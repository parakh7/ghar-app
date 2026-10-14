/**
 * Demo seed: "Shah Family" with Parakh (OWNER) and two family members.
 * Househelps, checklists and bills from the spec's demo data are added to this
 * seed in the phases that introduce their services (so seed data always goes
 * through real business logic, never raw inserts that could drift from it).
 */
import { and, eq } from "drizzle-orm";
import { loadEnv } from "../config/env.js";
import { MemoryErrorReporter } from "../lib/error-reporter.js";
import { systemClock } from "../lib/clock.js";
import { createLogger } from "../lib/logger.js";
import { hashPassword } from "../lib/password.js";
import { FakeQueue } from "../lib/queue.js";
import { ConsoleEmailProvider } from "../services/email/email.provider.js";
import { createHousehold } from "../services/household.service.js";
import { createDb, createPool } from "./client.js";
import { householdMembers, notificationPreferences, users } from "./schema.js";

const DEMO_PASSWORD = "demo-password-123";

async function main() {
  const env = loadEnv();
  if (env.NODE_ENV === "production") throw new Error("Refusing to seed demo data in production");
  const logger = createLogger(env);
  const pool = createPool(env.DATABASE_URL);
  const db = createDb(pool);
  // Seeding never touches the job queue or error-handling middleware, so a FakeQueue and
  // MemoryErrorReporter satisfy Deps without needing Redis or a real reporter.
  const deps = { env, db, logger, clock: systemClock, email: new ConsoleEmailProvider(logger), queue: new FakeQueue(), errorReporter: new MemoryErrorReporter() };

  const existing = await db.select({ id: users.id }).from(users).where(eq(users.email, "parakh@example.com")).limit(1);
  if (existing.length) {
    logger.info("demo data already present — skipping");
    await pool.end();
    return;
  }

  const passwordHash = await hashPassword(DEMO_PASSWORD);
  const now = new Date();
  const [parakh, mother, father] = await db.insert(users).values([
    { name: "Parakh", email: "parakh@example.com", passwordHash, emailVerifiedAt: now, passwordChangedAt: now },
    { name: "Mother", email: "mother@example.com", passwordHash, emailVerifiedAt: now, passwordChangedAt: now },
    { name: "Father", email: "father@example.com", passwordHash, emailVerifiedAt: now, passwordChangedAt: now },
  ]).returning();

  const household = await createHousehold(deps, parakh!.id, { name: "Shah Family", timezone: "Asia/Kolkata" });
  for (const [u, displayName] of [[mother!, "Mother"], [father!, "Father"]] as const) {
    await db.insert(householdMembers).values({ householdId: household.id, userId: u.id, role: "MEMBER", displayName, invitedByUserId: parakh!.id, joinedAt: now });
    await db.insert(notificationPreferences).values((["BILL", "SALARY", "ATTENDANCE", "CHECKLIST", "SYSTEM"] as const).map((category) => ({ householdId: household.id, userId: u.id, category, enabled: true })));
  }
  // Mother doesn't want bill reminders (per spec example §31)
  await db.update(notificationPreferences).set({ enabled: false })
    .where(and(eq(notificationPreferences.userId, mother!.id), eq(notificationPreferences.category, "BILL")));

  logger.info({ household: household.name }, `✓ seeded. Sign in as parakh@example.com / ${DEMO_PASSWORD}`);
  await pool.end();
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
