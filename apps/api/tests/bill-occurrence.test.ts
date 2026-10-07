import { and, eq } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { occurrenceDueDate, type OccurrenceDueDateFields } from "@household/shared";
import { auditLogs, billOccurrences, householdMembers } from "../src/db/schema.js";
import { createTestContext, csrf, signupUser, truncateAll, type TestContext } from "./helpers.js";

const ctx = createTestContext();
const NOW = "2026-09-29T04:30:00Z"; // 2026-09-29 in Asia/Kolkata — matches FakeClock's default
const TODAY = "2026-09-29";

beforeEach(async () => {
  await truncateAll(ctx.db);
  ctx.clock.set(NOW);
});
afterAll(() => ctx.close());

async function createHousehold(c: TestContext, cookie: string, name = "Shah Family") {
  const res = await c.request.post("/api/households").set(csrf).set("cookie", cookie).send({ name });
  expect(res.status).toBe(201);
  return res.body.data as { id: string };
}

async function addMember(householdId: string, userId: string, role: "OWNER" | "ADMIN" | "MEMBER" | "VIEWER") {
  await ctx.db.insert(householdMembers).values({ householdId, userId, role, status: "ACTIVE", joinedAt: ctx.clock.now() });
}

async function createBill(h: { id: string }, cookie: string, body: Record<string, unknown>) {
  const res = await ctx.request.post(`/api/households/${h.id}/bills`).set(csrf).set("cookie", cookie).send(body);
  expect(res.status).toBe(201);
  return res.body.data as { id: string };
}

async function listOccurrences(h: { id: string }, billId: string, cookie: string) {
  const res = await ctx.request.get(`/api/households/${h.id}/bills/${billId}/occurrences`).set("cookie", cookie);
  expect(res.status).toBe(200);
  return res.body.data as Array<{ id: string; sequence: number; dueDate: string; amountDuePaise: number; amountPaidPaise: number; status: string }>;
}

/** Same bounded-generation rule `ensureOccurrences` implements — reused here as the test oracle so
 * these tests check wiring/locking behavior rather than re-deriving Task 1's date math by hand. */
function expectedDueDates(bill: OccurrenceDueDateFields, horizon: string): string[] {
  if (bill.frequency === "ONE_TIME") return bill.firstDueDate <= horizon ? [bill.firstDueDate] : [];
  const dates: string[] = [];
  for (let sequence = 0; ; sequence++) {
    const d = occurrenceDueDate(bill, sequence);
    if (d > horizon) break;
    dates.push(d);
  }
  return dates;
}

const HORIZON = occurrenceDueDate({ frequency: "YEARLY", intervalCount: 1, intervalUnit: null, firstDueDate: TODAY }, 1);

