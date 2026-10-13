import { and, asc, eq } from "drizzle-orm";
import { notificationDeliveries, notifications, users } from "../db/schema.js";
import type { Deps } from "../services/deps.js";

const MAX_ATTEMPTS = 3;
const BATCH_LIMIT = 100;

/**
 * Every 5 minutes: finds PENDING EMAIL deliveries (written by evaluate-reminders.job.ts, never
 * consumed until this job), sends each via deps.email, and updates its status. Each row is
 * processed in its own try/catch — a single bad row (provider error, anything) must not prevent
 * the rest of the batch from being processed, the same per-item-isolation lesson learned the hard
 * way in evaluate-reminders.job.ts's own review loop. A dangling delivery whose notification or
 * user row no longer exists can't happen — both FKs cascade-delete — so the inner joins below
 * naturally exclude that impossible case without needing explicit handling.
 */
export async function runDispatchEmailDeliveries(deps: Deps): Promise<void> {
  const rows = await deps.db.select({
    deliveryId: notificationDeliveries.id,
    attempts: notificationDeliveries.attempts,
    notificationTitle: notifications.title,
    notificationBody: notifications.body,
    userEmail: users.email,
    userEmailVerifiedAt: users.emailVerifiedAt,
  }).from(notificationDeliveries)
    .innerJoin(notifications, eq(notifications.id, notificationDeliveries.notificationId))
    .innerJoin(users, eq(users.id, notifications.userId))
    .where(and(eq(notificationDeliveries.channel, "EMAIL"), eq(notificationDeliveries.status, "PENDING")))
    .orderBy(asc(notificationDeliveries.createdAt))
    .limit(BATCH_LIMIT);

  for (const row of rows) {
    try {
      if (!row.userEmailVerifiedAt) {
        await deps.db.update(notificationDeliveries).set({ status: "SKIPPED" }).where(eq(notificationDeliveries.id, row.deliveryId));
        continue;
      }
      await deps.email.send({
        to: row.userEmail, subject: row.notificationTitle, text: row.notificationBody ?? row.notificationTitle, tag: "reminder-notification",
      });
      await deps.db.update(notificationDeliveries).set({ status: "SENT", sentAt: deps.clock.now() }).where(eq(notificationDeliveries.id, row.deliveryId));
    } catch (err) {
      const attempts = row.attempts + 1;
      await deps.db.update(notificationDeliveries)
        .set({ attempts, lastError: String(err), status: attempts >= MAX_ATTEMPTS ? "FAILED" : "PENDING" })
        .where(eq(notificationDeliveries.id, row.deliveryId));
    }
  }
}
