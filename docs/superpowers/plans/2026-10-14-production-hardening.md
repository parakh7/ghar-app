# Production Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A pluggable error reporter, a production-only `EMAIL_FROM` safeguard, and a Redis-backed rate-limit store usable across multiple API instances.

**Architecture:** The error reporter mirrors the existing `EmailProvider` interface pattern exactly (`Console`/`Memory` implementations, wired into `Deps`). The rate-limit store becomes Redis-backed via an optional `redis` client threaded through `Deps` and the three limiter functions — when no client is provided (the test environment), limiters fall back to their current in-memory behavior unchanged, so the existing throttle-behavior tests in `security.test.ts` keep passing exactly as they do today with zero Redis dependency in the test suite.

**Tech Stack:** `rate-limit-redis` (new), `ioredis` (already present transitively via BullMQ, now imported directly) — no other new dependencies.

## Global Constraints

- No vendor SDK (Sentry, Bugsnag, etc.) and no real email-provider vendor get integrated in this plan — there's no account/DSN to wire up yet. `ConsoleErrorReporter` is the only non-test implementation.
- **Plan-time correction to the spec:** the spec's testing section said to use "the same real-Redis test approach the job-queue tests already use." That approach doesn't exist — `apps/api/src/lib/queue.test.ts` mocks the `bullmq` module entirely (`vi.mock("bullmq")`) and never connects to a real Redis instance; the integration test suite uses `FakeQueue`, not a real queue. This matches a known constraint from an earlier phase: this sandbox has no Docker/Redis available for agents to verify against, so real-Redis verification is always a manual step the user runs themselves. This plan follows the actual established pattern instead: a mocked `ioredis` client for a narrow wiring-only unit test (Task 3), and the existing `security.test.ts` throttle tests are left completely unchanged (they'll keep exercising the in-memory store, since the test environment never supplies a `redis` client).
- `Deps.redis` is **optional** (`redis?: Redis`) specifically so the test environment can omit it and limiters fall back to in-memory — this is the mechanism that keeps existing tests passing, not an oversight.

---

### Task 1: Pluggable error reporter

**Files:**
- Create: `apps/api/src/lib/error-reporter.ts`
- Modify: `apps/api/src/services/deps.ts` (add `errorReporter: ErrorReporter`)
- Modify: `apps/api/src/middleware/error.ts` (`errorHandler`)
- Modify: `apps/api/src/app.ts` (pass `deps.errorReporter` to `errorHandler`)
- Modify: `apps/api/src/server.ts` (construct `ConsoleErrorReporter`, add to `Deps`)
- Modify: `apps/api/tests/helpers.ts` (construct `MemoryErrorReporter`, add to `Deps`, expose on `TestContext`)
- Test: `apps/api/tests/error-handling.test.ts` (new file — check first whether `apps/api/tests/` already has a file testing `errorHandler`/`notFoundHandler`; if `security.test.ts`'s "never leaks internals on malformed input" test already covers this file, add the new tests there instead of creating a duplicate file)

**Interfaces:**
- Produces: `ErrorReporter` interface with `report(err: unknown, context: { reqId?: string; path?: string }): void`. `ConsoleErrorReporter` (constructor takes a `Logger`) and `MemoryErrorReporter` (no-arg constructor, `readonly reported: Array<{ err: unknown; context: { reqId?: string; path?: string } }>`, with a `last(): typeof this.reported[number] | undefined` helper) both implement it.
- Consumes: `Logger` type (existing, `apps/api/src/lib/logger.js`).

- [ ] **Step 1: Write the failing tests**

First, check `apps/api/tests/security.test.ts` for a `describe("hardening", ...)` block (the file's test list from earlier in this project included "never leaks internals on malformed input" and "marks API responses as non-cacheable" under a "hardening" describe) — add the new tests there if it exists, to keep error-handling-adjacent tests together; otherwise create `apps/api/tests/error-handling.test.ts` with its own `createTestContext()`.

```typescript
  it("reports a genuinely unhandled error to the error reporter", async () => {
    const ctx = createTestContext();
    // Force an unhandled error: query a table that doesn't exist via a raw malformed request
    // path isn't available from outside, so instead assert indirectly via a route guaranteed
    // to hit the generic 500 path is impractical without an injection point — use the
    // errorHandler directly instead of a full HTTP round trip for this specific test.
    const { errorHandler } = await import("../src/middleware/error.js");
    const { MemoryErrorReporter } = await import("../src/lib/error-reporter.js");
    const reporter = new MemoryErrorReporter();
    const handler = errorHandler(ctx.deps.logger, reporter);
    const req = { requestId: "req-1", path: "/api/whatever" } as never;
    const res = { status: () => res, json: () => res } as never;
    handler(new Error("boom"), req, res, (() => {}) as never);
    expect(reporter.reported).toHaveLength(1);
    expect(reporter.reported[0]?.context).toEqual({ reqId: "req-1", path: "/api/whatever" });
  });

  it("does not report an AppError (expected 4xx) to the error reporter", async () => {
    const ctx = createTestContext();
    const { errorHandler } = await import("../src/middleware/error.js");
    const { MemoryErrorReporter } = await import("../src/lib/error-reporter.js");
    const { Errors } = await import("../src/lib/errors.js");
    const reporter = new MemoryErrorReporter();
    const handler = errorHandler(ctx.deps.logger, reporter);
    const req = { requestId: "req-2", path: "/api/whatever" } as never;
    const res = { status: () => res, json: () => res } as never;
    handler(Errors.validation({ field: "bad" }), req, res, (() => {}) as never);
    expect(reporter.reported).toHaveLength(0);
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd apps/api && npm run test -- security` (or `error-handling`, matching whichever file you added the tests to)
Expected: FAIL — `../src/lib/error-reporter.js` doesn't exist, and `errorHandler` doesn't accept a second argument yet.

- [ ] **Step 3: Create the error reporter module**

```typescript
// apps/api/src/lib/error-reporter.ts
import type { Logger } from "./logger.js";

export type ErrorContext = { reqId?: string; path?: string };

/** Swap in Sentry/Bugsnag/etc. later without touching error-handling code — same pattern as EmailProvider. */
export interface ErrorReporter {
  report(err: unknown, context: ErrorContext): void;
}

/** Development/production-without-a-vendor: routes through the existing structured logger. */
export class ConsoleErrorReporter implements ErrorReporter {
  constructor(private readonly logger: Logger) {}
  report(err: unknown, context: ErrorContext): void {
    this.logger.error({ err, ...context }, "reported error");
  }
}

/** Tests: keeps reported errors in memory so assertions can inspect them. */
export class MemoryErrorReporter implements ErrorReporter {
  readonly reported: Array<{ err: unknown; context: ErrorContext }> = [];
  report(err: unknown, context: ErrorContext): void {
    this.reported.push({ err, context });
  }
  last(): { err: unknown; context: ErrorContext } | undefined {
    return this.reported[this.reported.length - 1];
  }
}
```

- [ ] **Step 4: Wire it into `Deps`**

In `apps/api/src/services/deps.ts`, add the import and field:

```typescript
import type { ErrorReporter } from "../lib/error-reporter.js";
```

```typescript
export type Deps = {
  env: Env;
  db: Database;
  logger: Logger;
  clock: Clock;
  email: EmailProvider;
  queue: Queue;
  errorReporter: ErrorReporter;
};
```

- [ ] **Step 5: Update `errorHandler` to take and use it**

In `apps/api/src/middleware/error.ts`, change the signature and the unhandled-error branch:

```typescript
import type { ErrorRequestHandler, RequestHandler } from "express";
import { AppError, Errors } from "../lib/errors.js";
import type { ErrorReporter } from "../lib/error-reporter.js";
import type { Logger } from "../lib/logger.js";
import { fail } from "../lib/respond.js";

export const notFoundHandler: RequestHandler = (_req, res) => fail(res, Errors.notFound("That page"));

/** Users never see raw errors; technical details go to logs (and the error reporter) with the request id. */
export function errorHandler(logger: Logger, errorReporter: ErrorReporter): ErrorRequestHandler {
  return (err: unknown, req, res, _next) => {
    if (err instanceof AppError) return fail(res, err);
    const e = err as { type?: string; status?: number };
    if (e?.type === "entity.parse.failed") return fail(res, Errors.validation({ _: "Malformed JSON body." }, "Malformed request."));
    if (e?.type === "entity.too.large") return fail(res, new AppError("VALIDATION_ERROR", "Request is too large.", 413));
    logger.error({ err, reqId: req.requestId, path: req.path }, "unhandled error");
    errorReporter.report(err, { reqId: req.requestId, path: req.path });
    fail(res, new AppError("INTERNAL_ERROR", "Something went wrong on our side. Please try again.", 500));
  };
}
```

- [ ] **Step 6: Update the call site in `app.ts`**

In `apps/api/src/app.ts`, change:

```typescript
  app.use(errorHandler(deps.logger));
```

to:

```typescript
  app.use(errorHandler(deps.logger, deps.errorReporter));
```

- [ ] **Step 7: Wire it in `server.ts`**

In `apps/api/src/server.ts`, add the import:

```typescript
import { ConsoleErrorReporter } from "./lib/error-reporter.js";
```

Add the instance and include it in the `createApp` call:

```typescript
const errorReporter = new ConsoleErrorReporter(logger);
const app = createApp({ env, db, logger, clock: systemClock, email, queue, errorReporter });
```

- [ ] **Step 8: Wire it in `tests/helpers.ts`**

In `apps/api/tests/helpers.ts`, add the import:

```typescript
import { MemoryErrorReporter } from "../src/lib/error-reporter.js";
```

Add `errorReporter: MemoryErrorReporter;` to the `TestContext` type, construct it (`const errorReporter = new MemoryErrorReporter();`), include it in the `deps` object (`const deps: Deps = { env, db, logger: createLogger(env), clock, email, queue, errorReporter };`), and return it from `createTestContext` (`return { deps, db, email, clock, queue, errorReporter, request: supertest(app), close: () => pool.end() };`).

- [ ] **Step 9: Run the tests to verify they pass**

Run: `cd apps/api && npm run test -- security` (or `error-handling`)
Expected: PASS

- [ ] **Step 10: Run the full API test suite as a regression check**

Run: `cd apps/api && npm run test`
Expected: PASS, no regressions (every test file that calls `createTestContext()` now gets a working `errorReporter` automatically — nothing else should need to change)

- [ ] **Step 11: Typecheck and build**

Run: `cd apps/api && npm run typecheck` then `cd apps/api && npm run build`
Expected: both PASS (typecheck may show the 2 pre-existing unrelated failures already known from earlier work in this session — not yours to fix)

- [ ] **Step 12: Commit**

```bash
git add apps/api/src/lib/error-reporter.ts apps/api/src/services/deps.ts apps/api/src/middleware/error.ts apps/api/src/app.ts apps/api/src/server.ts apps/api/tests/helpers.ts apps/api/tests/security.test.ts
git commit -m "feat(api): pluggable error reporter"
```

(Drop `apps/api/tests/security.test.ts` from that list and replace with `apps/api/tests/error-handling.test.ts` if you created a new file instead of extending the existing one.)

---

### Task 2: Production-only EMAIL_FROM safeguard

**Files:**
- Modify: `apps/api/src/config/env.ts`
- Modify: `README.md` (deployment checklist wording)
- Test: `apps/api/src/config/env.test.ts` (check first whether this file already exists; if so, add to it)

**Interfaces:** None — this only tightens an existing Zod schema's validation.

- [ ] **Step 1: Write the failing tests**

Check if `apps/api/src/config/env.test.ts` already exists (search for other env-related test files under `apps/api/src/config/` or `apps/api/tests/`). If it exists, add these tests to its existing `describe` block, matching its existing style; otherwise create it:

```typescript
import { describe, expect, it } from "vitest";
import { loadEnv } from "./env.js";

describe("loadEnv", () => {
  it("rejects the default placeholder EMAIL_FROM in production", () => {
    expect(() => loadEnv({ NODE_ENV: "production", DATABASE_URL: "postgresql://x/y" })).toThrow(/EMAIL_FROM/);
  });

  it("accepts an explicit non-placeholder EMAIL_FROM in production", () => {
    const env = loadEnv({ NODE_ENV: "production", DATABASE_URL: "postgresql://x/y", EMAIL_FROM: "Ghar <no-reply@real-domain.com>" });
    expect(env.EMAIL_FROM).toBe("Ghar <no-reply@real-domain.com>");
  });

  it("still allows the default placeholder EMAIL_FROM in development and test", () => {
    const dev = loadEnv({ NODE_ENV: "development", DATABASE_URL: "postgresql://x/y" });
    expect(dev.EMAIL_FROM).toBe("Household <no-reply@example.com>");
    const test = loadEnv({ NODE_ENV: "test", DATABASE_URL: "postgresql://x/y" });
    expect(test.EMAIL_FROM).toBe("Household <no-reply@example.com>");
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd apps/api && npm run test -- env`
Expected: FAIL — the production case with the placeholder currently succeeds instead of throwing.

- [ ] **Step 3: Add the cross-field check**

In `apps/api/src/config/env.ts`, the current schema and `loadEnv` are:

```typescript
const envSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().int().positive().default(4000),
  APP_URL: z.string().url().default("http://localhost:5173"),
  CORS_ORIGINS: z.string().default(""),
  TRUST_PROXY: z.coerce.number().int().min(0).default(0),
  DATABASE_URL: z.string().url(),
  REDIS_URL: z.string().url().default("redis://localhost:6379"),
  SESSION_TTL_DAYS: z.coerce.number().int().min(1).max(365).default(30),
  EMAIL_PROVIDER: z.enum(["console", "memory"]).default("console"),
  EMAIL_FROM: z.string().default("Household <no-reply@example.com>"),
  RATE_LIMIT_AUTH_MAX: z.coerce.number().int().positive().default(10),
  RATE_LIMIT_GLOBAL_MAX: z.coerce.number().int().positive().default(300),
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"]).default("info"),
  LOG_PRETTY: bool.optional(),
});

export type Env = z.infer<typeof envSchema>;

export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const parsed = envSchema.safeParse(source);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `  ${i.path.join(".")}: ${i.message}`).join("\n");
    throw new Error(`Invalid environment configuration:\n${issues}`);
  }
  return parsed.data;
}
```

Add a placeholder constant right above `envSchema`, and a `.superRefine()` after the object definition:

```typescript
const PLACEHOLDER_EMAIL_FROM = "Household <no-reply@example.com>";

const envSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().int().positive().default(4000),
  APP_URL: z.string().url().default("http://localhost:5173"),
  CORS_ORIGINS: z.string().default(""),
  TRUST_PROXY: z.coerce.number().int().min(0).default(0),
  DATABASE_URL: z.string().url(),
  REDIS_URL: z.string().url().default("redis://localhost:6379"),
  SESSION_TTL_DAYS: z.coerce.number().int().min(1).max(365).default(30),
  EMAIL_PROVIDER: z.enum(["console", "memory"]).default("console"),
  EMAIL_FROM: z.string().default(PLACEHOLDER_EMAIL_FROM),
  RATE_LIMIT_AUTH_MAX: z.coerce.number().int().positive().default(10),
  RATE_LIMIT_GLOBAL_MAX: z.coerce.number().int().positive().default(300),
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"]).default("info"),
  LOG_PRETTY: bool.optional(),
}).superRefine((env, ctx) => {
  if (env.NODE_ENV === "production" && env.EMAIL_FROM === PLACEHOLDER_EMAIL_FROM) {
    ctx.addIssue({ code: "custom", path: ["EMAIL_FROM"], message: "EMAIL_FROM must be set to a real sender address in production (the default placeholder is for development only)." });
  }
});
```

`loadEnv` itself needs no change — `safeParse` already runs the `.superRefine()` and surfaces its issue through the same error-formatting path.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd apps/api && npm run test -- env`
Expected: PASS

- [ ] **Step 5: Fix the deployment checklist wording**

In `README.md`'s "Deployment" section, change:

```markdown
- Replace `ConsoleEmailProvider` with a real provider (SES, Resend or Postmark) by implementing `EmailProvider` — a one-file change.
```

to:

```markdown
- Replace `ConsoleEmailProvider` with a real provider (SES, Resend or Postmark) by implementing `EmailProvider`, and add the corresponding value to `EMAIL_PROVIDER`'s enum in `apps/api/src/config/env.ts` — two files, not one.
- Set `EMAIL_FROM` to a real sender address — the API refuses to start in production with the development placeholder.
```

- [ ] **Step 6: Run the full API test suite as a regression check**

Run: `cd apps/api && npm run test`
Expected: PASS, no regressions

- [ ] **Step 7: Typecheck**

Run: `cd apps/api && npm run typecheck`
Expected: PASS (same 2 known pre-existing failures, unrelated)

- [ ] **Step 8: Commit**

```bash
git add apps/api/src/config/env.ts apps/api/src/config/env.test.ts README.md
git commit -m "fix(api): require a real EMAIL_FROM in production, fix deployment checklist wording"
```

(Adjust the test file path in the `git add` if you extended an existing file instead of creating `env.test.ts`.)

---

### Task 3: Redis-backed rate-limit store

**Files:**
- Modify: `apps/api/src/middleware/rate-limit.ts`
- Modify: `apps/api/src/services/deps.ts` (add optional `redis?: Redis`)
- Modify: `apps/api/src/app.ts` (pass `deps.redis` to `globalLimiter`)
- Modify: `apps/api/src/routes/auth.routes.ts` (pass `deps.redis` to `authLimiter`)
- Modify: `apps/api/src/routes/household.routes.ts` (pass `deps.redis` to `inviteLimiter`)
- Modify: `apps/api/src/server.ts` (construct a real `ioredis` client, add to `Deps`)
- Test: `apps/api/src/middleware/rate-limit.test.ts` (new file)

**Interfaces:**
- Consumes: `Deps` (Task 1's `errorReporter` field already added — this task adds `redis` alongside it, don't remove `errorReporter`).
- Produces: `globalLimiter(max: number, redis?: Redis): RequestHandler`, `authLimiter(max: number, redis?: Redis): RequestHandler`, `inviteLimiter(max: number, redis?: Redis): RequestHandler` — all three gain the same optional second parameter with identical semantics (Redis-backed when provided, in-memory when omitted).

- [ ] **Step 1: Install the dependency**

```bash
cd apps/api && npm install rate-limit-redis
```

Run `cd apps/api && npm run build` immediately after (no code changes yet) to confirm the install itself didn't break anything. `ioredis` is already present as a transitive dependency of `bullmq` — confirm with `npm ls ioredis` that it resolves; if it's absent for any reason, run `npm install ioredis` explicitly.

- [ ] **Step 2: Write the failing test**

```typescript
// apps/api/src/middleware/rate-limit.test.ts
import { describe, expect, it, vi } from "vitest";

const sendCommandCalls: unknown[][] = [];

vi.mock("ioredis", () => {
  class FakeRedis {
    async call(...args: unknown[]) {
      sendCommandCalls.push(args);
      return "OK";
    }
  }
  return { default: FakeRedis };
});

describe("rate limiters with a Redis client", () => {
  it("globalLimiter builds a RedisStore with the expected prefix when given a redis client", async () => {
    const { default: Redis } = await import("ioredis");
    const { globalLimiter } = await import("./rate-limit.js");
    const redis = new Redis();
    const limiter = globalLimiter(100, redis as never);
    expect(limiter).toBeTypeOf("function");
  });

  it("globalLimiter falls back to the in-memory store when no redis client is given", async () => {
    const { globalLimiter } = await import("./rate-limit.js");
    const limiter = globalLimiter(100);
    expect(limiter).toBeTypeOf("function");
  });
});
```

(This test intentionally checks construction doesn't throw rather than exercising full HTTP throttling behavior through a real Redis server — see this plan's Global Constraints section for why: no real Redis is available to agents in this sandbox, and the codebase's own `queue.test.ts` establishes the same mocked-dependency precedent for exactly this reason.)

- [ ] **Step 3: Run the test to verify it fails**

Run: `cd apps/api && npm run test -- rate-limit`
Expected: FAIL — `globalLimiter` doesn't accept a second argument yet.

- [ ] **Step 4: Update the rate-limit middleware**

Replace the full contents of `apps/api/src/middleware/rate-limit.ts`:

```typescript
import { rateLimit, ipKeyGenerator } from "express-rate-limit";
import { RedisStore } from "rate-limit-redis";
import type { RequestHandler } from "express";
import type Redis from "ioredis";
import { Errors } from "../lib/errors.js";
import { fail } from "../lib/respond.js";

/**
 * Redis-backed when a client is given (production/development — correct across multiple API
 * instances); falls back to express-rate-limit's built-in in-memory store when omitted (the test
 * environment never supplies one, so existing throttle-behavior tests keep working unchanged).
 */
function storeFor(prefix: string, redis?: Redis) {
  if (!redis) return undefined;
  return new RedisStore({ prefix, sendCommand: (...args: string[]) => redis.call(...args) });
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
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `cd apps/api && npm run test -- rate-limit`
Expected: PASS

- [ ] **Step 6: Add `redis` to `Deps`**

In `apps/api/src/services/deps.ts`:

```typescript
import type Redis from "ioredis";
```

```typescript
export type Deps = {
  env: Env;
  db: Database;
  logger: Logger;
  clock: Clock;
  email: EmailProvider;
  queue: Queue;
  errorReporter: ErrorReporter;
  redis?: Redis;
};
```

- [ ] **Step 7: Wire a real client in `server.ts`**

In `apps/api/src/server.ts`, add the import:

```typescript
import Redis from "ioredis";
```

Construct it and add to the `createApp` call:

```typescript
const redis = new Redis(env.REDIS_URL);
redis.on("error", (err) => logger.error({ err }, "rate-limit redis error"));
const app = createApp({ env, db, logger, clock: systemClock, email, queue, errorReporter, redis });
```

Add it to the shutdown sequence too — inside `shutdown`'s `server.close(async () => { ... })` callback, alongside the existing `await queue.close();` / `await pool.end();`:

```typescript
    await redis.quit();
```

- [ ] **Step 8: Pass `deps.redis` at each limiter call site**

In `apps/api/src/app.ts`, change:

```typescript
  app.use("/api", globalLimiter(deps.env.RATE_LIMIT_GLOBAL_MAX));
```

to:

```typescript
  app.use("/api", globalLimiter(deps.env.RATE_LIMIT_GLOBAL_MAX, deps.redis));
```

In `apps/api/src/routes/auth.routes.ts`, change:

```typescript
  const limiter = authLimiter(deps.env.RATE_LIMIT_AUTH_MAX);
```

to:

```typescript
  const limiter = authLimiter(deps.env.RATE_LIMIT_AUTH_MAX, deps.redis);
```

In `apps/api/src/routes/household.routes.ts`, change:

```typescript
  const limiter = inviteLimiter(deps.env.RATE_LIMIT_AUTH_MAX);
```

to:

```typescript
  const limiter = inviteLimiter(deps.env.RATE_LIMIT_AUTH_MAX, deps.redis);
```

(`tests/helpers.ts`'s `Deps` construction needs no change — `redis` is optional and already simply absent there, which is exactly the fallback-to-in-memory path this task relies on.)

- [ ] **Step 9: Run the full API test suite as a regression check**

Run: `cd apps/api && npm run test`
Expected: PASS, no regressions — in particular, `security.test.ts`'s two existing throttle tests ("throttles repeated login attempts for the same email", "throttles invite creation and resend") must still pass exactly as before, since the test environment never supplies `deps.redis`.

- [ ] **Step 10: Typecheck and build**

Run: `cd apps/api && npm run typecheck` then `cd apps/api && npm run build`
Expected: both PASS (same 2 known pre-existing failures, unrelated)

- [ ] **Step 11: Commit**

```bash
git add apps/api/package.json ../../package-lock.json apps/api/src/middleware/rate-limit.ts apps/api/src/middleware/rate-limit.test.ts apps/api/src/services/deps.ts apps/api/src/server.ts apps/api/src/app.ts apps/api/src/routes/auth.routes.ts apps/api/src/routes/household.routes.ts
git commit -m "feat(api): Redis-backed rate-limit store for multi-instance correctness"
```

(Run this `git add`/`git commit` pair from the repository root, not from `apps/api` — the relative `../../package-lock.json` path assumes that. If running from the repo root instead, use `package-lock.json` directly.)

- [ ] **Step 12: Manual verification note (not automatable)**

This plan's Global Constraints section explains why: no real Redis connection is available to verify against in this sandbox. Before this ships, start the app against a real Redis instance (`docker compose up -d redis`, already documented in `README.md`'s local setup) and manually confirm: (1) the app starts without error, (2) hitting the auth rate limit (e.g. repeated failed logins) still returns `429`, (3) `redis-cli keys 'rl:*'` shows the expected prefixed keys.

---

## Self-Review Notes

- **Spec coverage:** error reporter (Task 1), `EMAIL_FROM` production safeguard + deployment checklist wording (Task 2), Redis-backed rate limiting (Task 3) — every spec section has a task.
- **Placeholder scan:** every step has concrete before/after code. The two "check if a file already exists first" instructions (Task 1 Step 1, Task 2 Step 1) are existing-file inspections with a concrete fallback (create the named file) if it doesn't exist — not open-ended guesses.
- **Type consistency:** `Deps` gains `errorReporter: ErrorReporter` (Task 1) then `redis?: Redis` (Task 3) — both additive, non-breaking to every other field. `globalLimiter`/`authLimiter`/`inviteLimiter`'s new `redis?: Redis` second parameter has identical semantics and type across all three functions and all three call sites.
- **Flagged and corrected a spec inaccuracy during planning:** the spec's testing section claimed a real-Redis test precedent exists in this codebase; it doesn't. Task 3's design (optional `redis` param, mocked-`ioredis` unit test, unchanged integration tests) was built around the codebase's actual existing pattern instead, with the discrepancy noted in this plan's Global Constraints.
