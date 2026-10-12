import { eq } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { addDays } from "@household/shared";
import { householdMembers, notifications, notificationDeliveries, notificationPreferences, househelps, salarySettlements } from "../src/db/schema.js";
import { runEvaluateReminders } from "../src/jobs/evaluate-reminders.job.js";
import { createTestContext, csrf, signupUser, truncateAll, type TestContext } from "./helpers.js";

const ctx = createTestContext();
const SEND_HOUR_NOW = "2026-09-29T03:30:00Z"; // 09:00 IST — matches DEFAULT_REMINDERS' sendHour: 9
const WRONG_HOUR_NOW = "2026-09-29T04:30:00Z"; // 10:00 IST — one hour off
const TODAY = "2026-09-29";

beforeEach(async () => {
  await truncateAll(ctx.db);
  ctx.clock.set(SEND_HOUR_NOW);
});
afterAll(() => ctx.close());

async function createHousehold(c: TestContext, cookie: string, name = "Shah Family") {
  const res = await c.request.post("/api/households").set(csrf).set("cookie", cookie).send({ name });
  expect(res.status).toBe(201);
  return res.body.data as { id: string };
}

async function createBill(h: { id: string }, cookie: string, firstDueDate: string) {
  const res = await ctx.request.post(`/api/households/${h.id}/bills`).set(csrf).set("cookie", cookie)
    .send({ name: "Electricity", frequency: "ONE_TIME", firstDueDate, amountPaise: 50000 });
  expect(res.status).toBe(201);
  return res.body.data as { id: string };
}

async function createHousehelp(householdId: string, name = "Sunita") {
  const [row] = await ctx.db.insert(househelps).values({ householdId, name }).returning();
  return row!;
}

async function createSettlement(householdId: string, househelpId: string, dueDate: string) {
  const [row] = await ctx.db.insert(salarySettlements).values({
    householdId, househelpId, periodMonth: "2026-09-01", dueDate, basePaise: 1000000, workingDays: 26, netPayablePaise: 1000000,
  }).returning();
  return row!;
}

async function addActiveMember(householdId: string, userId: string) {
  await ctx.db.insert(householdMembers).values({ householdId, userId, role: "MEMBER", status: "ACTIVE" });
}

