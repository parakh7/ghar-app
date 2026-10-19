# Device-Level Web Push Notifications Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deliver real device-level browser push notifications for due bill/salary reminders, closing the gap left since Phase 7: `evaluate-reminders.job.ts` has been writing `notification_deliveries` rows with `channel='WEB_PUSH', status='PENDING'` all along, with no dispatcher, subscribe flow, or service-worker handling to consume them.

**Architecture:** Self-hosted VAPID Web Push via the `web-push` npm package (no third-party push vendor). A new `dispatch-web-push-deliveries` job mirrors the existing `dispatch-email-deliveries` job's structure exactly (same batch size, retry/attempts contract, per-row isolation) but fans a single delivery row out to every one of the user's active devices (the `notification_deliveries` table has one WEB_PUSH row per notification, not per device — `push_subscriptions` is where multi-device lives). The browser side adds a subscribe/unsubscribe flow to Settings and two new listeners in the existing hand-written service worker (`src/sw.ts`, which already uses `injectManifest` — no strategy change needed).

**Tech Stack:** `web-push` (new apps/api dependency) for VAPID-signed push delivery. No new apps/web dependencies — `Notification`, `PushManager`, and `ServiceWorkerRegistration.showNotification` are browser globals.

## Global Constraints

- Per-category `pushEnabled` toggle on `NotificationPreferenceDTO`, mirroring the existing `emailEnabled` toggle exactly — not a single global on/off switch.
- Include a "Send test notification" button/endpoint in Settings, for instant feedback right after subscribing.
- Self-hosted VAPID via `web-push` — no third-party push vendor.
- `push_subscriptions` table already exists (`apps/api/src/db/schema.ts:574-585`) — no migration needed. Columns: `id, userId, endpoint (unique), p256dh, auth, userAgent, lastUsedAt, revokedAt, createdAt, updatedAt`.
- `notification_deliveries` has a **unique index on `(notificationId, channel)`** (`schema.ts:572`) — exactly one `WEB_PUSH` row per notification. Multi-device fan-out happens inside the dispatch job for that single row, not at the row level.
- Dispatch job batch size: `BATCH_LIMIT = 100`. Retry contract: `MAX_ATTEMPTS = 3` (matches `dispatch-email-deliveries.job.ts`) — `attempts` increments on failure, stays `PENDING` under 3, becomes terminal `FAILED` at 3.
- A subscription the push service reports as gone (HTTP 404/410) is revoked (`push_subscriptions.revokedAt` set), never retried — that's device churn, not a send failure.
- Env vars (already stubbed in `apps/api/.env.example:51-53`, reuse these exact names): `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, `VAPID_EMAIL`. New: `PUSH_PROVIDER` enum `["console", "memory", "web-push"]`, default `"console"`.
- Frontend VAPID public key delivery: build-time `VITE_VAPID_PUBLIC_KEY` env var (matches the existing `VITE_API_URL` pattern in `apps/web/src/lib/api.ts:12`) — not a new API endpoint.
- Push payload JSON shape sent over the wire: `{ title: string; body: string; tag: string; linkPath: string | null }` (no `icon` field — the service worker hardcodes `/pwa-192x192.png` client-side).
- Service worker notification tag: `"reminder-notification"`. Message type posted back to the app on notification click: `"notification-click"`.
- New route paths: `POST /api/push-subscriptions`, `POST /api/push-subscriptions/unsubscribe` (user-scoped, not household-scoped), `POST /api/households/:householdId/notifications/test-push` (household-scoped, permission `household.view`).

---

### Task 1: Shared DTO & schemas

**Files:**
- Modify: `packages/shared/src/dto.ts:133-135`
- Modify: `packages/shared/src/schemas.ts:386-390`

**Interfaces:**
- Produces: `NotificationPreferenceDTO.pushEnabled: boolean`, `pushSubscribeSchema` (zod), `PushSubscribeInput` type, `pushUnsubscribeSchema` (zod), `PushUnsubscribeInput` type — all consumed by every later task.

- [ ] **Step 1: Extend `NotificationPreferenceDTO`**

In `packages/shared/src/dto.ts`, replace:

```ts
export type NotificationPreferenceDTO = {
  category: SettableNotificationCategory; enabled: boolean; emailEnabled: boolean;
};
```

with:

```ts
export type NotificationPreferenceDTO = {
  category: SettableNotificationCategory; enabled: boolean; emailEnabled: boolean; pushEnabled: boolean;
};
```

- [ ] **Step 2: Extend `updateNotificationPreferenceSchema` and add push subscribe/unsubscribe schemas**

In `packages/shared/src/schemas.ts`, replace:

```ts
export const updateNotificationPreferenceSchema = z.object({
  enabled: z.boolean().optional(),
  emailEnabled: z.boolean().optional(),
}).refine((v) => v.enabled !== undefined || v.emailEnabled !== undefined, { message: "Provide at least one field to update." });
export type UpdateNotificationPreferenceInput = z.infer<typeof updateNotificationPreferenceSchema>;
```

with:

```ts
export const updateNotificationPreferenceSchema = z.object({
  enabled: z.boolean().optional(),
  emailEnabled: z.boolean().optional(),
  pushEnabled: z.boolean().optional(),
}).refine((v) => v.enabled !== undefined || v.emailEnabled !== undefined || v.pushEnabled !== undefined, { message: "Provide at least one field to update." });
export type UpdateNotificationPreferenceInput = z.infer<typeof updateNotificationPreferenceSchema>;

export const pushSubscribeSchema = z.object({
  endpoint: z.string().url(),
  keys: z.object({ p256dh: z.string().min(1), auth: z.string().min(1) }),
  userAgent: z.string().max(512).optional(),
});
export type PushSubscribeInput = z.infer<typeof pushSubscribeSchema>;

export const pushUnsubscribeSchema = z.object({ endpoint: z.string().url() });
export type PushUnsubscribeInput = z.infer<typeof pushUnsubscribeSchema>;
```

- [ ] **Step 3: Build the shared package and verify no type errors**

Run: `npm run build --workspace @household/shared`
Expected: builds clean (no test file needed — this is pure type/schema plumbing, verified indirectly by every downstream task's tests, matching the convention that `emailEnabled` never got its own schema-only test either).

- [ ] **Step 4: Commit**

```bash
git add packages/shared/src/dto.ts packages/shared/src/schemas.ts
git commit -m "feat(shared): add pushEnabled and push subscribe/unsubscribe schemas"
```

---

### Task 2: Push provider abstraction + VAPID env config (apps/api)

**Files:**
- Modify: `apps/api/src/config/env.ts`
- Modify: `apps/api/src/config/env.test.ts`
- Create: `apps/api/src/services/push/push.provider.ts`
- Create: `apps/api/src/services/push/web-push.provider.ts`
- Create: `apps/api/src/services/push/web-push.provider.test.ts`
- Modify: `apps/api/package.json`
- Modify: `apps/api/.env.example`

**Interfaces:**
- Produces: `PushProvider` interface (`send(subscription: PushSubscriptionKeys, payload: PushPayload): Promise<void>`), `PushSendError` class (`.statusCode?: number`), `ConsolePushProvider`, `MemoryPushProvider` (test fake, `.sent`, `.failNext(endpoint, "error" | "expired")`), `WebPushProvider`. `Env.PUSH_PROVIDER: "console" | "memory" | "web-push"`, `Env.VAPID_PUBLIC_KEY?: string`, `Env.VAPID_PRIVATE_KEY?: string`, `Env.VAPID_EMAIL: string`.
- Consumes: nothing from earlier tasks.

- [ ] **Step 1: Add the `web-push` dependency**

In `apps/api/package.json`, add to `dependencies`: `"web-push": "^3.6.7"`, and to `devDependencies`: `"@types/web-push": "^3.6.4"`.

Run: `npm install` (from the repo root).

- [ ] **Step 2: Write the failing env tests**

Append to `apps/api/src/config/env.test.ts`, inside the `describe("loadEnv", ...)` block, after the last existing `it`:

```ts
  it("defaults PUSH_PROVIDER to console, no VAPID keys required", () => {
    const env = loadEnv({ DATABASE_URL: "postgresql://x/y" });
    expect(env.PUSH_PROVIDER).toBe("console");
    expect(env.VAPID_PUBLIC_KEY).toBeUndefined();
  });

  it("requires VAPID_PUBLIC_KEY and VAPID_PRIVATE_KEY when PUSH_PROVIDER=web-push", () => {
    expect(() => loadEnv({ DATABASE_URL: "postgresql://x/y", PUSH_PROVIDER: "web-push" })).toThrow(/VAPID_PUBLIC_KEY/);
  });

  it("accepts PUSH_PROVIDER=web-push when both VAPID keys are set", () => {
    const env = loadEnv({ DATABASE_URL: "postgresql://x/y", PUSH_PROVIDER: "web-push", VAPID_PUBLIC_KEY: "pub", VAPID_PRIVATE_KEY: "priv" });
    expect(env.PUSH_PROVIDER).toBe("web-push");
  });

  it("rejects a VAPID_EMAIL that isn't a mailto: or https: URI when PUSH_PROVIDER=web-push", () => {
    expect(() => loadEnv({ DATABASE_URL: "postgresql://x/y", PUSH_PROVIDER: "web-push", VAPID_PUBLIC_KEY: "pub", VAPID_PRIVATE_KEY: "priv", VAPID_EMAIL: "admin@example.com" }))
      .toThrow(/VAPID_EMAIL/);
  });
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `cd apps/api && npm run test -- env`
Expected: FAIL — `PUSH_PROVIDER` is not a recognized key / `env.PUSH_PROVIDER` is `undefined`.

- [ ] **Step 4: Implement the env changes**

In `apps/api/src/config/env.ts`, add these fields to `envSchema`'s object, right after `RESEND_API_KEY: z.string().optional(),`:

```ts
  PUSH_PROVIDER: z.enum(["console", "memory", "web-push"]).default("console"),
  VAPID_PUBLIC_KEY: z.string().optional(),
  VAPID_PRIVATE_KEY: z.string().optional(),
  VAPID_EMAIL: z.string().default("mailto:admin@example.com"),
```

And add this block inside `.superRefine((env, ctx) => { ... })`, right after the `RESEND_API_KEY` check:

```ts
  if (env.PUSH_PROVIDER === "web-push") {
    if (!env.VAPID_PUBLIC_KEY) ctx.addIssue({ code: "custom", path: ["VAPID_PUBLIC_KEY"], message: "VAPID_PUBLIC_KEY is required when PUSH_PROVIDER=web-push." });
    if (!env.VAPID_PRIVATE_KEY) ctx.addIssue({ code: "custom", path: ["VAPID_PRIVATE_KEY"], message: "VAPID_PRIVATE_KEY is required when PUSH_PROVIDER=web-push." });
    if (!/^(mailto:|https?:)/.test(env.VAPID_EMAIL)) ctx.addIssue({ code: "custom", path: ["VAPID_EMAIL"], message: "VAPID_EMAIL must start with mailto: or https:// (the web-push spec requires a contactable VAPID subject)." });
  }
```

- [ ] **Step 5: Run the env tests to verify they pass**

Run: `cd apps/api && npm run test -- env`
Expected: PASS, all `loadEnv` tests green.

- [ ] **Step 6: Write the failing provider test**

Create `apps/api/src/services/push/web-push.provider.test.ts`:

