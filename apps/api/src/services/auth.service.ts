import { and, eq, gt, isNull } from "drizzle-orm";
import type { LoginInput, SignupInput, UserDTO } from "@household/shared";
import { authTokens, users } from "../db/schema.js";
import { Errors } from "../lib/errors.js";
import { generateToken, hashToken } from "../lib/crypto.js";
import { getDummyHash, hashPassword, verifyPassword } from "../lib/password.js";
import { recordAudit } from "./audit.service.js";
import type { Deps } from "./deps.js";
import { passwordChangedMessage, resetPasswordMessage, verifyEmailMessage } from "./email/templates.js";
import { createSession, revokeAllSessions, type SessionUser } from "./session.service.js";

const HOUR = 3_600_000;
const VERIFY_TTL = 24 * HOUR;
const RESET_TTL = 1 * HOUR;

type RequestMeta = { userAgent?: string | undefined; ip?: string | undefined };

export function toUserDTO(u: SessionUser): UserDTO {
  return { id: u.id, name: u.name, email: u.email, emailVerified: u.emailVerifiedAt !== null, createdAt: u.createdAt.toISOString() };
}

function isUniqueViolation(err: unknown): boolean {
  const e = err as { code?: string; cause?: { code?: string } };
  return e?.code === "23505" || e?.cause?.code === "23505";
}

async function issueToken(deps: Deps, userId: string, purpose: "EMAIL_VERIFY" | "PASSWORD_RESET", ttlMs: number) {
  const token = generateToken();
  const now = deps.clock.now();
  await deps.db.transaction(async (tx) => {
    // Only the newest link of each kind works.
    await tx.update(authTokens).set({ usedAt: now }).where(and(eq(authTokens.userId, userId), eq(authTokens.purpose, purpose), isNull(authTokens.usedAt)));
    await tx.insert(authTokens).values({ userId, purpose, tokenHash: hashToken(token), expiresAt: new Date(now.getTime() + ttlMs) });
  });
  return token;
}

/** Atomically consumes a single-use token. Returns the user id or throws INVALID_TOKEN. */
async function consumeToken(deps: Deps, tx: Parameters<Parameters<Deps["db"]["transaction"]>[0]>[0], token: string, purpose: "EMAIL_VERIFY" | "PASSWORD_RESET") {
  const now = deps.clock.now();
  const [row] = await tx.update(authTokens).set({ usedAt: now })
    .where(and(eq(authTokens.tokenHash, hashToken(token)), eq(authTokens.purpose, purpose), isNull(authTokens.usedAt), gt(authTokens.expiresAt, now)))
    .returning({ userId: authTokens.userId });
  if (!row) throw Errors.invalidToken();
  return row.userId;
}

async function sendVerification(deps: Deps, user: { id: string; email: string; name: string }) {
  const token = await issueToken(deps, user.id, "EMAIL_VERIFY", VERIFY_TTL);
  const link = `${deps.env.APP_URL}/verify-email?token=${encodeURIComponent(token)}`;
  await deps.email.send(verifyEmailMessage(user.email, user.name, link));
}

export async function signup(deps: Deps, input: SignupInput, meta: RequestMeta) {
  const passwordHash = await hashPassword(input.password);
  let result;
  try {
    result = await deps.db.transaction(async (tx) => {
      const [user] = await tx.insert(users).values({ name: input.name, email: input.email, passwordHash, passwordChangedAt: deps.clock.now() }).returning();
      const session = await createSession(deps, tx, user!.id, meta);
      await recordAudit(tx, { householdId: null, actorUserId: user!.id, action: "user.signed_up", entityType: "user", entityId: user!.id, ipAddress: meta.ip ?? null });
      return { user: user!, session };
    });
  } catch (err) {
    if (isUniqueViolation(err)) throw Errors.emailTaken();
    throw err;
  }
  deps.logger.info({ userId: result.user.id, event: "auth.signup" }, "user signed up");
  // Email failures must not fail signup; user can resend.
  sendVerification(deps, result.user).catch((err: unknown) => deps.logger.error({ err, userId: result.user.id }, "verification email failed"));
  return { user: toUserDTO(result.user), session: result.session };
}

