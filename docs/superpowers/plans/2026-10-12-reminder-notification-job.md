# Phase 7 Spec 3 — Notification-Creation Job Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a scheduled job that turns Spec 2's due-item evaluation into real `notifications`/`notification_deliveries` rows, in-app only, fanned out to each household's active members per their `notification_preferences`.

**Architecture:** A new `evaluate-reminders` BullMQ job (registered + scheduled hourly in `worker.ts`, mirroring the existing `heartbeat` job) loops every non-archived household, calls the existing `getDueBillOccurrences`/`getDueSettlements`, gates each due item by its effective rule's `sendHour` against the household's current local hour, fans out to `ACTIVE` household members filtered by `notification_preferences`, and inserts one `notifications` row + one `notification_deliveries` row per channel per (item, user), relying on the existing `notifications_idempotency_uq` constraint for re-run safety.

**Tech Stack:** TypeScript, Express 5, Drizzle ORM, Postgres, BullMQ, Vitest, Supertest (full-app integration tests against a real test database).

## Global Constraints

- No schema migration: `notifications`, `notification_deliveries`, `notification_preferences` already exist (Phase 1).
- In-app only: only the `IN_APP` delivery row is marked `SENT` by this job; all other channels stay `PENDING` for a later spec's dispatcher.
- Personal offset/send-hour overrides on `notification_preferences` are NOT consulted — only `enabled`/`channels`. Offsets/send-hour always come from the effective `reminder_rules` row.
- A missing `notification_preferences` row for a (user, category) means "enabled, default channels `{IN_APP, WEB_PUSH}`" — never "disabled."
- Idempotency key format (exact, matches the `notifications` table's own doc comment): `` `bill_occ:<occurrenceId>:before:<offset>:user:<userId>` ``, `` `bill_occ:<occurrenceId>:overdue:<today>:user:<userId>` ``, and the `settlement:` equivalents.
- Follow the existing `isUniqueViolation(err)` pattern (duplicated per-file, as already done in `bill-category.service.ts`, `category.service.ts`, `reminder-rule.service.ts`, `auth.service.ts`) — do not introduce a shared util.
- Per [[household-app-testing-cadence]]: targeted test files only for this work; do not run the full suite.

---

## File Structure

- **Modify:** `apps/api/src/services/reminder-evaluation.service.ts` — `DueBillOccurrence`/`DueSettlement` gain a `sendHour: number` field (the effective rule's `sendHour`), so the job can gate on it without re-querying rules itself.
- **Modify:** `apps/api/tests/reminder-evaluation.test.ts` — two new assertions proving `sendHour` is exposed.
- **Create:** `apps/api/src/jobs/evaluate-reminders.job.ts` — `runEvaluateReminders(deps: Deps): Promise<void>`, the whole job: household loop, send-hour gating, recipient fan-out, notification + delivery row creation.
- **Create:** `apps/api/tests/evaluate-reminders.test.ts` — full-app integration tests (same `createTestContext`/`signupUser`/HTTP-household-creation pattern as `reminder-evaluation.test.ts`, not the self-contained raw-DB style of `heartbeat.job.test.ts` — this job needs realistic household/member/preference fixtures that the HTTP layer and `household.service.ts`'s default-seeding already provide for free).
- **Modify:** `apps/api/src/worker.ts` — register and schedule the new job.

---

### Task 1: Expose `sendHour` on due-item evaluation results

**Files:**
- Modify: `apps/api/src/services/reminder-evaluation.service.ts:15-24` (`DueBillOccurrence` type), `:26-35` (`DueSettlement` type), `:107-110` (push in `getDueBillOccurrences`), `:149-152` (push in `getDueSettlements`)
- Test: `apps/api/tests/reminder-evaluation.test.ts`

**Interfaces:**
- Produces: `DueBillOccurrence.sendHour: number` and `DueSettlement.sendHour: number` — the effective rule's `sendHour` for that item. Task 2's job reads this field directly; it does not re-fetch rules.

- [ ] **Step 1: Write the failing tests**

In `apps/api/tests/reminder-evaluation.test.ts`, insert immediately after the first `getDueBillOccurrences` test (after the `});` that closes `"flags an item exactly at an offset boundary (household default rule: offsets [7,3,1,0])"`, i.e. right before the `"flags an overdue item..."` test):

```typescript
    it("exposes the effective rule's sendHour for the job's send-hour gating", async () => {
      const owner = await signupUser(ctx);
      const h = await createHousehold(ctx, owner.cookie);
      const { occurrence } = await createBill(h, owner.cookie, addDays(TODAY, 7));

      const due = await getDueBillOccurrences(ctx.deps, h.id, TODAY);
      const item = due.find((d) => d.occurrenceId === occurrence.id)!;
      expect(item.sendHour).toBe(9); // DEFAULT_REMINDERS.BILL.sendHour
    });
```

And in the `getDueSettlements` describe block, immediately after the first settlement test (`"flags an item exactly at an offset boundary (household default rule: offsets [3,0])"`), right before `"flags an overdue settlement..."`:

```typescript
    it("exposes the effective rule's sendHour for the job's send-hour gating", async () => {
      const owner = await signupUser(ctx);
      const h = await createHousehold(ctx, owner.cookie);
      const help = await createHousehelp(h.id);
      const settlement = await createSettlement(h.id, help.id, addDays(TODAY, 3));

      const due = await getDueSettlements(ctx.deps, h.id, TODAY);
      const item = due.find((d) => d.settlementId === settlement.id)!;
      expect(item.sendHour).toBe(9); // DEFAULT_REMINDERS.SALARY.sendHour
    });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm run test --workspace @household/api -- reminder-evaluation`
Expected: FAIL — `item.sendHour` is `undefined`, not `9`.

- [ ] **Step 3: Implement the field**

In `apps/api/src/services/reminder-evaluation.service.ts`, add `sendHour: number;` to both type definitions:

```typescript
export type DueBillOccurrence = {
  billId: string;
  billName: string;
  occurrenceId: string;
  dueDate: ISODate;
  amountDuePaise: number;
  daysUntilDue: number;
  matchedOffsets: number[];
  isOverdue: boolean;
  sendHour: number;
};
```

```typescript
export type DueSettlement = {
  settlementId: string;
  househelpId: string;
  househelpName: string;
  dueDate: ISODate;
  netPayablePaise: number;
  daysUntilDue: number;
  matchedOffsets: number[];
  isOverdue: boolean;
  sendHour: number;
};
```

Then update the two push sites to include it. In `getDueBillOccurrences`:

```typescript
    result.push({
      billId: occ.billId, billName: occ.billName, occurrenceId: occ.occurrenceId, dueDate: occ.dueDate,
      amountDuePaise: occ.amountDuePaise, daysUntilDue, matchedOffsets, isOverdue, sendHour: rule.sendHour,
    });
```

In `getDueSettlements`:

```typescript
    result.push({
      settlementId: s.id, househelpId: s.househelpId, househelpName: nameById.get(s.househelpId) ?? "",
      dueDate: s.dueDate, netPayablePaise: s.netPayablePaise, daysUntilDue, matchedOffsets, isOverdue, sendHour: rule.sendHour,
    });
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm run test --workspace @household/api -- reminder-evaluation`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/services/reminder-evaluation.service.ts apps/api/tests/reminder-evaluation.test.ts
git commit -m "feat(api): expose effective rule's sendHour on due-item evaluation results"
```

---

### Task 2: `evaluate-reminders` job — gating, fan-out, notification creation, worker wiring

**Files:**
- Create: `apps/api/src/jobs/evaluate-reminders.job.ts`
- Create: `apps/api/tests/evaluate-reminders.test.ts`
- Modify: `apps/api/src/worker.ts:3` (import), `:25` (register handler, after the heartbeat registration), `:44` (schedule, after the heartbeat schedule)

**Interfaces:**
- Consumes: `getDueBillOccurrences(deps: Deps, householdId: string, today: ISODate): Promise<DueBillOccurrence[]>`, `getDueSettlements(deps: Deps, householdId: string, today: ISODate): Promise<DueSettlement[]>` (both from Task 1, now including `sendHour`), `dateInZone(instant: Date, timeZone: string): ISODate`, `hourInZone(instant: Date, timeZone: string): number` (from `@household/shared`), `deps.db`, `deps.clock.now()`.
- Produces: `runEvaluateReminders(deps: Deps): Promise<void>` — the job's entry point, registered under job name `"evaluate-reminders"`.

- [ ] **Step 1: Write the failing test file**

Create `apps/api/tests/evaluate-reminders.test.ts`:

```typescript
import { eq } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { addDays } from "@household/shared";
import { householdMembers, notifications, notificationDeliveries, notificationPreferences, househelps, salarySettlements } from "../src/db/schema.js";
import { runEvaluateReminders } from "../src/jobs/evaluate-reminders.job.js";
import { createTestContext, csrf, signupUser, truncateAll, type TestContext } from "./helpers.js";

const ctx = createTestContext();
const SEND_HOUR_NOW = "2026-09-29T03:30:00Z"; // 09:00 IST — matches DEFAULT_REMINDERS' sendHour: 9
const WRONG_HOUR_NOW = "2026-09-29T04:30:00Z"; // 10:00 IST — one hour off
const TODAY = "2026-09-29";

beforeEach(async () => {
  await truncateAll(ctx.db);
  ctx.clock.set(SEND_HOUR_NOW);
});
afterAll(() => ctx.close());

async function createHousehold(c: TestContext, cookie: string, name = "Shah Family") {
  const res = await c.request.post("/api/households").set(csrf).set("cookie", cookie).send({ name });
  expect(res.status).toBe(201);
  return res.body.data as { id: string };
}

async function createBill(h: { id: string }, cookie: string, firstDueDate: string) {
  const res = await ctx.request.post(`/api/households/${h.id}/bills`).set(csrf).set("cookie", cookie)
    .send({ name: "Electricity", frequency: "ONE_TIME", firstDueDate, amountPaise: 50000 });
  expect(res.status).toBe(201);
  return res.body.data as { id: string };
}

async function createHousehelp(householdId: string, name = "Sunita") {
  const [row] = await ctx.db.insert(househelps).values({ householdId, name }).returning();
  return row!;
}

async function createSettlement(householdId: string, househelpId: string, dueDate: string) {
  const [row] = await ctx.db.insert(salarySettlements).values({
    householdId, househelpId, periodMonth: "2026-09-01", dueDate, basePaise: 1000000, workingDays: 26, netPayablePaise: 1000000,
  }).returning();
  return row!;
}

async function addActiveMember(householdId: string, userId: string) {
  await ctx.db.insert(householdMembers).values({ householdId, userId, role: "MEMBER", status: "ACTIVE" });
}

describe("runEvaluateReminders", () => {
  it("creates an in-app notification for the household owner at a matched offset", async () => {
    const owner = await signupUser(ctx);
    const h = await createHousehold(ctx, owner.cookie);
    await createBill(h, owner.cookie, addDays(TODAY, 7)); // household default BILL offsets include 7

    await runEvaluateReminders(ctx.deps);

    const rows = await ctx.db.select().from(notifications).where(eq(notifications.householdId, h.id));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ userId: owner.id, category: "BILL", severity: "INFO" });
    expect(rows[0]!.idempotencyKey).toMatch(/^bill_occ:.+:before:7:user:/);

    const deliveries = await ctx.db.select().from(notificationDeliveries).where(eq(notificationDeliveries.notificationId, rows[0]!.id));
    expect(deliveries).toHaveLength(2); // IN_APP + WEB_PUSH (default channels)
    expect(deliveries.find((d) => d.channel === "IN_APP")).toMatchObject({ status: "SENT" });
    expect(deliveries.find((d) => d.channel === "WEB_PUSH")).toMatchObject({ status: "PENDING" });
  });

  it("does not create a notification outside the rule's sendHour", async () => {
    const owner = await signupUser(ctx);
    const h = await createHousehold(ctx, owner.cookie);
    await createBill(h, owner.cookie, addDays(TODAY, 7));
    ctx.clock.set(WRONG_HOUR_NOW);

    await runEvaluateReminders(ctx.deps);

    const rows = await ctx.db.select().from(notifications).where(eq(notifications.householdId, h.id));
    expect(rows).toHaveLength(0);
  });

  it("is idempotent across re-runs within the same hour", async () => {
    const owner = await signupUser(ctx);
    const h = await createHousehold(ctx, owner.cookie);
    await createBill(h, owner.cookie, addDays(TODAY, 7));

    await runEvaluateReminders(ctx.deps);
    await runEvaluateReminders(ctx.deps);

    const rows = await ctx.db.select().from(notifications).where(eq(notifications.householdId, h.id));
    expect(rows).toHaveLength(1);
  });

  it("fans out to every active member, skipping one whose preference disables BILL", async () => {
    const owner = await signupUser(ctx);
    const h = await createHousehold(ctx, owner.cookie);
    const other = await signupUser(ctx);
    await addActiveMember(h.id, other.id);
    await ctx.db.insert(notificationPreferences).values({ householdId: h.id, userId: other.id, category: "BILL", enabled: false });
    await createBill(h, owner.cookie, addDays(TODAY, 7));

    await runEvaluateReminders(ctx.deps);

    const rows = await ctx.db.select().from(notifications).where(eq(notifications.householdId, h.id));
    expect(rows.map((r) => r.userId)).toEqual([owner.id]);
  });

  it("notifies a member with no preference row at all (default-enabled)", async () => {
    const owner = await signupUser(ctx);
    const h = await createHousehold(ctx, owner.cookie);
    const other = await signupUser(ctx);
    await addActiveMember(h.id, other.id);
    await createBill(h, owner.cookie, addDays(TODAY, 7));

    await runEvaluateReminders(ctx.deps);

    const rows = await ctx.db.select().from(notifications).where(eq(notifications.householdId, h.id));
    expect(rows.map((r) => r.userId).sort()).toEqual([other.id, owner.id].sort());
  });

  it("fires an overdue notification daily while unpaid, once per day", async () => {
    const owner = await signupUser(ctx);
    const h = await createHousehold(ctx, owner.cookie);
    await createBill(h, owner.cookie, addDays(TODAY, -9));

    await runEvaluateReminders(ctx.deps);
    await runEvaluateReminders(ctx.deps); // same day — no duplicate

    let rows = await ctx.db.select().from(notifications).where(eq(notifications.householdId, h.id));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.severity).toBe("URGENT");

    ctx.clock.set("2026-09-30T03:30:00Z"); // next day, same send hour
    await runEvaluateReminders(ctx.deps);

    rows = await ctx.db.select().from(notifications).where(eq(notifications.householdId, h.id));
    expect(rows).toHaveLength(2);
  });

  it("keeps notifications isolated between households", async () => {
    const ownerA = await signupUser(ctx);
    const hA = await createHousehold(ctx, ownerA.cookie, "Household A");
    await createBill(hA, ownerA.cookie, addDays(TODAY, 7));
    const ownerB = await signupUser(ctx);
    const hB = await createHousehold(ctx, ownerB.cookie, "Household B");

    await runEvaluateReminders(ctx.deps);

    const rowsA = await ctx.db.select().from(notifications).where(eq(notifications.householdId, hA.id));
    const rowsB = await ctx.db.select().from(notifications).where(eq(notifications.householdId, hB.id));
    expect(rowsA).toHaveLength(1);
    expect(rowsB).toHaveLength(0);
  });

  it("creates a SALARY notification for a due settlement with the settlement idempotency-key prefix", async () => {
    const owner = await signupUser(ctx);
    const h = await createHousehold(ctx, owner.cookie);
    const help = await createHousehelp(h.id);
    await createSettlement(h.id, help.id, addDays(TODAY, 3)); // household default SALARY offsets: [3, 0]

    await runEvaluateReminders(ctx.deps);

    const rows = await ctx.db.select().from(notifications).where(eq(notifications.householdId, h.id));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ category: "SALARY", userId: owner.id });
    expect(rows[0]!.idempotencyKey).toMatch(/^settlement:.+:before:3:user:/);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm run test --workspace @household/api -- evaluate-reminders`
Expected: FAIL — `Cannot find module '../src/jobs/evaluate-reminders.job.js'`.

- [ ] **Step 3: Implement the job**

Create `apps/api/src/jobs/evaluate-reminders.job.ts`:

```typescript
import { and, eq, isNull } from "drizzle-orm";
import { dateInZone, hourInZone, type ISODate } from "@household/shared";
import { households, householdMembers, notifications, notificationDeliveries, notificationPreferences } from "../db/schema.js";
import type { Deps } from "../services/deps.js";
import { getDueBillOccurrences, getDueSettlements, type DueBillOccurrence, type DueSettlement } from "../services/reminder-evaluation.service.js";

function isUniqueViolation(err: unknown): boolean {
  const e = err as { code?: string; cause?: { code?: string } };
  return e?.code === "23505" || e?.cause?.code === "23505";
}

type NotificationChannelValue = "IN_APP" | "WEB_PUSH" | "EMAIL" | "SMS" | "WHATSAPP";
const DEFAULT_CHANNELS: readonly NotificationChannelValue[] = ["IN_APP", "WEB_PUSH"];

type Outcome = { kind: "before"; offset: number } | { kind: "overdue" };

/** `matchedOffsets` has at most one entry (offsetsDaysSchema forbids duplicates); overdue and a
 * matched offset are mutually exclusive (overdue requires daysUntilDue < 0, a matched offset
 * requires daysUntilDue === offset >= 0) — so every due item resolves to at most one outcome. */
function outcomeFor(item: { matchedOffsets: number[]; isOverdue: boolean }): Outcome | null {
  if (item.isOverdue) return { kind: "overdue" };
  if (item.matchedOffsets.length > 0) return { kind: "before", offset: item.matchedOffsets[0]! };
  return null;
}

function severityFor(outcome: Outcome): "INFO" | "WARNING" | "URGENT" {
  if (outcome.kind === "overdue") return "URGENT";
  return outcome.offset <= 1 ? "WARNING" : "INFO";
}

function idempotencyKey(prefix: "bill_occ" | "settlement", id: string, outcome: Outcome, today: ISODate, userId: string): string {
  const middle = outcome.kind === "overdue" ? `overdue:${today}` : `before:${outcome.offset}`;
  return `${prefix}:${id}:${middle}:user:${userId}`;
}

function billContent(item: DueBillOccurrence, outcome: Outcome): { title: string; body: string } {
  const amount = (item.amountDuePaise / 100).toFixed(2);
  if (outcome.kind === "overdue") {
    return { title: `${item.billName} overdue by ${-item.daysUntilDue} day(s)`, body: `₹${amount} was due on ${item.dueDate} and is still unpaid.` };
  }
  const title = outcome.offset === 0 ? `${item.billName} due today` : `${item.billName} due in ${outcome.offset} day(s)`;
  return { title, body: `₹${amount} is due on ${item.dueDate}.` };
}

function settlementContent(item: DueSettlement, outcome: Outcome): { title: string; body: string } {
  const amount = (item.netPayablePaise / 100).toFixed(2);
  if (outcome.kind === "overdue") {
    return { title: `${item.househelpName}'s salary overdue by ${-item.daysUntilDue} day(s)`, body: `₹${amount} was due on ${item.dueDate} and is still unpaid.` };
  }
  const title = outcome.offset === 0 ? `${item.househelpName}'s salary due today` : `${item.househelpName}'s salary due in ${outcome.offset} day(s)`;
  return { title, body: `₹${amount} is due on ${item.dueDate}.` };
}

type Recipient = { userId: string; channels: readonly NotificationChannelValue[] };

/** Every ACTIVE member of `householdId`, minus anyone whose `notification_preferences` row for
 * `category` has `enabled: false`. A missing preference row means "enabled, default channels" —
 * matches the column's own `enabled.default(true)` and the fact that invited members never get a
 * preferences row seeded (only the household creator does, in `household.service.ts`). */
async function getRecipients(deps: Deps, householdId: string, category: "BILL" | "SALARY"): Promise<Recipient[]> {
  const [members, prefs] = await Promise.all([
    deps.db.select({ userId: householdMembers.userId }).from(householdMembers)
      .where(and(eq(householdMembers.householdId, householdId), eq(householdMembers.status, "ACTIVE"))),
    deps.db.select().from(notificationPreferences)
      .where(and(eq(notificationPreferences.householdId, householdId), eq(notificationPreferences.category, category))),
  ]);
  const prefByUser = new Map(prefs.map((p) => [p.userId, p]));
  const recipients: Recipient[] = [];
  for (const m of members) {
    const pref = prefByUser.get(m.userId);
    if (pref && !pref.enabled) continue;
    recipients.push({ userId: m.userId, channels: pref?.channels ?? DEFAULT_CHANNELS });
  }
  return recipients;
}

type NotificationInput = {
  householdId: string; userId: string; category: "BILL" | "SALARY"; severity: "INFO" | "WARNING" | "URGENT";
  title: string; body: string; entityType: string; entityId: string; data: Record<string, unknown>;
  idempotencyKey: string; channels: readonly NotificationChannelValue[]; now: Date;
};

/** Inserts the notification + one delivery row per channel in a transaction. A unique-violation on
 * `notifications_idempotency_uq` (a re-run of the same hour, or a retried job) means this exact
 * notification already exists — caught and treated as success, not an error. */
async function createNotification(deps: Deps, input: NotificationInput): Promise<void> {
  try {
    await deps.db.transaction(async (tx) => {
      const [row] = await tx.insert(notifications).values({
        householdId: input.householdId, userId: input.userId, category: input.category, severity: input.severity,
        title: input.title, body: input.body, entityType: input.entityType, entityId: input.entityId,
        data: input.data, idempotencyKey: input.idempotencyKey,
      }).returning({ id: notifications.id });
      const notificationId = row!.id;
      for (const channel of input.channels) {
        await tx.insert(notificationDeliveries).values({
          householdId: input.householdId, notificationId, channel,
          status: channel === "IN_APP" ? "SENT" : "PENDING",
          sentAt: channel === "IN_APP" ? input.now : null,
        });
      }
    });
  } catch (err) {
    if (!isUniqueViolation(err)) throw err;
  }
}

/** Hourly: for every non-archived household, evaluates due bill occurrences and salary settlements
 * against their effective reminder_rules, and creates a notification for every active member whose
 * preferences don't disable that category — gated per item by the effective rule's sendHour matching
 * the household's current local hour. In-app only: non-IN_APP deliveries are recorded PENDING for a
 * later spec's dispatcher. */
export async function runEvaluateReminders(deps: Deps): Promise<void> {
  const now = deps.clock.now();
  const allHouseholds = await deps.db.select({ id: households.id, timezone: households.timezone })
    .from(households).where(isNull(households.archivedAt));

  for (const household of allHouseholds) {
    const today = dateInZone(now, household.timezone);
    const hour = hourInZone(now, household.timezone);

    const [dueBills, dueSettlements] = await Promise.all([
      getDueBillOccurrences(deps, household.id, today),
      getDueSettlements(deps, household.id, today),
    ]);

    for (const item of dueBills) {
      const outcome = outcomeFor(item);
      if (!outcome || item.sendHour !== hour) continue;
      const { title, body } = billContent(item, outcome);
      const recipients = await getRecipients(deps, household.id, "BILL");
      for (const recipient of recipients) {
        await createNotification(deps, {
          householdId: household.id, userId: recipient.userId, category: "BILL", severity: severityFor(outcome),
          title, body, entityType: "bill_occurrence", entityId: item.occurrenceId,
          data: { amountDuePaise: item.amountDuePaise, dueDate: item.dueDate },
          idempotencyKey: idempotencyKey("bill_occ", item.occurrenceId, outcome, today, recipient.userId),
          channels: recipient.channels, now,
        });
      }
    }

    for (const item of dueSettlements) {
      const outcome = outcomeFor(item);
      if (!outcome || item.sendHour !== hour) continue;
      const { title, body } = settlementContent(item, outcome);
      const recipients = await getRecipients(deps, household.id, "SALARY");
      for (const recipient of recipients) {
        await createNotification(deps, {
          householdId: household.id, userId: recipient.userId, category: "SALARY", severity: severityFor(outcome),
          title, body, entityType: "salary_settlement", entityId: item.settlementId,
          data: { netPayablePaise: item.netPayablePaise, dueDate: item.dueDate },
          idempotencyKey: idempotencyKey("settlement", item.settlementId, outcome, today, recipient.userId),
          channels: recipient.channels, now,
        });
      }
    }
  }
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm run test --workspace @household/api -- evaluate-reminders`
Expected: PASS

- [ ] **Step 5: Typecheck and build**

Run: `npm run typecheck --workspace @household/api && npm run build --workspace @household/api`
Expected: PASS, no type errors.

- [ ] **Step 6: Wire the job into the worker process**

In `apps/api/src/worker.ts`, add the import after the existing heartbeat import (line 3):

```typescript
import { runHeartbeat } from "./jobs/heartbeat.job.js";
import { runEvaluateReminders } from "./jobs/evaluate-reminders.job.js";
```

Add the handler registration after `deps.queue.registerHandler("heartbeat", () => runHeartbeat(deps));` (line 25):

```typescript
deps.queue.registerHandler("heartbeat", () => runHeartbeat(deps));
deps.queue.registerHandler("evaluate-reminders", () => runEvaluateReminders(deps));
```

Add the schedule call after `await deps.queue.scheduleRepeating("heartbeat", {}, 60_000);` (line 44):

```typescript
await deps.queue.scheduleRepeating("heartbeat", {}, 60_000);
await deps.queue.scheduleRepeating("evaluate-reminders", {}, 60 * 60 * 1000);
```

- [ ] **Step 7: Commit**

```bash
git add apps/api/src/jobs/evaluate-reminders.job.ts apps/api/tests/evaluate-reminders.test.ts apps/api/src/worker.ts
git commit -m "feat(api): notification-creation job for due bill/salary reminders"
```

---

## Self-Review Notes

- **Spec coverage:** hourly scheduling ✓ (Task 2 Step 6), per-item sendHour gating ✓ (Task 1 exposes it, Task 2 uses it + test), recipient fan-out with preference filtering + default-enabled-when-no-row ✓ (test), idempotency key format for both outcome kinds ✓ (matches schema doc comment exactly, tested), in-app-only delivery semantics (IN_APP SENT, others PENDING) ✓ (test), transactional notification+delivery insert ✓, cross-household isolation ✓ (test), SALARY path ✓ (test). No web UI in this spec, matching the design doc.
- **Type consistency:** `DueBillOccurrence`/`DueSettlement` (Task 1) both carry `sendHour: number`, consumed identically in Task 2's `outcomeFor`/gating logic. `NotificationChannelValue` is used consistently across `DEFAULT_CHANNELS`, `Recipient.channels`, and `NotificationInput.channels`.
- **No placeholders:** every step has runnable code; no "add validation" or "similar to above" steps.
