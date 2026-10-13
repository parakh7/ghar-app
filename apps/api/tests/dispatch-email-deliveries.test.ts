import { eq } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import type { EmailProvider } from "../src/services/email/email.provider.js";
import { householdMembers, notificationDeliveries, notifications, users } from "../src/db/schema.js";
import { runDispatchEmailDeliveries } from "../src/jobs/dispatch-email-deliveries.job.js";
import { createTestContext, csrf, signupUser, truncateAll, type TestContext } from "./helpers.js";

const ctx = createTestContext();

beforeEach(async () => { await truncateAll(ctx.db); });
afterAll(() => ctx.close());

class ThrowingEmailProvider implements EmailProvider {
  async send(): Promise<void> { throw new Error("smtp down"); }
}

async function createHousehold(c: TestContext, cookie: string) {
  const res = await c.request.post("/api/households").set(csrf).set("cookie", cookie).send({ name: "Shah Family" });
  expect(res.status).toBe(201);
  return res.body.data as { id: string };
}

async function verifyUser(userId: string) {
  await ctx.db.update(users).set({ emailVerifiedAt: ctx.clock.now() }).where(eq(users.id, userId));
}

async function addActiveMember(householdId: string, userId: string) {
  await ctx.db.insert(householdMembers).values({ householdId, userId, role: "MEMBER", status: "ACTIVE" });
}

let seq = 0;
async function insertDelivery(householdId: string, userId: string, overrides: Record<string, unknown> = {}) {
  seq += 1;
  const [notification] = await ctx.db.insert(notifications).values({
    householdId, userId, category: "BILL", title: `Electricity due in 7 day(s) #${seq}`,
    idempotencyKey: `test-key-${seq}`,
  }).returning();
  const [delivery] = await ctx.db.insert(notificationDeliveries).values({
    householdId, notificationId: notification!.id, channel: "EMAIL", status: "PENDING", ...overrides,
  }).returning();
  return { notification: notification!, delivery: delivery! };
}

describe("runDispatchEmailDeliveries", () => {
  it("sends a PENDING EMAIL delivery for a verified user and marks it SENT", async () => {
    const owner = await signupUser(ctx);
    await verifyUser(owner.id);
    const h = await createHousehold(ctx, owner.cookie);
    const { notification, delivery } = await insertDelivery(h.id, owner.id);

    await runDispatchEmailDeliveries(ctx.deps);

    const [updated] = await ctx.db.select().from(notificationDeliveries).where(eq(notificationDeliveries.id, delivery.id));
    expect(updated!.status).toBe("SENT");
    expect(updated!.sentAt).not.toBeNull();
    const sent = ctx.email.sent.find((m) => m.to === owner.email && m.tag === "reminder-notification");
    expect(sent).toMatchObject({ subject: notification.title, tag: "reminder-notification" });
  });

  it("skips an unverified user's delivery without attempting to send", async () => {
    const owner = await signupUser(ctx); // not verified
    const h = await createHousehold(ctx, owner.cookie);
    const { delivery } = await insertDelivery(h.id, owner.id);

    await runDispatchEmailDeliveries(ctx.deps);

    const [updated] = await ctx.db.select().from(notificationDeliveries).where(eq(notificationDeliveries.id, delivery.id));
    expect(updated!.status).toBe("SKIPPED");
    expect(ctx.email.sent.find((m) => m.to === owner.email && m.tag === "reminder-notification")).toBeUndefined();
  });

  it("increments attempts and records lastError on failure, staying PENDING under 3 attempts", async () => {
    const owner = await signupUser(ctx);
    await verifyUser(owner.id);
    const h = await createHousehold(ctx, owner.cookie);
    const { delivery } = await insertDelivery(h.id, owner.id);
    const failingDeps = { ...ctx.deps, email: new ThrowingEmailProvider() };

    await runDispatchEmailDeliveries(failingDeps);

    const [updated] = await ctx.db.select().from(notificationDeliveries).where(eq(notificationDeliveries.id, delivery.id));
    expect(updated!.status).toBe("PENDING");
    expect(updated!.attempts).toBe(1);
    expect(updated!.lastError).toContain("smtp down");
  });

  it("marks FAILED on the 3rd consecutive failure", async () => {
    const owner = await signupUser(ctx);
    await verifyUser(owner.id);
    const h = await createHousehold(ctx, owner.cookie);
    const { delivery } = await insertDelivery(h.id, owner.id, { attempts: 2 });
    const failingDeps = { ...ctx.deps, email: new ThrowingEmailProvider() };

    await runDispatchEmailDeliveries(failingDeps);

    const [updated] = await ctx.db.select().from(notificationDeliveries).where(eq(notificationDeliveries.id, delivery.id));
    expect(updated!.status).toBe("FAILED");
    expect(updated!.attempts).toBe(3);
  });

  it("a failing row doesn't block a healthy row in the same run", async () => {
    const owner = await signupUser(ctx);
    await verifyUser(owner.id);
    const h = await createHousehold(ctx, owner.cookie);
    const other = await signupUser(ctx);
    await verifyUser(other.id);
    await addActiveMember(h.id, other.id);

    const failing = await insertDelivery(h.id, owner.id);
    const healthy = await insertDelivery(h.id, other.id);

    const flakyProvider: EmailProvider = {
      async send(message) {
        if (message.to === owner.email) throw new Error("this recipient's send fails");
      },
    };
    await runDispatchEmailDeliveries({ ...ctx.deps, email: flakyProvider });

    const rows = await ctx.db.select().from(notificationDeliveries).where(eq(notificationDeliveries.householdId, h.id));
    const failingRow = rows.find((r) => r.id === failing.delivery.id)!;
    const healthyRow = rows.find((r) => r.id === healthy.delivery.id)!;
    expect(failingRow.status).toBe("PENDING");
    expect(healthyRow.status).toBe("SENT");
  });

  it("never touches non-EMAIL or non-PENDING rows", async () => {
    const owner = await signupUser(ctx);
    await verifyUser(owner.id);
    const h = await createHousehold(ctx, owner.cookie);
    const { delivery: alreadySent } = await insertDelivery(h.id, owner.id, { status: "SENT", sentAt: ctx.clock.now() });
    const { delivery: inApp } = await insertDelivery(h.id, owner.id, { channel: "IN_APP", status: "PENDING" });

    await runDispatchEmailDeliveries(ctx.deps);

    expect(ctx.email.sent.find((m) => m.to === owner.email && m.tag === "reminder-notification")).toBeUndefined();
    const [sentRow] = await ctx.db.select().from(notificationDeliveries).where(eq(notificationDeliveries.id, alreadySent.id));
    const [inAppRow] = await ctx.db.select().from(notificationDeliveries).where(eq(notificationDeliveries.id, inApp.id));
    expect(sentRow!.status).toBe("SENT");
    expect(inAppRow!.status).toBe("PENDING"); // untouched — IN_APP delivery isn't this job's concern
  });

  it("caps how many rows it processes in a single run", async () => {
    const owner = await signupUser(ctx);
    await verifyUser(owner.id);
    const h = await createHousehold(ctx, owner.cookie);
    for (let i = 0; i < 101; i++) await insertDelivery(h.id, owner.id);

    await runDispatchEmailDeliveries(ctx.deps);

    const rows = await ctx.db.select().from(notificationDeliveries).where(eq(notificationDeliveries.householdId, h.id));
    const stillPending = rows.filter((r) => r.status === "PENDING").length;
    expect(stillPending).toBeGreaterThan(0); // the cap left at least one row unprocessed this run
  });
});
