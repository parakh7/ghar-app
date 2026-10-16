import { Redis } from "ioredis";
import { Resend } from "resend";
import { createApp } from "./app.js";
import { loadEnv } from "./config/env.js";
import { createDb, createPool } from "./db/client.js";
import { ConsoleErrorReporter } from "./lib/error-reporter.js";
import { systemClock } from "./lib/clock.js";
import { createLogger } from "./lib/logger.js";
import { BullMQQueue, FakeQueue, type Queue } from "./lib/queue.js";
import { ConsoleEmailProvider, MemoryEmailProvider } from "./services/email/email.provider.js";
import { ResendEmailProvider } from "./services/email/resend.provider.js";

const env = loadEnv();
const logger = createLogger(env);
const pool = createPool(env.DATABASE_URL, env.DATABASE_POOL_MAX);
const db = createDb(pool);
const email = env.EMAIL_PROVIDER === "resend" ? new ResendEmailProvider(new Resend(env.RESEND_API_KEY), env.EMAIL_FROM, logger)
  : env.EMAIL_PROVIDER === "memory" ? new MemoryEmailProvider()
  : new ConsoleEmailProvider(logger);
// `{ consume: false }` (the default): the API server only schedules/produces jobs via
// `deps.queue` — it never registers a handler and never processes jobs itself. Job processing
// belongs exclusively to the dedicated worker process (see `worker.ts`). In JOB_RUNNER=http mode
// there's no worker process at all — jobs run via the /api/internal/run-jobs route instead — so
// deps.queue is a true no-op there rather than an unused BullMQ/Redis connection.
const queue: Queue = env.JOB_RUNNER === "http" ? new FakeQueue() : new BullMQQueue(env, logger, { consume: false });
const errorReporter = new ConsoleErrorReporter(logger);
// JOB_RUNNER=http means no Redis is expected to be available at all (that's the point of that
// mode) — rate limiting falls back to express-rate-limit's in-memory store in that case, same as
// the test environment already does, rather than retrying a connection that will never succeed.
const redis = env.JOB_RUNNER === "http" ? undefined : new Redis(env.REDIS_URL);
redis?.on("error", (err) => logger.error({ err }, "rate-limit redis error"));

const app = createApp({ env, db, logger, clock: systemClock, email, queue, errorReporter, redis });
const server = app.listen(env.PORT, () => logger.info({ port: env.PORT, env: env.NODE_ENV }, "API listening"));

process.on("unhandledRejection", (reason) => logger.error({ err: reason }, "unhandled promise rejection"));

let shuttingDown = false;
async function shutdown(signal: string) {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info({ signal }, "shutting down");
  server.close(async () => {
    await queue.close();
    await redis?.quit();
    await pool.end();
    process.exit(0);
  });
  setTimeout(() => process.exit(1), 10_000).unref();
}
process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));
