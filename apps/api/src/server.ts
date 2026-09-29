import { createApp } from "./app.js";
import { loadEnv } from "./config/env.js";
import { createDb, createPool } from "./db/client.js";
import { systemClock } from "./lib/clock.js";
import { createLogger } from "./lib/logger.js";
import { ConsoleEmailProvider, MemoryEmailProvider } from "./services/email/email.provider.js";

const env = loadEnv();
const logger = createLogger(env);
const pool = createPool(env.DATABASE_URL);
const db = createDb(pool);
const email = env.EMAIL_PROVIDER === "memory" ? new MemoryEmailProvider() : new ConsoleEmailProvider(logger);

const app = createApp({ env, db, logger, clock: systemClock, email });
const server = app.listen(env.PORT, () => logger.info({ port: env.PORT, env: env.NODE_ENV }, "API listening"));

process.on("unhandledRejection", (reason) => logger.error({ err: reason }, "unhandled promise rejection"));

let shuttingDown = false;
async function shutdown(signal: string) {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info({ signal }, "shutting down");
  server.close(async () => {
    await pool.end();
    process.exit(0);
  });
  setTimeout(() => process.exit(1), 10_000).unref();
}
process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));
