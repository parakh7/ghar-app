# Production Hardening — Design Spec

**Phase:** 10 (Security review, load/perf testing, production hardening) — Spec 2 of 3.

**Status:** Approved.

## Context

This app already has substantial production-readiness groundwork: env validation at startup (`apps/api/src/config/env.ts`, the API refuses to start with invalid config), graceful SIGTERM shutdown, liveness/readiness health checks, structured redacted pino logging correlated by `x-request-id`, and a documented deployment checklist in `README.md`. The one gap the README itself explicitly flags: rate limiting (`apps/api/src/middleware/rate-limit.ts`) uses an in-memory store, correct only for a single API instance — its own comment already names the fix (`rate-limit-redis`, using the existing `REDIS_URL`).

## Scope

**1. Rate-limit store: memory → Redis.**
- Add `rate-limit-redis` (new dependency) to `apps/api`.
- A dedicated `ioredis` client (already present transitively via BullMQ, used directly here — not BullMQ's own internal connection, which is private to the `BullMQQueue` class) connects using the existing `REDIS_URL`.
- All three limiters in `rate-limit.ts` — `globalLimiter`, `authLimiter`, `inviteLimiter` — get a `RedisStore`, each with its own key prefix (e.g. `rl:global:`, `rl:auth:`, `rl:invite:`) sharing the one Redis connection, so the three limiters' counters can't collide with each other.
- Redis is already load-bearing for Phase 7's job queue — this doesn't add a new hard dependency, it makes an existing one's correctness match what's already documented.

**2. Pluggable error reporter.** Mirrors the existing `EmailProvider` pattern (`apps/api/src/services/email/email.provider.ts`) exactly:
- New `ErrorReporter` interface: `report(err: unknown, context: { reqId?: string; path?: string }): void`.
- `ConsoleErrorReporter` — logs via the existing pino `Logger` (same information `errorHandler` already logs today, just routed through the same seam a real vendor would plug into).
- `MemoryErrorReporter` — in-memory array of reported errors, for test assertions.
- Wired into `Deps` alongside the existing `EmailProvider`/`Queue` dependencies.
- Called from `errorHandler` (`apps/api/src/middleware/error.ts:15`, immediately alongside the existing `logger.error(...)` call) — **only** for the genuinely-unhandled-error branch, not for `AppError` instances (expected 4xx validation/auth/not-found responses aren't bugs and shouldn't be reported as such).
- No vendor SDK (Sentry, Bugsnag, etc.) integrated in this spec — there's no production deployment or vendor account to wire up yet. Swapping `ConsoleErrorReporter` for a real one later is a one-file change, same story as `EmailProvider`.

**3. Env validation fixes (two concrete gaps found during design):**
- `EMAIL_FROM` (`apps/api/src/config/env.ts:15`) currently defaults to a placeholder (`"Household <no-reply@example.com>"`) regardless of `NODE_ENV`. In production, forgetting to set it means the app silently sends real emails from a fake domain instead of failing loudly at startup — exactly the kind of silent misconfiguration env validation exists to prevent. Fix: the schema must require an explicit, non-default value when `NODE_ENV=production`, while keeping today's friendly default for `development`/`test`. This needs a `.superRefine()` (or equivalent cross-field check) on the env schema, since the requirement depends on `NODE_ENV`'s value, not `EMAIL_FROM` alone.
- `README.md`'s deployment checklist claims implementing a new `EmailProvider` is "a one-file change," but `EMAIL_PROVIDER`'s env enum (`env.ts:14`, currently `z.enum(["console", "memory"])`) has no slot for a real provider — selecting one in production would require *also* extending this enum, making it at least two files. This is a documentation-accuracy fix (correct the checklist wording), not a code fix — adding an enum value for a vendor that isn't implemented would just be dead code.

**Explicitly out of scope:** choosing or integrating any specific error-tracking vendor or email-provider vendor (no account/DSN exists to wire up against); load/perf testing (Spec 3 of this phase).

## Testing

- Rate-limit Redis store: a test confirming the limiter's `RedisStore` actually persists/increments counts in the test Redis instance across requests (using the same real-Redis test approach the job-queue tests already use, not a mock), and that the three limiters' prefixed keys don't collide with each other.
- Error reporter: a test confirming `errorHandler` calls `MemoryErrorReporter.report(...)` for a genuinely unhandled error, and confirming it does **not** call it for an `AppError` (e.g. a validation failure) — the negative case matters as much as the positive one here.
- Env validation: a test confirming `loadEnv` rejects a production-mode config with the default/placeholder `EMAIL_FROM` value, and accepts an explicit non-default value in production, and still accepts the default in development/test.
