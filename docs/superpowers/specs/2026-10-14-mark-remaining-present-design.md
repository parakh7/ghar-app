# Mark Remaining as Present — Design Spec

**Status:** Approved.

## Context

On the per-househelp attendance calendar (`HousehelpCalendarPage`), a manager currently has to tap every day individually to mark it. When a househelp has worked every scheduled day for most of a month, re-marking each one by hand is tedious. The page already computes exactly which days are unmarked (`summarizeMonth`'s `notYetMarked` — scheduled weekday, not a holiday, already occurred, no attendance record) and shows that count as a badge.

## Scope

Add a "Mark remaining as present" action that marks every one of those `notYetMarked` days PRESENT in a single request, for the currently displayed month.

- Only touches days with **no existing attendance record** — never overwrites an existing mark of any status (including HOLIDAY).
- Only scheduled weekdays (per the househelp's current attendance schedule, same simplification the page's own summary already uses — not historical per-date schedule versions).
- Only days that have already occurred (≤ today in the household's timezone) — a future month naturally has zero eligible days.
- Confirmation required before committing: `window.confirm("Mark N remaining day(s) as present?")`.

**Out of scope:** bulk-marking any status other than PRESENT, bulk actions spanning multiple househelps or multiple months in one call, undo.

## Backend

New service function `markRemainingPresent(deps, actorUserId, membership, househelpId, month, ip): Promise<{ month: string; count: number }>` in `apps/api/src/services/attendance.service.ts`, mirroring the existing `markHoliday` bulk-write pattern:

- One DB transaction: select the household's active schedule weekdays, compute the target month's eligible dates (scheduled, ≤ today, no existing record), bulk-insert PRESENT rows for exactly those dates.
- Permission: same two-tier rule every other attendance write already uses (`assertWritable`) — `attendance.mark` is always required (enforced at the route level, like every other attendance route); if any eligible date isn't today, `attendance.editHistory` is also required (checked inside the function, same as `markHoliday`/`setAttendance`).
- Audit: one summary entry (`attendance.remainingMarkedPresent`, `newValue: { month, count }`) if any eligible date wasn't today — same "no audit for a same-day-only action" rule the rest of this service follows. No audit entry (and no-op) when `count === 0`.
- New route: `POST /households/:householdId/househelps/:id/attendance/remaining-present`, body `{ month }` (validated with the existing `monthSchema`), guarded by `requireHousehold(deps, "attendance.mark")`.
- New DTO: `MarkRemainingPresentResultDTO = { month: string; count: number }` in `@household/shared`.

## Frontend

- New hook `useMarkRemainingPresent(householdId)` in `useAttendance.ts`, mirroring `useMarkHoliday`: posts to the new endpoint, invalidates the same `["attendance", "month", householdId, househelpId]` / `["attendance", "today", householdId]` queries on success via the existing `invalidateAttendance` helper.
- `HousehelpCalendarPage`: a new button next to the month-navigation row, shown only when `summary.notYetMarked > 0 && canMarkToday && canEditHistory`. On click, confirms via `window.confirm`, then fires the mutation with `{ househelpId: id, month }`.

## Testing

- API: a test file covering — marks only the truly-unmarked scheduled days (not holidays, not already-marked days, not off-schedule days, not future days); one summary audit entry recorded; `count: 0` and no audit entry when there's nothing to mark; `403` without `attendance.mark`; `403` without `attendance.editHistory` when at least one eligible date is in the past (not today); cross-household isolation.
- Web: a test confirming the button is hidden when `notYetMarked` is 0, and that confirming the dialog calls the endpoint with the right `household`/`househelp`/`month` and then shows the updated calendar.
