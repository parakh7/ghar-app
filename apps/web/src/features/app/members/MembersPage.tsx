import { useState, type FormEvent } from "react";
import { Mail, Trash2, UserMinus } from "lucide-react";
import type { HouseholdRole } from "@household/shared";
import { inviteMemberSchema } from "@household/shared";
import { ApiError } from "../../../lib/api";
import { Alert } from "../../../components/Alert";
import { Button } from "../../../components/Button";
import { TextField } from "../../../components/TextField";
import { useFormErrors } from "../../auth/useFormErrors";
import { zodFieldErrors } from "../../auth/zod-errors";
import { useActiveHousehold } from "../useActiveHousehold";
import {
  useHousehold, useInviteMember, useInvites, useMembers, useRemoveMember, useResendInvite, useRevokeInvite, useUpdateMember,
} from "./useMembers";

const ROLE_LABEL: Record<HouseholdRole, string> = { OWNER: "Owner", ADMIN: "Admin", MEMBER: "Member", VIEWER: "View only" };
const ALL_ROLES: HouseholdRole[] = ["OWNER", "ADMIN", "MEMBER", "VIEWER"];
const INVITABLE_ROLES: HouseholdRole[] = ["ADMIN", "MEMBER", "VIEWER"];

function messageFrom(err: unknown): string {
  return err instanceof ApiError ? err.message : "Something went wrong. Please try again.";
}

export function MembersPage() {
  const { household: active } = useActiveHousehold();
  const householdId = active?.id;
  const householdQuery = useHousehold(householdId);
  const membersQuery = useMembers(householdId);
  const invitesQuery = useInvites(householdId);
  const canManage = householdQuery.data?.permissions.includes("members.manage") ?? false;

  const inviteMember = useInviteMember(householdId ?? "");
  const revokeInvite = useRevokeInvite(householdId ?? "");
  const resendInvite = useResendInvite(householdId ?? "");
  const updateMember = useUpdateMember(householdId ?? "");
  const removeMember = useRemoveMember(householdId ?? "");

  const [email, setEmail] = useState("");
  const [role, setRole] = useState<HouseholdRole>("MEMBER");
  const [pageError, setPageError] = useState<string | null>(null);
  const errors = useFormErrors();

  function onInvite(e: FormEvent) {
    e.preventDefault();
    errors.clear();
    const parsed = inviteMemberSchema.safeParse({ email, role });
    if (!parsed.success) return errors.setFields(zodFieldErrors(parsed.error));
    inviteMember.mutate(parsed.data, { onSuccess: () => { setEmail(""); setRole("MEMBER"); }, onError: errors.fromError });
  }

  if (!householdId) return null;

  return (
    <>
      <header className="page-head"><h1 className="page-title">Members</h1></header>
      {pageError && <Alert tone="error" title={pageError} />}

      <h2 className="section-title">Active members</h2>
      <div className="list">
        {membersQuery.data?.map((m) => (
          <div key={m.userId} className="list__item">
            <span className="list__text">
              <span className="list__label" style={{ display: "block" }}>{m.displayName || m.name}</span>
              <span className="list__meta">{m.email}</span>
            </span>
            {canManage ? (
              <span style={{ display: "flex", alignItems: "center", gap: "var(--space-2)" }}>
                <select
                  className="input" aria-label={`Role for ${m.name}`} value={m.role}
                  onChange={(e) => updateMember.mutate(
                    { userId: m.userId, body: { role: e.target.value as HouseholdRole } },
                    { onError: (err) => setPageError(messageFrom(err)) },
                  )}
                >
                  {ALL_ROLES.map((r) => <option key={r} value={r}>{ROLE_LABEL[r]}</option>)}
                </select>
                <Button
                  variant="ghost" icon={<UserMinus size={20} aria-hidden />} aria-label={`Remove ${m.name}`}
                  onClick={() => removeMember.mutate(m.userId, { onError: (err) => setPageError(messageFrom(err)) })}
                />
              </span>
            ) : (
              <span className="badge badge--neutral">{ROLE_LABEL[m.role]}</span>
            )}
          </div>
        ))}
      </div>

      {canManage && (
        <>
          <h2 className="section-title">Pending invites</h2>
          <div className="list">
            {invitesQuery.data?.length === 0 && <p className="list__meta" style={{ padding: "var(--space-3) 0" }}>No pending invites.</p>}
            {invitesQuery.data?.map((inv) => (
              <div key={inv.id} className="list__item">
                <span className="list__text">
                  <span className="list__label" style={{ display: "block" }}>{inv.email}</span>
                  <span className="list__meta">Invited as {ROLE_LABEL[inv.role]}</span>
                </span>
                <span style={{ display: "flex", gap: "var(--space-2)" }}>
                  <Button variant="ghost" icon={<Mail size={20} aria-hidden />} loading={resendInvite.isPending} onClick={() => resendInvite.mutate(inv.id, { onError: (err) => setPageError(messageFrom(err)) })}>Resend</Button>
                  <Button variant="ghost" icon={<Trash2 size={20} aria-hidden />} aria-label={`Revoke invite for ${inv.email}`} onClick={() => revokeInvite.mutate(inv.id, { onError: (err) => setPageError(messageFrom(err)) })} />
                </span>
              </div>
            ))}
          </div>

          <h2 className="section-title">Invite someone</h2>
          <form className="auth__form" onSubmit={onInvite} noValidate>
            {errors.formError && <Alert tone="error" title={errors.formError} />}
            <TextField label="Email" type="email" autoComplete="email" inputMode="email" value={email} onChange={(e) => setEmail(e.target.value)} error={errors.fieldErrors.email} />
            <div className="field">
              <label className="field__label" htmlFor="invite-role">Role</label>
              <select id="invite-role" className="input" value={role} onChange={(e) => setRole(e.target.value as HouseholdRole)}>
                {INVITABLE_ROLES.map((r) => <option key={r} value={r}>{ROLE_LABEL[r]}</option>)}
              </select>
            </div>
            <Button type="submit" block loading={inviteMember.isPending}>Send invite</Button>
          </form>
        </>
      )}
    </>
  );
}
