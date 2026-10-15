import { Resend } from "resend";
import { loadEnv } from "./config/env.js";
import { createDb, createPool } from "./db/client.js";
import { runHeartbeat } from "./jobs/heartbeat.job.js";
import { runEvaluateReminders } from "./jobs/evaluate-reminders.job.js";
import { runDispatchEmailDeliveries } from "./jobs/dispatch-email-deliveries.job.js";
import { ConsoleErrorReporter } from "./lib/error-reporter.js";
import { systemClock } from "./lib/clock.js";
import { createLogger } from "./lib/logger.js";
import { BullMQQueue } from "./lib/queue.js";
import { ConsoleEmailProvider, MemoryEmailProvider } from "./services/email/email.provider.js";
import { ResendEmailProvider } from "./services/email/resend.provider.js";
import type { Deps } from "./services/deps.js";

const env = loadEnv();
const logger = createLogger(env);

if (env.JOB_RUNNER !== "bullmq") {
  logger.warn({ jobRunner: env.JOB_RUNNER }, "JOB_RUNNER is not \"bullmq\" — this worker process has nothing to consume (jobs run via /api/internal/run-jobs instead); exiting");
  process.exit(0);
}

const pool = createPool(env.DATABASE_URL, env.DATABASE_POOL_MAX);
const db = createDb(pool);
const email = env.EMAIL_PROVIDER === "resend" ? new ResendEmailProvider(new Resend(env.RESEND_API_KEY), env.EMAIL_FROM, logger)
  : env.EMAIL_PROVIDER === "memory" ? new MemoryEmailProvider()
  : new ConsoleEmailProvider(logger);
const errorReporter = new ConsoleErrorReporter(logger);

// `{ consume: true }` is what starts job processing here: it makes BullMQQueue construct an
// internal BullMQ Worker, which begins polling Redis as soon as it's created (BullMQ workers
// default to `autorun: true`). This is the only place in the codebase that should pass
// `{ consume: true }` — the API server (`server.ts`) only ever schedules jobs, never processes
// them, so it omits this flag.
const queue = new BullMQQueue(env, logger, { consume: true });

const deps: Deps = { env, db, logger, clock: systemClock, email, queue, errorReporter };

deps.queue.registerHandler("heartbeat", () => runHeartbeat(deps));
deps.queue.registerHandler("evaluate-reminders", () => runEvaluateReminders(deps));
deps.queue.registerHandler("dispatch-email-deliveries", () => runDispatchEmailDeliveries(deps));

process.on("unhandledRejection", (reason) => logger.error({ err: reason }, "unhandled promise rejection"));

let shuttingDown = false;
async function shutdown(signal: string) {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info({ signal }, "worker shutting down");
  await queue.close();
  await pool.end();
  process.exit(0);
}
process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));

// Registered above, before this await: if Redis is unreachable, ioredis queues this command
// and retries indefinitely, so this await can hang — the signal handlers must already be live
// so graceful shutdown still works while waiting on it.
await deps.queue.scheduleRepeating("heartbeat", {}, 60_000);
await deps.queue.scheduleRepeating("evaluate-reminders", {}, 60 * 60 * 1000);
await deps.queue.scheduleRepeating("dispatch-email-deliveries", {}, 5 * 60 * 1000);

logger.info({ env: env.NODE_ENV }, "worker listening for jobs");
