import { Router } from "express";
import { ok } from "../lib/respond.js";
import { Errors } from "../lib/errors.js";
import { runHeartbeat } from "../jobs/heartbeat.job.js";
import { runEvaluateReminders } from "../jobs/evaluate-reminders.job.js";
import { runDispatchEmailDeliveries } from "../jobs/dispatch-email-deliveries.job.js";
import { runDispatchWebPushDeliveries } from "../jobs/dispatch-web-push-deliveries.job.js";
import type { Deps } from "../services/deps.js";

export type NamedJob = { name: string; run: (deps: Deps) => Promise<void> };
export type JobResult = { name: string; ok: boolean; error?: string };

const JOBS: NamedJob[] = [
  { name: "heartbeat", run: runHeartbeat },
  { name: "evaluate-reminders", run: runEvaluateReminders },
  { name: "dispatch-email-deliveries", run: runDispatchEmailDeliveries },
  { name: "dispatch-web-push-deliveries", run: runDispatchWebPushDeliveries },
];

/** Runs each job in order; one throwing doesn't stop the others, matching how independent BullMQ job failures don't affect each other. */
export async function runAllJobs(jobs: NamedJob[], deps: Deps): Promise<JobResult[]> {
  const results: JobResult[] = [];
  for (const job of jobs) {
    try {
      await job.run(deps);
      results.push({ name: job.name, ok: true });
    } catch (err) {
      deps.logger.error({ err, job: job.name }, "internal job run failed");
      results.push({ name: job.name, ok: false, error: err instanceof Error ? err.message : "unknown error" });
    }
  }
  return results;
}

/**
 * Alternative to the BullMQ worker process (JOB_RUNNER=http) for deployments that can't run a
 * persistent background worker, e.g. a free hosting tier — an external cron hits this on a
 * schedule instead. Runs all three jobs on every hit regardless of their original BullMQ
 * intervals (1 min / 1 hour / 5 min) — each job's own logic is safe to run more often than
 * originally scheduled, and one external cron is simpler to operate than three.
 */
export function internalRoutes(deps: Deps): Router {
  const r = Router();
  let running = false;

  r.post("/run-jobs", async (req, res) => {
    if (req.header("x-jobs-secret") !== deps.env.JOBS_SECRET) throw Errors.forbidden("Invalid or missing jobs secret.");
    if (running) { ok(res, { skipped: true }, 202); return; }

    running = true;
    try {
      const ran = await runAllJobs(JOBS, deps);
      ok(res, { ran });
    } finally {
      running = false;
    }
  });

  return r;
}
