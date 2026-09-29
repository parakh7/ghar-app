import type { ReactNode } from "react";
import { AlertTriangle, CheckCircle2, Info } from "lucide-react";

const ICONS = { error: AlertTriangle, success: CheckCircle2, info: Info };

export function Alert({ tone, title, children }: { tone: "error" | "success" | "info"; title?: string; children?: ReactNode }) {
  const Icon = ICONS[tone];
  return (
    <div className={`alert alert--${tone}`} role={tone === "error" ? "alert" : "status"}>
      <Icon size={18} aria-hidden />
      <div>
        {title && <p className="alert__title">{title}</p>}
        {children && <div className="alert__body">{children}</div>}
      </div>
    </div>
  );
}
