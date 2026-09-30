# Attendance Analytics (Monthly Summary) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a per-househelp monthly attendance summary (status counts + an attendance rate) to the existing calendar page — no new route, no new permission, no new API endpoint.

**Architecture:** A new pure function `summarizeMonth` (`apps/web/src/features/app/attendance/summarize.ts`) computes the summary from data `HousehelpCalendarPage` already fetches (`AttendanceRecordDTO[]` from `useMonthAttendance`, `weekdays` from `useSchedule`). The page renders the result as a small stat strip above the existing month grid — reusing the existing `.card`/`.badge`/`.chips` CSS classes and `statusTone.ts`'s tone mapping, so no CSS changes are needed at all.

**Tech Stack:** React 19 + TanStack Query (data already fetched by the existing page — no new queries), Vitest + Testing Library (web).

## Global Constraints

- This is a display-only feature — no salary/payroll calculation. Phase 5 owns attendance-based salary math.
- `summarizeMonth` is a pure function (no React, no fetching) — fully unit-testable in isolation.
- Reuses the current-schedule simplification the calendar page already makes: `scheduledWeekdays` is whatever `useSchedule` currently returns, applied uniformly across whichever month is being viewed (a mid-month schedule change isn't retroactively modeled — matches the calendar's existing day-dimming behavior, not a new inconsistency introduced by this spec).
- "Today" and "month" are both `"YYYY-MM-DD"`/`"YYYY-MM"` strings compared lexically (never parsed into a `Date` for comparison) — consistent with the rest of this codebase's date handling.
- No new CSS: the stat strip reuses `.card` (container), `.chips` (the tile row's flex-wrap layout — confirmed its rule is `display: flex; flex-wrap: wrap; gap: var(--space-2); ...` with no child-specific styling, so it composes safely with `.badge` children instead of its usual `.chip` buttons), `.badge`/`.badge--*` (`apps/web/src/styles/components.css`, already added in the attendance-calendar branch), and inline `style` for the one-off headline size (`var(--text-2xl)`) — matching this codebase's established convention of inline styles for single-use layout tweaks (see `HousehelpCalendarPage.tsx`'s existing header row).
- Spec: `docs/superpowers/specs/2026-09-30-attendance-analytics-design.md`.

---

### Task 1: `summarizeMonth` — pure computation

**Files:**
- Create: `apps/web/src/features/app/attendance/summarize.ts`
- Test: `apps/web/src/features/app/attendance/summarize.test.ts`

**Interfaces:**
- Consumes: `AttendanceRecordDTO`, `AttendanceStatus` (`@household/shared`).
- Produces: `AttendanceSummary` (type), `summarizeMonth(records: AttendanceRecordDTO[], scheduledWeekdays: number[], month: string, today: string): AttendanceSummary` — consumed by Task 2.

- [ ] **Step 1: Write the failing unit tests**

Create `apps/web/src/features/app/attendance/summarize.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import type { AttendanceRecordDTO } from "@household/shared";
import { summarizeMonth } from "./summarize";

const WEEKDAYS = [1, 2, 3, 4, 5]; // Mon–Fri

function rec(date: string, status: AttendanceRecordDTO["status"]): AttendanceRecordDTO {
  return { date, status, note: null };
}

describe("summarizeMonth", () => {
  it("counts every scheduled weekday in a full past month, with unmarked days as not-yet-marked", () => {
    // August 2026 has 21 weekdays (Mon–Fri) total; "today" is well past the month, so all 21 count.
    const records = [
      rec("2026-08-03", "PRESENT"),
      rec("2026-08-04", "ABSENT"),
      rec("2026-08-05", "HALF_DAY"),
      rec("2026-08-06", "LEAVE"),
    ];
    const summary = summarizeMonth(records, WEEKDAYS, "2026-08", "2026-09-29");
    expect(summary).toEqual({
      countedDays: 21, present: 1, absent: 1, halfDay: 1, leave: 1, holiday: 0, notYetMarked: 17,
      rate: 1.5 / 21,
    });
  });

  it("stops counting at today for the current (in-progress) month, not the whole month", () => {
    // September 2026's 1st–10th has 8 weekdays (Sept 5–6 is a weekend); "today" is the 10th.
    const records = [rec("2026-09-01", "PRESENT")];
    const summary = summarizeMonth(records, WEEKDAYS, "2026-09", "2026-09-10");
    expect(summary).toEqual({
      countedDays: 8, present: 1, absent: 0, halfDay: 0, leave: 0, holiday: 0, notYetMarked: 7,
      rate: 1 / 8,
    });
  });

  it("excludes holidays from both counted days and the rate numerator", () => {
    // Same August weekdays as the first test, but one is a declared holiday.
    const records = [
      rec("2026-08-03", "PRESENT"),
      rec("2026-08-04", "HOLIDAY"),
      rec("2026-08-05", "ABSENT"),
    ];
    const summary = summarizeMonth(records, WEEKDAYS, "2026-08", "2026-09-29");
    expect(summary).toEqual({
      countedDays: 20, present: 1, absent: 1, halfDay: 0, leave: 0, holiday: 1, notYetMarked: 18,
      rate: 1 / 20,
    });
  });

  it("returns a null rate when no scheduled day in the month has occurred yet", () => {
    // October 2026 is entirely after "today" of 2026-09-29.
    const summary = summarizeMonth([], WEEKDAYS, "2026-10", "2026-09-29");
    expect(summary).toEqual({ countedDays: 0, present: 0, absent: 0, halfDay: 0, leave: 0, holiday: 0, notYetMarked: 0, rate: null });
  });

  it("weights a half-day as 0.5 present, not 0 and not 1", () => {
    // Sept 1–4, 2026 are Tue/Wed/Thu/Fri — 4 scheduled weekdays, no weekend in between.
    const records = [
      rec("2026-09-01", "PRESENT"),
      rec("2026-09-02", "HALF_DAY"),
      rec("2026-09-03", "HALF_DAY"),
      rec("2026-09-04", "ABSENT"),
    ];
    const summary = summarizeMonth(records, WEEKDAYS, "2026-09", "2026-09-04");
    expect(summary.countedDays).toBe(4);
    expect(summary.rate).toBe(0.5);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm run test --workspace @household/web -- summarize`
Expected: FAIL — `./summarize` doesn't exist yet.

- [ ] **Step 3: Implement `summarize.ts`**

Create `apps/web/src/features/app/attendance/summarize.ts`:

```ts
import type { AttendanceRecordDTO, AttendanceStatus } from "@household/shared";

export type AttendanceSummary = {
  countedDays: number;
  present: number; absent: number; halfDay: number; leave: number; holiday: number;
  notYetMarked: number;
  /** `null` when `countedDays === 0` — render as "—", never "0%"/"NaN". */
  rate: number | null;
};

function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

/** 1=Mon … 7=Sun, matching `attendance_schedules.weekdays`'s convention. */
function isoWeekdayOf(date: string): number {
  return ((new Date(`${date}T00:00:00Z`).getUTCDay() + 6) % 7) + 1;
}

/**
 * Summarizes one househelp's attendance for `month`, counting only days that both (a) fall on a
 * scheduled weekday and (b) have already occurred (up to `today`, inclusive — the whole month if
 * `month` is entirely in the past, zero days if `month` is entirely in the future). A day marked
 * HOLIDAY is excluded from `countedDays` and the rate entirely — it was never "expected attendance".
 * A scheduled, non-holiday day with no record counts toward `countedDays` as `notYetMarked`.
 */
export function summarizeMonth(records: AttendanceRecordDTO[], scheduledWeekdays: number[], month: string, today: string): AttendanceSummary {
  const scheduled = new Set(scheduledWeekdays);
  const byDate = new Map(records.map((r) => [r.date, r.status]));
  const todayMonth = today.slice(0, 7);
  const [year, m] = month.split("-").map(Number);
  const daysTotal = daysInMonth(year!, m!);
  const lastDay = month < todayMonth ? daysTotal : month > todayMonth ? 0 : Number(today.slice(8, 10));

  const counts: Record<AttendanceStatus, number> = { PRESENT: 0, ABSENT: 0, HALF_DAY: 0, LEAVE: 0, HOLIDAY: 0 };
  let countedDays = 0;
  let notYetMarked = 0;

  for (let day = 1; day <= lastDay; day++) {
    const d = `${month}-${String(day).padStart(2, "0")}`;
    if (!scheduled.has(isoWeekdayOf(d))) continue;
    const status = byDate.get(d);
    if (status === "HOLIDAY") { counts.HOLIDAY++; continue; }
    countedDays++;
    if (status === undefined) { notYetMarked++; continue; }
    counts[status]++;
  }

  const rate = countedDays === 0 ? null : (counts.PRESENT + 0.5 * counts.HALF_DAY) / countedDays;
  return {
    countedDays, present: counts.PRESENT, absent: counts.ABSENT, halfDay: counts.HALF_DAY,
    leave: counts.LEAVE, holiday: counts.HOLIDAY, notYetMarked, rate,
  };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm run test --workspace @household/web -- summarize`
Expected: PASS — all 5 cases.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/features/app/attendance/summarize.ts apps/web/src/features/app/attendance/summarize.test.ts
git commit -m "feat(web): pure monthly attendance summary computation"
```

---

### Task 2: Wire the summary into `HousehelpCalendarPage`

**Files:**
- Modify: `apps/web/src/features/app/attendance/HousehelpCalendarPage.tsx`
- Modify: `apps/web/src/features/app/attendance/HousehelpCalendarPage.test.tsx`

**Interfaces:**
- Consumes: `summarizeMonth`, `AttendanceSummary` (`./summarize`, from Task 1); `month`, `today`, `monthQuery.data`, `scheduleQuery.data` — all already computed/fetched by the existing page.

- [ ] **Step 1: Write the failing component test**

Append to `apps/web/src/features/app/attendance/HousehelpCalendarPage.test.tsx`, inside the existing `describe("HousehelpCalendarPage", ...)` block (after the last existing `it(...)`):

```tsx
  it("shows the monthly summary and updates it when the month changes", async () => {
    renderPage(["attendance.view", "attendance.editHistory"]);
    // September 2026: schedule is Mon–Fri, "today" (pinned) is the 29th — 21 scheduled weekdays have
    // occurred by then. The mocked month data has exactly one record: 2026-09-15 → PRESENT.
    await screen.findByText("5% attendance");
    expect(screen.getByText(/Present\s*1/)).toBeInTheDocument();
    expect(screen.getByText(/Not yet marked\s*20/)).toBeInTheDocument();

    // October 2026 is entirely in the future relative to the pinned "today" — nothing has occurred
    // yet, so the rate is unknown rather than a misleading 0%.
    await userEvent.click(screen.getByRole("button", { name: "Next" }));
    await screen.findByText("— attendance");
  });
```

This relies on the existing `renderPage` helper's mocks (already in the file): the September month-attendance mock returns `[{ date: "2026-09-15", status: "PRESENT", note: null }]`, the schedule mock returns `weekdays: [1, 2, 3, 4, 5]`, and every other month (including October) returns `[]` — all already set up by Task 1/prior work in this test file, no mock changes needed.

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm run test --workspace @household/web -- HousehelpCalendarPage`
Expected: FAIL — "5% attendance" never renders (the summary isn't wired in yet).

- [ ] **Step 3: Wire `summarizeMonth` into the page**

In `apps/web/src/features/app/attendance/HousehelpCalendarPage.tsx`, add the import alongside the other same-folder imports:

```tsx
import { summarizeMonth } from "./summarize";
```

Add the summary computation right after the existing `scheduledWeekdays` line (`const scheduledWeekdays = new Set(scheduleQuery.data?.weekdays ?? []);`):

```tsx
  const summary = summarizeMonth(monthQuery.data ?? [], scheduleQuery.data?.weekdays ?? [], month, today);
```

Add the stat strip markup right after the existing `{pageError && <Alert tone="error" title={pageError} />}` line and before the existing `<div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: "var(--space-4)" }}>` that holds the Previous/Next buttons — i.e., the error alert (if any) comes first, then the summary, then the month navigation:

```tsx
      <div className="card" style={{ marginBottom: "var(--space-4)" }}>
        <p style={{ fontSize: "var(--text-2xl)", fontWeight: 700, margin: 0 }}>
          {summary.rate === null ? "—" : `${Math.round(summary.rate * 100)}%`} attendance
        </p>
        <div className="chips" style={{ marginTop: "var(--space-3)" }}>
          <span className={`badge badge--${toneOf("PRESENT")}`}>Present {summary.present}</span>
          <span className={`badge badge--${toneOf("ABSENT")}`}>Absent {summary.absent}</span>
          <span className={`badge badge--${toneOf("HALF_DAY")}`}>Half-day {summary.halfDay}</span>
          <span className={`badge badge--${toneOf("LEAVE")}`}>Leave {summary.leave}</span>
          <span className={`badge badge--${toneOf("HOLIDAY")}`}>Holiday {summary.holiday}</span>
          <span className="badge badge--muted">Not yet marked {summary.notYetMarked}</span>
        </div>
      </div>
```

`toneOf` already accepts a bare `AttendanceStatus` literal (it's typed `AttendanceStatus | null`), so `toneOf("PRESENT")` etc. works without any change to `statusTone.ts`.

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm run test --workspace @household/web -- HousehelpCalendarPage`
Expected: PASS — all 5 cases (4 pre-existing + this task's new one).

- [ ] **Step 5: Run the full web suite to check for regressions**

Run: `npm run test --workspace @household/web`
Expected: PASS.

- [ ] **Step 6: Run the full monorepo build and typecheck**

Run: `npm run build && npm run typecheck`
Expected: both PASS across `shared`, `api`, `web`.

- [ ] **Step 7: Commit**

```bash
git add apps/web/src/features/app/attendance/HousehelpCalendarPage.tsx apps/web/src/features/app/attendance/HousehelpCalendarPage.test.tsx
git commit -m "feat(web): show monthly attendance summary on the calendar page"
```
