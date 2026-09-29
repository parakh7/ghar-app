import type { ButtonHTMLAttributes, ReactNode } from "react";

type Props = ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: "primary" | "secondary" | "ghost" | "danger";
  block?: boolean;
  loading?: boolean;
  icon?: ReactNode;
};

export function Button({ variant = "primary", block, loading, icon, children, disabled, className, type = "button", ...rest }: Props) {
  return (
    <button
      type={type}
      className={["btn", `btn--${variant}`, block && "btn--block", className].filter(Boolean).join(" ")}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      {...rest}
    >
      {loading ? <span className="btn__spinner" aria-hidden /> : icon}
      <span>{children}</span>
    </button>
  );
}
