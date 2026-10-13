# Phase 7 Spec 5 — Email Notification Channel Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Dispatch `notification_deliveries` rows with `channel = 'EMAIL'` and `status = 'PENDING'` (written by Spec 3's `evaluate-reminders` job, never consumed until now) via the existing `EmailProvider` infrastructure.

**Architecture:** A new `dispatch-email-deliveries` BullMQ job, scheduled every 5 minutes independent of `evaluate-reminders`'s hourly cadence, queries pending EMAIL deliveries joined to their notification and recipient user, and processes each row in its own try/catch (one bad row never blocks the rest of the batch).

**Tech Stack:** TypeScript, BullMQ, Drizzle ORM, Postgres, Vitest.

## Global Constraints

- No schema migration, no shared-package changes, no web changes — this is `apps/api` only.
- No new `EmailProvider` — `ConsoleEmailProvider`/`MemoryEmailProvider` only.
- `EMAIL` channel delivery rows cannot be produced in production today (no preferences UI yet, Spec 6) — build and test this fully anyway; it stays inert until Spec 6 ships.
- Verified-email gate: `users.emailVerifiedAt === null` → mark the delivery `SKIPPED`, no send attempted.
- Retry: on send failure, `attempts += 1`; status stays `PENDING` while `attempts < 3`, becomes `FAILED` once `attempts` reaches `3`.
- Per-row processing, not per-batch — a single row's failure must not prevent any other row in the same run from being processed.
- Per project testing cadence (user's explicit instruction this round): targeted test file only — **no full-suite run**, not even at merge time.

---

## File Structure

- Create: `apps/api/src/jobs/dispatch-email-deliveries.job.ts` — `runDispatchEmailDeliveries(deps: Deps): Promise<void>`.
- Create: `apps/api/tests/dispatch-email-deliveries.test.ts`.
- Modify: `apps/api/src/worker.ts` — register + schedule the new job.

---

### Task 1: `dispatch-email-deliveries` job

**Files:**
- Create: `apps/api/src/jobs/dispatch-email-deliveries.job.ts`
- Modify: `apps/api/src/worker.ts:4` (import, after the `evaluate-reminders` import), `:27` (register handler, after the `evaluate-reminders` registration), `:47` (schedule, after the `evaluate-reminders` schedule)
- Test: `apps/api/tests/dispatch-email-deliveries.test.ts`

**Interfaces:**
- Consumes: `Deps` (`env`, `db`, `logger`, `clock`, `email: EmailProvider`, `queue`), `EmailProvider.send(message: { to: string; subject: string; text: string; html?: string; tag: string }): Promise<void>` (`apps/api/src/services/email/email.provider.ts`), schema tables `notificationDeliveries`, `notifications`, `users` (`apps/api/src/db/schema.ts`).
- Produces: `runDispatchEmailDeliveries(deps: Deps): Promise<void>`, registered under job name `"dispatch-email-deliveries"`.

- [ ] **Step 1: Write the failing test file**

Create `apps/api/tests/dispatch-email-deliveries.test.ts`:

```typescript
import { eq } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import type { EmailProvider } from "../src/services/email/email.provider.js";
import { householdMembers, notificationDeliveries, notifications, users } from "../src/db/schema.js";
import { runDispatchEmailDeliveries } from "../src/jobs/dispatch-email-deliveries.job.js";
import { createTestContext, csrf, signupUser, truncateAll, type TestContext } from "./helpers.js";

const ctx = createTestContext();

beforeEach(async () => { await truncateAll(ctx.db); });
afterAll(() => ctx.close());

class ThrowingEmailProvider implements EmailProvider {
  async send(): Promise<void> { throw new Error("smtp down"); }
}

async function createHousehold(c: TestContext, cookie: string) {
  const res = await c.request.post("/api/households").set(csrf).set("cookie", cookie).send({ name: "Shah Family" });
  expect(res.status).toBe(201);
  return res.body.data as { id: string };
}

async function verifyUser(userId: string) {
  await ctx.db.update(users).set({ emailVerifiedAt: ctx.clock.now() }).where(eq(users.id, userId));
}

async function addActiveMember(householdId: string, userId: string) {
  await ctx.db.insert(householdMembers).values({ householdId, userId, role: "MEMBER", status: "ACTIVE" });
}

let seq = 0;
async function insertDelivery(householdId: string, userId: string, overrides: Record<string, unknown> = {}) {
  seq += 1;
  const [notification] = await ctx.db.insert(notifications).values({
    householdId, userId, category: "BILL", title: `Electricity due in 7 day(s) #${seq}`,
    idempotencyKey: `test-key-${seq}`,
  }).returning();
  const [delivery] = await ctx.db.insert(notificationDeliveries).values({
    householdId, notificationId: notification!.id, channel: "EMAIL", status: "PENDING", ...overrides,
  }).returning();
  return { notification: notification!, delivery: delivery! };
}