export async function login(deps: Deps, input: LoginInput, meta: RequestMeta) {
  const [user] = await deps.db.select().from(users).where(and(eq(users.email, input.email), isNull(users.deletedAt))).limit(1);
  // Always run exactly one argon2 verify so response time doesn't reveal whether the email exists.
  const valid = await verifyPassword(user?.passwordHash ?? (await getDummyHash()), input.password);
  if (!user || !user.passwordHash || !valid) {
    deps.logger.warn({ event: "auth.login_failed", ip: meta.ip }, "login failed");
    throw Errors.invalidCredentials();
  }
  const session = await createSession(deps, deps.db, user.id, meta);
  deps.logger.info({ userId: user.id, event: "auth.login" }, "user logged in");
  return { user: toUserDTO(user), session };
}

export async function resendVerification(deps: Deps, user: SessionUser) {
  if (user.emailVerifiedAt) return;
  await sendVerification(deps, user);
}

export async function verifyEmail(deps: Deps, token: string) {
  await deps.db.transaction(async (tx) => {
    const userId = await consumeToken(deps, tx, token, "EMAIL_VERIFY");
    await tx.update(users).set({ emailVerifiedAt: deps.clock.now() }).where(and(eq(users.id, userId), isNull(users.emailVerifiedAt)));
    await recordAudit(tx, { householdId: null, actorUserId: userId, action: "user.email_verified", entityType: "user", entityId: userId });
  });
}

/** Always resolves the same way whether or not the email exists (no account enumeration). */
export async function requestPasswordReset(deps: Deps, email: string) {
  const [user] = await deps.db.select({ id: users.id, email: users.email, name: users.name }).from(users)
    .where(and(eq(users.email, email), isNull(users.deletedAt))).limit(1);
  if (!user) {
    deps.logger.info({ event: "auth.reset_requested_unknown" }, "password reset requested for unknown email");
    return;
  }
  const token = await issueToken(deps, user.id, "PASSWORD_RESET", RESET_TTL);
  const link = `${deps.env.APP_URL}/reset-password?token=${encodeURIComponent(token)}`;
  await deps.email.send(resetPasswordMessage(user.email, user.name, link));
  deps.logger.info({ userId: user.id, event: "auth.reset_requested" }, "password reset requested");
}

export async function resetPassword(deps: Deps, token: string, newPassword: string, meta: RequestMeta) {
  const passwordHash = await hashPassword(newPassword);
  const user = await deps.db.transaction(async (tx) => {
    const userId = await consumeToken(deps, tx, token, "PASSWORD_RESET");
    const now = deps.clock.now();
    // Resetting via emailed link also proves email ownership.
    const [u] = await tx.update(users).set({ passwordHash, passwordChangedAt: now, emailVerifiedAt: now }).where(eq(users.id, userId)).returning();
    await revokeAllSessions(deps, tx, userId);
    await recordAudit(tx, { householdId: null, actorUserId: userId, action: "user.password_reset", entityType: "user", entityId: userId, ipAddress: meta.ip ?? null });
    return u!;
  });
  deps.logger.info({ userId: user.id, event: "auth.password_reset" }, "password reset; all sessions revoked");
  deps.email.send(passwordChangedMessage(user.email, user.name)).catch((err: unknown) => deps.logger.error({ err }, "password-changed email failed"));
}

export async function changePassword(deps: Deps, userId: string, currentSessionId: string, currentPassword: string, newPassword: string) {
  const [user] = await deps.db.select().from(users).where(eq(users.id, userId)).limit(1);
  if (!user?.passwordHash || !(await verifyPassword(user.passwordHash, currentPassword))) {
    throw Errors.validation({ currentPassword: "Current password is incorrect." }, "Current password is incorrect.");
  }
  const passwordHash = await hashPassword(newPassword);
  await deps.db.transaction(async (tx) => {
    await tx.update(users).set({ passwordHash, passwordChangedAt: deps.clock.now() }).where(eq(users.id, userId));
    await revokeAllSessions(deps, tx, userId, currentSessionId); // keep this device signed in
    await recordAudit(tx, { householdId: null, actorUserId: userId, action: "user.password_changed", entityType: "user", entityId: userId });
  });
  deps.email.send(passwordChangedMessage(user.email, user.name)).catch((err: unknown) => deps.logger.error({ err }, "password-changed email failed"));
}