```ts
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Logger } from "../../lib/logger.js";
import { PushSendError } from "./push.provider.js";
import { WebPushProvider } from "./web-push.provider.js";

const { setVapidDetails, sendNotification } = vi.hoisted(() => ({
  setVapidDetails: vi.fn(),
  sendNotification: vi.fn(),
}));
vi.mock("web-push", () => ({ default: { setVapidDetails, sendNotification } }));

function fakeLogger(): Logger {
  return { info: vi.fn(), error: vi.fn() } as unknown as Logger;
}

describe("WebPushProvider", () => {
  beforeEach(() => {
    setVapidDetails.mockClear();
    sendNotification.mockClear();
  });

  it("sets VAPID details once at construction", () => {
    new WebPushProvider("pub", "priv", "mailto:a@example.com", fakeLogger());
    expect(setVapidDetails).toHaveBeenCalledWith("mailto:a@example.com", "pub", "priv");
  });

  it("sends the subscription and JSON payload via web-push", async () => {
    sendNotification.mockResolvedValue(undefined);
    const provider = new WebPushProvider("pub", "priv", "mailto:a@example.com", fakeLogger());
    await provider.send({ endpoint: "https://push.example/abc", p256dh: "p", auth: "a" }, { title: "t", body: "b", tag: "reminder-notification", linkPath: "/bills/1" });
    expect(sendNotification).toHaveBeenCalledWith(
      { endpoint: "https://push.example/abc", keys: { p256dh: "p", auth: "a" } },
      JSON.stringify({ title: "t", body: "b", tag: "reminder-notification", linkPath: "/bills/1" }),
    );
  });

  it("throws PushSendError when web-push rejects with statusCode 410", async () => {
    sendNotification.mockRejectedValue(Object.assign(new Error("gone"), { statusCode: 410 }));
    const provider = new WebPushProvider("pub", "priv", "mailto:a@example.com", fakeLogger());
    await expect(provider.send({ endpoint: "e", p256dh: "p", auth: "a" }, { title: "t", body: "b", tag: "x", linkPath: null }))
      .rejects.toBeInstanceOf(PushSendError);
  });

  it("throws PushSendError when web-push rejects with statusCode 404", async () => {
    sendNotification.mockRejectedValue(Object.assign(new Error("not found"), { statusCode: 404 }));
    const provider = new WebPushProvider("pub", "priv", "mailto:a@example.com", fakeLogger());
    await expect(provider.send({ endpoint: "e", p256dh: "p", auth: "a" }, { title: "t", body: "b", tag: "x", linkPath: null }))
      .rejects.toBeInstanceOf(PushSendError);
  });

  it("passes through other errors unchanged", async () => {
    sendNotification.mockRejectedValue(new Error("network down"));
    const provider = new WebPushProvider("pub", "priv", "mailto:a@example.com", fakeLogger());
    await expect(provider.send({ endpoint: "e", p256dh: "p", auth: "a" }, { title: "t", body: "b", tag: "x", linkPath: null }))
      .rejects.toThrow("network down");
  });
});
```

- [ ] **Step 7: Run the test to verify it fails**

Run: `cd apps/api && npm run test -- web-push.provider`
Expected: FAIL — cannot find module `./push.provider.js` / `./web-push.provider.js`.

- [ ] **Step 8: Implement `push.provider.ts`**

Create `apps/api/src/services/push/push.provider.ts`:

```ts
import type { Logger } from "../../lib/logger.js";

export type PushSubscriptionKeys = { endpoint: string; p256dh: string; auth: string };
export type PushPayload = { title: string; body: string; tag: string; linkPath: string | null };

/** Thrown when the push service itself reports the subscription is dead (HTTP 404/410) — the one
 *  error shape dispatch code special-cases to revoke the subscription instead of retrying. */
export class PushSendError extends Error {
  constructor(message: string, public readonly statusCode?: number) {
    super(message);
    this.name = "PushSendError";
  }
}

export interface PushProvider {
  send(subscription: PushSubscriptionKeys, payload: PushPayload): Promise<void>;
}

/** Development: prints the push payload to the log instead of sending a real push. */
export class ConsolePushProvider implements PushProvider {
  constructor(private readonly logger: Logger) {}
  async send(subscription: PushSubscriptionKeys, payload: PushPayload): Promise<void> {
    this.logger.info({ push: { endpoint: subscription.endpoint, title: payload.title } }, `🔔 ${payload.title}\n${payload.body}`);
  }
}

/** Tests: records every send; failNext lets a test simulate one endpoint failing or expiring. */
export class MemoryPushProvider implements PushProvider {
  readonly sent: Array<{ subscription: PushSubscriptionKeys; payload: PushPayload }> = [];
  private readonly failures = new Map<string, "error" | "expired">();
  failNext(endpoint: string, mode: "error" | "expired"): void {
    this.failures.set(endpoint, mode);
  }
  async send(subscription: PushSubscriptionKeys, payload: PushPayload): Promise<void> {
    const mode = this.failures.get(subscription.endpoint);
    if (mode === "expired") throw new PushSendError("subscription expired", 410);
    if (mode === "error") throw new Error("push send failed");
    this.sent.push({ subscription, payload });
  }
}
```

- [ ] **Step 9: Implement `web-push.provider.ts`**

Create `apps/api/src/services/push/web-push.provider.ts`:

```ts
import webpush from "web-push";
import type { Logger } from "../../lib/logger.js";
import { PushSendError, type PushPayload, type PushProvider, type PushSubscriptionKeys } from "./push.provider.js";

/** web-push's sendNotification rejects with a WebPushError carrying `.statusCode` rather than a
 *  typed error class — 404/410 specifically mean the push service itself says the subscription is
 *  gone, normalized here into PushSendError so dispatch code can tell "device gone" apart from
 *  "send failed" without depending on web-push's error shape directly. */
export class WebPushProvider implements PushProvider {
  constructor(publicKey: string, privateKey: string, subject: string, private readonly logger: Logger) {
    webpush.setVapidDetails(subject, publicKey, privateKey);
  }

  async send(subscription: PushSubscriptionKeys, payload: PushPayload): Promise<void> {
    try {
      await webpush.sendNotification(
        { endpoint: subscription.endpoint, keys: { p256dh: subscription.p256dh, auth: subscription.auth } },
        JSON.stringify(payload),
      );
      this.logger.info({ push: { endpoint: subscription.endpoint, tag: payload.tag } }, "push sent via web-push");
    } catch (err) {
      const statusCode = (err as { statusCode?: number }).statusCode;
      if (statusCode === 404 || statusCode === 410) throw new PushSendError("subscription expired", statusCode);
      throw err;
    }
  }
}
```

- [ ] **Step 10: Run the provider test to verify it passes**

Run: `cd apps/api && npm run test -- web-push.provider`
Expected: PASS, all 5 tests green.

- [ ] **Step 11: Update `.env.example`**

In `apps/api/.env.example`, replace the `# ─── Later phases (not used yet) ─────────────────────────` block with:

```
# ─── Web Push ────────────────────────────────────────────
# PUSH_PROVIDER=console logs push payloads to the server log (no real push sent) — default, fine
# for local dev. PUSH_PROVIDER=web-push sends real browser push via VAPID (needs the keys below).
PUSH_PROVIDER=console

# Generate once per environment (not per deploy) with: npx web-push generate-vapid-keys
# Keep VAPID_PRIVATE_KEY secret; VAPID_PUBLIC_KEY is also needed by the frontend build
# (VITE_VAPID_PUBLIC_KEY in apps/web) — it is not sensitive.
# VAPID_PUBLIC_KEY=
# VAPID_PRIVATE_KEY=
VAPID_EMAIL=mailto:admin@example.com
```

- [ ] **Step 12: Commit**

```bash
git add apps/api/package.json apps/api/package-lock.json apps/api/src/config/env.ts apps/api/src/config/env.test.ts apps/api/src/services/push/push.provider.ts apps/api/src/services/push/web-push.provider.ts apps/api/src/services/push/web-push.provider.test.ts apps/api/.env.example
git commit -m "feat(api): add push provider abstraction and VAPID env config"
```

---

### Task 3: Wire push into Deps + subscribe/unsubscribe routes

**Files:**
- Modify: `apps/api/src/services/deps.ts`
- Modify: `apps/api/src/worker.ts`
- Modify: `apps/api/src/server.ts`
- Modify: `apps/api/tests/helpers.ts`
- Create: `apps/api/src/services/push/push-subscription.service.ts`
- Create: `apps/api/src/routes/push-subscription.routes.ts`
- Create: `apps/api/tests/push-subscription.test.ts`
- Modify: `apps/api/src/app.ts`

**Interfaces:**
- Consumes: `PushProvider`, `ConsolePushProvider`, `MemoryPushProvider`, `WebPushProvider` (Task 2); `pushSubscribeSchema`, `pushUnsubscribeSchema` (Task 1).
- Produces: `Deps.push: PushProvider`; `subscribe(deps, userId, input): Promise<void>`, `unsubscribe(deps, userId, endpoint): Promise<void>` (`push-subscription.service.ts`); `TestContext.push: MemoryPushProvider` (test helper, used by Tasks 5-6).

- [ ] **Step 1: Add `push` to `Deps`**

In `apps/api/src/services/deps.ts`, add the import and field:

```ts
import type { PushProvider } from "./push/push.provider.js";
```

```ts
export type Deps = {
  env: Env;
  db: Database;
  logger: Logger;
  clock: Clock;
  email: EmailProvider;
  push: PushProvider;
  queue: Queue;
  errorReporter: ErrorReporter;
  redis?: Redis;
};
```

- [ ] **Step 2: Construct the push provider in `worker.ts`**

In `apps/api/src/worker.ts`, add imports:

```ts
import { ConsolePushProvider, MemoryPushProvider } from "./services/push/push.provider.js";
import { WebPushProvider } from "./services/push/web-push.provider.js";
```

After the existing `const email = ...` block, add:

```ts
const push = env.PUSH_PROVIDER === "web-push" ? new WebPushProvider(env.VAPID_PUBLIC_KEY!, env.VAPID_PRIVATE_KEY!, env.VAPID_EMAIL, logger)
  : env.PUSH_PROVIDER === "memory" ? new MemoryPushProvider()
  : new ConsolePushProvider(logger);
```

Change `const deps: Deps = { env, db, logger, clock: systemClock, email, queue, errorReporter };` to:

```ts
const deps: Deps = { env, db, logger, clock: systemClock, email, push, queue, errorReporter };
```

- [ ] **Step 3: Construct the push provider in `server.ts`**

In `apps/api/src/server.ts`, add the same two imports as Step 2, add the same `const push = ...` block after the existing `const email = ...` block, and change:

```ts
const app = createApp({ env, db, logger, clock: systemClock, email, queue, errorReporter, redis });
```

to:

```ts
const app = createApp({ env, db, logger, clock: systemClock, email, push, queue, errorReporter, redis });
```

- [ ] **Step 4: Update `tests/helpers.ts`**

In `apps/api/tests/helpers.ts`, add the import:

```ts
import { MemoryPushProvider } from "../src/services/push/push.provider.js";
```

Add `push: MemoryPushProvider;` to the `TestContext` type, and in `createTestContext`, add `const push = new MemoryPushProvider();`, include `push` in both the `deps: Deps = { ... }` object literal and the function's returned object:

```ts
export type TestContext = {
  deps: Deps;
  db: Database;
  email: MemoryEmailProvider;
  push: MemoryPushProvider;
  clock: FakeClock;
  queue: FakeQueue;
  errorReporter: MemoryErrorReporter;
  request: ReturnType<typeof supertest>;
  close: () => Promise<void>;
};

export function createTestContext(envOverrides: Partial<Record<keyof Env, string>> = {}): TestContext {
  const env = loadEnv({ NODE_ENV: "test", DATABASE_URL: TEST_DB_URL, LOG_LEVEL: "silent", RATE_LIMIT_AUTH_MAX: "1000", RATE_LIMIT_GLOBAL_MAX: "10000", APP_URL: "http://localhost:5173", ...envOverrides });
  const pool = createPool(env.DATABASE_URL, 5);
  const db = createDb(pool);
  const email = new MemoryEmailProvider();
  const push = new MemoryPushProvider();
  const clock = new FakeClock();
  const queue = new FakeQueue();
  const errorReporter = new MemoryErrorReporter();
  const deps: Deps = { env, db, logger: createLogger(env), clock, email, push, queue, errorReporter };
  const app = createApp(deps);
  return { deps, db, email, push, clock, queue, errorReporter, request: supertest(app), close: () => pool.end() };
}
```

- [ ] **Step 5: Run the full api test suite once to confirm the Deps change didn't break anything**

Run: `cd apps/api && npm run typecheck && npm run test`
Expected: typecheck clean; all existing tests still pass (this is a pure additive change to `Deps` and the test context).

- [ ] **Step 6: Write the failing subscription tests**

Create `apps/api/tests/push-subscription.test.ts`:

