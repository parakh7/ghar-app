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
