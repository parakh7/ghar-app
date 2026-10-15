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
  /** Releases any held connections; call during process shutdown. */
  close(): Promise<void>;
}

export interface BullMQQueueOptions {
  /**
   * When `true`, also constructs a BullMQ `Worker`, which begins consuming jobs from Redis
   * immediately on construction (BullMQ workers default to `autorun: true`) — before
   * `registerHandler` is ever called. Only the dedicated worker process should pass `true`.
   * Processes that only need to produce/schedule jobs (e.g. the API server) must leave this
   * `false` (the default), or they'll race the worker process for every job.
   */
  consume?: boolean;
}

/** Real implementation: a BullMQ `Queue` (scheduling), optionally paired with a `Worker` (processing) over Redis. */
export class BullMQQueue implements Queue {
  private readonly handlers = new Map<string, JobHandler>();
  private readonly queue: BullQueue;
  private readonly worker?: BullWorker;

  constructor(env: Env, logger: Logger, options: BullMQQueueOptions = {}) {
    const connection = { url: env.REDIS_URL };
    this.queue = new BullQueue(QUEUE_NAME, { connection });
    // Without a listener, BullMQ falls back to a raw `console.error` per emitted error (e.g. a
    // flood of ECONNREFUSED stack dumps when Redis is unreachable). Route it through pino instead.
    this.queue.on("error", (err) => logger.error({ err }, "queue error"));

    if (options.consume) {
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
  }

  registerHandler(jobName: string, handler: JobHandler): void {
    this.handlers.set(jobName, handler);
  }

  async scheduleRepeating(jobName: string, data: unknown, everyMs: number): Promise<void> {
    // BullMQ v6 removed `repeat` as a `Queue.add` job option in favor of job schedulers.
    await this.queue.upsertJobScheduler(jobName, { every: everyMs }, { name: jobName, data });
  }

  /** Closes the worker (if consuming) and the queue's Redis connections; call during process shutdown. */
  async close(): Promise<void> {
    await this.worker?.close();
    await this.queue.close();
  }
}

type RepeatingCall = { jobName: string; data: unknown; everyMs: number };

/**
 * Test fake: records scheduling calls and lets tests invoke a registered handler synchronously.
 * Also doubles as the real `deps.queue` for JOB_RUNNER=http (server.ts) — true no-op is exactly
 * what that mode needs, since jobs run via the internal HTTP route instead of BullMQ there.
 */
export class FakeQueue implements Queue {
  private readonly handlers = new Map<string, JobHandler>();
  readonly scheduled: RepeatingCall[] = [];

  registerHandler(jobName: string, handler: JobHandler): void {
    this.handlers.set(jobName, handler);
  }

  async scheduleRepeating(jobName: string, data: unknown, everyMs: number): Promise<void> {
    this.scheduled.push({ jobName, data, everyMs });
  }

  async close(): Promise<void> {}

  /** Test-only: synchronously runs a registered job's handler, as if it had just fired. */
  async runHandler(jobName: string, data: unknown): Promise<void> {
    const handler = this.handlers.get(jobName);
    if (!handler) throw new Error(`no handler registered for job "${jobName}"`);
    await handler(data);
  }
}