```ts
import { eq } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { pushSubscriptions } from "../src/db/schema.js";
import { createTestContext, csrf, signupUser, truncateAll } from "./helpers.js";

const ctx = createTestContext();

beforeEach(async () => { await truncateAll(ctx.db); });
afterAll(() => ctx.close());

describe("push subscriptions", () => {
  describe("POST /push-subscriptions", () => {
    it("creates a subscription row for the caller", async () => {
      const user = await signupUser(ctx);
      const res = await ctx.request.post("/api/push-subscriptions").set(csrf).set("cookie", user.cookie)
        .send({ endpoint: "https://push.example/abc", keys: { p256dh: "p1", auth: "a1" } });
      expect(res.status).toBe(201);

      const [row] = await ctx.db.select().from(pushSubscriptions).where(eq(pushSubscriptions.endpoint, "https://push.example/abc"));
      expect(row).toMatchObject({ userId: user.id, p256dh: "p1", auth: "a1", revokedAt: null });
    });

    it("re-subscribing the same endpoint updates it instead of creating a duplicate", async () => {
      const user = await signupUser(ctx);
      await ctx.request.post("/api/push-subscriptions").set(csrf).set("cookie", user.cookie)
        .send({ endpoint: "https://push.example/abc", keys: { p256dh: "p1", auth: "a1" } });
      await ctx.request.post("/api/push-subscriptions").set(csrf).set("cookie", user.cookie)
        .send({ endpoint: "https://push.example/abc", keys: { p256dh: "p2", auth: "a2" } });

      const rows = await ctx.db.select().from(pushSubscriptions).where(eq(pushSubscriptions.endpoint, "https://push.example/abc"));
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ p256dh: "p2", auth: "a2" });
    });

    it("re-subscribing a previously revoked endpoint clears revokedAt", async () => {
      const user = await signupUser(ctx);
      await ctx.request.post("/api/push-subscriptions").set(csrf).set("cookie", user.cookie)
        .send({ endpoint: "https://push.example/abc", keys: { p256dh: "p1", auth: "a1" } });
      await ctx.request.post("/api/push-subscriptions/unsubscribe").set(csrf).set("cookie", user.cookie)
        .send({ endpoint: "https://push.example/abc" });

      await ctx.request.post("/api/push-subscriptions").set(csrf).set("cookie", user.cookie)
        .send({ endpoint: "https://push.example/abc", keys: { p256dh: "p1", auth: "a1" } });

      const [row] = await ctx.db.select().from(pushSubscriptions).where(eq(pushSubscriptions.endpoint, "https://push.example/abc"));
      expect(row!.revokedAt).toBeNull();
    });

    it("401s when not signed in", async () => {
      const res = await ctx.request.post("/api/push-subscriptions").set(csrf)
        .send({ endpoint: "https://push.example/abc", keys: { p256dh: "p1", auth: "a1" } });
      expect(res.status).toBe(401);
    });
  });

  describe("POST /push-subscriptions/unsubscribe", () => {
    it("sets revokedAt on the caller's own subscription", async () => {
      const user = await signupUser(ctx);
      await ctx.request.post("/api/push-subscriptions").set(csrf).set("cookie", user.cookie)
        .send({ endpoint: "https://push.example/abc", keys: { p256dh: "p1", auth: "a1" } });

      const res = await ctx.request.post("/api/push-subscriptions/unsubscribe").set(csrf).set("cookie", user.cookie).send({ endpoint: "https://push.example/abc" });
      expect(res.status).toBe(200);

      const [row] = await ctx.db.select().from(pushSubscriptions).where(eq(pushSubscriptions.endpoint, "https://push.example/abc"));
      expect(row!.revokedAt).not.toBeNull();
    });

    it("is idempotent — unsubscribing twice is not an error", async () => {
      const user = await signupUser(ctx);
      await ctx.request.post("/api/push-subscriptions").set(csrf).set("cookie", user.cookie)
        .send({ endpoint: "https://push.example/abc", keys: { p256dh: "p1", auth: "a1" } });
      await ctx.request.post("/api/push-subscriptions/unsubscribe").set(csrf).set("cookie", user.cookie).send({ endpoint: "https://push.example/abc" });
      const res = await ctx.request.post("/api/push-subscriptions/unsubscribe").set(csrf).set("cookie", user.cookie).send({ endpoint: "https://push.example/abc" });
      expect(res.status).toBe(200);
    });

    it("never revokes another user's subscription", async () => {
      const owner = await signupUser(ctx);
      const other = await signupUser(ctx);
      await ctx.request.post("/api/push-subscriptions").set(csrf).set("cookie", owner.cookie)
        .send({ endpoint: "https://push.example/abc", keys: { p256dh: "p1", auth: "a1" } });

      await ctx.request.post("/api/push-subscriptions/unsubscribe").set(csrf).set("cookie", other.cookie).send({ endpoint: "https://push.example/abc" });

      const [row] = await ctx.db.select().from(pushSubscriptions).where(eq(pushSubscriptions.endpoint, "https://push.example/abc"));
      expect(row!.revokedAt).toBeNull();
    });
  });
});
```

- [ ] **Step 7: Run the test to verify it fails**

