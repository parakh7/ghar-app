import { z } from "zod";
import { isValidTimeZone } from "./time.js";

export const emailSchema = z.string().trim().toLowerCase().email("Enter a valid email address").max(254);

/** Length over complexity rules (NIST 800-63B). Upper bound stops hash-DoS. */
export const passwordSchema = z
  .string()
  .min(8, "Use at least 8 characters")
  .max(128, "Use at most 128 characters");

export const nameSchema = z.string().trim().min(1, "Enter your name").max(80);

export const signupSchema = z.object({ name: nameSchema, email: emailSchema, password: passwordSchema });
export const loginSchema = z.object({ email: emailSchema, password: z.string().min(1, "Enter your password").max(128) });
export const forgotPasswordSchema = z.object({ email: emailSchema });
export const resetPasswordSchema = z.object({ token: z.string().min(20).max(200), password: passwordSchema });
export const verifyEmailSchema = z.object({ token: z.string().min(20).max(200) });
export const changePasswordSchema = z.object({ currentPassword: z.string().min(1).max(128), newPassword: passwordSchema });

export const createHouseholdSchema = z.object({
  name: z.string().trim().min(1, "Give your household a name").max(60),
  timezone: z.string().refine(isValidTimeZone, "Unknown timezone").default("Asia/Kolkata"),
});
export const updateHouseholdSchema = z.object({
  name: z.string().trim().min(1, "Give your household a name").max(60).optional(),
  timezone: z.string().refine(isValidTimeZone, "Unknown timezone").optional(),
});

export type SignupInput = z.infer<typeof signupSchema>;
export type LoginInput = z.infer<typeof loginSchema>;
export type ForgotPasswordInput = z.infer<typeof forgotPasswordSchema>;
export type ResetPasswordInput = z.infer<typeof resetPasswordSchema>;
export type CreateHouseholdInput = z.input<typeof createHouseholdSchema>;

export const inviteMemberSchema = z.object({
  email: emailSchema,
  role: z.enum(["ADMIN", "MEMBER", "VIEWER"]),
});
export const updateMemberSchema = z.object({
  role: z.enum(["OWNER", "ADMIN", "MEMBER", "VIEWER"]).optional(),
  displayName: z.string().trim().max(40).optional(),
}).refine((v) => v.role !== undefined || v.displayName !== undefined, { message: "Provide a role or display name to update." });
export const acceptInviteSchema = z.object({ token: z.string().min(20).max(200) });

export type InviteMemberInput = z.infer<typeof inviteMemberSchema>;
export type UpdateMemberInput = z.infer<typeof updateMemberSchema>;
export type AcceptInviteInput = z.infer<typeof acceptInviteSchema>;

export const dateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use YYYY-MM-DD");
export const timeSchema = z.string().regex(/^([01]\d|2[0-3]):([0-5]\d)$/, "Use 24-hour HH:MM");
const paiseSchema = z.number().int().nonnegative();
const salaryModeSchema = z.enum(["FIXED_MONTHLY", "ATTENDANCE_BASED", "DAILY_RATE"]);

export const createCategorySchema = z.object({ name: z.string().trim().min(1, "Give the category a name").max(60) });
export const updateCategorySchema = z.object({
  name: z.string().trim().min(1, "Give the category a name").max(60).optional(),
  isActive: z.boolean().optional(),
}).refine((v) => v.name !== undefined || v.isActive !== undefined, { message: "Provide a name or active state to update." });
export const moveCategorySchema = z.object({ direction: z.enum(["up", "down"]) });

export const createBillCategorySchema = z.object({
  name: z.string().trim().min(1, "Give the category a name").max(60),
  icon: z.string().trim().max(60).optional(),
});
export const updateBillCategorySchema = z.object({
  name: z.string().trim().min(1, "Give the category a name").max(60).optional(),
  icon: z.string().trim().max(60).nullable().optional(),
  isActive: z.boolean().optional(),
}).refine((v) => v.name !== undefined || v.icon !== undefined || v.isActive !== undefined, { message: "Provide a name, icon, or active state to update." });

export const createHousehelpSchema = z.object({
  name: z.string().trim().min(1, "Give the househelp a name").max(80),
  phone: z.string().trim().max(20).optional(),
  roleTitle: z.string().trim().max(60).optional(),
  salaryMode: salaryModeSchema.default("FIXED_MONTHLY"),
  monthlySalaryPaise: paiseSchema.optional(),
  dailyRatePaise: paiseSchema.optional(),
  halfDayRatePaise: paiseSchema.optional(),
  salaryDueDay: z.number().int().min(1).max(31).default(1),
  startDate: dateSchema.optional(),
  notes: z.string().trim().max(2000).optional(),
  categoryIds: z.array(z.string().uuid()).default([]),
});

