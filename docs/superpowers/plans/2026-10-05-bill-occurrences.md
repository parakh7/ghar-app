# Bill Occurrence Generation Engine (Phase 6 Spec 2) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Regression testing per task: run only the targeted workspace's test command named in that task's steps, not the full monorepo suite.

**Goal:** Materialize `bill_occurrences` rows from a bill's recurrence rule (frequency/intervalCount/intervalUnit/firstDueDate/endDate). No payment recording and no waiving in this spec — those are Spec 3. This spec only generates/syncs the due-date schedule and lets a household correct a variable-amount bill's per-occurrence due amount before it's paid.

**Scope confirmation:** `bill_occurrences` table already exists fully designed (`apps/api/src/db/schema.ts:439-460`) — `amountDuePaise` is **NOT NULL**, unlike `bills.amountPaise` which is nullable (variable-amount bills). Unique `(billId, sequence)` index is explicitly commented "idempotent generation" — the schema was designed for exactly the upsert-by-sequence approach this plan uses. No month-add-with-clamping date utility exists anywhere yet (checked `packages/shared/src/time.ts` and the private helpers in `salary-settlement.service.ts` — neither fits; this spec writes its own).

**Decisions locked in (confirmed with user):**
- Variable-amount bills (`bills.amountPaise === null`) generate occurrences with `amountDuePaise: 0` as a placeholder; a household can edit a PENDING occurrence's due amount via a dedicated action before paying it (Spec 3 adds the actual payment recording against whatever amount is set here).
- Unbounded recurring bills (no `endDate`) get a **rolling 12-month horizon**: occurrences are generated from `firstDueDate` up to `min(endDate, today + 12 months)` if `endDate` is set, else up to `today + 12 months`. There's no background scheduler yet (that's Phase 7/BullMQ) — the horizon is extended via an idempotent sync call made automatically whenever a bill or its occurrence list is viewed, plus internally on create/update.
- Editing a bill's recurrence-relevant fields (`frequency`/`intervalCount`/`intervalUnit`/`firstDueDate`/`endDate`) **regenerates future unpaid PENDING occurrences only**: any occurrence that is `PENDING`, has `amountPaidPaise === 0`, and `dueDate` is in the future gets deleted and recomputed under the new rule (sequence numbers are recomputed fresh, not preserved). Any occurrence that is past-due, `PARTIALLY_PAID`, `PAID`, or `WAIVED` is never touched, regardless of rule changes — history is immutable.
- Occurrence generation only applies to `ACTIVE` bills. A `PAUSED` or `ARCHIVED` bill's `ensureOccurrences` call is a no-op (doesn't create new rows) — it does NOT retroactively delete already-generated future occurrences either (pause/resume/archive/unarchive don't touch occurrences at all in this spec; that interaction is deliberately out of scope to keep this spec's surface manageable).

## Global Constraints

- The recurrence-to-date-sequence mapping is a **pure function**, no DB access: `occurrenceDueDate(bill, sequence): string` computing the Nth (0-indexed) occurrence's due date directly from `frequency`/`intervalCount`/`intervalUnit`/`firstDueDate` — not an iterative "step forward one period at a time and count" walker. For day/week-based steps (`WEEKLY`, `CUSTOM` with `intervalUnit: "day"|"week"`) this is trivial date-plus-N-days arithmetic. For month-based steps (`MONTHLY`, `QUARTERLY`, `HALF_YEARLY`, `YEARLY`, `CUSTOM` with `intervalUnit: "month"`), compute the target year/month directly (`firstDueDate`'s month + `sequence * monthsPerStep`), then clamp the day-of-month to the target month's actual length — mirror the `Date.UTC(year, month, 0)` clamping trick already used in `salary-settlement.service.ts`'s `lastDayOfMonth`/`daysInMonth` (reuse the *technique*, don't import those — they're private to that file and operate on a different input shape). `monthsPerStep` is 1 (MONTHLY), 3 (QUARTERLY), 6 (HALF_YEARLY), 12 (YEARLY), or `intervalCount` (CUSTOM+month). `ONE_TIME` only ever has sequence 0, at `firstDueDate` exactly — any sequence ≥ 1 is invalid for a ONE_TIME bill and the function should make this unreachable from the generator (never called with sequence ≥ 1 for that frequency), not silently return a wrong date.
- `ensureOccurrences` must be genuinely idempotent: calling it twice in a row with the same bill state produces no changes the second time. Rely on the `(billId, sequence)` unique index as the backstop, but the service logic itself should compute "what should exist" and diff against "what does exist" rather than blindly inserting.
- Every mutation (generate, sync, amount-edit) wrapped in one transaction, with `recordAudit`, `requireHousehold` permission gating (`bills.view` for reads, `bills.manage` for every write), cross-household isolation via householdId-scoped queries — same convention as every prior phase.

