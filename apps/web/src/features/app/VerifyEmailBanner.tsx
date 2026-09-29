import { useMutation } from "@tanstack/react-query";
import { post } from "../../lib/api";
import { Alert } from "../../components/Alert";
import { Button } from "../../components/Button";
import { useSession } from "../auth/session";

export function VerifyEmailBanner() {
  const { data } = useSession();
  const resend = useMutation({ mutationFn: () => post<null>("/auth/resend-verification") });
  if (!data || data.user.emailVerified) return null;
  return (
    <div style={{ marginBottom: "var(--space-6)" }}>
      {resend.isSuccess ? (
        <Alert tone="success" title="New link sent">Check {data.user.email}.</Alert>
      ) : (
        <Alert tone="info" title="Confirm your email">
          <p>We sent a link to {data.user.email}. Confirming it lets you invite family and recover your account.</p>
          <Button variant="ghost" onClick={() => resend.mutate()} loading={resend.isPending} style={{ marginLeft: "calc(-1 * var(--space-3))" }}>Send a new link</Button>
          {resend.isError && <p role="alert">{resend.error.message}</p>}
        </Alert>
      )}
    </div>
  );
}
