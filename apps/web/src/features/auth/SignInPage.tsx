import { useState, type FormEvent } from "react";
import { Link, useLocation } from "react-router-dom";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { loginSchema, type MeDTO } from "@household/shared";
import { post } from "../../lib/api";
import { Alert } from "../../components/Alert";
import { Button } from "../../components/Button";
import { TextField } from "../../components/TextField";
import { AuthLayout } from "./AuthLayout";
import { meKey } from "./session";
import { useFormErrors } from "./useFormErrors";
import { zodFieldErrors } from "./zod-errors";

export function SignInPage() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const errors = useFormErrors();
  const qc = useQueryClient();
  const location = useLocation();
  const notice = (location.state as { notice?: string } | null)?.notice;

  const mutation = useMutation({
    mutationFn: (body: { email: string; password: string }) => post<MeDTO>("/auth/login", body),
    // RedirectIfSignedIn performs the navigation (to the saved return path) once the session is set.
    onSuccess: ({ data }) => qc.setQueryData(meKey, data),
    onError: errors.fromError,
  });

  function onSubmit(e: FormEvent) {
    e.preventDefault();
    errors.clear();
    const parsed = loginSchema.safeParse({ email, password });
    if (!parsed.success) return errors.setFields(zodFieldErrors(parsed.error));
    mutation.mutate(parsed.data);
  }

  return (
    <AuthLayout
      title="Welcome back"
      subtitle="Sign in to see who's coming today and what's due."
      footer={<p>New here? <Link to="/signup">Create an account</Link></p>}
    >
      <form className="auth__form" onSubmit={onSubmit} noValidate>
        {notice && <Alert tone="success" title={notice} />}
        {errors.formError && <Alert tone="error" title={errors.formError} />}
        <TextField label="Email" type="email" autoComplete="email" inputMode="email" value={email} onChange={(e) => setEmail(e.target.value)} error={errors.fieldErrors.email} autoFocus />
        <TextField label="Password" type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} error={errors.fieldErrors.password} />
        <div className="auth__row"><Link to="/forgot-password">Forgot password?</Link></div>
        <Button type="submit" block loading={mutation.isPending}>Sign in</Button>
      </form>
    </AuthLayout>
  );
}
