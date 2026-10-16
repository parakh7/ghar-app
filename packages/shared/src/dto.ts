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
/** Only createInvite/resendInvite return the link — by design, listInvites never re-exposes it. */
export type InviteWithLinkDTO = InviteDTO & { link: string };

export type CategoryDTO = { id: string; name: string; sortOrder: number; isActive: boolean };
export type BillCategoryDTO = { id: string; name: string; icon: string | null; sortOrder: number; isActive: boolean };

export type BillFrequency = "ONE_TIME" | "WEEKLY" | "MONTHLY" | "QUARTERLY" | "HALF_YEARLY" | "YEARLY" | "CUSTOM";
export type BillStatus = "ACTIVE" | "PAUSED" | "ARCHIVED";

export type BillDTO = {
  id: string; name: string; categoryId: string | null; provider: string | null; accountNumber: string | null;
  amountPaise: number | null; frequency: BillFrequency; intervalCount: number; intervalUnit: string | null;
  firstDueDate: string; endDate: string | null; paymentMethod: PaymentMethod | null; autopay: boolean;
  status: BillStatus; notes: string | null; archivedAt: string | null; createdAt: string;
};

export type OccurrenceStatus = "PENDING" | "PARTIALLY_PAID" | "PAID" | "WAIVED";

export type BillOccurrenceDTO = {
  id: string; billId: string; sequence: number; dueDate: string;
  amountDuePaise: number; amountPaidPaise: number; status: OccurrenceStatus;
  paidAt: string | null; waivedAt: string | null; createdAt: string;
};

export type HousehelpDTO = {
  id: string; name: string; phone: string | null; roleTitle: string | null;
  status: "ACTIVE" | "INACTIVE"; startDate: string | null; endDate: string | null;
  salaryMode: "FIXED_MONTHLY" | "ATTENDANCE_BASED" | "DAILY_RATE";
  monthlySalaryPaise: number | null; dailyRatePaise: number | null; halfDayRatePaise: number | null;
  salaryDueDay: number; allowedLeavesPerMonth: number; notes: string | null; archivedAt: string | null;
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

export type MarkRemainingPresentResultDTO = { month: string; count: number };

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
  absentDays: number; leaveDays: number; holidayDays: number; absenceDeductionPaise: number;
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

export type BillPaymentDTO = {
  id: string; occurrenceId: string; amountPaise: number; paidOn: string; method: PaymentMethod;
  transactionRef: string | null; notes: string | null; voidedAt: string | null; voidReason: string | null; createdAt: string;
};

export type ReminderTargetType = "BILL" | "SALARY" | "CHECKLIST" | "ATTENDANCE";

export type ReminderRuleDTO = {
  id: string; targetType: ReminderTargetType; targetId: string | null;
  offsetsDays: number[]; overdueDaily: boolean; sendHour: number; isActive: boolean; createdAt: string;
};

export type NotificationCategory = "BILL" | "SALARY" | "ATTENDANCE" | "CHECKLIST" | "SYSTEM";
export type NotificationSeverity = "INFO" | "SUCCESS" | "WARNING" | "URGENT";

export type NotificationDTO = {
  id: string; category: NotificationCategory; severity: NotificationSeverity;
  title: string; body: string | null; linkPath: string | null;
  readAt: string | null; dismissedAt: string | null; createdAt: string;
};

export type SettableNotificationCategory = "BILL" | "SALARY";

export type NotificationPreferenceDTO = {
  category: SettableNotificationCategory; enabled: boolean; emailEnabled: boolean;
};

export type TodayAttendanceSummaryDTO = { marked: number; total: number };
export type TodayChecklistSummaryDTO = { done: number; total: number; pending: string[] };
export type TodayBillDTO = {
  occurrenceId: string; billId: string; billName: string;
  amountDuePaise: number; dueDate: string; isOverdue: boolean;
};
export type TodaySalaryDTO = {
  settlementId: string; househelpName: string; periodMonth: string;
  dueDate: string; netDuePaise: number; status: SettlementStatus;
};
export type TodaySalarySectionDTO = { upcoming: TodaySalaryDTO | null; hasAnySettlement: boolean };

export type TodayDashboardDTO = {
  attendance?: TodayAttendanceSummaryDTO;
  checklist?: TodayChecklistSummaryDTO;
  bills?: TodayBillDTO[];
  salary?: TodaySalarySectionDTO;
};

export type SearchHousehelpResultDTO = { id: string; name: string };
export type SearchBillResultDTO = { id: string; name: string; provider: string | null };
export type SearchChecklistTaskResultDTO = { id: string; name: string };
export type SearchMemberResultDTO = { userId: string; name: string; email: string };

export type SearchResultsDTO = {
  househelps?: SearchHousehelpResultDTO[];
  bills?: SearchBillResultDTO[];
  checklistTasks?: SearchChecklistTaskResultDTO[];
  members?: SearchMemberResultDTO[];
};

export type ReportType = "bills" | "salary" | "attendance" | "checklist";

export type BillsReportRowDTO = {
  occurrenceId: string; billId: string; billName: string; dueDate: string;
  amountDuePaise: number; amountPaidPaise: number; status: OccurrenceStatus;
};
export type BillsReportDTO = { type: "bills"; rows: BillsReportRowDTO[]; totalDuePaise: number; totalPaidPaise: number };

export type SalaryReportRowDTO = {
  settlementId: string; househelpId: string; househelpName: string;
  netPayablePaise: number; amountPaidPaise: number; status: SettlementStatus;
};
export type SalaryReportDTO = { type: "salary"; rows: SalaryReportRowDTO[]; totalNetPayablePaise: number; totalPaidPaise: number };

export type AttendanceReportRowDTO = {
  househelpId: string; name: string; present: number; absent: number; halfDay: number; leave: number; holiday: number;
};
export type AttendanceReportDTO = { type: "attendance"; rows: AttendanceReportRowDTO[] };

export type ChecklistReportRowDTO = {
  taskId: string; name: string; dueCount: number; completedCount: number; skippedCount: number; missedCount: number;
};
export type ChecklistReportDTO = { type: "checklist"; rows: ChecklistReportRowDTO[] };

export type ReportDTO = BillsReportDTO | SalaryReportDTO | AttendanceReportDTO | ChecklistReportDTO;
