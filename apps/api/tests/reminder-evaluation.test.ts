import { and, eq, isNull } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { addDays } from "@household/shared";
import { billOccurrences, househelps, reminderRules, salarySettlements } from "../src/db/schema.js";
import { getDueBillOccurrences, getDueSettlements } from "../src/services/reminder-evaluation.service.js";
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

/** ONE_TIME so the bill has exactly one occurrence, at exactly `firstDueDate` — the cleanest way
 * to pin a due date precisely for offset-boundary assertions. */
async function createBill(h: { id: string }, cookie: string, firstDueDate: string, extra: Record<string, unknown> = {}) {
  const res = await ctx.request.post(`/api/households/${h.id}/bills`).set(csrf).set("cookie", cookie)
    .send({ name: "Test bill", frequency: "ONE_TIME", firstDueDate, amountPaise: 50000, ...extra });
  expect(res.status).toBe(201);
  const bill = res.body.data as { id: string };
  const [occurrence] = await ctx.db.select().from(billOccurrences).where(eq(billOccurrences.billId, bill.id));
  return { bill, occurrence: occurrence! };
}

async function createHousehelp(householdId: string, name = "Sunita") {
  const [row] = await ctx.db.insert(househelps).values({ householdId, name }).returning();
  return row!;
}

let settlementSeq = 0;
async function createSettlement(householdId: string, househelpId: string, dueDate: string, extra: Record<string, unknown> = {}) {
  settlementSeq += 1;
  const periodMonth = `2026-${String((settlementSeq % 12) + 1).padStart(2, "0")}-01`;
  const [row] = await ctx.db.insert(salarySettlements).values({
    householdId, househelpId, periodMonth, dueDate, basePaise: 1000000, workingDays: 26, netPayablePaise: 1000000, ...extra,
  }).returning();
  return row!;
}

async function getDefaultRule(householdId: string, targetType: "BILL" | "SALARY") {
  const [row] = await ctx.db.select().from(reminderRules)
    .where(and(eq(reminderRules.householdId, householdId), eq(reminderRules.targetType, targetType), isNull(reminderRules.targetId)));
  return row!;
}

