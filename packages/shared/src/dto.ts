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

export type AttendanceStatus = "PRESENT" | "ABSENT" | "HALF_DAY" | "LEAVE" | "HOLIDAY";

export type AttendanceRecordDTO = { date: string; status: AttendanceStatus; note: string | null };

export type TodayAttendanceEntryDTO = {
  househelpId: string; name: string; roleTitle: string | null;
  scheduledToday: boolean; status: AttendanceStatus | null; note: string | null;
};

export type TodayAttendanceDTO = { date: string; entries: TodayAttendanceEntryDTO[] };

export type MarkHolidayResultDTO = { date: string; count: number };

export type TaskFrequency = "DAILY" | "WEEKLY" | "WEEKDAYS" | "MONTHLY" | "SPECIFIC_DATE" | "CUSTOM";
export type TaskPriority = "LOW" | "NORMAL" | "HIGH";

export type ChecklistTaskDTO = {
  id: string; name: string; description: string | null; categoryId: string | null;
  frequency: TaskFrequency; weekdays: number[] | null; dayOfMonth: number | null;
  specificDate: string | null; intervalDays: number | null; anchorDate: string | null;
  preferredTime: string | null; priority: TaskPriority; sortOrder: number;
  isActive: boolean; archivedAt: string | null; createdAt: string;
};

export type CompletionStatus = "PENDING" | "COMPLETED" | "SKIPPED";

export type TodayChecklistEntryDTO = { taskId: string; name: string; status: "COMPLETED" | "SKIPPED" | null; note: string | null };

export type TodayChecklistDTO = { date: string; entries: TodayChecklistEntryDTO[] };

export type SettlementStatus = "PENDING" | "PARTIALLY_PAID" | "PAID" | "CANCELLED";
export type AdjustmentType = "BONUS" | "OVERTIME" | "DEDUCTION" | "ADVANCE" | "ADJUSTMENT";
export type PaymentMethod = "CASH" | "UPI" | "BANK_TRANSFER" | "CARD" | "AUTO_DEBIT" | "CHEQUE" | "OTHER";

export type SettlementDTO = {
  id: string; househelpId: string; periodMonth: string; dueDate: string;
  basePaise: number; workingDays: number; presentDays: number; halfDays: number;
  absentDays: number; leaveDays: number; absenceDeductionPaise: number;
  additionsPaise: number; deductionsPaise: number; advancePaise: number;
  netPayablePaise: number; amountPaidPaise: number; status: SettlementStatus;
  note: string | null; paidAt: string | null;
};

export type AdjustmentDTO = {
  id: string; househelpId: string; settlementId: string | null; periodMonth: string;
  type: AdjustmentType; amountPaise: number; reason: string | null;
  voidedAt: string | null; createdAt: string;
};

export type SalaryPaymentDTO = {
  id: string; settlementId: string; amountPaise: number; paidOn: string; method: PaymentMethod;
  reference: string | null; notes: string | null; voidedAt: string | null; createdAt: string;
};