export const updateHousehelpSchema = z.object({
  name: z.string().trim().min(1, "Give the househelp a name").max(80).optional(),
  phone: z.string().trim().max(20).nullable().optional(),
  roleTitle: z.string().trim().max(60).nullable().optional(),
  status: z.enum(["ACTIVE", "INACTIVE"]).optional(),
  salaryMode: salaryModeSchema.optional(),
  monthlySalaryPaise: paiseSchema.nullable().optional(),
  dailyRatePaise: paiseSchema.nullable().optional(),
  halfDayRatePaise: paiseSchema.nullable().optional(),
  salaryDueDay: z.number().int().min(1).max(31).optional(),
  startDate: dateSchema.nullable().optional(),
  endDate: dateSchema.nullable().optional(),
  notes: z.string().trim().max(2000).nullable().optional(),
  categoryIds: z.array(z.string().uuid()).optional(),
}).refine((v) => Object.values(v).some((x) => x !== undefined), { message: "Provide at least one field to update." });

export const updateScheduleSchema = z.object({
  weekdays: z.array(z.number().int().min(1).max(7)).min(1, "Pick at least one day")
    .refine((arr) => new Set(arr).size === arr.length, "No duplicate days"),
  startTime: timeSchema.optional(),
  endTime: timeSchema.optional(),
});

export type CreateCategoryInput = z.infer<typeof createCategorySchema>;
export type UpdateCategoryInput = z.infer<typeof updateCategorySchema>;
export type MoveCategoryInput = z.infer<typeof moveCategorySchema>;
export type CreateBillCategoryInput = z.infer<typeof createBillCategorySchema>;
export type UpdateBillCategoryInput = z.infer<typeof updateBillCategorySchema>;
export type CreateHousehelpInput = z.input<typeof createHousehelpSchema>;
export type UpdateHousehelpInput = z.infer<typeof updateHousehelpSchema>;
export type UpdateScheduleInput = z.infer<typeof updateScheduleSchema>;

export const attendanceStatusSchema = z.enum(["PRESENT", "ABSENT", "HALF_DAY", "LEAVE", "HOLIDAY"]);
export const monthSchema = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, "Use YYYY-MM");

export const markAttendanceSchema = z.object({
  date: dateSchema,
  status: attendanceStatusSchema,
  note: z.string().trim().max(500).optional(),
});
export const markHolidaySchema = z.object({ date: dateSchema });

export type MarkAttendanceInput = z.infer<typeof markAttendanceSchema>;
export type MarkHolidayInput = z.infer<typeof markHolidaySchema>;

export const taskFrequencySchema = z.enum(["DAILY", "WEEKLY", "WEEKDAYS", "MONTHLY", "SPECIFIC_DATE", "CUSTOM"]);
export const taskPrioritySchema = z.enum(["LOW", "NORMAL", "HIGH"]);

type FrequencyConfigFields = {
  weekdays?: number[]; dayOfMonth?: number; specificDate?: string; intervalDays?: number; anchorDate?: string;
};

/**
 * Each frequency accepts exactly its own config fields and rejects the others — an inapplicable
 * field left populated would make "is this task due today" (a later spec) ambiguous. WEEKDAYS takes
 * no input at all: it's a fixed Mon–Fri set the service stores canonically, never client-supplied.
 */
function checkFrequencyConfig(v: { frequency: z.infer<typeof taskFrequencySchema> } & FrequencyConfigFields, ctx: z.RefinementCtx): void {
  const has = {
    weekdays: v.weekdays !== undefined, dayOfMonth: v.dayOfMonth !== undefined,
    specificDate: v.specificDate !== undefined, intervalDays: v.intervalDays !== undefined, anchorDate: v.anchorDate !== undefined,
  };
  const reject = (field: keyof typeof has) => { if (has[field]) ctx.addIssue({ code: "custom", path: [field], message: `Not used for a ${v.frequency} task.` }); };
  const rejectAllExcept = (...allowed: (keyof typeof has)[]) => {
    (Object.keys(has) as (keyof typeof has)[]).forEach((f) => { if (!allowed.includes(f)) reject(f); });
  };
  switch (v.frequency) {
    case "DAILY":
    case "WEEKDAYS":
      rejectAllExcept();
      break;
    case "WEEKLY":
      rejectAllExcept("weekdays");
      if (!v.weekdays || v.weekdays.length === 0) ctx.addIssue({ code: "custom", path: ["weekdays"], message: "Pick at least one weekday for a weekly task." });
      else if (new Set(v.weekdays).size !== v.weekdays.length) ctx.addIssue({ code: "custom", path: ["weekdays"], message: "No duplicate days." });
      break;
    case "MONTHLY":
      rejectAllExcept("dayOfMonth");
      if (!has.dayOfMonth) ctx.addIssue({ code: "custom", path: ["dayOfMonth"], message: "Give the day of the month for a monthly task." });
      break;
    case "SPECIFIC_DATE":
      rejectAllExcept("specificDate");
      if (!has.specificDate) ctx.addIssue({ code: "custom", path: ["specificDate"], message: "Give the date for a one-time task." });
      break;
    case "CUSTOM":
      rejectAllExcept("intervalDays", "anchorDate");
      if (!has.intervalDays) ctx.addIssue({ code: "custom", path: ["intervalDays"], message: "Give the repeat interval in days." });
      if (!has.anchorDate) ctx.addIssue({ code: "custom", path: ["anchorDate"], message: "Give the anchor date to count the interval from." });
      break;
  }
}