describe("bill occurrence generation and sync", () => {
  describe("generation per frequency", () => {
    it.each([
      ["ONE_TIME", "2026-11-05"],
      ["WEEKLY", "2026-11-05"],
      ["MONTHLY", "2026-11-05"],
      ["QUARTERLY", "2026-11-05"],
      ["HALF_YEARLY", "2026-11-05"],
      ["YEARLY", "2026-11-05"],
    ])("%s generates the correct count/dates within the 12-month horizon", async (frequency, firstDueDate) => {
      const owner = await signupUser(ctx);
      const h = await createHousehold(ctx, owner.cookie);
      const bill = await createBill(h, owner.cookie, { name: "Test bill", frequency, firstDueDate });
      const occurrences = await listOccurrences(h, bill.id, owner.cookie);

      const expected = expectedDueDates({ frequency: frequency as OccurrenceDueDateFields["frequency"], intervalCount: 1, intervalUnit: null, firstDueDate }, HORIZON);
      expect(occurrences.map((o) => o.dueDate)).toEqual(expected);
      occurrences.forEach((o, i) => expect(o.sequence).toBe(i));
    });

    it("CUSTOM generates per intervalCount/intervalUnit", async () => {
      const owner = await signupUser(ctx);
      const h = await createHousehold(ctx, owner.cookie);
      const bill = await createBill(h, owner.cookie, { name: "Custom bill", frequency: "CUSTOM", intervalCount: 10, intervalUnit: "day", firstDueDate: "2026-11-05" });
      const occurrences = await listOccurrences(h, bill.id, owner.cookie);

      const expected = expectedDueDates({ frequency: "CUSTOM", intervalCount: 10, intervalUnit: "day", firstDueDate: "2026-11-05" }, HORIZON);
      expect(occurrences.map((o) => o.dueDate)).toEqual(expected);
    });

    it("every generated occurrence is PENDING with amountPaidPaise 0", async () => {
      const owner = await signupUser(ctx);
      const h = await createHousehold(ctx, owner.cookie);
      const bill = await createBill(h, owner.cookie, { name: "Test bill", frequency: "MONTHLY", firstDueDate: "2026-11-05", amountPaise: 150000 });
      const occurrences = await listOccurrences(h, bill.id, owner.cookie);
      expect(occurrences.length).toBeGreaterThan(0);
      occurrences.forEach((o) => expect(o).toMatchObject({ status: "PENDING", amountPaidPaise: 0, amountDuePaise: 150000 }));
    });

    it("a variable-amount bill (amountPaise omitted) generates occurrences with amountDuePaise 0", async () => {
      const owner = await signupUser(ctx);
      const h = await createHousehold(ctx, owner.cookie);
      const bill = await createBill(h, owner.cookie, { name: "Electricity", frequency: "MONTHLY", firstDueDate: "2026-11-05" });
      const occurrences = await listOccurrences(h, bill.id, owner.cookie);
      expect(occurrences.length).toBeGreaterThan(0);
      occurrences.forEach((o) => expect(o.amountDuePaise).toBe(0));
    });
  });

  describe("ONE_TIME is generated exactly once", () => {
    it("calling sync again does not add a second occurrence", async () => {
      const owner = await signupUser(ctx);
      const h = await createHousehold(ctx, owner.cookie);
      const bill = await createBill(h, owner.cookie, { name: "Annual fee", frequency: "ONE_TIME", firstDueDate: "2026-11-05" });
      const before = await listOccurrences(h, bill.id, owner.cookie);
      expect(before).toHaveLength(1);

      const syncRes = await ctx.request.post(`/api/households/${h.id}/bills/${bill.id}/occurrences/sync`).set(csrf).set("cookie", owner.cookie);
      expect(syncRes.status).toBe(200);

      const after = await listOccurrences(h, bill.id, owner.cookie);
      expect(after).toHaveLength(1);
      expect(after[0]!.id).toBe(before[0]!.id);
    });
  });

  describe("PAUSED/ARCHIVED bills do not generate", () => {
    it.each(["pause", "archive"])("sync is a no-op once the bill is %sd", async (transition) => {
      const owner = await signupUser(ctx);
      const h = await createHousehold(ctx, owner.cookie);
      const bill = await createBill(h, owner.cookie, { name: "Test bill", frequency: "MONTHLY", firstDueDate: "2026-11-05" });
      const before = await listOccurrences(h, bill.id, owner.cookie);
      expect(before.length).toBeGreaterThan(0);

      await ctx.request.post(`/api/households/${h.id}/bills/${bill.id}/${transition}`).set(csrf).set("cookie", owner.cookie);
      const syncRes = await ctx.request.post(`/api/households/${h.id}/bills/${bill.id}/occurrences/sync`).set(csrf).set("cookie", owner.cookie);
      expect(syncRes.status).toBe(200);

      const after = await listOccurrences(h, bill.id, owner.cookie);
      expect(after).toEqual(before);
    });
  });

  describe("mode-flip exploit (N1) and ONE_TIME floor exemption (N2)", () => {
    /**
     * N1: "first generation vs resync" mode used to be INFERRED from `existingRows.length === 0`.
     * Exploit: shorten a bill's schedule into the past so a resync deletes every future unlocked
     * row (count now 0), then call the read-gated `/sync` endpoint — with the old inferred mode,
     * zero existing rows would be wrongly read as "first generation" again, backfilling a fresh
     * flood of overdue history from a passive action. `isInitialGeneration` is now an explicit flag
     * set only once, by `createBill` — this proves a later empty-row state can't retrigger it.
     */
    it("a plain /sync after a bill's occurrences have all been emptied out does not re-manufacture overdue rows", async () => {
      const owner = await signupUser(ctx);
      const h = await createHousehold(ctx, owner.cookie);
      const bill = await createBill(h, owner.cookie, { name: "Test bill", frequency: "MONTHLY", firstDueDate: "2026-11-05" });
      const before = await listOccurrences(h, bill.id, owner.cookie);
      expect(before.length).toBeGreaterThan(0);

      // Move the whole schedule into the past — the resync this triggers deletes every (still
      // unlocked, future) existing row, since none of the new needed dates (all <= today, and a
      // resync only keeps dates > today) match any of them.
      const patchRes = await ctx.request.patch(`/api/households/${h.id}/bills/${bill.id}`).set(csrf).set("cookie", owner.cookie)
        .send({ firstDueDate: "2026-01-05", endDate: "2026-02-05" });
      expect(patchRes.status).toBe(200);
      const emptied = await listOccurrences(h, bill.id, owner.cookie);
      expect(emptied).toHaveLength(0);

      const viewer = await signupUser(ctx);
      await addMember(h.id, viewer.id, "VIEWER");
      const syncRes = await ctx.request.post(`/api/households/${h.id}/bills/${bill.id}/occurrences/sync`).set(csrf).set("cookie", viewer.cookie);
      expect(syncRes.status).toBe(200);

      // Still empty — a passive VIEWER-triggered sync must not manufacture overdue history.
      const afterSync = await listOccurrences(h, bill.id, owner.cookie);
      expect(afterSync).toHaveLength(0);
    });

    it("a ONE_TIME bill with firstDueDate more than 12 months in the past still generates its one occurrence", async () => {
      const owner = await signupUser(ctx);
      const h = await createHousehold(ctx, owner.cookie);
      // More than 12 months before TODAY (2026-09-29) — would be excluded by the recurring-bill
      // backfill floor, which must not apply to ONE_TIME at all.
      const bill = await createBill(h, owner.cookie, { name: "Old one-off", frequency: "ONE_TIME", firstDueDate: "2024-01-01" });
      const occurrences = await listOccurrences(h, bill.id, owner.cookie);
      expect(occurrences).toHaveLength(1);
      expect(occurrences[0]).toMatchObject({ dueDate: "2024-01-01", status: "PENDING" });
    });
  });

  describe("very old firstDueDate — starting-sequence bound stays correct and fast", () => {
    // About 11 years before TODAY (2026-09-29) — well past the 12-month backfill floor
    // (`oneYearAgo(TODAY)`). This is exactly the shape of input `startSequenceFor` exists for: before
    // the fix, `ruleDatesWithin`'s loop termination (`dueDate > horizon`) never depended on the
    // floor, so a bill this old paid for iterating its ENTIRE history up to the horizon on every
    // single call — including every passive `/sync`, reachable by any VIEWER on every bill-detail
    // page view.
    const OLD_FIRST_DUE = "2015-01-01";
    // Mirrors the service's own `oneYearAgo(today)` — the floor initial generation actually applies.
    const FLOOR = occurrenceDueDate({ frequency: "CUSTOM", intervalCount: 12, intervalUnit: "month", firstDueDate: TODAY }, -1);

    it("MONTHLY generates exactly the floor-bounded occurrence set, well within a fast-path time budget", async () => {
      const owner = await signupUser(ctx);
      const h = await createHousehold(ctx, owner.cookie);

      const startedAt = Date.now();
      const bill = await createBill(h, owner.cookie, { name: "Old monthly bill", frequency: "MONTHLY", firstDueDate: OLD_FIRST_DUE });
      const occurrences = await listOccurrences(h, bill.id, owner.cookie);
      const elapsedMs = Date.now() - startedAt;

      const expected = expectedDueDates({ frequency: "MONTHLY", intervalCount: 1, intervalUnit: null, firstDueDate: OLD_FIRST_DUE }, HORIZON)
        .filter((d) => d >= FLOOR);
      expect(occurrences.map((o) => o.dueDate)).toEqual(expected);
      // Loose, non-flaky structural bound (generous enough to never flake in CI) — mainly guards
      // against a regression back to unbounded day-granularity iteration, not a tight perf assertion.
      expect(elapsedMs).toBeLessThan(2000);
    });

    it("CUSTOM day/1 (the reported pathological shape) generates exactly the floor-bounded occurrence set, well within a fast-path time budget", async () => {
      const owner = await signupUser(ctx);
      const h = await createHousehold(ctx, owner.cookie);

      const startedAt = Date.now();
      const bill = await createBill(h, owner.cookie, { name: "Old daily bill", frequency: "CUSTOM", intervalCount: 1, intervalUnit: "day", firstDueDate: OLD_FIRST_DUE });
      const occurrences = await listOccurrences(h, bill.id, owner.cookie);
      const elapsedMs = Date.now() - startedAt;

      const expected = expectedDueDates({ frequency: "CUSTOM", intervalCount: 1, intervalUnit: "day", firstDueDate: OLD_FIRST_DUE }, HORIZON)
        .filter((d) => d >= FLOOR);
      expect(occurrences.map((o) => o.dueDate)).toEqual(expected);
      // Before the fix, this shape (CUSTOM/day/1 with an old `firstDueDate`) is what the reviewer's
      // repro was built from (day-granularity iteration from sequence 0 all the way to the horizon,
      // paid on every call). A generous ceiling well under that failure mode, chosen to avoid CI
      // flakiness while still catching a regression back to unbounded iteration.
      expect(elapsedMs).toBeLessThan(2000);
    });
  });

  describe("resuming/unarchiving resyncs a schedule that changed while inactive", () => {
    it("resuming a paused bill resyncs occurrences to whatever schedule was set while paused", async () => {
      const owner = await signupUser(ctx);
      const h = await createHousehold(ctx, owner.cookie);
      const bill = await createBill(h, owner.cookie, { name: "Test bill", frequency: "MONTHLY", firstDueDate: "2026-11-05" });

      await ctx.request.post(`/api/households/${h.id}/bills/${bill.id}/pause`).set(csrf).set("cookie", owner.cookie);
      await ctx.request.patch(`/api/households/${h.id}/bills/${bill.id}`).set(csrf).set("cookie", owner.cookie).send({ frequency: "WEEKLY" });

      // While paused, the edit doesn't touch occurrences yet — still the stale MONTHLY schedule.
      const whilePaused = await listOccurrences(h, bill.id, owner.cookie);
      const expectedMonthly = expectedDueDates({ frequency: "MONTHLY", intervalCount: 1, intervalUnit: null, firstDueDate: "2026-11-05" }, HORIZON);
      expect(whilePaused.map((o) => o.dueDate)).toEqual(expectedMonthly);

      const resumeRes = await ctx.request.post(`/api/households/${h.id}/bills/${bill.id}/resume`).set(csrf).set("cookie", owner.cookie);
      expect(resumeRes.status).toBe(200);

      const afterResume = await listOccurrences(h, bill.id, owner.cookie);
      const expectedWeekly = expectedDueDates({ frequency: "WEEKLY", intervalCount: 1, intervalUnit: null, firstDueDate: "2026-11-05" }, HORIZON);
      expect(afterResume.map((o) => o.dueDate)).toEqual(expectedWeekly);
    });

    it("unarchiving a bill resyncs occurrences to whatever schedule was set while archived", async () => {
      const owner = await signupUser(ctx);
      const h = await createHousehold(ctx, owner.cookie);
      const bill = await createBill(h, owner.cookie, { name: "Test bill", frequency: "MONTHLY", firstDueDate: "2026-11-05" });

      await ctx.request.post(`/api/households/${h.id}/bills/${bill.id}/archive`).set(csrf).set("cookie", owner.cookie);
      await ctx.request.patch(`/api/households/${h.id}/bills/${bill.id}`).set(csrf).set("cookie", owner.cookie).send({ frequency: "WEEKLY" });

      const unarchiveRes = await ctx.request.post(`/api/households/${h.id}/bills/${bill.id}/unarchive`).set(csrf).set("cookie", owner.cookie);
      expect(unarchiveRes.status).toBe(200);

      const afterUnarchive = await listOccurrences(h, bill.id, owner.cookie);
      const expectedWeekly = expectedDueDates({ frequency: "WEEKLY", intervalCount: 1, intervalUnit: null, firstDueDate: "2026-11-05" }, HORIZON);
      expect(afterUnarchive.map((o) => o.dueDate)).toEqual(expectedWeekly);
    });
  });

  describe("regeneration on bill edits", () => {
    /**
     * This is the exact scenario the original (sequence-matched) design got wrong: once an
     * occurrence locks (paid/waived) at some sequence number, a later frequency change can never
     * create a new row at that same slot (the unique (billId, sequence) index is already occupied),
     * leaving a permanent hole and an out-of-order list. MONTHLY -> WEEKLY is a good adversarial
     * case because WEEKLY's dates mostly don't land on MONTHLY's dates (unlike e.g. QUARTERLY,
     * whose dates are a strict subset of MONTHLY's here), so this both proves the locked row
     * survives AND that every one of the new rule's dates gets generated with no gaps.
     */
    it("editing frequency (MONTHLY -> WEEKLY) regenerates future PENDING-unpaid occurrences, leaves a locked (paid) one untouched, and produces a gap-free chronological schedule", async () => {
      const owner = await signupUser(ctx);
      const h = await createHousehold(ctx, owner.cookie);
      const bill = await createBill(h, owner.cookie, { name: "Test bill", frequency: "MONTHLY", firstDueDate: "2026-11-05" });
      const before = await listOccurrences(h, bill.id, owner.cookie);
      // 2026-12-05 = the second MONTHLY occurrence; simulate it having been paid off already
      // (Spec 3 hasn't built payment-recording yet, so this is done via a direct DB write).
      const lockedBefore = before.find((o) => o.dueDate === "2026-12-05")!;
      await ctx.db.update(billOccurrences).set({ status: "PAID", amountPaidPaise: 1, paidAt: ctx.clock.now() }).where(eq(billOccurrences.id, lockedBefore.id));

      const res = await ctx.request.patch(`/api/households/${h.id}/bills/${bill.id}`).set(csrf).set("cookie", owner.cookie).send({ frequency: "WEEKLY" });
      expect(res.status).toBe(200);

      const after = await listOccurrences(h, bill.id, owner.cookie);

      // The locked row survives, completely untouched, at its original historical date.
      const lockedAfter = after.find((o) => o.id === lockedBefore.id)!;
      expect(lockedAfter).toMatchObject({ dueDate: "2026-12-05", status: "PAID", amountPaidPaise: 1 });

      const expectedWeekly = expectedDueDates({ frequency: "WEEKLY", intervalCount: 1, intervalUnit: null, firstDueDate: "2026-11-05" }, HORIZON);
      // 2026-11-12 is WEEKLY's "slot 1" date — under the old sequence-matched design this would
      // have been permanently blocked (MONTHLY's sequence 1, now locked at 2026-12-05, occupied
      // that slot forever). Asserting it's present directly proves that bug is fixed.
      expect(expectedWeekly).toContain("2026-11-12");

      // Coherent, gap-free, chronologically ordered: every WEEKLY date, plus the one locked
      // historical date, each appearing exactly once, in ascending due-date order.
      const expectedAll = [...expectedWeekly, "2026-12-05"].sort();
      expect(after.map((o) => o.dueDate)).toEqual(expectedAll);
    });

    it("editing frequency reuses an existing unlocked row when the new rule's date happens to coincide with an old one (no needless delete+reinsert)", async () => {
      const owner = await signupUser(ctx);
      const h = await createHousehold(ctx, owner.cookie);
      const bill = await createBill(h, owner.cookie, { name: "Test bill", frequency: "MONTHLY", firstDueDate: "2026-11-05" });
      const before = await listOccurrences(h, bill.id, owner.cookie);
      const anchor = before.find((o) => o.dueDate === "2026-11-05")!;

      // QUARTERLY's dates (every 3 months from the same anchor) are a strict subset of MONTHLY's
      // here, so every QUARTERLY date already exists as an unlocked MONTHLY-generated row.
      const res = await ctx.request.patch(`/api/households/${h.id}/bills/${bill.id}`).set(csrf).set("cookie", owner.cookie).send({ frequency: "QUARTERLY" });
      expect(res.status).toBe(200);

      const after = await listOccurrences(h, bill.id, owner.cookie);
      const expectedQuarterly = expectedDueDates({ frequency: "QUARTERLY", intervalCount: 1, intervalUnit: null, firstDueDate: "2026-11-05" }, HORIZON);
      expect(after.map((o) => o.dueDate)).toEqual(expectedQuarterly);
      // The anchor row itself (same id) was kept, not deleted and reinserted.
      expect(after.some((o) => o.id === anchor.id)).toBe(true);
    });

    it("shortening endDate deletes now-out-of-range future PENDING occurrences", async () => {
      const owner = await signupUser(ctx);
      const h = await createHousehold(ctx, owner.cookie);
      const bill = await createBill(h, owner.cookie, { name: "Test bill", frequency: "MONTHLY", firstDueDate: "2026-11-05" });
      const before = await listOccurrences(h, bill.id, owner.cookie);
      expect(before.length).toBeGreaterThan(3);

      const res = await ctx.request.patch(`/api/households/${h.id}/bills/${bill.id}`).set(csrf).set("cookie", owner.cookie).send({ endDate: "2027-01-05" });
      expect(res.status).toBe(200);

      const after = await listOccurrences(h, bill.id, owner.cookie);
      expect(after.map((o) => o.dueDate)).toEqual(["2026-11-05", "2026-12-05", "2027-01-05"]);
    });

    it("editing a field unrelated to the recurrence config does not touch occurrences", async () => {
      const owner = await signupUser(ctx);
      const h = await createHousehold(ctx, owner.cookie);
      const bill = await createBill(h, owner.cookie, { name: "Test bill", frequency: "MONTHLY", firstDueDate: "2026-11-05" });
      const before = await listOccurrences(h, bill.id, owner.cookie);

      const res = await ctx.request.patch(`/api/households/${h.id}/bills/${bill.id}`).set(csrf).set("cookie", owner.cookie).send({ provider: "BESCOM" });
      expect(res.status).toBe(200);

      const after = await listOccurrences(h, bill.id, owner.cookie);
      expect(after).toEqual(before);
    });

    it("records one summary audit entry per sync, not one per row, attributed to the triggering user", async () => {
      const owner = await signupUser(ctx);
      const h = await createHousehold(ctx, owner.cookie);
      const bill = await createBill(h, owner.cookie, { name: "Test bill", frequency: "MONTHLY", firstDueDate: "2026-11-05" });
      const logs = await ctx.db.select().from(auditLogs).where(and(eq(auditLogs.householdId, h.id), eq(auditLogs.action, "bill.occurrencesSynced")));
      expect(logs).toHaveLength(1);
      expect(logs[0]).toMatchObject({ entityId: bill.id, actorUserId: owner.id, newValue: { inserted: expect.any(Number) } });
    });

    it("a resync with no changes writes nothing (exact idempotency, no audit entry)", async () => {
      const owner = await signupUser(ctx);
      const h = await createHousehold(ctx, owner.cookie);
      const bill = await createBill(h, owner.cookie, { name: "Test bill", frequency: "MONTHLY", firstDueDate: "2026-11-05" });

      const countSyncLogs = async () => {
        const logs = await ctx.db.select().from(auditLogs).where(and(eq(auditLogs.householdId, h.id), eq(auditLogs.action, "bill.occurrencesSynced")));
        return logs.length;
      };

      const afterCreate = await countSyncLogs();
      expect(afterCreate).toBe(1); // first generation, at bill-creation time

      const sync1 = await ctx.request.post(`/api/households/${h.id}/bills/${bill.id}/occurrences/sync`).set(csrf).set("cookie", owner.cookie);
      expect(sync1.status).toBe(200);
      expect(await countSyncLogs()).toBe(afterCreate); // nothing changed — no new entry

      const sync2 = await ctx.request.post(`/api/households/${h.id}/bills/${bill.id}/occurrences/sync`).set(csrf).set("cookie", owner.cookie);
      expect(sync2.status).toBe(200);
      expect(await countSyncLogs()).toBe(afterCreate);
    });

    it("a past-due PENDING occurrence survives a resync untouched (locked by being overdue, not just by payment)", async () => {
      const owner = await signupUser(ctx);
      const h = await createHousehold(ctx, owner.cookie);
      // firstDueDate in the past relative to TODAY (2026-09-29) — first generation backfills
      // overdue history, so this bill is created with several already-past-due PENDING rows.
      const bill = await createBill(h, owner.cookie, { name: "Test bill", frequency: "MONTHLY", firstDueDate: "2026-01-05" });
      const before = await listOccurrences(h, bill.id, owner.cookie);
      const pastDue = before.filter((o) => o.dueDate <= TODAY);
      expect(pastDue.length).toBeGreaterThan(0);

      const syncRes = await ctx.request.post(`/api/households/${h.id}/bills/${bill.id}/occurrences/sync`).set(csrf).set("cookie", owner.cookie);
      expect(syncRes.status).toBe(200);

      const after = await listOccurrences(h, bill.id, owner.cookie);
      const pastDueAfter = after.filter((o) => pastDue.some((p) => p.id === o.id));
      expect(pastDueAfter).toEqual(pastDue);
    });

    it("a plain resync (no bill.amountPaise change) never retroactively rewrites an already-generated occurrence's amountDuePaise", async () => {
      const owner = await signupUser(ctx);
      const h = await createHousehold(ctx, owner.cookie);
      const bill = await createBill(h, owner.cookie, { name: "Test bill", frequency: "MONTHLY", firstDueDate: "2026-11-05", amountPaise: 100000 });
      const [occurrence] = await listOccurrences(h, bill.id, owner.cookie);
      expect(occurrence!.amountDuePaise).toBe(100000);

      // Manually correct one occurrence's amount (what updateOccurrenceAmount is for).
      await ctx.request.patch(`/api/households/${h.id}/bills/${bill.id}/occurrences/${occurrence!.id}`).set(csrf).set("cookie", owner.cookie)
        .send({ amountDuePaise: 123456 });

      // A plain resync (no bill.amountPaise change) — even one forced via a frequency-touching
      // field — must not touch it. `firstDueDate` is resent unchanged purely to force
      // `configTouched` so this PATCH actually triggers ensureOccurrences.
      await ctx.request.patch(`/api/households/${h.id}/bills/${bill.id}`).set(csrf).set("cookie", owner.cookie).send({ firstDueDate: "2026-11-05" });
      const afterResync = await listOccurrences(h, bill.id, owner.cookie);
      expect(afterResync.find((o) => o.id === occurrence!.id)!.amountDuePaise).toBe(123456);
    });

    /**
     * N3: changing the bill's own `amountPaise` is a deliberate re-pricing, not an incidental
     * resync — distinct from the rule above. It's expected to cascade to every still-open
     * (PENDING, unpaid, future) occurrence, overriding an earlier manual correction, while a
     * locked (paid) or already-past-due occurrence is still never touched.
     */
    it("changing the bill's amountPaise cascades to every future unpaid occurrence (including a previously manually-corrected one), but never touches a locked or past-due occurrence", async () => {
      const owner = await signupUser(ctx);
      const h = await createHousehold(ctx, owner.cookie);
      // firstDueDate in the past — first generation backfills some already-past-due occurrences,
      // giving us a locked-by-being-overdue row to confirm doesn't get re-priced.
      const bill = await createBill(h, owner.cookie, { name: "Test bill", frequency: "MONTHLY", firstDueDate: "2026-01-05", amountPaise: 100000 });
      const before = await listOccurrences(h, bill.id, owner.cookie);
      const pastDue = before.find((o) => o.dueDate <= TODAY)!;
      const future1 = before.find((o) => o.dueDate > TODAY)!;
      const future2 = before.find((o) => o.dueDate > TODAY && o.id !== future1.id)!;

      // Manually correct one future occurrence's amount, and lock another future one by paying it off.
      await ctx.request.patch(`/api/households/${h.id}/bills/${bill.id}/occurrences/${future1.id}`).set(csrf).set("cookie", owner.cookie)
        .send({ amountDuePaise: 123456 });
      await ctx.db.update(billOccurrences).set({ status: "PAID", amountPaidPaise: 100000, paidAt: ctx.clock.now() }).where(eq(billOccurrences.id, future2.id));

      // Re-price the bill itself — a plain amountPaise-only patch, no config fields touched.
      const res = await ctx.request.patch(`/api/households/${h.id}/bills/${bill.id}`).set(csrf).set("cookie", owner.cookie).send({ amountPaise: 999999 });
      expect(res.status).toBe(200);

      const after = await listOccurrences(h, bill.id, owner.cookie);
      // The manually-corrected future occurrence is overridden by the deliberate re-price.
      expect(after.find((o) => o.id === future1.id)!.amountDuePaise).toBe(999999);
      // Every other future PENDING-unpaid occurrence also picks up the new amount.
      after.filter((o) => o.dueDate > TODAY && o.status === "PENDING" && o.amountPaidPaise === 0)
        .forEach((o) => expect(o.amountDuePaise).toBe(999999));
      // The locked (paid) occurrence keeps its original amount.
      expect(after.find((o) => o.id === future2.id)!.amountDuePaise).toBe(100000);
      // The past-due occurrence keeps its original amount too.
      expect(after.find((o) => o.id === pastDue.id)!.amountDuePaise).toBe(100000);

      const [log] = await ctx.db.select().from(auditLogs).where(and(eq(auditLogs.householdId, h.id), eq(auditLogs.action, "bill.occurrenceAmountsRepriced")));
      expect(log).toMatchObject({ entityId: bill.id, actorUserId: owner.id, newValue: { amountDuePaise: 999999 } });
    });

    /**
     * NEW-1: `applyAmountChange` must trigger on the amount ACTUALLY changing, not merely on
     * `amountPaise` being present in the patch body. A "save this form" client (the web edit form)
     * resends every field on every save, including `amountPaise` unchanged — that must not
     * retrigger the re-price and silently undo a manual per-occurrence correction.
     */
    it("renaming a bill while resending its unchanged amountPaise does not disturb a manually-corrected occurrence's amount", async () => {
      const owner = await signupUser(ctx);
      const h = await createHousehold(ctx, owner.cookie);
      const bill = await createBill(h, owner.cookie, { name: "Test bill", frequency: "MONTHLY", firstDueDate: "2026-11-05", amountPaise: 100000 });
      const [occurrence] = await listOccurrences(h, bill.id, owner.cookie);

      await ctx.request.patch(`/api/households/${h.id}/bills/${bill.id}/occurrences/${occurrence!.id}`).set(csrf).set("cookie", owner.cookie)
        .send({ amountDuePaise: 123456 });

      // Resend the bill's entire form, including amountPaise at its EXISTING, unchanged value.
      const res = await ctx.request.patch(`/api/households/${h.id}/bills/${bill.id}`).set(csrf).set("cookie", owner.cookie)
        .send({ name: "Renamed bill", amountPaise: 100000 });
      expect(res.status).toBe(200);

      const after = await listOccurrences(h, bill.id, owner.cookie);
      expect(after.find((o) => o.id === occurrence!.id)!.amountDuePaise).toBe(123456);

      const repriceLogs = await ctx.db.select().from(auditLogs).where(and(eq(auditLogs.householdId, h.id), eq(auditLogs.action, "bill.occurrenceAmountsRepriced")));
      expect(repriceLogs).toHaveLength(0);
    });

    /**
     * NEW-2: `applyAmountChange` needs the same `status !== "ACTIVE"` guard `ensureOccurrences`
     * already has — every other kind of edit on a paused bill is deferred until resume, and an
     * amount edit shouldn't be the one exception that rewrites existing rows immediately.
     *
     * Resume deliberately does NOT catch the amount up (it resyncs the schedule only):
     * `applyAmountChange` can't tell "the bill was re-priced while paused" apart from "a human
     * corrected this one occurrence by hand", so running it on every resume would wipe manual
     * corrections on every pause→resume cycle. The accepted consequence, asserted below, is that
     * existing occurrences keep their old amount after resume — the same deferral a frequency/date
     * edit made while paused already gets.
     */
    it("an amount edit on a paused bill leaves existing occurrences untouched, and resume does not retroactively reprice them", async () => {
      const owner = await signupUser(ctx);
      const h = await createHousehold(ctx, owner.cookie);
      const bill = await createBill(h, owner.cookie, { name: "Test bill", frequency: "MONTHLY", firstDueDate: "2026-11-05", amountPaise: 100000 });

      await ctx.request.post(`/api/households/${h.id}/bills/${bill.id}/pause`).set(csrf).set("cookie", owner.cookie);
      const res = await ctx.request.patch(`/api/households/${h.id}/bills/${bill.id}`).set(csrf).set("cookie", owner.cookie).send({ amountPaise: 999999 });
      expect(res.status).toBe(200);

      // While paused, existing occurrences still show the old amount — the amount edit is deferred,
      // not applied immediately, exactly like a frequency/date edit already is while paused.
      const whilePaused = await listOccurrences(h, bill.id, owner.cookie);
      whilePaused.forEach((o) => expect(o.amountDuePaise).toBe(100000));

      const resumeRes = await ctx.request.post(`/api/households/${h.id}/bills/${bill.id}/resume`).set(csrf).set("cookie", owner.cookie);
      expect(resumeRes.status).toBe(200);

      // Resuming resyncs the SCHEDULE only — already-generated rows keep the amount they were
      // created with. The deferred amount edit is not retroactively applied (see resumeBill's doc
      // comment: doing so would wipe manual per-occurrence corrections on every pause→resume).
      const afterResume = await listOccurrences(h, bill.id, owner.cookie);
      afterResume.forEach((o) => expect(o.amountDuePaise).toBe(100000));
    });

    /**
     * Regression guard for the data-loss bug that resume-time `applyAmountChange` caused: a manual
     * per-occurrence correction must survive a pause→resume round trip with NO amount change at all
     * in between. Covers the worst case too — a variable-amount bill (`amountPaise: null`, so the
     * "bill's current amount" is 0) whose occurrences were all priced by hand.
     */
    it("a pause -> resume round trip with no amount change preserves manually-corrected occurrence amounts", async () => {
      const owner = await signupUser(ctx);
      const h = await createHousehold(ctx, owner.cookie);

      const fixed = await createBill(h, owner.cookie, { name: "Fixed bill", frequency: "MONTHLY", firstDueDate: "2026-11-05", amountPaise: 100000 });
      const [corrected] = await listOccurrences(h, fixed.id, owner.cookie);
      await ctx.request.patch(`/api/households/${h.id}/bills/${fixed.id}/occurrences/${corrected!.id}`).set(csrf).set("cookie", owner.cookie)
        .send({ amountDuePaise: 123456 });

      // Variable-amount bill: no default amount at all, every occurrence priced by hand.
      const variable = await createBill(h, owner.cookie, { name: "Electricity", frequency: "MONTHLY", firstDueDate: "2026-11-10", amountPaise: null });
      const variableOccurrences = (await listOccurrences(h, variable.id, owner.cookie)).slice(0, 3);
      const handPriced = [550000, 612300, 489900];
      for (const [i, o] of variableOccurrences.entries()) {
        await ctx.request.patch(`/api/households/${h.id}/bills/${variable.id}/occurrences/${o.id}`).set(csrf).set("cookie", owner.cookie)
          .send({ amountDuePaise: handPriced[i] });
      }

      for (const id of [fixed.id, variable.id]) {
        expect((await ctx.request.post(`/api/households/${h.id}/bills/${id}/pause`).set(csrf).set("cookie", owner.cookie)).status).toBe(200);
        expect((await ctx.request.post(`/api/households/${h.id}/bills/${id}/resume`).set(csrf).set("cookie", owner.cookie)).status).toBe(200);
      }

      const fixedAfter = await listOccurrences(h, fixed.id, owner.cookie);
      expect(fixedAfter.find((o) => o.id === corrected!.id)!.amountDuePaise).toBe(123456);

      const variableAfter = await listOccurrences(h, variable.id, owner.cookie);
      variableOccurrences.forEach((o, i) => {
        expect(variableAfter.find((v) => v.id === o.id)!.amountDuePaise).toBe(handPriced[i]);
      });
    });
  });

  describe("updateOccurrenceAmount", () => {
    it("updates the amount of a PENDING occurrence and records an audit entry", async () => {
      const owner = await signupUser(ctx);
      const h = await createHousehold(ctx, owner.cookie);
      const bill = await createBill(h, owner.cookie, { name: "Test bill", frequency: "MONTHLY", firstDueDate: "2026-11-05" });
      const [occurrence] = await listOccurrences(h, bill.id, owner.cookie);

      const res = await ctx.request.patch(`/api/households/${h.id}/bills/${bill.id}/occurrences/${occurrence!.id}`).set(csrf).set("cookie", owner.cookie)
        .send({ amountDuePaise: 250000 });
      expect(res.status).toBe(200);
      expect(res.body.data.amountDuePaise).toBe(250000);

      const [log] = await ctx.db.select().from(auditLogs).where(and(eq(auditLogs.householdId, h.id), eq(auditLogs.action, "bill.occurrenceAmountUpdated")));
      expect(log).toMatchObject({ entityId: occurrence!.id, newValue: { amountDuePaise: 250000 } });
    });

    it("rejects updating the amount of a non-PENDING occurrence", async () => {
      const owner = await signupUser(ctx);
      const h = await createHousehold(ctx, owner.cookie);
      const bill = await createBill(h, owner.cookie, { name: "Test bill", frequency: "MONTHLY", firstDueDate: "2026-11-05" });
      const [occurrence] = await listOccurrences(h, bill.id, owner.cookie);
      await ctx.db.update(billOccurrences).set({ status: "WAIVED", waivedAt: ctx.clock.now() }).where(eq(billOccurrences.id, occurrence!.id));

      const res = await ctx.request.patch(`/api/households/${h.id}/bills/${bill.id}/occurrences/${occurrence!.id}`).set(csrf).set("cookie", owner.cookie)
        .send({ amountDuePaise: 250000 });
      expect(res.status).toBe(400);
    });

    it("404s for an occurrence id that doesn't exist", async () => {
      const owner = await signupUser(ctx);
      const h = await createHousehold(ctx, owner.cookie);
      const bill = await createBill(h, owner.cookie, { name: "Test bill", frequency: "MONTHLY", firstDueDate: "2026-11-05" });
      const res = await ctx.request.patch(`/api/households/${h.id}/bills/${bill.id}/occurrences/00000000-0000-0000-0000-000000000000`).set(csrf).set("cookie", owner.cookie)
        .send({ amountDuePaise: 250000 });
      expect(res.status).toBe(404);
    });

    it("404s when the URL's bill id doesn't match the occurrence's actual bill (same household)", async () => {
      const owner = await signupUser(ctx);
      const h = await createHousehold(ctx, owner.cookie);
      const billA = await createBill(h, owner.cookie, { name: "Bill A", frequency: "MONTHLY", firstDueDate: "2026-11-05" });
      const billB = await createBill(h, owner.cookie, { name: "Bill B", frequency: "MONTHLY", firstDueDate: "2026-11-05" });
      const [occurrenceA] = await listOccurrences(h, billA.id, owner.cookie);

      const res = await ctx.request.patch(`/api/households/${h.id}/bills/${billB.id}/occurrences/${occurrenceA!.id}`).set(csrf).set("cookie", owner.cookie)
        .send({ amountDuePaise: 1 });
      expect(res.status).toBe(404);

      // The occurrence itself is untouched.
      const stillA = await listOccurrences(h, billA.id, owner.cookie);
      expect(stillA.find((o) => o.id === occurrenceA!.id)!.amountDuePaise).toBe(occurrenceA!.amountDuePaise);
    });
  });

  describe("filters", () => {
    it("filters by status", async () => {
      const owner = await signupUser(ctx);
      const h = await createHousehold(ctx, owner.cookie);
      const bill = await createBill(h, owner.cookie, { name: "Test bill", frequency: "MONTHLY", firstDueDate: "2026-11-05" });
      const [occurrence] = await listOccurrences(h, bill.id, owner.cookie);
      await ctx.db.update(billOccurrences).set({ status: "WAIVED", waivedAt: ctx.clock.now() }).where(eq(billOccurrences.id, occurrence!.id));

      const res = await ctx.request.get(`/api/households/${h.id}/bills/${bill.id}/occurrences?status=WAIVED`).set("cookie", owner.cookie);
      expect(res.status).toBe(200);
      expect(res.body.data).toHaveLength(1);
      expect(res.body.data[0].id).toBe(occurrence!.id);
    });

    it("rejects an invalid status filter", async () => {
      const owner = await signupUser(ctx);
      const h = await createHousehold(ctx, owner.cookie);
      const bill = await createBill(h, owner.cookie, { name: "Test bill", frequency: "MONTHLY", firstDueDate: "2026-11-05" });
      const res = await ctx.request.get(`/api/households/${h.id}/bills/${bill.id}/occurrences?status=BOGUS`).set("cookie", owner.cookie);
      expect(res.status).toBe(400);
    });

    it("filters by from/to date range", async () => {
      const owner = await signupUser(ctx);
      const h = await createHousehold(ctx, owner.cookie);
      const bill = await createBill(h, owner.cookie, { name: "Test bill", frequency: "MONTHLY", firstDueDate: "2026-11-05" });
      const res = await ctx.request.get(`/api/households/${h.id}/bills/${bill.id}/occurrences?from=2026-12-01&to=2027-01-31`).set("cookie", owner.cookie);
      expect(res.status).toBe(200);
      expect(res.body.data.map((o: { dueDate: string }) => o.dueDate)).toEqual(["2026-12-05", "2027-01-05"]);
    });
  });

  describe("cross-household isolation", () => {
    it("404s listing occurrences for a bill in another household", async () => {
      const owner = await signupUser(ctx);
      const h = await createHousehold(ctx, owner.cookie);
      const bill = await createBill(h, owner.cookie, { name: "Test bill", frequency: "MONTHLY", firstDueDate: "2026-11-05" });

      const other = await signupUser(ctx);
      const hOther = await createHousehold(ctx, other.cookie, "Other household");

      const res = await ctx.request.get(`/api/households/${hOther.id}/bills/${bill.id}/occurrences`).set("cookie", other.cookie);
      expect(res.status).toBe(404);
    });

    it("404s patching an occurrence amount scoped to another household", async () => {
      const owner = await signupUser(ctx);
      const h = await createHousehold(ctx, owner.cookie);
      const bill = await createBill(h, owner.cookie, { name: "Test bill", frequency: "MONTHLY", firstDueDate: "2026-11-05" });
      const [occurrence] = await listOccurrences(h, bill.id, owner.cookie);

      const other = await signupUser(ctx);
      const hOther = await createHousehold(ctx, other.cookie, "Other household");

      const res = await ctx.request.patch(`/api/households/${hOther.id}/bills/${bill.id}/occurrences/${occurrence!.id}`).set(csrf).set("cookie", other.cookie)
        .send({ amountDuePaise: 1 });
      expect(res.status).toBe(404);
    });
  });

  describe("permission gating", () => {
    it("VIEWER can list occurrences and trigger sync but not patch an amount", async () => {
      const owner = await signupUser(ctx);
      const h = await createHousehold(ctx, owner.cookie);
      const bill = await createBill(h, owner.cookie, { name: "Test bill", frequency: "MONTHLY", firstDueDate: "2026-11-05" });
      const [occurrence] = await listOccurrences(h, bill.id, owner.cookie);

      const viewer = await signupUser(ctx);
      await addMember(h.id, viewer.id, "VIEWER");

      const listRes = await ctx.request.get(`/api/households/${h.id}/bills/${bill.id}/occurrences`).set("cookie", viewer.cookie);
      expect(listRes.status).toBe(200);

      const syncRes = await ctx.request.post(`/api/households/${h.id}/bills/${bill.id}/occurrences/sync`).set(csrf).set("cookie", viewer.cookie);
      expect(syncRes.status).toBe(200);

      const patchRes = await ctx.request.patch(`/api/households/${h.id}/bills/${bill.id}/occurrences/${occurrence!.id}`).set(csrf).set("cookie", viewer.cookie)
        .send({ amountDuePaise: 1 });
      expect(patchRes.status).toBe(403);
    });

    it("ADMIN can patch an occurrence amount", async () => {
      const owner = await signupUser(ctx);
      const h = await createHousehold(ctx, owner.cookie);
      const bill = await createBill(h, owner.cookie, { name: "Test bill", frequency: "MONTHLY", firstDueDate: "2026-11-05" });
      const [occurrence] = await listOccurrences(h, bill.id, owner.cookie);

      const admin = await signupUser(ctx);
      await addMember(h.id, admin.id, "ADMIN");

      const res = await ctx.request.patch(`/api/households/${h.id}/bills/${bill.id}/occurrences/${occurrence!.id}`).set(csrf).set("cookie", admin.cookie)
        .send({ amountDuePaise: 1 });
      expect(res.status).toBe(200);
    });
  });
});
