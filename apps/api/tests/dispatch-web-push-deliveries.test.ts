import { eq } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { notificationDeliveries, notifications, pushSubscriptions } from "../src/db/schema.js";
import { dispatchSingleWebPushDelivery, runDispatchWebPushDeliveries } from "../src/jobs/dispatch-web-push-deliveries.job.js";
import { MemoryPushProvider } from "../src/services/push/push.provider.js";
import { createTestContext, csrf, signupUser, truncateAll, type TestContext } from "./helpers.js";

const ctx = createTestContext();

// ctx is created once for the whole file, and MemoryPushProvider keeps its `.sent` array and
// `failNext` state forever (same long-lived-fixture tradeoff as MemoryEmailProvider — see
// dispatch-email-deliveries.test.ts, which avoids the issue by asserting with .find() instead of
// exact counts/indices). This suite's assertions genuinely need per-test isolation (exact
// `.sent` lengths, `.sent[0]`, and `failNext` not leaking across shared endpoints like
// "https://push.example/a"), so swap in a fresh provider every test rather than rewriting every
// assertion to work around a shared fixture.
beforeEach(async () => {
  await truncateAll(ctx.db);
  ctx.push = new MemoryPushProvider();
  ctx.deps.push = ctx.push;
});
afterAll(() => ctx.close());

async function createHousehold(c: TestContext, cookie: string) {
  const res = await c.request.post("/api/households").set(csrf).set("cookie", cookie).send({ name: "Shah Family" });
  expect(res.status).toBe(201);
  return res.body.data as { id: string };
}

let seq = 0;
async function insertDelivery(householdId: string, userId: string, overrides: Record<string, unknown> = {}) {
  seq += 1;
  const [notification] = await ctx.db.insert(notifications).values({
    householdId, userId, category: "BILL", title: `Electricity due in 7 day(s) #${seq}`,
    idempotencyKey: `test-push-key-${seq}`,
  }).returning();
  const [delivery] = await ctx.db.insert(notificationDeliveries).values({
    householdId, notificationId: notification!.id, channel: "WEB_PUSH", status: "PENDING", ...overrides,
  }).returning();
  return { notification: notification!, delivery: delivery! };
}

async function addSubscription(userId: string, endpoint: string) {
  await ctx.db.insert(pushSubscriptions).values({ userId, endpoint, p256dh: "p", auth: "a" });
}

