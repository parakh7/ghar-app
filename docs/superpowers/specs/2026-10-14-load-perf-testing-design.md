# Load & Performance Testing — Design Spec

**Phase:** 10 (Security review, load/perf testing, production hardening) — Spec 3 of 3. Final spec of the entire 10-phase roadmap.

**Status:** Approved.

## Context

No load/perf testing exists anywhere in this codebase. This environment turns out to have Docker + a reachable local Redis container + a reachable local Postgres — richer than an earlier session's "no Docker available" note assumed (that memory is stale and gets corrected alongside this spec). That means a real load test against a real running instance of the API is possible here, not just a manual-steps document for the user to run later.

## Scope

**Setup:**
- A dedicated throwaway database, `household_loadtest`, created and migrated fresh for this test run, dropped afterward. Never touches `household_dev` or `household_test`.
- Minimal seed data: one household, one user (for login), a handful of househelps and checklist tasks — enough to exercise the target endpoints meaningfully, not a full demo dataset.
- The real API server, started via `tsx` directly (not the watch-mode `npm run dev` script) pointed at `household_loadtest` via env vars, run as a background process for the duration of the test, then stopped.
- `autocannon` (confirmed available via `npx`, zero new project dependency) as the load-generating tool.

**Scenarios — three separate runs, not mixed together, each 50 concurrent connections for 30 seconds:**
1. **Read-heavy:** `GET /api/households/:id/today` and `GET /api/households/:id/search?q=...` — pure reads, side-effect-free, safe to repeat indefinitely.
2. **Write-heavy:** the one-tap daily actions — `PUT` attendance mark and `PUT` checklist completion mark.
3. **Auth:** `POST /api/auth/login` — deliberately isolated from the other two since argon2id hashing is CPU-bound, unlike the DB-bound read/write scenarios.

A single login happens once before the read/write scenarios to obtain a session cookie, reused across their requests (consistent with how every other authenticated flow in this app works — cookie-based sessions, not per-request credentials).

**Thresholds:**
- Read-heavy and write-heavy: p95 latency under 200ms, zero errors (connection failures or 5xx responses) across the full 30-second run.
- Auth: no pre-set latency bar — argon2id is deliberately expensive by design (the README documents its exact cost parameters: m=19MiB, t=2, p=1). This scenario's job is to report real numbers (p95, throughput, error count) and flag only genuine problems (errors, or latency climbing without bound as the run progresses), not to hold it to the same bar as the DB-bound scenarios.

**Output:** a written report at `docs/performance/2026-10-14-load-test.md` — each scenario's latency percentiles (p50/p95/p99), requests/sec throughput, and error count, plus any bottleneck findings.

**Fix policy (same as the security review spec):** a finding with an obvious, low-risk fix (e.g., a missing database index revealed by slow query timing) gets fixed and the affected scenario re-measured as part of this spec. A finding that would need a larger design change gets documented only, not fixed now.

**Explicitly out of scope:** the reminder/notification background jobs' own throughput (BullMQ job processing, not an HTTP endpoint — a different kind of load test with its own separate concerns, not in scope here). Load-testing the web frontend's bundle/render performance (this spec is API-only).

## Testing

This spec's "testing" is the load test itself — there's no separate automated test suite for a load-testing script. The throwaway database and seed script get a quick manual sanity check (a few curl requests against the started server) before running the actual `autocannon` scenarios, to confirm the setup is correct before generating load.
