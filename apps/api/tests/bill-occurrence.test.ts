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

  describe("regeneration on bill edits", () => {
    it("editing frequency regenerates future PENDING-unpaid occurrences but leaves a locked (paid) one untouched", async () => {
      const owner = await signupUser(ctx);
      const h = await createHousehold(ctx, owner.cookie);
      const bill = await createBill(h, owner.cookie, { name: "Test bill", frequency: "MONTHLY", firstDueDate: "2026-11-05" });
      const before = await listOccurrences(h, bill.id, owner.cookie);
      // sequence 1 = 2026-12-05 under MONTHLY; simulate it having been paid off already (Spec 3
      // hasn't built payment-recording yet, so this is done via a direct DB write).
      const lockedBefore = before.find((o) => o.sequence === 1)!;
      await ctx.db.update(billOccurrences).set({ status: "PAID", amountPaidPaise: 1, paidAt: ctx.clock.now() }).where(eq(billOccurrences.id, lockedBefore.id));

      const res = await ctx.request.patch(`/api/households/${h.id}/bills/${bill.id}`).set(csrf).set("cookie", owner.cookie).send({ frequency: "QUARTERLY" });
      expect(res.status).toBe(200);

      const after = await listOccurrences(h, bill.id, owner.cookie);
      const lockedAfter = after.find((o) => o.sequence === 1)!;
      expect(lockedAfter).toMatchObject({ id: lockedBefore.id, dueDate: "2026-12-05", status: "PAID" });

      const expected = expectedDueDates({ frequency: "QUARTERLY", intervalCount: 1, intervalUnit: null, firstDueDate: "2026-11-05" }, HORIZON);
      // sequence 1's dueDate stays the old MONTHLY value (locked); every other sequence matches the new QUARTERLY schedule.
      const expectedWithLock = expected.map((d, i) => (i === 1 ? "2026-12-05" : d));
      expect(after.map((o) => o.dueDate)).toEqual(expectedWithLock);
      expect(after).toHaveLength(expected.length);
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

    it("records one summary audit entry per sync, not one per row", async () => {
      const owner = await signupUser(ctx);
      const h = await createHousehold(ctx, owner.cookie);
      const bill = await createBill(h, owner.cookie, { name: "Test bill", frequency: "MONTHLY", firstDueDate: "2026-11-05" });
      const logs = await ctx.db.select().from(auditLogs).where(and(eq(auditLogs.householdId, h.id), eq(auditLogs.action, "bill.occurrencesSynced")));
      expect(logs).toHaveLength(1);
      expect(logs[0]).toMatchObject({ entityId: bill.id, newValue: { inserted: expect.any(Number) } });
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
