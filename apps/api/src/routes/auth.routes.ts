import { Router } from "express";
import {
  changePasswordSchema, forgotPasswordSchema, loginSchema, resetPasswordSchema, signupSchema, verifyEmailSchema,
  type MeDTO,
} from "@household/shared";
import { clearSessionCookie, requireAuth, setSessionCookie } from "../middleware/auth.js";
import { authLimiter } from "../middleware/rate-limit.js";
import { parseBody } from "../middleware/validate.js";
import { ok } from "../lib/respond.js";
import * as auth from "../services/auth.service.js";
import type { Deps } from "../services/deps.js";
import { listHouseholdsForUser } from "../services/household.service.js";
import { revokeSession } from "../services/session.service.js";

/** Route handlers stay thin: parse → call service → respond. */
export function authRoutes(deps: Deps): Router {
  const r = Router();
  const limiter = authLimiter(deps.env.RATE_LIMIT_AUTH_MAX);
  const meta = (req: { get(h: string): string | undefined; ip?: string | undefined }) => ({ userAgent: req.get("user-agent"), ip: req.ip });

  r.post("/signup", limiter, async (req, res) => {
    const input = parseBody(req, signupSchema);
    const { user, session } = await auth.signup(deps, input, meta(req));
    setSessionCookie(res, deps.env, session.token, session.expiresAt);
    ok(res, { user, households: [] } satisfies MeDTO, 201, "Account created. Check your email to confirm your address.");
  });

  r.post("/login", limiter, async (req, res) => {
    const input = parseBody(req, loginSchema);
    const { user, session } = await auth.login(deps, input, meta(req));
    setSessionCookie(res, deps.env, session.token, session.expiresAt);
    const households = await listHouseholdsForUser(deps.db, user.id);
    ok(res, { user, households } satisfies MeDTO);
  });

  r.post("/logout", async (req, res) => {
    if (req.auth) await revokeSession(deps, req.auth.sessionId);
    clearSessionCookie(res, deps.env);
    ok(res, null, 200, "Signed out.");
  });

  r.get("/me", requireAuth, async (req, res) => {
    const households = await listHouseholdsForUser(deps.db, req.auth!.user.id);
    ok(res, { user: auth.toUserDTO(req.auth!.user), households } satisfies MeDTO);
  });

  r.post("/verify-email", limiter, async (req, res) => {
    const { token } = parseBody(req, verifyEmailSchema);
    await auth.verifyEmail(deps, token);
    ok(res, null, 200, "Email confirmed.");
  });

  r.post("/resend-verification", requireAuth, limiter, async (req, res) => {
    await auth.resendVerification(deps, req.auth!.user);
    ok(res, null, 200, "If your email isn't confirmed yet, we've sent a new link.");
  });

  r.post("/forgot-password", limiter, async (req, res) => {
    const { email } = parseBody(req, forgotPasswordSchema);
    await auth.requestPasswordReset(deps, email);
    ok(res, null, 200, "If an account exists for that email, we've sent a reset link.");
  });

  r.post("/reset-password", limiter, async (req, res) => {
    const { token, password } = parseBody(req, resetPasswordSchema);
    await auth.resetPassword(deps, token, password, meta(req));
    clearSessionCookie(res, deps.env);
    ok(res, null, 200, "Password updated. Sign in with your new password.");
  });

  r.post("/change-password", requireAuth, limiter, async (req, res) => {
    const { currentPassword, newPassword } = parseBody(req, changePasswordSchema);
    await auth.changePassword(deps, req.auth!.user.id, req.auth!.sessionId, currentPassword, newPassword);
    ok(res, null, 200, "Password changed. Other devices have been signed out.");
  });

  return r;
}
