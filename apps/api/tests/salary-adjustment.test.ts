import { eq } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { attendanceRecords, attendanceSchedules, householdMembers, salaryAdjustments, salarySettlements } from "../src/db/schema.js";
import { createTestContext, csrf, signupUser, truncateAll, type TestContext } from "./helpers.js";

const ctx = createTestContext();
beforeEach(() => truncateAll(ctx.db));
afterAll(() => ctx.close());

// FakeClock defaults to 2026-09-29T04:30:00Z, so August 2026 has fully elapsed — same convention
// salary-settlement.test.ts relies on.
const AUGUST_DAYS = Array.from({ length: 31 }, (_, i) => `2026-08-${String(i + 1).padStart(2, "0")}`);

async function createHousehold(c: TestContext, cookie: string, name = "Shah Family") {
  const res = await c.request.post("/api/households").set(csrf).set("cookie", cookie).send({ name });
  expect(res.status).toBe(201);
  return res.body.data as { id: string };
}

async function addMember(householdId: string, userId: string, role: "OWNER" | "ADMIN" | "MEMBER" | "VIEWER") {
  await ctx.db.insert(householdMembers).values({ householdId, userId, role, status: "ACTIVE", joinedAt: ctx.clock.now() });
}

async function createHousehelp(c: TestContext, cookie: string, householdId: string, body: Record<string, unknown> = {}) {
  const res = await c.request.post(`/api/households/${householdId}/househelps`).set(csrf).set("cookie", cookie).send({ name: "Sunita", ...body });
  expect(res.status).toBe(201);
  return res.body.data as { id: string };
}

async function scheduleWholeWeek(c: TestContext, householdId: string, househelpId: string) {
  await c.db.insert(attendanceSchedules).values({ householdId, househelpId, weekdays: [1, 2, 3, 4, 5, 6, 7], effectiveFrom: "2026-01-01" });
}

async function markAugust(c: TestContext, householdId: string, househelpId: string) {
  await c.db.insert(attendanceRecords).values(
    AUGUST_DAYS.map((date) => ({ householdId, househelpId, date, status: "PRESENT" as const, markedAt: c.clock.now() })),
  );
}

async function generate(c: TestContext, cookie: string, householdId: string, househelpId: string, periodMonth = "2026-08-01") {
  const res = await c.request.post(`/api/households/${householdId}/househelps/${househelpId}/salary/settlements`).set(csrf).set("cookie", cookie).send({ periodMonth });
  expect(res.status).toBe(200);
  return res.body.data as { id: string; netPayablePaise: number; additionsPaise: number; deductionsPaise: number };
}

function createAdjustment(c: TestContext, cookie: string, householdId: string, househelpId: string, body: Record<string, unknown>) {
  return c.request.post(`/api/households/${householdId}/househelps/${househelpId}/salary/adjustments`).set(csrf).set("cookie", cookie).send(body);
}

function voidAdjustment(c: TestContext, cookie: string, householdId: string, adjustmentId: string) {
  return c.request.delete(`/api/households/${householdId}/salary/adjustments/${adjustmentId}`).set(csrf).set("cookie", cookie);
}

