# Salary Calculation, Settlement, Payments (Phase 5) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Regression testing per task: run only the targeted workspace's test command named in that task's steps, not the full monorepo suite — the full suite runs once, after merge.

**Goal:** Monthly salary settlement generation, bonus/deduction adjustments, and payment recording for househelps. All three DB tables (`salary_settlements`, `salary_adjustments`, `salary_payments`) already exist and are fully designed (`apps/api/src/db/schema.ts:316-388`) — this plan is 100% greenfield above the schema layer (no service/route/UI exists yet). Per-househelp salary config (`salaryMode`, `monthlySalaryPaise`, `dailyRatePaise`, `halfDayRatePaise`, `salaryDueDay`) is already captured via the existing househelp create/update API — not touched here. Permissions `salaries.view`/`salaries.manage`/`salaries.pay` already exist in `packages/shared/src/permissions.ts` — no new permission needed.

**Decisions locked in (confirmed with user, or reasoned through where the schema/docs left a genuine gap):**
- **Absence deduction**: `ABSENT` reduces pay; `LEAVE` and `HOLIDAY` do not. A `HALF_DAY` deducts half a day's rate (or pays `halfDayRatePaise` directly, depending on mode — see below).
- **Settlement lifecycle**: a `PENDING` settlement can be regenerated (re-run the calc from current attendance) as many times as needed. The instant any `salary_payments` row exists against it (status becomes `PARTIALLY_PAID` or `PAID`), the base calc locks — further corrections go through `salary_adjustments`, never a regenerate.
- **Adjustments**: can be created any time, with `settlementId: null` (schema already supports this). Generating/regenerating a settlement for a `(househelpId, periodMonth)` pulls in every unattached, non-voided adjustment for that same `(househelpId, periodMonth)` and attaches it (sets `settlementId`).
- **Payments**: partial payments are supported. `amountPaidPaise` is the running sum of non-voided `salary_payments`; status is derived (`PENDING` when 0 paid, `PARTIALLY_PAID` when `0 < paid < netPayablePaise`, `PAID` when `paid >= netPayablePaise`).
- **`salaryMode` semantics** (not documented anywhere before this plan — reasoned through since the schema has three distinct values that must mean three different things, and this reading is the only one that makes all three non-redundant and consistent with the absence-deduction decision above):
  - `FIXED_MONTHLY`: `basePaise = monthlySalaryPaise`, full stop — attendance is irrelevant, no deduction ever, regardless of `absentDays`.
  - `ATTENDANCE_BASED`: `basePaise = monthlySalaryPaise`, but `absenceDeductionPaise = prorate(monthlySalaryPaise, absentDays, workingDays) + prorate(monthlySalaryPaise, halfDays, workingDays * 2)` (a half-day deducts half of one working-day's share).
  - `DAILY_RATE`: no monthly concept at all — `basePaise = presentDays * dailyRatePaise + halfDays * (halfDayRatePaise ?? prorate(dailyRatePaise, 1, 2))`. `absenceDeductionPaise` stays 0 (there's nothing to deduct from — absent days simply aren't paid, which is already baked into only counting present/half days).
  - If the relevant rate field for the househelp's configured mode is missing (`null`) when generating a settlement, generation must fail with a clear validation error — the existing househelp schema never enforced mode-conditional field presence, so this plan's generation step is where that gets caught.
- **Unmarked attendance**: if any of the househelp's scheduled days in `periodMonth` have no attendance record at all (never marked present/absent/etc.), settlement generation must refuse with a validation error naming the count of unmarked days, rather than silently treating them as present or absent. The user marks them via the existing attendance UI, then regenerates.
- **`workingDays`** = count of days in `periodMonth` where the househelp's `attendance_schedules` weekday lookup matches (same weekly-schedule join `attendance.service.ts`'s `getToday`/`getMonthAttendance` already use) — a status of `HOLIDAY` on a scheduled day does not remove it from `workingDays` and does not count as absent (it's paid, per the decision above).
- Settlements can only be generated for a month that has fully elapsed (`periodMonth`'s last day `< today` in the household's timezone) — never the current or a future month.

**Architecture:** `packages/shared` (DTOs + input schemas) → `apps/api` (3 services: settlement generation/calc, adjustments, payments — all consuming attendance data the same way `attendance.service.ts` already does) → `apps/web` (hooks + 2 pages: a per-household salaries list, and a settlement detail page with adjustments/payment recording).

## Global Constraints

- All money math goes through `packages/shared/src/money.ts`'s existing `prorate`/`sumPaise`/`assertPaise` — never hand-rolled arithmetic on paise. `prorate`'s docstring literally names absence deductions as its intended use.
- Mirror `apps/api/src/services/attendance.service.ts`'s conventions throughout: `requireHousehold(deps, permission)` route gating, cross-household isolation via composite foreign keys + householdId-scoped queries (never trust a URL param alone), `recordAudit` inside the same transaction as the mutating write, `Errors.validation`/`Errors.forbidden`/`Errors.notFound` from `apps/api/src/lib/errors.js`.
- Permission mapping: generating/regenerating a settlement and creating/voiding an adjustment both need `salaries.manage`. Recording/voiding a payment needs `salaries.pay` (already granted to `MEMBER` by default). Viewing needs `salaries.view` (already in the `VIEW` group, granted to everyone including `VIEWER`).
- Every write (generate, regenerate, adjustment create/void, payment record/void) happens inside one DB transaction per operation, same as `attendance.service.ts`'s `markHoliday`/`setAttendance`.
- Reuse `apps/api/src/services/attendance.service.ts`'s `isoWeekdayOf`-style date math and its existing schedule-join query shape (`attendanceSchedules` filtered by `effectiveFrom`/`effectiveTo` bracketing the target date) — don't reinvent the weekday/schedule logic, extend it to a whole-month count instead of a single day.

---

### Task 1: Shared types and input schemas

**Files:**
- Modify: `packages/shared/src/dto.ts`
- Modify: `packages/shared/src/schemas.ts`
- Create: `packages/shared/src/salary-calc.test.ts` *(pure-function tests only — see Step 3; no new pure-logic file is needed beyond what's being tested inline in Task 2, so this test file may end up unnecessary; see note in Step 3)*

**Interfaces produced:**
- `SettlementStatus = "PENDING" | "PARTIALLY_PAID" | "PAID" | "CANCELLED"`, `AdjustmentType = "BONUS" | "OVERTIME" | "DEDUCTION" | "ADVANCE" | "ADJUSTMENT"` (match the DB enums `settlement_status`/`salary_adjustment_type` in `schema.ts:40-41`).
- `SettlementDTO = { id, househelpId, periodMonth, dueDate, basePaise, workingDays, presentDays, halfDays, absentDays, leaveDays, absenceDeductionPaise, additionsPaise, deductionsPaise, advancePaise, netPayablePaise, amountPaidPaise, status, note, paidAt }`.
- `AdjustmentDTO = { id, househelpId, settlementId: string | null, periodMonth, type, amountPaise, reason, voidedAt: string | null, createdAt }`.
- `SalaryPaymentDTO = { id, settlementId, amountPaise, paidOn, method, reference, notes, voidedAt: string | null, createdAt }`.
- `generateSettlementSchema = z.object({ periodMonth: z.string().regex(/^\d{4}-\d{2}-01$/, "First of the month, YYYY-MM-01") })` — export `GenerateSettlementInput`.
- `createAdjustmentSchema = z.object({ periodMonth: dateSchema, type: z.enum(["BONUS","OVERTIME","DEDUCTION","ADVANCE","ADJUSTMENT"]), amountPaise: paiseSchema, reason: z.string().trim().max(500).optional() })` (reuse the existing `paiseSchema`/`dateSchema` already defined in this file for other money/date fields) — export `CreateAdjustmentInput`.
- `recordPaymentSchema = z.object({ amountPaise: paiseSchema.refine((v) => v > 0, "Amount must be positive"), paidOn: dateSchema, method: z.enum(["CASH","UPI","BANK_TRANSFER","CARD","AUTO_DEBIT","CHEQUE","OTHER"]), reference: z.string().trim().max(200).optional(), notes: z.string().trim().max(500).optional() })` — export `RecordPaymentInput`.

**Steps:**
- [ ] **Step 1:** Read `packages/shared/src/dto.ts`'s existing `HousehelpDTO`/`AttendanceRecordDTO` block and `packages/shared/src/schemas.ts`'s existing `paiseSchema`/`dateSchema` definitions (used by `createBillSchema`-adjacent or `createHousehelpSchema` — find wherever `paiseSchema` is already defined in this file) before writing, so the new types/schemas sit in the same style.
- [ ] **Step 2:** Add the DTOs and enums above to `dto.ts`.
- [ ] **Step 3:** Add the three schemas above to `schemas.ts`. **Note on the test file in Files list above:** if, after writing Steps 1-2, nothing in this task is a genuinely pure function worth unit-testing in isolation (the three schemas are simple enough that a round-trip parse test may be all that's warranted, or may not be worth a dedicated file at all) — use judgment; don't create `salary-calc.test.ts` if there's nothing substantive to put in it. The real calculation logic (and its tests) belongs in Task 2, where it has DB-sourced inputs to test against.
- [ ] **Step 4:** Export everything new from `index.ts`.
- [ ] **Step 5:** `npm run build -w @household/shared && npm run test --workspace @household/shared`. Expect PASS.
- [ ] **Step 6:** Commit: `feat(shared): salary settlement/adjustment/payment types and schemas`.

---

### Task 2: Settlement generation + calculation engine (API)

**Depends on:** Task 1. **Files:**
- Create: `apps/api/src/services/salary-settlement.service.ts`
- Create: `apps/api/tests/salary-settlement.test.ts`
- Modify: `apps/api/src/routes/household.routes.ts`

**Interfaces produced:** `generateSettlement(deps, actorUserId, membership, househelpId, input: GenerateSettlementInput, ip?): Promise<SettlementDTO>` (creates if none exists for the period, regenerates in place if one exists and is still `PENDING`, throws if the existing one is `PARTIALLY_PAID`/`PAID`/`CANCELLED`), `listSettlements(deps, membership, househelpId?, filters?): Promise<SettlementDTO[]>`, `getSettlement(deps, membership, settlementId): Promise<SettlementDTO & { adjustments: AdjustmentDTO[]; payments: SalaryPaymentDTO[] }>`.

- [ ] **Step 1:** Read `apps/api/src/services/attendance.service.ts` in full — this task's month-wide schedule/attendance queries extend its single-day patterns (`getToday`'s schedule join, `getMonthAttendance`'s date-range query) to a whole-month count. Read `apps/api/src/services/money` usage elsewhere if any exists (check `salaries`/`bills` — likely none yet, this may be the first consumer of `prorate` outside `money.test.ts`). Read `packages/shared/src/money.ts`'s `prorate`/`sumPaise` signatures (already shown in this plan's Global Constraints) before writing the calc.
- [ ] **Step 2:** Write a month-wide attendance aggregation query: for a given `householdId`/`househelpId`/`periodMonth`, compute `workingDays` (count of this month's calendar days where the househelp's active schedule's weekday list includes that day's ISO weekday — reuse `attendance.service.ts`'s schedule-join `and/or/lte/gte` shape, applied per-day across the month rather than for a single date), and `presentDays`/`halfDays`/`absentDays`/`leaveDays`/`holidayDays` (counts grouped by `attendanceRecords.status` for that househelp within the month's date range). Also compute the set of scheduled days with NO attendance record at all (`workingDays` minus every day that has a record of any status) — if non-empty, this is the "unmarked days" validation failure described in Global Constraints.
- [ ] **Step 3:** Implement the three-mode base-pay calculation exactly as specified in Global Constraints' `salaryMode` semantics bullet, reading the househelp's `salaryMode`/`monthlySalaryPaise`/`dailyRatePaise`/`halfDayRatePaise` from the `househelps` table. Validate the mode's required rate field is non-null before computing — throw `Errors.validation` naming the missing field if not.
- [ ] **Step 4:** `generateSettlement`: look up any existing settlement for `(househelpId, periodMonth)`. If none exists, compute everything above and insert a new row with `status: "PENDING"`, `additionsPaise`/`deductionsPaise`/`advancePaise` computed by summing unattached (`settlementId IS NULL`), non-voided `salary_adjustments` for this `(householdId, househelpId, periodMonth)` by type (`BONUS`+`OVERTIME` → additions, `DEDUCTION` → deductions, `ADVANCE` → advance, `ADJUSTMENT` → net-signed, added to whichever of additions/deductions matches its sign), then attach those adjustment rows to the new settlement (`UPDATE ... SET settlement_id = ...`) inside the same transaction. `netPayablePaise = basePaise - absenceDeductionPaise + additionsPaise - deductionsPaise - advancePaise`. Store `calcSnapshot` as a JSON blob of every input used (workingDays, day counts, rates, mode) — this is what the column exists for, per the schema's own comment. If a settlement already exists and is `PENDING`, re-run the same calc and update the row in place (also re-sweeping any newly-created unattached adjustments since the first generation). If it exists and is `PARTIALLY_PAID`/`PAID`/`CANCELLED`, throw `Errors.validation` — regeneration is blocked, per the locked decision.
- [ ] **Step 5:** `listSettlements`/`getSettlement`: straightforward reads, household-scoped, `getSettlement` also returns its linked adjustments and payments.
- [ ] **Step 6:** Routes in `household.routes.ts`, grouped near (not inside) the `salaries.*`-gated existing househelp routes:
  - `POST /:householdId/househelps/:id/salary/settlements` → `requireHousehold(deps, "salaries.manage")` → `generateSettlement`
  - `GET /:householdId/househelps/:id/salary/settlements` → `requireHousehold(deps, "salaries.view")` → `listSettlements`
  - `GET /:householdId/salary/settlements/:settlementId` → `requireHousehold(deps, "salaries.view")` → `getSettlement`
- [ ] **Step 7:** Tests covering: FIXED_MONTHLY (no deduction regardless of absences), ATTENDANCE_BASED (absence prorate math — hand-verify one concrete example, e.g. ₹10,000 base / 26 working days / 2 absent days), DAILY_RATE (present×rate + half×halfRate, no monthly figure), unmarked-days rejection, regeneration allowed while PENDING, regeneration blocked once a payment exists, missing-rate-field validation error, adjustment auto-attachment on generation, cross-household isolation, future/current-month rejection. Run only `npm run test --workspace @household/api` (or the equivalent single-file invocation) for this task's new file, not the full suite.
- [ ] **Step 8:** `npm run build -w @household/api` and the targeted test command. Expect PASS.
- [ ] **Step 9:** Commit: `feat(api): salary settlement generation and calculation engine`.

---

### Task 3: Adjustments and payments (API)

**Depends on:** Task 2 (settlements must exist for payments to attach to; adjustments can pre-date a settlement but the attach-on-generate logic from Task 2 is already in place). **Files:**
- Create: `apps/api/src/services/salary-adjustment.service.ts`
- Create: `apps/api/src/services/salary-payment.service.ts`
- Create: `apps/api/tests/salary-adjustment.test.ts`
- Create: `apps/api/tests/salary-payment.test.ts`
- Modify: `apps/api/src/routes/household.routes.ts`

**Interfaces produced:** `createAdjustment(deps, actorUserId, membership, househelpId, input: CreateAdjustmentInput, ip?): Promise<AdjustmentDTO>`, `voidAdjustment(deps, actorUserId, membership, adjustmentId, ip?): Promise<void>`, `recordPayment(deps, actorUserId, membership, settlementId, input: RecordPaymentInput, ip?): Promise<SalaryPaymentDTO>` (also recomputes and persists the settlement's `amountPaidPaise`/`status`/`paidAt` in the same transaction), `voidPayment(deps, actorUserId, membership, paymentId, ip?): Promise<void>` (same recompute, in reverse).

- [ ] **Step 1:** `createAdjustment`: insert with `settlementId: null` if no settlement exists yet for `(househelpId, periodMonth)`, or attach directly to an existing one (looked up the same way Task 2 does) if it does — but only if that settlement is still `PENDING` (an already-paid settlement's totals are locked; a new adjustment for that period should stay unattached until... actually since regeneration is blocked once paid, a late adjustment against an already-settled period has nowhere to attach — insert it unattached regardless of the target settlement's status, and leave attaching it to a human decision (a future settlement for a correction, or manual handling) — don't silently attach to a locked settlement's totals).
- [ ] **Step 2:** `voidAdjustment`: sets `voidedAt`, only if not already voided; if the adjustment is attached to a still-`PENDING` settlement, that settlement should be regenerated (recompute totals) in the same transaction — if attached to a locked (paid) settlement, voiding is still allowed (the adjustment stops counting for future reference) but does NOT retroactively change that settlement's locked totals.
- [ ] **Step 3:** `recordPayment`: validate the settlement isn't `CANCELLED`, validate the new payment doesn't push `amountPaidPaise` past `netPayablePaise` (reject overpayment — `Errors.validation`), insert the payment row, recompute `amountPaidPaise` (`sumPaise` of all non-voided payments for this settlement) and derive `status`/`paidAt` per the locked decision (`paidAt` set on first transition to `PAID`, cleared if voided back below `PAID`).
- [ ] **Step 4:** `voidPayment`: sets `voidReason`/`voidedAt`, recomputes `amountPaidPaise`/`status`/`paidAt` the same way, in the opposite direction.
- [ ] **Step 5:** Routes:
  - `POST /:householdId/househelps/:id/salary/adjustments` → `requireHousehold(deps, "salaries.manage")` → `createAdjustment`
  - `DELETE /:householdId/salary/adjustments/:adjustmentId` → `requireHousehold(deps, "salaries.manage")` → `voidAdjustment` (soft-delete via voidedAt, mirroring the existing void pattern on payments/adjustments tables — not a hard delete)
  - `POST /:householdId/salary/settlements/:settlementId/payments` → `requireHousehold(deps, "salaries.pay")` → `recordPayment`
  - `DELETE /:householdId/salary/payments/:paymentId` → `requireHousehold(deps, "salaries.pay")` → `voidPayment`
- [ ] **Step 6:** Tests: adjustment create (attached vs. unattached), void with/without a PENDING settlement to recompute, overpayment rejection, partial payment → `PARTIALLY_PAID`, full payment → `PAID` + `paidAt` set, void payment reverses status, cross-household isolation on all four operations. Targeted test run only (this task's two new test files).
- [ ] **Step 7:** `npm run build -w @household/api` and the targeted test commands. Expect PASS.
- [ ] **Step 8:** Commit: `feat(api): salary adjustments and payment recording`.

---

### Task 4: Web — salary pages and hooks

**Depends on:** Task 3. **Files:**
- Create: `apps/web/src/features/app/salary/useSalary.ts`
- Create: `apps/web/src/features/app/salary/SalaryListPage.tsx`
- Create: `apps/web/src/features/app/salary/SettlementDetailPage.tsx`
- Modify: `apps/web/src/App.tsx`
- Modify: `apps/web/src/features/app/HomePage.tsx` *(the Salaries card already exists as a placeholder empty-state — point it at real data/routing now that it's real; narrow change only, don't touch the other 3 cards)*

- [ ] **Step 1:** Read `apps/web/src/features/app/attendance/useAttendance.ts` and one of the already-shipped list+detail page pairs (e.g. `apps/web/src/features/app/checklist/ChecklistListPage.tsx` + `ChecklistTaskDetailPage.tsx`) for this codebase's established list→detail navigation and hook-file shape; mirror it rather than inventing a new structure.
- [ ] **Step 2:** `useSalary.ts`: hooks for listing settlements per househelp, generating/regenerating a settlement, fetching one settlement's detail (with adjustments/payments), creating/voiding an adjustment, recording/voiding a payment — same query-key + invalidation shape as `useAttendance.ts`/`useChecklistCompletion.ts`.
- [ ] **Step 3:** `SalaryListPage.tsx`: per-househelp list of settlements by month with status badges (reuse the existing `badge`/`badge--*` CSS classes and this codebase's status-tone-mapping convention — add a `settlementStatusTone` mapping like `statusTone.ts`'s `toneOf`), a "Generate settlement" action for the current household's households, honoring `salaries.manage` permission gating for the generate action (same `canX` boolean pattern as every other page in this codebase).
- [ ] **Step 4:** `SettlementDetailPage.tsx`: shows the full breakdown (base, deduction, additions, net payable, paid-so-far, balance remaining), lists adjustments and payments, a "Record payment" form (amount/date/method/reference), an "Add adjustment" form (type/amount/reason) — both gated behind their respective permissions.
- [ ] **Step 5:** Route wiring in `App.tsx` for the list and detail pages (check how `HousehelpCalendarPage`'s nested `:id` route is wired for the pattern — a settlement detail page nested similarly).
- [ ] **Step 6:** Wire `HomePage.tsx`'s existing "Salaries" card (currently a hardcoded `EmptyState`) to real data — show something real when settlements exist (e.g. the nearest unpaid/upcoming settlement), keep the existing `EmptyState` as the true empty case (no settlements yet at all). This is the first of Home's four placeholder cards to get real data — the other three (Househelp, Today's work, Payments) stay untouched, out of scope for this plan.
- [ ] **Step 7:** Tests for both new pages (render, generate action, record-payment flow, permission gating) mirroring this codebase's existing page-test shape and depth.
- [ ] **Step 8:** `npm run build -w @household/web && npm run typecheck -w @household/web`, then `npm run test --workspace @household/web` (targeted). Expect PASS.
- [ ] **Step 9:** `npm run lint`. Expect PASS.
- [ ] **Step 10:** Commit: `feat(web): salary settlement, adjustment, and payment pages`.

---

## Final note

After Task 4 merges: run the full monorepo suite once (`npm test` at the repo root) and rebuild `packages/shared`'s dist (`npm run build -w @household/shared`) in the main checkout — this repo's established stale-dist gotcha for anything touching the shared package.
