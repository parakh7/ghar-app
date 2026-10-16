import { useState, type FormEvent } from "react";
import { Check, Copy, Mail, MessageCircle, Trash2, UserMinus, X } from "lucide-react";
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

type RevealedInvite = { email: string; role: HouseholdRole; link: string; name: string };

function buildInviteMessage(inv: RevealedInvite, householdName: string): string {
  const greeting = inv.name ? `Hi ${inv.name}! ` : "Hi! ";
  return `${greeting}You've been invited to join *${householdName}* on Ghar as ${ROLE_LABEL[inv.role]}. Tap to accept: ${inv.link}`;
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
  const [name, setName] = useState("");
  const [role, setRole] = useState<HouseholdRole>("MEMBER");
  const [pageError, setPageError] = useState<string | null>(null);
  const [inviteNames, setInviteNames] = useState<Record<string, string>>({});
  const [revealedInvite, setRevealedInvite] = useState<RevealedInvite | null>(null);
  const [copied, setCopied] = useState(false);
  const errors = useFormErrors();

  function onInvite(e: FormEvent) {
    e.preventDefault();
    errors.clear();
    const parsed = inviteMemberSchema.safeParse({ email, role });
    if (!parsed.success) return errors.setFields(zodFieldErrors(parsed.error));
    const trimmedName = name.trim();
    inviteMember.mutate(parsed.data, {
      onSuccess: ({ data: invite }) => {
        if (trimmedName) setInviteNames((prev) => ({ ...prev, [parsed.data.email]: trimmedName }));
        setRevealedInvite({ email: invite.email, role: invite.role, link: invite.link, name: trimmedName });
        setCopied(false);
        setEmail(""); setName(""); setRole("MEMBER");
      },
      onError: errors.fromError,
    });
  }

  function onResend(inviteId: string, inviteEmail: string, inviteRole: HouseholdRole) {
    resendInvite.mutate(inviteId, {
      onSuccess: ({ data: invite }) => {
        setRevealedInvite({ email: inviteEmail, role: inviteRole, link: invite.link, name: inviteNames[inviteEmail] ?? "" });
        setCopied(false);
      },
      onError: (err) => setPageError(messageFrom(err)),
    });
  }

  async function copyLink(link: string) {
    await navigator.clipboard.writeText(link);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  function shareOnWhatsApp(inv: RevealedInvite, householdName: string) {
    const url = `https://wa.me/?text=${encodeURIComponent(buildInviteMessage(inv, householdName))}`;
    window.open(url, "_blank", "noopener,noreferrer");
  }

  if (!householdId) return null;

  return (
    <>
      <header className="page-head"><h1 className="page-title">Members</h1></header>
      {pageError && <Alert tone="error" title={pageError} />}

      {revealedInvite && (
        <Alert tone="success" title={`Invite ready for ${revealedInvite.email}`}>
          <p className="list__meta" style={{ marginBottom: "var(--space-3)" }}>
            This link is shown once — share it directly since the invite email may not reach every inbox.
          </p>
          <div style={{ display: "flex", flexWrap: "wrap", gap: "var(--space-2)" }}>
            <Button variant="secondary" icon={<MessageCircle size={18} aria-hidden />} onClick={() => shareOnWhatsApp(revealedInvite, householdQuery.data?.name ?? "Ghar")}>
              Share via WhatsApp
            </Button>
            <Button variant="ghost" icon={copied ? <Check size={18} aria-hidden /> : <Copy size={18} aria-hidden />} onClick={() => copyLink(revealedInvite.link)}>
              {copied ? "Copied!" : "Copy link"}
            </Button>
            <Button variant="ghost" icon={<X size={18} aria-hidden />} aria-label="Dismiss" onClick={() => setRevealedInvite(null)} />
          </div>
        </Alert>
      )}

      <h2 className="section-title">Active members</h2>
      <div className="list">
        {membersQuery.data?.map((m) => (
          <div key={m.userId} className="list__item">
            <span className="list__text">
              <span className="list__label" style={{ display: "block" }}>{m.displayName || m.name}</span>
              <span className="list__meta list__meta--truncate" title={m.email}>{m.email}</span>
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
                  onClick={() => {
                    if (!window.confirm(`Remove ${m.name} from the household?`)) return;
                    removeMember.mutate(m.userId, { onError: (err) => setPageError(messageFrom(err)) });
                  }}
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
            {invitesQuery.data?.length === 0 && <p className="list__meta" style={{ padding: "var(--space-3) var(--space-4)" }}>No pending invites.</p>}
            {invitesQuery.data?.map((inv) => (
              <div key={inv.id} className="list__item">
                <span className="list__text">
                  <span className="list__label list__meta--truncate" style={{ display: "block" }} title={inv.email}>{inv.email}</span>
                  <span className="list__meta">Invited as {ROLE_LABEL[inv.role]}</span>
                </span>
                <span style={{ display: "flex", gap: "var(--space-2)" }}>
                  <Button variant="ghost" icon={<Mail size={20} aria-hidden />} loading={resendInvite.isPending && resendInvite.variables === inv.id} onClick={() => onResend(inv.id, inv.email, inv.role)}>Resend</Button>
                  <Button variant="ghost" icon={<Trash2 size={20} aria-hidden />} aria-label={`Revoke invite for ${inv.email}`} onClick={() => revokeInvite.mutate(inv.id, { onError: (err) => setPageError(messageFrom(err)) })} />
                </span>
              </div>
            ))}
          </div>

          <h2 className="section-title">Invite someone</h2>
          <form className="auth__form" onSubmit={onInvite} noValidate>
            {errors.formError && <Alert tone="error" title={errors.formError} />}
            <TextField label="Name (optional)" hint="Used to personalize the WhatsApp share message." autoComplete="name" value={name} onChange={(e) => setName(e.target.value)} />
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
