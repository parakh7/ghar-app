import { and, asc, count, eq } from "drizzle-orm";
import type { HouseholdRole, MemberDTO, UpdateMemberInput } from "@household/shared";
import { householdMembers, users } from "../db/schema.js";
import type { DbOrTx } from "../db/client.js";
import { Errors } from "../lib/errors.js";
import { recordAudit } from "./audit.service.js";
import type { Deps } from "./deps.js";
import type { Membership } from "./household.service.js";

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

/** Counts ACTIVE owners. Pass a transaction and lock the target row first so this can't race a concurrent demotion/removal. */
async function countActiveOwners(tx: DbOrTx, householdId: string): Promise<number> {
  const [row] = await tx.select({ n: count() }).from(householdMembers)
    .where(and(eq(householdMembers.householdId, householdId), eq(householdMembers.role, "OWNER"), eq(householdMembers.status, "ACTIVE")));
  return Number(row?.n ?? 0);
}

const LAST_OWNER_ERROR = "A household needs at least one owner.";

export async function updateMember(
  deps: Deps, actorUserId: string, membership: Membership, targetUserId: string, patch: UpdateMemberInput, ip?: string,
): Promise<MemberDTO> {
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
