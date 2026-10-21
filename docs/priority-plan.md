# Production, Mobile Launch & Scaling — Priority Plan

Source brief: user-supplied launch plan targeting ~500 households across web/PWA + published Android/iOS apps, with push notifications and optional monetization. Brief mandates: audit first, preserve existing architecture, work incrementally, no large rewrite.

Phase A (read-only audit) is complete — three parallel audits covered frontend Capacitor-readiness, API reliability/security, and payments/data-layer. This doc consolidates those findings into a priority-ordered roadmap.

Each phase below gets its own spec → plan → implementation cycle when it's time to build it (brainstorm → spec → plan → subagent-driven-development, same workflow used for the web-push-notifications feature) — this document is the sequencing and scope, not a line-by-line implementation plan for every phase.

## Phase A Audit Findings

### Hosting/reliability — apps/api

| Severity | Finding |
|---|---|
| High | `globalLimiter` (`rate-limit.ts`, mounted ahead of auth in `app.ts:46`) has no `passOnStoreError`; a Redis blip makes it rethrow and 500 *every* `/api` request, not just rate-limited ones — Redis is an unmonitored single point of failure for the whole API in the default `JOB_RUNNER=bullmq` mode. |
| Medium-High | `db/client.ts`'s pool (`max=20` default via `DATABASE_POOL_MAX`) is opened independently by both `server.ts` and `worker.ts` — 40 baseline connections before any API horizontal scaling. Risk of exceeding Neon's connection ceiling, especially if `DATABASE_URL` points at Neon's direct (non-pooled) endpoint. |
| Medium | `/api/health/ready` (`health.routes.ts`) only checks Postgres (`select 1`), never Redis — blind to the exact failure mode above. |
| Medium | No APM/error-tracking vendor wired up. `lib/error-reporter.ts`'s `ErrorReporter` interface is deliberately swappable but `server.ts` only ever instantiates `ConsoleErrorReporter` — no alerting/aggregation at launch scale. |
| Medium | `JOB_RUNNER=http` mode's overlap guard (`internal.routes.ts`'s `running` boolean) is in-process only — no distributed lock if ever run behind >1 instance. Self-heals on crash (fresh process resets the flag), fine for the documented single-instance free-tier use case only. |
| Low-Medium | Local `apps/api/.env` (gitignored, never committed) holds a live Resend API key + VAPID private key — confirm no out-of-band leakage, rotate before/at launch if in doubt. |
| Low | CORS, auth/session (opaque revocable tokens, sliding TTL, concurrent-session support already works), household-scoped authorization (consistent `requireHousehold` gate across ~70 routes, 404-not-403 to prevent enumeration), and zod-based input validation are all solid — no structural fixes needed, only correct env config at deploy time. |

### Mobile/Capacitor-readiness — apps/web

| Severity | Finding |
|---|---|
| Blocker | `BrowserRouter` (`main.tsx`) + Netlify-only SPA fallback (`public/_redirects`) has no equivalent inside Capacitor's local webview — deep-link/cold-start navigation to a sub-path can break. |
| Blocker | `lib/api.ts`'s `VITE_API_URL` defaults to `""`, relying on Netlify's `/api/*` same-origin proxy (`_redirects`) for cookie/CSRF handling. A Capacitor build has no such proxy — this is the first scenario requiring a real absolute `VITE_API_URL` baked in at build time, making every API call genuinely cross-origin from the native shell's perspective. |
| High | The web-push flow just shipped (`lib/push.ts`, `sw.ts`'s `push`/`notificationclick` handlers, `AppShell.tsx`'s postMessage bridge) is Web-Push-specific and likely redundant/unreliable inside a native shell (iOS WKWebView has partial/inconsistent SW support) — native push (FCM/APNs via a Capacitor plugin) would need its own separate tap-handling path feeding the same `navigate()` call, not reuse this one as-is. |
| Medium | `window.open` for the WhatsApp invite-share link (`MembersPage.tsx`) needs `@capacitor/browser` or equivalent to reliably escape to the system browser/WhatsApp app from a native webview. |
| Low | `window.confirm`/`window.prompt` (8 destructive-action confirms across Bills/Salary/Attendance/Checklist pages) render inconsistently across native WebViews — UX polish item, not a hard blocker. |
| None found | No file-upload feature exists (nothing to migrate to a Capacitor Camera/file-picker plugin). No payment/redirect flow exists in the frontend today (non-issue for Capacitor wrapping). No deep-link/universal-link infra exists yet for invite links opening the native app from outside — needed later if native push/invite flows are added. |

### Payments & data layer

