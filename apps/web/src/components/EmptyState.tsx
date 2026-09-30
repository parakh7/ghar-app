import type { ReactNode } from "react";

export function EmptyState({ icon, title, text, action, tone = "coral" }: {
  icon: ReactNode; title: string; text: string; action?: ReactNode; tone?: "coral" | "amber" | "dusk";
}) {
  return (
    <div className="empty">
      <div className={`empty__icon empty__icon--${tone}`} aria-hidden>{icon}</div>
      <p className="empty__title">{title}</p>
      <p className="empty__text">{text}</p>
      {action}
    </div>
  );
}
