import { and, asc, eq, gt, isNull } from "drizzle-orm";
import type { HouseholdDTO, HouseholdRole, InviteDTO, InviteMemberInput, MemberDTO, UpdateMemberInput } from "@household/shared";
import { householdInvites, householdMembers, users } from "../db/schema.js";
import type { DbOrTx } from "../db/client.js";
import { generateToken, hashToken } from "../lib/crypto.js";
import { Errors } from "../lib/errors.js";
import { recordAudit } from "./audit.service.js";
import type { Deps } from "./deps.js";
import { getHousehold, getMembership, type Membership } from "./household.service.js";
import { inviteMessage } from "./email/templates.js";

const MEMBER_SELECT = {
  userId: users.id, name: users.name, email: users.email,
  role: householdMembers.role, displayName: householdMembers.displayName, joinedAt: householdMembers.joinedAt,
} as const;

function toMemberDTO(row: { userId: string; name: string; email: string; role: HouseholdRole; displayName: string | null; joinedAt: Date | null }): MemberDTO {
  // ACTIVE rows always have joinedAt set — it's stamped when a row becomes ACTIVE (invite accept or direct add).
  return { ...row, joinedAt: row.joinedAt!.toISOString() };
}

export async function listMembers(db: DbOrTx, householdId: string): Promise<MemberDTO[]> {
  const rows = await db.select(MEMBER_SELECT).from(householdMembers)
    .innerJoin(users, eq(users.id, householdMembers.userId))
    .where(and(eq(householdMembers.householdId, householdId), eq(householdMembers.status, "ACTIVE")))
    .orderBy(asc(householdMembers.createdAt));
  return rows.map(toMemberDTO);
}

async function getMemberDTO(db: DbOrTx, householdId: string, userId: string): Promise<MemberDTO | undefined> {
  const [row] = await db.select(MEMBER_SELECT).from(householdMembers)
    .innerJoin(users, eq(users.id, householdMembers.userId))
    .where(and(eq(householdMembers.householdId, householdId), eq(householdMembers.userId, userId), eq(householdMembers.status, "ACTIVE")))
    .limit(1);
  return row ? toMemberDTO(row) : undefined;
}

/**
 * Counts ACTIVE owners, locking every ACTIVE-owner row so a concurrent transaction trying to
 * demote/remove/leave a *different* owner row in the same household blocks until this one commits
 * or rolls back — otherwise two concurrent requests could each lock a different owner row, each
 * see the old (pre-change) count, and both pass the "at least one owner" check, leaving zero owners.
 * (Postgres rejects FOR UPDATE combined with an aggregate, so this selects rows and counts in JS.)
 */
async function countActiveOwners(tx: DbOrTx, householdId: string): Promise<number> {
  const rows = await tx.select({ userId: householdMembers.userId }).from(householdMembers)
    .where(and(eq(householdMembers.householdId, householdId), eq(householdMembers.role, "OWNER"), eq(householdMembers.status, "ACTIVE")))
    .for("update");
  return rows.length;
}

const LAST_OWNER_ERROR = "A household needs at least one owner.";

export async function updateMember(
  deps: Deps, actorUserId: string, membership: Membership, targetUserId: string, patch: UpdateMemberInput, ip?: string,
): Promise<MemberDTO> {
  // Only an existing OWNER may mint another one — otherwise a non-OWNER with members.manage
  // (e.g. an ADMIN granted it via role_permission_overrides) could promote themselves or anyone
  // else to OWNER, a status that (per resolvePermissions) can never be revoked.
  if (patch.role === "OWNER" && membership.role !== "OWNER") throw Errors.forbidden();
  await deps.db.transaction(async (tx) => {
    const [before] = await tx.select({ role: householdMembers.role, displayName: householdMembers.displayName })
      .from(householdMembers)
      .where(and(eq(householdMembers.householdId, membership.householdId), eq(householdMembers.userId, targetUserId), eq(householdMembers.status, "ACTIVE")))
      .for("update");
    if (!before) throw Errors.notFound("Member");
    if (patch.role && before.role === "OWNER" && patch.role !== "OWNER" && (await countActiveOwners(tx, membership.householdId)) <= 1) {
      throw Errors.validation({ role: LAST_OWNER_ERROR });
    }
    const changes: Partial<{ role: HouseholdRole; displayName: string }> = {};
    if (patch.role !== undefined) changes.role = patch.role;
    if (patch.displayName !== undefined) changes.displayName = patch.displayName;
    await tx.update(householdMembers).set(changes)
      .where(and(eq(householdMembers.householdId, membership.householdId), eq(householdMembers.userId, targetUserId)));
    await recordAudit(tx, { householdId: membership.householdId, actorUserId, action: "member.updated", entityType: "household_member", entityId: targetUserId, oldValue: before, newValue: changes, ipAddress: ip ?? null });
  });
  return (await getMemberDTO(deps.db, membership.householdId, targetUserId))!;
}

