import { useEffect, useRef } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { post } from "../../lib/api";
import { Alert } from "../../components/Alert";
import { AuthLayout } from "./AuthLayout";
import { meKey } from "./session";

export function VerifyEmailPage() {
  const [params] = useSearchParams();
  const token = params.get("token") ?? "";
  const qc = useQueryClient();
  const mutation = useMutation({
    mutationFn: () => post<null>("/auth/verify-email", { token }),
    onSuccess: () => qc.invalidateQueries({ queryKey: meKey }),
  });
  const fired = useRef(false); // StrictMode double-effect guard: the token is single-use
  useEffect(() => {
    if (token && !fired.current) { fired.current = true; mutation.mutate(); }
  }, [token, mutation]);

  return (
    <AuthLayout title="Confirm your email" footer={<p><Link to="/">Continue to the app</Link></p>}>
      {!token && <Alert tone="error" title="This confirmation link is incomplete.">Open the link from your email again.</Alert>}
      {mutation.isPending && <Alert tone="info" title="Confirming…" />}
      {mutation.isSuccess && <Alert tone="success" title="Email confirmed">You're all set.</Alert>}
      {mutation.isError && <Alert tone="error" title={mutation.error.message}>You can send a new link from the More tab.</Alert>}
    </AuthLayout>
  );
}
