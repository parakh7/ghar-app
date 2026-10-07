import type { Env } from "../config/env.js";
import type { Database } from "../db/client.js";
import type { Clock } from "../lib/clock.js";
import type { Logger } from "../lib/logger.js";
import type { Queue } from "../lib/queue.js";
import type { EmailProvider } from "./email/email.provider.js";

/** Everything a service needs, injected — no module-level singletons, so tests are isolated. */
export type Deps = {
  env: Env;
  db: Database;
  logger: Logger;
  clock: Clock;
  email: EmailProvider;
  queue: Queue;
};
