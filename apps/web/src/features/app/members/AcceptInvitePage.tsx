import { useEffect, useRef } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { HouseholdDTO } from "@household/shared";
import { post } from "../../../lib/api";
import { Alert } from "../../../components/Alert";
import { AuthLayout } from "../../auth/AuthLayout";
import { meKey } from "../../auth/session";
import { setActiveHouseholdId } from "../../../lib/active-household";

export function AcceptInvitePage() {
  const [params] = useSearchParams();
  const token = params.get("token") ?? "";
  const qc = useQueryClient();
  const navigate = useNavigate();

  const mutation = useMutation({
    mutationFn: () => post<HouseholdDTO>("/invites/accept", { token }),
    onSuccess: ({ data }) => {
      qc.invalidateQueries({ queryKey: meKey });
      setActiveHouseholdId(data.id);
      navigate("/", { replace: true });
    },
  });
  const fired = useRef(false); // StrictMode double-effect guard: the token is single-use
  useEffect(() => {
    if (token && !fired.current) { fired.current = true; mutation.mutate(); }
  }, [token, mutation]);

  return (
    <AuthLayout title="Joining household" footer={<p><Link to="/">Continue to the app</Link></p>}>
      {!token && <Alert tone="error" title="This invite link is incomplete.">Open the link from your email again.</Alert>}
      {mutation.isPending && <Alert tone="info" title="Joining…" />}
      {mutation.isError && <Alert tone="error" title={mutation.error.message} />}
    </AuthLayout>
  );
}
