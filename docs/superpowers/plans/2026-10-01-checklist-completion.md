# Checklist Completion Marking (Phase 4 Spec 2) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. Regression testing per task: run only the targeted test file(s)/workspace named in that task's steps, not the full monorepo suite — the full suite runs once, after merge.

**Goal:** One-tap done/skip marking for checklist tasks, mirroring the existing attendance one-tap pattern (Phase 3 Spec 1). The `checklist_completions` table already exists (`apps/api/src/db/schema.ts:293-312`, unique on `(taskId, date)`) — this plan builds the schema/validation, service/routes, and web UI on top of it. Nothing below changes the DB schema.

**Decisions locked in (confirmed with user):**
- Backdating mirrors attendance exactly: same-day needs `checklists.complete`, any other date needs a new `checklists.editHistory` permission (not yet in `PERMISSIONS`).
- Lives at its own route, `/checklist/today`, mirroring attendance's dedicated `TodayPage` — not wired into HomePage's placeholder card (that card's "always empty" behavior is a separate, pre-existing gap, out of scope here).
- Completion is a household-wide fact per task per day (no per-assignee attribution) — matches the schema's nullable `househelpId` and its `(taskId, date)` unique index. Service always writes `houshelpId: null` (schema allows it; no UI collects a specific person).

**Architecture:** Same three-layer shape as attendance: `packages/shared` (types/schemas/pure due-date logic) → `apps/api` (service + routes) → `apps/web` (hooks + page). Each task's reference implementation is the matching attendance file — read it before writing, don't guess the shape.

## Global Constraints

- Mirror `apps/api/src/services/attendance.service.ts`'s exact patterns: `assertWritable(membership, date, today)` gating same-day vs. backdated writes; `onConflictDoUpdate` keyed on the unique index for upsert-style marking; delete+audit for clearing; `recordAudit` only on corrections (`isCorrection = date !== today`), never on same-day marks.
- Mirror `apps/web/src/features/app/attendance/TodayPage.tsx`'s race-safe pop-animation: functional `setState((prev) => ...)` in the `onAnimationEnd` handler so a late animation-end event can't clear a *different* row's in-flight state.
- Date math: `((new Date(`${date}T00:00:00Z`).getUTCDay() + 6) % 7) + 1` is this codebase's established ISO-weekday formula (1=Mon…7=Sun) — reuse it verbatim, don't reinvent.
- `checklist_tasks.frequency === "WEEKDAYS"` is a **fixed** Mon–Fri set with no stored config (see `packages/shared/src/schemas.ts:141-144`, `rejectAllExcept()` with no args) — due-check is `isoWeekday <= 5`, not a lookup against `task.weekdays` (that column is `WEEKLY`-only).
- `MONTHLY`'s `dayOfMonth` (1–31) clamps to the actual month length (e.g. 31 in February means due on the 28th/29th) — this is new logic, not present anywhere yet; get the clamping right and cover it with a test.
- New permission `checklists.editHistory`: add to `PERMISSIONS` in `packages/shared/src/permissions.ts` right after `"checklists.complete"`. Do **not** add it to `MEMBER`'s explicit grant list — `OWNER`/`ADMIN` get it automatically (both default to the full `PERMISSIONS` array minus a couple of unrelated entries), exactly how `attendance.editHistory` is handled today.

---

### Task 1: Shared types, schemas, and the due-today predicate

**Files:**
- Modify: `packages/shared/src/dto.ts`
- Modify: `packages/shared/src/schemas.ts`
- Modify: `packages/shared/src/permissions.ts`
- Modify: `packages/shared/src/index.ts`
- Create: `packages/shared/src/checklist-frequency.ts`
- Create: `packages/shared/src/checklist-frequency.test.ts`

**Interfaces produced:**
- `isTaskDueOn(task, date: string): boolean` — pure function, exported from the new file and re-exported via `index.ts`. `task` param type: `Pick<ChecklistTaskDTO, "frequency" | "weekdays" | "dayOfMonth" | "specificDate" | "intervalDays" | "anchorDate">`.
- DTOs in `dto.ts` (place near the existing `TaskFrequency`/`ChecklistTaskDTO` block): `CompletionStatus = "PENDING" | "COMPLETED" | "SKIPPED"` (matches the DB enum at `apps/api/src/db/schema.ts:39`); `TodayChecklistEntryDTO = { taskId: string; name: string; status: CompletionStatus | null; note: string | null }`; `TodayChecklistDTO = { date: string; entries: TodayChecklistEntryDTO[] }`.
- `markCompletionSchema` in `schemas.ts`, mirroring `markAttendanceSchema`'s shape (same file, find it near line ~100): `{ date: dateSchema, status: z.enum(["COMPLETED", "SKIPPED"]), note: z.string().trim().max(500).optional() }`. Export `MarkCompletionInput = z.infer<typeof markCompletionSchema>`. (`PENDING` is never client-submitted — it's the "no record exists yet" default, same as attendance's `status: null` meaning not-yet-marked.)

**Steps:**
- [ ] **Step 1:** Add `"checklists.editHistory"` to the `PERMISSIONS` array in `permissions.ts`, immediately after `"checklists.complete"`. Confirm (don't change) that it's absent from `MEMBER`'s explicit array in `DEFAULT_ROLE_PERMISSIONS` — `OWNER`/`ADMIN` pick it up automatically since they're `PERMISSIONS`-minus-exclusions. Add one test case to `permissions.test.ts` mirroring the existing `attendance.editHistory` test (role without it → `false`, `ADMIN`/`OWNER` → `true`).
- [ ] **Step 2:** Add the DTOs described above to `dto.ts`.
- [ ] **Step 3:** Add `markCompletionSchema` to `schemas.ts` (reuse `dateSchema`, already defined/imported in that file for `markAttendanceSchema`).
- [ ] **Step 4:** Create `checklist-frequency.ts` with `isTaskDueOn`. Implement per-frequency:
  - `DAILY`: always `true`.
  - `WEEKDAYS`: `isoWeekday(date) <= 5` (no stored config — see Global Constraints).
  - `WEEKLY`: `(task.weekdays ?? []).includes(isoWeekday(date))`.
  - `MONTHLY`: clamp `task.dayOfMonth` to the actual days-in-month for `date`'s year/month, compare to `date`'s day-of-month.
  - `SPECIFIC_DATE`: `date === task.specificDate`.
  - `CUSTOM`: due when `date >= task.anchorDate` and the whole-day difference between them is a multiple of `task.intervalDays` (UTC date math, matching this codebase's convention — see `isoWeekdayOf`'s own UTC-midnight parsing for the pattern to follow).
  Include the same `isoWeekdayOf` helper used by `attendance.service.ts` (copy its exact formula; this file doesn't import from `apps/api`).
- [ ] **Step 5:** Write `checklist-frequency.test.ts` covering: each frequency's due/not-due case, `WEEKDAYS` on a Saturday (not due) vs. a Wednesday (due), `MONTHLY` with `dayOfMonth: 31` against February and against a 30-day month (clamped), `CUSTOM` before its anchor date (not due) and exactly on an interval boundary (due).
- [ ] **Step 6:** Add the new file to `index.ts`'s export list.
- [ ] **Step 7:** Run `npm run build -w @household/shared && npm run test --workspace @household/shared`. Expect PASS.
- [ ] **Step 8:** Commit: `feat(shared): checklist completion types, schema, and due-today predicate`.

---

### Task 2: API service and routes

**Depends on:** Task 1 (imports its types/schemas/predicate). **Files:**
- Create: `apps/api/src/services/checklist-completion.service.ts`
- Create: `apps/api/src/services/checklist-completion.service.test.ts` (or follow this codebase's existing test-location convention for API services — check where `attendance.service.ts`'s own tests live and mirror that, not necessarily co-located)
- Modify: `apps/api/src/routes/household.routes.ts`

**Interfaces produced:** `getTodayChecklist(deps, membership, dateParam?): Promise<TodayChecklistDTO>`, `markCompletion(deps, actorUserId, membership, taskId, input: MarkCompletionInput, ip?): Promise<...>`, `clearCompletion(deps, actorUserId, membership, taskId, date, ip?): Promise<void>` — same signature shape as `attendance.service.ts`'s `getToday`/`setAttendance`/`clearAttendance`, with `taskId` replacing `househelpId` as the per-row key, and `isTaskDueOn` replacing the schedule-join to compute "due today".

- [ ] **Step 1:** Read `apps/api/src/services/attendance.service.ts` in full before writing anything — this task's service is a structural mirror of it (query active+non-archived rows for the household, apply the due-predicate instead of a schedule join, left-join today's completion records, build entries). Also read `apps/api/src/routes/household.routes.ts`'s attendance block (around lines 147-178) for the exact route-registration pattern (`requireHousehold(deps, permission)`, `ok(res, result, status, message)`).
- [ ] **Step 2:** Implement `getTodayChecklist`: query active checklist tasks (`isActive = true`, `archivedAt is null`) for the household, filter to those where `isTaskDueOn(task, date)`, left-join `checklist_completions` on `(taskId, date)`, return `{ date, entries }` with `status: null` for due tasks with no completion row yet. Due tasks sort first (mirror attendance's `scheduledToday`-first stable sort), same as `getToday`'s existing sort.
- [ ] **Step 3:** Implement `markCompletion`: `assertWritable`-equivalent gate using `checklists.complete` (same-day) / `checklists.editHistory` (backdated) — copy `assertWritable`'s exact logic, swap the permission names. Verify the task exists in this household (mirror `requireHousehelpInHousehold`'s shape, adapted to `checklist_tasks`). Upsert via `onConflictDoUpdate` on the `checklist_completions_task_date_uq` unique index, always writing `househelpId: null`. Audit only on `isCorrection` (date !== today), action `"checklist.completionCorrected"`.
- [ ] **Step 4:** Implement `clearCompletion`: delete the `(taskId, date)` row, same audit-on-correction shape as `clearAttendance`.
- [ ] **Step 5:** Wire three routes in `household.routes.ts`, directly beneath the attendance block for locality:
  - `GET /:householdId/checklist/today` → `requireHousehold(deps, "checklists.view")` → `getTodayChecklist`
  - `PUT /:householdId/checklist/:taskId/completion` → `requireHousehold(deps, "checklists.complete")` → `markCompletion`
  - `DELETE /:householdId/checklist/:taskId/completion` → `requireHousehold(deps, "checklists.complete")` → `clearCompletion`
  (The permission check inside `markCompletion`/`clearCompletion` for backdating still applies on top of the route-level `checklists.complete` gate — same two-layer shape attendance uses.)
- [ ] **Step 6:** Tests mirroring `attendance.service.ts`'s existing test coverage shape (same-day mark, backdated mark requires `editHistory`, future date rejected, clear removes the row, due-predicate integration for at least one frequency). Run only this task's new/changed test file(s) — not the full `apps/api` suite.
- [ ] **Step 7:** `npm run build -w @household/api` (or this repo's equivalent typecheck command for the API workspace) and the targeted test command from Step 6. Expect PASS.
- [ ] **Step 8:** Commit: `feat(api): checklist completion service and routes`.

---

### Task 3: Web hooks and Today's Checklist page

**Depends on:** Task 2 (calls its routes). **Files:**
- Create: `apps/web/src/features/app/checklist/useChecklistCompletion.ts`
- Create: `apps/web/src/features/app/checklist/ChecklistTodayPage.tsx`
- Modify: `apps/web/src/App.tsx`
- Modify: `apps/web/src/features/app/checklist/ChecklistListPage.tsx`

- [ ] **Step 1:** Read `apps/web/src/features/app/attendance/useAttendance.ts` and `apps/web/src/features/app/attendance/TodayPage.tsx` in full before writing — this task mirrors both structurally.
- [ ] **Step 2:** `useChecklistCompletion.ts`: `useTodayChecklist(householdId)` (query), `useMarkCompletion(householdId)` and `useClearCompletion(householdId)` (mutations hitting the Task 2 routes), invalidating the today-query on success — same shape as `useTodayAttendance`/`useSetAttendance`/`useClearAttendance`.
- [ ] **Step 3:** `ChecklistTodayPage.tsx`: list of due-today tasks, each with a one-tap mark control (done/skip — two states, unlike attendance's present/absent toggle; simplest faithful mirror: tapping an unmarked task marks it `COMPLETED`, a small secondary action marks `SKIPPED`, tapping a marked task's status badge clears it back to unmarked — adapt attendance's exact UI shape from `TodayPage.tsx`, including its `AttendancePicker`-equivalent for picking `COMPLETED`/`SKIPPED`/clear explicitly rather than inferring from a single tap, since completion has three states (none/done/skipped) same as attendance's five-state picker pattern). Reuse the exact race-safe pop-animation pattern (`poppedId` state, functional `setState` in `onAnimationEnd`) from `TodayPage.tsx` verbatim — this is a Global Constraint, not a suggestion.
- [ ] **Step 4:** Route: add `<Route path="checklist/today" element={<ChecklistTodayPage />} />` to `App.tsx`, alongside the existing `checklist/*` routes.
- [ ] **Step 5:** Link: add a `"Today's checklist"` link from `ChecklistListPage.tsx` to `/checklist/today`, mirroring `HousehelpsListPage.tsx:49`'s `<Link to="/attendance" className="list__label">Today's attendance</Link>` exactly (same className, same placement pattern).
- [ ] **Step 6:** Tests: a `ChecklistTodayPage.test.tsx` covering render of due-today entries, marking complete/skipped, and clearing — mirror `TodayPage.tsx`'s existing test file's structure and coverage shape.
- [ ] **Step 7:** `npm run build -w @household/web && npm run typecheck -w @household/web`, then `npm run test --workspace @household/web` (targeted — this workspace only). Expect PASS.
- [ ] **Step 8:** `npm run lint`. Expect PASS.
- [ ] **Step 9:** Commit: `feat(web): one-tap checklist completion marking (Today's checklist page)`.

---

## Final note

After Task 3 merges, run the full monorepo suite once (`npm test` at the repo root) and rebuild `packages/shared`'s dist (`npm run build -w @household/shared`) in the main checkout post-merge — this repo's established stale-dist gotcha for anything that touches the shared package.
