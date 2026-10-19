import { and, eq } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { householdMembers, notificationPreferences } from "../src/db/schema.js";
import { createTestContext, csrf, signupUser, truncateAll, type TestContext } from "./helpers.js";

const ctx = createTestContext();

beforeEach(async () => { await truncateAll(ctx.db); });
afterAll(() => ctx.close());

async function createHousehold(c: TestContext, cookie: string) {
  const res = await c.request.post("/api/households").set(csrf).set("cookie", cookie).send({ name: "Shah Family" });
  expect(res.status).toBe(201);
  return res.body.data as { id: string };
}

async function addActiveMember(householdId: string, userId: string) {
  await ctx.db.insert(householdMembers).values({ householdId, userId, role: "MEMBER", status: "ACTIVE" });
}

describe("notification preferences", () => {
  describe("GET /notification-preferences", () => {
    it("returns default enabled/no-email for a member with no seeded row", async () => {
      const owner = await signupUser(ctx);
      const h = await createHousehold(ctx, owner.cookie);
      const other = await signupUser(ctx);
      await addActiveMember(h.id, other.id);

      const res = await ctx.request.get(`/api/households/${h.id}/notification-preferences`).set("cookie", other.cookie);
      expect(res.status).toBe(200);
      expect(res.body.data).toEqual([
        { category: "BILL", enabled: true, emailEnabled: false, pushEnabled: true },
        { category: "SALARY", enabled: true, emailEnabled: false, pushEnabled: true },
      ]);
    });

    it("returns real stored values for a category with a row", async () => {
      const owner = await signupUser(ctx);
      const h = await createHousehold(ctx, owner.cookie);
      await ctx.db.update(notificationPreferences)
        .set({ enabled: false, channels: ["IN_APP", "WEB_PUSH", "EMAIL"] })
        .where(and(eq(notificationPreferences.householdId, h.id), eq(notificationPreferences.userId, owner.id), eq(notificationPreferences.category, "BILL")));

      const res = await ctx.request.get(`/api/households/${h.id}/notification-preferences`).set("cookie", owner.cookie);
      const bill = res.body.data.find((p: { category: string }) => p.category === "BILL");
      expect(bill).toEqual({ category: "BILL", enabled: false, emailEnabled: true, pushEnabled: true });
    });

    it("never returns another member's preferences", async () => {
      const owner = await signupUser(ctx);
      const h = await createHousehold(ctx, owner.cookie);
      await ctx.db.update(notificationPreferences)
        .set({ enabled: false })
        .where(and(eq(notificationPreferences.householdId, h.id), eq(notificationPreferences.userId, owner.id), eq(notificationPreferences.category, "SALARY")));
      const other = await signupUser(ctx);
      await addActiveMember(h.id, other.id);

      const res = await ctx.request.get(`/api/households/${h.id}/notification-preferences`).set("cookie", other.cookie);
      const salary = res.body.data.find((p: { category: string }) => p.category === "SALARY");
      expect(salary).toEqual({ category: "SALARY", enabled: true, emailEnabled: false, pushEnabled: true }); // default, not owner's disabled row
    });

    it("404s for a non-member", async () => {
      const owner = await signupUser(ctx);
      const h = await createHousehold(ctx, owner.cookie);
      const stranger = await signupUser(ctx);
      const res = await ctx.request.get(`/api/households/${h.id}/notification-preferences`).set("cookie", stranger.cookie);
      expect(res.status).toBe(404);
    });
  });

  describe("PATCH /notification-preferences/:category", () => {
    it("creates a row on a member's first-ever write, layering the request onto defaults", async () => {
      const owner = await signupUser(ctx);
      const h = await createHousehold(ctx, owner.cookie);
      const other = await signupUser(ctx);
      await addActiveMember(h.id, other.id);

      const res = await ctx.request.patch(`/api/households/${h.id}/notification-preferences/BILL`).set(csrf).set("cookie", other.cookie).send({ emailEnabled: true });
      expect(res.status).toBe(200);
      expect(res.body.data).toEqual({ category: "BILL", enabled: true, emailEnabled: true, pushEnabled: true });

      const [row] = await ctx.db.select().from(notificationPreferences)
        .where(and(eq(notificationPreferences.householdId, h.id), eq(notificationPreferences.userId, other.id), eq(notificationPreferences.category, "BILL")));
      expect(row).toBeDefined();
      expect(row!.channels).toContain("EMAIL");
      expect(row!.channels).toContain("IN_APP");
    });

    it("updates only the given field on an existing row, leaving the other untouched", async () => {
      const owner = await signupUser(ctx);
      const h = await createHousehold(ctx, owner.cookie);

      const first = await ctx.request.patch(`/api/households/${h.id}/notification-preferences/SALARY`).set(csrf).set("cookie", owner.cookie).send({ emailEnabled: true });
      expect(first.body.data).toEqual({ category: "SALARY", enabled: true, emailEnabled: true, pushEnabled: true });

      const second = await ctx.request.patch(`/api/households/${h.id}/notification-preferences/SALARY`).set(csrf).set("cookie", owner.cookie).send({ enabled: false });
      expect(second.body.data).toEqual({ category: "SALARY", enabled: false, emailEnabled: true, pushEnabled: true }); // emailEnabled untouched
    });

    it("round-trips emailEnabled true then false without disturbing IN_APP/WEB_PUSH", async () => {
      const owner = await signupUser(ctx);
      const h = await createHousehold(ctx, owner.cookie);

      await ctx.request.patch(`/api/households/${h.id}/notification-preferences/BILL`).set(csrf).set("cookie", owner.cookie).send({ emailEnabled: true });
      const off = await ctx.request.patch(`/api/households/${h.id}/notification-preferences/BILL`).set(csrf).set("cookie", owner.cookie).send({ emailEnabled: false });
      expect(off.body.data).toEqual({ category: "BILL", enabled: true, emailEnabled: false, pushEnabled: true });

      const [row] = await ctx.db.select().from(notificationPreferences)
        .where(and(eq(notificationPreferences.householdId, h.id), eq(notificationPreferences.userId, owner.id), eq(notificationPreferences.category, "BILL")));
      expect(row!.channels).toEqual(expect.arrayContaining(["IN_APP", "WEB_PUSH"]));
      expect(row!.channels).not.toContain("EMAIL");
    });

    it("400s for a category outside BILL/SALARY", async () => {
      const owner = await signupUser(ctx);
      const h = await createHousehold(ctx, owner.cookie);
      const res = await ctx.request.patch(`/api/households/${h.id}/notification-preferences/ATTENDANCE`).set(csrf).set("cookie", owner.cookie).send({ enabled: false });
      expect(res.status).toBe(400);
    });

    it("never writes another member's preferences", async () => {
      const owner = await signupUser(ctx);
      const h = await createHousehold(ctx, owner.cookie);
      const other = await signupUser(ctx);
      await addActiveMember(h.id, other.id);

      await ctx.request.patch(`/api/households/${h.id}/notification-preferences/BILL`).set(csrf).set("cookie", other.cookie).send({ enabled: false });

      const [ownerRow] = await ctx.db.select().from(notificationPreferences)
        .where(and(eq(notificationPreferences.householdId, h.id), eq(notificationPreferences.userId, owner.id), eq(notificationPreferences.category, "BILL")));
      expect(ownerRow!.enabled).toBe(true); // untouched — only `other`'s row was created/changed
    });

    it("round-trips pushEnabled true then false without disturbing IN_APP/EMAIL", async () => {
      const owner = await signupUser(ctx);
      const h = await createHousehold(ctx, owner.cookie);

      await ctx.request.patch(`/api/households/${h.id}/notification-preferences/BILL`).set(csrf).set("cookie", owner.cookie).send({ pushEnabled: false });
      const row1 = await ctx.db.select().from(notificationPreferences)
        .where(and(eq(notificationPreferences.householdId, h.id), eq(notificationPreferences.userId, owner.id), eq(notificationPreferences.category, "BILL")));
      expect(row1[0]!.channels).toEqual(expect.arrayContaining(["IN_APP"]));
      expect(row1[0]!.channels).not.toContain("WEB_PUSH");

      const on = await ctx.request.patch(`/api/households/${h.id}/notification-preferences/BILL`).set(csrf).set("cookie", owner.cookie).send({ pushEnabled: true });
      expect(on.body.data).toEqual({ category: "BILL", enabled: true, emailEnabled: false, pushEnabled: true });
    });

    it("a single PATCH can set both emailEnabled and pushEnabled", async () => {
      const owner = await signupUser(ctx);
      const h = await createHousehold(ctx, owner.cookie);

      const res = await ctx.request.patch(`/api/households/${h.id}/notification-preferences/SALARY`).set(csrf).set("cookie", owner.cookie)
        .send({ emailEnabled: true, pushEnabled: false });

      expect(res.body.data).toEqual({ category: "SALARY", enabled: true, emailEnabled: true, pushEnabled: false });
    });
  });
});