describe("reminder evaluation", () => {
  describe("getDueBillOccurrences", () => {
    it("flags an item exactly at an offset boundary (household default rule: offsets [7,3,1,0])", async () => {
      const owner = await signupUser(ctx);
      const h = await createHousehold(ctx, owner.cookie);
      const { bill, occurrence } = await createBill(h, owner.cookie, addDays(TODAY, 7));

      const due = await getDueBillOccurrences(ctx.deps, h.id, TODAY);
      const item = due.find((d) => d.occurrenceId === occurrence.id)!;
      expect(item).toMatchObject({ billId: bill.id, daysUntilDue: 7, matchedOffsets: [7], isOverdue: false });
    });

    it("exposes the effective rule's sendHour for the job's send-hour gating", async () => {
      const owner = await signupUser(ctx);
      const h = await createHousehold(ctx, owner.cookie);
      const { occurrence } = await createBill(h, owner.cookie, addDays(TODAY, 7));

      const due = await getDueBillOccurrences(ctx.deps, h.id, TODAY);
      const item = due.find((d) => d.occurrenceId === occurrence.id)!;
      expect(item.sendHour).toBe(9); // DEFAULT_REMINDERS.BILL.sendHour
    });

    it("flags an overdue item when the rule's overdueDaily is true (the default)", async () => {
      const owner = await signupUser(ctx);
      const h = await createHousehold(ctx, owner.cookie);
      const { occurrence } = await createBill(h, owner.cookie, addDays(TODAY, -9));

      const due = await getDueBillOccurrences(ctx.deps, h.id, TODAY);
      const item = due.find((d) => d.occurrenceId === occurrence.id)!;
      expect(item).toMatchObject({ daysUntilDue: -9, matchedOffsets: [], isOverdue: true });
    });

    it("does NOT flag an overdue item when the rule's overdueDaily is false", async () => {
      const owner = await signupUser(ctx);
      const h = await createHousehold(ctx, owner.cookie);
      const defaultRule = await getDefaultRule(h.id, "BILL");
      await ctx.db.update(reminderRules).set({ overdueDaily: false }).where(eq(reminderRules.id, defaultRule.id));
      const { occurrence } = await createBill(h, owner.cookie, addDays(TODAY, -9));

      const due = await getDueBillOccurrences(ctx.deps, h.id, TODAY);
      const item = due.find((d) => d.occurrenceId === occurrence.id)!;
      expect(item).toMatchObject({ daysUntilDue: -9, matchedOffsets: [], isOverdue: false });
    });

    it("returns matchedOffsets: [] and isOverdue: false for an item that is neither at an offset nor overdue", async () => {
      const owner = await signupUser(ctx);
      const h = await createHousehold(ctx, owner.cookie);
      const { occurrence } = await createBill(h, owner.cookie, addDays(TODAY, 10));

      const due = await getDueBillOccurrences(ctx.deps, h.id, TODAY);
      const item = due.find((d) => d.occurrenceId === occurrence.id)!;
      expect(item).toMatchObject({ daysUntilDue: 10, matchedOffsets: [], isOverdue: false });
    });

    it("a specific-target override rule takes precedence over the household default", async () => {
      const owner = await signupUser(ctx);
      const h = await createHousehold(ctx, owner.cookie);
      const { bill, occurrence } = await createBill(h, owner.cookie, addDays(TODAY, 14));
      // 14 is not in the household default's offsets ([7,3,1,0]) — only the override would match it.
      await ctx.db.insert(reminderRules).values({ householdId: h.id, targetType: "BILL", targetId: bill.id, offsetsDays: [14], overdueDaily: false });

      const due = await getDueBillOccurrences(ctx.deps, h.id, TODAY);
      const item = due.find((d) => d.occurrenceId === occurrence.id)!;
      expect(item).toMatchObject({ daysUntilDue: 14, matchedOffsets: [14], isOverdue: false });
    });

    it("an isActive: false rule suppresses all matching regardless of its stored offsets/overdueDaily", async () => {
      const owner = await signupUser(ctx);
      const h = await createHousehold(ctx, owner.cookie);
      const { bill, occurrence } = await createBill(h, owner.cookie, addDays(TODAY, -5));
      await ctx.db.insert(reminderRules).values({
        householdId: h.id, targetType: "BILL", targetId: bill.id, offsetsDays: [0, 5], overdueDaily: true, isActive: false,
      });

      const due = await getDueBillOccurrences(ctx.deps, h.id, TODAY);
      const item = due.find((d) => d.occurrenceId === occurrence.id)!;
      expect(item).toMatchObject({ daysUntilDue: -5, matchedOffsets: [], isOverdue: false });
    });

    it("excludes PAID, WAIVED, and PAUSED/ARCHIVED-bill occurrences entirely", async () => {
      const owner = await signupUser(ctx);
      const h = await createHousehold(ctx, owner.cookie);

      const paid = await createBill(h, owner.cookie, TODAY);
      await ctx.db.update(billOccurrences).set({ status: "PAID", amountPaidPaise: 50000, paidAt: ctx.clock.now() }).where(eq(billOccurrences.id, paid.occurrence.id));

      const waived = await createBill(h, owner.cookie, TODAY);
      await ctx.db.update(billOccurrences).set({ status: "WAIVED", waivedAt: ctx.clock.now() }).where(eq(billOccurrences.id, waived.occurrence.id));

      const paused = await createBill(h, owner.cookie, TODAY);
      await ctx.request.post(`/api/households/${h.id}/bills/${paused.bill.id}/pause`).set(csrf).set("cookie", owner.cookie);

      const archived = await createBill(h, owner.cookie, TODAY);
      await ctx.request.post(`/api/households/${h.id}/bills/${archived.bill.id}/archive`).set(csrf).set("cookie", owner.cookie);

      const stillDue = await createBill(h, owner.cookie, TODAY);

      const due = await getDueBillOccurrences(ctx.deps, h.id, TODAY);
      const ids = due.map((d) => d.occurrenceId);
      expect(ids).not.toContain(paid.occurrence.id);
      expect(ids).not.toContain(waived.occurrence.id);
      expect(ids).not.toContain(paused.occurrence.id);
      expect(ids).not.toContain(archived.occurrence.id);
      expect(ids).toContain(stillDue.occurrence.id);
    });

    it("never sees another household's bills (cross-household isolation)", async () => {
      const owner = await signupUser(ctx);
      const h = await createHousehold(ctx, owner.cookie);
      await createBill(h, owner.cookie, TODAY);

      const other = await signupUser(ctx);
      const hOther = await createHousehold(ctx, other.cookie, "Other household");
      const { occurrence: otherOccurrence } = await createBill(hOther, other.cookie, TODAY);

      const due = await getDueBillOccurrences(ctx.deps, h.id, TODAY);
      expect(due.map((d) => d.occurrenceId)).not.toContain(otherOccurrence.id);
    });
  });

  describe("getDueSettlements", () => {
    it("flags an item exactly at an offset boundary (household default rule: offsets [3,0])", async () => {
      const owner = await signupUser(ctx);
      const h = await createHousehold(ctx, owner.cookie);
      const help = await createHousehelp(h.id, "Sunita");
      const settlement = await createSettlement(h.id, help.id, addDays(TODAY, 3));

      const due = await getDueSettlements(ctx.deps, h.id, TODAY);
      const item = due.find((d) => d.settlementId === settlement.id)!;
      expect(item).toMatchObject({ househelpId: help.id, househelpName: "Sunita", daysUntilDue: 3, matchedOffsets: [3], isOverdue: false });
    });

    it("exposes the effective rule's sendHour for the job's send-hour gating", async () => {
      const owner = await signupUser(ctx);
      const h = await createHousehold(ctx, owner.cookie);
      const help = await createHousehelp(h.id);
      const settlement = await createSettlement(h.id, help.id, addDays(TODAY, 3));

      const due = await getDueSettlements(ctx.deps, h.id, TODAY);
      const item = due.find((d) => d.settlementId === settlement.id)!;
      expect(item.sendHour).toBe(9); // DEFAULT_REMINDERS.SALARY.sendHour
    });

    it("flags an overdue settlement when the rule's overdueDaily is true (the default)", async () => {
      const owner = await signupUser(ctx);
      const h = await createHousehold(ctx, owner.cookie);
      const help = await createHousehelp(h.id);
      const settlement = await createSettlement(h.id, help.id, addDays(TODAY, -4));

      const due = await getDueSettlements(ctx.deps, h.id, TODAY);
      const item = due.find((d) => d.settlementId === settlement.id)!;
      expect(item).toMatchObject({ daysUntilDue: -4, matchedOffsets: [], isOverdue: true });
    });

    it("does NOT flag an overdue settlement when the rule's overdueDaily is false", async () => {
      const owner = await signupUser(ctx);
      const h = await createHousehold(ctx, owner.cookie);
      const defaultRule = await getDefaultRule(h.id, "SALARY");
      await ctx.db.update(reminderRules).set({ overdueDaily: false }).where(eq(reminderRules.id, defaultRule.id));
      const help = await createHousehelp(h.id);
      const settlement = await createSettlement(h.id, help.id, addDays(TODAY, -4));

      const due = await getDueSettlements(ctx.deps, h.id, TODAY);
      const item = due.find((d) => d.settlementId === settlement.id)!;
      expect(item).toMatchObject({ daysUntilDue: -4, matchedOffsets: [], isOverdue: false });
    });

    it("returns matchedOffsets: [] and isOverdue: false for a settlement that is neither at an offset nor overdue", async () => {
      const owner = await signupUser(ctx);
      const h = await createHousehold(ctx, owner.cookie);
      const help = await createHousehelp(h.id);
      const settlement = await createSettlement(h.id, help.id, addDays(TODAY, 10));

      const due = await getDueSettlements(ctx.deps, h.id, TODAY);
      const item = due.find((d) => d.settlementId === settlement.id)!;
      expect(item).toMatchObject({ daysUntilDue: 10, matchedOffsets: [], isOverdue: false });
    });

    it("a specific-target (househelp) override rule takes precedence over the household default", async () => {
      const owner = await signupUser(ctx);
      const h = await createHousehold(ctx, owner.cookie);
      const help = await createHousehelp(h.id);
      const settlement = await createSettlement(h.id, help.id, addDays(TODAY, 14));
      // 14 is not in the household default's offsets ([3,0]) — only the override would match it.
      await ctx.db.insert(reminderRules).values({ householdId: h.id, targetType: "SALARY", targetId: help.id, offsetsDays: [14], overdueDaily: false });

      const due = await getDueSettlements(ctx.deps, h.id, TODAY);
      const item = due.find((d) => d.settlementId === settlement.id)!;
      expect(item).toMatchObject({ daysUntilDue: 14, matchedOffsets: [14], isOverdue: false });
    });

    it("an isActive: false rule suppresses all matching regardless of its stored offsets/overdueDaily", async () => {
      const owner = await signupUser(ctx);
      const h = await createHousehold(ctx, owner.cookie);
      const help = await createHousehelp(h.id);
      const settlement = await createSettlement(h.id, help.id, addDays(TODAY, -2));
      await ctx.db.insert(reminderRules).values({
        householdId: h.id, targetType: "SALARY", targetId: help.id, offsetsDays: [0, 2], overdueDaily: true, isActive: false,
      });

      const due = await getDueSettlements(ctx.deps, h.id, TODAY);
      const item = due.find((d) => d.settlementId === settlement.id)!;
      expect(item).toMatchObject({ daysUntilDue: -2, matchedOffsets: [], isOverdue: false });
    });

    it("excludes PAID and CANCELLED settlements entirely", async () => {
      const owner = await signupUser(ctx);
      const h = await createHousehold(ctx, owner.cookie);
      const help = await createHousehelp(h.id);
      const paid = await createSettlement(h.id, help.id, TODAY, { status: "PAID", amountPaidPaise: 1000000, paidAt: ctx.clock.now() });
      const cancelled = await createSettlement(h.id, help.id, TODAY, { status: "CANCELLED" });
      const stillDue = await createSettlement(h.id, help.id, TODAY);

      const due = await getDueSettlements(ctx.deps, h.id, TODAY);
      const ids = due.map((d) => d.settlementId);
      expect(ids).not.toContain(paid.id);
      expect(ids).not.toContain(cancelled.id);
      expect(ids).toContain(stillDue.id);
    });

    it("never sees another household's settlements (cross-household isolation)", async () => {
      const owner = await signupUser(ctx);
      const h = await createHousehold(ctx, owner.cookie);
      const help = await createHousehelp(h.id);
      await createSettlement(h.id, help.id, TODAY);

      const other = await signupUser(ctx);
      const hOther = await createHousehold(ctx, other.cookie, "Other household");
      const helpOther = await createHousehelp(hOther.id);
      const otherSettlement = await createSettlement(hOther.id, helpOther.id, TODAY);

      const due = await getDueSettlements(ctx.deps, h.id, TODAY);
      expect(due.map((d) => d.settlementId)).not.toContain(otherSettlement.id);
    });
  });
});
