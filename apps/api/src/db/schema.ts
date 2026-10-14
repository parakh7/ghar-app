/**
 * Household app — full data model.
 *
 * Conventions
 *  - Every household-scoped table has: id, household_id, created_at, updated_at.
 *  - Child rows reference parents via COMPOSITE foreign keys (household_id, parent_id)
 *    so the database itself rejects cross-household links, even if app code has a bug.
 *  - Money is bigint paise ("*_paise"). Never floats.
 *  - Calendar concepts (due dates, attendance days) are `date`, interpreted in the
 *    household timezone. Instants are `timestamptz` (stored UTC).
 *  - Financial & historical rows are never hard-deleted: archived_at / voided_at.
 *  - "OVERDUE" is derived (due_date < today-in-household-tz AND unpaid), never stored,
 *    so a missed nightly job can never leave a stale status.
 */
import { sql } from "drizzle-orm";
import {
  bigint, boolean, date, foreignKey, index, integer, jsonb, pgEnum, pgTable,
  smallint, text, time, timestamp, unique, uniqueIndex, uuid, check,
} from "drizzle-orm/pg-core";

// ─── helpers ─────────────────────────────────────────────
const id = () => uuid("id").primaryKey().defaultRandom();
const createdAt = () => timestamp("created_at", { withTimezone: true }).notNull().defaultNow();
const updatedAt = () => timestamp("updated_at", { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date());
const tsz = (name: string) => timestamp(name, { withTimezone: true });
const paise = (name: string) => bigint(name, { mode: "number" });
const householdId = () => uuid("household_id").notNull().references(() => households.id, { onDelete: "restrict" });

// ─── enums ───────────────────────────────────────────────
export const householdRole = pgEnum("household_role", ["OWNER", "ADMIN", "MEMBER", "VIEWER"]);
export const memberStatus = pgEnum("member_status", ["ACTIVE", "INVITED", "REMOVED"]);
export const authTokenPurpose = pgEnum("auth_token_purpose", ["EMAIL_VERIFY", "PASSWORD_RESET"]);
export const identityProvider = pgEnum("identity_provider", ["GOOGLE", "APPLE", "PHONE_OTP"]);
export const househelpStatus = pgEnum("househelp_status", ["ACTIVE", "INACTIVE"]);
export const salaryMode = pgEnum("salary_mode", ["FIXED_MONTHLY", "ATTENDANCE_BASED", "DAILY_RATE"]);
export const attendanceStatus = pgEnum("attendance_status", ["PRESENT", "ABSENT", "HALF_DAY", "LEAVE", "HOLIDAY"]);
export const taskFrequency = pgEnum("task_frequency", ["DAILY", "WEEKLY", "WEEKDAYS", "MONTHLY", "SPECIFIC_DATE", "CUSTOM"]);
export const taskPriority = pgEnum("task_priority", ["LOW", "NORMAL", "HIGH"]);
export const completionStatus = pgEnum("completion_status", ["PENDING", "COMPLETED", "SKIPPED"]);
export const settlementStatus = pgEnum("settlement_status", ["PENDING", "PARTIALLY_PAID", "PAID", "CANCELLED"]);
export const adjustmentType = pgEnum("salary_adjustment_type", ["BONUS", "OVERTIME", "DEDUCTION", "ADVANCE", "ADJUSTMENT"]);
export const paymentMethod = pgEnum("payment_method", ["CASH", "UPI", "BANK_TRANSFER", "CARD", "AUTO_DEBIT", "CHEQUE", "OTHER"]);
export const billStatus = pgEnum("bill_status", ["ACTIVE", "PAUSED", "ARCHIVED"]);
export const billFrequency = pgEnum("bill_frequency", ["ONE_TIME", "WEEKLY", "MONTHLY", "QUARTERLY", "HALF_YEARLY", "YEARLY", "CUSTOM"]);
export const occurrenceStatus = pgEnum("bill_occurrence_status", ["PENDING", "PARTIALLY_PAID", "PAID", "WAIVED"]);
export const reminderTarget = pgEnum("reminder_target", ["BILL", "SALARY", "CHECKLIST", "ATTENDANCE"]);
export const notificationCategory = pgEnum("notification_category", ["BILL", "SALARY", "ATTENDANCE", "CHECKLIST", "SYSTEM"]);
export const notificationSeverity = pgEnum("notification_severity", ["INFO", "SUCCESS", "WARNING", "URGENT"]);
export const notificationChannel = pgEnum("notification_channel", ["IN_APP", "WEB_PUSH", "EMAIL", "SMS", "WHATSAPP"]);
export const deliveryStatus = pgEnum("delivery_status", ["PENDING", "SENT", "FAILED", "SKIPPED"]);

// ═══ Identity ════════════════════════════════════════════
export const users = pgTable("users", {
  id: id(),
  name: text("name").notNull(),
  email: text("email").notNull(), // always stored lower-cased
  emailVerifiedAt: tsz("email_verified_at"),
  passwordHash: text("password_hash"), // null for social/OTP-only accounts (future)
  phone: text("phone"), // E.164, future OTP login
  phoneVerifiedAt: tsz("phone_verified_at"),
  locale: text("locale").notNull().default("en-IN"),
  timezone: text("timezone"), // personal override; falls back to household tz
  passwordChangedAt: tsz("password_changed_at"),
  deletedAt: tsz("deleted_at"),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
}, (t) => [
  uniqueIndex("users_email_uq").on(t.email),
  uniqueIndex("users_phone_uq").on(t.phone).where(sql`${t.phone} is not null`),
]);

/** Future Google / Apple / phone-OTP logins attach here — no schema change needed. */
export const authIdentities = pgTable("auth_identities", {
  id: id(),
  userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  provider: identityProvider("provider").notNull(),
  providerSubject: text("provider_subject").notNull(),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
}, (t) => [uniqueIndex("auth_identities_provider_subject_uq").on(t.provider, t.providerSubject), index("auth_identities_user_idx").on(t.userId)]);

export const userSessions = pgTable("user_sessions", {
  id: id(),
  userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  tokenHash: text("token_hash").notNull(), // sha256 of the opaque token; raw token never stored
  userAgent: text("user_agent"),
  ipAddress: text("ip_address"),
  lastSeenAt: tsz("last_seen_at").notNull().defaultNow(),
  expiresAt: tsz("expires_at").notNull(),
  revokedAt: tsz("revoked_at"),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
}, (t) => [uniqueIndex("user_sessions_token_uq").on(t.tokenHash), index("user_sessions_user_idx").on(t.userId, t.revokedAt)]);

export const authTokens = pgTable("auth_tokens", {
  id: id(),
  userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  purpose: authTokenPurpose("purpose").notNull(),
  tokenHash: text("token_hash").notNull(),
  expiresAt: tsz("expires_at").notNull(),
  usedAt: tsz("used_at"),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
}, (t) => [uniqueIndex("auth_tokens_hash_uq").on(t.tokenHash), index("auth_tokens_user_purpose_idx").on(t.userId, t.purpose)]);

// ═══ Households ══════════════════════════════════════════
export const households = pgTable("households", {
  id: id(),
  name: text("name").notNull(),
  timezone: text("timezone").notNull().default("Asia/Kolkata"),
  currency: text("currency").notNull().default("INR"),
  /** RolePermissionOverrides from @household/shared — makes role permissions configurable per household. */
  rolePermissionOverrides: jsonb("role_permission_overrides"),
  onboardingCompletedAt: tsz("onboarding_completed_at"),
  createdByUserId: uuid("created_by_user_id").references(() => users.id, { onDelete: "set null" }),
  archivedAt: tsz("archived_at"),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const householdMembers = pgTable("household_members", {
  id: id(),
  householdId: householdId(),
  userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  role: householdRole("role").notNull(),
  status: memberStatus("status").notNull().default("ACTIVE"),
  displayName: text("display_name"), // "Mother", "Papa"
  invitedByUserId: uuid("invited_by_user_id").references(() => users.id, { onDelete: "set null" }),
  joinedAt: tsz("joined_at"),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
}, (t) => [
  uniqueIndex("household_members_household_user_uq").on(t.householdId, t.userId),
  index("household_members_user_idx").on(t.userId, t.status),
]);

export const householdInvites = pgTable("household_invites", {
  id: id(),
  householdId: householdId(),
  email: text("email").notNull(),
  role: householdRole("role").notNull(),
  tokenHash: text("token_hash").notNull(),
  invitedByUserId: uuid("invited_by_user_id").notNull().references(() => users.id),
  expiresAt: tsz("expires_at").notNull(),
  acceptedAt: tsz("accepted_at"),
  revokedAt: tsz("revoked_at"),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
}, (t) => [uniqueIndex("household_invites_token_uq").on(t.tokenHash), index("household_invites_household_idx").on(t.householdId, t.email)]);

// ═══ Househelps ══════════════════════════════════════════
export const househelpCategories = pgTable("househelp_categories", {
  id: id(),
  householdId: householdId(),
  name: text("name").notNull(),
  sortOrder: integer("sort_order").notNull().default(0),
  isActive: boolean("is_active").notNull().default(true),
  deletedAt: tsz("deleted_at"),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
}, (t) => [
  unique("househelp_categories_hh_id_uq").on(t.householdId, t.id),
  uniqueIndex("househelp_categories_hh_name_uq").on(t.householdId, sql`lower(${t.name})`).where(sql`${t.deletedAt} is null`),
  index("househelp_categories_hh_order_idx").on(t.householdId, t.sortOrder),
]);

export const househelps = pgTable("househelps", {
  id: id(),
  householdId: householdId(),
  name: text("name").notNull(),
  phone: text("phone"),
  photoUrl: text("photo_url"),
  roleTitle: text("role_title"), // free text, e.g. "Cook", "Full-time help"
  status: househelpStatus("status").notNull().default("ACTIVE"),
  startDate: date("start_date"),
  endDate: date("end_date"),
  salaryMode: salaryMode("salary_mode").notNull().default("FIXED_MONTHLY"),
  monthlySalaryPaise: paise("monthly_salary_paise"),
  dailyRatePaise: paise("daily_rate_paise"),
  halfDayRatePaise: paise("half_day_rate_paise"),
  /** 1–31; months shorter than this due on their last day. */
  salaryDueDay: smallint("salary_due_day").notNull().default(1),
  allowedLeavesPerMonth: smallint("allowed_leaves_per_month").notNull().default(0),
  notes: text("notes"),
  archivedAt: tsz("archived_at"),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
}, (t) => [
  unique("househelps_hh_id_uq").on(t.householdId, t.id),
  index("househelps_hh_status_idx").on(t.householdId, t.status),
  check("househelps_due_day_ck", sql`${t.salaryDueDay} between 1 and 31`),
  check("househelps_allowed_leaves_ck", sql`${t.allowedLeavesPerMonth} between 0 and 31`),
  check("househelps_salary_nonneg_ck", sql`coalesce(${t.monthlySalaryPaise},0) >= 0 and coalesce(${t.dailyRatePaise},0) >= 0 and coalesce(${t.halfDayRatePaise},0) >= 0`),
]);

export const househelpCategoryLinks = pgTable("househelp_category_links", {
  id: id(),
  householdId: householdId(),
  househelpId: uuid("househelp_id").notNull(),
  categoryId: uuid("category_id").notNull(),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
}, (t) => [
  uniqueIndex("househelp_category_links_uq").on(t.househelpId, t.categoryId),
  foreignKey({ columns: [t.householdId, t.househelpId], foreignColumns: [househelps.householdId, househelps.id], name: "hcl_househelp_fk" }).onDelete("cascade"),
  foreignKey({ columns: [t.householdId, t.categoryId], foreignColumns: [househelpCategories.householdId, househelpCategories.id], name: "hcl_category_fk" }).onDelete("cascade"),
]);

/** Versioned schedules: analytics for past months use the schedule that applied then. */
export const attendanceSchedules = pgTable("attendance_schedules", {
  id: id(),
  householdId: householdId(),
  househelpId: uuid("househelp_id").notNull(),
  /** ISO weekday numbers 1=Mon … 7=Sun */
  weekdays: smallint("weekdays").array().notNull(),
  startTime: time("start_time"),
  endTime: time("end_time"),
  effectiveFrom: date("effective_from").notNull(),
  effectiveTo: date("effective_to"),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
}, (t) => [
  index("attendance_schedules_hh_helper_idx").on(t.householdId, t.househelpId, t.effectiveFrom),
  foreignKey({ columns: [t.householdId, t.househelpId], foreignColumns: [househelps.householdId, househelps.id], name: "as_househelp_fk" }),
]);

/** NOT_MARKED = no row. Attendance is never inferred automatically. */
export const attendanceRecords = pgTable("attendance_records", {
  id: id(),
  householdId: householdId(),
  househelpId: uuid("househelp_id").notNull(),
  date: date("date").notNull(),
  status: attendanceStatus("status").notNull(),
  note: text("note"),
  markedByUserId: uuid("marked_by_user_id").references(() => users.id, { onDelete: "set null" }),
  markedAt: tsz("marked_at").notNull().defaultNow(),
  /** client-generated id for offline mutation replay (Phase 9) */
  clientMutationId: text("client_mutation_id"),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
}, (t) => [
  uniqueIndex("attendance_helper_date_uq").on(t.househelpId, t.date),
  index("attendance_hh_date_idx").on(t.householdId, t.date),
  index("attendance_hh_helper_idx").on(t.householdId, t.househelpId, t.date),
  uniqueIndex("attendance_client_mutation_uq").on(t.householdId, t.clientMutationId).where(sql`${t.clientMutationId} is not null`),
  foreignKey({ columns: [t.householdId, t.househelpId], foreignColumns: [househelps.householdId, househelps.id], name: "attendance_househelp_fk" }),
]);

// ═══ Checklists ══════════════════════════════════════════
export const checklistTasks = pgTable("checklist_tasks", {
  id: id(),
  householdId: householdId(),
  name: text("name").notNull(),
  description: text("description"),
  categoryId: uuid("category_id"),
  frequency: taskFrequency("frequency").notNull(),
  /** for WEEKLY/WEEKDAYS: ISO weekdays 1–7 */
  weekdays: smallint("weekdays").array(),
  /** for MONTHLY: 1–31 (clamped to month end) */
  dayOfMonth: smallint("day_of_month"),
  /** for SPECIFIC_DATE */
  specificDate: date("specific_date"),
  /** for CUSTOM: every N days from anchor */
  intervalDays: smallint("interval_days"),
  anchorDate: date("anchor_date"),
  preferredTime: time("preferred_time"),
  priority: taskPriority("priority").notNull().default("NORMAL"),
  sortOrder: integer("sort_order").notNull().default(0),
  isActive: boolean("is_active").notNull().default(true),
  archivedAt: tsz("archived_at"),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
}, (t) => [
  unique("checklist_tasks_hh_id_uq").on(t.householdId, t.id),
  index("checklist_tasks_hh_active_idx").on(t.householdId, t.isActive),
  foreignKey({ columns: [t.householdId, t.categoryId], foreignColumns: [househelpCategories.householdId, househelpCategories.id], name: "ct_category_fk" }),
]);

export const checklistAssignments = pgTable("checklist_assignments", {
  id: id(),
  householdId: householdId(),
  taskId: uuid("task_id").notNull(),
  househelpId: uuid("househelp_id").notNull(),
  effectiveFrom: date("effective_from").notNull(),
  effectiveTo: date("effective_to"),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
}, (t) => [
  index("checklist_assignments_hh_helper_idx").on(t.householdId, t.househelpId),
  index("checklist_assignments_task_idx").on(t.taskId),
  foreignKey({ columns: [t.householdId, t.taskId], foreignColumns: [checklistTasks.householdId, checklistTasks.id], name: "ca_task_fk" }),
  foreignKey({ columns: [t.householdId, t.househelpId], foreignColumns: [househelps.householdId, househelps.id], name: "ca_househelp_fk" }),
]);

export const checklistCompletions = pgTable("checklist_completions", {
  id: id(),
  householdId: householdId(),
  taskId: uuid("task_id").notNull(),
  househelpId: uuid("househelp_id"),
  date: date("date").notNull(),
  status: completionStatus("status").notNull(),
  note: text("note"),
  recordedByUserId: uuid("recorded_by_user_id").references(() => users.id, { onDelete: "set null" }),
  recordedAt: tsz("recorded_at").notNull().defaultNow(),
  clientMutationId: text("client_mutation_id"),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
}, (t) => [
  uniqueIndex("checklist_completions_task_date_uq").on(t.taskId, t.date),
  index("checklist_completions_hh_date_idx").on(t.householdId, t.date),
  uniqueIndex("checklist_completions_client_mutation_uq").on(t.householdId, t.clientMutationId).where(sql`${t.clientMutationId} is not null`),
  foreignKey({ columns: [t.householdId, t.taskId], foreignColumns: [checklistTasks.householdId, checklistTasks.id], name: "cc_task_fk" }),
  foreignKey({ columns: [t.householdId, t.househelpId], foreignColumns: [househelps.householdId, househelps.id], name: "cc_househelp_fk" }),
]);

// ═══ Salaries ════════════════════════════════════════════
/** One row per househelp per month. calc_snapshot freezes the exact inputs used, for transparency. */
export const salarySettlements = pgTable("salary_settlements", {
  id: id(),
  householdId: householdId(),
  househelpId: uuid("househelp_id").notNull(),
  periodMonth: date("period_month").notNull(), // always the 1st of the month
  dueDate: date("due_date").notNull(),
  basePaise: paise("base_paise").notNull(),
  workingDays: smallint("working_days").notNull(),
  presentDays: smallint("present_days").notNull().default(0),
  halfDays: smallint("half_days").notNull().default(0),
  absentDays: smallint("absent_days").notNull().default(0),
  leaveDays: smallint("leave_days").notNull().default(0),
  absenceDeductionPaise: paise("absence_deduction_paise").notNull().default(0),
  additionsPaise: paise("additions_paise").notNull().default(0),
  deductionsPaise: paise("deductions_paise").notNull().default(0),
  advancePaise: paise("advance_paise").notNull().default(0),
  netPayablePaise: paise("net_payable_paise").notNull(),
  amountPaidPaise: paise("amount_paid_paise").notNull().default(0),
  status: settlementStatus("status").notNull().default("PENDING"),
  calcSnapshot: jsonb("calc_snapshot"),
  note: text("note"),
  paidAt: tsz("paid_at"),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
}, (t) => [
  unique("salary_settlements_hh_id_uq").on(t.householdId, t.id),
  uniqueIndex("salary_settlements_helper_period_uq").on(t.househelpId, t.periodMonth),
  index("salary_settlements_hh_status_due_idx").on(t.householdId, t.status, t.dueDate),
  check("salary_settlements_period_first_ck", sql`extract(day from ${t.periodMonth}) = 1`),
  foreignKey({ columns: [t.householdId, t.househelpId], foreignColumns: [househelps.householdId, househelps.id], name: "ss_househelp_fk" }),
]);

export const salaryAdjustments = pgTable("salary_adjustments", {
  id: id(),
  householdId: householdId(),
  househelpId: uuid("househelp_id").notNull(),
  settlementId: uuid("settlement_id"),
  periodMonth: date("period_month").notNull(),
  type: adjustmentType("type").notNull(),
  /** Always positive; sign is implied by type (BONUS/OVERTIME add, DEDUCTION/ADVANCE subtract, ADJUSTMENT signed). */
  amountPaise: paise("amount_paise").notNull(),
  reason: text("reason"),
  createdByUserId: uuid("created_by_user_id").references(() => users.id, { onDelete: "set null" }),
  voidedAt: tsz("voided_at"),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
}, (t) => [
  index("salary_adjustments_hh_helper_period_idx").on(t.householdId, t.househelpId, t.periodMonth),
  foreignKey({ columns: [t.householdId, t.househelpId], foreignColumns: [househelps.householdId, househelps.id], name: "sa_househelp_fk" }),
  foreignKey({ columns: [t.householdId, t.settlementId], foreignColumns: [salarySettlements.householdId, salarySettlements.id], name: "sa_settlement_fk" }),
]);

export const salaryPayments = pgTable("salary_payments", {
  id: id(),
  householdId: householdId(),
  househelpId: uuid("househelp_id").notNull(),
  settlementId: uuid("settlement_id").notNull(),
  amountPaise: paise("amount_paise").notNull(),
  paidOn: date("paid_on").notNull(),
  method: paymentMethod("method").notNull(),
  reference: text("reference"),
  notes: text("notes"),
  recordedByUserId: uuid("recorded_by_user_id").references(() => users.id, { onDelete: "set null" }),
  voidedAt: tsz("voided_at"),
  voidReason: text("void_reason"),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
}, (t) => [
  index("salary_payments_hh_helper_idx").on(t.householdId, t.househelpId, t.paidOn),
  check("salary_payments_positive_ck", sql`${t.amountPaise} > 0`),
  foreignKey({ columns: [t.householdId, t.househelpId], foreignColumns: [househelps.householdId, househelps.id], name: "sp_househelp_fk" }),
  foreignKey({ columns: [t.householdId, t.settlementId], foreignColumns: [salarySettlements.householdId, salarySettlements.id], name: "sp_settlement_fk" }),
]);

// ═══ Bills ═══════════════════════════════════════════════
export const billCategories = pgTable("bill_categories", {
  id: id(),
  householdId: householdId(),
  name: text("name").notNull(),
  icon: text("icon"),
  sortOrder: integer("sort_order").notNull().default(0),
  isActive: boolean("is_active").notNull().default(true),
  deletedAt: tsz("deleted_at"),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
}, (t) => [
  unique("bill_categories_hh_id_uq").on(t.householdId, t.id),
  uniqueIndex("bill_categories_hh_name_uq").on(t.householdId, sql`lower(${t.name})`).where(sql`${t.deletedAt} is null`),
]);

/** Bill DEFINITION. Each due instance is a bill_occurrence; each payment a bill_payment. */
export const bills = pgTable("bills", {
  id: id(),
  householdId: householdId(),
  name: text("name").notNull(),
  categoryId: uuid("category_id"),
  provider: text("provider"),
  accountNumber: text("account_number"),
  /** null when amount varies each cycle (e.g. electricity); occurrence carries the actual amount */
  amountPaise: paise("amount_paise"),
  frequency: billFrequency("frequency").notNull(),
  /** CUSTOM: every N units of interval_unit */
  intervalCount: smallint("interval_count").notNull().default(1),
  intervalUnit: text("interval_unit"), // 'day' | 'week' | 'month' (CUSTOM only)
  /** First due date; the recurrence anchor (day-of-month derived from here, clamped per month). */
  firstDueDate: date("first_due_date").notNull(),
  endDate: date("end_date"),
  paymentMethod: paymentMethod("payment_method"),
  autopay: boolean("autopay").notNull().default(false),
  status: billStatus("status").notNull().default("ACTIVE"),
  notes: text("notes"),
  archivedAt: tsz("archived_at"),
  createdByUserId: uuid("created_by_user_id").references(() => users.id, { onDelete: "set null" }),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
}, (t) => [
  unique("bills_hh_id_uq").on(t.householdId, t.id),
  index("bills_hh_status_idx").on(t.householdId, t.status),
  check("bills_amount_nonneg_ck", sql`coalesce(${t.amountPaise},0) >= 0`),
  check("bills_interval_ck", sql`${t.intervalCount} >= 1`),
  foreignKey({ columns: [t.householdId, t.categoryId], foreignColumns: [billCategories.householdId, billCategories.id], name: "bills_category_fk" }),
]);

export const billOccurrences = pgTable("bill_occurrences", {
  id: id(),
  householdId: householdId(),
  billId: uuid("bill_id").notNull(),
  sequence: integer("sequence").notNull(), // 0 = first occurrence
  dueDate: date("due_date").notNull(),
  amountDuePaise: paise("amount_due_paise").notNull(),
  amountPaidPaise: paise("amount_paid_paise").notNull().default(0),
  status: occurrenceStatus("status").notNull().default("PENDING"),
  paidAt: tsz("paid_at"),
  waivedAt: tsz("waived_at"),
  waivedByUserId: uuid("waived_by_user_id").references(() => users.id, { onDelete: "set null" }),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
}, (t) => [
  unique("bill_occurrences_hh_id_uq").on(t.householdId, t.id),
  uniqueIndex("bill_occurrences_bill_seq_uq").on(t.billId, t.sequence), // idempotent generation
  index("bill_occurrences_hh_due_idx").on(t.householdId, t.dueDate),
  index("bill_occurrences_hh_status_due_idx").on(t.householdId, t.status, t.dueDate),
  check("bill_occurrences_amounts_ck", sql`${t.amountDuePaise} >= 0 and ${t.amountPaidPaise} >= 0`),
  foreignKey({ columns: [t.householdId, t.billId], foreignColumns: [bills.householdId, bills.id], name: "bo_bill_fk" }),
]);

export const billPayments = pgTable("bill_payments", {
  id: id(),
  householdId: householdId(),
  billId: uuid("bill_id").notNull(),
  occurrenceId: uuid("occurrence_id").notNull(),
  amountPaise: paise("amount_paise").notNull(),
  paidOn: date("paid_on").notNull(),
  method: paymentMethod("method").notNull(),
  transactionRef: text("transaction_ref"),
  notes: text("notes"),
  recordedByUserId: uuid("recorded_by_user_id").references(() => users.id, { onDelete: "set null" }),
  voidedAt: tsz("voided_at"),
  voidReason: text("void_reason"),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
}, (t) => [
  index("bill_payments_hh_paid_idx").on(t.householdId, t.paidOn),
  index("bill_payments_occurrence_idx").on(t.occurrenceId),
  check("bill_payments_positive_ck", sql`${t.amountPaise} > 0`),
  foreignKey({ columns: [t.householdId, t.billId], foreignColumns: [bills.householdId, bills.id], name: "bp_bill_fk" }),
  foreignKey({ columns: [t.householdId, t.occurrenceId], foreignColumns: [billOccurrences.householdId, billOccurrences.id], name: "bp_occurrence_fk" }),
]);

/** "Other" household expenses for the monthly expense dashboard. */
export const householdExpenses = pgTable("household_expenses", {
  id: id(),
  householdId: householdId(),
  description: text("description").notNull(),
  category: text("category"),
  amountPaise: paise("amount_paise").notNull(),
  spentOn: date("spent_on").notNull(),
  method: paymentMethod("method"),
  recordedByUserId: uuid("recorded_by_user_id").references(() => users.id, { onDelete: "set null" }),
  voidedAt: tsz("voided_at"),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
}, (t) => [index("household_expenses_hh_date_idx").on(t.householdId, t.spentOn), check("household_expenses_positive_ck", sql`${t.amountPaise} > 0`)]);

// ═══ Reminders & notifications ═══════════════════════════
/**
 * target_id NULL = household default for that target type.
 * offsets_days: e.g. {7,3,1,0} — days BEFORE due; 0 = on due date.
 */
export const reminderRules = pgTable("reminder_rules", {
  id: id(),
  householdId: householdId(),
  targetType: reminderTarget("target_type").notNull(),
  targetId: uuid("target_id"),
  offsetsDays: smallint("offsets_days").array().notNull(),
  overdueDaily: boolean("overdue_daily").notNull().default(true),
  sendHour: smallint("send_hour").notNull().default(9), // household-local hour
  isActive: boolean("is_active").notNull().default(true),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
}, (t) => [
  uniqueIndex("reminder_rules_target_uq").on(t.householdId, t.targetType, sql`coalesce(${t.targetId}, '00000000-0000-0000-0000-000000000000'::uuid)`),
  check("reminder_rules_hour_ck", sql`${t.sendHour} between 0 and 23`),
]);

/** Per USER per household — Father can want bill reminders while Mother doesn't. */
export const notificationPreferences = pgTable("notification_preferences", {
  id: id(),
  householdId: householdId(),
  userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  category: notificationCategory("category").notNull(),
  enabled: boolean("enabled").notNull().default(true),
  channels: notificationChannel("channels").array().notNull().default(sql`'{IN_APP,WEB_PUSH}'::notification_channel[]`),
  /** optional personal override of reminder offsets / hour */
  offsetsDays: smallint("offsets_days").array(),
  sendHour: smallint("send_hour"),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
}, (t) => [uniqueIndex("notification_prefs_uq").on(t.householdId, t.userId, t.category)]);

export const notifications = pgTable("notifications", {
  id: id(),
  householdId: householdId(),
  userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  category: notificationCategory("category").notNull(),
  severity: notificationSeverity("severity").notNull().default("INFO"),
  title: text("title").notNull(),
  body: text("body"),
  entityType: text("entity_type"),
  entityId: uuid("entity_id"),
  data: jsonb("data"),
  /** e.g. "bill_occ:<id>:before:3:user:<id>" — a re-run of any job can never duplicate. */
  idempotencyKey: text("idempotency_key").notNull(),
  readAt: tsz("read_at"),
  dismissedAt: tsz("dismissed_at"),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
}, (t) => [
  uniqueIndex("notifications_idempotency_uq").on(t.idempotencyKey),
  index("notifications_user_hh_created_idx").on(t.userId, t.householdId, t.createdAt),
  index("notifications_user_unread_idx").on(t.userId, t.householdId).where(sql`${t.readAt} is null and ${t.dismissedAt} is null`),
]);

export const notificationDeliveries = pgTable("notification_deliveries", {
  id: id(),
  householdId: householdId(),
  notificationId: uuid("notification_id").notNull().references(() => notifications.id, { onDelete: "cascade" }),
  channel: notificationChannel("channel").notNull(),
  status: deliveryStatus("status").notNull().default("PENDING"),
  attempts: smallint("attempts").notNull().default(0),
  lastError: text("last_error"),
  sentAt: tsz("sent_at"),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
}, (t) => [uniqueIndex("notification_deliveries_uq").on(t.notificationId, t.channel), index("notification_deliveries_status_idx").on(t.status, t.createdAt)]);

export const pushSubscriptions = pgTable("push_subscriptions", {
  id: id(),
  userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  endpoint: text("endpoint").notNull(),
  p256dh: text("p256dh").notNull(),
  auth: text("auth").notNull(),
  userAgent: text("user_agent"),
  lastUsedAt: tsz("last_used_at"),
  revokedAt: tsz("revoked_at"),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
}, (t) => [uniqueIndex("push_subscriptions_endpoint_uq").on(t.endpoint), index("push_subscriptions_user_idx").on(t.userId)]);

// ═══ Audit ═══════════════════════════════════════════════
export const auditLogs = pgTable("audit_logs", {
  id: id(),
  householdId: uuid("household_id").references(() => households.id, { onDelete: "restrict" }), // null for account-level events
  actorUserId: uuid("actor_user_id").references(() => users.id, { onDelete: "set null" }),
  action: text("action").notNull(), // e.g. "attendance.marked", "bill.created"
  entityType: text("entity_type").notNull(),
  entityId: uuid("entity_id"),
  oldValue: jsonb("old_value"),
  newValue: jsonb("new_value"),
  ipAddress: text("ip_address"),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
}, (t) => [
  index("audit_logs_hh_created_idx").on(t.householdId, t.createdAt),
  index("audit_logs_entity_idx").on(t.entityType, t.entityId),
]);

