import type { StatusTone } from "./StatusBadge";

export function AgendaItem({ time, dotTone, title, subtitle }: {
  time: string; dotTone: StatusTone; title: string; subtitle: string;
}) {
  return (
    <div className="agenda-item">
      <span className="agenda-item__time">{time}</span>
      <span className={`agenda-item__dot agenda-item__dot--${dotTone}`} aria-hidden />
      <div className="agenda-item__text">
        <p className="agenda-item__title">{title}</p>
        <p className="agenda-item__subtitle">{subtitle}</p>
      </div>
    </div>
  );
}
