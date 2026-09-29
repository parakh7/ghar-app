import { useState, type FormEvent } from "react";
import { Link, useLocation, useNavigate } from "react-router-dom";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { signupSchema, type MeDTO } from "@household/shared";
import { post } from "../../lib/api";
import { Alert } from "../../components/Alert";
import { Button } from "../../components/Button";
import { TextField } from "../../components/TextField";
import { AuthLayout } from "./AuthLayout";
import { meKey } from "./session";
import { useFormErrors } from "./useFormErrors";
import { zodFieldErrors } from "./zod-errors";

export function SignUpPage() {
  const [form, setForm] = useState({ name: "", email: "", password: "" });
  const errors = useFormErrors();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const location = useLocation();

  const mutation = useMutation({
    mutationFn: (body: typeof form) => post<MeDTO>("/auth/signup", body),
    onSuccess: ({ data }) => {
      qc.setQueryData(meKey, data);
      const from = (location.state as { from?: unknown } | null)?.from;
      const safe = typeof from === "string" && from.startsWith("/") && !from.startsWith("//");
      navigate(safe ? (from as string) : "/onboarding", { replace: true });
    },
    onError: errors.fromError,
  });

  function onSubmit(e: FormEvent) {
    e.preventDefault();
    errors.clear();
    const parsed = signupSchema.safeParse(form);
    if (!parsed.success) return errors.setFields(zodFieldErrors(parsed.error));
    mutation.mutate(parsed.data);
  }

  const set = (k: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement>) => setForm((f) => ({ ...f, [k]: e.target.value }));

  return (
    <AuthLayout
      title="Set up your home"
      subtitle="Househelp, attendance, bills and reminders — all in one place for the whole family."
      footer={<p>Already have an account? <Link to="/signin">Sign in</Link></p>}
    >
      <form className="auth__form" onSubmit={onSubmit} noValidate>
        {errors.formError && <Alert tone="error" title={errors.formError} />}
        <TextField label="Your name" autoComplete="name" value={form.name} onChange={set("name")} error={errors.fieldErrors.name} autoFocus />
        <TextField label="Email" type="email" autoComplete="email" inputMode="email" value={form.email} onChange={set("email")} error={errors.fieldErrors.email} />
        <TextField label="Password" type="password" autoComplete="new-password" hint="At least 8 characters. A short phrase is easy to remember." value={form.password} onChange={set("password")} error={errors.fieldErrors.password} />
        <Button type="submit" block loading={mutation.isPending}>Create account</Button>
      </form>
    </AuthLayout>
  );
}
