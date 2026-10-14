# Security Review — Findings Report

**Date:** 2026-10-14. **Spec:** `docs/superpowers/specs/2026-10-14-security-review-design.md` (Phase 10, Spec 1).

**Method:** `README.md`'s "Security model" table documents a set of claimed protections built across Phases 1-9. This review verified each claim against the current code rather than trusting the documentation, and separately checked for gaps the table doesn't mention (XSS, SSRF, sensitive-data-exposure, security misconfiguration).

**Summary:** No Critical or High findings requiring a code fix survived verification. One dependency vulnerability (High) had a safe non-breaking fix, applied. One Medium logic finding (password-reset timing side-channel) is documented here for later triage, per this review's fix policy (Critical/High fixed now, Medium/Low logged only).

---

## 1. Dependency audit

- **source-map-js (High, CWE-1284, event-loop DoS via malformed source map) — FIXED.** Pulled transitively via `jsdom`→`css-tree` and `vite`→`postcss`, both dev/build-time only (never in the shipped `dist/` bundle). Resolved by `npm audit fix` (1.2.1 → patched, no breaking change). Verified via `npm audit` — 0 vulnerabilities of this kind remain.
- **esbuild / `@esbuild-kit/*` chain via `drizzle-kit` (4 Moderate, CWE-346 — a malicious website can send requests to a locally running dev server) — accepted, not fixed.** `drizzle-kit` is a local CLI tool for generating migrations; it never runs in production, and exploitation requires a developer to have `drizzle-kit`'s dev-mode esbuild server actively running while simultaneously browsing a malicious site. No non-breaking fix exists upstream (`npm audit fix --force` would downgrade `drizzle-kit` from 0.31.11 to 0.18.1, itself within the vulnerable range per `npm audit`'s own report — i.e. not actually a fix). Revisit when `drizzle-kit` ships a 1.0 release with this resolved.
- `npm outdated` shows only routine minor/patch version gaps (zod, express, pino, drizzle-orm, @tanstack/react-query, etc.) — none carry a known CVE. Not a security finding; ordinary maintenance.

## 2. Auth / session / authorization code review

Verified against the code and found **matching the README's claims**:
- Session cookie flags — `httpOnly`, `secure` in production, `sameSite=lax`, `__Host-` prefix in production (`apps/api/src/middleware/auth.ts:7-14`).
- Session tokens — SHA-256 hash stored, raw token never persisted (`apps/api/src/services/session.service.ts:15,19`); sliding expiry and instant revocation (`session.service.ts:40-57`).
- `requireHousehold` — non-members get 404 (not 403, so household IDs can't be probed), permission checks rather than role checks (`apps/api/src/middleware/household.ts:16-31`).
- CSRF — required header + Origin check (`apps/api/src/middleware/csrf.ts`).
- Password reset revokes every session (`apps/api/src/services/auth.service.ts:121`); change-password preserves the current session via `exceptSessionId` (`auth.service.ts:137`).
- Invite acceptance — email-match check + row-locked atomic upsert, properly household-scoped (`apps/api/src/services/member.service.ts:175-201`); invite revoke/resend also household-scoped (`member.service.ts:147-172`).
- Login's account-enumeration protection — a dummy argon2 verify always runs so response timing doesn't reveal whether an email exists (`auth.service.ts:77`).

**Finding — Medium: password-reset request has a timing side-channel the enumeration protection doesn't cover.**
`requestPasswordReset` (`apps/api/src/services/auth.service.ts:101-112`) is commented "Always resolves the same way whether or not the email exists," but doesn't actually do that: the known-email path issues a token (DB insert) and **awaits** `deps.email.send(...)` (line 110) before returning; the unknown-email path returns immediately after a single `SELECT` (lines 104-107). `signup` already solves exactly this problem at line 70 by firing the verification email without awaiting it (`sendVerification(...).catch(...)`), specifically so email-provider latency can't leak timing information. `requestPasswordReset` doesn't follow that same pattern.
- **Impact:** an attacker measuring response times on `/auth/forgot-password` can likely distinguish registered from unregistered emails, defeating the stated no-enumeration goal for this endpoint specifically (login's enumeration protection, verified above, is unaffected).
- **Suggested fix:** make the email send fire-and-forget here too (`deps.email.send(...).catch((err) => deps.logger.error(...))`), matching `signup`'s pattern at line 70. Note this closes the dominant timing gap (email-provider I/O) but not a smaller residual one — the known-email path still does one extra `INSERT` (`issueToken`) that the unknown-email path doesn't; that residual difference is far smaller and lower-priority.
- **Status:** not fixed in this review (Medium, per this review's fix policy) — logged here for a follow-up patch.

## 3. OWASP Top 10-style pass

All clean — no findings.
- **Injection:** every raw `sql` tagged-template usage in `apps/api/src` is static schema DDL (constraints/indexes) or a literal `select 1` health check. No user input reaches raw SQL anywhere; all query input goes through Drizzle's parameterized query builder.
- **XSS:** zero uses of `dangerouslySetInnerHTML` anywhere in `apps/web/src`.
- **SSRF:** zero outbound `fetch`/HTTP-client calls anywhere in `apps/api/src` — there's no surface for this at all currently (no webhooks, no user-supplied URLs fetched server-side).
- **Sensitive data exposure:** no route or DTO exposes `passwordHash`, a session token, or a reset/verify token hash — every response is built through a dedicated `toXDTO()` function that only picks safe fields.
- **Security misconfiguration:** no debug or seed route is reachable via the HTTP server; `db:seed` is a standalone script invoked directly with `tsx`, not wired into the Express app, so it's unreachable regardless of `NODE_ENV`.

## 4. Security headers / transport config

All clean — matches the README's claims.
- `helmet` is configured with an explicit CSP (`default-src 'none'`, `frame-ancestors 'none'`) and `crossOriginResourcePolicy: "same-site"` (`apps/api/src/app.ts:26-29`); nosniff/frame-deny/HSTS come from helmet's secure-by-default behavior and aren't overridden.
- CORS uses a strict allowlist with each configured origin normalized via `new URL(o).origin` before comparison (`apps/api/src/app.ts:30-33`, `apps/api/src/config/env.ts:33-34`) — no wildcard, no unconditional Origin reflection.
- Session cookie flags confirmed identical to the Area 2 findings above.
- The CSRF header's value (`packages/shared/src/api.ts:23-24`) is an intentional public, non-secret constant (`"web"`) — the defense is the *requirement* that the header be present (which a cross-origin form/script can't attach without a CORS preflight the server would reject), not the value's secrecy. This is documented in `csrf.ts`'s own comment and is correct as designed, not a flaw.

---

## Open items for later triage

- **Medium:** password-reset timing side-channel (`auth.service.ts:101-112`) — see Area 2 above.
- **Low / accepted:** `drizzle-kit`'s transitive esbuild dev-server CWE-346 exposure — see Dependency audit above. Revisit on `drizzle-kit`'s next major release.
