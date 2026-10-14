import type { ReactNode } from "react";

export function ActivityItem({ initials, text, time }: { initials: string; text: ReactNode; time: string }) {
  return (
    <div className="activity-item">
      <span className="activity-item__avatar" aria-hidden>{initials}</span>
      <p className="activity-item__text">{text}</p>
      <span className="activity-item__time">{time}</span>
    </div>
  );
}
