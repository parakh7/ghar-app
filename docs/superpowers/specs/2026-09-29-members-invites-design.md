# Phase 2, Spec 1 — Members & Invites

**Status:** approved, ready for implementation plan
**Date:** 2026-09-29
**Scope:** Household member management and email-based invites. Split out of Phase 2 ("Members and invites, househelps, categories, schedules") as the first of two specs — househelps/categories/schedules is Spec 2.

## Context

Phase 1 already delivered the full schema (`household_members`, `household_invites`), the authorization primitive (`getMembership`, `requireHousehold`), and the permission set (`members.view`, `members.manage`). This spec adds the service, route, and web layers on top of that existing foundation — no schema changes.

`DEFAULT_ROLE_PERMISSIONS` (packages/shared/src/permissions.ts) grants `members.manage` to OWNER only by default (ADMIN is explicitly excluded), overridable per household via `role_permission_overrides`. `members.view` is granted to all roles.

`users.email` is globally unique — one account can belong to multiple households (see `listHouseholdsForUser`). An invited email may already have an account.

## API surface

New routes mounted under the existing `/api/households/:householdId/...` router (`household.routes.ts` pattern), each behind `requireHousehold(deps, permission)` except where noted:

| Method | Path | Permission | Notes |
|---|---|---|---|
| GET | `/members` | `members.view` | List ACTIVE members |
| PATCH | `/members/:userId` | `members.manage` | Change role and/or displayName |
| DELETE | `/members/:userId` | `members.manage` | Remove a member (soft) |
| DELETE | `/members/me` | none (membership only) | Self-leave |
| GET | `/invites` | `members.manage` | List pending (unaccepted, unrevoked, unexpired) invites |
| POST | `/invites` | `members.manage` | Create + email an invite |
| DELETE | `/invites/:inviteId` | `members.manage` | Revoke a pending invite |
| POST | `/invites/:inviteId/resend` | `members.manage` | Reissue token + re-send email |

Plus one route outside household scoping, since the caller isn't a member yet:

| Method | Path | Auth | Notes |
|---|---|---|---|
| POST | `/api/invites/accept` | `requireAuth` only | Body `{token}`. Consumes invite, creates/activates membership for the logged-in user. |

Service module: `apps/api/src/services/member.service.ts`, same style as `household.service.ts` — plain functions taking `Deps`/`DbOrTx`, no classes.

## Invite lifecycle

1. **Create.** Caller (default: OWNER) submits `{email, role}`. Reject with a validation/conflict error if that email is already an ACTIVE member of the household. Any prior unaccepted invite for the same `(householdId, email)` is revoked (`revokedAt = now`) before the new row is inserted. Token: 256-bit random (`generateToken`/`hashToken` from `lib/crypto.ts`, same as email-verify/password-reset), 7-day expiry (`expiresAt`).
2. **Email.** New `inviteMessage` template in `services/email/templates.ts`. Link: `${APP_URL}/invites/accept?token=...`.
3. **Accept — four branches, resolved by the web app before calling the API:**
   - Logged in as the invited email → web calls `POST /api/invites/accept` directly.
   - Logged in as a different user → error screen: "This invite is for `x@y.com` — sign out and sign in as that address." No API call.
   - Not logged in, account exists for that email → redirect to `/login?next=/invites/accept?token=...&email=x@y.com` (email pre-filled, field locked); after login, accept fires.
   - Not logged in, no account → redirect to `/signup?next=...&email=...` (email pre-filled, locked); after signup, accept fires.
4. **Consume.** `acceptInvite` looks up the invite by token hash, requires `acceptedAt IS NULL AND revokedAt IS NULL AND expiresAt > now`, and requires the token's stored email to match the authenticated user's email (defense in depth beyond the web-side branch above). On match: upsert `household_members` (insert if no row, or reactivate a `REMOVED` row) with `status='ACTIVE', joinedAt=now`, set `acceptedAt=now` on the invite. All in one transaction with an audit row (`member.invite_accepted`).
5. **Invalid token** (expired/revoked/already-accepted/not found) → generic `INVALID_TOKEN` error, same shape as existing verify/reset token errors. No account-enumeration signal.

## Member management rules

- **Last-owner protection.** Within the same transaction as a role change or removal, count ACTIVE members with `role='OWNER'` in that household; if the target is the only one and the operation would remove OWNER status, reject with a validation error ("A household needs at least one owner.").
- **Soft removal.** Removing a member (by OWNER or self-leave) sets `status='REMOVED'`, never a hard delete — preserves FK history for attendance/checklist rows added in later phases.
- **Audit.** Role change, removal, self-leave, and invite-accept each write an `audit_logs` row in the same transaction as the mutation (`member.role_changed`, `member.removed`, `member.left`, `member.invite_accepted`), matching the existing in-tx audit convention.

## Shared package additions (`packages/shared/src`)

- `schemas.ts`: `inviteMemberSchema` (`email`, `role`), `updateMemberSchema` (`role?`, `displayName?`), `acceptInviteSchema` (`token`)
- `dto.ts`: `MemberDTO` (`userId`, `name`, `email`, `role`, `displayName`, `joinedAt`), `InviteDTO` (`id`, `email`, `role`, `expiresAt`, `createdAt`)
- `permissions.ts`: no changes — `members.view`/`members.manage` already exist

## Web (`apps/web/src/features/app/members/`)

- **Members page** (reachable from the "More" menu): active-members list (name, role badge, remove/change-role actions, each gated on `members.manage` from the current `HouseholdDTO.permissions`) plus a pending-invites list (resend/revoke) and an "Invite member" form (email + role picker).
- **Accept-invite page** (`/invites/accept`): implements the four login-state branches above.
- Reuses existing primitives (`Button`, `TextField`, `Alert`, `EmptyState`); a role badge can extend existing badge styling — no new design-system primitive required.

## Testing

- **API integration** (real Postgres, matching Phase 1 pattern): invite create/accept/expire/revoke/resend; permission checks (VIEWER/MEMBER blocked from `members.manage` routes); last-owner protection on both role-change and removal; self-leave; cross-household isolation (inviting into or accepting for a household the caller isn't a member of → 404/INVALID_TOKEN as appropriate); account-enumeration-safe accept errors; email-already-a-member conflict.
- **Web**: component tests for the members list and permission-gated actions, and the accept-invite page's branch logic.
- **E2E**: not added in this spec — Phase 1's Playwright budget covers auth/household journeys; an invite journey can be added later if wanted.
