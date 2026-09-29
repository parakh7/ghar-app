import { and, eq, gt, isNull, ne } from "drizzle-orm";
import type { DbOrTx } from "../db/client.js";
import { userSessions, users } from "../db/schema.js";
import { generateToken, hashToken } from "../lib/crypto.js";
import type { Deps } from "./deps.js";

const DAY = 86_400_000;
/** Only write last_seen/expiry at most once per hour per session (avoids a write on every request). */
const TOUCH_INTERVAL_MS = 60 * 60 * 1000;

export type SessionUser = { id: string; name: string; email: string; emailVerifiedAt: Date | null; createdAt: Date };
export type ActiveSession = { sessionId: string; user: SessionUser };

export async function createSession(deps: Deps, db: DbOrTx, userId: string, meta: { userAgent?: string | undefined; ip?: string | undefined }) {
  const token = generateToken();
  const now = deps.clock.now();
  const expiresAt = new Date(now.getTime() + deps.env.SESSION_TTL_DAYS * DAY);
  const [row] = await db.insert(userSessions).values({
    userId, tokenHash: hashToken(token), expiresAt, lastSeenAt: now,
    userAgent: meta.userAgent?.slice(0, 300) ?? null, ipAddress: meta.ip ?? null,
  }).returning({ id: userSessions.id });
  return { token, sessionId: row!.id, expiresAt };
}

/** Resolves a raw token to a live session; slides expiry forward on use. */
export async function resolveSession(deps: Deps, token: string): Promise<ActiveSession | null> {
  if (!token || token.length > 200) return null;
  const now = deps.clock.now();
  const [row] = await deps.db
    .select({
      sessionId: userSessions.id, lastSeenAt: userSessions.lastSeenAt,
      id: users.id, name: users.name, email: users.email, emailVerifiedAt: users.emailVerifiedAt, createdAt: users.createdAt,
    })
    .from(userSessions)
    .innerJoin(users, eq(users.id, userSessions.userId))
    .where(and(eq(userSessions.tokenHash, hashToken(token)), isNull(userSessions.revokedAt), gt(userSessions.expiresAt, now), isNull(users.deletedAt)))
    .limit(1);
  if (!row) return null;

  if (now.getTime() - row.lastSeenAt.getTime() > TOUCH_INTERVAL_MS) {
    await deps.db.update(userSessions)
      .set({ lastSeenAt: now, expiresAt: new Date(now.getTime() + deps.env.SESSION_TTL_DAYS * DAY) })
      .where(eq(userSessions.id, row.sessionId));
  }
  const { sessionId, lastSeenAt: _l, ...user } = row;
  return { sessionId, user };
}

export async function revokeSession(deps: Deps, sessionId: string): Promise<void> {
  await deps.db.update(userSessions).set({ revokedAt: deps.clock.now() }).where(and(eq(userSessions.id, sessionId), isNull(userSessions.revokedAt)));
}

export async function revokeAllSessions(deps: Deps, db: DbOrTx, userId: string, exceptSessionId?: string): Promise<void> {
  const conditions = [eq(userSessions.userId, userId), isNull(userSessions.revokedAt)];
  if (exceptSessionId) conditions.push(ne(userSessions.id, exceptSessionId));
  await db.update(userSessions).set({ revokedAt: deps.clock.now() }).where(and(...conditions));
}
