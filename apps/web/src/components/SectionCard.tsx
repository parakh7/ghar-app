import type { ReactNode } from "react";

export function SectionCard({ title, aside, children }: { title: string; aside?: ReactNode; children: ReactNode }) {
  return (
    <section className="section-card" aria-labelledby={`section-${title.replace(/\s+/g, "-").toLowerCase()}`}>
      <div className="section-card__head">
        <h2 className="section-card__title" id={`section-${title.replace(/\s+/g, "-").toLowerCase()}`}>{title}</h2>
        {aside}
      </div>
      {children}
    </section>
  );
}
