import { eq } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { billOccurrences, billPayments, householdMembers } from "../src/db/schema.js";
import { createTestContext, csrf, signupUser, truncateAll, type TestContext } from "./helpers.js";

const ctx = createTestContext();
const NOW = "2026-09-29T04:30:00Z"; // 2026-09-29 in Asia/Kolkata — matches FakeClock's default

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

async function firstOccurrence(h: { id: string }, billId: string, cookie: string) {
  const res = await ctx.request.get(`/api/households/${h.id}/bills/${billId}/occurrences`).set("cookie", cookie);
  expect(res.status).toBe(200);
  const rows = res.body.data as Array<{ id: string; dueDate: string; amountDuePaise: number; amountPaidPaise: number; status: string }>;
  return rows[0]!;
}

function recordPayment(c: TestContext, cookie: string, householdId: string, billId: string, occurrenceId: string, body: Record<string, unknown>) {
  return c.request.post(`/api/households/${householdId}/bills/${billId}/occurrences/${occurrenceId}/payments`).set(csrf).set("cookie", cookie).send(body);
}

function voidPayment(c: TestContext, cookie: string, householdId: string, billId: string, occurrenceId: string, paymentId: string, reason?: string) {
  const url = `/api/households/${householdId}/bills/${billId}/occurrences/${occurrenceId}/payments/${paymentId}${reason ? `?reason=${encodeURIComponent(reason)}` : ""}`;
  return c.request.delete(url).set(csrf).set("cookie", cookie);
}

function waive(c: TestContext, cookie: string, householdId: string, billId: string, occurrenceId: string, body: Record<string, unknown> = {}) {
  return c.request.post(`/api/households/${householdId}/bills/${billId}/occurrences/${occurrenceId}/waive`).set(csrf).set("cookie", cookie).send(body);
}

