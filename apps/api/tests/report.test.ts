import { eq } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { attendanceRecords, billOccurrences, checklistCompletions, checklistTasks, households, householdMembers, househelps, salarySettlements } from "../src/db/schema.js";
import { createTestContext, csrf, signupUser, truncateAll, type TestContext } from "./helpers.js";

const ctx = createTestContext();

beforeEach(async () => { await truncateAll(ctx.db); });
afterAll(() => ctx.close());

async function createHousehold(c: TestContext, cookie: string, name = "Shah Family") {
  const res = await c.request.post("/api/households").set(csrf).set("cookie", cookie).send({ name });
  expect(res.status).toBe(201);
  return res.body.data as { id: string };
}

async function createHousehelp(householdId: string, name: string) {
  const [row] = await ctx.db.insert(househelps).values({ householdId, name }).returning();
  return row!;
}

async function createBill(h: { id: string }, cookie: string, firstDueDate: string) {
  const res = await ctx.request.post(`/api/households/${h.id}/bills`).set(csrf).set("cookie", cookie)
    .send({ name: "Electricity", frequency: "ONE_TIME", firstDueDate, amountPaise: 50000 });
  expect(res.status).toBe(201);
  const bill = res.body.data as { id: string };
  const [occurrence] = await ctx.db.select().from(billOccurrences).where(eq(billOccurrences.billId, bill.id));
  return { bill, occurrence: occurrence! };
}

async function createSettlement(householdId: string, househelpId: string, periodMonth: string, dueDate: string, overrides: Record<string, unknown> = {}) {
  const [row] = await ctx.db.insert(salarySettlements).values({
    householdId, househelpId, periodMonth, dueDate, basePaise: 1000000, workingDays: 26, netPayablePaise: 1000000, ...overrides,
  }).returning();
  return row!;
}

async function addMember(householdId: string, userId: string, overrides: Record<string, unknown> = {}) {
  // listMembers()'s toMemberDTO (and any route that touches it) non-null-asserts joinedAt — must set
  // it here or a 500 surfaces the instant anything in the request path touches member listing.
  await ctx.db.insert(householdMembers).values({ householdId, userId, role: "MEMBER", status: "ACTIVE", joinedAt: ctx.clock.now(), ...overrides });
}

async function report(h: { id: string }, cookie: string, type: string, month: string) {
  return ctx.request.get(`/api/households/${h.id}/reports?type=${type}&month=${month}`).set("cookie", cookie);
}

