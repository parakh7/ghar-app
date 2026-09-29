import type { ErrorCode } from "@household/shared";

export class AppError extends Error {
  constructor(
    public readonly code: ErrorCode,
    message: string,
    public readonly status: number,
    public readonly fields?: Record<string, string>,
  ) {
    super(message);
    this.name = "AppError";
  }
}

export const Errors = {
  validation: (fields: Record<string, string>, message = "Please check the highlighted fields.") => new AppError("VALIDATION_ERROR", message, 400, fields),
  unauthenticated: () => new AppError("UNAUTHENTICATED", "Please sign in to continue.", 401),
  forbidden: (message = "You don't have permission to do that.") => new AppError("FORBIDDEN", message, 403),
  notFound: (what = "That item") => new AppError("NOT_FOUND", `${what} was not found.`, 404),
  householdNotFound: () => new AppError("HOUSEHOLD_NOT_FOUND", "Household not found.", 404),
  emailTaken: () => new AppError("EMAIL_TAKEN", "An account with this email already exists.", 409, { email: "An account with this email already exists." }),
  invalidCredentials: () => new AppError("INVALID_CREDENTIALS", "Email or password is incorrect.", 401),
  invalidToken: () => new AppError("INVALID_TOKEN", "This link is invalid or has expired. Request a new one.", 400),
  csrf: () => new AppError("CSRF_FAILED", "Request blocked for security reasons. Refresh the page and try again.", 403),
  rateLimited: () => new AppError("RATE_LIMITED", "Too many attempts. Please wait a few minutes and try again.", 429),
  conflict: (message: string) => new AppError("CONFLICT", message, 409),
};
