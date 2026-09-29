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