export const createChecklistTaskSchema = z.object({
  name: z.string().trim().min(1, "Give the task a name").max(120),
  description: z.string().trim().max(2000).optional(),
  categoryId: z.string().uuid().optional(),
  frequency: taskFrequencySchema,
  weekdays: z.array(z.number().int().min(1).max(7)).optional(),
  dayOfMonth: z.number().int().min(1).max(31).optional(),
  specificDate: dateSchema.optional(),
  intervalDays: z.number().int().min(1).optional(),
  anchorDate: dateSchema.optional(),
  preferredTime: timeSchema.optional(),
  priority: taskPrioritySchema.default("NORMAL"),
}).superRefine(checkFrequencyConfig);

export const updateChecklistTaskSchema = z.object({
  name: z.string().trim().min(1, "Give the task a name").max(120).optional(),
  description: z.string().trim().max(2000).nullable().optional(),
  categoryId: z.string().uuid().nullable().optional(),
  frequency: taskFrequencySchema.optional(),
  weekdays: z.array(z.number().int().min(1).max(7)).optional(),
  dayOfMonth: z.number().int().min(1).max(31).optional(),
  specificDate: dateSchema.optional(),
  intervalDays: z.number().int().min(1).optional(),
  anchorDate: dateSchema.optional(),
  preferredTime: timeSchema.nullable().optional(),
  priority: taskPrioritySchema.optional(),
}).superRefine((v, ctx) => {
  const configTouched = v.weekdays !== undefined || v.dayOfMonth !== undefined || v.specificDate !== undefined || v.intervalDays !== undefined || v.anchorDate !== undefined;
  if (v.frequency === undefined) {
    if (configTouched) ctx.addIssue({ code: "custom", path: ["frequency"], message: "Include frequency when changing its config fields." });
    return;
  }
  checkFrequencyConfig(v as { frequency: z.infer<typeof taskFrequencySchema> } & FrequencyConfigFields, ctx);
}).refine((v) => Object.values(v).some((x) => x !== undefined), { message: "Provide at least one field to update." });

export const putAssignmentsSchema = z.object({ househelpIds: z.array(z.string().uuid()) });

export const markCompletionSchema = z.object({
  date: dateSchema,
  status: z.enum(["COMPLETED", "SKIPPED"]),
  note: z.string().trim().max(500).optional(),
});

export type CreateChecklistTaskInput = z.input<typeof createChecklistTaskSchema>;
export type UpdateChecklistTaskInput = z.infer<typeof updateChecklistTaskSchema>;
export type PutAssignmentsInput = z.infer<typeof putAssignmentsSchema>;
export type MarkCompletionInput = z.infer<typeof markCompletionSchema>;

export const generateSettlementSchema = z.object({
  periodMonth: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])-01$/, "First of the month, YYYY-MM-01"),
});

export const createAdjustmentSchema = z.object({
  periodMonth: dateSchema,
  type: z.enum(["BONUS", "OVERTIME", "DEDUCTION", "ADVANCE", "ADJUSTMENT"]),
  amountPaise: paiseSchema,
  reason: z.string().trim().max(500).optional(),
});

export const recordPaymentSchema = z.object({
  amountPaise: paiseSchema.refine((v) => v > 0, "Amount must be positive"),
  paidOn: dateSchema,
  method: z.enum(["CASH", "UPI", "BANK_TRANSFER", "CARD", "AUTO_DEBIT", "CHEQUE", "OTHER"]),
  reference: z.string().trim().max(200).optional(),
  notes: z.string().trim().max(500).optional(),
});

/** `?reason=` on DELETE /salary/payments/:paymentId — same cap as every other free-text field. */
export const voidReasonSchema = z.string().trim().max(500);

export type GenerateSettlementInput = z.infer<typeof generateSettlementSchema>;
export type CreateAdjustmentInput = z.infer<typeof createAdjustmentSchema>;
export type RecordPaymentInput = z.infer<typeof recordPaymentSchema>;

