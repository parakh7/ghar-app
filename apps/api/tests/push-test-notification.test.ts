import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { pushSubscriptions } from "../src/db/schema.js";
import { createTestContext, csrf, signupUser, truncateAll } from "./helpers.js";

const ctx = createTestContext();

beforeEach(async () => { await truncateAll(ctx.db); });
afterAll(() => ctx.close());

async function createHousehold(cookie: string) {
  const res = await ctx.request.post("/api/households").set(csrf).set("cookie", cookie).send({ name: "Shah Family" });
  expect(res.status).toBe(201);
  return res.body.data as { id: string };
}

describe("POST /:householdId/notifications/test-push", () => {
  it("sends a real test push when the user has an active subscription", async () => {
    const owner = await signupUser(ctx);
    const h = await createHousehold(owner.cookie);
    await ctx.db.insert(pushSubscriptions).values({ userId: owner.id, endpoint: "https://push.example/abc", p256dh: "p", auth: "a" });

    const res = await ctx.request.post(`/api/households/${h.id}/notifications/test-push`).set(csrf).set("cookie", owner.cookie);

    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({ delivered: true });
    expect(ctx.push.sent).toHaveLength(1);
    expect(ctx.push.sent[0]!.payload.title).toBe("Test notification");
  });

  it("reports no-active-devices when the user has no subscription", async () => {
    const owner = await signupUser(ctx);
    const h = await createHousehold(owner.cookie);

    const res = await ctx.request.post(`/api/households/${h.id}/notifications/test-push`).set(csrf).set("cookie", owner.cookie);

    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({ delivered: false, reason: "no-active-devices" });
  });

  it("404s for a non-member", async () => {
    const owner = await signupUser(ctx);
    const h = await createHousehold(owner.cookie);
    const stranger = await signupUser(ctx);
    const res = await ctx.request.post(`/api/households/${h.id}/notifications/test-push`).set(csrf).set("cookie", stranger.cookie);
    expect(res.status).toBe(404);
  });
});