Run: `cd apps/api && npm run test -- push-subscription`
Expected: FAIL — 404s (route doesn't exist yet).

- [ ] **Step 8: Implement the subscription service**

Create `apps/api/src/services/push/push-subscription.service.ts`:

```ts
import { and, eq } from "drizzle-orm";
import type { PushSubscribeInput } from "@household/shared";
import { pushSubscriptions } from "../../db/schema.js";
import type { Deps } from "../deps.js";

export async function subscribe(deps: Deps, userId: string, input: PushSubscribeInput): Promise<void> {
  const now = deps.clock.now();
  await deps.db.insert(pushSubscriptions)
    .values({
      userId, endpoint: input.endpoint, p256dh: input.keys.p256dh, auth: input.keys.auth,
      userAgent: input.userAgent ?? null, lastUsedAt: now, revokedAt: null,
    })
    .onConflictDoUpdate({
      target: pushSubscriptions.endpoint,
      set: { userId, p256dh: input.keys.p256dh, auth: input.keys.auth, userAgent: input.userAgent ?? null, lastUsedAt: now, revokedAt: null, updatedAt: now },
    });
}

export async function unsubscribe(deps: Deps, userId: string, endpoint: string): Promise<void> {
  await deps.db.update(pushSubscriptions)
    .set({ revokedAt: deps.clock.now() })
    .where(and(eq(pushSubscriptions.endpoint, endpoint), eq(pushSubscriptions.userId, userId)));
}
```

- [ ] **Step 9: Implement the routes**

Create `apps/api/src/routes/push-subscription.routes.ts`:

```ts
import { Router } from "express";
import { pushSubscribeSchema, pushUnsubscribeSchema } from "@household/shared";
import { requireAuth } from "../middleware/auth.js";
import { parseBody } from "../middleware/validate.js";
import { ok } from "../lib/respond.js";
import * as pushSubscriptionService from "../services/push/push-subscription.service.js";
import type { Deps } from "../services/deps.js";

/** User-scoped, not household-scoped — a device subscription belongs to a user account, not a
 *  specific household: the same browser subscribes once and receives push for every household the
 *  signed-in user belongs to. */
export function pushSubscriptionRoutes(deps: Deps): Router {
  const r = Router();
  r.use(requireAuth);

  r.post("/", async (req, res) => {
    const input = parseBody(req, pushSubscribeSchema);
    await pushSubscriptionService.subscribe(deps, req.auth!.user.id, { ...input, userAgent: input.userAgent ?? req.get("user-agent") });
    ok(res, null, 201);
  });

  r.post("/unsubscribe", async (req, res) => {
    const { endpoint } = parseBody(req, pushUnsubscribeSchema);
    await pushSubscriptionService.unsubscribe(deps, req.auth!.user.id, endpoint);
    ok(res, null);
  });

  return r;
}
```

- [ ] **Step 10: Mount the routes**

In `apps/api/src/app.ts`, add the import:

```ts
import { pushSubscriptionRoutes } from "./routes/push-subscription.routes.js";
```

And add, after `app.use("/api/invites", inviteRoutes(deps));`:

```ts
  app.use("/api/push-subscriptions", pushSubscriptionRoutes(deps));
```

- [ ] **Step 11: Run the test to verify it passes**

Run: `cd apps/api && npm run test -- push-subscription`
Expected: PASS, all 7 tests green.

- [ ] **Step 12: Commit**

```bash
git add apps/api/src/services/deps.ts apps/api/src/worker.ts apps/api/src/server.ts apps/api/tests/helpers.ts apps/api/src/services/push/push-subscription.service.ts apps/api/src/routes/push-subscription.routes.ts apps/api/tests/push-subscription.test.ts apps/api/src/app.ts
git commit -m "feat(api): wire push provider into Deps, add subscribe/unsubscribe routes"
```

---

### Task 4: Extract resolveLinkPath + extend notification preferences with pushEnabled

**Files:**
- Create: `apps/api/src/services/notification-link.ts`
- Modify: `apps/api/src/services/notification.service.ts`
- Modify: `apps/api/src/services/notification-preference.service.ts`
- Modify: `apps/api/tests/notification-preference.test.ts`

**Interfaces:**
- Consumes: `NotificationPreferenceDTO.pushEnabled`, `UpdateNotificationPreferenceInput.pushEnabled` (Task 1).
- Produces: `resolveLinkPath(deps, row: { entityType: string | null; entityId: string | null }): Promise<string | null>` (`notification-link.ts`), consumed by Task 5's dispatch job.

- [ ] **Step 1: Extract `resolveLinkPath` into its own file**

Create `apps/api/src/services/notification-link.ts`:

```ts
import { eq } from "drizzle-orm";
import { billOccurrences } from "../db/schema.js";
import type { Deps } from "./deps.js";

/**
 * BILL notifications store the bill OCCURRENCE id as entityId (set by evaluate-reminders.job.ts),
 * but the only bill detail route is /bills/:billId. Resolved here, at read time, rather than
 * touching the job's write-time shape or adding a migration — a SALARY row's entityId already IS
 * the settlement id the /salary/:id route expects, so it passes through unchanged.
 */
export async function resolveLinkPath(deps: Deps, row: { entityType: string | null; entityId: string | null }): Promise<string | null> {
  if (row.entityType === "bill_occurrence" && row.entityId) {
    const [occ] = await deps.db.select({ billId: billOccurrences.billId }).from(billOccurrences).where(eq(billOccurrences.id, row.entityId));
    return occ ? `/bills/${occ.billId}` : null;
  }
  if (row.entityType === "salary_settlement" && row.entityId) {
    return `/salary/${row.entityId}`;
  }
  return null;
}
```

- [ ] **Step 2: Update `notification.service.ts` to use the extracted function**

In `apps/api/src/services/notification.service.ts`, remove the local `resolveLinkPath` function (lines 16-25) and its now-unused `billOccurrences` import, and add:

```ts
import { resolveLinkPath } from "./notification-link.js";
```

The top of the file should now read:

```ts
import { and, count, desc, eq, isNull } from "drizzle-orm";
import type { NotificationActionInput, NotificationDTO } from "@household/shared";
import { notifications } from "../db/schema.js";
import { Errors } from "../lib/errors.js";
import { resolveLinkPath } from "./notification-link.js";
import type { Deps } from "./deps.js";
import type { Membership } from "./household.service.js";

type NotificationRow = typeof notifications.$inferSelect;

async function toNotificationDTO(deps: Deps, row: NotificationRow): Promise<NotificationDTO> {
  return {
    id: row.id, category: row.category, severity: row.severity,
    title: row.title, body: row.body, linkPath: await resolveLinkPath(deps, row),
    readAt: row.readAt?.toISOString() ?? null, dismissedAt: row.dismissedAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
  };
}
```

(The rest of the file — `listNotifications`, `getUnreadCount`, `markNotification`, `markAllRead` — is unchanged.)

- [ ] **Step 3: Run the existing notification tests to confirm the refactor didn't break linkPath resolution**

Run: `cd apps/api && npm run test -- notification.test`
Expected: PASS, including the three existing linkPath-resolution tests (`notification.test.ts:42-69`) — they're the regression net for this extraction.

- [ ] **Step 4: Update the failing (pre-change) preference tests**

In `apps/api/tests/notification-preference.test.ts`, every `toEqual` assertion that currently includes `emailEnabled` must gain `pushEnabled: true` (the default, since `DEFAULT_CHANNELS` includes `WEB_PUSH`), unless the test explicitly set `channels` to exclude it. Apply these exact replacements:

Line 32-34, replace:
```ts
      expect(res.body.data).toEqual([
        { category: "BILL", enabled: true, emailEnabled: false },
        { category: "SALARY", enabled: true, emailEnabled: false },
      ]);
```
with:
```ts
      expect(res.body.data).toEqual([
        { category: "BILL", enabled: true, emailEnabled: false, pushEnabled: true },
        { category: "SALARY", enabled: true, emailEnabled: false, pushEnabled: true },
      ]);
```

Line 46, replace `expect(bill).toEqual({ category: "BILL", enabled: false, emailEnabled: true });` with `expect(bill).toEqual({ category: "BILL", enabled: false, emailEnabled: true, pushEnabled: true });` (the test's own `channels` override is `["IN_APP", "WEB_PUSH", "EMAIL"]`, so `pushEnabled` is `true`).

Line 60, replace `expect(salary).toEqual({ category: "SALARY", enabled: true, emailEnabled: false }); // default, not owner's disabled row` with `expect(salary).toEqual({ category: "SALARY", enabled: true, emailEnabled: false, pushEnabled: true }); // default, not owner's disabled row`.

Line 81, replace `expect(res.body.data).toEqual({ category: "BILL", enabled: true, emailEnabled: true });` with `expect(res.body.data).toEqual({ category: "BILL", enabled: true, emailEnabled: true, pushEnabled: true });`.

Line 95, replace `expect(first.body.data).toEqual({ category: "SALARY", enabled: true, emailEnabled: true });` with `expect(first.body.data).toEqual({ category: "SALARY", enabled: true, emailEnabled: true, pushEnabled: true });`.

Line 98, replace `expect(second.body.data).toEqual({ category: "SALARY", enabled: false, emailEnabled: true }); // emailEnabled untouched` with `expect(second.body.data).toEqual({ category: "SALARY", enabled: false, emailEnabled: true, pushEnabled: true }); // emailEnabled untouched`.

Line 107, replace `expect(off.body.data).toEqual({ category: "BILL", enabled: true, emailEnabled: false });` with `expect(off.body.data).toEqual({ category: "BILL", enabled: true, emailEnabled: false, pushEnabled: true });`.

- [ ] **Step 5: Add new pushEnabled test cases**

Append to the `describe("PATCH /notification-preferences/:category", ...)` block, right before its closing `});`:

```ts
    it("round-trips pushEnabled true then false without disturbing IN_APP/EMAIL", async () => {
      const owner = await signupUser(ctx);
      const h = await createHousehold(ctx, owner.cookie);

      await ctx.request.patch(`/api/households/${h.id}/notification-preferences/BILL`).set(csrf).set("cookie", owner.cookie).send({ pushEnabled: false });
      const row1 = await ctx.db.select().from(notificationPreferences)
        .where(and(eq(notificationPreferences.householdId, h.id), eq(notificationPreferences.userId, owner.id), eq(notificationPreferences.category, "BILL")));
      expect(row1[0]!.channels).toEqual(expect.arrayContaining(["IN_APP"]));
      expect(row1[0]!.channels).not.toContain("WEB_PUSH");

      const on = await ctx.request.patch(`/api/households/${h.id}/notification-preferences/BILL`).set(csrf).set("cookie", owner.cookie).send({ pushEnabled: true });
      expect(on.body.data).toEqual({ category: "BILL", enabled: true, emailEnabled: false, pushEnabled: true });
    });

    it("a single PATCH can set both emailEnabled and pushEnabled", async () => {
      const owner = await signupUser(ctx);
      const h = await createHousehold(ctx, owner.cookie);

      const res = await ctx.request.patch(`/api/households/${h.id}/notification-preferences/SALARY`).set(csrf).set("cookie", owner.cookie)
        .send({ emailEnabled: true, pushEnabled: false });

      expect(res.body.data).toEqual({ category: "SALARY", enabled: true, emailEnabled: true, pushEnabled: false });
    });
```

- [ ] **Step 6: Implement the `pushEnabled` extension**

Replace `apps/api/src/services/notification-preference.service.ts` with:

```ts
import { and, eq } from "drizzle-orm";
import type { NotificationPreferenceDTO, SettableNotificationCategory, UpdateNotificationPreferenceInput } from "@household/shared";
import { notificationPreferences } from "../db/schema.js";
import { Errors } from "../lib/errors.js";
import type { Deps } from "./deps.js";
import type { Membership } from "./household.service.js";

type PrefRow = typeof notificationPreferences.$inferSelect;
type ChannelValue = "IN_APP" | "WEB_PUSH" | "EMAIL" | "SMS" | "WHATSAPP";

const DEFAULT_CHANNELS: ChannelValue[] = ["IN_APP", "WEB_PUSH"];
const SETTABLE_CATEGORIES: SettableNotificationCategory[] = ["BILL", "SALARY"];

function toDTO(category: SettableNotificationCategory, row: PrefRow | undefined): NotificationPreferenceDTO {
  const enabled = row?.enabled ?? true;
  const channels = row?.channels ?? DEFAULT_CHANNELS;
  return { category, enabled, emailEnabled: channels.includes("EMAIL"), pushEnabled: channels.includes("WEB_PUSH") };
}

export async function listNotificationPreferences(deps: Deps, userId: string, membership: Membership): Promise<NotificationPreferenceDTO[]> {
  const rows = await deps.db.select().from(notificationPreferences)
    .where(and(eq(notificationPreferences.householdId, membership.householdId), eq(notificationPreferences.userId, userId)));
  const byCategory = new Map(rows.map((r) => [r.category, r]));
  return SETTABLE_CATEGORIES.map((category) => toDTO(category, byCategory.get(category)));
}

export async function updateNotificationPreference(
  deps: Deps, userId: string, membership: Membership, category: string, input: UpdateNotificationPreferenceInput,
): Promise<NotificationPreferenceDTO> {
  if (!SETTABLE_CATEGORIES.includes(category as SettableNotificationCategory)) throw Errors.validation({ category: "Unsupported category." });
  const cat = category as SettableNotificationCategory;

  const result = await deps.db.transaction(async (tx) => {
    const [existing] = await tx.select().from(notificationPreferences)
      .where(and(eq(notificationPreferences.householdId, membership.householdId), eq(notificationPreferences.userId, userId), eq(notificationPreferences.category, cat)))
      .for("update");

    const enabled = input.enabled ?? existing?.enabled ?? true;
    const currentChannels = existing?.channels ?? DEFAULT_CHANNELS;
    const afterEmail: ChannelValue[] = input.emailEnabled === undefined
      ? currentChannels
      : input.emailEnabled
        ? currentChannels.includes("EMAIL") ? currentChannels : [...currentChannels, "EMAIL"]
        : currentChannels.filter((c) => c !== "EMAIL");
    const channels: ChannelValue[] = input.pushEnabled === undefined
      ? afterEmail
      : input.pushEnabled
        ? afterEmail.includes("WEB_PUSH") ? afterEmail : [...afterEmail, "WEB_PUSH"]
        : afterEmail.filter((c) => c !== "WEB_PUSH");

    if (existing) {
      await tx.update(notificationPreferences).set({ enabled, channels }).where(eq(notificationPreferences.id, existing.id));
    } else {
      await tx.insert(notificationPreferences).values({ householdId: membership.householdId, userId, category: cat, enabled, channels });
    }
    return { enabled, channels };
  });

  return { category: cat, enabled: result.enabled, emailEnabled: result.channels.includes("EMAIL"), pushEnabled: result.channels.includes("WEB_PUSH") };
}
```

- [ ] **Step 7: Run the preference tests to verify everything passes**

Run: `cd apps/api && npm run test -- notification-preference`
Expected: PASS, all tests (updated + new) green.

- [ ] **Step 8: Commit**

```bash
git add apps/api/src/services/notification-link.ts apps/api/src/services/notification.service.ts apps/api/src/services/notification-preference.service.ts apps/api/tests/notification-preference.test.ts
git commit -m "feat(api): extract resolveLinkPath, add pushEnabled to notification preferences"
```

---

### Task 5: Dispatch-web-push-deliveries job

**Files:**
- Create: `apps/api/src/jobs/dispatch-web-push-deliveries.job.ts`
- Create: `apps/api/tests/dispatch-web-push-deliveries.test.ts`

**Interfaces:**
- Consumes: `Deps.push` (Task 3), `resolveLinkPath` (Task 4), `PushSendError` (Task 2), `TestContext.push: MemoryPushProvider` (Task 3).
- Produces: `runDispatchWebPushDeliveries(deps: Deps): Promise<void>`, `dispatchSingleWebPushDelivery(deps: Deps, deliveryId: string): Promise<void>` — the second is consumed by Task 6's test-notification endpoint.

- [ ] **Step 1: Write the failing tests**

Create `apps/api/tests/dispatch-web-push-deliveries.test.ts`:

```ts
import { eq } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { notificationDeliveries, notifications, pushSubscriptions } from "../src/db/schema.js";
import { dispatchSingleWebPushDelivery, runDispatchWebPushDeliveries } from "../src/jobs/dispatch-web-push-deliveries.job.js";
import { createTestContext, csrf, signupUser, truncateAll, type TestContext } from "./helpers.js";

const ctx = createTestContext();

beforeEach(async () => { await truncateAll(ctx.db); });
afterAll(() => ctx.close());

async function createHousehold(c: TestContext, cookie: string) {
  const res = await c.request.post("/api/households").set(csrf).set("cookie", cookie).send({ name: "Shah Family" });
  expect(res.status).toBe(201);
  return res.body.data as { id: string };
}

let seq = 0;
async function insertDelivery(householdId: string, userId: string, overrides: Record<string, unknown> = {}) {
  seq += 1;
  const [notification] = await ctx.db.insert(notifications).values({
    householdId, userId, category: "BILL", title: `Electricity due in 7 day(s) #${seq}`,
    idempotencyKey: `test-push-key-${seq}`,
  }).returning();
  const [delivery] = await ctx.db.insert(notificationDeliveries).values({
    householdId, notificationId: notification!.id, channel: "WEB_PUSH", status: "PENDING", ...overrides,
  }).returning();
  return { notification: notification!, delivery: delivery! };
}

async function addSubscription(userId: string, endpoint: string) {
  await ctx.db.insert(pushSubscriptions).values({ userId, endpoint, p256dh: "p", auth: "a" });
}

