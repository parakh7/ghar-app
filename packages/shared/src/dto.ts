import type { HouseholdRole, Permission } from "./permissions.js";

export type UserDTO = { id: string; name: string; email: string; emailVerified: boolean; createdAt: string };

export type HouseholdSummaryDTO = {
  id: string;
  name: string;
  timezone: string;
  role: HouseholdRole;
  memberCount: number;
};

export type HouseholdDTO = HouseholdSummaryDTO & { permissions: Permission[]; createdAt: string };

export type MeDTO = { user: UserDTO; households: HouseholdSummaryDTO[] };

export type MemberDTO = { userId: string; name: string; email: string; role: HouseholdRole; displayName: string | null; joinedAt: string };
export type InviteDTO = { id: string; email: string; role: HouseholdRole; expiresAt: string; createdAt: string };
