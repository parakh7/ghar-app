import { eq } from "drizzle-orm";
import { notificationDeliveries, notifications } from "../../db/schema.js";
import { dispatchSingleWebPushDelivery } from "../../jobs/dispatch-web-push-deliveries.job.js";
import type { Deps } from "../deps.js";
import type { Membership } from "../household.service.js";

export type TestPushResult = { delivered: boolean; reason?: "no-active-devices" | "send-failed" };

/** An explicit user action, not a reminder — bypasses notification_preferences entirely, the same
 *  way "mark all read" isn't preference-gated either. */
export async function sendTestPushNotification(deps: Deps, userId: string, membership: Membership): Promise<TestPushResult> {
  const [notification] = await deps.db.insert(notifications).values({
    householdId: membership.householdId, userId, category: "SYSTEM",
    title: "Test notification", body: "If you can see this, push notifications are working on this device.",
    idempotencyKey: `test-push:${userId}:${deps.clock.now().getTime()}`,
  }).returning();

  const [delivery] = await deps.db.insert(notificationDeliveries).values({
    householdId: membership.householdId, notificationId: notification!.id, channel: "WEB_PUSH", status: "PENDING",
  }).returning();

  await dispatchSingleWebPushDelivery(deps, delivery!.id);

  const [updated] = await deps.db.select().from(notificationDeliveries).where(eq(notificationDeliveries.id, delivery!.id));
  if (updated!.status === "SENT") return { delivered: true };
  if (updated!.status === "SKIPPED") return { delivered: false, reason: "no-active-devices" };
  return { delivered: false, reason: "send-failed" };
}
