import { and, count, desc, eq, isNull } from "drizzle-orm";
import type { NotificationActionInput, NotificationDTO } from "@household/shared";
import { notifications } from "../db/schema.js";
import { Errors } from "../lib/errors.js";
import { resolveLinkPath } from "./notification-link.js";
import type { Deps } from "./deps.js";
import type { Membership } from "./household.service.js";

type NotificationRow = typeof notifications.$inferSelect;

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
