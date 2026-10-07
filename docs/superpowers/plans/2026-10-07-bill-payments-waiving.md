# Bill Payments and Waiving (Phase 6 Spec 3) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Regression testing per task: run only the targeted workspace's test command named in that task's steps, not the full monorepo suite.

**Goal:** Record (and void) payments against a bill occurrence, and waive (and unwaive) an occurrence that doesn't need to be paid. `bill_payments` already exists fully designed (`apps/api/src/db/schema.ts` — search `billPayments`) as a close structural sibling of the already-shipped `salary_payments`/`salary-payment.service.ts`, and `bill_occurrences.status` already has `WAIVED` in its enum (`PENDING`/`PARTIALLY_PAID`/`PAID`/`WAIVED`) with `waivedAt`/`waivedByUserId` columns already present on the table — this spec is the first thing to actually write to them. `payments.record` and `bills.manage` permissions already exist.

**Decisions locked in (confirmed with user):**
- Waiving only applies to a `PENDING` occurrence — once any payment is recorded (`PARTIALLY_PAID`), waiving is blocked; void the payment first if the remaining balance shouldn't be collected.
- Waiving/unwaiving is gated on `bills.manage` (a household-management decision), not `payments.record` — distinct from recording a payment, which stays on `payments.record` (already granted to `MEMBER` by default, matching salary payments' permission split).
- Recording a payment against a `WAIVED` occurrence is rejected, mirroring how `recordPayment` already rejects a `CANCELLED` salary settlement.
- Overpayment is rejected the same way salary payments already do: a new payment that would push `amountPaidPaise` past the occurrence's `amountDuePaise` is `Errors.validation`. (This also means a variable-amount occurrence still sitting at the Spec 2 placeholder `amountDuePaise: 0` cannot accept any payment until its real amount is set via the existing `updateOccurrenceAmount` action — a natural consequence of reusing the same guard, not a new rule.)

**Architecture:** `apps/api/src/services/salary-payment.service.ts` is the exact pattern to mirror for `bill-payment.service.ts` — same recompute-from-source-of-truth design (`recomputeSettlementPaymentTotals`'s equivalent re-sums every non-voided payment for the occurrence and persists the derived `amountPaidPaise`/`status`/`paidAt`, never incremental). Waiving has no salary equivalent — it's new, but follows the same status-machine-with-explicit-action-endpoints shape Spec 1 already established for bills (`pauseBill`/`resumeBill`/`archiveBill`/`unarchiveBill`).

## Global Constraints

- Mirror `apps/api/src/services/salary-payment.service.ts` function-for-function: `recordPayment` locks the occurrence row (`.for("update")`), rejects if `status === "WAIVED"`, computes `prospectivePaidPaise` and rejects overpayment against `amountDuePaise`, inserts the payment, then recomputes-and-persists the occurrence's `amountPaidPaise`/`status`/`paidAt` in the same transaction. `voidPayment` soft-deletes (`voidedAt`/`voidReason`) and recomputes in reverse. The recompute function is the single source of truth for `status`/`amountPaidPaise`/`paidAt` — never set these fields anywhere else.
- `bill_payments`'s field names differ slightly from `salary_payments`: `transactionRef` (not `reference`), two FKs (`billId` AND `occurrenceId`, not one `settlementId`) — get these exactly right from the schema, don't assume they match salary's naming.
- Waive/unwaive are explicit action endpoints (no body beyond an optional reason), not a general PATCH — mirror the existing `pauseBill`/`resumeBill` action-endpoint shape. `waiveOccurrence` only succeeds from `PENDING`; `unwaiveOccurrence` only succeeds from `WAIVED` (back to `PENDING`), both inside one transaction with `recordAudit`.
- Permissions: `payments.record` for record/void payment, `bills.manage` for waive/unwaive, `bills.view` for any read. Cross-household isolation, non-member 404s — same convention as every prior spec.

---

### Task 1: Shared types and schemas

**Files:**
- Modify: `packages/shared/src/dto.ts`
- Modify: `packages/shared/src/schemas.ts`

**Interfaces produced:**
- `BillPaymentDTO = { id, occurrenceId, amountPaise, paidOn, method: PaymentMethod, transactionRef: string | null, notes: string | null, voidedAt: string | null, voidReason: string | null, createdAt }`.
- `recordBillPaymentSchema = z.object({ amountPaise: paiseSchema.refine((v) => v > 0, "Amount must be positive"), paidOn: dateSchema, method: paymentMethodSchema, transactionRef: z.string().trim().max(200).optional(), notes: z.string().trim().max(500).optional() })` — reuse the existing `paymentMethodSchema` (already shared between salary payments and bill payments since Phase 6 Spec 1's dedup) rather than a new inline enum. Export `RecordBillPaymentInput`.
- `waiveOccurrenceSchema = z.object({ reason: z.string().trim().max(500).optional() })`, export `WaiveOccurrenceInput`.

**Steps:**
- [ ] **Step 1:** Read `packages/shared/src/dto.ts`'s existing `SalaryPaymentDTO` and `packages/shared/src/schemas.ts`'s existing `recordPaymentSchema`/`paymentMethodSchema`/`voidReasonSchema` (all from Phase 5/6 Spec 1-2) before writing — match their style exactly, reuse `paymentMethodSchema`/`voidReasonSchema` rather than redefining.
- [ ] **Step 2:** Read `apps/api/src/db/schema.ts`'s full `billPayments` table definition (search `billPayments`) for exact column names/types.
- [ ] **Step 3:** Add the DTO and both schemas as specified above.
- [ ] **Step 4:** `npm run build -w @household/shared` (no dedicated test file needed if these are thin compositions of already-tested primitives, same judgment call Phase 5/6's shared-layer tasks made — only add a test if there's a genuinely new pure function, which there isn't here).
- [ ] **Step 5:** Commit: `feat(shared): bill payment and waive-occurrence types and schemas`.

---

### Task 2: Payment and waive services, routes (API)

**Depends on:** Task 1. **Files:**
- Create: `apps/api/src/services/bill-payment.service.ts`
- Create: `apps/api/tests/bill-payment.test.ts`
- Modify: `apps/api/src/services/bill-occurrence.service.ts` (add `waiveOccurrence`/`unwaiveOccurrence`)
- Modify: `apps/api/tests/bill-occurrence.test.ts`
- Modify: `apps/api/src/routes/household.routes.ts`

**Interfaces produced:** `recordPayment(deps, actorUserId, membership, occurrenceId, input: RecordBillPaymentInput, ip?): Promise<BillPaymentDTO>`, `voidPayment(deps, actorUserId, membership, paymentId, reason?, ip?): Promise<void>`, `waiveOccurrence(deps, actorUserId, membership, occurrenceId, input: WaiveOccurrenceInput, ip?): Promise<BillOccurrenceDTO>`, `unwaiveOccurrence(deps, actorUserId, membership, occurrenceId, ip?): Promise<BillOccurrenceDTO>`.

- [ ] **Step 1:** Read `apps/api/src/services/salary-payment.service.ts` in FULL before writing anything — this task's `recordPayment`/`voidPayment` are a structural mirror of it, operating on `billPayments`/`billOccurrences` instead of `salaryPayments`/`salarySettlements`. Read `apps/api/src/services/bill-occurrence.service.ts` in full too (the Spec 2 file you're extending for waive/unwaive) — note it already has the lock/transaction/audit conventions this task continues.
- [ ] **Step 2:** Implement `bill-payment.service.ts`'s recompute function (mirroring `recomputeSettlementPaymentTotals`): re-sum non-voided `bill_payments` for the occurrence, derive `status` (`amountPaidPaise <= 0 → PENDING`, `>= amountDuePaise → PAID`, else `PARTIALLY_PAID` — but only if current status isn't `WAIVED`, mirroring how salary's version leaves `CANCELLED` alone), set/clear `paidAt` on crossing into/out of `PAID`.
- [ ] **Step 3:** Implement `recordPayment`: lock the occurrence (`.for("update")`), reject if `status === "WAIVED"` (`Errors.validation`), reject overpayment against `amountDuePaise`, insert the payment, recompute-and-persist.
- [ ] **Step 4:** Implement `voidPayment`: lock the payment, reject if already voided, soft-delete, recompute-and-persist the parent occurrence in reverse.
- [ ] **Step 5:** Implement `waiveOccurrence`/`unwaiveOccurrence` in `bill-occurrence.service.ts`: `waiveOccurrence` locks the occurrence, rejects (`Errors.validation`, with a message naming the current status) unless `status === "PENDING"`, sets `status: "WAIVED"`, `waivedAt: deps.clock.now()`, `waivedByUserId: actorUserId`. `unwaiveOccurrence` locks the occurrence, rejects unless `status === "WAIVED"`, sets `status: "PENDING"`, `waivedAt: null`, `waivedByUserId: null`. Both wrapped in one transaction with `recordAudit`.
- [ ] **Step 6:** Routes in `household.routes.ts`:
  - `POST /:householdId/bills/:id/occurrences/:occurrenceId/payments` (`payments.record`) → `recordPayment`
  - `DELETE /:householdId/bills/:id/occurrences/:occurrenceId/payments/:paymentId?reason=...` (`payments.record`) → `voidPayment`
  - `POST /:householdId/bills/:id/occurrences/:occurrenceId/waive` (`bills.manage`) → `waiveOccurrence`
  - `POST /:householdId/bills/:id/occurrences/:occurrenceId/unwaive` (`bills.manage`) → `unwaiveOccurrence`
  (Validate the occurrence's `billId` matches the URL's `:id` the same way Spec 2's `updateOccurrenceAmount` already does, for the same reason — the URL shouldn't lie about which bill a nested action belongs to.)
- [ ] **Step 7:** Tests: partial payment → `PARTIALLY_PAID`, full payment → `PAID` + `paidAt` set, overpayment rejected, void payment reverses status (including un-sticking a `PAID`/`PARTIALLY_PAID` occurrence back toward `PENDING`), payment rejected against a `WAIVED` occurrence, waive rejected from `PARTIALLY_PAID`/`PAID`/already-`WAIVED`, unwaive rejected from anything but `WAIVED`, waive-then-unwaive round trip returns to a clean `PENDING` state, bill-id-mismatch 404s on all four new routes, cross-household isolation, permission gating (`payments.record` vs `bills.manage` on the right endpoints). Targeted test run only.
- [ ] **Step 8:** `npm run build -w @household/api` and the targeted test commands. Expect PASS.
- [ ] **Step 9:** Commit: `feat(api): bill occurrence payments and waiving`.

---

### Task 3: Web — payment recording and waive actions

**Depends on:** Task 2. **Files:**
- Modify: `apps/web/src/features/app/bills/BillDetailPage.tsx`
- Modify: `apps/web/src/features/app/bills/useBills.ts`
- Modify: `apps/web/src/features/app/bills/occurrenceStatusTone.ts` (if `WAIVED`'s tone/label isn't already handled — check, Spec 2 added the mapping for all 4 statuses already so this may need no change)

- [ ] **Step 1:** Read `apps/web/src/features/app/salary/SettlementDetailPage.tsx`'s payment-recording form (from Phase 5) for the pattern to mirror — amount/date/method/reference inputs, `formatINR`/`rupeesToPaise` usage, the void-payment action. Read the current `apps/web/src/features/app/bills/BillDetailPage.tsx` (through Spec 2) in full before editing.
- [ ] **Step 2:** Add hooks to `useBills.ts`: `useRecordPayment`/`useVoidPayment` (mutations against the new payment routes) and `useWaiveOccurrence`/`useUnwaiveOccurrence`, same query-key + invalidation shape as the rest of this file (remember Spec 2's final-review fix: invalidate the occurrence-list key, not just `["bills"]`/`["bill"]`).
- [ ] **Step 3:** Extend each occurrence row in `BillDetailPage.tsx`'s occurrence list with: a "Record payment" action (opens a small form — amount/date/method/reference/notes) for any non-`WAIVED` occurrence with `amountPaidPaise < amountDuePaise`, gated on `payments.record`; a payment-history sub-list per occurrence showing its non-voided payments with a void action, gated on `payments.record`; a "Waive"/"Unwaive" action gated on `bills.manage`, shown only when the occurrence's status makes the action valid (`PENDING` → show "Waive", `WAIVED` → show "Unwaive", `PARTIALLY_PAID`/`PAID` → show neither).
- [ ] **Step 4:** Tests covering: record-payment flow, void-payment flow, waive/unwaive flow, permission gating on all of the above, an occurrence correctly hiding the payment action once `WAIVED`.
- [ ] **Step 5:** `npm run build -w @household/web && npm run typecheck -w @household/web`, then `npm run test --workspace @household/web` (targeted). Expect PASS.
- [ ] **Step 6:** `npm run lint`. Expect PASS.
- [ ] **Step 7:** Commit: `feat(web): bill payment recording and occurrence waiving`.

---

## Final note

Per the user's current instruction: merge this spec to master once all 3 tasks are reviewed clean, and don't run the repo-wide `npm test` unless explicitly asked — targeted per-task tests and the standard task/final review process are what gate the merge.
