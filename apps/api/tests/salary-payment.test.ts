import { eq } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { attendanceRecords, attendanceSchedules, householdMembers, salaryPayments, salarySettlements } from "../src/db/schema.js";
import { DAY, createTestContext, csrf, signupUser, truncateAll, type TestContext } from "./helpers.js";

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
  return res.body.data as { id: string; netPayablePaise: number };
}

function recordPayment(c: TestContext, cookie: string, householdId: string, settlementId: string, body: Record<string, unknown>) {
  return c.request.post(`/api/households/${householdId}/salary/settlements/${settlementId}/payments`).set(csrf).set("cookie", cookie).send(body);
}

function voidPayment(c: TestContext, cookie: string, householdId: string, paymentId: string, reason?: string) {
  const url = `/api/households/${householdId}/salary/payments/${paymentId}${reason ? `?reason=${encodeURIComponent(reason)}` : ""}`;
  return c.request.delete(url).set(csrf).set("cookie", cookie);
}

describe("salary payments", () => {
  it("a partial payment moves the settlement to PARTIALLY_PAID", async () => {
    const owner = await signupUser(ctx);
    const h = await createHousehold(ctx, owner.cookie);
    const help = await createHousehelp(ctx, owner.cookie, h.id, { salaryMode: "FIXED_MONTHLY", monthlySalaryPaise: 1_000_000 });
    await scheduleWholeWeek(ctx, h.id, help.id);
    await markAugust(ctx, h.id, help.id);
    const settlement = await generate(ctx, owner.cookie, h.id, help.id);

    const res = await recordPayment(ctx, owner.cookie, h.id, settlement.id, { amountPaise: 400_000, paidOn: "2026-09-02", method: "CASH" });
    expect(res.status).toBe(201);

    const [row] = await ctx.db.select().from(salarySettlements).where(eq(salarySettlements.id, settlement.id));
    expect(row!.status).toBe("PARTIALLY_PAID");
    expect(row!.amountPaidPaise).toBe(400_000);
    expect(row!.paidAt).toBeNull();
  });

  it("a full payment moves the settlement to PAID and sets paidAt", async () => {
    const owner = await signupUser(ctx);
    const h = await createHousehold(ctx, owner.cookie);
    const help = await createHousehelp(ctx, owner.cookie, h.id, { salaryMode: "FIXED_MONTHLY", monthlySalaryPaise: 1_000_000 });
    await scheduleWholeWeek(ctx, h.id, help.id);
    await markAugust(ctx, h.id, help.id);
    const settlement = await generate(ctx, owner.cookie, h.id, help.id);

    const res = await recordPayment(ctx, owner.cookie, h.id, settlement.id, { amountPaise: 1_000_000, paidOn: "2026-09-02", method: "CASH" });
    expect(res.status).toBe(201);

    const [row] = await ctx.db.select().from(salarySettlements).where(eq(salarySettlements.id, settlement.id));
    expect(row!.status).toBe("PAID");
    expect(row!.amountPaidPaise).toBe(1_000_000);
    expect(row!.paidAt).not.toBeNull();
  });

  it("accumulates multiple partial payments that together reach PAID", async () => {
    const owner = await signupUser(ctx);
    const h = await createHousehold(ctx, owner.cookie);
    const help = await createHousehelp(ctx, owner.cookie, h.id, { salaryMode: "FIXED_MONTHLY", monthlySalaryPaise: 1_000_000 });
    await scheduleWholeWeek(ctx, h.id, help.id);
    await markAugust(ctx, h.id, help.id);
    const settlement = await generate(ctx, owner.cookie, h.id, help.id);

    const first = await recordPayment(ctx, owner.cookie, h.id, settlement.id, { amountPaise: 600_000, paidOn: "2026-09-02", method: "CASH" });
    expect(first.status).toBe(201);
    const second = await recordPayment(ctx, owner.cookie, h.id, settlement.id, { amountPaise: 400_000, paidOn: "2026-09-03", method: "UPI" });
    expect(second.status).toBe(201);

    const [row] = await ctx.db.select().from(salarySettlements).where(eq(salarySettlements.id, settlement.id));
    expect(row!.status).toBe("PAID");
    expect(row!.amountPaidPaise).toBe(1_000_000);
  });

  it("rejects a payment that would exceed netPayablePaise, and doesn't touch the settlement", async () => {
    const owner = await signupUser(ctx);
    const h = await createHousehold(ctx, owner.cookie);
    const help = await createHousehelp(ctx, owner.cookie, h.id, { salaryMode: "FIXED_MONTHLY", monthlySalaryPaise: 1_000_000 });
    await scheduleWholeWeek(ctx, h.id, help.id);
    await markAugust(ctx, h.id, help.id);
    const settlement = await generate(ctx, owner.cookie, h.id, help.id);

    const res = await recordPayment(ctx, owner.cookie, h.id, settlement.id, { amountPaise: 1_000_001, paidOn: "2026-09-02", method: "CASH" });
    expect(res.status).toBe(400);
    expect(res.body.error.fields).toHaveProperty("amountPaise");

    const [row] = await ctx.db.select().from(salarySettlements).where(eq(salarySettlements.id, settlement.id));
    expect(row!.status).toBe("PENDING");
    expect(row!.amountPaidPaise).toBe(0);
  });

  it("rejects recording a payment against a CANCELLED settlement", async () => {
    const owner = await signupUser(ctx);
    const h = await createHousehold(ctx, owner.cookie);
    const help = await createHousehelp(ctx, owner.cookie, h.id, { salaryMode: "FIXED_MONTHLY", monthlySalaryPaise: 1_000_000 });
    await scheduleWholeWeek(ctx, h.id, help.id);
    await markAugust(ctx, h.id, help.id);
    const settlement = await generate(ctx, owner.cookie, h.id, help.id);
    await ctx.db.update(salarySettlements).set({ status: "CANCELLED" }).where(eq(salarySettlements.id, settlement.id));

    const res = await recordPayment(ctx, owner.cookie, h.id, settlement.id, { amountPaise: 100_000, paidOn: "2026-09-02", method: "CASH" });
    expect(res.status).toBe(400);
  });

  it("voiding a payment reverses the settlement's status back down (PAID -> PARTIALLY_PAID), clearing paidAt", async () => {
    const owner = await signupUser(ctx);
    const h = await createHousehold(ctx, owner.cookie);
    const help = await createHousehelp(ctx, owner.cookie, h.id, { salaryMode: "FIXED_MONTHLY", monthlySalaryPaise: 1_000_000 });
    await scheduleWholeWeek(ctx, h.id, help.id);
    await markAugust(ctx, h.id, help.id);
    const settlement = await generate(ctx, owner.cookie, h.id, help.id);

    await recordPayment(ctx, owner.cookie, h.id, settlement.id, { amountPaise: 600_000, paidOn: "2026-09-02", method: "CASH" });
    const second = await recordPayment(ctx, owner.cookie, h.id, settlement.id, { amountPaise: 400_000, paidOn: "2026-09-03", method: "UPI" });
    expect(second.status).toBe(201);

    let [row] = await ctx.db.select().from(salarySettlements).where(eq(salarySettlements.id, settlement.id));
    expect(row!.status).toBe("PAID");
    expect(row!.paidAt).not.toBeNull();

    const voidRes = await voidPayment(ctx, owner.cookie, h.id, second.body.data.id, "entered in error");
    expect(voidRes.status).toBe(200);

    [row] = await ctx.db.select().from(salarySettlements).where(eq(salarySettlements.id, settlement.id));
    expect(row!.status).toBe("PARTIALLY_PAID");
    expect(row!.amountPaidPaise).toBe(600_000);
    expect(row!.paidAt).toBeNull();

    const [paymentRow] = await ctx.db.select().from(salaryPayments).where(eq(salaryPayments.id, second.body.data.id));
    expect(paymentRow!.voidedAt).not.toBeNull();
    expect(paymentRow!.voidReason).toBe("entered in error");
  });

  it("voiding a payment reverses the settlement's status all the way back to PENDING, unsticking regeneration", async () => {
    const owner = await signupUser(ctx);
    const h = await createHousehold(ctx, owner.cookie);
    const help = await createHousehelp(ctx, owner.cookie, h.id, { salaryMode: "FIXED_MONTHLY", monthlySalaryPaise: 1_000_000 });
    await scheduleWholeWeek(ctx, h.id, help.id);
    await markAugust(ctx, h.id, help.id);
    const settlement = await generate(ctx, owner.cookie, h.id, help.id);

    const only = await recordPayment(ctx, owner.cookie, h.id, settlement.id, { amountPaise: 300_000, paidOn: "2026-09-02", method: "CASH" });
    expect(only.status).toBe(201);
    let [row] = await ctx.db.select().from(salarySettlements).where(eq(salarySettlements.id, settlement.id));
    expect(row!.status).toBe("PARTIALLY_PAID");

    const voidRes = await voidPayment(ctx, owner.cookie, h.id, only.body.data.id);
    expect(voidRes.status).toBe(200);

    [row] = await ctx.db.select().from(salarySettlements).where(eq(salarySettlements.id, settlement.id));
    expect(row!.status).toBe("PENDING");
    expect(row!.amountPaidPaise).toBe(0);

    // The single most important correctness property: voiding the last payment must unstick the
    // regeneration lock (generateSettlement reads `status` directly, not a live payments re-query).
    const regen = await ctx.request.post(`/api/households/${h.id}/househelps/${help.id}/salary/settlements`)
      .set(csrf).set("cookie", owner.cookie).send({ periodMonth: "2026-08-01" });
    expect(regen.status).toBe(200);
  });

  it("rejects voiding an already-voided payment", async () => {
    const owner = await signupUser(ctx);
    const h = await createHousehold(ctx, owner.cookie);
    const help = await createHousehelp(ctx, owner.cookie, h.id, { salaryMode: "FIXED_MONTHLY", monthlySalaryPaise: 1_000_000 });
    await scheduleWholeWeek(ctx, h.id, help.id);
    await markAugust(ctx, h.id, help.id);
    const settlement = await generate(ctx, owner.cookie, h.id, help.id);
    const payment = await recordPayment(ctx, owner.cookie, h.id, settlement.id, { amountPaise: 300_000, paidOn: "2026-09-02", method: "CASH" });
    await voidPayment(ctx, owner.cookie, h.id, payment.body.data.id);

    const res = await voidPayment(ctx, owner.cookie, h.id, payment.body.data.id);
    expect(res.status).toBe(400);
  });

  it("a member of household A cannot record or void household B's payments", async () => {
    const alice = await signupUser(ctx);
    const bob = await signupUser(ctx);
    const a = await createHousehold(ctx, alice.cookie, "A");
    const b = await createHousehold(ctx, bob.cookie, "B");
    const bobsHelp = await createHousehelp(ctx, bob.cookie, b.id, { salaryMode: "FIXED_MONTHLY", monthlySalaryPaise: 1_000_000 });
    await scheduleWholeWeek(ctx, b.id, bobsHelp.id);
    await markAugust(ctx, b.id, bobsHelp.id);
    const settlement = await generate(ctx, bob.cookie, b.id, bobsHelp.id);

    const recordAttempt = await recordPayment(ctx, alice.cookie, a.id, settlement.id, { amountPaise: 100_000, paidOn: "2026-09-02", method: "CASH" });
    expect(recordAttempt.status).toBe(404);

    const bobsPayment = await recordPayment(ctx, bob.cookie, b.id, settlement.id, { amountPaise: 100_000, paidOn: "2026-09-02", method: "CASH" });
    expect(bobsPayment.status).toBe(201);

    const voidAttempt = await voidPayment(ctx, alice.cookie, a.id, bobsPayment.body.data.id);
    expect(voidAttempt.status).toBe(404);
  });

  it("VIEWER cannot record payments but MEMBER can (has salaries.pay by default)", async () => {
    const owner = await signupUser(ctx);
    const viewer = await signupUser(ctx);
    const member = await signupUser(ctx);
    const h = await createHousehold(ctx, owner.cookie);
    await addMember(h.id, viewer.id, "VIEWER");
    await addMember(h.id, member.id, "MEMBER");
    const help = await createHousehelp(ctx, owner.cookie, h.id, { salaryMode: "FIXED_MONTHLY", monthlySalaryPaise: 1_000_000 });
    await scheduleWholeWeek(ctx, h.id, help.id);
    await markAugust(ctx, h.id, help.id);
    const settlement = await generate(ctx, owner.cookie, h.id, help.id);

    const denied = await recordPayment(ctx, viewer.cookie, h.id, settlement.id, { amountPaise: 100_000, paidOn: "2026-09-02", method: "CASH" });
    expect(denied.status).toBe(403);

    const allowed = await recordPayment(ctx, member.cookie, h.id, settlement.id, { amountPaise: 100_000, paidOn: "2026-09-02", method: "CASH" });
    expect(allowed.status).toBe(201);
  });

  it("a payment for exactly the remaining balance after a partial payment flips the settlement to PAID", async () => {
    const owner = await signupUser(ctx);
    const h = await createHousehold(ctx, owner.cookie);
    const help = await createHousehelp(ctx, owner.cookie, h.id, { salaryMode: "FIXED_MONTHLY", monthlySalaryPaise: 1_000_000 });
    await scheduleWholeWeek(ctx, h.id, help.id);
    await markAugust(ctx, h.id, help.id);
    const settlement = await generate(ctx, owner.cookie, h.id, help.id);

    const first = await recordPayment(ctx, owner.cookie, h.id, settlement.id, { amountPaise: 400_000, paidOn: "2026-09-02", method: "CASH" });
    expect(first.status).toBe(201);

    // Exactly the remaining balance (1,000,000 - 400,000), not an arbitrary partial.
    const second = await recordPayment(ctx, owner.cookie, h.id, settlement.id, { amountPaise: 600_000, paidOn: "2026-09-03", method: "UPI" });
    expect(second.status).toBe(201);

    const [row] = await ctx.db.select().from(salarySettlements).where(eq(salarySettlements.id, settlement.id));
    expect(row!.status).toBe("PAID");
    expect(row!.amountPaidPaise).toBe(1_000_000);
  });

  it("paidAt is re-stamped fresh (not resurrected from a prior value) when voided back down and paid again", async () => {
    const owner = await signupUser(ctx);
    const h = await createHousehold(ctx, owner.cookie);
    const help = await createHousehelp(ctx, owner.cookie, h.id, { salaryMode: "FIXED_MONTHLY", monthlySalaryPaise: 1_000_000 });
    await scheduleWholeWeek(ctx, h.id, help.id);
    await markAugust(ctx, h.id, help.id);
    const settlement = await generate(ctx, owner.cookie, h.id, help.id);

    const first = await recordPayment(ctx, owner.cookie, h.id, settlement.id, { amountPaise: 1_000_000, paidOn: "2026-09-02", method: "CASH" });
    expect(first.status).toBe(201);
    let [row] = await ctx.db.select().from(salarySettlements).where(eq(salarySettlements.id, settlement.id));
    expect(row!.status).toBe("PAID");
    const firstPaidAt = row!.paidAt;
    expect(firstPaidAt).not.toBeNull();

    ctx.clock.advance(DAY);
    const voidRes = await voidPayment(ctx, owner.cookie, h.id, first.body.data.id);
    expect(voidRes.status).toBe(200);
    [row] = await ctx.db.select().from(salarySettlements).where(eq(salarySettlements.id, settlement.id));
    expect(row!.status).toBe("PENDING");
    expect(row!.paidAt).toBeNull();

    ctx.clock.advance(DAY);
    const second = await recordPayment(ctx, owner.cookie, h.id, settlement.id, { amountPaise: 1_000_000, paidOn: "2026-09-05", method: "CASH" });
    expect(second.status).toBe(201);
    [row] = await ctx.db.select().from(salarySettlements).where(eq(salarySettlements.id, settlement.id));
    expect(row!.status).toBe("PAID");
    expect(row!.paidAt).not.toBeNull();
    expect(row!.paidAt!.getTime()).toBeGreaterThan(firstPaidAt!.getTime());
  });
});
