# Phase 3, Spec 2 — Attendance Analytics (Monthly Summary)

**Status:** approved, ready for implementation plan
**Date:** 2026-09-30
**Scope:** A per-househelp monthly attendance summary (counts by status + an attendance rate) built into the existing calendar page. Second and final spec of Phase 3 (Spec 1, one-tap marking + calendar, already shipped). No new route, no new permission, no new API endpoint — purely additive to `HousehelpCalendarPage`, computed client-side from data the page already fetches.

## Context

Phase 3 Spec 1 shipped `HousehelpCalendarPage` (`apps/web/src/features/app/attendance/HousehelpCalendarPage.tsx`), which already fetches, for the currently-viewed month: the househelp's attendance records (`useMonthAttendance` → `AttendanceRecordDTO[]`, one entry per marked day: `{date, status, note}`) and their currently-effective schedule (`useSchedule` → `ScheduleDTO | null`, with `weekdays: number[]`, 1=Mon…7=Sun). The calendar already uses these two together to dim day-cells that fall outside the current schedule — this spec reuses that exact same simplification (the current schedule's weekdays applied uniformly across whatever month is being viewed; a mid-month schedule change isn't retroactively modeled, matching the calendar's existing behavior). `attendance.view` (already required to view the page at all) is sufficient gating — no new permission.

A full-fidelity "attendance-based salary" calculation is Phase 5's job, not this spec's; this spec is a display-only summary.

## Computation

Implemented as a pure, unit-testable function in a new file `apps/web/src/features/app/attendance/summarize.ts`:

```ts
export type AttendanceSummary = {
  countedDays: number;
  present: number; absent: number; halfDay: number; leave: number; holiday: number;
  notYetMarked: number;
  rate: number | null; // null when countedDays === 0 ("—" in the UI)
};

export function summarizeMonth(
  records: AttendanceRecordDTO[], scheduledWeekdays: number[], month: string /* YYYY-MM */, today: string /* YYYY-MM-DD */,
): AttendanceSummary
```

- **Counted days**: every calendar day in `month` whose ISO weekday (1=Mon…7=Sun) is in `scheduledWeekdays`, up to `min(last day of month, today)` — so a past month counts every scheduled day in it; the current (in-progress) month only counts scheduled days that have already occurred. A future month (fully past `today`) yields `countedDays = 0`.
- **Holidays are excluded from counted days entirely** — a day marked `HOLIDAY` doesn't count toward the denominator (nor, obviously, the numerator). This mirrors how a declared holiday isn't "expected attendance" either direction.
- Of the remaining counted days, each is classified by its record's `status` (`PRESENT`/`ABSENT`/`HALF_DAY`/`LEAVE`) or, if no record exists for that date, as **not yet marked**.
- **Rate** = `(present + 0.5 × halfDay) / countedDays`, or `null` if `countedDays === 0` (rendered as "—", never `0%`/`NaN`).

## UI

A stat strip/card added to `HousehelpCalendarPage`, above the existing prev/next month header, updating whenever `month` changes (same state that already drives the grid and the `useMonthAttendance` query — no new state needed). Shows:
- A headline rate: `"87% attendance"`, or `"— attendance"` when `rate === null`.
- Six compact count tiles below it: Present, Absent, Half-day, Leave, Holiday, Not yet marked — each using the existing `statusTone.ts` tone-to-color mapping (Not yet marked uses the "muted" tone already defined for NOT_MARKED) via the existing `.badge`/`.badge--*` classes, so no new color tokens are introduced. A small new `.stat-row`/`.stat-tile` layout class (flex row, wrapping) is the only new CSS — reusing `.card` for the containing block.

## Testing

- `summarize.test.ts` (unit, no DOM): a full past month with a mix of statuses; a partial current month (asserts `countedDays` stops at `today`, not the month's end); a month containing `HOLIDAY` days (asserts they're excluded from both `countedDays` and the numerator); a month where zero scheduled days have occurred yet relative to `today` (asserts `rate === null`); a case exercising the 0.5 half-day weighting explicitly (e.g. 1 present + 2 half-days over 4 counted days → rate 0.5, not 0.25 or 0.75).
- `HousehelpCalendarPage.test.tsx`: one additional case asserting the stat strip renders the expected rate and counts for a fixed mocked dataset, and that navigating to a different month (already-tested via the existing "navigates to the next month" case's data-fetch assertion) updates the displayed summary.
