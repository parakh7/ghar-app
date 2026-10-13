import { useNavigate } from "react-router-dom";
import { Bell, X } from "lucide-react";
import type { NotificationDTO } from "@household/shared";
import { Button } from "../../components/Button";
import { EmptyState } from "../../components/EmptyState";
import { useActiveHousehold } from "../app/useActiveHousehold";
import { useDismissNotification, useMarkAllRead, useMarkNotificationRead, useNotifications } from "./useNotifications";

function relativeTime(iso: string): string {
  const minutes = Math.round((Date.now() - new Date(iso).getTime()) / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

export function NotificationsPage() {
  const { household } = useActiveHousehold();
  const householdId = household?.id;
  const notificationsQuery = useNotifications(householdId);
  const markRead = useMarkNotificationRead(householdId ?? "");
  const dismiss = useDismissNotification(householdId ?? "");
  const markAllRead = useMarkAllRead(householdId ?? "");
  const navigate = useNavigate();

  if (!householdId || !notificationsQuery.data) return null;
  const items = notificationsQuery.data;
  const hasUnread = items.some((n) => !n.readAt);

  function onOpen(n: NotificationDTO) {
    if (!n.readAt) markRead.mutate(n.id);
    if (n.linkPath) navigate(n.linkPath);
  }

  return (
    <>
      <header className="page-head" style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <h1 className="page-title">Notifications</h1>
        <Button variant="ghost" disabled={!hasUnread} onClick={() => markAllRead.mutate()}>Mark all as read</Button>
      </header>

      {items.length === 0 && (
        <div className="card">
          <EmptyState icon={<Bell size={22} />} title="No notifications" text="Reminders about due bills and salary will show up here." />
        </div>
      )}

      <div className="list">
        {items.map((n) => (
          <div key={n.id} className="list__item">
            <button type="button" className="list__text" style={{ textAlign: "left", background: "none", border: 0, padding: 0, cursor: "pointer" }} onClick={() => onOpen(n)}>
              <span className="list__label" style={{ display: "block", fontWeight: n.readAt ? 500 : 700 }}>{n.title}</span>
              {n.body && <span className="list__meta" style={{ display: "block" }}>{n.body}</span>}
              <span className="list__meta">{relativeTime(n.createdAt)}</span>
            </button>
            <button type="button" aria-label="Dismiss" style={{ background: "none", border: 0, cursor: "pointer" }} onClick={() => dismiss.mutate(n.id)}>
              <X size={18} aria-hidden />
            </button>
          </div>
        ))}
      </div>
    </>
  );
}