describe("runDispatchEmailDeliveries", () => {
  it("sends a PENDING EMAIL delivery for a verified user and marks it SENT", async () => {
    const owner = await signupUser(ctx);
    await verifyUser(owner.id);
    const h = await createHousehold(ctx, owner.cookie);
    const { notification, delivery } = await insertDelivery(h.id, owner.id);

    await runDispatchEmailDeliveries(ctx.deps);

    const [updated] = await ctx.db.select().from(notificationDeliveries).where(eq(notificationDeliveries.id, delivery.id));
    expect(updated!.status).toBe("SENT");
    expect(updated!.sentAt).not.toBeNull();
    const sent = ctx.email.sent.find((m) => m.to === owner.email);
    expect(sent).toMatchObject({ subject: notification.title, tag: "reminder-notification" });
  });

  it("skips an unverified user's delivery without attempting to send", async () => {
    const owner = await signupUser(ctx); // not verified
    const h = await createHousehold(ctx, owner.cookie);
    const { delivery } = await insertDelivery(h.id, owner.id);

    await runDispatchEmailDeliveries(ctx.deps);

    const [updated] = await ctx.db.select().from(notificationDeliveries).where(eq(notificationDeliveries.id, delivery.id));
    expect(updated!.status).toBe("SKIPPED");
    expect(ctx.email.sent).toHaveLength(0);
  });

  it("increments attempts and records lastError on failure, staying PENDING under 3 attempts", async () => {
    const owner = await signupUser(ctx);
    await verifyUser(owner.id);
    const h = await createHousehold(ctx, owner.cookie);
    const { delivery } = await insertDelivery(h.id, owner.id);
    const failingDeps = { ...ctx.deps, email: new ThrowingEmailProvider() };

    await runDispatchEmailDeliveries(failingDeps);

    const [updated] = await ctx.db.select().from(notificationDeliveries).where(eq(notificationDeliveries.id, delivery.id));
    expect(updated!.status).toBe("PENDING");
    expect(updated!.attempts).toBe(1);
    expect(updated!.lastError).toContain("smtp down");
  });

  it("marks FAILED on the 3rd consecutive failure", async () => {
    const owner = await signupUser(ctx);
    await verifyUser(owner.id);
    const h = await createHousehold(ctx, owner.cookie);
    const { delivery } = await insertDelivery(h.id, owner.id, { attempts: 2 });
    const failingDeps = { ...ctx.deps, email: new ThrowingEmailProvider() };

    await runDispatchEmailDeliveries(failingDeps);

    const [updated] = await ctx.db.select().from(notificationDeliveries).where(eq(notificationDeliveries.id, delivery.id));
    expect(updated!.status).toBe("FAILED");
    expect(updated!.attempts).toBe(3);
  });

  it("a failing row doesn't block a healthy row in the same run", async () => {
    const owner = await signupUser(ctx);
    await verifyUser(owner.id);
    const h = await createHousehold(ctx, owner.cookie);
    const other = await signupUser(ctx);
    await verifyUser(other.id);
    await addActiveMember(h.id, other.id);

    const failing = await insertDelivery(h.id, owner.id);
    const healthy = await insertDelivery(h.id, other.id);

    const flakyProvider: EmailProvider = {
      async send(message) {
        if (message.to === owner.email) throw new Error("this recipient's send fails");
      },
    };
    await runDispatchEmailDeliveries({ ...ctx.deps, email: flakyProvider });

    const rows = await ctx.db.select().from(notificationDeliveries).where(eq(notificationDeliveries.householdId, h.id));
    const failingRow = rows.find((r) => r.id === failing.delivery.id)!;
    const healthyRow = rows.find((r) => r.id === healthy.delivery.id)!;
    expect(failingRow.status).toBe("PENDING");
    expect(healthyRow.status).toBe("SENT");
  });

  it("never touches non-EMAIL or non-PENDING rows", async () => {
    const owner = await signupUser(ctx);
    await verifyUser(owner.id);
    const h = await createHousehold(ctx, owner.cookie);
    const { delivery: alreadySent } = await insertDelivery(h.id, owner.id, { status: "SENT", sentAt: ctx.clock.now() });
    const { delivery: inApp } = await insertDelivery(h.id, owner.id, { channel: "IN_APP", status: "PENDING" });

    await runDispatchEmailDeliveries(ctx.deps);

    expect(ctx.email.sent).toHaveLength(0);
    const [sentRow] = await ctx.db.select().from(notificationDeliveries).where(eq(notificationDeliveries.id, alreadySent.id));
    const [inAppRow] = await ctx.db.select().from(notificationDeliveries).where(eq(notificationDeliveries.id, inApp.id));
    expect(sentRow!.status).toBe("SENT");
    expect(inAppRow!.status).toBe("PENDING"); // untouched — IN_APP delivery isn't this job's concern
  });

  it("caps how many rows it processes in a single run", async () => {
    const owner = await signupUser(ctx);
    await verifyUser(owner.id);
    const h = await createHousehold(ctx, owner.cookie);
    for (let i = 0; i < 101; i++) await insertDelivery(h.id, owner.id);

    await runDispatchEmailDeliveries(ctx.deps);

    const rows = await ctx.db.select().from(notificationDeliveries).where(eq(notificationDeliveries.householdId, h.id));
    const stillPending = rows.filter((r) => r.status === "PENDING").length;
    expect(stillPending).toBeGreaterThan(0); // the cap left at least one row unprocessed this run
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm run test --workspace @household/api -- dispatch-email-deliveries`
Expected: FAIL — `Cannot find module '../src/jobs/dispatch-email-deliveries.job.js'`.

- [ ] **Step 3: Implement the job**

Create `apps/api/src/jobs/dispatch-email-deliveries.job.ts`:

```typescript
import { and, asc, eq } from "drizzle-orm";
import { notificationDeliveries, notifications, users } from "../db/schema.js";
import type { Deps } from "../services/deps.js";

const MAX_ATTEMPTS = 3;
const BATCH_LIMIT = 100;

/**
 * Every 5 minutes: finds PENDING EMAIL deliveries (written by evaluate-reminders.job.ts, never
 * consumed until this job), sends each via deps.email, and updates its status. Each row is
 * processed in its own try/catch — a single bad row (provider error, anything) must not prevent
 * the rest of the batch from being processed, the same per-item-isolation lesson learned the hard
 * way in evaluate-reminders.job.ts's own review loop. A dangling delivery whose notification or
 * user row no longer exists can't happen — both FKs cascade-delete — so the inner joins below
 * naturally exclude that impossible case without needing explicit handling.
 */
export async function runDispatchEmailDeliveries(deps: Deps): Promise<void> {
  const rows = await deps.db.select({
    deliveryId: notificationDeliveries.id,
    attempts: notificationDeliveries.attempts,
    notificationTitle: notifications.title,
    notificationBody: notifications.body,
    userEmail: users.email,
    userEmailVerifiedAt: users.emailVerifiedAt,
  }).from(notificationDeliveries)
    .innerJoin(notifications, eq(notifications.id, notificationDeliveries.notificationId))
    .innerJoin(users, eq(users.id, notifications.userId))
    .where(and(eq(notificationDeliveries.channel, "EMAIL"), eq(notificationDeliveries.status, "PENDING")))
    .orderBy(asc(notificationDeliveries.createdAt))
    .limit(BATCH_LIMIT);

  for (const row of rows) {
    try {
      if (!row.userEmailVerifiedAt) {
        await deps.db.update(notificationDeliveries).set({ status: "SKIPPED" }).where(eq(notificationDeliveries.id, row.deliveryId));
        continue;
      }
      await deps.email.send({
        to: row.userEmail, subject: row.notificationTitle, text: row.notificationBody ?? row.notificationTitle, tag: "reminder-notification",
      });
      await deps.db.update(notificationDeliveries).set({ status: "SENT", sentAt: deps.clock.now() }).where(eq(notificationDeliveries.id, row.deliveryId));
    } catch (err) {
      const attempts = row.attempts + 1;
      await deps.db.update(notificationDeliveries)
        .set({ attempts, lastError: String(err), status: attempts >= MAX_ATTEMPTS ? "FAILED" : "PENDING" })
        .where(eq(notificationDeliveries.id, row.deliveryId));
    }
  }
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm run test --workspace @household/api -- dispatch-email-deliveries`
Expected: PASS

- [ ] **Step 5: Typecheck and build**

Run: `npm run typecheck --workspace @household/api && npm run build --workspace @household/api`
Expected: PASS (the 2 pre-existing, unrelated `TS18048` failures in `tests/bill-category.test.ts`/`tests/bill.test.ts` are not part of this change — confirmed pre-existing on master).

- [ ] **Step 6: Wire the job into the worker process**

In `apps/api/src/worker.ts`, add the import after the existing `evaluate-reminders` import (line 4):

```typescript
import { runEvaluateReminders } from "./jobs/evaluate-reminders.job.js";
import { runDispatchEmailDeliveries } from "./jobs/dispatch-email-deliveries.job.js";
```

Add the handler registration after `deps.queue.registerHandler("evaluate-reminders", () => runEvaluateReminders(deps));` (line 27):

```typescript
deps.queue.registerHandler("evaluate-reminders", () => runEvaluateReminders(deps));
deps.queue.registerHandler("dispatch-email-deliveries", () => runDispatchEmailDeliveries(deps));
```

Add the schedule call after `await deps.queue.scheduleRepeating("evaluate-reminders", {}, 60 * 60 * 1000);` (line 47):

```typescript
await deps.queue.scheduleRepeating("evaluate-reminders", {}, 60 * 60 * 1000);
await deps.queue.scheduleRepeating("dispatch-email-deliveries", {}, 5 * 60 * 1000);
```

- [ ] **Step 7: Commit**

```bash
git add apps/api/src/jobs/dispatch-email-deliveries.job.ts apps/api/tests/dispatch-email-deliveries.test.ts apps/api/src/worker.ts
git commit -m "feat(api): dispatch PENDING EMAIL notification deliveries"
```

---

## Self-Review Notes

- **Spec coverage:** 5-minute separate job ✓, batch query + 100-row cap ✓ (tested), per-row try/catch isolation ✓ (tested with two distinct recipients so the result doesn't depend on unspecified query ordering), verified-email gate → SKIPPED ✓ (tested), send → SENT with `sentAt` ✓ (tested), failure → `attempts`/`lastError`, PENDING under 3 then FAILED at 3 ✓ (both boundary cases tested), non-EMAIL/non-PENDING rows untouched ✓ (tested), console/memory-only email provider (no new provider added) ✓, no migration/web changes ✓. The spec's "defensive: missing notification/user row → log and skip" case is replaced with a one-line doc-comment explanation of why it's structurally impossible (FK cascade deletes) rather than dead defensive code for a scenario that can't happen — consistent with the project's YAGNI stance on unreachable error handling.
- **Type consistency:** the job's `Deps` usage (`db`, `email`, `clock`) matches the existing `Deps` type exactly; `EmailProvider`/`EmailMessage` shapes match `email.provider.ts` verbatim; test file's `ThrowingEmailProvider`/inline flaky provider both satisfy the real `EmailProvider` interface.
- **No placeholders:** every step has runnable code.
