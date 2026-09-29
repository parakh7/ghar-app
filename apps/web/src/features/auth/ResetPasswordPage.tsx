import { useState, type FormEvent } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { passwordSchema } from "@household/shared";
import { post } from "../../lib/api";
import { Alert } from "../../components/Alert";
import { Button } from "../../components/Button";
import { TextField } from "../../components/TextField";
import { AuthLayout } from "./AuthLayout";
import { meKey } from "./session";
import { useFormErrors } from "./useFormErrors";

export function ResetPasswordPage() {
  const [params] = useSearchParams();
  const token = params.get("token") ?? "";
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const errors = useFormErrors();
  const navigate = useNavigate();
  const qc = useQueryClient();

  const mutation = useMutation({
    mutationFn: () => post<null>("/auth/reset-password", { token, password }),
    onSuccess: () => { qc.setQueryData(meKey, null); navigate("/signin", { replace: true, state: { notice: "Password updated. Sign in with your new password." } }); },
    onError: errors.fromError,
  });

  function onSubmit(e: FormEvent) {
    e.preventDefault();
    errors.clear();
    const p = passwordSchema.safeParse(password);
    if (!p.success) return errors.setFields({ password: p.error.issues[0]!.message });
    if (password !== confirm) return errors.setFields({ confirm: "Passwords don't match" });
    mutation.mutate();
  }

  if (!token) {
    return (
      <AuthLayout title="Link not valid" footer={<p><Link to="/forgot-password">Request a new link</Link></p>}>
        <Alert tone="error" title="This reset link is incomplete." >Open the link from your email again, or request a new one.</Alert>
      </AuthLayout>
    );
  }

  return (
    <AuthLayout title="Choose a new password" subtitle="You'll be signed out on all other devices." footer={<p><Link to="/signin">Back to sign in</Link></p>}>
      <form className="auth__form" onSubmit={onSubmit} noValidate>
        {errors.formError && <Alert tone="error" title={errors.formError}>{errors.formError.includes("expired") && <Link to="/forgot-password">Request a new link</Link>}</Alert>}
        <TextField label="New password" type="password" autoComplete="new-password" hint="At least 8 characters." value={password} onChange={(e) => setPassword(e.target.value)} error={errors.fieldErrors.password} autoFocus />
        <TextField label="Confirm new password" type="password" autoComplete="new-password" value={confirm} onChange={(e) => setConfirm(e.target.value)} error={errors.fieldErrors.confirm} />
        <Button type="submit" block loading={mutation.isPending}>Update password</Button>
      </form>
    </AuthLayout>
  );
}
