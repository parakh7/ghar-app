import type { RequestHandler } from "express";
import { CSRF_HEADER, CSRF_HEADER_VALUE } from "@household/shared";
import { Errors } from "../lib/errors.js";

const SAFE = new Set(["GET", "HEAD", "OPTIONS"]);

/**
 * CSRF defence for cookie auth:
 *  1. SameSite=Lax session cookie (set in auth middleware), plus
 *  2. every state-changing request must carry a custom header. Browsers can't add custom
 *     headers cross-origin without a CORS preflight, which our CORS policy rejects, plus
 *  3. if an Origin header is present it must be on the allow-list.
 * Bearer-token requests (native apps) carry no ambient credentials and are exempt.
 */
export function csrfProtection(allowed: string[]): RequestHandler {
  const origins = new Set(allowed);
  return (req, _res, next) => {
    if (SAFE.has(req.method)) return next();
    if (req.header("authorization")?.startsWith("Bearer ")) return next();
    if (req.header(CSRF_HEADER) !== CSRF_HEADER_VALUE) throw Errors.csrf();
    const origin = req.header("origin");
    if (origin && !origins.has(origin)) throw Errors.csrf();
    next();
  };
}
