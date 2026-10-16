import type { CookieOptions, RequestHandler, Response } from "express";
import type { Env } from "../config/env.js";
import { Errors } from "../lib/errors.js";
import type { Deps } from "../services/deps.js";
import { resolveSession } from "../services/session.service.js";

export function sessionCookieName(env: Pick<Env, "NODE_ENV">): string {
  // __Host- prefix: browser enforces Secure, Path=/ and no Domain — cannot be set by subdomains.
  return env.NODE_ENV === "production" ? "__Host-hh_session" : "hh_session";
}

function cookieOptions(env: Env, expires?: Date): CookieOptions {
  // "lax" works for local dev (same registrable domain, different ports count as same-site) but
  // breaks the common deployment shape of a separately-hosted SPA + API (e.g. Netlify + Render) —
  // those are genuinely cross-site, and Lax cookies are never sent on cross-site fetch/XHR
  // regardless of `credentials: "include"`. "none" requires Secure (already true in production)
  // and is safe here specifically because csrfProtection's custom-header check already defends
  // against the CSRF risk SameSite normally mitigates.
  return { httpOnly: true, secure: env.NODE_ENV === "production", sameSite: env.NODE_ENV === "production" ? "none" : "lax", path: "/", ...(expires ? { expires } : {}) };
}

export function setSessionCookie(res: Response, env: Env, token: string, expiresAt: Date): void {
  res.cookie(sessionCookieName(env), token, cookieOptions(env, expiresAt));
}

export function clearSessionCookie(res: Response, env: Env): void {
  res.clearCookie(sessionCookieName(env), cookieOptions(env));
}

/** Reads a session from the httpOnly cookie (web) or `Authorization: Bearer` (future native apps). Never rejects. */
export function authenticate(deps: Deps): RequestHandler {
  const cookieName = sessionCookieName(deps.env);
  return async (req, _res, next) => {
    const header = req.header("authorization");
    const bearer = header?.startsWith("Bearer ") ? header.slice(7).trim() : undefined;
    const token: string | undefined = bearer ?? (req.cookies as Record<string, string> | undefined)?.[cookieName];
    if (token) {
      const session = await resolveSession(deps, token);
      if (session) req.auth = session;
    }
    next();
  };
}

export const requireAuth: RequestHandler = (req, _res, next) => {
  if (!req.auth) throw Errors.unauthenticated();
  next();
};