describe("salary adjustments", () => {
  it("creates an unattached adjustment when no settlement exists yet for the period", async () => {
    const owner = await signupUser(ctx);
    const h = await createHousehold(ctx, owner.cookie);
    const help = await createHousehelp(ctx, owner.cookie, h.id, { salaryMode: "FIXED_MONTHLY", monthlySalaryPaise: 1_000_000 });

    const res = await createAdjustment(ctx, owner.cookie, h.id, help.id, { periodMonth: "2026-08-15", type: "BONUS", amountPaise: 50_000 });
    expect(res.status).toBe(201);
    expect(res.body.data).toMatchObject({ settlementId: null, type: "BONUS", amountPaise: 50_000 });
  });

  it("attaches directly to an existing PENDING settlement and recomputes its totals", async () => {
    const owner = await signupUser(ctx);
    const h = await createHousehold(ctx, owner.cookie);
    const help = await createHousehelp(ctx, owner.cookie, h.id, { salaryMode: "FIXED_MONTHLY", monthlySalaryPaise: 1_000_000 });
    await scheduleWholeWeek(ctx, h.id, help.id);
    await markAugust(ctx, h.id, help.id);
    const settlement = await generate(ctx, owner.cookie, h.id, help.id);
    expect(settlement.netPayablePaise).toBe(1_000_000);

    const res = await createAdjustment(ctx, owner.cookie, h.id, help.id, { periodMonth: "2026-08-20", type: "BONUS", amountPaise: 75_000 });
    expect(res.status).toBe(201);
    expect(res.body.data.settlementId).toBe(settlement.id);

    const [updated] = await ctx.db.select().from(salarySettlements).where(eq(salarySettlements.id, settlement.id));
    expect(updated!.additionsPaise).toBe(75_000);
    expect(updated!.netPayablePaise).toBe(1_075_000);
  });

  it("leaves a new adjustment unattached when the target settlement is already locked (paid) — never silently touches locked totals", async () => {
    const owner = await signupUser(ctx);
    const h = await createHousehold(ctx, owner.cookie);
    const help = await createHousehelp(ctx, owner.cookie, h.id, { salaryMode: "FIXED_MONTHLY", monthlySalaryPaise: 1_000_000 });
    await scheduleWholeWeek(ctx, h.id, help.id);
    await markAugust(ctx, h.id, help.id);
    const settlement = await generate(ctx, owner.cookie, h.id, help.id);
    await ctx.db.update(salarySettlements).set({ status: "PAID", amountPaidPaise: settlement.netPayablePaise }).where(eq(salarySettlements.id, settlement.id));

    const res = await createAdjustment(ctx, owner.cookie, h.id, help.id, { periodMonth: "2026-08-20", type: "DEDUCTION", amountPaise: 10_000 });
    expect(res.status).toBe(201);
    expect(res.body.data.settlementId).toBeNull();

    const [unchanged] = await ctx.db.select().from(salarySettlements).where(eq(salarySettlements.id, settlement.id));
    expect(unchanged!.deductionsPaise).toBe(0);
    expect(unchanged!.netPayablePaise).toBe(settlement.netPayablePaise);
  });

  it("voiding an unattached adjustment just marks it voided", async () => {
    const owner = await signupUser(ctx);
    const h = await createHousehold(ctx, owner.cookie);
    const help = await createHousehelp(ctx, owner.cookie, h.id, { salaryMode: "FIXED_MONTHLY", monthlySalaryPaise: 1_000_000 });
    const created = await createAdjustment(ctx, owner.cookie, h.id, help.id, { periodMonth: "2026-08-15", type: "BONUS", amountPaise: 50_000 });
    const id = created.body.data.id as string;

    const res = await voidAdjustment(ctx, owner.cookie, h.id, id);
    expect(res.status).toBe(200);
    const [row] = await ctx.db.select().from(salaryAdjustments).where(eq(salaryAdjustments.id, id));
    expect(row!.voidedAt).not.toBeNull();
  });

  it("voiding an adjustment attached to a PENDING settlement recomputes its totals", async () => {
    const owner = await signupUser(ctx);
    const h = await createHousehold(ctx, owner.cookie);
    const help = await createHousehelp(ctx, owner.cookie, h.id, { salaryMode: "FIXED_MONTHLY", monthlySalaryPaise: 1_000_000 });
    await scheduleWholeWeek(ctx, h.id, help.id);
    await markAugust(ctx, h.id, help.id);
    const settlement = await generate(ctx, owner.cookie, h.id, help.id);
    const created = await createAdjustment(ctx, owner.cookie, h.id, help.id, { periodMonth: "2026-08-20", type: "BONUS", amountPaise: 75_000 });
    expect(created.body.data.settlementId).toBe(settlement.id);

    const res = await voidAdjustment(ctx, owner.cookie, h.id, created.body.data.id);
    expect(res.status).toBe(200);

    const [updated] = await ctx.db.select().from(salarySettlements).where(eq(salarySettlements.id, settlement.id));
    expect(updated!.additionsPaise).toBe(0);
    expect(updated!.netPayablePaise).toBe(1_000_000);
  });

  it("voiding an adjustment attached to a locked (paid) settlement is allowed but does not retroactively change its locked totals", async () => {
    const owner = await signupUser(ctx);
    const h = await createHousehold(ctx, owner.cookie);
    const help = await createHousehelp(ctx, owner.cookie, h.id, { salaryMode: "FIXED_MONTHLY", monthlySalaryPaise: 1_000_000 });
    await scheduleWholeWeek(ctx, h.id, help.id);
    await markAugust(ctx, h.id, help.id);
    const settlement = await generate(ctx, owner.cookie, h.id, help.id);
    const created = await createAdjustment(ctx, owner.cookie, h.id, help.id, { periodMonth: "2026-08-20", type: "BONUS", amountPaise: 75_000 });
    expect(created.body.data.settlementId).toBe(settlement.id);

    // Simulate the settlement having since been paid (locking in the 75,000 addition).
    await ctx.db.update(salarySettlements)
      .set({ status: "PAID", amountPaidPaise: 1_075_000, netPayablePaise: 1_075_000, additionsPaise: 75_000 })
      .where(eq(salarySettlements.id, settlement.id));

    const res = await voidAdjustment(ctx, owner.cookie, h.id, created.body.data.id);
    expect(res.status).toBe(200);

    const [row] = await ctx.db.select().from(salarySettlements).where(eq(salarySettlements.id, settlement.id));
    expect(row!.additionsPaise).toBe(75_000); // unchanged — locked totals are never retroactively edited
    expect(row!.netPayablePaise).toBe(1_075_000);
    expect(row!.status).toBe("PAID");
  });

  it("rejects voiding an already-voided adjustment", async () => {
    const owner = await signupUser(ctx);
    const h = await createHousehold(ctx, owner.cookie);
    const help = await createHousehelp(ctx, owner.cookie, h.id, { salaryMode: "FIXED_MONTHLY", monthlySalaryPaise: 1_000_000 });
    const created = await createAdjustment(ctx, owner.cookie, h.id, help.id, { periodMonth: "2026-08-15", type: "BONUS", amountPaise: 50_000 });
    const id = created.body.data.id as string;
    await voidAdjustment(ctx, owner.cookie, h.id, id);

    const res = await voidAdjustment(ctx, owner.cookie, h.id, id);
    expect(res.status).toBe(400);
  });

  it("a member of household A cannot create or void household B's adjustments", async () => {
    const alice = await signupUser(ctx);
    const bob = await signupUser(ctx);
    const a = await createHousehold(ctx, alice.cookie, "A");
    const b = await createHousehold(ctx, bob.cookie, "B");
    const bobsHelp = await createHousehelp(ctx, bob.cookie, b.id, { salaryMode: "FIXED_MONTHLY", monthlySalaryPaise: 1_000_000 });

    const createAttempt = await createAdjustment(ctx, alice.cookie, a.id, bobsHelp.id, { periodMonth: "2026-08-15", type: "BONUS", amountPaise: 50_000 });
    expect(createAttempt.status).toBe(404);

    const bobsAdj = await createAdjustment(ctx, bob.cookie, b.id, bobsHelp.id, { periodMonth: "2026-08-15", type: "BONUS", amountPaise: 50_000 });
    expect(bobsAdj.status).toBe(201);

    const voidAttempt = await voidAdjustment(ctx, alice.cookie, a.id, bobsAdj.body.data.id);
    expect(voidAttempt.status).toBe(404);
  });

  it("MEMBER cannot create or void adjustments (lacks salaries.manage)", async () => {
    const owner = await signupUser(ctx);
    const member = await signupUser(ctx);
    const h = await createHousehold(ctx, owner.cookie);
    await addMember(h.id, member.id, "MEMBER");
    const help = await createHousehelp(ctx, owner.cookie, h.id, { salaryMode: "FIXED_MONTHLY", monthlySalaryPaise: 1_000_000 });

    const denied = await createAdjustment(ctx, member.cookie, h.id, help.id, { periodMonth: "2026-08-15", type: "BONUS", amountPaise: 50_000 });
    expect(denied.status).toBe(403);

    const created = await createAdjustment(ctx, owner.cookie, h.id, help.id, { periodMonth: "2026-08-15", type: "BONUS", amountPaise: 50_000 });
    expect(created.status).toBe(201);
    const voidDenied = await voidAdjustment(ctx, member.cookie, h.id, created.body.data.id);
    expect(voidDenied.status).toBe(403);
  });

  it("ADJUSTMENT type is a straight addition (not net-signed), and a negative amountPaise is rejected", async () => {
    const owner = await signupUser(ctx);
    const h = await createHousehold(ctx, owner.cookie);
    const help = await createHousehelp(ctx, owner.cookie, h.id, { salaryMode: "FIXED_MONTHLY", monthlySalaryPaise: 1_000_000 });
    await scheduleWholeWeek(ctx, h.id, help.id);
    await markAugust(ctx, h.id, help.id);
    const settlement = await generate(ctx, owner.cookie, h.id, help.id);

    const negative = await createAdjustment(ctx, owner.cookie, h.id, help.id, { periodMonth: "2026-08-10", type: "ADJUSTMENT", amountPaise: -1000 });
    expect(negative.status).toBe(400);

    const res = await createAdjustment(ctx, owner.cookie, h.id, help.id, { periodMonth: "2026-08-10", type: "ADJUSTMENT", amountPaise: 15_000 });
    expect(res.status).toBe(201);

    const [row] = await ctx.db.select().from(salarySettlements).where(eq(salarySettlements.id, settlement.id));
    expect(row!.additionsPaise).toBe(15_000); // addition, like BONUS/OVERTIME — never net-signed
    expect(row!.netPayablePaise).toBe(1_015_000);
  });

  it("regression: an adjustment swept (but left unattached) by one recompute gets ATTACHED by it, so a later void correctly recomputes totals", async () => {
    const owner = await signupUser(ctx);
    const h = await createHousehold(ctx, owner.cookie);
    const help = await createHousehelp(ctx, owner.cookie, h.id, { salaryMode: "FIXED_MONTHLY", monthlySalaryPaise: 1_000_000 });
    await scheduleWholeWeek(ctx, h.id, help.id);
    await markAugust(ctx, h.id, help.id);
    const settlement = await generate(ctx, owner.cookie, h.id, help.id);

    // Pay in full -> PAID, locked.
    const payRes = await ctx.request.post(`/api/households/${h.id}/salary/settlements/${settlement.id}/payments`)
      .set(csrf).set("cookie", owner.cookie).send({ amountPaise: 1_000_000, paidOn: "2026-09-02", method: "CASH" });
    expect(payRes.status).toBe(201);
    const paymentId = payRes.body.data.id as string;
    const [paid] = await ctx.db.select().from(salarySettlements).where(eq(salarySettlements.id, settlement.id));
    expect(paid!.status).toBe("PAID");

    // Adjustment A: created while locked -> correctly stays unattached.
    const adjA = await createAdjustment(ctx, owner.cookie, h.id, help.id, { periodMonth: "2026-08-10", type: "BONUS", amountPaise: 200_000 });
    expect(adjA.status).toBe(201);
    expect(adjA.body.data.settlementId).toBeNull();

    // Void the payment -> settlement drops back to PENDING, unlocking it.
    const voidPayRes = await ctx.request.delete(`/api/households/${h.id}/salary/payments/${paymentId}`).set(csrf).set("cookie", owner.cookie);
    expect(voidPayRes.status).toBe(200);
    const [unlocked] = await ctx.db.select().from(salarySettlements).where(eq(salarySettlements.id, settlement.id));
    expect(unlocked!.status).toBe("PENDING");

    // Adjustment B: created now that it's PENDING again -> attaches, and the sweep also counts A
    // (still unattached) into the recomputed totals. The fix must ALSO attach A at this point,
    // not merely count it — otherwise a later void of A would silently skip recomputing.
    const adjB = await createAdjustment(ctx, owner.cookie, h.id, help.id, { periodMonth: "2026-08-11", type: "BONUS", amountPaise: 50_000 });
    expect(adjB.status).toBe(201);
    expect(adjB.body.data.settlementId).toBe(settlement.id);

    const [afterB] = await ctx.db.select().from(salarySettlements).where(eq(salarySettlements.id, settlement.id));
    expect(afterB!.additionsPaise).toBe(250_000); // A (200,000) + B (50,000)
    expect(afterB!.netPayablePaise).toBe(1_250_000);

    const [adjARow] = await ctx.db.select().from(salaryAdjustments).where(eq(salaryAdjustments.id, adjA.body.data.id));
    expect(adjARow!.settlementId).toBe(settlement.id); // A must now be attached, not left dangling null

    // Void A -> because A is now correctly attached, this MUST recompute totals down to just B.
    const voidARes = await voidAdjustment(ctx, owner.cookie, h.id, adjA.body.data.id);
    expect(voidARes.status).toBe(200);

    const [afterVoidA] = await ctx.db.select().from(salarySettlements).where(eq(salarySettlements.id, settlement.id));
    expect(afterVoidA!.additionsPaise).toBe(50_000); // only B remains
    expect(afterVoidA!.netPayablePaise).toBe(1_050_000);

    // getSettlement's adjustment list must agree with the totals: only B is still unvoided.
    const detail = await ctx.request.get(`/api/households/${h.id}/salary/settlements/${settlement.id}`).set("cookie", owner.cookie);
    const unvoided = (detail.body.data.adjustments as { voidedAt: string | null }[]).filter((a) => !a.voidedAt);
    expect(unvoided).toHaveLength(1);
  });
});