describe("runDispatchWebPushDeliveries", () => {
  it("sends to a single active subscription and marks the delivery SENT", async () => {
    const owner = await signupUser(ctx);
    const h = await createHousehold(ctx, owner.cookie);
    await addSubscription(owner.id, "https://push.example/a");
    const { delivery } = await insertDelivery(h.id, owner.id);

    await runDispatchWebPushDeliveries(ctx.deps);

    const [updated] = await ctx.db.select().from(notificationDeliveries).where(eq(notificationDeliveries.id, delivery.id));
    expect(updated!.status).toBe("SENT");
    expect(updated!.sentAt).not.toBeNull();
    expect(ctx.push.sent).toHaveLength(1);
    const [sub] = await ctx.db.select().from(pushSubscriptions).where(eq(pushSubscriptions.endpoint, "https://push.example/a"));
    expect(sub!.lastUsedAt).not.toBeNull();
  });

  it("skips a delivery for a user with no active subscriptions", async () => {
    const owner = await signupUser(ctx);
    const h = await createHousehold(ctx, owner.cookie);
    const { delivery } = await insertDelivery(h.id, owner.id);

    await runDispatchWebPushDeliveries(ctx.deps);

    const [updated] = await ctx.db.select().from(notificationDeliveries).where(eq(notificationDeliveries.id, delivery.id));
    expect(updated!.status).toBe("SKIPPED");
    expect(ctx.push.sent).toHaveLength(0);
  });

  it("revokes an expired subscription but still marks the delivery SENT via the other device", async () => {
    const owner = await signupUser(ctx);
    const h = await createHousehold(ctx, owner.cookie);
    await addSubscription(owner.id, "https://push.example/dead");
    await addSubscription(owner.id, "https://push.example/alive");
    ctx.push.failNext("https://push.example/dead", "expired");
    const { delivery } = await insertDelivery(h.id, owner.id);

    await runDispatchWebPushDeliveries(ctx.deps);

    const [updated] = await ctx.db.select().from(notificationDeliveries).where(eq(notificationDeliveries.id, delivery.id));
    expect(updated!.status).toBe("SENT");
    const [dead] = await ctx.db.select().from(pushSubscriptions).where(eq(pushSubscriptions.endpoint, "https://push.example/dead"));
    expect(dead!.revokedAt).not.toBeNull();
    const [alive] = await ctx.db.select().from(pushSubscriptions).where(eq(pushSubscriptions.endpoint, "https://push.example/alive"));
    expect(alive!.revokedAt).toBeNull();
  });

  it("marks the delivery SKIPPED (not FAILED) when the only subscription turns out expired", async () => {
    const owner = await signupUser(ctx);
    const h = await createHousehold(ctx, owner.cookie);
    await addSubscription(owner.id, "https://push.example/only");
    ctx.push.failNext("https://push.example/only", "expired");
    const { delivery } = await insertDelivery(h.id, owner.id);

    await runDispatchWebPushDeliveries(ctx.deps);

    const [updated] = await ctx.db.select().from(notificationDeliveries).where(eq(notificationDeliveries.id, delivery.id));
    expect(updated!.status).toBe("SKIPPED");
    const [sub] = await ctx.db.select().from(pushSubscriptions).where(eq(pushSubscriptions.endpoint, "https://push.example/only"));
    expect(sub!.revokedAt).not.toBeNull();
  });

  it("increments attempts and records lastError on a generic failure, staying PENDING under 3 attempts", async () => {
    const owner = await signupUser(ctx);
    const h = await createHousehold(ctx, owner.cookie);
    await addSubscription(owner.id, "https://push.example/a");
    ctx.push.failNext("https://push.example/a", "error");
    const { delivery } = await insertDelivery(h.id, owner.id);

    await runDispatchWebPushDeliveries(ctx.deps);

    const [updated] = await ctx.db.select().from(notificationDeliveries).where(eq(notificationDeliveries.id, delivery.id));
    expect(updated!.status).toBe("PENDING");
    expect(updated!.attempts).toBe(1);
    expect(updated!.lastError).toContain("push send failed");
  });

  it("marks FAILED on the 3rd consecutive failure", async () => {
    const owner = await signupUser(ctx);
    const h = await createHousehold(ctx, owner.cookie);
    await addSubscription(owner.id, "https://push.example/a");
    ctx.push.failNext("https://push.example/a", "error");
    const { delivery } = await insertDelivery(h.id, owner.id, { attempts: 2 });

    await runDispatchWebPushDeliveries(ctx.deps);

    const [updated] = await ctx.db.select().from(notificationDeliveries).where(eq(notificationDeliveries.id, delivery.id));
    expect(updated!.status).toBe("FAILED");
    expect(updated!.attempts).toBe(3);
  });

  it("resolves a SALARY notification's linkPath directly from entityId", async () => {
    const owner = await signupUser(ctx);
    const h = await createHousehold(ctx, owner.cookie);
    await addSubscription(owner.id, "https://push.example/a");
    const [notification] = await ctx.db.insert(notifications).values({
      householdId: h.id, userId: owner.id, category: "SALARY", title: "Salary due",
      entityType: "salary_settlement", entityId: "11111111-1111-1111-1111-111111111111",
      idempotencyKey: "test-push-salary-1",
    }).returning();
    await ctx.db.insert(notificationDeliveries).values({
      householdId: h.id, notificationId: notification!.id, channel: "WEB_PUSH", status: "PENDING",
    });

    await runDispatchWebPushDeliveries(ctx.deps);

    expect(ctx.push.sent[0]!.payload.linkPath).toBe("/salary/11111111-1111-1111-1111-111111111111");
  });

  it("never touches non-WEB_PUSH or non-PENDING rows", async () => {
    const owner = await signupUser(ctx);
    const h = await createHousehold(ctx, owner.cookie);
    await addSubscription(owner.id, "https://push.example/a");
    const { delivery: alreadySent } = await insertDelivery(h.id, owner.id, { status: "SENT", sentAt: ctx.clock.now() });
    const { delivery: email } = await insertDelivery(h.id, owner.id, { channel: "EMAIL", status: "PENDING" });

    await runDispatchWebPushDeliveries(ctx.deps);

    expect(ctx.push.sent).toHaveLength(0);
    const [sentRow] = await ctx.db.select().from(notificationDeliveries).where(eq(notificationDeliveries.id, alreadySent.id));
    const [emailRow] = await ctx.db.select().from(notificationDeliveries).where(eq(notificationDeliveries.id, email.id));
    expect(sentRow!.status).toBe("SENT");
    expect(emailRow!.status).toBe("PENDING");
  });

  it("caps how many rows it processes in a single run", async () => {
    const owner = await signupUser(ctx);
    const h = await createHousehold(ctx, owner.cookie);
    await addSubscription(owner.id, "https://push.example/a");
    for (let i = 0; i < 101; i++) await insertDelivery(h.id, owner.id);

    await runDispatchWebPushDeliveries(ctx.deps);

    const rows = await ctx.db.select().from(notificationDeliveries).where(eq(notificationDeliveries.householdId, h.id));
    const stillPending = rows.filter((r) => r.status === "PENDING").length;
    expect(stillPending).toBeGreaterThan(0);
  });
});

