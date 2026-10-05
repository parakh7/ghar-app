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

    it("amountPaise changing later never retroactively rewrites an already-generated occurrence's amountDuePaise", async () => {
      const owner = await signupUser(ctx);
      const h = await createHousehold(ctx, owner.cookie);
      const bill = await createBill(h, owner.cookie, { name: "Test bill", frequency: "MONTHLY", firstDueDate: "2026-11-05", amountPaise: 100000 });
      const [occurrence] = await listOccurrences(h, bill.id, owner.cookie);
      expect(occurrence!.amountDuePaise).toBe(100000);

      // Manually correct one occurrence's amount (what updateOccurrenceAmount is for).
      await ctx.request.patch(`/api/households/${h.id}/bills/${bill.id}/occurrences/${occurrence!.id}`).set(csrf).set("cookie", owner.cookie)
        .send({ amountDuePaise: 123456 });

      // A plain resync (no bill.amountPaise change) must not touch it.
      await ctx.request.post(`/api/households/${h.id}/bills/${bill.id}/occurrences/sync`).set(csrf).set("cookie", owner.cookie);
      const afterResync = await listOccurrences(h, bill.id, owner.cookie);
      expect(afterResync.find((o) => o.id === occurrence!.id)!.amountDuePaise).toBe(123456);

      // Even changing the bill's own amountPaise must not retroactively touch an existing row —
      // amount sync only ever happens at insert time for a brand-new occurrence. `firstDueDate` is
      // resent unchanged alongside it purely to force `configTouched` so this PATCH actually
      // triggers a resync (amountPaise alone doesn't) — the thing under test is what that resync
      // does to the existing row's amount, not whether it ran.
      await ctx.request.patch(`/api/households/${h.id}/bills/${bill.id}`).set(csrf).set("cookie", owner.cookie)
        .send({ amountPaise: 999999, firstDueDate: "2026-11-05" });
      const afterAmountChange = await listOccurrences(h, bill.id, owner.cookie);
      expect(afterAmountChange.find((o) => o.id === occurrence!.id)!.amountDuePaise).toBe(123456);
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
