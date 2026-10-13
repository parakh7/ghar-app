import { eq } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { addDays } from "@household/shared";
import { attendanceRecords, billOccurrences, checklistCompletions, checklistTasks, households, householdMembers, househelps, salarySettlements } from "../src/db/schema.js";
import { createTestContext, csrf, signupUser, truncateAll, type TestContext } from "./helpers.js";

const ctx = createTestContext();
const NOW = "2026-09-29T04:30:00Z"; // 10:00 IST
const TODAY = "2026-09-29";

beforeEach(async () => { await truncateAll(ctx.db); ctx.clock.set(NOW); });
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

async function addMember(householdId: string, userId: string, role: "MEMBER" | "VIEWER" = "MEMBER") {
  await ctx.db.insert(householdMembers).values({ householdId, userId, role, status: "ACTIVE" });
}

let seq = 0;
async function createSettlement(householdId: string, househelpId: string, dueDate: string, overrides: Record<string, unknown> = {}) {
  seq += 1;
  const periodMonth = `2026-${String((seq % 12) + 1).padStart(2, "0")}-01`;
  const [row] = await ctx.db.insert(salarySettlements).values({
    householdId, househelpId, periodMonth, dueDate, basePaise: 1000000, workingDays: 26, netPayablePaise: 1000000, ...overrides,
  }).returning();
  return row!;
}

