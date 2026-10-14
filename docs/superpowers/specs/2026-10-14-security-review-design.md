# Security Review — Design Spec

**Phase:** 10 (Security review, load/perf testing, production hardening) — Spec 1 of 3.

**Status:** Approved.

## Context

`README.md`'s "Security model" section documents a mature set of protections already built across Phases 1-9: argon2id password hashing, hashed opaque session tokens (`httpOnly`, `SameSite=Lax`, `__Host-`+`Secure` in production), single-use expiring password-reset/verify tokens, timing-equalized account-enumeration protection, CSRF via SameSite cookie + required `x-household-client` header + Origin allow-list, membership-based authorization (non-members get 404, permission checks not role checks), composite-FK cross-household integrity, zod validation + parameterized SQL (Drizzle) + 100kB body limit, `helmet` security headers (CSP `default-src 'none'`, nosniff, frame denial, HSTS), rate limiting (flagged in the README itself as memory-store-only, needs a Redis store for multi-instance deployment), redacted structured logging, and audit logging.

This spec's job is to **verify that documented model actually matches the current code** (things drift), and to look for gaps the table doesn't explicitly cover — it is a review, not a greenfield hardening effort.

## Scope

Four areas, reviewed sequentially (not a parallel multi-agent fan-out — confirmed with the user as unnecessary for this scope):

1. **Dependency audit.** `npm audit` across the root and all 3 workspaces (`packages/shared`, `apps/api`, `apps/web`). Flag known CVEs and meaningfully outdated major versions of key packages (Express, Drizzle, React, etc.).
2. **Auth/session/authorization code review.** Manual read of `apps/api/src/middleware/auth.ts`, `apps/api/src/middleware/household.ts` (`requireHousehold`), session token generation/hashing/expiry logic, the CSRF middleware, password reset/change flows, and invite-token flows. Verify each README claim against the actual code (e.g., is the reset-revokes-every-session claim actually true today; is the account-enumeration timing-equalization still in place). Looking for logic bugs — missing checks, IDOR via household-scoping gaps, timing issues — not just re-reading the README as fact.
3. **OWASP Top 10-style pass.** Injection (any raw `sql` tagged-template Drizzle usage that isn't fully parameterized), XSS (any `dangerouslySetInnerHTML` in the web app — not mentioned in the README's table at all), SSRF (any outbound `fetch` built from user-controlled input — e.g. webhook-style URLs), broken access control (overlaps with #2 — cross-check, don't duplicate), sensitive data exposure (secrets/PII leaking into logs or error responses beyond what pino's redaction list already covers), security misconfiguration (e.g., a dev-only bypass accidentally reachable in production config).
4. **Security headers / transport config.** Confirm `helmet`'s actual configured directives in `apps/api/src/app.ts` (or wherever it's wired) match the README's claims (CSP, nosniff, frame denial, HSTS), confirm CORS origin-allowlist behavior, confirm session cookie flags (`httpOnly`/`secure`/`sameSite`) are correct in both dev and the `NODE_ENV=production` path.

**Explicitly out of scope:** the known `scrub()`-drops-Date-fields audit-log bug (tracked separately — a data-integrity issue, not a security one). Load/perf testing (Spec 2) and broader production-hardening config like env-var validation depth or observability (Spec 3) are separate specs in this phase — this spec claims security headers/cookie flags specifically because they're inherently security-review territory.

## Output and fix policy

A written findings report at `docs/security/2026-10-14-security-review.md`. Every finding tagged by severity (Critical/High/Medium/Low) with a file:line reference and a plain explanation of the risk. **Critical and High findings get fixed as part of this spec's implementation** — each as its own small, targeted patch with a test proving the fix. Medium and Low findings are documented in the report for later triage, not fixed now, so this spec's implementation scope stays bounded by what's actually found rather than open-ended.

## Testing

- Each Critical/High fix gets a regression test proving the specific vulnerability is closed (e.g., a test hitting the exact IDOR path and asserting 404, or a test confirming a security header is present on responses).
- No test is written for Medium/Low findings in this spec — they're documentation only until triaged.
- The dependency audit and the manual code-review areas (OWASP pass, headers check) are not independently "tested" beyond the fixes above — they produce findings in the report, verified by direct inspection (e.g., running `curl -I` against a dev server to confirm actual response headers) rather than new automated tests.
