import { Redis } from "ioredis";
import { createApp } from "./app.js";
import { loadEnv } from "./config/env.js";
import { createDb, createPool } from "./db/client.js";
import { ConsoleErrorReporter } from "./lib/error-reporter.js";
import { systemClock } from "./lib/clock.js";
import { createLogger } from "./lib/logger.js";
import { BullMQQueue } from "./lib/queue.js";
import { ConsoleEmailProvider, MemoryEmailProvider } from "./services/email/email.provider.js";

const env = loadEnv();
const logger = createLogger(env);
const pool = createPool(env.DATABASE_URL, env.DATABASE_POOL_MAX);
const db = createDb(pool);
const email = env.EMAIL_PROVIDER === "memory" ? new MemoryEmailProvider() : new ConsoleEmailProvider(logger);
// `{ consume: false }` (the default): the API server only schedules/produces jobs via
// `deps.queue` — it never registers a handler and never processes jobs itself. Job processing
// belongs exclusively to the dedicated worker process (see `worker.ts`).
const queue = new BullMQQueue(env, logger, { consume: false });
const errorReporter = new ConsoleErrorReporter(logger);
const redis = new Redis(env.REDIS_URL);
redis.on("error", (err) => logger.error({ err }, "rate-limit redis error"));

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
    await redis.quit();
    await pool.end();
    process.exit(0);
  });
  setTimeout(() => process.exit(1), 10_000).unref();
}
process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));
