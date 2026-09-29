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

export type CategoryDTO = { id: string; name: string; sortOrder: number; isActive: boolean };

export type HousehelpDTO = {
  id: string; name: string; phone: string | null; roleTitle: string | null;
  status: "ACTIVE" | "INACTIVE"; startDate: string | null; endDate: string | null;
  salaryMode: "FIXED_MONTHLY" | "ATTENDANCE_BASED" | "DAILY_RATE";
  monthlySalaryPaise: number | null; dailyRatePaise: number | null; halfDayRatePaise: number | null;
  salaryDueDay: number; notes: string | null; archivedAt: string | null;
  categoryIds: string[]; createdAt: string;
};

export type ScheduleDTO = { id: string; weekdays: number[]; startTime: string | null; endTime: string | null; effectiveFrom: string };
