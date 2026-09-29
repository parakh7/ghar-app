export type ApiSuccess<T> = { success: true; data: T; message: string | null };
export type ApiFailure = { success: false; error: { code: ErrorCode; message: string; fields?: Record<string, string> } };
export type ApiResponse<T> = ApiSuccess<T> | ApiFailure;

export const ERROR_CODES = [
  "VALIDATION_ERROR",
  "UNAUTHENTICATED",
  "FORBIDDEN",
  "NOT_FOUND",
  "HOUSEHOLD_NOT_FOUND",
  "EMAIL_TAKEN",
  "INVALID_CREDENTIALS",
  "INVALID_TOKEN",
  "EMAIL_NOT_VERIFIED",
  "CSRF_FAILED",
  "RATE_LIMITED",
  "CONFLICT",
  "INTERNAL_ERROR",
] as const;
export type ErrorCode = (typeof ERROR_CODES)[number];

/** Header required on every state-changing request (CSRF defence). */
export const CSRF_HEADER = "x-household-client";
export const CSRF_HEADER_VALUE = "web";