describe("dispatchSingleWebPushDelivery", () => {
  it("dispatches exactly the given delivery id", async () => {
    const owner = await signupUser(ctx);
    const h = await createHousehold(ctx, owner.cookie);
    await addSubscription(owner.id, "https://push.example/a");
    const { delivery } = await insertDelivery(h.id, owner.id);

    await dispatchSingleWebPushDelivery(ctx.deps, delivery.id);

    const [updated] = await ctx.db.select().from(notificationDeliveries).where(eq(notificationDeliveries.id, delivery.id));
    expect(updated!.status).toBe("SENT");
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd apps/api && npm run test -- dispatch-web-push-deliveries`
Expected: FAIL — cannot find module `../src/jobs/dispatch-web-push-deliveries.job.js`.

- [ ] **Step 3: Implement the job**

Create `apps/api/src/jobs/dispatch-web-push-deliveries.job.ts`:

```ts
import { and, asc, eq, isNull } from "drizzle-orm";
import { notificationDeliveries, notifications, pushSubscriptions } from "../db/schema.js";
import { resolveLinkPath } from "../services/notification-link.js";
import { PushSendError } from "../services/push/push.provider.js";
import type { Deps } from "../services/deps.js";

const MAX_ATTEMPTS = 3;
const BATCH_LIMIT = 100;

type DeliveryRow = {
  deliveryId: string; attempts: number; notificationTitle: string; notificationBody: string | null;
  userId: string; entityType: string | null; entityId: string | null;
};

const SELECT_COLUMNS = {
  deliveryId: notificationDeliveries.id,
  attempts: notificationDeliveries.attempts,
  notificationTitle: notifications.title,
  notificationBody: notifications.body,
  userId: notifications.userId,
  entityType: notifications.entityType,
  entityId: notifications.entityId,
};

/**
 * Fans one WEB_PUSH delivery row out to every active (non-revoked) subscription for that
 * notification's user — notification_deliveries has one WEB_PUSH row per notification (unique on
 * notificationId+channel), not per device, so multi-device delivery happens here rather than at
 * the row level. A subscription the push service reports as gone (404/410, surfaced as
 * PushSendError) is revoked rather than retried — that's device churn, not a send failure. Known
 * simplification: push_subscriptions has no per-subscription attempts column, so a hard failure on
 * one specific device among several only shows up in the delivery's lastError (last failure wins)
 * and isn't retried per-device — acceptable for a personal-household app.
 */
async function processDelivery(deps: Deps, row: DeliveryRow): Promise<void> {
  const subs = await deps.db.select().from(pushSubscriptions)
    .where(and(eq(pushSubscriptions.userId, row.userId), isNull(pushSubscriptions.revokedAt)));

  if (subs.length === 0) {
    await deps.db.update(notificationDeliveries).set({ status: "SKIPPED" }).where(eq(notificationDeliveries.id, row.deliveryId));
    return;
  }

  const linkPath = await resolveLinkPath(deps, { entityType: row.entityType, entityId: row.entityId });
  const payload = { title: row.notificationTitle, body: row.notificationBody ?? row.notificationTitle, tag: "reminder-notification", linkPath };

  let successCount = 0;
  let hardFailure: string | null = null;
  for (const sub of subs) {
    try {
      await deps.push.send({ endpoint: sub.endpoint, p256dh: sub.p256dh, auth: sub.auth }, payload);
      successCount += 1;
      await deps.db.update(pushSubscriptions).set({ lastUsedAt: deps.clock.now() }).where(eq(pushSubscriptions.id, sub.id));
    } catch (err) {
      if (err instanceof PushSendError) {
        await deps.db.update(pushSubscriptions).set({ revokedAt: deps.clock.now() }).where(eq(pushSubscriptions.id, sub.id));
      } else {
        hardFailure = String(err);
      }
    }
  }

  if (successCount > 0) {
    await deps.db.update(notificationDeliveries).set({ status: "SENT", sentAt: deps.clock.now() }).where(eq(notificationDeliveries.id, row.deliveryId));
  } else if (!hardFailure) {
    await deps.db.update(notificationDeliveries).set({ status: "SKIPPED" }).where(eq(notificationDeliveries.id, row.deliveryId));
  } else {
    const attempts = row.attempts + 1;
    await deps.db.update(notificationDeliveries)
      .set({ attempts, lastError: hardFailure, status: attempts >= MAX_ATTEMPTS ? "FAILED" : "PENDING" })
      .where(eq(notificationDeliveries.id, row.deliveryId));
  }
}

/** Every 5 minutes: finds PENDING WEB_PUSH deliveries (written by evaluate-reminders.job.ts, never
 *  consumed until this job) and dispatches each. Per-row try/catch, same per-item-isolation
 *  approach as dispatch-email-deliveries.job.ts. */
export async function runDispatchWebPushDeliveries(deps: Deps): Promise<void> {
  const rows = await deps.db.select(SELECT_COLUMNS).from(notificationDeliveries)
    .innerJoin(notifications, eq(notifications.id, notificationDeliveries.notificationId))
    .where(and(eq(notificationDeliveries.channel, "WEB_PUSH"), eq(notificationDeliveries.status, "PENDING")))
    .orderBy(asc(notificationDeliveries.createdAt))
    .limit(BATCH_LIMIT);

  for (const row of rows) {
    try {
      await processDelivery(deps, row);
    } catch (err) {
      const attempts = row.attempts + 1;
      await deps.db.update(notificationDeliveries)
        .set({ attempts, lastError: String(err), status: attempts >= MAX_ATTEMPTS ? "FAILED" : "PENDING" })
        .where(eq(notificationDeliveries.id, row.deliveryId));
    }
  }
}

/** Used by the "send test notification" endpoint for instant feedback instead of waiting up to 5
 *  minutes for the next scheduled tick — same per-row logic as the batch job, for one delivery id. */
export async function dispatchSingleWebPushDelivery(deps: Deps, deliveryId: string): Promise<void> {
  const [row] = await deps.db.select(SELECT_COLUMNS).from(notificationDeliveries)
    .innerJoin(notifications, eq(notifications.id, notificationDeliveries.notificationId))
    .where(eq(notificationDeliveries.id, deliveryId));
  if (row) await processDelivery(deps, row);
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd apps/api && npm run test -- dispatch-web-push-deliveries`
Expected: PASS, all 10 tests green.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/jobs/dispatch-web-push-deliveries.job.ts apps/api/tests/dispatch-web-push-deliveries.test.ts
git commit -m "feat(api): add dispatch-web-push-deliveries job"
```

---

### Task 6: Test-notification endpoint + job registration

**Files:**
- Create: `apps/api/src/services/push/push-test.service.ts`
- Create: `apps/api/tests/push-test-notification.test.ts`
- Modify: `apps/api/src/routes/household.routes.ts`
- Modify: `apps/api/src/routes/internal.routes.ts`
- Modify: `apps/api/src/worker.ts`

**Interfaces:**
- Consumes: `dispatchSingleWebPushDelivery` (Task 5).
- Produces: `sendTestPushNotification(deps, userId, membership): Promise<{ delivered: boolean; reason?: "no-active-devices" | "send-failed" }>`, consumed by `apps/web`'s Task 8.

- [ ] **Step 1: Write the failing tests**

Create `apps/api/tests/push-test-notification.test.ts`:

```ts
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { pushSubscriptions } from "../src/db/schema.js";
import { createTestContext, csrf, signupUser, truncateAll } from "./helpers.js";

const ctx = createTestContext();

beforeEach(async () => { await truncateAll(ctx.db); });
afterAll(() => ctx.close());

async function createHousehold(cookie: string) {
  const res = await ctx.request.post("/api/households").set(csrf).set("cookie", cookie).send({ name: "Shah Family" });
  expect(res.status).toBe(201);
  return res.body.data as { id: string };
}

describe("POST /:householdId/notifications/test-push", () => {
  it("sends a real test push when the user has an active subscription", async () => {
    const owner = await signupUser(ctx);
    const h = await createHousehold(owner.cookie);
    await ctx.db.insert(pushSubscriptions).values({ userId: owner.id, endpoint: "https://push.example/abc", p256dh: "p", auth: "a" });

    const res = await ctx.request.post(`/api/households/${h.id}/notifications/test-push`).set(csrf).set("cookie", owner.cookie);

    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({ delivered: true });
    expect(ctx.push.sent).toHaveLength(1);
    expect(ctx.push.sent[0]!.payload.title).toBe("Test notification");
  });

  it("reports no-active-devices when the user has no subscription", async () => {
    const owner = await signupUser(ctx);
    const h = await createHousehold(owner.cookie);

    const res = await ctx.request.post(`/api/households/${h.id}/notifications/test-push`).set(csrf).set("cookie", owner.cookie);

    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({ delivered: false, reason: "no-active-devices" });
  });

  it("404s for a non-member", async () => {
    const owner = await signupUser(ctx);
    const h = await createHousehold(owner.cookie);
    const stranger = await signupUser(ctx);
    const res = await ctx.request.post(`/api/households/${h.id}/notifications/test-push`).set(csrf).set("cookie", stranger.cookie);
    expect(res.status).toBe(404);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd apps/api && npm run test -- push-test-notification`
Expected: FAIL — 404 (route doesn't exist).

- [ ] **Step 3: Implement the test-push service**

Create `apps/api/src/services/push/push-test.service.ts`:

```ts
import { eq } from "drizzle-orm";
import { notificationDeliveries, notifications } from "../../db/schema.js";
import { dispatchSingleWebPushDelivery } from "../../jobs/dispatch-web-push-deliveries.job.js";
import type { Deps } from "../deps.js";
import type { Membership } from "../household.service.js";

export type TestPushResult = { delivered: boolean; reason?: "no-active-devices" | "send-failed" };

/** An explicit user action, not a reminder — bypasses notification_preferences entirely, the same
 *  way "mark all read" isn't preference-gated either. */
export async function sendTestPushNotification(deps: Deps, userId: string, membership: Membership): Promise<TestPushResult> {
  const [notification] = await deps.db.insert(notifications).values({
    householdId: membership.householdId, userId, category: "SYSTEM",
    title: "Test notification", body: "If you can see this, push notifications are working on this device.",
    idempotencyKey: `test-push:${userId}:${deps.clock.now().getTime()}`,
  }).returning();

  const [delivery] = await deps.db.insert(notificationDeliveries).values({
    householdId: membership.householdId, notificationId: notification!.id, channel: "WEB_PUSH", status: "PENDING",
  }).returning();

  await dispatchSingleWebPushDelivery(deps, delivery!.id);

  const [updated] = await deps.db.select().from(notificationDeliveries).where(eq(notificationDeliveries.id, delivery!.id));
  if (updated!.status === "SENT") return { delivered: true };
  if (updated!.status === "SKIPPED") return { delivered: false, reason: "no-active-devices" };
  return { delivered: false, reason: "send-failed" };
}
```

- [ ] **Step 4: Add the route**

In `apps/api/src/routes/household.routes.ts`, add the import near the other `services/*` imports:

```ts
import * as pushTestService from "../services/push/push-test.service.js";
```

Add, right after the existing `r.patch("/:householdId/notification-preferences/:category", ...)` route block:

```ts
  r.post("/:householdId/notifications/test-push", requireHousehold(deps, "household.view"), async (req, res) => {
    ok(res, await pushTestService.sendTestPushNotification(deps, req.auth!.user.id, req.membership!));
  });
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `cd apps/api && npm run test -- push-test-notification`
Expected: PASS, all 3 tests green.

- [ ] **Step 6: Register the dispatch job for both job runners**

In `apps/api/src/routes/internal.routes.ts`, add the import:

```ts
import { runDispatchWebPushDeliveries } from "../jobs/dispatch-web-push-deliveries.job.js";
```

Add to the `JOBS` array:

```ts
const JOBS: NamedJob[] = [
  { name: "heartbeat", run: runHeartbeat },
  { name: "evaluate-reminders", run: runEvaluateReminders },
  { name: "dispatch-email-deliveries", run: runDispatchEmailDeliveries },
  { name: "dispatch-web-push-deliveries", run: runDispatchWebPushDeliveries },
];
```

In `apps/api/src/worker.ts`, add the import:

```ts
import { runDispatchWebPushDeliveries } from "./jobs/dispatch-web-push-deliveries.job.js";
```

Add, right after `deps.queue.registerHandler("dispatch-email-deliveries", () => runDispatchEmailDeliveries(deps));`:

```ts
deps.queue.registerHandler("dispatch-web-push-deliveries", () => runDispatchWebPushDeliveries(deps));
```

Add, right after `await deps.queue.scheduleRepeating("dispatch-email-deliveries", {}, 5 * 60 * 1000);`:

```ts
await deps.queue.scheduleRepeating("dispatch-web-push-deliveries", {}, 5 * 60 * 1000);
```

- [ ] **Step 7: Run the full api suite once to confirm nothing regressed**

Run: `cd apps/api && npm run typecheck && npm run test`
Expected: typecheck clean, all tests pass (this is the last api-side task — a good checkpoint before moving to apps/web).

- [ ] **Step 8: Commit**

```bash
git add apps/api/src/services/push/push-test.service.ts apps/api/tests/push-test-notification.test.ts apps/api/src/routes/household.routes.ts apps/api/src/routes/internal.routes.ts apps/api/src/worker.ts
git commit -m "feat(api): add test-push endpoint, register dispatch-web-push-deliveries job"
```

---

### Task 7: Browser push wrapper (apps/web)

**Files:**
- Create: `apps/web/src/lib/push.ts`
- Create: `apps/web/src/lib/push.test.ts`
- Modify: `apps/web/src/vite-env.d.ts`
- Create: `apps/web/.env.example`

**Interfaces:**
- Produces: `PushSupportState` type, `isPushSupported(): boolean`, `getPushSupportState(): Promise<PushSupportState>`, `PushPermissionDeniedError` class, `subscribeToPush(vapidPublicKey: string): Promise<PushSubscriptionJSON>`, `unsubscribeFromPush(): Promise<string | null>` — all consumed by Task 8.

- [ ] **Step 1: Extend `vite-env.d.ts`**

In `apps/web/src/vite-env.d.ts`, replace:

```ts
/// <reference types="vite/client" />
interface ImportMetaEnv { readonly VITE_API_URL?: string }
interface ImportMeta { readonly env: ImportMetaEnv }
```

with:

```ts
/// <reference types="vite/client" />
interface ImportMetaEnv {
  readonly VITE_API_URL?: string;
  readonly VITE_VAPID_PUBLIC_KEY?: string;
}
interface ImportMeta { readonly env: ImportMetaEnv }
```

- [ ] **Step 2: Create `apps/web/.env.example`**

```
# Base URL of the API, when it's not same-origin with the web app (optional in local dev — Vite's
# dev server proxies /api to http://localhost:4000, see vite.config.ts).
VITE_API_URL=

# Public VAPID key for Web Push — must match the API's VAPID_PUBLIC_KEY (see apps/api/.env.example).
# Not a secret; safe to commit the real value to deployment config. Generate both keys together with:
# npx web-push generate-vapid-keys
VITE_VAPID_PUBLIC_KEY=
```

- [ ] **Step 3: Write the failing tests**

Create `apps/web/src/lib/push.test.ts`:

```ts
import { afterEach, describe, expect, it, vi } from "vitest";
import { getPushSupportState, isPushSupported, PushPermissionDeniedError, subscribeToPush, unsubscribeFromPush } from "./push";

function stubSupport({ permission, subscription }: { permission: NotificationPermission; subscription: unknown }) {
  (window as unknown as { PushManager: unknown }).PushManager = class {};
  (window as unknown as { Notification: unknown }).Notification = {
    permission,
    requestPermission: vi.fn().mockResolvedValue(permission),
  };
  const registration = {
    pushManager: {
      getSubscription: vi.fn().mockResolvedValue(subscription),
      subscribe: vi.fn().mockResolvedValue(
        subscription ?? { endpoint: "https://push.example/abc", toJSON: () => ({ endpoint: "https://push.example/abc", keys: { p256dh: "p", auth: "a" } }) },
      ),
    },
  };
  Object.defineProperty(navigator, "serviceWorker", { value: { ready: Promise.resolve(registration) }, configurable: true });
  return registration;
}

function clearStubs() {
  delete (window as unknown as { PushManager?: unknown }).PushManager;
  delete (window as unknown as { Notification?: unknown }).Notification;
  Reflect.deleteProperty(navigator, "serviceWorker");
}

describe("push support helpers", () => {
  afterEach(() => { clearStubs(); vi.restoreAllMocks(); });

  it("reports unsupported when the browser lacks the push APIs", async () => {
    expect(isPushSupported()).toBe(false);
    expect(await getPushSupportState()).toBe("unsupported");
  });

  it("reports denied when Notification.permission is denied", async () => {
    stubSupport({ permission: "denied", subscription: null });
    expect(await getPushSupportState()).toBe("denied");
  });

  it("reports default when permission hasn't been requested yet", async () => {
    stubSupport({ permission: "default", subscription: null });
    expect(await getPushSupportState()).toBe("default");
  });

  it("reports granted-unsubscribed when permission is granted but no subscription exists", async () => {
    stubSupport({ permission: "granted", subscription: null });
    expect(await getPushSupportState()).toBe("granted-unsubscribed");
  });

  it("reports subscribed when an active subscription exists", async () => {
    stubSupport({ permission: "granted", subscription: { endpoint: "https://push.example/abc" } });
    expect(await getPushSupportState()).toBe("subscribed");
  });

  it("subscribes and returns the subscription JSON when permission is granted", async () => {
    const registration = stubSupport({ permission: "granted", subscription: null });
    const result = await subscribeToPush("B".repeat(87));
    expect(registration.pushManager.subscribe).toHaveBeenCalledWith(expect.objectContaining({ userVisibleOnly: true }));
    expect(result.endpoint).toBe("https://push.example/abc");
  });

  it("throws PushPermissionDeniedError when the user denies the prompt", async () => {
    stubSupport({ permission: "denied", subscription: null });
    (window as unknown as { Notification: { requestPermission: () => Promise<NotificationPermission> } }).Notification.requestPermission = vi.fn().mockResolvedValue("denied");
    await expect(subscribeToPush("B".repeat(87))).rejects.toBeInstanceOf(PushPermissionDeniedError);
  });

  it("unsubscribes the active subscription and returns its endpoint", async () => {
    const existing = { endpoint: "https://push.example/abc", unsubscribe: vi.fn().mockResolvedValue(true) };
    stubSupport({ permission: "granted", subscription: existing });
    const endpoint = await unsubscribeFromPush();
    expect(existing.unsubscribe).toHaveBeenCalled();
    expect(endpoint).toBe("https://push.example/abc");
  });

  it("returns null from unsubscribe when there's no active subscription", async () => {
    stubSupport({ permission: "granted", subscription: null });
    expect(await unsubscribeFromPush()).toBeNull();
  });
});
```

- [ ] **Step 4: Run the test to verify it fails**

Run: `cd apps/web && npm run test -- push.test`
Expected: FAIL — cannot find module `./push`.

- [ ] **Step 5: Implement `push.ts`**

Create `apps/web/src/lib/push.ts`:

```ts
export type PushSupportState = "unsupported" | "default" | "denied" | "granted-unsubscribed" | "subscribed";

function urlBase64ToUint8Array(base64: string): Uint8Array {
  const padding = "=".repeat((4 - (base64.length % 4)) % 4);
  const normalized = (base64 + padding).replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(normalized);
  return Uint8Array.from([...raw].map((char) => char.charCodeAt(0)));
}

export function isPushSupported(): boolean {
  return "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;
}

export async function getPushSupportState(): Promise<PushSupportState> {
  if (!isPushSupported()) return "unsupported";
  if (Notification.permission === "denied") return "denied";
  if (Notification.permission === "default") return "default";
  const registration = await navigator.serviceWorker.ready;
  const existing = await registration.pushManager.getSubscription();
  return existing ? "subscribed" : "granted-unsubscribed";
}

export class PushPermissionDeniedError extends Error {}

export async function subscribeToPush(vapidPublicKey: string): Promise<PushSubscriptionJSON> {
  if (!isPushSupported()) throw new Error("Push notifications are not supported in this browser.");
  const permission = await Notification.requestPermission();
  if (permission !== "granted") throw new PushPermissionDeniedError("Notification permission was not granted.");
  const registration = await navigator.serviceWorker.ready;
  const subscription = await registration.pushManager.subscribe({
    userVisibleOnly: true,
    applicationServerKey: urlBase64ToUint8Array(vapidPublicKey),
  });
  return subscription.toJSON();
}

export async function unsubscribeFromPush(): Promise<string | null> {
  if (!isPushSupported()) return null;
  const registration = await navigator.serviceWorker.ready;
  const existing = await registration.pushManager.getSubscription();
  if (!existing) return null;
  const endpoint = existing.endpoint;
  await existing.unsubscribe();
  return endpoint;
}
```

- [ ] **Step 6: Run the test to verify it passes**

Run: `cd apps/web && npm run test -- push.test`
Expected: PASS, all 9 tests green.

- [ ] **Step 7: Commit**

```bash
git add apps/web/src/lib/push.ts apps/web/src/lib/push.test.ts apps/web/src/vite-env.d.ts apps/web/.env.example
git commit -m "feat(web): add browser push subscribe/unsubscribe wrapper"
```

---

### Task 8: Settings UI — subscribe flow + per-category push toggle

**Files:**
- Create: `apps/web/src/features/settings/usePushSubscription.ts`
- Modify: `apps/web/src/features/settings/NotificationSettingsPage.tsx`
- Modify: `apps/web/src/features/settings/NotificationSettingsPage.test.tsx`

**Interfaces:**
- Consumes: `getPushSupportState`, `subscribeToPush`, `unsubscribeFromPush`, `PushPermissionDeniedError` (Task 7); `pushEnabled` on `NotificationPreferenceDTO` (Task 1); `POST /households/:id/notifications/test-push` (Task 6); `POST /push-subscriptions`, `POST /push-subscriptions/unsubscribe` (Task 3).

- [ ] **Step 1: Implement the hooks**

Create `apps/web/src/features/settings/usePushSubscription.ts`:

```ts
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { post } from "../../lib/api";
import { getPushSupportState, subscribeToPush, unsubscribeFromPush } from "../../lib/push";

const SUPPORT_KEY = ["push-support-state"];

export function usePushSupportState() {
  return useQuery({ queryKey: SUPPORT_KEY, queryFn: getPushSupportState });
}

export function useSubscribeToPush() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async () => {
      const vapidKey = import.meta.env.VITE_VAPID_PUBLIC_KEY;
      if (!vapidKey) throw new Error("Push notifications aren't configured for this deployment.");
      const subscription = await subscribeToPush(vapidKey);
      await post("/push-subscriptions", { endpoint: subscription.endpoint, keys: subscription.keys, userAgent: navigator.userAgent });
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: SUPPORT_KEY }),
  });
}

export function useUnsubscribeFromPush() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async () => {
      const endpoint = await unsubscribeFromPush();
      if (endpoint) await post("/push-subscriptions/unsubscribe", { endpoint });
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: SUPPORT_KEY }),
  });
}

