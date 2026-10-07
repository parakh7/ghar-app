# Reminder Queue Infra (Phase 7 Spec 1) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Regression testing per task: run only the targeted workspace's test command named in that task's steps, not the full monorepo suite.

**Goal:** Stand up BullMQ+Redis queue infrastructure end-to-end, proven with one trivial scheduled job. No reminder business logic yet (that's Specs 2-3) — this spec exists purely to get the plumbing right: a real Redis available locally, a queue/worker abstraction that follows this codebase's existing dependency-injection pattern, and a worker process that can actually run.

**Scope confirmation:** `reminder_rules`/`notification_preferences`/`notifications`/`notification_deliveries`/`push_subscriptions` tables already exist fully designed (`apps/api/src/db/schema.ts:500-583`) but aren't touched by this spec at all — Spec 1 is pure infra, no reminder-domain code. `apps/api/.env.example` already has a `REDIS_URL=redis://localhost:6379` placeholder under a "Later phases (not used yet)" heading. No `bullmq`/`ioredis` dependency, no `docker-compose.yml`, and no queue/worker code exists anywhere — this is the first infra-as-code file and the first new runtime dependency since Phase 1.

**Decisions locked in (confirmed with user):**
- Local Redis via `docker-compose.yml` (this repo's first) — not assuming a pre-existing Redis install.
- The automated test suite (`npm test`) never needs a real Redis connection — mirror `apps/api/src/lib/clock.ts`'s real-vs-fake pattern (`Clock`/`systemClock`/`FakeClock`) for the queue: a small interface, a real BullMQ-backed implementation, and an in-memory fake used in every test via `deps.queue`. Verifying the real BullMQ+Redis wiring end-to-end is a manual/documented step (`docker compose up`, run the worker, observe), the same way this repo already treats Postgres (assumed-running, not spun up by the test suite).

**Architecture:** `deps.queue` joins `deps.db`/`deps.clock`/`deps.email` in the existing `Deps` injection shape (`apps/api/src/services/deps.ts`). A new `apps/api/src/worker.ts` entrypoint mirrors `server.ts`'s `Deps` construction (same `env`/`db`/`logger`/`clock`/`email`, plus the real queue) but runs a BullMQ `Worker` instead of an Express app — no HTTP server in the worker process.

## Global Constraints

- Mirror `apps/api/src/lib/clock.ts`'s exact real-vs-fake shape: a minimal `Queue` interface (just what this codebase actually needs — don't design a general-purpose abstraction beyond that), one real `BullMQQueue` implementation, one `FakeQueue` test double (constructed per-test in `apps/api/tests/helpers.ts`, same place `FakeClock` lives).
- New npm scripts follow the existing `dev:api`/`dev:web` naming convention exactly: `dev:worker` at both the `apps/api` and root `package.json` level.
- `docker-compose.yml` lives at the repo root, defines a single `redis` service, minimal (image + port mapping + no persistence needed for local dev).
- The heartbeat job writes through the EXISTING `recordAudit` (`apps/api/src/services/audit.service.ts`) rather than a new table — this spec shouldn't need a schema migration, since its only purpose is proving the pipeline works, and an audit entry is already an observable, queryable side effect.

---

### Task 1: Dependencies, docker-compose, env, npm scripts

**Files:**
- Modify: `apps/api/package.json` (add `bullmq`, `ioredis` dependencies; add `dev:worker` script)
- Modify: `package.json` (root — add `dev:worker` passthrough script)
- Create: `docker-compose.yml`
- Modify: `apps/api/.env.example` (move `REDIS_URL` out of the "later phases" heading now that it's in use; add a brief comment)

**Steps:**
- [ ] **Step 1:** Read `apps/api/package.json`'s current dependency list and `package.json`'s (root) current `scripts` block in full before editing.
- [ ] **Step 2:** Add `bullmq` and `ioredis` to `apps/api/package.json`'s dependencies (check npm for their current stable major versions at install time rather than guessing a version number).
- [ ] **Step 3:** Create `docker-compose.yml` at the repo root: one `redis` service (`image: redis:7-alpine` or similar current stable tag), port `6379:6379`, no volume (ephemeral local dev cache is fine — reminders aren't durable queue state worth persisting across a dev-machine restart at this stage).
- [ ] **Step 4:** Add `apps/api/package.json`'s `dev:worker` script: `tsx watch --env-file-if-exists=.env src/worker.ts` (mirroring the existing `dev` script's exact shape, just pointing at the new worker entrypoint instead of `server.ts`). Add the root `package.json`'s `dev:worker` passthrough: `npm run dev:worker --workspace @household/api` (mirroring `dev:api`'s existing shape).
- [ ] **Step 5:** Update `apps/api/.env.example`: move `REDIS_URL=redis://localhost:6379` out from under the "Later phases (not used yet)" heading into the active section, with a one-line comment (e.g. `# BullMQ job queue — run \`docker compose up redis\` locally`).
- [ ] **Step 6:** `npm install` at the repo root to pick up the new dependencies. `npm run build -w @household/api` to confirm nothing broke (no new code yet, this just confirms the dependency install itself didn't break the build).
- [ ] **Step 7:** Commit: `chore(api): add BullMQ/Redis dependencies, docker-compose, worker dev script`.

---

### Task 2: Queue abstraction and worker entrypoint

**Depends on:** Task 1. **Files:**
- Create: `apps/api/src/lib/queue.ts`
- Create: `apps/api/src/lib/queue.test.ts`
- Modify: `apps/api/src/services/deps.ts`
- Modify: `apps/api/src/server.ts` (construct the real queue and pass it into `Deps`)
- Create: `apps/api/src/worker.ts`
- Modify: `apps/api/tests/helpers.ts` (add `FakeQueue`, wire into the test `Deps` factory)

**Interfaces produced:** a `Queue` interface (read `apps/api/src/lib/clock.ts` first and shape this analogously — at minimum it needs an `enqueue(jobName: string, data: unknown, opts?: { repeat?: { every: number } }): Promise<void>` method; keep it to exactly what Task 3's heartbeat job needs, don't speculatively add methods), `BullMQQueue` (real implementation wrapping a BullMQ `Queue` + `Worker` pair connected via `ioredis`, reading `REDIS_URL` from `env`), `FakeQueue` (records enqueued jobs in memory, exposes them for test assertions, and — critically — exposes a way for a test to manually invoke a registered job's handler synchronously, since tests can't wait on a real BullMQ worker's async processing).

- [ ] **Step 1:** Read `apps/api/src/lib/clock.ts` and `apps/api/tests/helpers.ts`'s `FakeClock` construction in full before writing anything — this task's `Queue`/`FakeQueue` are a structural mirror. Read `apps/api/src/services/deps.ts` and `apps/api/src/server.ts` to see exactly how `email`/`clock` are constructed and threaded into `Deps` today.
- [ ] **Step 2:** Design the `Queue` interface minimally: something like `{ registerHandler(jobName: string, handler: (data: unknown) => Promise<void>): void; scheduleRepeating(jobName: string, data: unknown, everyMs: number): Promise<void> }` — a queue that can both register what a job named X does, and schedule it to run repeatedly. (This is a judgment call on exact shape — the implementer should pick whatever's cleanest given BullMQ's actual API, as long as it supports Task 3's one repeating heartbeat job and is fully fake-able in tests without a real Redis connection.)
- [ ] **Step 3:** Implement `BullMQQueue`: wraps a BullMQ `Queue` (for scheduling) and a BullMQ `Worker` (for processing) sharing one `ioredis` connection built from `env.REDIS_URL`. `registerHandler` stores handlers in a map the `Worker`'s processor function dispatches to by job name. `scheduleRepeating` adds a repeatable job via BullMQ's `repeat: { every: everyMs }` option.
- [ ] **Step 4:** Implement `FakeQueue`: `registerHandler` stores handlers in memory same as the real one; `scheduleRepeating` just records the call (job name, data, interval) in an inspectable array for test assertions — it does NOT actually schedule anything or invoke the handler on a timer (tests should never need to wait on real time). Add a test-only helper method (e.g. `runHandler(jobName, data)`) that synchronously invokes a registered handler, so a test can verify "when this job runs, X happens" without any real queue mechanics.
- [ ] **Step 5:** Add `queue: Queue` to the `Deps` type in `deps.ts`. Construct the real `BullMQQueue` in `server.ts` and thread it through, mirroring exactly how `email`/`clock` are constructed there today. Add `FakeQueue` construction to the test `Deps` factory in `helpers.ts`, mirroring `FakeClock`'s per-test construction.
- [ ] **Step 6:** Create `apps/api/src/worker.ts`: constructs the same `env`/`db`/`logger`/`clock`/`email`/`queue` (real `BullMQQueue`) as `server.ts` does, but instead of starting an Express app, just keeps the process alive (the `BullMQQueue`'s internal `Worker` is already processing jobs once constructed — this file's job is process lifecycle, not HTTP). Include a basic startup log line and graceful shutdown (SIGTERM/SIGINT closing the Redis connection cleanly) — check if `server.ts` already has a shutdown pattern to mirror.
- [ ] **Step 7:** Tests for `FakeQueue`: `registerHandler` + `runHandler` correctly invokes the registered function with the given data; `scheduleRepeating` records the call without invoking anything; calling `runHandler` for an unregistered job name throws a clear error (not a silent no-op). These tests need no real Redis. Run only `npm run test --workspace @household/api -- queue.test`.
- [ ] **Step 8:** `npm run build -w @household/api` and the targeted test command. Expect PASS. (The `BullMQQueue` real implementation won't be exercised by automated tests in this task — that's fine, consistent with the locked decision; it'll be manually verified in Task 3.)
- [ ] **Step 9:** Commit: `feat(api): BullMQ-backed queue abstraction with an in-memory test fake, worker process entrypoint`.

---

### Task 3: Heartbeat job — prove the pipeline end-to-end

**Depends on:** Task 2. **Files:**
- Create: `apps/api/src/jobs/heartbeat.job.ts`
- Create: `apps/api/src/jobs/heartbeat.job.test.ts`
- Modify: `apps/api/src/worker.ts` (register the heartbeat job and schedule it on startup)

**Steps:**
- [ ] **Step 1:** Read `apps/api/src/services/audit.service.ts`'s `recordAudit` function signature in full — the heartbeat job's only job is calling this with a distinct, easily-queryable action name.
- [ ] **Step 2:** Implement `heartbeat.job.ts`: a function `runHeartbeat(deps: Deps): Promise<void>` that calls `recordAudit` with `action: "system.heartbeat"`, a `null`/system `actorUserId` (check how `recordAudit` handles a system-triggered audit entry with no human actor — there may already be a convention for this elsewhere, e.g. a nullable actor field), and `newValue: { ranAt: deps.clock.now() }` or similar minimal payload.
- [ ] **Step 3:** In `worker.ts`, after constructing `deps`, call `deps.queue.registerHandler("heartbeat", () => runHeartbeat(deps))` and `deps.queue.scheduleRepeating("heartbeat", {}, 60_000)` (every 60 seconds — short enough to observe manually within a minute of starting the worker, this is a throwaway proof, not the real cadence any future reminder job will use).
- [ ] **Step 4:** Test `runHeartbeat` directly (not through the queue): construct a test `Deps` (with `FakeQueue`, doesn't matter here since this test calls `runHeartbeat` directly), call it, assert an audit log row with `action: "system.heartbeat"` was written with the expected shape. Run only `npm run test --workspace @household/api -- heartbeat.job.test`.
- [ ] **Step 5:** `npm run build -w @household/api` and the targeted test command. Expect PASS.
- [ ] **Step 6:** Manual end-to-end verification (document the exact steps taken and their observed output in the task's completion report, since this can't be automated per the locked decision): `docker compose up -d redis`, run any pending DB migrations if needed, start the API (`npm run dev:api`) and the worker (`npm run dev:worker`) in separate terminals, wait ~60-90 seconds, query the `audit_logs` table (or use `db:studio`) for `action = 'system.heartbeat'` rows, confirm at least 2 rows appear roughly 60 seconds apart (proving the repeat schedule actually fires against real Redis), then stop both processes and confirm `docker compose down` cleans up.
- [ ] **Step 7:** Commit: `feat(api): heartbeat job proving the queue pipeline end-to-end`.

---

## Final note

Per the user's current instruction: merge this spec to master once all 3 tasks are reviewed clean, and don't run the repo-wide `npm test` unless explicitly asked. The manual end-to-end verification in Task 3 Step 6 is a one-time proof for this spec, not a repeatable test — it does not need to be re-run for future specs once this plumbing is proven to work.
