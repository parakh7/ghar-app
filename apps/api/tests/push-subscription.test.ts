import { eq } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { pushSubscriptions } from "../src/db/schema.js";
import { createTestContext, csrf, signupUser, truncateAll } from "./helpers.js";

const ctx = createTestContext();

beforeEach(async () => { await truncateAll(ctx.db); });
afterAll(() => ctx.close());

describe("push subscriptions", () => {
  describe("POST /push-subscriptions", () => {
    it("creates a subscription row for the caller", async () => {
      const user = await signupUser(ctx);
      const res = await ctx.request.post("/api/push-subscriptions").set(csrf).set("cookie", user.cookie)
        .send({ endpoint: "https://push.example/abc", keys: { p256dh: "p1", auth: "a1" } });
      expect(res.status).toBe(201);

      const [row] = await ctx.db.select().from(pushSubscriptions).where(eq(pushSubscriptions.endpoint, "https://push.example/abc"));
      expect(row).toMatchObject({ userId: user.id, p256dh: "p1", auth: "a1", revokedAt: null });
    });

    it("re-subscribing the same endpoint updates it instead of creating a duplicate", async () => {
      const user = await signupUser(ctx);
      await ctx.request.post("/api/push-subscriptions").set(csrf).set("cookie", user.cookie)
        .send({ endpoint: "https://push.example/abc", keys: { p256dh: "p1", auth: "a1" } });
      await ctx.request.post("/api/push-subscriptions").set(csrf).set("cookie", user.cookie)
        .send({ endpoint: "https://push.example/abc", keys: { p256dh: "p2", auth: "a2" } });

      const rows = await ctx.db.select().from(pushSubscriptions).where(eq(pushSubscriptions.endpoint, "https://push.example/abc"));
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ p256dh: "p2", auth: "a2" });
    });

    it("re-subscribing a previously revoked endpoint clears revokedAt", async () => {
      const user = await signupUser(ctx);
      await ctx.request.post("/api/push-subscriptions").set(csrf).set("cookie", user.cookie)
        .send({ endpoint: "https://push.example/abc", keys: { p256dh: "p1", auth: "a1" } });
      await ctx.request.post("/api/push-subscriptions/unsubscribe").set(csrf).set("cookie", user.cookie)
        .send({ endpoint: "https://push.example/abc" });

      await ctx.request.post("/api/push-subscriptions").set(csrf).set("cookie", user.cookie)
        .send({ endpoint: "https://push.example/abc", keys: { p256dh: "p1", auth: "a1" } });

      const [row] = await ctx.db.select().from(pushSubscriptions).where(eq(pushSubscriptions.endpoint, "https://push.example/abc"));
      expect(row!.revokedAt).toBeNull();
    });

    it("401s when not signed in", async () => {
      const res = await ctx.request.post("/api/push-subscriptions").set(csrf)
        .send({ endpoint: "https://push.example/abc", keys: { p256dh: "p1", auth: "a1" } });
      expect(res.status).toBe(401);
    });
  });

  describe("POST /push-subscriptions/unsubscribe", () => {
    it("sets revokedAt on the caller's own subscription", async () => {
      const user = await signupUser(ctx);
      await ctx.request.post("/api/push-subscriptions").set(csrf).set("cookie", user.cookie)
        .send({ endpoint: "https://push.example/abc", keys: { p256dh: "p1", auth: "a1" } });

      const res = await ctx.request.post("/api/push-subscriptions/unsubscribe").set(csrf).set("cookie", user.cookie).send({ endpoint: "https://push.example/abc" });
      expect(res.status).toBe(200);

      const [row] = await ctx.db.select().from(pushSubscriptions).where(eq(pushSubscriptions.endpoint, "https://push.example/abc"));
      expect(row!.revokedAt).not.toBeNull();
    });

    it("is idempotent — unsubscribing twice is not an error", async () => {
      const user = await signupUser(ctx);
      await ctx.request.post("/api/push-subscriptions").set(csrf).set("cookie", user.cookie)
        .send({ endpoint: "https://push.example/abc", keys: { p256dh: "p1", auth: "a1" } });
      await ctx.request.post("/api/push-subscriptions/unsubscribe").set(csrf).set("cookie", user.cookie).send({ endpoint: "https://push.example/abc" });
      const res = await ctx.request.post("/api/push-subscriptions/unsubscribe").set(csrf).set("cookie", user.cookie).send({ endpoint: "https://push.example/abc" });
      expect(res.status).toBe(200);
    });

    it("never revokes another user's subscription", async () => {
      const owner = await signupUser(ctx);
      const other = await signupUser(ctx);
      await ctx.request.post("/api/push-subscriptions").set(csrf).set("cookie", owner.cookie)
        .send({ endpoint: "https://push.example/abc", keys: { p256dh: "p1", auth: "a1" } });

      await ctx.request.post("/api/push-subscriptions/unsubscribe").set(csrf).set("cookie", other.cookie).send({ endpoint: "https://push.example/abc" });

      const [row] = await ctx.db.select().from(pushSubscriptions).where(eq(pushSubscriptions.endpoint, "https://push.example/abc"));
      expect(row!.revokedAt).toBeNull();
    });
  });
});