describe("bill payments", () => {
  it("a partial payment moves the occurrence to PARTIALLY_PAID", async () => {
    const owner = await signupUser(ctx);
    const h = await createHousehold(ctx, owner.cookie);
    const bill = await createBill(h, owner.cookie, { name: "Electricity", frequency: "MONTHLY", firstDueDate: "2026-11-05", amountPaise: 100000 });
    const occ = await firstOccurrence(h, bill.id, owner.cookie);

    const res = await recordPayment(ctx, owner.cookie, h.id, bill.id, occ.id, { amountPaise: 40000, paidOn: "2026-11-01", method: "CASH" });
    expect(res.status).toBe(201);

    const [row] = await ctx.db.select().from(billOccurrences).where(eq(billOccurrences.id, occ.id));
    expect(row!.status).toBe("PARTIALLY_PAID");
    expect(row!.amountPaidPaise).toBe(40000);
    expect(row!.paidAt).toBeNull();
  });

  it("a full payment moves the occurrence to PAID and sets paidAt", async () => {
    const owner = await signupUser(ctx);
    const h = await createHousehold(ctx, owner.cookie);
    const bill = await createBill(h, owner.cookie, { name: "Electricity", frequency: "MONTHLY", firstDueDate: "2026-11-05", amountPaise: 100000 });
    const occ = await firstOccurrence(h, bill.id, owner.cookie);

    const res = await recordPayment(ctx, owner.cookie, h.id, bill.id, occ.id, { amountPaise: 100000, paidOn: "2026-11-01", method: "UPI" });
    expect(res.status).toBe(201);
    expect(res.body.data).toMatchObject({ occurrenceId: occ.id, amountPaise: 100000, method: "UPI" });

    const [row] = await ctx.db.select().from(billOccurrences).where(eq(billOccurrences.id, occ.id));
    expect(row!.status).toBe("PAID");
    expect(row!.amountPaidPaise).toBe(100000);
    expect(row!.paidAt).not.toBeNull();
  });

  it("accumulates multiple partial payments that together reach PAID", async () => {
    const owner = await signupUser(ctx);
    const h = await createHousehold(ctx, owner.cookie);
    const bill = await createBill(h, owner.cookie, { name: "Electricity", frequency: "MONTHLY", firstDueDate: "2026-11-05", amountPaise: 100000 });
    const occ = await firstOccurrence(h, bill.id, owner.cookie);

    const first = await recordPayment(ctx, owner.cookie, h.id, bill.id, occ.id, { amountPaise: 60000, paidOn: "2026-11-01", method: "CASH" });
    expect(first.status).toBe(201);
    const second = await recordPayment(ctx, owner.cookie, h.id, bill.id, occ.id, { amountPaise: 40000, paidOn: "2026-11-02", method: "UPI" });
    expect(second.status).toBe(201);

    const [row] = await ctx.db.select().from(billOccurrences).where(eq(billOccurrences.id, occ.id));
    expect(row!.status).toBe("PAID");
    expect(row!.amountPaidPaise).toBe(100000);
  });

  it("rejects a payment that would exceed amountDuePaise, and doesn't touch the occurrence", async () => {
    const owner = await signupUser(ctx);
    const h = await createHousehold(ctx, owner.cookie);
    const bill = await createBill(h, owner.cookie, { name: "Electricity", frequency: "MONTHLY", firstDueDate: "2026-11-05", amountPaise: 100000 });
    const occ = await firstOccurrence(h, bill.id, owner.cookie);

    const res = await recordPayment(ctx, owner.cookie, h.id, bill.id, occ.id, { amountPaise: 100001, paidOn: "2026-11-01", method: "CASH" });
    expect(res.status).toBe(400);
    expect(res.body.error.fields).toHaveProperty("amountPaise");

    const [row] = await ctx.db.select().from(billOccurrences).where(eq(billOccurrences.id, occ.id));
    expect(row!.status).toBe("PENDING");
    expect(row!.amountPaidPaise).toBe(0);
  });

  it("rejects recording a payment against a WAIVED occurrence", async () => {
    const owner = await signupUser(ctx);
    const h = await createHousehold(ctx, owner.cookie);
    const bill = await createBill(h, owner.cookie, { name: "Electricity", frequency: "MONTHLY", firstDueDate: "2026-11-05", amountPaise: 100000 });
    const occ = await firstOccurrence(h, bill.id, owner.cookie);
    const waiveRes = await waive(ctx, owner.cookie, h.id, bill.id, occ.id);
    expect(waiveRes.status).toBe(200);

    const res = await recordPayment(ctx, owner.cookie, h.id, bill.id, occ.id, { amountPaise: 1000, paidOn: "2026-11-01", method: "CASH" });
    expect(res.status).toBe(400);
  });

  it("voiding a payment reverses the occurrence's status back down (PAID -> PARTIALLY_PAID), clearing paidAt", async () => {
    const owner = await signupUser(ctx);
    const h = await createHousehold(ctx, owner.cookie);
    const bill = await createBill(h, owner.cookie, { name: "Electricity", frequency: "MONTHLY", firstDueDate: "2026-11-05", amountPaise: 100000 });
    const occ = await firstOccurrence(h, bill.id, owner.cookie);

    await recordPayment(ctx, owner.cookie, h.id, bill.id, occ.id, { amountPaise: 60000, paidOn: "2026-11-01", method: "CASH" });
    const second = await recordPayment(ctx, owner.cookie, h.id, bill.id, occ.id, { amountPaise: 40000, paidOn: "2026-11-02", method: "UPI" });
    expect(second.status).toBe(201);

    let [row] = await ctx.db.select().from(billOccurrences).where(eq(billOccurrences.id, occ.id));
    expect(row!.status).toBe("PAID");
    expect(row!.paidAt).not.toBeNull();

    const voidRes = await voidPayment(ctx, owner.cookie, h.id, bill.id, occ.id, second.body.data.id, "entered in error");
    expect(voidRes.status).toBe(200);

    [row] = await ctx.db.select().from(billOccurrences).where(eq(billOccurrences.id, occ.id));
    expect(row!.status).toBe("PARTIALLY_PAID");
    expect(row!.amountPaidPaise).toBe(60000);
    expect(row!.paidAt).toBeNull();

    const [paymentRow] = await ctx.db.select().from(billPayments).where(eq(billPayments.id, second.body.data.id));
    expect(paymentRow!.voidedAt).not.toBeNull();
    expect(paymentRow!.voidReason).toBe("entered in error");
  });

  it("voiding a payment reverses the occurrence's status all the way back to PENDING", async () => {
    const owner = await signupUser(ctx);
    const h = await createHousehold(ctx, owner.cookie);
    const bill = await createBill(h, owner.cookie, { name: "Electricity", frequency: "MONTHLY", firstDueDate: "2026-11-05", amountPaise: 100000 });
    const occ = await firstOccurrence(h, bill.id, owner.cookie);

    const only = await recordPayment(ctx, owner.cookie, h.id, bill.id, occ.id, { amountPaise: 30000, paidOn: "2026-11-01", method: "CASH" });
    expect(only.status).toBe(201);
    let [row] = await ctx.db.select().from(billOccurrences).where(eq(billOccurrences.id, occ.id));
    expect(row!.status).toBe("PARTIALLY_PAID");

    const voidRes = await voidPayment(ctx, owner.cookie, h.id, bill.id, occ.id, only.body.data.id);
    expect(voidRes.status).toBe(200);

    [row] = await ctx.db.select().from(billOccurrences).where(eq(billOccurrences.id, occ.id));
    expect(row!.status).toBe("PENDING");
    expect(row!.amountPaidPaise).toBe(0);
  });

  it("rejects voiding an already-voided payment", async () => {
    const owner = await signupUser(ctx);
    const h = await createHousehold(ctx, owner.cookie);
    const bill = await createBill(h, owner.cookie, { name: "Electricity", frequency: "MONTHLY", firstDueDate: "2026-11-05", amountPaise: 100000 });
    const occ = await firstOccurrence(h, bill.id, owner.cookie);
    const payment = await recordPayment(ctx, owner.cookie, h.id, bill.id, occ.id, { amountPaise: 30000, paidOn: "2026-11-01", method: "CASH" });
    await voidPayment(ctx, owner.cookie, h.id, bill.id, occ.id, payment.body.data.id);

    const res = await voidPayment(ctx, owner.cookie, h.id, bill.id, occ.id, payment.body.data.id);
    expect(res.status).toBe(400);
  });

  describe("bill-id mismatch and cross-household isolation", () => {
    it("404s recording a payment when the URL's bill id doesn't match the occurrence's actual bill", async () => {
      const owner = await signupUser(ctx);
      const h = await createHousehold(ctx, owner.cookie);
      const billA = await createBill(h, owner.cookie, { name: "Bill A", frequency: "MONTHLY", firstDueDate: "2026-11-05", amountPaise: 100000 });
      const billB = await createBill(h, owner.cookie, { name: "Bill B", frequency: "MONTHLY", firstDueDate: "2026-11-05", amountPaise: 100000 });
      const occA = await firstOccurrence(h, billA.id, owner.cookie);

      const res = await recordPayment(ctx, owner.cookie, h.id, billB.id, occA.id, { amountPaise: 1000, paidOn: "2026-11-01", method: "CASH" });
      expect(res.status).toBe(404);
    });

    it("404s voiding a payment when the URL's bill/occurrence ids don't match the payment's actual ones", async () => {
      const owner = await signupUser(ctx);
      const h = await createHousehold(ctx, owner.cookie);
      const billA = await createBill(h, owner.cookie, { name: "Bill A", frequency: "MONTHLY", firstDueDate: "2026-11-05", amountPaise: 100000 });
      const billB = await createBill(h, owner.cookie, { name: "Bill B", frequency: "MONTHLY", firstDueDate: "2026-11-05", amountPaise: 100000 });
      const occA = await firstOccurrence(h, billA.id, owner.cookie);
      const occB = await firstOccurrence(h, billB.id, owner.cookie);
      const payment = await recordPayment(ctx, owner.cookie, h.id, billA.id, occA.id, { amountPaise: 1000, paidOn: "2026-11-01", method: "CASH" });
      expect(payment.status).toBe(201);

      const wrongBill = await voidPayment(ctx, owner.cookie, h.id, billB.id, occA.id, payment.body.data.id);
      expect(wrongBill.status).toBe(404);
      const wrongOccurrence = await voidPayment(ctx, owner.cookie, h.id, billA.id, occB.id, payment.body.data.id);
      expect(wrongOccurrence.status).toBe(404);
    });

    it("a member of household A cannot record or void household B's payments", async () => {
      const alice = await signupUser(ctx);
      const bob = await signupUser(ctx);
      const a = await createHousehold(ctx, alice.cookie, "A");
      const b = await createHousehold(ctx, bob.cookie, "B");
      const bill = await createBill(b, bob.cookie, { name: "Electricity", frequency: "MONTHLY", firstDueDate: "2026-11-05", amountPaise: 100000 });
      const occ = await firstOccurrence(b, bill.id, bob.cookie);

      const recordAttempt = await recordPayment(ctx, alice.cookie, a.id, bill.id, occ.id, { amountPaise: 1000, paidOn: "2026-11-01", method: "CASH" });
      expect(recordAttempt.status).toBe(404);

      const bobsPayment = await recordPayment(ctx, bob.cookie, b.id, bill.id, occ.id, { amountPaise: 1000, paidOn: "2026-11-01", method: "CASH" });
      expect(bobsPayment.status).toBe(201);

      const voidAttempt = await voidPayment(ctx, alice.cookie, a.id, bill.id, occ.id, bobsPayment.body.data.id);
      expect(voidAttempt.status).toBe(404);
    });
  });

  describe("permission gating", () => {
    it("VIEWER cannot record payments but MEMBER can (has payments.record by default)", async () => {
      const owner = await signupUser(ctx);
      const viewer = await signupUser(ctx);
      const member = await signupUser(ctx);
      const h = await createHousehold(ctx, owner.cookie);
      await addMember(h.id, viewer.id, "VIEWER");
      await addMember(h.id, member.id, "MEMBER");
      const bill = await createBill(h, owner.cookie, { name: "Electricity", frequency: "MONTHLY", firstDueDate: "2026-11-05", amountPaise: 100000 });
      const occ = await firstOccurrence(h, bill.id, owner.cookie);

      const denied = await recordPayment(ctx, viewer.cookie, h.id, bill.id, occ.id, { amountPaise: 1000, paidOn: "2026-11-01", method: "CASH" });
      expect(denied.status).toBe(403);

      const allowed = await recordPayment(ctx, member.cookie, h.id, bill.id, occ.id, { amountPaise: 1000, paidOn: "2026-11-01", method: "CASH" });
      expect(allowed.status).toBe(201);
    });
  });
});
