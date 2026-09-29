import { rateLimit, ipKeyGenerator } from "express-rate-limit";
import type { RequestHandler } from "express";
import { Errors } from "../lib/errors.js";
import { fail } from "../lib/respond.js";

/**
 * In-memory store is correct for a single API instance. When scaling horizontally,
 * pass a Redis store (rate-limit-redis) using REDIS_URL — the interface is identical.
 */
export function globalLimiter(max: number): RequestHandler {
  return rateLimit({
    windowMs: 60_000, limit: max, standardHeaders: "draft-8", legacyHeaders: false,
    handler: (_req, res) => fail(res, Errors.rateLimited()),
  });
}

/** Keyed by IP + submitted email so one attacker can't lock out everyone behind a shared IP. */
export function authLimiter(max: number): RequestHandler {
  return rateLimit({
    windowMs: 15 * 60_000, limit: max, standardHeaders: "draft-8", legacyHeaders: false,
    keyGenerator: (req) => {
      const email = typeof req.body?.email === "string" ? req.body.email.trim().toLowerCase().slice(0, 254) : "";
      return `${ipKeyGenerator(req.ip ?? "unknown")}|${email}`;
    },
    handler: (_req, res) => fail(res, Errors.rateLimited()),
  });
}