export async function removeMember(deps: Deps, actorUserId: string, membership: Membership, targetUserId: string, ip?: string): Promise<void> {
  await deps.db.transaction(async (tx) => {
    const [row] = await tx.select({ role: householdMembers.role }).from(householdMembers)
      .where(and(eq(householdMembers.householdId, membership.householdId), eq(householdMembers.userId, targetUserId), eq(householdMembers.status, "ACTIVE")))
      .for("update");
    if (!row) throw Errors.notFound("Member");
    if (row.role === "OWNER" && (await countActiveOwners(tx, membership.householdId)) <= 1) throw Errors.validation({ role: LAST_OWNER_ERROR });
    await tx.update(householdMembers).set({ status: "REMOVED" })
      .where(and(eq(householdMembers.householdId, membership.householdId), eq(householdMembers.userId, targetUserId)));
    await recordAudit(tx, { householdId: membership.householdId, actorUserId, action: "member.removed", entityType: "household_member", entityId: targetUserId, ipAddress: ip ?? null });
  });
}

export async function leaveHousehold(deps: Deps, membership: Membership, userId: string, ip?: string): Promise<void> {
  await deps.db.transaction(async (tx) => {
    const [row] = await tx.select({ role: householdMembers.role }).from(householdMembers)
      .where(and(eq(householdMembers.householdId, membership.householdId), eq(householdMembers.userId, userId), eq(householdMembers.status, "ACTIVE")))
      .for("update");
    if (!row) throw Errors.notFound("Membership");
    if (row.role === "OWNER" && (await countActiveOwners(tx, membership.householdId)) <= 1) {
      throw Errors.validation({}, "You're the only owner. Promote another member to owner before leaving.");
    }
    await tx.update(householdMembers).set({ status: "REMOVED" })
      .where(and(eq(householdMembers.householdId, membership.householdId), eq(householdMembers.userId, userId)));
    await recordAudit(tx, { householdId: membership.householdId, actorUserId: userId, action: "member.left", entityType: "household_member", entityId: userId, ipAddress: ip ?? null });
  });
}

const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

function toInviteDTO(row: { id: string; email: string; role: HouseholdRole; expiresAt: Date; createdAt: Date }): InviteDTO {
  return { id: row.id, email: row.email, role: row.role, expiresAt: row.expiresAt.toISOString(), createdAt: row.createdAt.toISOString() };
}

export async function listInvites(deps: Deps, householdId: string): Promise<InviteDTO[]> {
  const rows = await deps.db.select().from(householdInvites)
    .where(and(eq(householdInvites.householdId, householdId), isNull(householdInvites.acceptedAt), isNull(householdInvites.revokedAt), gt(householdInvites.expiresAt, deps.clock.now())))
    .orderBy(asc(householdInvites.createdAt));
  return rows.map(toInviteDTO);
}

export async function createInvite(deps: Deps, actorUserId: string, membership: Membership, input: InviteMemberInput, ip?: string): Promise<InviteDTO> {
  const [existingMember] = await deps.db.select({ id: users.id }).from(users)
    .innerJoin(householdMembers, and(eq(householdMembers.userId, users.id), eq(householdMembers.householdId, membership.householdId), eq(householdMembers.status, "ACTIVE")))
    .where(eq(users.email, input.email)).limit(1);
  if (existingMember) throw Errors.conflict("This person is already a member of the household.");

  const token = generateToken();
  const now = deps.clock.now();
  const invite = await deps.db.transaction(async (tx) => {
    // Only the newest unaccepted invite for this email works — same "invalidate the old one" rule as auth tokens.
    await tx.update(householdInvites).set({ revokedAt: now })
      .where(and(eq(householdInvites.householdId, membership.householdId), eq(householdInvites.email, input.email), isNull(householdInvites.acceptedAt), isNull(householdInvites.revokedAt)));
    const [row] = await tx.insert(householdInvites).values({
      householdId: membership.householdId, email: input.email, role: input.role,
      tokenHash: hashToken(token), invitedByUserId: actorUserId, expiresAt: new Date(now.getTime() + INVITE_TTL_MS),
    }).returning();
    await recordAudit(tx, { householdId: membership.householdId, actorUserId, action: "member.invited", entityType: "household_invite", entityId: row!.id, newValue: { email: input.email, role: input.role }, ipAddress: ip ?? null });
    return row!;
  });
  const link = `${deps.env.APP_URL}/invites/accept?token=${encodeURIComponent(token)}`;
  deps.email.send(inviteMessage(invite.email, invite.role, membership.name, link))
    .catch((err: unknown) => deps.logger.error({ err, householdId: membership.householdId }, "invite email failed"));
  deps.logger.info({ householdId: membership.householdId, event: "member.invited" }, "member invited");
  return toInviteDTO(invite);
}

