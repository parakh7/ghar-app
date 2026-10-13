export function NotificationBadge({ count }: { count: number }) {
  if (count <= 0) return null;
  return <span className="badge-count" aria-label={`${count} unread notifications`}>{count > 99 ? "99+" : count}</span>;
}
