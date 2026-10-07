import { Queue as BullQueue, Worker as BullWorker } from "bullmq";
import type { Env } from "../config/env.js";
import type { Logger } from "./logger.js";

type JobHandler = (data: unknown) => Promise<void>;

/** A single BullMQ queue shared by every job type in this app; jobs are routed by name. */
const QUEUE_NAME = "household";

/**
 * Background job queue — schedule jobs by name and register what each named job does.
 * Deliberately minimal: only what Task 3's repeating heartbeat job needs.
 */
export interface Queue {
  /** Registers the function that runs whenever a job named `jobName` is processed. */
  registerHandler(jobName: string, handler: JobHandler): void;
  /** Schedules `jobName` to run every `everyMs` milliseconds, passing it `data` each time. */
  scheduleRepeating(jobName: string, data: unknown, everyMs: number): Promise<void>;
}

/** Real implementation: a BullMQ `Queue` (scheduling) + `Worker` (processing) pair over Redis. */
export class BullMQQueue implements Queue {
  private readonly handlers = new Map<string, JobHandler>();
  private readonly queue: BullQueue;
  private readonly worker: BullWorker;

  constructor(env: Env, logger: Logger) {
    const connection = { url: env.REDIS_URL };
    this.queue = new BullQueue(QUEUE_NAME, { connection });
    this.worker = new BullWorker(
      QUEUE_NAME,
      async (job) => {
        const handler = this.handlers.get(job.name);
        if (!handler) throw new Error(`no handler registered for job "${job.name}"`);
        await handler(job.data);
      },
      { connection },
    );
    this.worker.on("failed", (job, err) => logger.error({ jobName: job?.name, err }, "job failed"));
    this.worker.on("error", (err) => logger.error({ err }, "queue worker error"));
  }

  registerHandler(jobName: string, handler: JobHandler): void {
    this.handlers.set(jobName, handler);
  }

  async scheduleRepeating(jobName: string, data: unknown, everyMs: number): Promise<void> {
    // BullMQ v6 removed `repeat` as a `Queue.add` job option in favor of job schedulers.
    await this.queue.upsertJobScheduler(jobName, { every: everyMs }, { name: jobName, data });
  }

  /** Closes the worker and queue's Redis connections; call during process shutdown. */
  async close(): Promise<void> {
    await this.worker.close();
    await this.queue.close();
  }
}

type RepeatingCall = { jobName: string; data: unknown; everyMs: number };

/** Test fake: records scheduling calls and lets tests invoke a registered handler synchronously. */
export class FakeQueue implements Queue {
  private readonly handlers = new Map<string, JobHandler>();
  readonly scheduled: RepeatingCall[] = [];

  registerHandler(jobName: string, handler: JobHandler): void {
    this.handlers.set(jobName, handler);
  }

  async scheduleRepeating(jobName: string, data: unknown, everyMs: number): Promise<void> {
    this.scheduled.push({ jobName, data, everyMs });
  }

  /** Test-only: synchronously runs a registered job's handler, as if it had just fired. */
  async runHandler(jobName: string, data: unknown): Promise<void> {
    const handler = this.handlers.get(jobName);
    if (!handler) throw new Error(`no handler registered for job "${jobName}"`);
    await handler(data);
  }
}
