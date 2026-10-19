import { and, asc, eq, isNull } from "drizzle-orm";
import { notificationDeliveries, notifications, pushSubscriptions } from "../db/schema.js";
import { resolveLinkPath } from "../services/notification-link.js";
import { PushSendError } from "../services/push/push.provider.js";
import type { Deps } from "../services/deps.js";

const MAX_ATTEMPTS = 3;
const BATCH_LIMIT = 100;

type DeliveryRow = {
  deliveryId: string; attempts: number; notificationId: string; notificationTitle: string; notificationBody: string | null;
  userId: string; entityType: string | null; entityId: string | null;
};

const SELECT_COLUMNS = {
  deliveryId: notificationDeliveries.id,
  attempts: notificationDeliveries.attempts,
  notificationId: notificationDeliveries.notificationId,
  notificationTitle: notifications.title,
  notificationBody: notifications.body,
  userId: notifications.userId,
  entityType: notifications.entityType,
  entityId: notifications.entityId,
};

/**
 * Fans one WEB_PUSH delivery row out to every active (non-revoked) subscription for that
 * notification's user — notification_deliveries has one WEB_PUSH row per notification (unique on
 * notificationId+channel), not per device, so multi-device delivery happens here rather than at
 * the row level. A subscription the push service reports as gone (404/410, surfaced as
 * PushSendError) is revoked rather than retried — that's device churn, not a send failure. Known
 * simplification: push_subscriptions has no per-subscription attempts column, so a hard failure on
 * one specific device among several isn't retried per-device. If at least one other device
 * succeeded, the delivery is marked SENT and the hard failure is NOT recorded anywhere — neither
 * attempts nor lastError is written — it is silently discarded. Only a hard failure with ZERO
 * successes across all devices gets recorded in lastError (and retried, up to MAX_ATTEMPTS).
 * Acceptable for a personal-household app.
 */
async function processDelivery(deps: Deps, row: DeliveryRow): Promise<void> {
  const subs = await deps.db.select().from(pushSubscriptions)
    .where(and(eq(pushSubscriptions.userId, row.userId), isNull(pushSubscriptions.revokedAt)));

  if (subs.length === 0) {
    await deps.db.update(notificationDeliveries).set({ status: "SKIPPED" }).where(eq(notificationDeliveries.id, row.deliveryId));
    return;
  }

  const linkPath = await resolveLinkPath(deps, { entityType: row.entityType, entityId: row.entityId });
  const payload = { title: row.notificationTitle, body: row.notificationBody ?? row.notificationTitle, tag: `reminder-${row.notificationId}`, linkPath };

  let successCount = 0;
  let hardFailure: string | null = null;
  for (const sub of subs) {
    try {
      await deps.push.send({ endpoint: sub.endpoint, p256dh: sub.p256dh, auth: sub.auth }, payload);
      successCount += 1;
      await deps.db.update(pushSubscriptions).set({ lastUsedAt: deps.clock.now() }).where(eq(pushSubscriptions.id, sub.id));
    } catch (err) {
      if (err instanceof PushSendError) {
        await deps.db.update(pushSubscriptions).set({ revokedAt: deps.clock.now() }).where(eq(pushSubscriptions.id, sub.id));
      } else {
        hardFailure = String(err);
      }
    }
  }

  if (successCount > 0) {
    await deps.db.update(notificationDeliveries).set({ status: "SENT", sentAt: deps.clock.now() }).where(eq(notificationDeliveries.id, row.deliveryId));
  } else if (!hardFailure) {
    await deps.db.update(notificationDeliveries).set({ status: "SKIPPED" }).where(eq(notificationDeliveries.id, row.deliveryId));
  } else {
    const attempts = row.attempts + 1;
    await deps.db.update(notificationDeliveries)
      .set({ attempts, lastError: hardFailure, status: attempts >= MAX_ATTEMPTS ? "FAILED" : "PENDING" })
      .where(eq(notificationDeliveries.id, row.deliveryId));
  }
}

/** Every 5 minutes: finds PENDING WEB_PUSH deliveries (written by evaluate-reminders.job.ts, never
 *  consumed until this job) and dispatches each. Per-row try/catch, same per-item-isolation
 *  approach as dispatch-email-deliveries.job.ts. */
export async function runDispatchWebPushDeliveries(deps: Deps): Promise<void> {
  const rows = await deps.db.select(SELECT_COLUMNS).from(notificationDeliveries)
    .innerJoin(notifications, eq(notifications.id, notificationDeliveries.notificationId))
    .where(and(eq(notificationDeliveries.channel, "WEB_PUSH"), eq(notificationDeliveries.status, "PENDING")))
    .orderBy(asc(notificationDeliveries.createdAt))
    .limit(BATCH_LIMIT);

  for (const row of rows) {
    try {
      await processDelivery(deps, row);
    } catch (err) {
      const attempts = row.attempts + 1;
      await deps.db.update(notificationDeliveries)
        .set({ attempts, lastError: String(err), status: attempts >= MAX_ATTEMPTS ? "FAILED" : "PENDING" })
        .where(eq(notificationDeliveries.id, row.deliveryId));
    }
  }
}

/** Used by the "send test notification" endpoint for instant feedback instead of waiting up to 5
 *  minutes for the next scheduled tick — same per-row logic as the batch job, for one delivery id. */
export async function dispatchSingleWebPushDelivery(deps: Deps, deliveryId: string): Promise<void> {
  const [row] = await deps.db.select(SELECT_COLUMNS).from(notificationDeliveries)
    .innerJoin(notifications, eq(notifications.id, notificationDeliveries.notificationId))
    .where(eq(notificationDeliveries.id, deliveryId));
  if (row) await processDelivery(deps, row);
}
