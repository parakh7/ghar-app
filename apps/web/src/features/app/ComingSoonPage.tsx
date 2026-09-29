import type { ReactNode } from "react";
import { EmptyState } from "../../components/EmptyState";

export function ComingSoonPage({ title, icon, heading, text }: { title: string; icon: ReactNode; heading: string; text: string }) {
  return (
    <>
      <header className="page-head"><h1 className="page-title">{title}</h1></header>
      <div className="card"><EmptyState icon={icon} title={heading} text={text} /></div>
    </>
  );
}
