import type { ReactNode } from "react";
import { Link } from "react-router-dom";

export function SummaryCard({ icon, label, value, unit, badge, to }: {
  icon: ReactNode; label: string; value: ReactNode; unit?: string; badge: ReactNode; to: string;
}) {
  return (
    <Link to={to} className="summary-card">
      <div className="summary-card__head">
        <span className="summary-card__icon" aria-hidden>{icon}</span>
        <span className="summary-card__label">{label}</span>
      </div>
      <p className="summary-card__value">
        {value}
        {unit && <span className="summary-card__unit"> {unit}</span>}
      </p>
      {badge}
    </Link>
  );
}