describe("GET /reports", () => {
  it("bills: includes occurrences due in the month at any status, with correct totals, excluding other months", async () => {
    const owner = await signupUser(ctx);
    const h = await createHousehold(ctx, owner.cookie);
    const { occurrence: pending } = await createBill(h, owner.cookie, "2026-09-15");
    const { occurrence: paid } = await createBill(h, owner.cookie, "2026-09-20");
    await ctx.db.update(billOccurrences).set({ status: "PAID", amountPaidPaise: 50000 }).where(eq(billOccurrences.id, paid.id));
    await createBill(h, owner.cookie, "2026-10-01"); // different month — excluded

    const res = await report(h, owner.cookie, "bills", "2026-09");
    expect(res.status).toBe(200);
    const ids = res.body.data.rows.map((r: { occurrenceId: string }) => r.occurrenceId);
    expect(ids).toContain(pending.id);
    expect(ids).toContain(paid.id);
    expect(ids).toHaveLength(2);
    expect(res.body.data.totalDuePaise).toBe(100000);
    expect(res.body.data.totalPaidPaise).toBe(50000);
  });

  it("salary: filters to the selected period month, with totals", async () => {
    const owner = await signupUser(ctx);
    const h = await createHousehold(ctx, owner.cookie);
    const help = await createHousehelp(h.id, "Sunita");
    const included = await createSettlement(h.id, help.id, "2026-09-01", "2026-09-05", { amountPaidPaise: 400000 });
    await createSettlement(h.id, help.id, "2026-10-01", "2026-10-05"); // different month — excluded

    const res = await report(h, owner.cookie, "salary", "2026-09");
    expect(res.status).toBe(200);
    expect(res.body.data.rows).toEqual([
      { settlementId: included.id, househelpId: help.id, househelpName: "Sunita", netPayablePaise: 1000000, amountPaidPaise: 400000, status: "PENDING" },
    ]);
    expect(res.body.data.totalNetPayablePaise).toBe(1000000);
    expect(res.body.data.totalPaidPaise).toBe(400000);
  });

  it("attendance: tallies status counts per househelp for the month, excluding other months", async () => {
    const owner = await signupUser(ctx);
    const h = await createHousehold(ctx, owner.cookie);
    const help = await createHousehelp(h.id, "Sunita");
    await ctx.db.insert(attendanceRecords).values([
      { householdId: h.id, househelpId: help.id, date: "2026-09-01", status: "PRESENT" },
      { householdId: h.id, househelpId: help.id, date: "2026-09-02", status: "PRESENT" },
      { householdId: h.id, househelpId: help.id, date: "2026-09-03", status: "ABSENT" },
      { householdId: h.id, househelpId: help.id, date: "2026-09-04", status: "LEAVE" },
      { householdId: h.id, househelpId: help.id, date: "2026-10-01", status: "PRESENT" },
    ]);

    const res = await report(h, owner.cookie, "attendance", "2026-09");
    expect(res.status).toBe(200);
    expect(res.body.data.rows).toEqual([
      { househelpId: help.id, name: "Sunita", present: 2, absent: 1, halfDay: 0, leave: 1, holiday: 0 },
    ]);
  });

  it("checklist: tallies due/completed/skipped/missed across the month, respecting frequency", async () => {
    const owner = await signupUser(ctx);
    const h = await createHousehold(ctx, owner.cookie);
    const [daily] = await ctx.db.insert(checklistTasks).values({ householdId: h.id, name: "Wash dishes", frequency: "DAILY" }).returning();
    const [weekly] = await ctx.db.insert(checklistTasks).values({ householdId: h.id, name: "Vacuum", frequency: "WEEKLY", weekdays: [1] }).returning();
    await ctx.db.insert(checklistCompletions).values({ householdId: h.id, taskId: daily!.id, date: "2026-09-01", status: "COMPLETED" });
    await ctx.db.insert(checklistCompletions).values({ householdId: h.id, taskId: daily!.id, date: "2026-09-02", status: "SKIPPED" });

    const res = await report(h, owner.cookie, "checklist", "2026-09");
    expect(res.status).toBe(200);
    const dailyRow = res.body.data.rows.find((r: { taskId: string }) => r.taskId === daily!.id);
    expect(dailyRow).toMatchObject({ dueCount: 30, completedCount: 1, skippedCount: 1, missedCount: 28 });
    const weeklyRow = res.body.data.rows.find((r: { taskId: string }) => r.taskId === weekly!.id);
    expect(weeklyRow.dueCount).toBeGreaterThan(0);
    expect(weeklyRow.dueCount).toBeLessThan(30);
    expect(weeklyRow.completedCount + weeklyRow.skippedCount + weeklyRow.missedCount).toBe(weeklyRow.dueCount);
  });

  it("403s without reports.view", async () => {
    const owner = await signupUser(ctx);
    const h = await createHousehold(ctx, owner.cookie);
    const member = await signupUser(ctx);
    await addMember(h.id, member.id);
    await ctx.db.update(households).set({ rolePermissionOverrides: { MEMBER: { revoke: ["reports.view"] } } }).where(eq(households.id, h.id));

    const res = await report(h, member.cookie, "bills", "2026-09");
    expect(res.status).toBe(403);
  });

  it("400s for an invalid report type", async () => {
    const owner = await signupUser(ctx);
    const h = await createHousehold(ctx, owner.cookie);
    const res = await report(h, owner.cookie, "nonsense", "2026-09");
    expect(res.status).toBe(400);
  });

  it("never reflects another household's data", async () => {
    const ownerA = await signupUser(ctx);
    const hA = await createHousehold(ctx, ownerA.cookie, "Household A");
    await createBill(hA, ownerA.cookie, "2026-09-10");

    const ownerB = await signupUser(ctx);
    const hB = await createHousehold(ctx, ownerB.cookie, "Household B");

    const res = await report(hB, ownerB.cookie, "bills", "2026-09");
    expect(res.body.data.rows).toEqual([]);
  });
});