export function useSendTestPushNotification(householdId: string) {
  return useMutation({
    mutationFn: () => post<{ delivered: boolean; reason?: string }>(`/households/${householdId}/notifications/test-push`),
  });
}
```

- [ ] **Step 2: Write the failing UI tests**

Replace `apps/web/src/features/settings/NotificationSettingsPage.test.tsx` entirely with:

```tsx
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { meKey } from "../auth/session";
import { NotificationSettingsPage } from "./NotificationSettingsPage";

const HOUSEHOLD = { id: "h1", name: "Shah Family", timezone: "Asia/Kolkata", role: "OWNER" as const, memberCount: 2 };

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function renderPage() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  qc.setQueryData(meKey, { user: { id: "u1", name: "Parakh", email: "p@example.com", emailVerified: true, createdAt: "2026-01-01T00:00:00.000Z" }, households: [HOUSEHOLD] });
  return render(<QueryClientProvider client={qc}><MemoryRouter><NotificationSettingsPage /></MemoryRouter></QueryClientProvider>);
}

function mockPreferencesFetch(overrides: { onPatch?: (url: string, body: unknown) => unknown } = {}) {
  return vi.spyOn(globalThis, "fetch").mockImplementation((async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (init?.method === "PATCH" && overrides.onPatch) {
      const result = overrides.onPatch(url, init.body ? JSON.parse(init.body as string) : {});
      if (result) return jsonResponse({ success: true, data: result, message: null });
    }
    if (url.endsWith("/households/h1/notification-preferences")) {
      return jsonResponse({ success: true, data: [
        { category: "BILL", enabled: true, emailEnabled: false, pushEnabled: false },
        { category: "SALARY", enabled: true, emailEnabled: false, pushEnabled: false },
      ] }, 200);
    }
    throw new Error(`unexpected fetch ${url}`);
  }) as typeof fetch);
}

function stubPushSupport({ permission, subscription }: { permission: NotificationPermission; subscription: unknown }) {
  (window as unknown as { PushManager: unknown }).PushManager = class {};
  (window as unknown as { Notification: unknown }).Notification = { permission, requestPermission: vi.fn().mockResolvedValue(permission) };
  const registration = {
    pushManager: {
      getSubscription: vi.fn().mockResolvedValue(subscription),
      subscribe: vi.fn().mockResolvedValue({ endpoint: "https://push.example/abc", toJSON: () => ({ endpoint: "https://push.example/abc", keys: { p256dh: "p", auth: "a" } }) }),
    },
  };
  Object.defineProperty(navigator, "serviceWorker", { value: { ready: Promise.resolve(registration) }, configurable: true });
}

function clearPushStubs() {
  delete (window as unknown as { PushManager?: unknown }).PushManager;
  delete (window as unknown as { Notification?: unknown }).Notification;
  Reflect.deleteProperty(navigator, "serviceWorker");
}

describe("NotificationSettingsPage", () => {
  beforeEach(() => { vi.restoreAllMocks(); });
  afterEach(() => { vi.restoreAllMocks(); clearPushStubs(); });

  it("renders both categories' current state", async () => {
    mockPreferencesFetch();
    renderPage();
    await screen.findByText("Bills");
    await screen.findByText("Salary");
    const billToggle = screen.getAllByRole("button", { name: "On" })[0]!;
    expect(billToggle).toHaveAttribute("aria-pressed", "true");
  });

  it("hides the email and push toggles when enabled is off", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation((async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/households/h1/notification-preferences")) {
        return jsonResponse({ success: true, data: [
          { category: "BILL", enabled: false, emailEnabled: false, pushEnabled: false },
          { category: "SALARY", enabled: true, emailEnabled: false, pushEnabled: false },
        ] }, 200);
      }
      throw new Error(`unexpected fetch ${url}`);
    }) as typeof fetch);
    renderPage();
    await screen.findByText("Bills");
    expect(screen.getAllByRole("button", { name: "Also email me" })).toHaveLength(1);
    expect(screen.getAllByRole("button", { name: "Also notify on this device" })).toHaveLength(1);
  });

  it("toggling enabled fires the correct PATCH body", async () => {
    const fetchSpy = mockPreferencesFetch({ onPatch: (url, body) => url.includes("/notification-preferences/BILL") ? { category: "BILL", enabled: false, emailEnabled: false, pushEnabled: false, ...(body as object) } : null });
    renderPage();
    await screen.findByText("Bills");
    const toggles = screen.getAllByRole("button", { name: "On" });
    await userEvent.click(toggles[0]!);
    const patchCall = fetchSpy.mock.calls.find(([u, init]) => String(u).includes("/notification-preferences/BILL") && (init as RequestInit | undefined)?.method === "PATCH");
    expect(patchCall).toBeDefined();
    expect(JSON.parse((patchCall![1] as RequestInit).body as string)).toEqual({ enabled: false });
  });

  it("toggling email opt-in fires the correct PATCH body", async () => {
    const fetchSpy = mockPreferencesFetch({ onPatch: (url, body) => url.includes("/notification-preferences/SALARY") ? { category: "SALARY", enabled: true, emailEnabled: true, pushEnabled: false, ...(body as object) } : null });
    renderPage();
    await screen.findByText("Salary");
    const emailToggles = screen.getAllByRole("button", { name: "Also email me" });
    await userEvent.click(emailToggles[1]!);
    const patchCall = fetchSpy.mock.calls.find(([u, init]) => String(u).includes("/notification-preferences/SALARY") && (init as RequestInit | undefined)?.method === "PATCH");
    expect(patchCall).toBeDefined();
    expect(JSON.parse((patchCall![1] as RequestInit).body as string)).toEqual({ emailEnabled: true });
  });

  it("toggling push opt-in fires the correct PATCH body", async () => {
    const fetchSpy = mockPreferencesFetch({ onPatch: (url, body) => url.includes("/notification-preferences/SALARY") ? { category: "SALARY", enabled: true, emailEnabled: false, pushEnabled: true, ...(body as object) } : null });
    renderPage();
    await screen.findByText("Salary");
    const pushToggles = screen.getAllByRole("button", { name: "Also notify on this device" });
    await userEvent.click(pushToggles[1]!);
    const patchCall = fetchSpy.mock.calls.find(([u, init]) => String(u).includes("/notification-preferences/SALARY") && (init as RequestInit | undefined)?.method === "PATCH");
    expect(patchCall).toBeDefined();
    expect(JSON.parse((patchCall![1] as RequestInit).body as string)).toEqual({ pushEnabled: true });
  });

  it("shows a not-supported message when the browser lacks push APIs", async () => {
    mockPreferencesFetch();
    renderPage();
    await screen.findByText(/aren't supported on this device/);
  });

  it("shows the test-notification button once subscribed, and sends a test push on click", async () => {
    stubPushSupport({ permission: "granted", subscription: { endpoint: "https://push.example/abc" } });
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation((async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/households/h1/notifications/test-push") && init?.method === "POST") {
        return jsonResponse({ success: true, data: { delivered: true }, message: null });
      }
      if (url.endsWith("/households/h1/notification-preferences")) {
        return jsonResponse({ success: true, data: [
          { category: "BILL", enabled: true, emailEnabled: false, pushEnabled: false },
          { category: "SALARY", enabled: true, emailEnabled: false, pushEnabled: false },
        ] }, 200);
      }
      throw new Error(`unexpected fetch ${url}`);
    }) as typeof fetch);
    renderPage();
    const testButton = await screen.findByRole("button", { name: "Send test notification" });
    await userEvent.click(testButton);
    await screen.findByText("Sent — check for a notification.");
    expect(fetchSpy.mock.calls.some(([u, init]) => String(u).endsWith("/households/h1/notifications/test-push") && (init as RequestInit | undefined)?.method === "POST")).toBe(true);
  });
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `cd apps/web && npm run test -- NotificationSettingsPage`
Expected: FAIL — `pushEnabled`-related assertions fail (toggle not rendered yet), and the not-supported/subscribed-state tests fail (no such UI yet).

