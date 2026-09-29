import { useId, useState, type InputHTMLAttributes } from "react";
import { AlertCircle, Eye, EyeOff } from "lucide-react";

type Props = Omit<InputHTMLAttributes<HTMLInputElement>, "id"> & { label: string; hint?: string; error?: string | undefined };

export function TextField({ label, hint, error, type = "text", ...rest }: Props) {
  const id = useId();
  const [reveal, setReveal] = useState(false);
  const isPassword = type === "password";
  const describedBy = [hint && `${id}-hint`, error && `${id}-error`].filter(Boolean).join(" ") || undefined;

  return (
    <div className="field">
      <label className="field__label" htmlFor={id}>{label}</label>
      {hint && <p className="field__hint" id={`${id}-hint`}>{hint}</p>}
      <div className="field__control">
        <input
          id={id}
          className={`input${isPassword ? " input--with-action" : ""}`}
          type={isPassword && reveal ? "text" : type}
          aria-invalid={error ? true : undefined}
          aria-describedby={describedBy}
          {...rest}
        />
        {isPassword && (
          <button type="button" className="field__action" onClick={() => setReveal((v) => !v)} aria-label={reveal ? "Hide password" : "Show password"} aria-pressed={reveal}>
            {reveal ? <EyeOff size={20} aria-hidden /> : <Eye size={20} aria-hidden />}
          </button>
        )}
      </div>
      {error && (
        <p className="field__error" id={`${id}-error`}>
          <AlertCircle size={16} aria-hidden style={{ marginTop: 3, flex: "none" }} />
          {error}
        </p>
      )}
    </div>
  );
}
