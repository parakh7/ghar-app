# Due-Item Evaluation + Reminder Rules CRUD (Phase 7 Spec 2) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Regression testing per task: run only the targeted workspace's test command named in that task's steps, not the full monorepo suite.

**Goal:** Two independent pieces that Spec 3 (the actual notification-creation job) will combine: (1) read-only "what's due/overdue within an offset window" queries for bills and salary, household-wide; (2) CRUD for `reminder_rules` so a household can configure/override the offsets, overdue-daily behavior, and send hour per target type (and optionally per specific bill/settlement target). No notification creation in this spec — that's Spec 3.

**Scope confirmation:** `reminder_rules` table already exists fully designed (`apps/api/src/db/schema.ts:505-519`) and is already seeded with default rows at household creation (`household.service.ts:77-80`: BILL `offsetsDays:[7,3,1,0]`, SALARY `offsetsDays:[3,0]`, both `overdueDaily:true, sendHour:9`) — no new seeding needed, just CRUD on top of what's already there. No `reminders.*` permission exists yet in `packages/shared/src/permissions.ts` — this spec adds it.

**Decisions locked in (confirmed with user):**
- This spec covers **BILL and SALARY targets only**. `CHECKLIST` and `ATTENDANCE` remain valid `reminderTarget` enum values (unchanged, no schema migration) but produce no due-item evaluation in this spec — neither domain has a multi-day "due in advance" concept today (checklist/attendance only have same-day due/not-done predicates), and that semantic gap is out of scope here, to be designed later if/when those reminder types are actually built.

