# Phase 3, Spec 1 — Attendance Marking and Calendar

**Status:** approved, ready for implementation plan
**Date:** 2026-09-30
**Scope:** One-tap daily attendance marking for househelps, a household-wide bulk holiday action, and a per-househelp monthly calendar view for reviewing/correcting past days. First of two Phase 3 specs — analytics (which reads this data) is deferred to a second spec once real attendance data exists to design against.

## Context

Phase 1 already delivered the schema this spec needs: `attendance_records` (one row per `(househelp_id, date)`, unique-constrained; no row = NOT_MARKED; status enum `PRESENT | ABSENT | HALF_DAY | LEAVE | HOLIDAY`) and `attendance_schedules` (built out in Phase 2 Spec 2's `schedule.service.ts` — gives us "is this househelp scheduled to work on date X" for free). Permissions `attendance.view`, `attendance.mark`, `attendance.editHistory` already exist in `packages/shared/src/permissions.ts` (OWNER/ADMIN get all three by default, MEMBER gets view+mark, VIEWER gets view only). **No migration, no new permissions** — this spec is purely services, routes, DTOs, and UI on top of what already exists.

Household "today" is computed via the existing `dateInZone(instant, timeZone)` helper (`packages/shared/src/time.ts`), the same helper `schedule.service.ts` already uses for its own today/yesterday boundary — attendance is never marked or read using server UTC directly.

## API

All routes under `/api/households/:householdId/attendance/...`, gated by `requireHousehold(deps, permission)` per Phase 1/2 convention.

- `GET /attendance/today?date=YYYY-MM-DD` (`attendance.view`, defaults to household's current date) — returns every active househelp with today's mark (`status` or `null`) and `scheduledToday: boolean` (from `attendance_schedules`), pre-sorted scheduled-first. Rejects a date after household's today.
- `PUT /attendance/:househelpId` `{date, status, note?}` — upserts the one record via `ON CONFLICT (househelp_id, date) DO UPDATE` (the existing unique index makes this a natural idempotent upsert, no row-locking needed). Rejects a future date.
- `DELETE /attendance/:househelpId?date=YYYY-MM-DD` — reverts to NOT_MARKED (deletes the row).
- `POST /attendance/holiday` `{date}` — in one transaction, upserts every active househelp's record for `date` to `HOLIDAY`, overwriting any existing mark. No confirmation logic server-side (that's a web-only guard); permission/audit rules below key off the same `date`.
- `GET /househelps/:id/attendance?month=YYYY-MM` (`attendance.view`) — all records for that househelp in the given month, for the calendar grid. Works for archived househelps too (historical record).

**Permission rule, uniform across `PUT`/`DELETE`/`POST .../holiday`:** if the target `date` equals the household's current date, `attendance.mark` is sufficient; any other date requires `attendance.editHistory`. All three endpoints reject a `date` later than the household's today.

**Audit:** every write where `date !== household's today` is recorded via `recordAudit` (action `attendance.corrected`, same transaction as the change) — matches the categories/househelps precedent for meaningful changes without flooding the log with routine daily taps. Same-day writes are not audited.

**Archived househelps** are excluded from `GET /attendance/today` and from the bulk holiday action, same filtering `househelp.service.ts` already applies elsewhere; they remain readable via their own calendar endpoint.

## Web UI

**Today screen** (`apps/web/src/features/app/attendance/TodayPage.tsx`): lists active househelps, scheduled-today first, each row showing name, meta line, and a status chip.
- Tap cycles `PRESENT ↔ ABSENT` (first tap from NOT_MARKED sets `PRESENT`).
- A secondary "more" affordance opens a small picker: Half-day / Leave / Holiday / Not-marked (clear) — a discoverable tap target rather than long-press, since long-press is unreliable across devices and this app is built for non-technical/senior users.
- A header action "Mark today as holiday" opens a confirm dialog naming how many rows already carry a non-holiday mark ("3 already marked — overwrite?") before calling the bulk endpoint.
- This screen only ever targets the household's current date — no date-picker here.

**Calendar view** (`apps/web/src/features/app/attendance/HousehelpCalendarPage.tsx`): reached from a househelp's detail page (an "Attendance" link on `HousehelpDetailPage.tsx`, built in Phase 2 Spec 2). Month grid, one househelp at a time, prev/next navigation. Each day cell colored by status (five status colors, a neutral "not marked", and a muted style for days outside that househelp's current schedule — informational only, doesn't block marking). Tapping a day opens the same picker used on the Today screen; if the day isn't today, the picker is hidden/disabled for viewers without `attendance.editHistory` (the server enforces the same rule regardless of what the UI shows).

Both pages reuse existing primitives (`Button`, `Alert`, `EmptyState`, the `.chip[aria-pressed]` pattern) and the existing `permissions` array on `useHousehold` for gating, per established convention.

## Testing

- **API integration** (real Postgres): upsert semantics (create then overwrite), unmark (delete), future-date rejection on all three write endpoints, permission boundaries (MEMBER marks today but is blocked from editing a past day; VIEWER blocked from all writes), bulk-holiday overwrite behavior (including that it does overwrite existing non-holiday marks), month-range query correctness at a household-timezone boundary (same `FakeClock`-based pattern as the Phase 2 Spec 2 schedule-versioning test), archived-househelp exclusion from `today`/holiday and inclusion in the per-househelp calendar query, audit-log presence on past-day corrections and absence on same-day marks.
- **Web:** status-cycle tap behavior on the Today screen, the picker path for Half-day/Leave/Holiday/clear, the holiday confirm dialog (including the "already marked" count), calendar month navigation and per-status coloring, and the permission-gated picker on past days (editHistory vs. mark-only).
- **E2E:** not added in this spec, consistent with Phase 2's scope decisions.