export async function revokeInvite(deps: Deps, actorUserId: string, householdId: string, inviteId: string, ip?: string): Promise<void> {
  await deps.db.transaction(async (tx) => {
    const [row] = await tx.update(householdInvites).set({ revokedAt: deps.clock.now() })
      .where(and(eq(householdInvites.id, inviteId), eq(householdInvites.householdId, householdId), isNull(householdInvites.acceptedAt), isNull(householdInvites.revokedAt)))
      .returning({ id: householdInvites.id });
    if (!row) throw Errors.notFound("Invite");
    await recordAudit(tx, { householdId, actorUserId, action: "member.invite_revoked", entityType: "household_invite", entityId: inviteId, ipAddress: ip ?? null });
  });
}

export async function resendInvite(deps: Deps, actorUserId: string, membership: Membership, inviteId: string, ip?: string): Promise<InviteDTO> {
  const token = generateToken();
  const now = deps.clock.now();
  const invite = await deps.db.transaction(async (tx) => {
    const [row] = await tx.update(householdInvites)
      .set({ tokenHash: hashToken(token), expiresAt: new Date(now.getTime() + INVITE_TTL_MS) })
      .where(and(eq(householdInvites.id, inviteId), eq(householdInvites.householdId, membership.householdId), isNull(householdInvites.acceptedAt), isNull(householdInvites.revokedAt)))
      .returning();
    if (!row) throw Errors.notFound("Invite");
    await recordAudit(tx, { householdId: membership.householdId, actorUserId, action: "member.invite_resent", entityType: "household_invite", entityId: inviteId, ipAddress: ip ?? null });
    return row;
  });
  const link = `${deps.env.APP_URL}/invites/accept?token=${encodeURIComponent(token)}`;
  deps.email.send(inviteMessage(invite.email, invite.role, membership.name, link))
    .catch((err: unknown) => deps.logger.error({ err, householdId: membership.householdId }, "invite email failed"));
  return toInviteDTO(invite);
}

/** `user` is whoever is currently authenticated — the caller doesn't need to be a member of the invite's household yet. */
export async function acceptInvite(deps: Deps, user: { id: string; email: string }, token: string, ip?: string): Promise<HouseholdDTO> {
  const now = deps.clock.now();
  const [invite] = await deps.db.select().from(householdInvites)
    .where(and(eq(householdInvites.tokenHash, hashToken(token)), isNull(householdInvites.acceptedAt), isNull(householdInvites.revokedAt), gt(householdInvites.expiresAt, now)))
    .limit(1);
  if (!invite) throw Errors.invalidToken();
  if (invite.email !== user.email) {
    throw Errors.forbidden(`This invite is for ${invite.email}. Sign out and sign in as that address to accept it.`);
  }
  await deps.db.transaction(async (tx) => {
    const [existing] = await tx.select({ status: householdMembers.status }).from(householdMembers)
      .where(and(eq(householdMembers.householdId, invite.householdId), eq(householdMembers.userId, user.id)))
      .for("update");
    if (existing?.status === "ACTIVE") {
      // Already an active member (e.g. re-accepting a second still-valid invite after being promoted).
      // Don't let the invite's role silently overwrite whatever role they hold today.
    } else if (existing) {
      // Reactivating a previously-removed member — the invite's role applies fresh.
      await tx.update(householdMembers).set({ status: "ACTIVE", role: invite.role, joinedAt: now, invitedByUserId: invite.invitedByUserId })
        .where(and(eq(householdMembers.householdId, invite.householdId), eq(householdMembers.userId, user.id)));
    } else {
      await tx.insert(householdMembers).values({ householdId: invite.householdId, userId: user.id, role: invite.role, status: "ACTIVE", joinedAt: now, invitedByUserId: invite.invitedByUserId });
    }
    await tx.update(householdInvites).set({ acceptedAt: now }).where(eq(householdInvites.id, invite.id));
    await recordAudit(tx, { householdId: invite.householdId, actorUserId: user.id, action: "member.invite_accepted", entityType: "household_invite", entityId: invite.id, ipAddress: ip ?? null });
  });
  const membership = await getMembership(deps.db, user.id, invite.householdId);
  return getHousehold(deps.db, membership!);
}