**Architecture:** Two independently-testable pieces, done as separate tasks since they don't depend on each other:
- **Due-item evaluation**: a pure-ish service function per domain (`getDueBillOccurrences`, reusing/extending `bill-occurrence.service.ts`; `getDueSettlements`, reusing `salary-settlement.service.ts`'s already-household-wide `listSettlements`) that, given a household and a day, returns which due-items fall within someone's offset window or are overdue. Salary's query is directly reusable as-is (already household-wide); bills needs one new household-wide aggregation query (today's `listOccurrences` is bill-scoped only).
- **Reminder rules CRUD**: `reminder-rule.service.ts`, mirroring the existing category/bill CRUD pattern (list/create/update/delete, no soft-delete needed — these are small config rows, hard-delete is fine, mirroring `bill_categories`' uniqueness-on-targetType+targetId constraint).

## Global Constraints

- `reminder_rules.targetId` is nullable — `null` means "household default for this targetType" (already seeded this way), non-null means "override for one specific bill/settlement's recurring identity" (i.e. `targetId` for BILL points at a `bills.id`, for SALARY points at a... check: salary settlements don't have one stable "recurring bill"-like identity the way bills do — probably `targetId` for SALARY should point at a `househelps.id`, since a settlement recurs per househelp per month, not per settlement row. Confirm this interpretation makes sense against the unique constraint shape and the schema's own column comment, if any, before implementing — don't guess silently if the schema's intent is ambiguous here).
- Due-window computation uses this codebase's established `dateInZone(deps.clock.now(), household.timezone)` pattern for "today" — same convention every prior phase's due/overdue logic already uses (attendance, salary settlements, bill occurrences).
- "Due within an offset window" for a given rule with `offsetsDays: [7,3,1,0]` means: an item is flagged if `daysUntilDue` (item's due date minus today) exactly equals one of the configured offsets, OR the item is overdue (`daysUntilDue < 0`) and `overdueDaily` is true. This produces a de-duplicatable, idempotent-by-design signal (Spec 3's job will turn each (item, offset-or-overdue) pairing into exactly one notification per day, via an idempotency key) — this spec just needs to correctly compute the flagged set, not worry about notification de-duplication itself.
- Reminder rules CRUD: `reminders.manage` permission gates every write (create/update/delete), `reminders.view` (or just bundle into `household.view`, since these are low-sensitivity config rows visible to anyone who can see the household — use judgment, document the choice) gates reads. Add `reminders.manage` to `PERMISSIONS` in `packages/shared/src/permissions.ts`, granted to `OWNER`/`ADMIN` by default (mirroring how `bills.manage`/`categories.manage` are scoped — household-management actions, not everyday-member actions).
- Cross-household isolation, non-member 404s, audit logging on every mutation — standard convention.

---

### Task 1: Due-item evaluation queries (bills + salary)

**Files:**
- Create: `apps/api/src/services/reminder-evaluation.service.ts`
- Create: `apps/api/tests/reminder-evaluation.test.ts`
- Modify: `apps/api/src/services/bill-occurrence.service.ts` (add a household-wide due-occurrence query, exported for the new service to use — or add it directly to the new file if it doesn't fit naturally as an addition to the existing file; use judgment, document the choice)

**Interfaces produced:** `DueBillOccurrence = { billId, billName, occurrenceId, dueDate, amountDuePaise, daysUntilDue, matchedOffsets: number[], isOverdue: boolean }`, `DueSettlement = { settlementId, househelpId, househelpName, dueDate, netPayablePaise, daysUntilDue, matchedOffsets: number[], isOverdue: boolean }`, `getDueBillOccurrences(deps, householdId, today): Promise<DueBillOccurrence[]>`, `getDueSettlements(deps, householdId, today): Promise<DueSettlement[]>` — both take the household's effective reminder rules into account (join against `reminder_rules` for `targetType = 'BILL'`/`'SALARY'`, falling back to the household-default rule (`targetId IS NULL`) unless a specific-target override exists).

- [ ] **Step 1:** Read `apps/api/src/services/bill-occurrence.service.ts`'s `listOccurrences` in full (the billId-scoped query to extend/mirror for a household-wide version) and `apps/api/src/services/salary-settlement.service.ts`'s `listSettlements` in full (already household-wide, confirm its exact return shape and how to filter to "unpaid, due soon or overdue" — likely `status != 'PAID'` and `status != 'CANCELLED'`/`'WAIVED'`, check the exact status enum values for both domains before filtering).
- [ ] **Step 2:** Implement the household-wide due-bill-occurrences query: active (non-archived, non-paused — check `bills.status`) bills' occurrences where `status IN ('PENDING', 'PARTIALLY_PAID')` (unpaid), joined to get the bill's name, within the household.
- [ ] **Step 3:** For each due item, compute `daysUntilDue` (`dueDate - today`, whole days) and `isOverdue` (`daysUntilDue < 0`). Look up the effective `reminder_rules` row for this item (specific-target override if one exists for this `billId`/`househelpId`, else the household-default row for that targetType — if NEITHER exists, which shouldn't happen given seeding, but defensively skip the item rather than crash) and compute `matchedOffsets` = the subset of that rule's `offsetsDays` equal to `daysUntilDue` (empty array if none match and not overdue — these items are simply not due for a reminder today, still return them for inspection but the caller/Spec 3 will filter on `matchedOffsets.length > 0 || (isOverdue && overdueDaily)`). Also check a rule's `isActive` flag — an inactive rule means no offsets match and overdue-daily doesn't apply either, regardless of its stored `offsetsDays`/`overdueDaily` values.
- [ ] **Step 4:** Implement the equivalent for settlements, reusing `listSettlements` directly (household-wide already) rather than writing a new query, applying the same effective-rule-lookup and offset-matching logic.
- [ ] **Step 5:** Tests: an item exactly at an offset boundary flags that offset; an item overdue with `overdueDaily: true` flags as overdue; an item overdue with `overdueDaily: false` does NOT flag as overdue; an item with no matching offset and not overdue returns `matchedOffsets: []`/`isOverdue: false`; a specific-target override rule takes precedence over the household default; an `isActive: false` rule suppresses all matching regardless of its offsets; paid/archived/waived items are excluded entirely; cross-household isolation (a household's query never sees another household's bills/settlements). Targeted test run only.
- [ ] **Step 6:** `npm run build -w @household/api` and the targeted test command. Expect PASS.
- [ ] **Step 7:** Commit: `feat(api): due-item evaluation for bill occurrences and salary settlements`.

---

### Task 2: Reminder rules CRUD (API)

**Files:**
- Create: `apps/api/src/services/reminder-rule.service.ts`
- Create: `apps/api/tests/reminder-rule.test.ts`
- Modify: `apps/api/src/routes/household.routes.ts`
- Modify: `packages/shared/src/dto.ts`
- Modify: `packages/shared/src/schemas.ts`
- Modify: `packages/shared/src/permissions.ts` (add `reminders.manage`)

**Interfaces produced:** `ReminderRuleDTO = { id, targetType: "BILL" | "SALARY" | "CHECKLIST" | "ATTENDANCE", targetId: string | null, offsetsDays: number[], overdueDaily: boolean, sendHour: number, isActive: boolean, createdAt }`, `createReminderRuleSchema`/`updateReminderRuleSchema` (validate `sendHour` 0-23, `offsetsDays` is a non-empty array of non-negative integers with **no duplicates** — reject on write, both are confirmed gaps in Task 1's evaluator which assumes but doesn't enforce either property — and `targetType` enum), `listReminderRules(deps, membership): Promise<ReminderRuleDTO[]>`, `createReminderRule(deps, actorUserId, membership, input, ip?): Promise<ReminderRuleDTO>` (validates `targetId`, if provided, actually exists in this household for the given `targetType` — a `billId` for BILL, **a `househelpId` (NOT a `salary_settlements.id`) for SALARY** — confirmed and empirically verified during Task 1's review: a settlement-row-id override would be a one-shot that silently stops applying the next month, since a new settlement row is created per househelp per period; `reminder_rules.targetId` has no FK, so nothing in the database will catch validating against the wrong table here, get this right), `updateReminderRule(deps, actorUserId, membership, ruleId, input, ip?): Promise<ReminderRuleDTO>`, `deleteReminderRule(deps, actorUserId, membership, ruleId, ip?): Promise<void>` (reject deleting a household-default row — `targetId IS NULL` — since the household should always have exactly one default rule per already-seeded targetType; only specific-target overrides can be deleted; use `updateReminderRule` with `isActive: false` to "turn off" a default instead).

**Confirmed product decision (from Task 1's review):** an archived/departed househelp's still-unpaid salary settlement continues to be evaluated and can still trigger reminders — this is intentional (an outstanding debt doesn't stop mattering because someone left) and needs no special-casing in this task's CRUD either (a `targetId` override for an archived househelp's id should still validate successfully and still take effect).

- [ ] **Step 1:** Read `apps/api/src/services/bill-category.service.ts` (the existing category-CRUD mirror from Phase 6) for the exact uniqueness-conflict-handling pattern, and `apps/api/src/db/schema.ts`'s full `reminderRules` table definition before writing anything.
- [ ] **Step 2:** Add `ReminderRuleDTO` to `dto.ts`, the two schemas to `schemas.ts`.
- [ ] **Step 3:** Add `"reminders.manage"` to `PERMISSIONS` in `permissions.ts`, granted to `OWNER`/`ADMIN` by default (not `MEMBER`) — mirror exactly how `bills.manage`/`categories.manage` are scoped in `DEFAULT_ROLE_PERMISSIONS`.
- [ ] **Step 4:** Implement `reminder-rule.service.ts`'s four functions per the interfaces above, with the `targetId`-exists validation and the default-row-can't-be-deleted guard.
- [ ] **Step 5:** Routes in `household.routes.ts`: `GET /:householdId/reminder-rules` (`household.view` — these are low-sensitivity config, visible to anyone who can see the household; document this choice in a code comment if it deviates from a stricter pattern elsewhere), `POST /:householdId/reminder-rules` + `PATCH /:householdId/reminder-rules/:ruleId` + `DELETE /:householdId/reminder-rules/:ruleId` (all `reminders.manage`).
- [ ] **Step 6:** Tests: create a BILL-targetType override for a specific bill, create a SALARY override for a specific househelp, uniqueness conflict (duplicate targetType+targetId), `targetId` validation against a nonexistent bill/househelp, delete rejected on a household-default row, delete succeeds on an override row, `isActive` toggle, `offsetsDays` validation (empty array rejected, duplicate values rejected, negative values rejected), cross-household isolation, permission gating. Targeted test run only.
- [ ] **Step 7:** `npm run build -w @household/api` and the targeted test command. Expect PASS.
- [ ] **Step 8:** Commit: `feat(api): reminder rules CRUD`.

---

## Final note

No web UI in this spec (that's a later spec, once notifications actually exist to configure reminders for in a meaningful UI context) — Task 1 and Task 2 are both API-only. Merge to master once both tasks are reviewed clean. Don't run the repo-wide `npm test` unless explicitly asked.
