import { and, count, desc, eq, isNull } from "drizzle-orm";
import type { NotificationActionInput, NotificationDTO } from "@household/shared";
import { billOccurrences, notifications } from "../db/schema.js";
import { Errors } from "../lib/errors.js";
import type { Deps } from "./deps.js";
import type { Membership } from "./household.service.js";

type NotificationRow = typeof notifications.$inferSelect;

/**
 * BILL notifications store the bill OCCURRENCE id as entityId (set by evaluate-reminders.job.ts),
 * but the only bill detail route is /bills/:billId. Resolved here, at read time, rather than
 * touching the job's write-time shape or adding a migration — a SALARY row's entityId already IS
 * the settlement id the /salary/:id route expects, so it passes through unchanged.
 */
async function resolveLinkPath(deps: Deps, row: NotificationRow): Promise<string | null> {
  if (row.entityType === "bill_occurrence" && row.entityId) {
    const [occ] = await deps.db.select({ billId: billOccurrences.billId }).from(billOccurrences).where(eq(billOccurrences.id, row.entityId));
    return occ ? `/bills/${occ.billId}` : null;
  }
  if (row.entityType === "salary_settlement" && row.entityId) {
    return `/salary/${row.entityId}`;
  }
  return null;
}

async function toNotificationDTO(deps: Deps, row: NotificationRow): Promise<NotificationDTO> {
  return {
    id: row.id, category: row.category, severity: row.severity,
    title: row.title, body: row.body, linkPath: await resolveLinkPath(deps, row),
    readAt: row.readAt?.toISOString() ?? null, dismissedAt: row.dismissedAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
  };
}

export async function listNotifications(deps: Deps, userId: string, membership: Membership): Promise<NotificationDTO[]> {
  const rows = await deps.db.select().from(notifications)
    .where(and(eq(notifications.userId, userId), eq(notifications.householdId, membership.householdId), isNull(notifications.dismissedAt)))
    .orderBy(desc(notifications.createdAt))
    .limit(50);
  return Promise.all(rows.map((row) => toNotificationDTO(deps, row)));
}

export async function getUnreadCount(deps: Deps, userId: string, membership: Membership): Promise<number> {
  const [{ n } = { n: 0 }] = await deps.db.select({ n: count() }).from(notifications)
    .where(and(eq(notifications.userId, userId), eq(notifications.householdId, membership.householdId), isNull(notifications.readAt), isNull(notifications.dismissedAt)));
  return Number(n);
}

export async function markNotification(
  deps: Deps, userId: string, membership: Membership, notificationId: string, action: NotificationActionInput["action"],
): Promise<NotificationDTO> {
  const [row] = await deps.db.select().from(notifications)
    .where(and(eq(notifications.userId, userId), eq(notifications.householdId, membership.householdId), eq(notifications.id, notificationId)));
  if (!row) throw Errors.notFound("Notification");

  if (action === "read" && !row.readAt) {
    await deps.db.update(notifications).set({ readAt: new Date() }).where(eq(notifications.id, notificationId));
  } else if (action === "dismiss" && !row.dismissedAt) {
    await deps.db.update(notifications).set({ dismissedAt: new Date() }).where(eq(notifications.id, notificationId));
  }
  const [updated] = await deps.db.select().from(notifications).where(eq(notifications.id, notificationId));
  return toNotificationDTO(deps, updated!);
}

export async function markAllRead(deps: Deps, userId: string, membership: Membership): Promise<void> {
  await deps.db.update(notifications).set({ readAt: new Date() })
    .where(and(eq(notifications.userId, userId), eq(notifications.householdId, membership.householdId), isNull(notifications.readAt), isNull(notifications.dismissedAt)));
}
