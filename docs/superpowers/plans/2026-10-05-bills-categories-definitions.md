# Bill Categories + Bill Definitions CRUD (Phase 6 Spec 1) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Regression testing per task: run only the targeted workspace's test command named in that task's steps, not the full monorepo suite.

**Goal:** CRUD for bill categories and bill definitions (the recurring-bill record itself — name, provider, amount, frequency, due-date anchor). This is the first of 4 specs for Phase 6 ("Bills, recurrence, occurrences, partial payments"). **No occurrence generation and no payment recording in this spec** — those are Specs 2 and 3. A bill created here just sits as a definition; nothing is materialized yet.

**Scope confirmation (greenfield above schema):** `bill_categories` and `bills` tables already exist fully designed (`apps/api/src/db/schema.ts:391-436`). `bill_categories` rows are already seeded per-household at creation (`DEFAULT_BILL_CATEGORIES`, `household.service.ts:76`) but have no CRUD service yet. `bills.view`/`bills.manage` permissions already exist in `packages/shared/src/permissions.ts`. Nothing beyond the schema/seed/permissions exists for either table — no service, route, or UI.

**Architecture:** Bill categories mirror the existing househelp-category pattern almost exactly (`apps/api/src/services/category.service.ts` — soft-delete via `deletedAt`, partial-unique-index-on-lower-name uniqueness, `FOR UPDATE`-locked reordering). Bill definitions are new CRUD with one piece of real validation logic: a frequency-config check mirroring the already-shipped checklist-task pattern (`packages/shared/src/schemas.ts`'s `checkFrequencyConfig`/`taskFrequencySchema`).

## Global Constraints

- Bill categories: mirror `apps/api/src/services/category.service.ts` function-for-function (`listCategories`/`createCategory`/`updateCategory`/`softDeleteCategory`/`moveCategory`), same soft-delete-via-`deletedAt` + partial-unique-index-on-`lower(name)` pattern, same `FOR UPDATE`-locked reorder swap. Read that file in full before writing — this is a structural mirror, not a reinvention.
- `bills.intervalCount`/`intervalUnit` are **CUSTOM-frequency-only** fields (per the DB schema's own design: `intervalCount` defaults to 1 and is documented as CUSTOM-only, `intervalUnit` is a plain nullable text column with no DB-level enum). Every other frequency (`ONE_TIME`/`WEEKLY`/`MONTHLY`/`QUARTERLY`/`HALF_YEARLY`/`YEARLY`) must reject both fields being set (mirror checklist's `checkFrequencyConfig`'s `rejectAllExcept()` pattern exactly — same shape, different field set). `CUSTOM` requires both `intervalUnit` (one of `"day"|"week"|"month"`) and a non-default `intervalCount` making sense (any integer ≥1 is valid, including 1 — "every 1 day" is a degenerate but valid CUSTOM bill).
- `bills.amountPaise` is nullable by design (null = variable amount, e.g. electricity — the actual amount gets set per-occurrence in Spec 2). Do not make it required in the create schema.
- `bills.categoryId` is nullable (a bill can be uncategorized) — validate it exists in this household if provided, but don't require it.
- Status lifecycle for a bill: `ACTIVE ⇄ PAUSED`, and `ACTIVE/PAUSED → ARCHIVED` (with `archivedAt` set), `ARCHIVED → ACTIVE` (unarchive, clearing `archivedAt`) — mirror the existing househelp archive/unarchive action-endpoint pattern (`POST /:id/archive`, `POST /:id/unarchive`) rather than allowing arbitrary status writes through a general PATCH.
- Permissions: `bills.view` for all reads, `bills.manage` for every write (create/update/pause/resume/archive/unarchive on bills; create/update/delete/move on categories).
- Cross-household isolation, non-member 404s, and audit logging on every mutation follow this codebase's standard convention (`requireHousehold`, `recordAudit` inside the same transaction as the change) — same as every prior phase.

---

### Task 1: Bill categories CRUD (API)

**Files:**
- Create: `apps/api/src/services/bill-category.service.ts`
- Create: `apps/api/tests/bill-category.test.ts`
- Modify: `apps/api/src/routes/household.routes.ts`
- Modify: `packages/shared/src/schemas.ts` (reuse `createCategorySchema`'s shape — check whether it can be reused directly for bill categories, or needs its own near-identical copy since it's a different table; prefer reuse if the existing schema has no coupling to househelp-categories specifically)

**Interfaces produced:** `listBillCategories(db, householdId)`, `createBillCategory(deps, actorUserId, householdId, {name, icon?}, ip?)`, `updateBillCategory(deps, actorUserId, householdId, categoryId, {name?, icon?, isActive?}, ip?)`, `softDeleteBillCategory(...)`, `moveBillCategory(..., direction)` — exact same signatures as `category.service.ts`'s functions, operating on `billCategories` instead of `househelpCategories`.

- [ ] **Step 1:** Read `apps/api/src/services/category.service.ts` in full (all 99 lines) before writing anything. Read `packages/shared/src/schemas.ts`'s `createCategorySchema`/`updateCategorySchema` to decide whether they're generic enough to reuse as-is for bill categories (note: bill categories additionally have an `icon` field that househelp categories don't — check this) or need their own `createBillCategorySchema`/`updateBillCategorySchema` with the extra `icon` field.
- [ ] **Step 2:** Read `apps/api/src/db/schema.ts`'s `billCategories` table definition (lines ~391-404) for exact column names/constraints.
- [ ] **Step 3:** Implement `bill-category.service.ts` as a structural mirror of `category.service.ts`, operating on `billCategories`, including the `icon` field in create/update/DTO.
- [ ] **Step 4:** Add/extend schemas in `packages/shared/src/schemas.ts` as decided in Step 1, and the corresponding `BillCategoryDTO` in `packages/shared/src/dto.ts` (`{ id, name, icon: string | null, sortOrder, isActive, createdAt }` — check `category.service.ts`'s existing `CategoryDTO` shape for the exact pattern to extend).
- [ ] **Step 5:** Routes in `household.routes.ts`, mirroring the existing categories routes exactly (same path shape, different resource segment): `GET /:householdId/bill-categories` (`bills.view`), `POST /:householdId/bill-categories` + `PATCH .../:categoryId` + `DELETE .../:categoryId` + `POST .../:categoryId/move` (all `bills.manage`).
- [ ] **Step 6:** Tests mirroring the existing househelp-category test file's shape and coverage (create, rename with uniqueness conflict, soft-delete, reorder, cross-household isolation, permission gating).
- [ ] **Step 7:** `npm run build -w @household/api` and the targeted test command (this new test file only). Expect PASS.
- [ ] **Step 8:** Commit: `feat(api): bill category CRUD`.

---

### Task 2: Bill definitions CRUD (API)

**Depends on:** Task 1 (bills reference `bill_categories` for validation, though not a hard code dependency — can run in parallel if preferred, but do it after for a cleaner review sequence). **Files:**
- Create: `apps/api/src/services/bill.service.ts`
- Create: `apps/api/tests/bill.test.ts`
- Modify: `apps/api/src/routes/household.routes.ts`
- Modify: `packages/shared/src/dto.ts`
- Modify: `packages/shared/src/schemas.ts`

**Interfaces produced:** `BillDTO`, `createBillSchema`/`CreateBillInput`, `updateBillSchema`/`UpdateBillInput`; `listBills(deps, membership, filters?)`, `getBill(deps, membership, billId)`, `createBill(deps, actorUserId, membership, input, ip?)`, `updateBill(deps, actorUserId, membership, billId, input, ip?)`, `pauseBill`/`resumeBill`/`archiveBill`/`unarchiveBill(deps, actorUserId, membership, billId, ip?)`.

- [ ] **Step 1:** Read `apps/api/src/db/schema.ts`'s full `bills` table definition (lines ~407-436) and `packages/shared/src/schemas.ts`'s existing `checkFrequencyConfig`/`taskFrequencySchema` block (checklist's frequency validation — the pattern to mirror for bill frequency validation, with a different field set per the Global Constraints' `intervalCount`/`intervalUnit` rule). Also read `apps/api/src/services/checklist-task.service.ts` for how it validates `categoryId` exists in the household (same validation bill creation needs against `bill_categories`) and how its own archive/unarchive-equivalent (`isActive`) is structured, if applicable, or `apps/api/src/services/househelp.service.ts`'s archive/unarchive for the closer pattern match (bills have explicit ACTIVE/PAUSED/ARCHIVED states, closer to a status-machine than a boolean).
- [ ] **Step 2:** Add `BillDTO` to `dto.ts`: `{ id, name, categoryId: string | null, provider: string | null, accountNumber: string | null, amountPaise: number | null, frequency, intervalCount, intervalUnit: string | null, firstDueDate, endDate: string | null, paymentMethod: PaymentMethod | null, autopay, status: "ACTIVE" | "PAUSED" | "ARCHIVED", notes: string | null, archivedAt: string | null, createdAt }`. Add `BillFrequency = "ONE_TIME" | "WEEKLY" | "MONTHLY" | "QUARTERLY" | "HALF_YEARLY" | "YEARLY" | "CUSTOM"`.
- [ ] **Step 3:** Add `createBillSchema`/`updateBillSchema` to `schemas.ts` with a `checkBillFrequencyConfig` superRefine mirroring `checkFrequencyConfig`'s exact shape: every frequency except `CUSTOM` rejects both `intervalCount` and `intervalUnit` if set; `CUSTOM` requires `intervalUnit` (`z.enum(["day","week","month"])`) and accepts any `intervalCount >= 1` (defaulting to 1 if omitted, matching the DB column's default). `amountPaise` is `paiseSchema.nullable().optional()`. `categoryId` is `z.string().uuid().optional()`. `firstDueDate` is required (`dateSchema`), `endDate` is optional/nullable (`dateSchema.nullable().optional()`), must be `>= firstDueDate` if both present (add a refine for this).
- [ ] **Step 4:** Implement `bill.service.ts`: `createBill` validates `categoryId` (if given) exists in this household's `bill_categories`, inserts with `status: "ACTIVE"`. `updateBill` handles the general-fields PATCH (everything except status transitions) — re-runs the frequency-config validation if `frequency` or its config fields are touched (mirror `updateChecklistTaskSchema`'s "include frequency when changing its config fields" requirement). `pauseBill`/`resumeBill`/`archiveBill`/`unarchiveBill` are explicit status-transition actions, each validating the current status allows the transition (e.g. can't pause an already-archived bill) and each wrapped in a transaction with `recordAudit`.
- [ ] **Step 5:** `listBills`/`getBill`: household-scoped reads; `listBills` should support an optional status filter (e.g. `?status=ACTIVE`) since the UI will likely want to hide archived bills by default — check Task 3's brief isn't dictating this before finalizing the exact filter shape, use judgment.
- [ ] **Step 6:** Routes in `household.routes.ts`: `GET /:householdId/bills` (`bills.view`), `GET /:householdId/bills/:id` (`bills.view`), `POST /:householdId/bills` (`bills.manage`), `PATCH /:householdId/bills/:id` (`bills.manage`), `POST /:householdId/bills/:id/pause` + `/resume` + `/archive` + `/unarchive` (all `bills.manage`).
- [ ] **Step 7:** Tests: create with each frequency (valid configs), frequency-config validation rejections (e.g. `intervalUnit` set on a `MONTHLY` bill → 400, `CUSTOM` missing `intervalUnit` → 400), `endDate < firstDueDate` rejection, category-must-exist-in-household validation, full status-transition matrix (pause/resume/archive/unarchive, including invalid transitions like archiving an already-archived bill), cross-household isolation, permission gating. Targeted test run only.
- [ ] **Step 8:** `npm run build -w @household/api` and the targeted test command. Expect PASS.
- [ ] **Step 9:** Commit: `feat(api): bill definition CRUD with frequency validation`.

---

### Task 3: Web — bill categories and bill definitions pages

**Depends on:** Tasks 1-2. **Files:**
- Create: `apps/web/src/features/app/bills/BillCategoriesPage.tsx`
- Create: `apps/web/src/features/app/bills/BillsListPage.tsx`
- Create: `apps/web/src/features/app/bills/BillFormPage.tsx`
- Create: `apps/web/src/features/app/bills/BillDetailPage.tsx`
- Create: `apps/web/src/features/app/bills/useBills.ts`
- Modify: `apps/web/src/App.tsx`

- [ ] **Step 1:** Read `apps/web/src/features/app/househelps/CategoriesPage.tsx` in full (the direct template for `BillCategoriesPage.tsx`) and one existing create/edit form + detail page pair (e.g. the checklist task form/detail pages, or the househelp form/detail pages) for the pattern `BillFormPage.tsx`/`BillDetailPage.tsx` should mirror.
- [ ] **Step 2:** `useBills.ts`: hooks for bill categories (list/create/update/delete/move, mirroring whatever hook file backs `CategoriesPage.tsx`) and bills (list/get/create/update/pause/resume/archive/unarchive), same query-key + invalidation shape as every other feature's hook file in this codebase.
- [ ] **Step 3:** `BillCategoriesPage.tsx`: direct mirror of `CategoriesPage.tsx`, same interactions (add/rename/toggle-active/reorder/delete), pointed at bill-category endpoints, plus the `icon` field if Task 1 added one.
- [ ] **Step 4:** `BillsListPage.tsx`: list of bills (name, category, amount-or-"variable", frequency label, status badge), filterable/toggleable to show archived or not, a "Add bill" action gated on `bills.manage`. No occurrence/due-date display yet (that's Spec 2) — just the definition list.
- [ ] **Step 5:** `BillFormPage.tsx`: create/edit form for a bill — name, category picker, provider, account number, amount (with a clear "leave blank for variable amount" affordance), frequency picker with conditional `intervalCount`/`intervalUnit` fields shown only for CUSTOM (mirror the checklist task form's conditional-fields-per-frequency pattern), first due date, end date, payment method, autopay toggle, notes.
- [ ] **Step 6:** `BillDetailPage.tsx`: shows one bill's full definition plus pause/resume/archive/unarchive actions gated on `bills.manage`. No payment history yet (Spec 3).
- [ ] **Step 7:** Route wiring in `App.tsx` (`/bills`, `/bills/categories`, `/bills/new`, `/bills/:id`, `/bills/:id/edit`) — check how checklist's equivalent routes are structured for the pattern.
- [ ] **Step 8:** Tests for all new pages mirroring this codebase's existing page-test depth (render, create/edit submission, status-transition actions, permission gating).
- [ ] **Step 9:** `npm run build -w @household/web && npm run typecheck -w @household/web`, then `npm run test --workspace @household/web` (targeted). Expect PASS.
- [ ] **Step 10:** `npm run lint`. Expect PASS.
- [ ] **Step 11:** Commit: `feat(web): bill category and bill definition pages`.

---

## Final note

This plan does NOT include a full-suite run or a final whole-branch review step beyond each task's own review — per the user's current instruction, merge each task to master as it completes rather than batching the whole spec, and the full monorepo test suite only runs when the user explicitly asks for it. Still run the per-task targeted tests and the standard task-review process (spec compliance + quality) for every task — only the full-suite gate changes.
