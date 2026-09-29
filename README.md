# Ghar — household management for Indian homes

> *Working name. Open the app and immediately know what needs attention today.*

A mobile-first, PWA-ready app for managing househelps, attendance, checklists, salaries, household bills and reminders — built for families, including non-technical and senior members.

**Status: Phase 2 of 10 complete** — members and invites, househelps, categories (CRUD and reorder), and schedules, on top of Phase 1's architecture, data model, authentication, households and household-level authorization. See [Roadmap](#roadmap).

---

## Contents

- [Architecture](#architecture)
- [Tech stack](#tech-stack)
- [Folder structure](#folder-structure)
- [Local setup](#local-setup)
- [Environment variables](#environment-variables)
- [Database](#database)
- [Running the apps](#running-the-apps)
- [Testing](#testing)
- [Building for production](#building-for-production)
- [Security model](#security-model)
- [Design system](#design-system)
- [Decisions & deviations from the spec](#decisions--deviations-from-the-spec)
- [PWA & push notifications](#pwa--push-notifications)
- [Deployment](#deployment)
- [Troubleshooting](#troubleshooting)
- [Roadmap](#roadmap)

---

## Architecture

```
┌──────────────────────┐   same-origin /api (Vite proxy in dev,
│  apps/web            │   reverse proxy in prod)
│  React 19 + Vite     │ ───────────────────────────────┐
│  TanStack Query      │                                 ▼
└──────────────────────┘                  ┌──────────────────────────────┐
          │ imports                       │  apps/api   Express 5        │
          ▼                               │                              │
┌──────────────────────┐   imports        │  routes/      thin: parse →  │
│  packages/shared     │ ◀─────────────── │               service → reply│
│  zod schemas, money, │                  │  middleware/  auth, household│
│  permissions, time,  │                  │               authz, CSRF,   │
│  API contract types  │                  │               rate limit     │
└──────────────────────┘                  │  services/    ALL business   │
                                          │               logic          │
                                          │  db/          Drizzle schema │
                                          └──────────────┬───────────────┘
                                                         ▼
                                                  PostgreSQL 16
                                     (Redis + BullMQ added in Phase 7)
```

**Rules the codebase follows**

- Business logic lives in `apps/api/src/services`. Route handlers only parse input, call a service and respond. React components never compute business rules.
- Validation schemas live once in `packages/shared` and run on both client and server.
- Services receive their dependencies (`db`, `clock`, `email`, `logger`, `env`) as a `Deps` object — no module singletons. Tests inject a fake clock, so time-sensitive logic (session expiry, and later reminders and due dates) is tested at exact instants.
- Every household-scoped request goes through `requireHousehold(deps, permission)`. Downstream code uses `req.membership.householdId`, **never** a household id from the URL or body.

## Tech stack

| Layer | Choice |
|---|---|
| Language | TypeScript 5.9 (strict, `noUncheckedIndexedAccess`) |
| API | Express 5, zod 4, pino, helmet, express-rate-limit |
| Database | PostgreSQL 16, Drizzle ORM 0.45 + drizzle-kit migrations |
| Auth | argon2id (`@node-rs/argon2`), opaque DB-backed sessions |
| Web | React 19, Vite 8, React Router 7, TanStack Query 5, lucide icons |
| Tests | Vitest 5, Supertest, React Testing Library, Playwright |
| Font | Atkinson Hyperlegible Next (designed for low-vision readability) |

## Folder structure

```
household-app/
├── apps/
│   ├── api/
│   │   ├── drizzle/                 # generated SQL migrations (committed)
│   │   ├── src/
│   │   │   ├── config/env.ts        # validated environment
│   │   │   ├── db/                  # schema.ts, client, migrate, seed
│   │   │   ├── lib/                 # errors, respond, logger, crypto, password, clock
│   │   │   ├── middleware/          # auth, household, csrf, validate, rate-limit, error
│   │   │   ├── routes/              # auth, households, health
│   │   │   ├── services/            # auth, session, household, audit, email/
│   │   │   ├── app.ts               # createApp(deps) — used by server and tests
│   │   │   └── server.ts            # process entry, graceful shutdown
│   │   └── tests/                   # integration tests against real Postgres
│   └── web/
│       └── src/
│           ├── components/          # design-system primitives
│           ├── features/auth/       # sign in/up, reset, verify
│           ├── features/app/        # shell, guards, onboarding, home, more
│           ├── lib/                 # api client, formatting
│           └── styles/              # tokens.css, base.css, components.css
├── packages/shared/src/             # money, permissions, time, schemas, DTOs, API types
├── e2e/                             # Playwright journeys
└── playwright.config.ts
```

## Local setup

**Prerequisites:** Node 22 (`.nvmrc`; ≥ 20.11 works), PostgreSQL 14+.

```bash
# 1. Install
npm install

# 2. Databases (dev + test). Example using psql as a superuser:
psql -c "CREATE USER app WITH PASSWORD 'app' CREATEDB;"
createdb -O app household_dev
createdb -O app household_test

# 3. Environment
cp apps/api/.env.example apps/api/.env      # defaults match the commands above

# 4. Schema + demo data
npm run build -w @household/shared
npm run db:migrate
npm run db:seed

# 5. Run
npm run dev          # API on :4000, web on :5173
```

Open <http://localhost:5173> and sign in as **parakh@example.com / demo-password-123**. The seed also creates *mother@example.com* and *father@example.com* (same password) as MEMBERs of "Shah Family". Mother has bill reminders switched off, to exercise per-user preferences in Phase 7.

**Emails in development:** `EMAIL_PROVIDER=console` prints verification and reset emails, including their links, to the API log.

## Environment variables

All variables are validated at startup (`apps/api/src/config/env.ts`); the API refuses to start with invalid config. See `apps/api/.env.example`.

| Variable | Default | Purpose |
|---|---|---|
| `NODE_ENV` | `development` | `production` enables Secure `__Host-` cookies |
| `PORT` | `4000` | API port |
| `APP_URL` | `http://localhost:5173` | Web origin: CORS allow-list and email links |
| `CORS_ORIGINS` | — | Extra allowed origins, comma separated |
| `TRUST_PROXY` | `0` | Proxy hops in front of the API (for correct client IPs) |
| `DATABASE_URL` | — (required) | Postgres connection |
| `TEST_DATABASE_URL` | `…/household_test` | Wiped on every test run; name must contain "test" |
| `SESSION_TTL_DAYS` | `30` | Sliding session lifetime |
| `EMAIL_PROVIDER` | `console` | `console` or `memory` (tests) |
| `EMAIL_FROM` | — | Sender address |
| `RATE_LIMIT_AUTH_MAX` | `10` | Auth attempts per 15 min per IP + email |
| `RATE_LIMIT_GLOBAL_MAX` | `300` | Requests per minute per IP |
| `LOG_LEVEL` | `info` | pino level |
| `LOG_PRETTY` | dev: `true` | Human-readable logs |
| `REDIS_URL`, `VAPID_*` | — | Reserved for Phase 7 |
| `VITE_API_URL` (web) | same origin | Only if the API is on a different origin |

`.env` is git-ignored. Never commit secrets.

## Database

The **entire data model** (29 tables) is defined now in `apps/api/src/db/schema.ts`, so later phases add services, not schema redesigns. Conventions:

- **Every household-scoped table** has `id`, `household_id`, `created_at`, `updated_at`, with indexes on `household_id` and composites such as `(household_id, due_date)` and `(household_id, status, due_date)`.
- **Composite foreign keys.** Child rows reference parents as `(household_id, parent_id) → parent(household_id, id)`. The database rejects any row that links data across households, even if application code has a bug. A test proves this.
- **Money** is `bigint` paise, never floats. Helpers in `packages/shared/src/money.ts` (`rupeesToPaise`, `formatINR`, `prorate`) are exact; `prorate` uses BigInt half-up rounding.
- **Dates vs instants.** Calendar concepts (due dates, attendance days) are `date` columns, returned as `"YYYY-MM-DD"` strings and interpreted in the **household timezone** (default `Asia/Kolkata`). Instants are `timestamptz`; every connection runs in UTC.
- **Bills** are split into `bills` (definition) → `bill_occurrences` (each due instance, unique `(bill_id, sequence)` so generation is idempotent) → `bill_payments` (supports partial payments).
- **Overdue is derived, not stored** — `due_date < today (household tz) AND unpaid`. A missed nightly job can never leave a stale status.
- **Notifications** carry a globally unique `idempotency_key` (e.g. `bill_occ:<id>:before:3:user:<id>`), so a reminder job that runs twice cannot create duplicates.
- **No hard deletes** for financial/historical data: `archived_at`, `voided_at`, `deleted_at`.
- **Offline-ready:** attendance and checklist completions have a `client_mutation_id` unique per household, so queued offline writes (Phase 9) replay safely.

```bash
npm run db:generate   # after editing schema.ts → writes a new SQL migration to apps/api/drizzle/
npm run db:migrate    # apply migrations
npm run db:seed       # demo data (refuses to run in production)
npm run db:studio -w @household/api   # browse data
```

Review generated SQL before committing it.

## Running the apps

```bash
npm run dev        # both
npm run dev:api    # API only (tsx watch)
npm run dev:web    # web only (Vite; proxies /api → :4000)
```

## Testing

```bash
npm test                 # shared unit + API integration + web component tests
npm run test:e2e         # Playwright (needs Postgres migrated + seeded)
npm run typecheck
npm run lint
```

- **API integration tests** run against a **real Postgres** (`TEST_DATABASE_URL`), which is dropped and re-migrated at the start of each run. They cover signup, login, session expiry and sliding renewal, logout revocation, email verification, password reset (single-use, expiry, revoking all sessions), change password, CSRF, CORS, rate limiting, error envelopes and security headers. They also cover roles, per-household permission overrides, the audit log, and **TEST 9 (household isolation)** at both API and database level.
- **E2E** runs 5 user journeys on Android, iPhone and desktop viewports (15 runs).
- First-time Playwright setup: `npx playwright install chromium`.

Results when Phase 1 was delivered: shared 13 ✓, API 42 ✓, web 6 ✓, E2E 15 ✓; typecheck, lint and build clean.

## Building for production

```bash
npm run build
# → packages/shared/dist, apps/api/dist, apps/web/dist (static files)
NODE_ENV=production npm run start -w @household/api
```

Serve `apps/web/dist` from a CDN or static host and route `/api/*` to the API on the **same origin**. This keeps the `SameSite=Lax` session cookie first-party, which matters on iPhone Safari.

## Security model

| Concern | Implementation |
|---|---|
| Passwords | argon2id (m=19 MiB, t=2, p=1). Length-based policy (8–128) per NIST 800-63B |
| Sessions | 256-bit random token; only its SHA-256 stored. `httpOnly`, `SameSite=Lax`, `__Host-` + `Secure` in production. Sliding 30-day expiry; instantly revocable |
| Native apps (future) | Same token accepted as `Authorization: Bearer` |
| Password reset / verify | Single-use, hashed, expiring tokens (1 h / 24 h); issuing a new one invalidates the old. Reset revokes every session |
| Account enumeration | Identical responses and equalised timing (dummy argon2 verify) for unknown emails |
| CSRF | SameSite cookie **+** required `x-household-client` header on every mutation **+** Origin allow-list |
| Authorization | Membership row decides access; non-members get **404** (IDs can't be probed); permission checks, not role checks |
| Cross-household integrity | Composite foreign keys in Postgres |
| Input | zod on every body; parameterised SQL only (Drizzle); 100 kB body limit |
| Headers | helmet (CSP `default-src 'none'` for the JSON API, nosniff, frame denial, HSTS) |
| Rate limiting | Global per IP; auth per IP + email. Memory store — **use a Redis store when running more than one API instance** |
| Logging | Structured pino with redaction of passwords, tokens, cookies, auth headers, account numbers; request paths logged without query strings |
| Errors | Users see friendly messages; stack traces only in logs, correlated by `x-request-id` |
| Audit | `audit_logs` rows written in the same transaction as the change |
| Open redirects | Post-login return paths are restricted to in-app paths |

### Roles

Defaults live in `packages/shared/src/permissions.ts`. Households can grant or revoke permissions per role through `households.role_permission_overrides`. OWNER can never lose permissions.

| | OWNER | ADMIN | MEMBER | VIEWER |
|---|---|---|---|---|
| View everything | ✓ | ✓ | ✓ | ✓ |
| Mark attendance, complete tasks, record payments | ✓ | ✓ | ✓ | — |
| Manage househelps, bills, checklists, salaries | ✓ | ✓ | — | — |
| Manage members | ✓ | — | — | — |
| Delete household | ✓ | — | — | — |

## Design system

Tokens are in `apps/web/src/styles/tokens.css`, with light and dark variants. Principles:

- **Terracotta** `#C2410C` is the primary colour. **Ochre gold** `#B8790C` is reserved for one meaning, "today", so it stays a strong signal.
- **Atkinson Hyperlegible Next** at a 17px base, for senior family members. Inputs are ≥16px to stop iOS zoom-on-focus.
- 48px touch targets; visible focus rings; `prefers-reduced-motion` respected.
- Status is always a word or icon **plus** colour, never colour alone.
- Mobile: bottom tab bar (Home, Househelps, Checklist, Bills, More). Desktop (≥900px): sidebar.

Primitives so far: `Button`, `TextField` (with password reveal), `Alert`, `EmptyState`, `ErrorState`, `Logo`. BottomSheet, Badge variants, Tabs, Toast, DatePicker and Skeleton arrive with the features that need them.

## Decisions & deviations from the spec

1. **Drizzle instead of Prisma.** Prisma's engine binaries couldn't be downloaded in the environment where Phase 1 was built and tested. Drizzle is TypeScript-native, has no native engine, and produces reviewable SQL migrations. Switching to Prisma later is feasible: `prisma db pull` on this schema is a starting point.
2. **Opaque sessions instead of JWT.** Every session can be revoked instantly (sign-out, password reset, removed members), which JWTs can't do without a denylist. So there is no `JWT_SECRET`.
3. **Household-scoped URLs:** `/api/households/:householdId/househelps` rather than `/api/househelps`. The id in the path is only a request; the membership row decides access.
4. **`OVERDUE` is computed**, as explained under [Database](#database).
5. **Not-marked attendance** is the absence of a row. The app never infers attendance.

## PWA & push notifications

Planned for Phase 7 (web push) and Phase 9 (manifest, service worker, offline cache and queued mutations). The groundwork is in place: `push_subscriptions` and `notification_deliveries` tables, the `IN_APP`/`WEB_PUSH`/`EMAIL`/`SMS`/`WHATSAPP` channel enum, `client_mutation_id` columns, and theme-colour and viewport-fit meta tags. To generate VAPID keys when the time comes: `npx web-push generate-vapid-keys`.

## Deployment

Any Node 20+ host plus managed Postgres (for example Render, Railway, Fly.io or AWS). Checklist:

- `NODE_ENV=production`, a strong DB password, TLS everywhere.
- Run `npm run db:migrate` as a release step, before new code starts.
- Serve the web app and API on one origin, and set `APP_URL` to it.
- Set `TRUST_PROXY` to the number of proxies in front of the API.
- Health checks: `GET /api/health/live` (process) and `GET /api/health/ready` (includes DB).
- The API shuts down gracefully on SIGTERM.
- Replace `ConsoleEmailProvider` with a real provider (SES, Resend or Postmark) by implementing `EmailProvider` — a one-file change.

## Troubleshooting

| Symptom | Fix |
|---|---|
| `Invalid environment configuration` on start | Copy `apps/api/.env.example` to `apps/api/.env` and fix the listed keys |
| `/api/health/ready` returns 503 | Postgres isn't reachable at `DATABASE_URL` |
| Every POST returns `CSRF_FAILED` | Call the API through `apps/web/src/lib/api.ts` (it adds the header), or add `x-household-client: web` |
| Signed in, but immediately signed out on iPhone | The web app and API are on different sites. Serve them on one origin |
| `Refusing to wipe non-test database` | `TEST_DATABASE_URL` must point at a database whose name contains "test" |
| Can't find the verification/reset email in dev | It is printed in the API log (`EMAIL_PROVIDER=console`) |
| Playwright: browser not found | `npx playwright install chromium` |

## Roadmap

| Phase | Scope | Status |
|---|---|---|
| 1 | Architecture, data model, auth, households, authorization | ✅ |
| 2 | Members and invites, househelps, categories (CRUD and reorder), schedules | ✅ |
| 3 | Attendance (one-tap), calendar, analytics | next |
| 4 | Checklist tasks, assignments, completion | |
| 5 | Salary calculation, settlement, payments | |
| 6 | Bills, recurrence engine, occurrences, partial payments | |
| 7 | Reminder engine (BullMQ + Redis), notification centre, web push, preferences | |
| 8 | Today service and dashboard, reports and exports, search | |
| 9 | PWA, offline cache and mutation queue, mobile polish | |
| 10 | Security review, load and performance testing, production hardening | |

Phases 2 onward are best continued in Claude Code against a real Postgres and Redis. Phase 7's jobs need a process that keeps running.
