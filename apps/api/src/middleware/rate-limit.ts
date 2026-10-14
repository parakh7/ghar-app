import { rateLimit, ipKeyGenerator } from "express-rate-limit";
import { RedisStore, type SendCommandFn } from "rate-limit-redis";
import type { RequestHandler } from "express";
import type { Redis } from "ioredis";
import { Errors } from "../lib/errors.js";
import { fail } from "../lib/respond.js";

/**
 * Redis-backed when a client is given (production/development — correct across multiple API
 * instances); falls back to express-rate-limit's built-in in-memory store when omitted (the test
 * environment never supplies one, so existing throttle-behavior tests keep working unchanged).
 */
function storeFor(prefix: string, redis?: Redis) {
  if (!redis) return undefined;
  const sendCommand = ((...args: string[]) => redis.call(...(args as [string, ...string[]]))) as unknown as SendCommandFn;
  return new RedisStore({ prefix, sendCommand });
}

export function globalLimiter(max: number, redis?: Redis): RequestHandler {
  return rateLimit({
    windowMs: 60_000, limit: max, standardHeaders: "draft-8", legacyHeaders: false,
    store: storeFor("rl:global:", redis),
    handler: (_req, res) => fail(res, Errors.rateLimited()),
  });
}

/** Keyed by IP + submitted email so one attacker can't lock out everyone behind a shared IP. */
export function authLimiter(max: number, redis?: Redis): RequestHandler {
  return rateLimit({
    windowMs: 15 * 60_000, limit: max, standardHeaders: "draft-8", legacyHeaders: false,
    store: storeFor("rl:auth:", redis),
    keyGenerator: (req) => {
      const email = typeof req.body?.email === "string" ? req.body.email.trim().toLowerCase().slice(0, 254) : "";
      return `${ipKeyGenerator(req.ip ?? "unknown")}|${email}`;
    },
    handler: (_req, res) => fail(res, Errors.rateLimited()),
  });
}

/**
 * Guards invite create/resend — both send email, so they need the same email-bomb protection as
 * signup/password-reset. Keyed by IP + household (not email: resend has no email in its body,
 * only an inviteId) so spamming one household's invites can't be dodged by rotating target emails,
 * and doesn't lock out unrelated households behind the same IP/NAT.
 */
export function inviteLimiter(max: number, redis?: Redis): RequestHandler {
  return rateLimit({
    windowMs: 15 * 60_000, limit: max, standardHeaders: "draft-8", legacyHeaders: false,
    store: storeFor("rl:invite:", redis),
    keyGenerator: (req) => `${ipKeyGenerator(req.ip ?? "unknown")}|${req.params.householdId ?? ""}`,
    handler: (_req, res) => fail(res, Errors.rateLimited()),
  });
}