describe("runEvaluateReminders", () => {
  it("creates an in-app notification for the household owner at a matched offset", async () => {
    const owner = await signupUser(ctx);
    const h = await createHousehold(ctx, owner.cookie);
    await createBill(h, owner.cookie, addDays(TODAY, 7)); // household default BILL offsets include 7

    await runEvaluateReminders(ctx.deps);

    const rows = await ctx.db.select().from(notifications).where(eq(notifications.householdId, h.id));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ userId: owner.id, category: "BILL", severity: "INFO" });
    expect(rows[0]!.idempotencyKey).toMatch(/^bill_occ:.+:before:7:user:/);

    const deliveries = await ctx.db.select().from(notificationDeliveries).where(eq(notificationDeliveries.notificationId, rows[0]!.id));
    expect(deliveries).toHaveLength(2); // IN_APP + WEB_PUSH (default channels)
    expect(deliveries.find((d) => d.channel === "IN_APP")).toMatchObject({ status: "SENT" });
    expect(deliveries.find((d) => d.channel === "WEB_PUSH")).toMatchObject({ status: "PENDING" });
  });

  it("does not create a notification outside the rule's sendHour", async () => {
    const owner = await signupUser(ctx);
    const h = await createHousehold(ctx, owner.cookie);
    await createBill(h, owner.cookie, addDays(TODAY, 7));
    ctx.clock.set(WRONG_HOUR_NOW);

    await runEvaluateReminders(ctx.deps);

    const rows = await ctx.db.select().from(notifications).where(eq(notifications.householdId, h.id));
    expect(rows).toHaveLength(0);
  });

  it("is idempotent across re-runs within the same hour", async () => {
    const owner = await signupUser(ctx);
    const h = await createHousehold(ctx, owner.cookie);
    await createBill(h, owner.cookie, addDays(TODAY, 7));

    await runEvaluateReminders(ctx.deps);
    await runEvaluateReminders(ctx.deps);

    const rows = await ctx.db.select().from(notifications).where(eq(notifications.householdId, h.id));
    expect(rows).toHaveLength(1);
  });

  it("fans out to every active member, skipping one whose preference disables BILL", async () => {
    const owner = await signupUser(ctx);
    const h = await createHousehold(ctx, owner.cookie);
    const other = await signupUser(ctx);
    await addActiveMember(h.id, other.id);
    await ctx.db.insert(notificationPreferences).values({ householdId: h.id, userId: other.id, category: "BILL", enabled: false });
    await createBill(h, owner.cookie, addDays(TODAY, 7));

    await runEvaluateReminders(ctx.deps);

    const rows = await ctx.db.select().from(notifications).where(eq(notifications.householdId, h.id));
    expect(rows.map((r) => r.userId)).toEqual([owner.id]);
  });

  it("notifies a member with no preference row at all (default-enabled)", async () => {
    const owner = await signupUser(ctx);
    const h = await createHousehold(ctx, owner.cookie);
    const other = await signupUser(ctx);
    await addActiveMember(h.id, other.id);
    await createBill(h, owner.cookie, addDays(TODAY, 7));

    await runEvaluateReminders(ctx.deps);

    const rows = await ctx.db.select().from(notifications).where(eq(notifications.householdId, h.id));
    expect(rows.map((r) => r.userId).sort()).toEqual([other.id, owner.id].sort());
  });

  it("fires an overdue notification daily while unpaid, once per day", async () => {
    const owner = await signupUser(ctx);
    const h = await createHousehold(ctx, owner.cookie);
    await createBill(h, owner.cookie, addDays(TODAY, -9));

    await runEvaluateReminders(ctx.deps);
    await runEvaluateReminders(ctx.deps); // same day — no duplicate

    let rows = await ctx.db.select().from(notifications).where(eq(notifications.householdId, h.id));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.severity).toBe("URGENT");

    ctx.clock.set("2026-09-30T03:30:00Z"); // next day, same send hour
    await runEvaluateReminders(ctx.deps);

    rows = await ctx.db.select().from(notifications).where(eq(notifications.householdId, h.id));
    expect(rows).toHaveLength(2);
  });

  it("keeps notifications isolated between households", async () => {
    const ownerA = await signupUser(ctx);
    const hA = await createHousehold(ctx, ownerA.cookie, "Household A");
    await createBill(hA, ownerA.cookie, addDays(TODAY, 7));
    const ownerB = await signupUser(ctx);
    const hB = await createHousehold(ctx, ownerB.cookie, "Household B");

    await runEvaluateReminders(ctx.deps);

    const rowsA = await ctx.db.select().from(notifications).where(eq(notifications.householdId, hA.id));
    const rowsB = await ctx.db.select().from(notifications).where(eq(notifications.householdId, hB.id));
    expect(rowsA).toHaveLength(1);
    expect(rowsB).toHaveLength(0);
  });

  it("creates a SALARY notification for a due settlement with the settlement idempotency-key prefix", async () => {
    const owner = await signupUser(ctx);
    const h = await createHousehold(ctx, owner.cookie);
    const help = await createHousehelp(h.id);
    await createSettlement(h.id, help.id, addDays(TODAY, 3)); // household default SALARY offsets: [3, 0]

    await runEvaluateReminders(ctx.deps);

    const rows = await ctx.db.select().from(notifications).where(eq(notifications.householdId, h.id));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ category: "SALARY", userId: owner.id });
    expect(rows[0]!.idempotencyKey).toMatch(/^settlement:.+:before:3:user:/);
  });
});
