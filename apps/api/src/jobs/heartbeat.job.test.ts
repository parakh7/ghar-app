import { eq } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { loadEnv } from "../config/env.js";
import { createDb, createPool } from "../db/client.js";
import { auditLogs } from "../db/schema.js";
import type { Clock } from "../lib/clock.js";
import { MemoryErrorReporter } from "../lib/error-reporter.js";
import { createLogger } from "../lib/logger.js";
import { FakeQueue } from "../lib/queue.js";
import { MemoryEmailProvider } from "../services/email/email.provider.js";
import type { Deps } from "../services/deps.js";
import { runHeartbeat } from "./heartbeat.job.js";

// Self-contained setup (not `tests/helpers.ts`): that file lives outside `src`, and
// `tsconfig.build.json` restricts the build's rootDir to `src`, so a test under `src/jobs`
// can't import across that boundary.
const TEST_DB_URL = process.env.TEST_DATABASE_URL ?? "postgresql://app:app@localhost:5432/household_test";

class FakeClock implements Clock {
  private t = new Date("2026-09-29T04:30:00Z");
  now() { return new Date(this.t); }
  advance(ms: number) { this.t = new Date(this.t.getTime() + ms); }
}

const env = loadEnv({ NODE_ENV: "test", DATABASE_URL: TEST_DB_URL, LOG_LEVEL: "silent" });
const pool = createPool(env.DATABASE_URL, 5);
const db = createDb(pool);
const clock = new FakeClock();
const deps: Deps = { env, db, logger: createLogger(env), clock, email: new MemoryEmailProvider(), queue: new FakeQueue(), errorReporter: new MemoryErrorReporter() };

beforeEach(async () => {
  await db.delete(auditLogs);
});
afterAll(() => pool.end());

describe("runHeartbeat", () => {
  it("records a system audit entry with no household or human actor", async () => {
    await runHeartbeat(deps);

    const logs = await db.select().from(auditLogs).where(eq(auditLogs.action, "system.heartbeat"));
    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatchObject({
      householdId: null,
      actorUserId: null,
      action: "system.heartbeat",
      entityType: "system",
      entityId: null,
      newValue: { ranAt: clock.now().toISOString() },
    });
  });

  it("writes a fresh row each time it runs", async () => {
    await runHeartbeat(deps);
    clock.advance(1000);
    await runHeartbeat(deps);

    const logs = await db.select().from(auditLogs).where(eq(auditLogs.action, "system.heartbeat"));
    expect(logs).toHaveLength(2);
  });
});
