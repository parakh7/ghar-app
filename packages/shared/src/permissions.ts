export const HOUSEHOLD_ROLES = ["OWNER", "ADMIN", "MEMBER", "VIEWER"] as const;
export type HouseholdRole = (typeof HOUSEHOLD_ROLES)[number];

/**
 * Fine-grained permissions. Routes check permissions, never roles directly,
 * so new roles or per-household overrides don't require touching route code.
 */
export const PERMISSIONS = [
  "household.view",
  "household.manage",      // rename, settings, timezone
  "household.delete",
  "members.view",
  "members.manage",        // invite, remove, change roles
  "househelps.view",
  "househelps.manage",
  "categories.manage",
  "attendance.view",
  "attendance.mark",
  "attendance.editHistory",
  "checklists.view",
  "checklists.manage",
  "checklists.complete",
  "checklists.editHistory",
  "salaries.view",
  "salaries.manage",       // adjustments, settlement
  "salaries.pay",          // record salary payment
  "bills.view",
  "bills.manage",
  "payments.record",       // record bill payment
  "reports.view",
  "audit.view",
] as const;
export type Permission = (typeof PERMISSIONS)[number];

const VIEW: Permission[] = PERMISSIONS.filter((p) => p.endsWith(".view")) as Permission[];

export const DEFAULT_ROLE_PERMISSIONS: Record<HouseholdRole, readonly Permission[]> = {
  OWNER: PERMISSIONS,
  ADMIN: PERMISSIONS.filter((p) => p !== "household.delete" && p !== "members.manage"),
  MEMBER: [...VIEW.filter((p) => p !== "audit.view"), "attendance.mark", "checklists.complete", "payments.record", "salaries.pay"],
  VIEWER: VIEW.filter((p) => p !== "audit.view"),
};

/** Per-household overrides: { MEMBER: { grant: ["bills.manage"], revoke: ["salaries.pay"] } } */
export type RolePermissionOverrides = Partial<Record<HouseholdRole, { grant?: Permission[]; revoke?: Permission[] }>>;

/** OWNER can never lose permissions — prevents a household locking itself out. */
export function resolvePermissions(role: HouseholdRole, overrides?: RolePermissionOverrides | null): Set<Permission> {
  const set = new Set<Permission>(DEFAULT_ROLE_PERMISSIONS[role]);
  if (role === "OWNER" || !overrides) return set;
  const o = overrides[role];
  o?.grant?.forEach((p) => { if ((PERMISSIONS as readonly string[]).includes(p)) set.add(p); });
  o?.revoke?.forEach((p) => set.delete(p));
  return set;
}

export function hasPermission(role: HouseholdRole, permission: Permission, overrides?: RolePermissionOverrides | null): boolean {
  return resolvePermissions(role, overrides).has(permission);
}