export const billFrequencySchema = z.enum(["ONE_TIME", "WEEKLY", "MONTHLY", "QUARTERLY", "HALF_YEARLY", "YEARLY", "CUSTOM"]);
export const billStatusSchema = z.enum(["ACTIVE", "PAUSED", "ARCHIVED"]);
const billIntervalUnitSchema = z.enum(["day", "week", "month"]);
const paymentMethodSchema = z.enum(["CASH", "UPI", "BANK_TRANSFER", "CARD", "AUTO_DEBIT", "CHEQUE", "OTHER"]);

type BillFrequencyConfigFields = { intervalCount?: number; intervalUnit?: "day" | "week" | "month" };

/**
 * CUSTOM is the only bill frequency with a configurable interval — every other frequency has an
 * implicit fixed cadence (e.g. MONTHLY = every month), so a client-supplied intervalCount/intervalUnit
 * on those would be ambiguous (which cadence wins?) and is rejected outright.
 */
function checkBillFrequencyConfig(v: { frequency: z.infer<typeof billFrequencySchema> } & BillFrequencyConfigFields, ctx: z.RefinementCtx): void {
  if (v.frequency === "CUSTOM") {
    if (v.intervalUnit === undefined) ctx.addIssue({ code: "custom", path: ["intervalUnit"], message: "Give the interval unit for a custom-frequency bill." });
    if (v.intervalCount !== undefined && v.intervalCount < 1) ctx.addIssue({ code: "custom", path: ["intervalCount"], message: "Must be at least 1." });
  } else {
    if (v.intervalCount !== undefined) ctx.addIssue({ code: "custom", path: ["intervalCount"], message: `Not used for a ${v.frequency} bill.` });
    if (v.intervalUnit !== undefined) ctx.addIssue({ code: "custom", path: ["intervalUnit"], message: `Not used for a ${v.frequency} bill.` });
  }
}

export const createBillSchema = z.object({
  name: z.string().trim().min(1, "Give the bill a name").max(120),
  categoryId: z.string().uuid().optional(),
  provider: z.string().trim().max(120).optional(),
  accountNumber: z.string().trim().max(120).optional(),
  amountPaise: paiseSchema.nullable().optional(),
  frequency: billFrequencySchema,
  intervalCount: z.number().int().min(1).optional(),
  intervalUnit: billIntervalUnitSchema.optional(),
  firstDueDate: dateSchema,
  endDate: dateSchema.nullable().optional(),
  paymentMethod: paymentMethodSchema.nullable().optional(),
  autopay: z.boolean().default(false),
  notes: z.string().trim().max(2000).optional(),
}).superRefine(checkBillFrequencyConfig).refine(
  (v) => !v.endDate || v.endDate >= v.firstDueDate,
  { message: "End date must be on or after the first due date.", path: ["endDate"] },
);

export const updateBillSchema = z.object({
  name: z.string().trim().min(1, "Give the bill a name").max(120).optional(),
  categoryId: z.string().uuid().nullable().optional(),
  provider: z.string().trim().max(120).nullable().optional(),
  accountNumber: z.string().trim().max(120).nullable().optional(),
  amountPaise: paiseSchema.nullable().optional(),
  frequency: billFrequencySchema.optional(),
  intervalCount: z.number().int().min(1).optional(),
  intervalUnit: billIntervalUnitSchema.optional(),
  firstDueDate: dateSchema.optional(),
  endDate: dateSchema.nullable().optional(),
  paymentMethod: paymentMethodSchema.nullable().optional(),
  autopay: z.boolean().optional(),
  notes: z.string().trim().max(2000).nullable().optional(),
}).superRefine((v, ctx) => {
  const configTouched = v.intervalCount !== undefined || v.intervalUnit !== undefined;
  if (v.frequency === undefined) {
    if (configTouched) ctx.addIssue({ code: "custom", path: ["frequency"], message: "Include frequency when changing its config fields." });
    return;
  }
  checkBillFrequencyConfig(v as { frequency: z.infer<typeof billFrequencySchema> } & BillFrequencyConfigFields, ctx);
}).superRefine((v, ctx) => {
  // endDate vs firstDueDate can only be fully checked here when both are present in the same patch;
  // the case where only endDate changes against an existing firstDueDate is re-checked in the service.
  if (v.firstDueDate !== undefined && v.endDate !== undefined && v.endDate !== null && v.endDate < v.firstDueDate) {
    ctx.addIssue({ code: "custom", path: ["endDate"], message: "End date must be on or after the first due date." });
  }
}).refine((v) => Object.values(v).some((x) => x !== undefined), { message: "Provide at least one field to update." });

export type CreateBillInput = z.input<typeof createBillSchema>;
export type UpdateBillInput = z.infer<typeof updateBillSchema>;
