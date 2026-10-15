# Dual-Mode Job Runner (BullMQ or HTTP+Cron) — Design Spec

**Status:** Approved.

## Context

The three scheduled jobs (`heartbeat`, `evaluate-reminders`, `dispatch-email-deliveries`) only ever
run via BullMQ's repeating-job scheduler, consumed by a dedicated `worker.ts` process. That process
needs somewhere to run continuously — fine on a paid host, but Render's free tier only offers free
*web services*, not free background workers, and the BullMQ `Queue` interface in this codebase
(`apps/api/src/lib/queue.ts`) is confirmed used only for this scheduled-repeat purpose (grepped: no
route/service calls `deps.queue.add` for on-demand work). That makes an external-cron-triggered HTTP
endpoint a viable, lower-cost alternative for deployments that don't want to pay for a worker — with
weaker timing guarantees than BullMQ, acceptable for a personal household app where "reminders fire
within a few minutes of schedule, not to the second" is fine.

## Design

**Config** (`apps/api/src/config/env.ts`):
- `JOB_RUNNER: z.enum(["bullmq", "http"]).default("bullmq")` — default preserves every existing
  deployment's behavior unchanged.
- `JOBS_SECRET: z.string().optional()`, required (via `superRefine`, same pattern as the existing
  `EMAIL_FROM`/`RESEND_API_KEY` guards) when `JOB_RUNNER === "http"`.

**New endpoint** `POST /api/internal/run-jobs`, registered only when `env.JOB_RUNNER === "http"`:
- Requires header `x-jobs-secret` matching `env.JOBS_SECRET`; `401` otherwise.
- An in-memory "already running" flag prevents overlapping executions if a cron hit lands while a
  previous run is still in progress — returns `202` with `{ skipped: true }` in that case rather
  than starting a second concurrent run.
- Otherwise runs `runHeartbeat`, `runEvaluateReminders`, `runDispatchEmailDeliveries` (the same
  functions `worker.ts` already calls) sequentially against the server's own `deps`. Each is
  wrapped individually — one throwing doesn't stop the others, matching how independent BullMQ jobs
  already fail independently of each other. Responds `200` with a per-job summary
  (`{ ran: [{ name, ok, error? }] }`).
- Runs all three jobs on every hit regardless of their original BullMQ intervals (1 min / 1 hour /
  5 min) — each job's own logic is idempotent-safe to run more often than originally scheduled, and
  a single external cron is far simpler to operate than three separately-scheduled ones. The
  operator picks one interval (recommended: every 5-15 minutes) for their external cron.

**`server.ts`:** when `JOB_RUNNER === "http"`, constructs `deps.queue` as `FakeQueue` (already exists
in `queue.ts`, currently test-only — a true no-op, confirmed nothing outside `server.ts`/`worker.ts`
touches `deps.queue`) instead of `BullMQQueue`, and registers the new route. When `JOB_RUNNER ===
"bullmq"` (default), behavior is byte-for-byte identical to today.

**`worker.ts`:** when `JOB_RUNNER !== "bullmq"`, logs a warning and exits immediately rather than
starting a BullMQ worker that nothing will ever schedule into — guards against someone deploying the
dedicated worker process by mistake alongside `http` mode.

## Testing

- `env.test.ts`: `JOBS_SECRET` required when `JOB_RUNNER=http`, both providers' defaults unaffected.
- New `internal.routes.test.ts`: rejects a missing/wrong secret, runs all three jobs on a valid
  request, returns `{ skipped: true }` for a second concurrent request while the first is still
  running, and isolates one job's thrown error from the other two still completing.
- No changes needed to existing `heartbeat.job.test.ts` or the other job tests — the job functions
  themselves are unchanged, only how they get invoked.

## Out of scope

- Removing Redis/BullMQ as dependencies entirely — this spec adds the alternative mode, it doesn't
  remove the existing one. A future spec could drop `bullmq`/`ioredis` if `http` mode becomes the
  only one anyone uses, but that's a bigger, separate decision.
- Persisting "last run" timestamps anywhere (DB/Redis) — the in-memory overlap guard is sufficient
  for a single-instance deployment and resets harmlessly on restart.
