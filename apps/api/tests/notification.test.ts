import { eq } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { billOccurrences, householdMembers, notifications } from "../src/db/schema.js";
import { createTestContext, csrf, signupUser, truncateAll, type TestContext } from "./helpers.js";

const ctx = createTestContext();

beforeEach(async () => { await truncateAll(ctx.db); });
afterAll(() => ctx.close());

async function createHousehold(c: TestContext, cookie: string, name = "Shah Family") {
  const res = await c.request.post("/api/households").set(csrf).set("cookie", cookie).send({ name });
  expect(res.status).toBe(201);
  return res.body.data as { id: string };
}

async function createBill(h: { id: string }, cookie: string) {
  const res = await ctx.request.post(`/api/households/${h.id}/bills`).set(csrf).set("cookie", cookie)
    .send({ name: "Electricity", frequency: "ONE_TIME", firstDueDate: "2026-09-29", amountPaise: 50000 });
  expect(res.status).toBe(201);
  const bill = res.body.data as { id: string };
  const [occurrence] = await ctx.db.select().from(billOccurrences).where(eq(billOccurrences.billId, bill.id));
  return { bill, occurrence: occurrence! };
}

async function addActiveMember(householdId: string, userId: string) {
  await ctx.db.insert(householdMembers).values({ householdId, userId, role: "MEMBER", status: "ACTIVE" });
}

let seq = 0;
async function insertNotification(householdId: string, userId: string, overrides: Record<string, unknown> = {}) {
  seq += 1;
  const [row] = await ctx.db.insert(notifications).values({
    householdId, userId, category: "BILL", title: "Electricity due in 7 day(s)",
    idempotencyKey: `test-key-${seq}`, ...overrides,
  }).returning();
  return row!;
}

