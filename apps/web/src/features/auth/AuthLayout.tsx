import type { ReactNode } from "react";
import { Logo } from "../../components/Logo";
import "./auth.css";

export function AuthLayout({ title, subtitle, children, footer }: { title: string; subtitle?: string; children: ReactNode; footer?: ReactNode }) {
  return (
    <div className="auth">
      <main className="auth__main">
        <div className="auth__brand"><Logo size={40} /><span className="auth__wordmark">Ghar</span></div>
        <h1 className="auth__title">{title}</h1>
        {subtitle && <p className="auth__subtitle">{subtitle}</p>}
        <div className="auth__body">{children}</div>
        {footer && <div className="auth__footer">{footer}</div>}
      </main>
    </div>
  );
}