describe("GET /today", () => {
  it("includes a section only when the caller has its permission", async () => {
    const owner = await signupUser(ctx);
    const h = await createHousehold(ctx, owner.cookie);
    const member = await signupUser(ctx);
    await addMember(h.id, member.id, "MEMBER");
    await ctx.db.update(households).set({ rolePermissionOverrides: { MEMBER: { revoke: ["bills.view"] } } }).where(eq(households.id, h.id));

    const res = await ctx.request.get(`/api/households/${h.id}/today`).set("cookie", member.cookie);
    expect(res.status).toBe(200);
    expect(res.body.data).not.toHaveProperty("bills");
    expect(res.body.data).toHaveProperty("attendance");
    expect(res.body.data).toHaveProperty("checklist");
    expect(res.body.data).toHaveProperty("salary");

    const ownerRes = await ctx.request.get(`/api/households/${h.id}/today`).set("cookie", owner.cookie);
    expect(ownerRes.body.data).toHaveProperty("bills"); // OWNER's permissions can never be revoked
  });

  it("returns empty/zero sections for a household with nothing yet", async () => {
    const owner = await signupUser(ctx);
    const h = await createHousehold(ctx, owner.cookie);

    const res = await ctx.request.get(`/api/households/${h.id}/today`).set("cookie", owner.cookie);
    expect(res.body.data).toEqual({
      attendance: { marked: 0, total: 0 },
      checklist: { done: 0, total: 0, pending: [] },
      bills: [],
      salary: { upcoming: null, hasAnySettlement: false },
    });
  });

  it("computes attendance marked/total from today's active househelps and records", async () => {
    const owner = await signupUser(ctx);
    const h = await createHousehold(ctx, owner.cookie);
    const marked = await createHousehelp(h.id, "Sunita");
    await createHousehelp(h.id, "Geeta");
    await ctx.db.insert(attendanceRecords).values({ householdId: h.id, househelpId: marked.id, date: TODAY, status: "PRESENT" });

    const res = await ctx.request.get(`/api/households/${h.id}/today`).set("cookie", owner.cookie);
    expect(res.body.data.attendance).toEqual({ marked: 1, total: 2 });
  });

  it("computes checklist done/total/pending from today's due tasks and completions", async () => {
    const owner = await signupUser(ctx);
    const h = await createHousehold(ctx, owner.cookie);
    const [doneTask] = await ctx.db.insert(checklistTasks).values({ householdId: h.id, name: "Wash dishes", frequency: "DAILY" }).returning();
    await ctx.db.insert(checklistTasks).values({ householdId: h.id, name: "Sweep floor", frequency: "DAILY" });
    await ctx.db.insert(checklistCompletions).values({ householdId: h.id, taskId: doneTask!.id, date: TODAY, status: "COMPLETED" });

    const res = await ctx.request.get(`/api/households/${h.id}/today`).set("cookie", owner.cookie);
    expect(res.body.data.checklist).toEqual({ done: 1, total: 2, pending: ["Sweep floor"] });
  });

  it("includes bills due today or overdue, excludes future-due bills", async () => {
    const owner = await signupUser(ctx);
    const h = await createHousehold(ctx, owner.cookie);
    const { occurrence: todayOcc } = await createBill(h, owner.cookie, TODAY);
    const { occurrence: overdueOcc } = await createBill(h, owner.cookie, addDays(TODAY, -3));
    await createBill(h, owner.cookie, addDays(TODAY, 5)); // future — excluded

    const res = await ctx.request.get(`/api/households/${h.id}/today`).set("cookie", owner.cookie);
    const ids = res.body.data.bills.map((b: { occurrenceId: string }) => b.occurrenceId);
    expect(ids).toContain(todayOcc.id);
    expect(ids).toContain(overdueOcc.id);
    expect(ids).toHaveLength(2);
    expect(res.body.data.bills.find((b: { occurrenceId: string }) => b.occurrenceId === overdueOcc.id).isOverdue).toBe(true);
    expect(res.body.data.bills.find((b: { occurrenceId: string }) => b.occurrenceId === todayOcc.id).isOverdue).toBe(false);
  });

  it("excludes a paid occurrence due today", async () => {
    const owner = await signupUser(ctx);
    const h = await createHousehold(ctx, owner.cookie);
    const { occurrence } = await createBill(h, owner.cookie, TODAY);
    await ctx.db.update(billOccurrences).set({ status: "PAID", amountPaidPaise: 50000, paidAt: ctx.clock.now() }).where(eq(billOccurrences.id, occurrence.id));

    const res = await ctx.request.get(`/api/households/${h.id}/today`).set("cookie", owner.cookie);
    expect(res.body.data.bills).toEqual([]);
  });

  it("salary picks the single nearest-due unpaid settlement across househelps", async () => {
    const owner = await signupUser(ctx);
    const h = await createHousehold(ctx, owner.cookie);
    const a = await createHousehelp(h.id, "Sunita");
    const b = await createHousehelp(h.id, "Geeta");
    await createSettlement(h.id, a.id, addDays(TODAY, 10));
    const nearer = await createSettlement(h.id, b.id, addDays(TODAY, 3));

    const res = await ctx.request.get(`/api/households/${h.id}/today`).set("cookie", owner.cookie);
    expect(res.body.data.salary.upcoming).toMatchObject({ settlementId: nearer.id, househelpName: "Geeta" });
    expect(res.body.data.salary.hasAnySettlement).toBe(true);
  });

  it("salary reports hasAnySettlement true but upcoming null when everything is paid", async () => {
    const owner = await signupUser(ctx);
    const h = await createHousehold(ctx, owner.cookie);
    const help = await createHousehelp(h.id, "Sunita");
    await createSettlement(h.id, help.id, TODAY, { status: "PAID", amountPaidPaise: 1000000, paidAt: ctx.clock.now() });

    const res = await ctx.request.get(`/api/households/${h.id}/today`).set("cookie", owner.cookie);
    expect(res.body.data.salary).toEqual({ upcoming: null, hasAnySettlement: true });
  });

  it("never reflects another household's data", async () => {
    const ownerA = await signupUser(ctx);
    const hA = await createHousehold(ctx, ownerA.cookie, "Household A");
    const helpA = await createHousehelp(hA.id, "Sunita");
    await ctx.db.insert(attendanceRecords).values({ householdId: hA.id, househelpId: helpA.id, date: TODAY, status: "PRESENT" });

    const ownerB = await signupUser(ctx);
    const hB = await createHousehold(ctx, ownerB.cookie, "Household B");

    const res = await ctx.request.get(`/api/households/${hB.id}/today`).set("cookie", ownerB.cookie);
    expect(res.body.data.attendance).toEqual({ marked: 0, total: 0 });
  });

  it("404s for a non-member", async () => {
    const owner = await signupUser(ctx);
    const h = await createHousehold(ctx, owner.cookie);
    const stranger = await signupUser(ctx);
    const res = await ctx.request.get(`/api/households/${h.id}/today`).set("cookie", stranger.cookie);
    expect(res.status).toBe(404);
  });
});