describe("notifications", () => {
  describe("GET /notifications", () => {
    it("lists the caller's non-dismissed notifications, newest first, resolving a BILL linkPath", async () => {
      const owner = await signupUser(ctx);
      const h = await createHousehold(ctx, owner.cookie);
      const { bill, occurrence } = await createBill(h, owner.cookie);
      await insertNotification(h.id, owner.id, { entityType: "bill_occurrence", entityId: occurrence.id });

      const res = await ctx.request.get(`/api/households/${h.id}/notifications`).set("cookie", owner.cookie);
      expect(res.status).toBe(200);
      expect(res.body.data).toHaveLength(1);
      expect(res.body.data[0]).toMatchObject({ category: "BILL", title: "Electricity due in 7 day(s)", linkPath: `/bills/${bill.id}`, readAt: null, dismissedAt: null });
    });

    it("resolves a SALARY notification's linkPath directly from entityId", async () => {
      const owner = await signupUser(ctx);
      const h = await createHousehold(ctx, owner.cookie);
      await insertNotification(h.id, owner.id, { category: "SALARY", entityType: "salary_settlement", entityId: "11111111-1111-1111-1111-111111111111" });

      const res = await ctx.request.get(`/api/households/${h.id}/notifications`).set("cookie", owner.cookie);
      expect(res.body.data[0]).toMatchObject({ linkPath: "/salary/11111111-1111-1111-1111-111111111111" });
    });

    it("returns a null linkPath for a BILL notification whose occurrence no longer exists", async () => {
      const owner = await signupUser(ctx);
      const h = await createHousehold(ctx, owner.cookie);
      await insertNotification(h.id, owner.id, { entityType: "bill_occurrence", entityId: "22222222-2222-2222-2222-222222222222" });

      const res = await ctx.request.get(`/api/households/${h.id}/notifications`).set("cookie", owner.cookie);
      expect(res.body.data[0]).toMatchObject({ linkPath: null });
    });

    it("excludes dismissed notifications but includes read ones", async () => {
      const owner = await signupUser(ctx);
      const h = await createHousehold(ctx, owner.cookie);
      await insertNotification(h.id, owner.id, { dismissedAt: ctx.clock.now() });
      const read = await insertNotification(h.id, owner.id, { readAt: ctx.clock.now() });

      const res = await ctx.request.get(`/api/households/${h.id}/notifications`).set("cookie", owner.cookie);
      expect(res.body.data).toHaveLength(1);
      expect(res.body.data[0].id).toBe(read.id);
      expect(res.body.data[0].readAt).not.toBeNull();
    });

    it("never returns another household member's notifications", async () => {
      const owner = await signupUser(ctx);
      const h = await createHousehold(ctx, owner.cookie);
      const other = await signupUser(ctx);
      await addActiveMember(h.id, other.id);
      await insertNotification(h.id, other.id);

      const res = await ctx.request.get(`/api/households/${h.id}/notifications`).set("cookie", owner.cookie);
      expect(res.body.data).toHaveLength(0);
    });

    it("404s for a non-member", async () => {
      const owner = await signupUser(ctx);
      const h = await createHousehold(ctx, owner.cookie);
      const stranger = await signupUser(ctx);
      const res = await ctx.request.get(`/api/households/${h.id}/notifications`).set("cookie", stranger.cookie);
      expect(res.status).toBe(404);
    });
  });

  describe("GET /notifications/unread-count", () => {
    it("counts only notifications with both readAt and dismissedAt null", async () => {
      const owner = await signupUser(ctx);
      const h = await createHousehold(ctx, owner.cookie);
      await insertNotification(h.id, owner.id);
      await insertNotification(h.id, owner.id);
      await insertNotification(h.id, owner.id, { readAt: ctx.clock.now() });
      await insertNotification(h.id, owner.id, { dismissedAt: ctx.clock.now() });

      const res = await ctx.request.get(`/api/households/${h.id}/notifications/unread-count`).set("cookie", owner.cookie);
      expect(res.status).toBe(200);
      expect(res.body.data).toEqual({ count: 2 });
    });
  });

  describe("PATCH /notifications/:id", () => {
    it("marks a notification read, idempotently", async () => {
      const owner = await signupUser(ctx);
      const h = await createHousehold(ctx, owner.cookie);
      const n = await insertNotification(h.id, owner.id);

      const res1 = await ctx.request.patch(`/api/households/${h.id}/notifications/${n.id}`).set(csrf).set("cookie", owner.cookie).send({ action: "read" });
      expect(res1.status).toBe(200);
      expect(res1.body.data.readAt).not.toBeNull();

      const res2 = await ctx.request.patch(`/api/households/${h.id}/notifications/${n.id}`).set(csrf).set("cookie", owner.cookie).send({ action: "read" });
      expect(res2.status).toBe(200);
      expect(res2.body.data.readAt).toBe(res1.body.data.readAt);
    });

    it("marks a notification dismissed", async () => {
      const owner = await signupUser(ctx);
      const h = await createHousehold(ctx, owner.cookie);
      const n = await insertNotification(h.id, owner.id);

      const res = await ctx.request.patch(`/api/households/${h.id}/notifications/${n.id}`).set(csrf).set("cookie", owner.cookie).send({ action: "dismiss" });
      expect(res.status).toBe(200);
      expect(res.body.data.dismissedAt).not.toBeNull();

      const list = await ctx.request.get(`/api/households/${h.id}/notifications`).set("cookie", owner.cookie);
      expect(list.body.data).toHaveLength(0);
    });

    it("404s for another user's notification, even in the same household", async () => {
      const owner = await signupUser(ctx);
      const h = await createHousehold(ctx, owner.cookie);
      const other = await signupUser(ctx);
      await addActiveMember(h.id, other.id);
      const n = await insertNotification(h.id, other.id);

      const res = await ctx.request.patch(`/api/households/${h.id}/notifications/${n.id}`).set(csrf).set("cookie", owner.cookie).send({ action: "read" });
      expect(res.status).toBe(404);
    });
  });

  describe("POST /notifications/mark-all-read", () => {
    it("marks every unread, non-dismissed notification read for the caller only", async () => {
      const owner = await signupUser(ctx);
      const h = await createHousehold(ctx, owner.cookie);
      const other = await signupUser(ctx);
      await addActiveMember(h.id, other.id);
      const a = await insertNotification(h.id, owner.id);
      const b = await insertNotification(h.id, owner.id, { dismissedAt: ctx.clock.now() });
      const c = await insertNotification(h.id, other.id);

      const res = await ctx.request.post(`/api/households/${h.id}/notifications/mark-all-read`).set(csrf).set("cookie", owner.cookie);
      expect(res.status).toBe(200);

      const rows = await ctx.db.select().from(notifications).where(eq(notifications.householdId, h.id));
      expect(rows.find((r) => r.id === a.id)!.readAt).not.toBeNull();
      expect(rows.find((r) => r.id === b.id)!.readAt).toBeNull(); // dismissed rows aren't touched
      expect(rows.find((r) => r.id === c.id)!.readAt).toBeNull(); // another user's row untouched
    });
  });
});