- [ ] **Step 4: Implement the UI**

Replace `apps/web/src/features/settings/NotificationSettingsPage.tsx` entirely with:

```tsx
import type { NotificationPreferenceDTO, SettableNotificationCategory } from "@household/shared";
import { PushPermissionDeniedError } from "../../lib/push";
import { useActiveHousehold } from "../app/useActiveHousehold";
import { useNotificationPreferences, useUpdateNotificationPreference } from "./useNotificationPreferences";
import { usePushSupportState, useSendTestPushNotification, useSubscribeToPush, useUnsubscribeFromPush } from "./usePushSubscription";

const CATEGORY_LABEL: Record<SettableNotificationCategory, string> = { BILL: "Bills", SALARY: "Salary" };

function PushSubscriptionSection({ householdId }: { householdId: string }) {
  const supportQuery = usePushSupportState();
  const subscribeMutation = useSubscribeToPush();
  const unsubscribeMutation = useUnsubscribeFromPush();
  const testMutation = useSendTestPushNotification(householdId);

  if (!supportQuery.data) return null;
  const state = supportQuery.data;

  if (state === "unsupported") {
    return <p className="list__item">Browser notifications aren't supported on this device.</p>;
  }
  if (state === "denied") {
    return <p className="list__item">Notifications are blocked for this site — enable them in your browser's site settings.</p>;
  }

  if (state === "subscribed") {
    return (
      <div className="list__item" style={{ flexDirection: "column", alignItems: "stretch", gap: "var(--space-2)" }}>
        <span className="list__label">Enabled on this device</span>
        <div style={{ display: "flex", gap: "var(--space-2)" }}>
          <button type="button" className="chip" onClick={() => testMutation.mutate()} disabled={testMutation.isPending}>
            Send test notification
          </button>
          <button type="button" className="chip" onClick={() => unsubscribeMutation.mutate()} disabled={unsubscribeMutation.isPending}>
            Turn off on this device
          </button>
        </div>
        {testMutation.isSuccess && (
          <span>{testMutation.data.delivered ? "Sent — check for a notification." : "Not sent: no active device found."}</span>
        )}
      </div>
    );
  }

  return (
    <div className="list__item" style={{ flexDirection: "column", alignItems: "stretch", gap: "var(--space-2)" }}>
      <button type="button" className="chip" onClick={() => subscribeMutation.mutate()} disabled={subscribeMutation.isPending}>
        Enable browser notifications
      </button>
      {subscribeMutation.isError && (
        <span>{subscribeMutation.error instanceof PushPermissionDeniedError ? "Notification permission was denied." : subscribeMutation.error.message}</span>
      )}
    </div>
  );
}

export function NotificationSettingsPage() {
  const { household } = useActiveHousehold();
  const householdId = household?.id;
  const prefsQuery = useNotificationPreferences(householdId);
  const updatePref = useUpdateNotificationPreference(householdId ?? "");

  if (!householdId || !prefsQuery.data) return null;

  function onToggleEnabled(pref: NotificationPreferenceDTO) {
    updatePref.mutate({ category: pref.category, body: { enabled: !pref.enabled } });
  }

  function onToggleEmail(pref: NotificationPreferenceDTO) {
    updatePref.mutate({ category: pref.category, body: { emailEnabled: !pref.emailEnabled } });
  }

  function onTogglePush(pref: NotificationPreferenceDTO) {
    updatePref.mutate({ category: pref.category, body: { pushEnabled: !pref.pushEnabled } });
  }

  return (
    <>
      <header className="page-head"><h1 className="page-title">Notification settings</h1></header>
      <PushSubscriptionSection householdId={householdId} />
      <div className="list">
        {prefsQuery.data.map((pref) => (
          <div key={pref.category} className="list__item" style={{ flexDirection: "column", alignItems: "stretch", gap: "var(--space-2)" }}>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
              <span className="list__label">{CATEGORY_LABEL[pref.category]}</span>
              <button type="button" className="chip" aria-pressed={pref.enabled} onClick={() => onToggleEnabled(pref)}>
                {pref.enabled ? "On" : "Off"}
              </button>
            </div>
            {pref.enabled && (
              <>
                <button type="button" className="chip" aria-pressed={pref.emailEnabled} onClick={() => onToggleEmail(pref)}>
                  Also email me
                </button>
                <button type="button" className="chip" aria-pressed={pref.pushEnabled} onClick={() => onTogglePush(pref)}>
                  Also notify on this device
                </button>
              </>
            )}
          </div>
        ))}
      </div>
    </>
  );
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `cd apps/web && npm run test -- NotificationSettingsPage`
Expected: PASS, all 8 tests green.

- [ ] **Step 6: Commit**

```bash
git add apps/web/src/features/settings/usePushSubscription.ts apps/web/src/features/settings/NotificationSettingsPage.tsx apps/web/src/features/settings/NotificationSettingsPage.test.tsx
git commit -m "feat(web): add push subscribe flow and per-category push toggle to settings"
```

---

### Task 9: Service worker push handling + notification-click navigation

**Files:**
- Modify: `apps/web/src/sw.ts`
- Modify: `apps/web/src/features/app/AppShell.tsx`
- Modify: `apps/web/src/features/app/AppShell.test.tsx`

**Interfaces:**
- Consumes: push payload shape `{ title, body, tag, linkPath }` (Global Constraints), message type `"notification-click"`.

- [ ] **Step 1: Add push + notificationclick listeners to the service worker**

Replace `apps/web/src/sw.ts` entirely with:

```ts
import { precacheAndRoute } from "workbox-precaching";
import { offlineFallback } from "workbox-recipes";

type PushPayload = { title?: string; body?: string; tag?: string; linkPath?: string | null };
type ClientLike = { focus?: () => Promise<unknown>; postMessage: (msg: unknown) => void };
type PushEventLike = { data?: { json: () => PushPayload }; waitUntil: (p: Promise<unknown>) => void };
type NotificationClickEventLike = { notification: { close: () => void; data?: { linkPath?: string } }; waitUntil: (p: Promise<unknown>) => void };

declare const self: {
  __WB_MANIFEST: Array<{ url: string; revision: string | null }>;
  registration: { showNotification: (title: string, options: { body?: string; icon?: string; badge?: string; tag?: string; data?: unknown }) => Promise<void> };
  clients: { matchAll: (opts: { type: string; includeUncontrolled: boolean }) => Promise<ClientLike[]>; openWindow: (url: string) => Promise<unknown> };
  addEventListener(type: "push", listener: (event: PushEventLike) => void): void;
  addEventListener(type: "notificationclick", listener: (event: NotificationClickEventLike) => void): void;
};

precacheAndRoute(self.__WB_MANIFEST);

offlineFallback({ pageFallback: "/offline.html" });

self.addEventListener("push", (event) => {
  let payload: PushPayload = {};
  try { payload = event.data?.json() ?? {}; } catch { /* non-JSON or empty payload — fall back to generic text */ }
  const title = payload.title ?? "Household update";
  event.waitUntil(self.registration.showNotification(title, {
    body: payload.body ?? "",
    icon: "/pwa-192x192.png",
    badge: "/pwa-192x192.png",
    tag: payload.tag ?? "reminder-notification",
    data: { linkPath: payload.linkPath ?? "/" },
  }));
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const linkPath = event.notification.data?.linkPath ?? "/";
  event.waitUntil((async () => {
    const allClients = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    const client = allClients.find((c) => typeof c.focus === "function");
    if (client?.focus) {
      await client.focus();
      client.postMessage({ type: "notification-click", linkPath });
    } else {
      await self.clients.openWindow(linkPath);
    }
  })());
});
```

(No automated test for this file — matches the existing PWA shell convention: Workbox/service-worker behavior is verified manually, see Verification below. The `notificationclick` → app navigation behavior IS covered automatically, in Step 2-4 below, via `AppShell`'s message listener.)

- [ ] **Step 2: Write the failing AppShell test**

In `apps/web/src/features/app/AppShell.test.tsx`, add a new route to `renderShell`'s `<Routes>` (inside the existing `<Route element={<AppShell />}>` is wrong — add it as a sibling top-level route, matching how `/search` and `/more` are already siblings):

```tsx
          <Route path="/bills/:id" element={<div>Bill detail page</div>} />
```

placed right after the existing `<Route path="/more" element={<div>More page</div>} />` line.

Add this test at the end of the `describe("AppShell", ...)` block, right before its closing `});`:

```tsx
  it("navigates and refreshes notifications when the service worker reports a notification click", async () => {
    const swTarget = new EventTarget();
    Object.defineProperty(navigator, "serviceWorker", { value: swTarget, configurable: true });
    renderShell(0);
    await screen.findByText("Home page body");

    swTarget.dispatchEvent(new MessageEvent("message", { data: { type: "notification-click", linkPath: "/bills/abc123" } }));

    await screen.findByText("Bill detail page");
    Reflect.deleteProperty(navigator, "serviceWorker");
  });
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `cd apps/web && npm run test -- AppShell`
Expected: FAIL — the new test times out (`findByText("Bill detail page")` never resolves), since `AppShell` doesn't listen for service worker messages yet.

- [ ] **Step 4: Implement the message listener**

In `apps/web/src/features/app/AppShell.tsx`, change the imports:

```tsx
import { useEffect, useState } from "react";
import { Link, NavLink, Outlet, useNavigate } from "react-router-dom";
import { useQueryClient } from "@tanstack/react-query";
```

(`useState` stays alongside the new `useEffect`; `useNavigate` is added to the existing `react-router-dom` import; `useQueryClient` is a new import from `@tanstack/react-query`.)

Inside the `AppShell` function body, right after `const name = data?.user.name ?? "";`, add:

```tsx
  const navigate = useNavigate();
  const qc = useQueryClient();

  useEffect(() => {
    if (!("serviceWorker" in navigator)) return;
    function onMessage(event: MessageEvent) {
      if (!event.data || event.data.type !== "notification-click") return;
      if (household) {
        void qc.invalidateQueries({ queryKey: ["notifications", household.id] });
        void qc.invalidateQueries({ queryKey: ["notifications-unread-count", household.id] });
      }
      navigate(event.data.linkPath as string);
    }
    navigator.serviceWorker.addEventListener("message", onMessage);
    return () => navigator.serviceWorker.removeEventListener("message", onMessage);
  }, [navigate, qc, household]);
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `cd apps/web && npm run test -- AppShell`
Expected: PASS, all tests (existing + new) green.

- [ ] **Step 6: Run the full web suite once**

Run: `cd apps/web && npm run typecheck && npm run test`
Expected: typecheck clean, all tests pass — this is the last task, a good final checkpoint before the full-branch build check.

- [ ] **Step 7: Commit**

```bash
git add apps/web/src/sw.ts apps/web/src/features/app/AppShell.tsx apps/web/src/features/app/AppShell.test.tsx
git commit -m "feat(web): handle push/notificationclick in the service worker, navigate on click"
```

---

## Verification

1. Run each task's own test command as listed above during implementation (already covers every new/changed file individually, per the project's testing-cadence convention).
2. Full suite once, post-merge: `npm run test --workspace @household/api` and `npm run test --workspace @household/web`.
3. `npm run build --workspace @household/web` (regenerates PWA assets, confirms `sw.ts` compiles under `injectManifest`) and `tsc --noEmit` in both `apps/api` and `apps/web`.
4. Manual end-to-end (service workers and real push require this — no amount of unit testing substitutes for it): generate real VAPID keys with `npx web-push generate-vapid-keys`, set `PUSH_PROVIDER=web-push` + `VAPID_PUBLIC_KEY`/`VAPID_PRIVATE_KEY` in `apps/api/.env` and the same public key as `VITE_VAPID_PUBLIC_KEY` in `apps/web/.env`, run both dev servers, open Settings in a real browser (localhost counts as a secure context), click "Enable browser notifications", grant the permission prompt, click "Send test notification", confirm a real OS-level notification appears, and confirm clicking it focuses/navigates the app tab.
