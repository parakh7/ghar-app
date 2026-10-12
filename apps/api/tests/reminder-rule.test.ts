import { and, eq } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { attendanceRecords, attendanceSchedules, auditLogs, householdMembers, reminderRules } from "../src/db/schema.js";
import { createTestContext, csrf, signupUser, truncateAll, type TestContext } from "./helpers.js";

const ctx = createTestContext();
beforeEach(() => truncateAll(ctx.db));
afterAll(() => ctx.close());

async function createHousehold(c: TestContext, cookie: string, name = "Shah Family") {
  const res = await c.request.post("/api/households").set(csrf).set("cookie", cookie).send({ name });
  expect(res.status).toBe(201);
  return res.body.data as { id: string };
}

async function addMember(householdId: string, userId: string, role: "OWNER" | "ADMIN" | "MEMBER" | "VIEWER") {
  await ctx.db.insert(householdMembers).values({ householdId, userId, role, status: "ACTIVE", joinedAt: ctx.clock.now() });
}

async function createBill(c: TestContext, cookie: string, householdId: string, name = "Electricity bill") {
  const res = await c.request.post(`/api/households/${householdId}/bills`).set(csrf).set("cookie", cookie)
    .send({ name, frequency: "MONTHLY", firstDueDate: "2026-11-05" });
  expect(res.status).toBe(201);
  return res.body.data as { id: string };
}

async function createHousehelp(c: TestContext, cookie: string, householdId: string, name = "Sunita") {
  const res = await c.request.post(`/api/households/${householdId}/househelps`).set(csrf).set("cookie", cookie).send({ name });
  expect(res.status).toBe(201);
  return res.body.data as { id: string };
}

