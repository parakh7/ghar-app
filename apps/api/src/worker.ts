import { loadEnv } from "./config/env.js";
import { createDb, createPool } from "./db/client.js";
import { systemClock } from "./lib/clock.js";
import { createLogger } from "./lib/logger.js";
import { BullMQQueue } from "./lib/queue.js";
import { ConsoleEmailProvider, MemoryEmailProvider } from "./services/email/email.provider.js";
import type { Deps } from "./services/deps.js";

const env = loadEnv();
const logger = createLogger(env);
const pool = createPool(env.DATABASE_URL);
const db = createDb(pool);
const email = env.EMAIL_PROVIDER === "memory" ? new MemoryEmailProvider() : new ConsoleEmailProvider(logger);
const queue = new BullMQQueue(env, logger);

// Constructing the Deps is already what starts job processing: the BullMQQueue's internal
// Worker begins polling Redis as soon as it's created. Future tasks register handlers on
// `deps.queue` and schedule repeating jobs — this process just needs to stay alive for that.
const deps: Deps = { env, db, logger, clock: systemClock, email, queue };
void deps;

logger.info({ env: env.NODE_ENV }, "worker listening for jobs");

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
