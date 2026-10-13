import { useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { Check, LogOut, Plus } from "lucide-react";
import { ApiError } from "../../lib/api";
import { Alert } from "../../components/Alert";
import { Button } from "../../components/Button";
import { useSession, useSignOut } from "../auth/session";
import { NotificationBadge } from "../notifications/NotificationBadge";
import { useUnreadCount } from "../notifications/useNotifications";
import { useLeaveHousehold } from "./members/useMembers";
import { useActiveHousehold } from "./useActiveHousehold";

const ROLE_LABEL = { OWNER: "Owner", ADMIN: "Admin", MEMBER: "Member", VIEWER: "View only" } as const;

export function MorePage() {
  const { data } = useSession();
  const { household, households, switchTo } = useActiveHousehold();
  const signOut = useSignOut();
  const navigate = useNavigate();
  const leaveHousehold = useLeaveHousehold(household?.id ?? "");
  const unreadCount = useUnreadCount(household?.id).data ?? 0;
  const [leaveError, setLeaveError] = useState<string | null>(null);

  function onLeave() {
    if (!household) return;
    if (!window.confirm(`Leave ${household.name}? You'll need a new invite to rejoin.`)) return;
    leaveHousehold.mutate(undefined, {
      onError: (err) => setLeaveError(err instanceof ApiError ? err.message : "Something went wrong."),
    });
  }

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
            {h.id === household?.id && <Check size={22} aria-hidden color="var(--accent-700)" />}
          </button>
        ))}
      </div>
      <div style={{ marginTop: "var(--space-3)" }}>
        <Button variant="ghost" icon={<Plus size={20} aria-hidden />} onClick={() => navigate("/onboarding/new")}>Add another home</Button>
      </div>

      <h2 className="section-title">Household</h2>
      <div className="list">
        <Link to="/members" className="list__item">
          <span className="list__label">Members</span>
        </Link>
        <Link to="/notifications" className="list__item">
          <span className="list__label">Notifications</span>
          <NotificationBadge count={unreadCount} />
        </Link>
        <Link to="/settings/notifications" className="list__item">
          <span className="list__label">Notification settings</span>
        </Link>
        <Link to="/reports" className="list__item">
          <span className="list__label">Reports</span>
        </Link>
      </div>

      <h2 className="section-title">Account</h2>
      <div className="list">
        <div className="list__item">
          <span className="list__text"><span className="list__label" style={{ display: "block" }}>{data?.user.name}</span><span className="list__meta list__meta--truncate" title={data?.user.email}>{data?.user.email}</span></span>
          <span className="badge badge--neutral">{data?.user.emailVerified ? "Confirmed" : "Unconfirmed"}</span>
        </div>
        {leaveError && <Alert tone="error" title={leaveError} />}
      </div>

      {household && (
        <div style={{ marginTop: "var(--space-3)" }}>
          <Button variant="danger" block loading={leaveHousehold.isPending} onClick={onLeave}>Leave {household.name}</Button>
        </div>
      )}

      <div style={{ marginTop: "var(--space-8)" }}>
        <Button variant="danger" block icon={<LogOut size={20} aria-hidden />} loading={signOut.isPending} onClick={() => signOut.mutate(undefined, { onSettled: () => navigate("/signin", { replace: true }) })}>
          Sign out
        </Button>
      </div>
    </>
  );
}
