import { useNavigate } from "react-router-dom";
import { Check, LogOut, Plus } from "lucide-react";
import { Button } from "../../components/Button";
import { useSession, useSignOut } from "../auth/session";
import { useActiveHousehold } from "./useActiveHousehold";

const ROLE_LABEL = { OWNER: "Owner", ADMIN: "Admin", MEMBER: "Member", VIEWER: "View only" } as const;

export function MorePage() {
  const { data } = useSession();
  const { household, households, switchTo } = useActiveHousehold();
  const signOut = useSignOut();
  const navigate = useNavigate();

  return (
    <>
      <header className="page-head"><h1 className="page-title">More</h1></header>

      <h2 className="section-title">Your homes</h2>
      <div className="list" role="radiogroup" aria-label="Active household">
        {households.map((h) => (
          <button key={h.id} type="button" role="radio" aria-checked={h.id === household?.id} className="radio-row list__item" onClick={() => switchTo(h.id)}>
            <span style={{ flex: 1 }}>
              <span className="list__label" style={{ display: "block" }}>{h.name}</span>
              <span className="list__meta">{ROLE_LABEL[h.role]} · {h.memberCount} {h.memberCount === 1 ? "member" : "members"}</span>
            </span>
            {h.id === household?.id && <Check size={22} aria-hidden color="var(--neem-700)" />}
          </button>
        ))}
      </div>
      <div style={{ marginTop: "var(--space-3)" }}>
        <Button variant="ghost" icon={<Plus size={20} aria-hidden />} onClick={() => navigate("/onboarding/new")}>Add another home</Button>
      </div>

      <h2 className="section-title">Account</h2>
      <div className="list">
        <div className="list__item">
          <span className="list__text"><span className="list__label" style={{ display: "block" }}>{data?.user.name}</span><span className="list__meta list__meta--truncate" title={data?.user.email}>{data?.user.email}</span></span>
          <span className="badge badge--neutral">{data?.user.emailVerified ? "Confirmed" : "Unconfirmed"}</span>
        </div>
      </div>

      <div style={{ marginTop: "var(--space-8)" }}>
        <Button variant="danger" block icon={<LogOut size={20} aria-hidden />} loading={signOut.isPending} onClick={() => signOut.mutate(undefined, { onSettled: () => navigate("/signin", { replace: true }) })}>
          Sign out
        </Button>
      </div>
    </>
  );
}