describe("reminder rules", () => {
  it("lists the two seeded household-default rules (BILL and SALARY) on a new household", async () => {
    const owner = await signupUser(ctx);
    const h = await createHousehold(ctx, owner.cookie);
    const res = await ctx.request.get(`/api/households/${h.id}/reminder-rules`).set("cookie", owner.cookie);
    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(2);
    const byType = Object.fromEntries(res.body.data.map((r: { targetType: string }) => [r.targetType, r]));
    expect(byType.BILL).toMatchObject({ targetId: null, offsetsDays: [7, 3, 1, 0], overdueDaily: true, sendHour: 9, isActive: true });
    expect(byType.SALARY).toMatchObject({ targetId: null, offsetsDays: [3, 0], overdueDaily: true, sendHour: 9, isActive: true });
  });

  it("creates a BILL-targetType override for a specific bill", async () => {
    const owner = await signupUser(ctx);
    const h = await createHousehold(ctx, owner.cookie);
    const bill = await createBill(ctx, owner.cookie, h.id);
    const res = await ctx.request.post(`/api/households/${h.id}/reminder-rules`).set(csrf).set("cookie", owner.cookie)
      .send({ targetType: "BILL", targetId: bill.id, offsetsDays: [5, 1], overdueDaily: false, sendHour: 10 });
    expect(res.status).toBe(201);
    expect(res.body.data).toMatchObject({ targetType: "BILL", targetId: bill.id, offsetsDays: [5, 1], overdueDaily: false, sendHour: 10, isActive: true });
    const [log] = await ctx.db.select().from(auditLogs).where(and(eq(auditLogs.householdId, h.id), eq(auditLogs.action, "reminder_rule.created")));
    expect(log).toBeDefined();
  });

  it("creates a SALARY override for a specific househelp", async () => {
    const owner = await signupUser(ctx);
    const h = await createHousehold(ctx, owner.cookie);
    const help = await createHousehelp(ctx, owner.cookie, h.id);
    const res = await ctx.request.post(`/api/households/${h.id}/reminder-rules`).set(csrf).set("cookie", owner.cookie)
      .send({ targetType: "SALARY", targetId: help.id, offsetsDays: [2], sendHour: 8 });
    expect(res.status).toBe(201);
    expect(res.body.data).toMatchObject({ targetType: "SALARY", targetId: help.id, offsetsDays: [2], sendHour: 8 });
  });

  it("rejects a SALARY targetId that is a salary_settlements.id rather than a househelps.id", async () => {
    const owner = await signupUser(ctx);
    const h = await createHousehold(ctx, owner.cookie);
    const helpRes = await ctx.request.post(`/api/households/${h.id}/househelps`).set(csrf).set("cookie", owner.cookie)
      .send({ name: "Sunita", salaryMode: "FIXED_MONTHLY", monthlySalaryPaise: 2_000_000 });
    expect(helpRes.status).toBe(201);
    const help = helpRes.body.data as { id: string };
    await ctx.db.insert(attendanceSchedules).values({ householdId: h.id, househelpId: help.id, weekdays: [1, 2, 3, 4, 5, 6, 7], effectiveFrom: "2026-01-01" });
    const augustDays = Array.from({ length: 31 }, (_, i) => `2026-08-${String(i + 1).padStart(2, "0")}`);
    await ctx.db.insert(attendanceRecords).values(augustDays.map((date) => ({ householdId: h.id, househelpId: help.id, date, status: "PRESENT" as const, markedAt: ctx.clock.now() })));
    const settlementRes = await ctx.request.post(`/api/households/${h.id}/househelps/${help.id}/salary/settlements`)
      .set(csrf).set("cookie", owner.cookie).send({ periodMonth: "2026-08-01" });
    expect(settlementRes.status).toBe(200);
    const settlementId = settlementRes.body.data.id as string;
    expect(settlementId).not.toBe(help.id); // sanity: genuinely a different id, not coincidentally equal

    const res = await ctx.request.post(`/api/households/${h.id}/reminder-rules`).set(csrf).set("cookie", owner.cookie)
      .send({ targetType: "SALARY", targetId: settlementId, offsetsDays: [1] });
    expect(res.status).toBe(400);

    // And the househelp's own id — the correct target — must still validate fine.
    const ok = await ctx.request.post(`/api/households/${h.id}/reminder-rules`).set(csrf).set("cookie", owner.cookie)
      .send({ targetType: "SALARY", targetId: help.id, offsetsDays: [1] });
    expect(ok.status).toBe(201);
  });

  it("an archived/departed househelp's id still validates successfully for a SALARY override", async () => {
    const owner = await signupUser(ctx);
    const h = await createHousehold(ctx, owner.cookie);
    const help = await createHousehelp(ctx, owner.cookie, h.id);
    const archiveRes = await ctx.request.post(`/api/households/${h.id}/househelps/${help.id}/archive`).set(csrf).set("cookie", owner.cookie);
    expect(archiveRes.status).toBe(200);
    const res = await ctx.request.post(`/api/households/${h.id}/reminder-rules`).set(csrf).set("cookie", owner.cookie)
      .send({ targetType: "SALARY", targetId: help.id, offsetsDays: [1] });
    expect(res.status).toBe(201);
  });

  it("rejects a BILL targetId that doesn't exist in the household", async () => {
    const owner = await signupUser(ctx);
    const h = await createHousehold(ctx, owner.cookie);
    const res = await ctx.request.post(`/api/households/${h.id}/reminder-rules`).set(csrf).set("cookie", owner.cookie)
      .send({ targetType: "BILL", targetId: "00000000-0000-0000-0000-000000000001", offsetsDays: [1] });
    expect(res.status).toBe(400);
  });

  it("rejects a SALARY targetId that doesn't exist in the household", async () => {
    const owner = await signupUser(ctx);
    const h = await createHousehold(ctx, owner.cookie);
    const res = await ctx.request.post(`/api/households/${h.id}/reminder-rules`).set(csrf).set("cookie", owner.cookie)
      .send({ targetType: "SALARY", targetId: "00000000-0000-0000-0000-000000000001", offsetsDays: [1] });
    expect(res.status).toBe(400);
  });

  it("rejects a bill belonging to another household as a BILL targetId", async () => {
    const owner = await signupUser(ctx);
    const h = await createHousehold(ctx, owner.cookie, "A");
    const other = await createHousehold(ctx, owner.cookie, "B");
    const bill = await createBill(ctx, owner.cookie, other.id);
    const res = await ctx.request.post(`/api/households/${h.id}/reminder-rules`).set(csrf).set("cookie", owner.cookie)
      .send({ targetType: "BILL", targetId: bill.id, offsetsDays: [1] });
    expect(res.status).toBe(400);
  });

  it("rejects a duplicate rule for the same targetType + targetId (uniqueness conflict)", async () => {
    const owner = await signupUser(ctx);
    const h = await createHousehold(ctx, owner.cookie);
    const bill = await createBill(ctx, owner.cookie, h.id);
    const first = await ctx.request.post(`/api/households/${h.id}/reminder-rules`).set(csrf).set("cookie", owner.cookie)
      .send({ targetType: "BILL", targetId: bill.id, offsetsDays: [1] });
    expect(first.status).toBe(201);
    const second = await ctx.request.post(`/api/households/${h.id}/reminder-rules`).set(csrf).set("cookie", owner.cookie)
      .send({ targetType: "BILL", targetId: bill.id, offsetsDays: [2] });
    expect(second.status).toBe(409);
  });

  it("rejects a second household-default rule for a targetType that already has one", async () => {
    const owner = await signupUser(ctx);
    const h = await createHousehold(ctx, owner.cookie);
    const res = await ctx.request.post(`/api/households/${h.id}/reminder-rules`).set(csrf).set("cookie", owner.cookie)
      .send({ targetType: "BILL", offsetsDays: [1] });
    expect(res.status).toBe(409);
  });

  it("rejects an empty offsetsDays array", async () => {
    const owner = await signupUser(ctx);
    const h = await createHousehold(ctx, owner.cookie);
    const bill = await createBill(ctx, owner.cookie, h.id);
    const res = await ctx.request.post(`/api/households/${h.id}/reminder-rules`).set(csrf).set("cookie", owner.cookie)
      .send({ targetType: "BILL", targetId: bill.id, offsetsDays: [] });
    expect(res.status).toBe(400);
  });

  it("rejects duplicate values within offsetsDays", async () => {
    const owner = await signupUser(ctx);
    const h = await createHousehold(ctx, owner.cookie);
    const bill = await createBill(ctx, owner.cookie, h.id);
    const res = await ctx.request.post(`/api/households/${h.id}/reminder-rules`).set(csrf).set("cookie", owner.cookie)
      .send({ targetType: "BILL", targetId: bill.id, offsetsDays: [3, 3, 1] });
    expect(res.status).toBe(400);
  });

  it("rejects negative values within offsetsDays", async () => {
    const owner = await signupUser(ctx);
    const h = await createHousehold(ctx, owner.cookie);
    const bill = await createBill(ctx, owner.cookie, h.id);
    const res = await ctx.request.post(`/api/households/${h.id}/reminder-rules`).set(csrf).set("cookie", owner.cookie)
      .send({ targetType: "BILL", targetId: bill.id, offsetsDays: [-1, 3] });
    expect(res.status).toBe(400);
  });

  it("rejects a sendHour outside 0-23", async () => {
    const owner = await signupUser(ctx);
    const h = await createHousehold(ctx, owner.cookie);
    const bill = await createBill(ctx, owner.cookie, h.id);
    const res = await ctx.request.post(`/api/households/${h.id}/reminder-rules`).set(csrf).set("cookie", owner.cookie)
      .send({ targetType: "BILL", targetId: bill.id, offsetsDays: [1], sendHour: 24 });
    expect(res.status).toBe(400);
  });

  it("toggles isActive via PATCH", async () => {
    const owner = await signupUser(ctx);
    const h = await createHousehold(ctx, owner.cookie);
    const bill = await createBill(ctx, owner.cookie, h.id);
    const create = await ctx.request.post(`/api/households/${h.id}/reminder-rules`).set(csrf).set("cookie", owner.cookie)
      .send({ targetType: "BILL", targetId: bill.id, offsetsDays: [1] });
    const ruleId = create.body.data.id as string;
    const res = await ctx.request.patch(`/api/households/${h.id}/reminder-rules/${ruleId}`).set(csrf).set("cookie", owner.cookie)
      .send({ isActive: false });
    expect(res.status).toBe(200);
    expect(res.body.data.isActive).toBe(false);
  });

  it("rejects a PATCH with no fields", async () => {
    const owner = await signupUser(ctx);
    const h = await createHousehold(ctx, owner.cookie);
    const bill = await createBill(ctx, owner.cookie, h.id);
    const create = await ctx.request.post(`/api/households/${h.id}/reminder-rules`).set(csrf).set("cookie", owner.cookie)
      .send({ targetType: "BILL", targetId: bill.id, offsetsDays: [1] });
    const res = await ctx.request.patch(`/api/households/${h.id}/reminder-rules/${create.body.data.id}`).set(csrf).set("cookie", owner.cookie).send({});
    expect(res.status).toBe(400);
  });

  it("rejects deleting a household-default rule (targetId IS NULL)", async () => {
    const owner = await signupUser(ctx);
    const h = await createHousehold(ctx, owner.cookie);
    const [defaultBillRule] = await ctx.db.select().from(reminderRules)
      .where(and(eq(reminderRules.householdId, h.id), eq(reminderRules.targetType, "BILL")));
    const res = await ctx.request.delete(`/api/households/${h.id}/reminder-rules/${defaultBillRule!.id}`).set(csrf).set("cookie", owner.cookie);
    expect(res.status).toBe(409);
    const [stillThere] = await ctx.db.select().from(reminderRules).where(eq(reminderRules.id, defaultBillRule!.id));
    expect(stillThere).toBeDefined();
  });

  it("deletes an override row successfully", async () => {
    const owner = await signupUser(ctx);
    const h = await createHousehold(ctx, owner.cookie);
    const bill = await createBill(ctx, owner.cookie, h.id);
    const create = await ctx.request.post(`/api/households/${h.id}/reminder-rules`).set(csrf).set("cookie", owner.cookie)
      .send({ targetType: "BILL", targetId: bill.id, offsetsDays: [1] });
    const ruleId = create.body.data.id as string;
    const res = await ctx.request.delete(`/api/households/${h.id}/reminder-rules/${ruleId}`).set(csrf).set("cookie", owner.cookie);
    expect(res.status).toBe(200);
    const [row] = await ctx.db.select().from(reminderRules).where(eq(reminderRules.id, ruleId));
    expect(row).toBeUndefined();
  });

  it("a member of household A cannot see or manage household B's reminder rules", async () => {
    const alice = await signupUser(ctx);
    const bob = await signupUser(ctx);
    await createHousehold(ctx, alice.cookie, "A");
    const b = await createHousehold(ctx, bob.cookie, "B");
    const listRes = await ctx.request.get(`/api/households/${b.id}/reminder-rules`).set("cookie", alice.cookie);
    expect(listRes.status).toBe(404);
    const createRes = await ctx.request.post(`/api/households/${b.id}/reminder-rules`).set(csrf).set("cookie", alice.cookie)
      .send({ targetType: "BILL", offsetsDays: [1] });
    expect(createRes.status).toBe(404);
  });

  it("VIEWER can list reminder rules but not create/update/delete them", async () => {
    const owner = await signupUser(ctx);
    const viewer = await signupUser(ctx);
    const h = await createHousehold(ctx, owner.cookie);
    await addMember(h.id, viewer.id, "VIEWER");
    const bill = await createBill(ctx, owner.cookie, h.id);
    expect((await ctx.request.get(`/api/households/${h.id}/reminder-rules`).set("cookie", viewer.cookie)).status).toBe(200);
    const createRes = await ctx.request.post(`/api/households/${h.id}/reminder-rules`).set(csrf).set("cookie", viewer.cookie)
      .send({ targetType: "BILL", targetId: bill.id, offsetsDays: [1] });
    expect(createRes.status).toBe(403);
  });

  it("MEMBER can list reminder rules but not manage them (reminders.manage is OWNER/ADMIN only by default)", async () => {
    const owner = await signupUser(ctx);
    const member = await signupUser(ctx);
    const h = await createHousehold(ctx, owner.cookie);
    await addMember(h.id, member.id, "MEMBER");
    expect((await ctx.request.get(`/api/households/${h.id}/reminder-rules`).set("cookie", member.cookie)).status).toBe(200);
    const createRes = await ctx.request.post(`/api/households/${h.id}/reminder-rules`).set(csrf).set("cookie", member.cookie)
      .send({ targetType: "BILL", offsetsDays: [1] });
    expect(createRes.status).toBe(403);
  });

  it("ADMIN can manage reminder rules", async () => {
    const owner = await signupUser(ctx);
    const admin = await signupUser(ctx);
    const h = await createHousehold(ctx, owner.cookie);
    await addMember(h.id, admin.id, "ADMIN");
    const bill = await createBill(ctx, owner.cookie, h.id);
    const res = await ctx.request.post(`/api/households/${h.id}/reminder-rules`).set(csrf).set("cookie", admin.cookie)
      .send({ targetType: "BILL", targetId: bill.id, offsetsDays: [1] });
    expect(res.status).toBe(201);
  });
});
