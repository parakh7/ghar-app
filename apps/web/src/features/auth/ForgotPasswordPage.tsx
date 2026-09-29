import { useState, type FormEvent } from "react";
import { Link } from "react-router-dom";
import { useMutation } from "@tanstack/react-query";
import { forgotPasswordSchema } from "@household/shared";
import { post } from "../../lib/api";
import { Alert } from "../../components/Alert";
import { Button } from "../../components/Button";
import { TextField } from "../../components/TextField";
import { AuthLayout } from "./AuthLayout";
import { useFormErrors } from "./useFormErrors";
import { zodFieldErrors } from "./zod-errors";

export function ForgotPasswordPage() {
  const [email, setEmail] = useState("");
  const errors = useFormErrors();
  const mutation = useMutation({ mutationFn: (body: { email: string }) => post<null>("/auth/forgot-password", body), onError: errors.fromError });

  function onSubmit(e: FormEvent) {
    e.preventDefault();
    errors.clear();
    const parsed = forgotPasswordSchema.safeParse({ email });
    if (!parsed.success) return errors.setFields(zodFieldErrors(parsed.error));
    mutation.mutate(parsed.data);
  }

  return (
    <AuthLayout title="Reset your password" subtitle="Enter the email you signed up with and we'll send you a link." footer={<p><Link to="/signin">Back to sign in</Link></p>}>
      {mutation.isSuccess ? (
        <Alert tone="success" title="Check your email">
          If an account exists for <strong>{email}</strong>, a reset link is on its way. It works for 1 hour.
        </Alert>
      ) : (
        <form className="auth__form" onSubmit={onSubmit} noValidate>
          {errors.formError && <Alert tone="error" title={errors.formError} />}
          <TextField label="Email" type="email" autoComplete="email" inputMode="email" value={email} onChange={(e) => setEmail(e.target.value)} error={errors.fieldErrors.email} autoFocus />
          <Button type="submit" block loading={mutation.isPending}>Send reset link</Button>
        </form>
      )}
    </AuthLayout>
  );
}