---

### Task 1: Shared date-math walker, DTO, and schema

**Files:**
- Create: `packages/shared/src/bill-occurrence.ts`
- Create: `packages/shared/src/bill-occurrence.test.ts`
- Modify: `packages/shared/src/dto.ts`
- Modify: `packages/shared/src/schemas.ts`
- Modify: `packages/shared/src/index.ts`

**Interfaces produced:**
- `occurrenceDueDate(bill: Pick<BillDTO, "frequency" | "intervalCount" | "intervalUnit" | "firstDueDate">, sequence: number): string` — pure function per Global Constraints.
- `OccurrenceStatus = "PENDING" | "PARTIALLY_PAID" | "PAID" | "WAIVED"`.
- `BillOccurrenceDTO = { id, billId, sequence, dueDate, amountDuePaise, amountPaidPaise, status: OccurrenceStatus, paidAt: string | null, waivedAt: string | null, createdAt }`.
- `updateOccurrenceAmountSchema = z.object({ amountDuePaise: paiseSchema })`, export `UpdateOccurrenceAmountInput`.

**Steps:**
- [ ] **Step 1:** Read `apps/api/src/services/salary-settlement.service.ts`'s `lastDayOfMonth`/`daysInMonth`/`nextMonth` functions for the exact clamping technique to mirror (`Date.UTC(year, month, 0)` gives the last day of the *previous* 1-indexed month — i.e. passing the target month 1-indexed yields that month's own last day). Read `packages/shared/src/dto.ts`'s existing `BillDTO` and `packages/shared/src/schemas.ts`'s existing `paiseSchema` before writing.
- [ ] **Step 2:** Implement `occurrenceDueDate` in the new file:
  - `ONE_TIME`: assert `sequence === 0` (throw if not — this should be unreachable from correct caller code, treat it as a programmer error, not a user-facing validation), return `firstDueDate` unchanged.
  - `WEEKLY`: `firstDueDate + sequence * 7` days.
  - `MONTHLY`/`QUARTERLY`/`HALF_YEARLY`/`YEARLY`: compute `monthsPerStep` (1/3/6/12), target month = `firstDueDate`'s month + `sequence * monthsPerStep` (handling year rollover), day = `min(firstDueDate's day-of-month, daysInMonth(targetYear, targetMonth))`.
  - `CUSTOM`: if `intervalUnit === "day"`, `firstDueDate + sequence * intervalCount` days; if `"week"`, `firstDueDate + sequence * intervalCount * 7` days; if `"month"`, same month-based calculation as above with `monthsPerStep = intervalCount`.
- [ ] **Step 3:** Add `OccurrenceStatus`/`BillOccurrenceDTO` to `dto.ts`, `updateOccurrenceAmountSchema` to `schemas.ts`, export the new file from `index.ts`.
- [ ] **Step 4:** Tests covering: `ONE_TIME` sequence 0 returns `firstDueDate`, `ONE_TIME` sequence 1 throws; `WEEKLY` several sequences; `MONTHLY` with a day-31 anchor landing on Feb (clamped to 28/29, both leap and non-leap years) and rolling back to 31 in a 31-day month later; `QUARTERLY`/`HALF_YEARLY`/`YEARLY` each with at least one clamping case and one year-rollover case; `CUSTOM` for all three `intervalUnit` values. Run only `npm run test --workspace @household/shared`.
- [ ] **Step 5:** `npm run build -w @household/shared` and the targeted test command. Expect PASS.
- [ ] **Step 6:** Commit: `feat(shared): bill occurrence due-date calculation`.

---

### Task 2: Occurrence generation service and routes (API)

**Depends on:** Task 1. **Files:**
- Create: `apps/api/src/services/bill-occurrence.service.ts`
- Create: `apps/api/tests/bill-occurrence.test.ts`
- Modify: `apps/api/src/services/bill.service.ts` (wire `ensureOccurrences` into `createBill`/`updateBill`)
- Modify: `apps/api/src/routes/household.routes.ts`

**Interfaces produced:** `ensureOccurrences(deps, membership, bill: { id, householdId, status, frequency, intervalCount, intervalUnit, firstDueDate, endDate, amountPaise }): Promise<void>` (idempotent sync, no-op if `status !== "ACTIVE"`), `listOccurrences(deps, membership, billId, filters?: { status?, from?, to? }): Promise<BillOccurrenceDTO[]>`, `updateOccurrenceAmount(deps, actorUserId, membership, occurrenceId, input: UpdateOccurrenceAmountInput, ip?): Promise<BillOccurrenceDTO>` (only while `status === "PENDING"`).

- [ ] **Step 1:** Read `apps/api/src/services/bill.service.ts` in full (the Spec 1 file you're extending) and `apps/api/src/db/schema.ts`'s full `billOccurrences` table definition before writing anything.
- [ ] **Step 2:** Implement `ensureOccurrences`:
  - No-op if `bill.status !== "ACTIVE"`.
  - Compute `horizon = bill.endDate ? min(bill.endDate, today + 12 months) : today + 12 months` (use `dateInZone`/the household's timezone the same way `attendance.service.ts`/`salary-settlement.service.ts` derive "today").
  - Compute the needed `(sequence, dueDate)` pairs from `sequence = 0` forward via Task 1's `occurrenceDueDate`, stopping once the computed date exceeds `horizon` (for `ONE_TIME`, this is always just sequence 0, included if `firstDueDate <= horizon`).
  - Load all existing occurrences for this bill.
  - For each needed sequence: if no existing row, insert it (`amountDuePaise: bill.amountPaise ?? 0`, `status: "PENDING"`). If an existing row is `PENDING` with `amountPaidPaise === 0` and `dueDate` in the future, and its stored `dueDate`/`amountDuePaise` differ from the freshly computed values, update it in place. Otherwise (locked: `PARTIALLY_PAID`/`PAID`/`WAIVED`, or `PENDING`-but-already-past-due) leave it untouched.
  - Delete any existing occurrence whose sequence is outside the needed range (beyond the new horizon, or past where the rule now stops) **only if** it's still `PENDING` with `amountPaidPaise === 0` and `dueDate` in the future — never delete a locked or past-due row.
  - Wrap in one transaction; `recordAudit` once per call summarizing the net change (counts of inserted/updated/deleted), not once per row.
- [ ] **Step 3:** Wire `ensureOccurrences` into `bill.service.ts`'s `createBill` (call it right after insert, with the newly created bill) and `updateBill` (call it after persisting, only if the patch touched `frequency`/`intervalCount`/`intervalUnit`/`firstDueDate`/`endDate` — reuse whatever "configTouched"-style check `updateBill` already has from Spec 1's frequency-revalidation logic).
- [ ] **Step 4:** Implement `listOccurrences` (household+bill scoped, optional status/date-range filters) and `updateOccurrenceAmount` (validates `status === "PENDING"`, else `Errors.validation`; updates `amountDuePaise`; `recordAudit`).
- [ ] **Step 5:** Routes in `household.routes.ts`:
  - `GET /:householdId/bills/:id/occurrences?status=&from=&to=` (`bills.view`) → `listOccurrences`
  - `POST /:householdId/bills/:id/occurrences/sync` (`bills.view` — this is a read-triggered refresh, not a destructive write a casual viewer should be blocked from; reconsider to `bills.manage` if you think a pure "make the list current" action should require the stricter permission, your call, document the reasoning either way) → `ensureOccurrences` then `listOccurrences`
  - `PATCH /:householdId/bills/:id/occurrences/:occurrenceId` (`bills.manage`) → `updateOccurrenceAmount`
- [ ] **Step 6:** Tests: generation for each frequency (correct count/dates within a bounded horizon), `ONE_TIME` generates exactly one occurrence ever (calling sync again doesn't add a second), variable-amount bill generates `amountDuePaise: 0`, editing a bill's frequency regenerates future PENDING-unpaid occurrences but leaves a manually-set past/paid/waived one untouched (set one up directly via DB insert to simulate a "locked" occurrence, since payment-setting isn't built until Spec 3), `endDate` shortened deletes now-out-of-range future PENDING occurrences, `PAUSED`/`ARCHIVED` bill's sync is a no-op, `updateOccurrenceAmount` rejects when occurrence isn't PENDING, cross-household isolation, permission gating. Targeted test run only.
- [ ] **Step 7:** `npm run build -w @household/api` and the targeted test command. Expect PASS.
- [ ] **Step 8:** Commit: `feat(api): bill occurrence generation and sync`.

---

### Task 3: Web — occurrence list on bill detail

**Depends on:** Task 2. **Files:**
- Modify: `apps/web/src/features/app/bills/BillDetailPage.tsx`
- Modify: `apps/web/src/features/app/bills/useBills.ts`
- Create: `apps/web/src/features/app/bills/BillDetailPage.test.tsx` additions (extend existing file, don't create a new one — check it already exists from Spec 1)

- [ ] **Step 1:** Read `apps/web/src/features/app/bills/BillDetailPage.tsx` and `useBills.ts` (both from Spec 1) in full before editing.
- [ ] **Step 2:** Add hooks to `useBills.ts`: `useOccurrences(householdId, billId)` (query, triggers the sync endpoint first via its `queryFn` or a combined mutation+query pattern — check how this codebase's existing pages handle "refresh then read" if a precedent exists, otherwise a straightforward `useEffect`-on-mount sync-then-invalidate is fine) and `useUpdateOccurrenceAmount(householdId, billId)` (mutation).
- [ ] **Step 3:** Add an occurrence list section to `BillDetailPage.tsx` — due date, amount (via `formatINR`), status badge (reuse/extend the existing `statusTone.ts` pattern for `OccurrenceStatus`), and for variable-amount bills (`bill.amountPaise === null`) a small inline "set amount" action on each `PENDING` occurrence, gated on `bills.manage`.
- [ ] **Step 4:** Extend `BillDetailPage.test.tsx` with coverage for: occurrence list renders, set-amount flow, permission gating on the set-amount action.
- [ ] **Step 5:** `npm run build -w @household/web && npm run typecheck -w @household/web`, then `npm run test --workspace @household/web` (targeted). Expect PASS.
- [ ] **Step 6:** `npm run lint`. Expect PASS.
- [ ] **Step 7:** Commit: `feat(web): bill occurrence list and due-amount editing`.

---

## Final note

Per the user's current instruction: merge this spec to master once all 3 tasks are reviewed clean (don't wait for a separate full-suite gate), and don't run the repo-wide `npm test` unless explicitly asked — targeted per-task tests and the standard task/final review process are what gate each merge.
