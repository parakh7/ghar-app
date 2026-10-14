import type { ReactNode } from "react";
import type { StatusTone } from "./StatusBadge";

export function ListRow({ icon, iconTone, title, detail, badge, action }: {
  icon: ReactNode; iconTone?: StatusTone; title: ReactNode; detail?: ReactNode; badge?: ReactNode; action?: ReactNode;
}) {
  return (
    <div className="list-row">
      <span className={`list-row__icon${iconTone ? ` list-row__icon--${iconTone}` : ""}`} aria-hidden>{icon}</span>
      <div className="list-row__text">
        <p className="list-row__title">{title}</p>
        {detail && <p className="list-row__detail">{detail}</p>}
      </div>
      {badge}
      {action}
    </div>
  );
}