describe("runDispatchWebPushDeliveries", () => {
  it("sends to a single active subscription and marks the delivery SENT", async () => {
    const owner = await signupUser(ctx);
    const h = await createHousehold(ctx, owner.cookie);
    await addSubscription(owner.id, "https://push.example/a");
    const { delivery } = await insertDelivery(h.id, owner.id);

    await runDispatchWebPushDeliveries(ctx.deps);

    const [updated] = await ctx.db.select().from(notificationDeliveries).where(eq(notificationDeliveries.id, delivery.id));
    expect(updated!.status).toBe("SENT");
    expect(updated!.sentAt).not.toBeNull();
    expect(ctx.push.sent).toHaveLength(1);
    const [sub] = await ctx.db.select().from(pushSubscriptions).where(eq(pushSubscriptions.endpoint, "https://push.example/a"));
    expect(sub!.lastUsedAt).not.toBeNull();
  });

  it("skips a delivery for a user with no active subscriptions", async () => {
    const owner = await signupUser(ctx);
    const h = await createHousehold(ctx, owner.cookie);
    const { delivery } = await insertDelivery(h.id, owner.id);

    await runDispatchWebPushDeliveries(ctx.deps);

    const [updated] = await ctx.db.select().from(notificationDeliveries).where(eq(notificationDeliveries.id, delivery.id));
    expect(updated!.status).toBe("SKIPPED");
    expect(ctx.push.sent).toHaveLength(0);
  });

  it("revokes an expired subscription but still marks the delivery SENT via the other device", async () => {
    const owner = await signupUser(ctx);
    const h = await createHousehold(ctx, owner.cookie);
    await addSubscription(owner.id, "https://push.example/dead");
    await addSubscription(owner.id, "https://push.example/alive");
    ctx.push.failNext("https://push.example/dead", "expired");
    const { delivery } = await insertDelivery(h.id, owner.id);

    await runDispatchWebPushDeliveries(ctx.deps);

    const [updated] = await ctx.db.select().from(notificationDeliveries).where(eq(notificationDeliveries.id, delivery.id));
    expect(updated!.status).toBe("SENT");
    const [dead] = await ctx.db.select().from(pushSubscriptions).where(eq(pushSubscriptions.endpoint, "https://push.example/dead"));
    expect(dead!.revokedAt).not.toBeNull();
    const [alive] = await ctx.db.select().from(pushSubscriptions).where(eq(pushSubscriptions.endpoint, "https://push.example/alive"));
    expect(alive!.revokedAt).toBeNull();
  });

  it("marks the delivery SKIPPED (not FAILED) when the only subscription turns out expired", async () => {
    const owner = await signupUser(ctx);
    const h = await createHousehold(ctx, owner.cookie);
    await addSubscription(owner.id, "https://push.example/only");
    ctx.push.failNext("https://push.example/only", "expired");
    const { delivery } = await insertDelivery(h.id, owner.id);

    await runDispatchWebPushDeliveries(ctx.deps);

    const [updated] = await ctx.db.select().from(notificationDeliveries).where(eq(notificationDeliveries.id, delivery.id));
    expect(updated!.status).toBe("SKIPPED");
    const [sub] = await ctx.db.select().from(pushSubscriptions).where(eq(pushSubscriptions.endpoint, "https://push.example/only"));
    expect(sub!.revokedAt).not.toBeNull();
  });

  it("increments attempts and records lastError on a generic failure, staying PENDING under 3 attempts", async () => {
    const owner = await signupUser(ctx);
    const h = await createHousehold(ctx, owner.cookie);
    await addSubscription(owner.id, "https://push.example/a");
    ctx.push.failNext("https://push.example/a", "error");
    const { delivery } = await insertDelivery(h.id, owner.id);

    await runDispatchWebPushDeliveries(ctx.deps);

    const [updated] = await ctx.db.select().from(notificationDeliveries).where(eq(notificationDeliveries.id, delivery.id));
    expect(updated!.status).toBe("PENDING");
    expect(updated!.attempts).toBe(1);
    expect(updated!.lastError).toContain("push send failed");
  });

  it("marks FAILED on the 3rd consecutive failure", async () => {
    const owner = await signupUser(ctx);
    const h = await createHousehold(ctx, owner.cookie);
    await addSubscription(owner.id, "https://push.example/a");
    ctx.push.failNext("https://push.example/a", "error");
    const { delivery } = await insertDelivery(h.id, owner.id, { attempts: 2 });

    await runDispatchWebPushDeliveries(ctx.deps);

    const [updated] = await ctx.db.select().from(notificationDeliveries).where(eq(notificationDeliveries.id, delivery.id));
    expect(updated!.status).toBe("FAILED");
    expect(updated!.attempts).toBe(3);
  });

  it("resolves a SALARY notification's linkPath directly from entityId", async () => {
    const owner = await signupUser(ctx);
    const h = await createHousehold(ctx, owner.cookie);
    await addSubscription(owner.id, "https://push.example/a");
    const [notification] = await ctx.db.insert(notifications).values({
      householdId: h.id, userId: owner.id, category: "SALARY", title: "Salary due",
      entityType: "salary_settlement", entityId: "11111111-1111-1111-1111-111111111111",
      idempotencyKey: "test-push-salary-1",
    }).returning();
    await ctx.db.insert(notificationDeliveries).values({
      householdId: h.id, notificationId: notification!.id, channel: "WEB_PUSH", status: "PENDING",
    });

    await runDispatchWebPushDeliveries(ctx.deps);

    expect(ctx.push.sent[0]!.payload.linkPath).toBe("/salary/11111111-1111-1111-1111-111111111111");
  });

  it("never touches non-WEB_PUSH or non-PENDING rows", async () => {
    const owner = await signupUser(ctx);
    const h = await createHousehold(ctx, owner.cookie);
    await addSubscription(owner.id, "https://push.example/a");
    const { delivery: alreadySent } = await insertDelivery(h.id, owner.id, { status: "SENT", sentAt: ctx.clock.now() });
    const { delivery: email } = await insertDelivery(h.id, owner.id, { channel: "EMAIL", status: "PENDING" });

    await runDispatchWebPushDeliveries(ctx.deps);

    expect(ctx.push.sent).toHaveLength(0);
    const [sentRow] = await ctx.db.select().from(notificationDeliveries).where(eq(notificationDeliveries.id, alreadySent.id));
    const [emailRow] = await ctx.db.select().from(notificationDeliveries).where(eq(notificationDeliveries.id, email.id));
    expect(sentRow!.status).toBe("SENT");
    expect(emailRow!.status).toBe("PENDING");
  });

  it("caps how many rows it processes in a single run", async () => {
    const owner = await signupUser(ctx);
    const h = await createHousehold(ctx, owner.cookie);
    await addSubscription(owner.id, "https://push.example/a");
    for (let i = 0; i < 101; i++) await insertDelivery(h.id, owner.id);

    await runDispatchWebPushDeliveries(ctx.deps);

    const rows = await ctx.db.select().from(notificationDeliveries).where(eq(notificationDeliveries.householdId, h.id));
    const stillPending = rows.filter((r) => r.status === "PENDING").length;
    expect(stillPending).toBeGreaterThan(0);
  });
});

describe("dispatchSingleWebPushDelivery", () => {
  it("dispatches exactly the given delivery id", async () => {
    const owner = await signupUser(ctx);
    const h = await createHousehold(ctx, owner.cookie);
    await addSubscription(owner.id, "https://push.example/a");
    const { delivery } = await insertDelivery(h.id, owner.id);

    await dispatchSingleWebPushDelivery(ctx.deps, delivery.id);

    const [updated] = await ctx.db.select().from(notificationDeliveries).where(eq(notificationDeliveries.id, delivery.id));
    expect(updated!.status).toBe("SENT");
  });
});