- Confirmed exactly as the launch brief warned against: bill/salary "payment recording" is 100% self-reported (free-text `transactionRef`, no gateway integration, no webhook, no signature verification anywhere in `apps/api/src`). No Razorpay/PhonePe/UPI-link integration exists.
- Zero subscription/premium-tier/entitlement scaffolding anywhere in schema or DTOs — monetization would start from nothing.
- Schema (29 tables) is well-indexed on the hot paths spot-checked (notifications, notification_deliveries, bill_occurrences, attendance_records) — no missing-FK-index concerns found. Migrations are properly sequential via drizzle-kit (not one unversioned blob).
- `apps/api/.env.example`'s `DATABASE_URL` is a plain local-Postgres template — no evidence in-repo of whether production actually uses Neon's pooled vs. direct endpoint. Needs live confirmation (can't be audited from code alone, per the launch brief's own instruction not to guess provider quotas).
- No backup/restore/PITR documentation exists anywhere in the repo.
- `feature/load-perf-testing` is merged to master — one small-scale `autocannon` smoke run exists (`docs/performance/2026-10-14-load-test.md`), explicitly self-caveated as not representative of production-scale row counts or BullMQ throughput. One real fix shipped from it (`/today`'s sequential awaits → `Promise.all`) and pool-size made configurable.

## Priority-Ordered Roadmap

Sequenced by the launch brief's own stated order, adjusted for what the audit actually found (fix cheap/high-risk items before starting expensive/slow-to-unblock mobile work):

### 1. Hosting/reliability hardening (next concrete step — no external accounts needed)
- Add `passOnStoreError: true` (or an equivalent explicit fallback) to the rate limiters so a Redis blip degrades rate-limiting, not the whole API.
- Extend `/api/health/ready` to also check Redis connectivity.
- Confirm actual Neon connection limit and `DATABASE_URL` pooled-vs-direct endpoint (needs user to check Neon dashboard — cannot be verified from code); right-size `DATABASE_POOL_MAX` accordingly, or move the worker onto Neon's pooled endpoint if it isn't already.
- Wire a real `ErrorReporter` implementation (e.g. Sentry) behind the existing `ErrorReporter` interface — swap-in, no interface change needed.
- Confirm Render plan (Free vs. paid always-on) based on actual cold-start/uptime impact — needs user's Render dashboard access, not guessable from code.
- Rotate the Resend API key / VAPID private key currently sitting in the local `.env` if there's any doubt about exposure.

### 2. Capacitor mobile wrapping
Blocked on resolving the routing + API-proxy assumptions first:
- Decide: switch to `HashRouter`, or confirm Capacitor's webview can be configured with a server-style fallback (e.g. via `capacitor.config`'s `server` option or a local static-file server plugin) — needs a spike before committing to one approach.
- Set a real production `VITE_API_URL` for Capacitor builds (separate build config from the Netlify web build) and re-verify cookie/CSRF behavior cross-origin from a native shell.
- Decide web-push vs. native-push strategy for the mobile build specifically (likely: disable the web-push UI/SW branch in Capacitor builds, add native push separately in Phase 3 below) rather than trying to make both coexist.
- Needs: Apple Developer account + Mac/Xcode access (user to arrange — cannot be substituted), Google Play Developer account.

### 3. Native push notifications (FCM/APNs)
- Add a Capacitor push plugin; associate device tokens with authenticated users (new table, mirrors `push_subscriptions`'s shape but for native tokens — same revoke-on-invalid-token pattern already proven out in the web-push work).
- Native tap-to-navigate needs its own listener feeding the same `navigate(linkPath)` AppShell already has.
- Needs: Firebase project (Android), Apple Push certs/keys (iOS).

### 4. Monetization (defer until product-market signal, per the brief's own "validate before building tiers" instruction)
- No scaffolding exists yet (confirmed in audit) — this is a from-scratch build when it happens: entitlement model, RevenueCat vs. direct StoreKit/Play Billing decision, server-side purchase verification.
- Separately: the self-reported bill-payment flow (no gateway) is a known, accepted gap per the brief — not blocking, since household bill payments are a different flow from app-premium billing.

### 5. Security/privacy pass + launch gates
- Backup/restore/PITR: document and test a real restore (currently zero documentation exists).
- Formal load test at production-representative scale (current one is an explicitly-caveated small-scale smoke test).
- Account deletion / data export / privacy policy / store metadata — none of this exists yet per the audit; needed before any app-store submission regardless of mobile timeline.

## What needs the user, not code

- Neon dashboard: actual plan, connection limits, pooled-vs-direct endpoint in use.
- Render dashboard: actual plan, cold-start behavior observed in practice.
- Apple Developer account + a Mac for iOS builds/signing (no substitute).
- Google Play Developer account.
- Firebase project (Android push) + Apple Push credentials (iOS push), when Phase 3 starts.
- Decision on monetization timing/pricing (brief explicitly says validate with users first, don't guess).

## Next action

Start item 1 (hosting/reliability hardening) — it's the only phase with no external blockers, directly addresses the highest-severity audit findings, and matches the brief's own ordering (stabilize before mobile).
