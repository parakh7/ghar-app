import { and, asc, count, eq, isNull } from "drizzle-orm";
import {
  resolvePermissions, type CreateHouseholdInput, type HouseholdDTO, type HouseholdRole,
  type HouseholdSummaryDTO, type RolePermissionOverrides,
} from "@household/shared";
import {
  billCategories, householdMembers, households, househelpCategories, notificationPreferences, reminderRules,
} from "../db/schema.js";
import type { DbOrTx } from "../db/client.js";
import { recordAudit } from "./audit.service.js";
import type { Deps } from "./deps.js";

/** Suggestions only — inserted as ordinary, editable household rows. Nothing is hard-coded elsewhere. */
export const DEFAULT_HOUSEHELP_CATEGORIES = ["Cleaning", "Cooking", "Utensils", "Dusting", "Laundry", "Ironing", "Driver", "Gardening", "Babysitting", "Other"];
export const DEFAULT_BILL_CATEGORIES: { name: string; icon: string }[] = [
  { name: "Electricity", icon: "zap" }, { name: "Internet", icon: "wifi" }, { name: "Mobile", icon: "smartphone" },
  { name: "Gas", icon: "flame" }, { name: "Water", icon: "droplet" }, { name: "Society maintenance", icon: "building" },
  { name: "Rent", icon: "home" }, { name: "Insurance", icon: "shield" }, { name: "Credit card", icon: "credit-card" },
  { name: "Subscriptions", icon: "tv" }, { name: "Newspaper", icon: "newspaper" }, { name: "School fees", icon: "graduation-cap" },
  { name: "Property tax", icon: "landmark" }, { name: "Other", icon: "receipt" },
];
export const DEFAULT_REMINDERS = {
  BILL: { offsetsDays: [7, 3, 1, 0], overdueDaily: true, sendHour: 9 },
  SALARY: { offsetsDays: [3, 0], overdueDaily: true, sendHour: 9 },
} as const;

export type Membership = { householdId: string; role: HouseholdRole; timezone: string; name: string; overrides: RolePermissionOverrides | null };

/** THE authorization primitive. Returns null when the user is not an ACTIVE member — callers must 404. */
export async function getMembership(db: DbOrTx, userId: string, householdId: string): Promise<Membership | null> {
  const [row] = await db
    .select({ householdId: households.id, role: householdMembers.role, timezone: households.timezone, name: households.name, overrides: households.rolePermissionOverrides })
    .from(householdMembers)
    .innerJoin(households, eq(households.id, householdMembers.householdId))
    .where(and(eq(householdMembers.userId, userId), eq(householdMembers.householdId, householdId), eq(householdMembers.status, "ACTIVE"), isNull(households.archivedAt)))
    .limit(1);
  return row ? { ...row, overrides: (row.overrides as RolePermissionOverrides | null) ?? null } : null;
}

export async function listHouseholdsForUser(db: DbOrTx, userId: string): Promise<HouseholdSummaryDTO[]> {
  const mine = await db
    .select({ id: households.id, name: households.name, timezone: households.timezone, role: householdMembers.role })
    .from(householdMembers)
    .innerJoin(households, eq(households.id, householdMembers.householdId))
    .where(and(eq(householdMembers.userId, userId), eq(householdMembers.status, "ACTIVE"), isNull(households.archivedAt)))
    .orderBy(asc(households.createdAt));
  if (mine.length === 0) return [];

  // one grouped query, not N+1
  const counts = await db
    .select({ householdId: householdMembers.householdId, n: count() })
    .from(householdMembers)
    .where(eq(householdMembers.status, "ACTIVE"))
    .groupBy(householdMembers.householdId);
  const byId = new Map(counts.map((c) => [c.householdId, Number(c.n)]));
  return mine.map((h) => ({ ...h, memberCount: byId.get(h.id) ?? 1 }));
}

export async function getHousehold(db: DbOrTx, membership: Membership): Promise<HouseholdDTO> {
  const [h] = await db.select().from(households).where(eq(households.id, membership.householdId)).limit(1);
  const [{ n } = { n: 1 }] = await db.select({ n: count() }).from(householdMembers)
    .where(and(eq(householdMembers.householdId, membership.householdId), eq(householdMembers.status, "ACTIVE")));
  return {
    id: h!.id, name: h!.name, timezone: h!.timezone, role: membership.role, memberCount: Number(n),
    permissions: [...resolvePermissions(membership.role, membership.overrides)], createdAt: h!.createdAt.toISOString(),
  };
}

export async function createHousehold(deps: Deps, userId: string, input: CreateHouseholdInput, ip?: string): Promise<HouseholdDTO> {
  const timezone = input.timezone ?? "Asia/Kolkata";
  const household = await deps.db.transaction(async (tx) => {
    const [h] = await tx.insert(households).values({ name: input.name, timezone, createdByUserId: userId }).returning();
    const householdId = h!.id;
    await tx.insert(householdMembers).values({ householdId, userId, role: "OWNER", status: "ACTIVE", joinedAt: deps.clock.now() });
    await tx.insert(househelpCategories).values(DEFAULT_HOUSEHELP_CATEGORIES.map((name, i) => ({ householdId, name, sortOrder: i })));
    await tx.insert(billCategories).values(DEFAULT_BILL_CATEGORIES.map((c, i) => ({ householdId, name: c.name, icon: c.icon, sortOrder: i })));
    await tx.insert(reminderRules).values([
      { householdId, targetType: "BILL", targetId: null, ...DEFAULT_REMINDERS.BILL, offsetsDays: [...DEFAULT_REMINDERS.BILL.offsetsDays] },
      { householdId, targetType: "SALARY", targetId: null, ...DEFAULT_REMINDERS.SALARY, offsetsDays: [...DEFAULT_REMINDERS.SALARY.offsetsDays] },
    ]);
    await tx.insert(notificationPreferences).values(
      (["BILL", "SALARY", "ATTENDANCE", "CHECKLIST", "SYSTEM"] as const).map((category) => ({ householdId, userId, category, enabled: true })),
    );
    await recordAudit(tx, { householdId, actorUserId: userId, action: "household.created", entityType: "household", entityId: householdId, newValue: { name: h!.name, timezone }, ipAddress: ip ?? null });
    return h!;
  });
  deps.logger.info({ householdId: household.id, userId, event: "household.created" }, "household created");
  return getHousehold(deps.db, { householdId: household.id, role: "OWNER", timezone: household.timezone, name: household.name, overrides: null });
}

export async function updateHousehold(deps: Deps, actorUserId: string, membership: Membership, patch: { name?: string | undefined; timezone?: string | undefined }, ip?: string): Promise<HouseholdDTO> {
  await deps.db.transaction(async (tx) => {
    const [before] = await tx.select({ name: households.name, timezone: households.timezone }).from(households).where(eq(households.id, membership.householdId)).for("update");
    const changes = Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined));
    if (Object.keys(changes).length === 0) return;
    await tx.update(households).set(changes).where(eq(households.id, membership.householdId));
    await recordAudit(tx, { householdId: membership.householdId, actorUserId, action: "household.updated", entityType: "household", entityId: membership.householdId, oldValue: before, newValue: changes, ipAddress: ip ?? null });
  });
  const fresh = await getMembership(deps.db, actorUserId, membership.householdId);
  return getHousehold(deps.db, fresh!);
}
