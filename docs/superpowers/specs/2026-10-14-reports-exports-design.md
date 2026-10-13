# Phase 8, Spec 3 — Reports & Exports

**Status:** approved, ready for implementation plan
**Date:** 2026-10-14
**Scope:** Last spec of Phase 8 (Today Dashboard → Search → **Reports & Exports**). The roadmap text was unelaborated ("reports and exports") and needed scoping from scratch — narrowed through brainstorming to 4 month-scoped reports (bills spend, salary payout, attendance, checklist completion) and CSV-only, client-side-generated export. No new tables. One pre-existing, previously-unused permission (`reports.view`) is activated by this spec.

## Context

`reports.view` (`permissions.ts:30`) exists in every default role's `.view` set already (it's included via the `VIEW` filter, same as every other `.view` permission) but no route has ever checked it — this spec is its first consumer. Per-report data sources, all already built:
- Salary: `listSettlementsForHousehold(deps, householdId)` (`salary-settlement.service.ts:331`), `listHousehelps(db, householdId, false)` (`househelp.service.ts:27`, for names).
- Attendance: `getMonthAttendance(db, householdId, househelpId, month)` (`attendance.service.ts:161`) — already per-househelp, month-scoped; no household-wide version exists, so this spec loops it over active househelps (same pattern Spec 1 used for salary's "reuse + loop" aggregation).
- Checklist: `isTaskDueOn(task, date)` (`@household/shared`, pure function) is the only piece that exists — there is no function anywhere that answers "what was due this month," only "is this due on this one date" (used today for today-only views).
- Bills: nothing fits. `listOccurrences` (`bill-occurrence.service.ts:326`) is per-bill, not household-wide. `listDueOccurrencesForHousehold` (`bill-occurrence.service.ts:358`) is household-wide but only ever-open (`PENDING`/`PARTIALLY_PAID`) occurrences — a spend report needs paid/waived occurrences too, and a specific month's due dates rather than "all currently open."

## API

- **New file** `apps/api/src/services/report.service.ts`, exporting `getReport(deps, membership, type, month): Promise<ReportDTO>`.
- `GET /households/:householdId/reports?type=<bills|salary|attendance|checklist>&month=YYYY-MM` — gated on `reports.view` alone (confirmed: no additional per-entity permission check — `reports.view` is the single, deliberate gate for the whole feature). An unrecognized `type` is a 400.
- **Bills**: new `listOccurrencesDueInMonth(deps, householdId, month)` in `bill-occurrence.service.ts` (household-wide, any status, `dueDate` within the month — mirrors `listDueOccurrencesForHousehold`'s join/shape but replaces its status filter with a date-range filter). Report: `{ rows: {occurrenceId, billId, billName, dueDate, amountDuePaise, amountPaidPaise, status}[], totalDuePaise, totalPaidPaise }`.
- **Salary**: filter `listSettlementsForHousehold`'s results to `periodMonth === month`, join `listHousehelps` for names. Report: `{ rows: {settlementId, househelpId, househelpName, netPayablePaise, amountPaidPaise, status}[], totalNetPayablePaise, totalPaidPaise }`.
- **Attendance**: for every active househelp, `getMonthAttendance` for the month, tally `status` occurrences. Report: `{ rows: {househelpId, name, present, absent, halfDay, leave, holiday}[] }`.
- **Checklist**: for every active, non-archived checklist task, iterate each calendar day in the month, call `isTaskDueOn(task, date)`; where due, look up that day's completion (if any) and bucket as `completed`/`skipped`/`missed` (due with no completion row). Report: `{ rows: {taskId, name, dueCount, completedCount, skippedCount, missedCount}[] }`.

## Web

- New `/reports` page, reached via a new row in `MorePage.tsx` (same pattern as the Notifications/Notification-settings rows).
- A type selector (4 options) + a native `<input type="month">` defaulting to the current month + a results table matching the selected report's shape + a "Download CSV" button.
- CSV generation is a pure client-side function (`rowsToCSV` or similar) operating on the already-fetched report JSON — no second request, no server-side CSV writer. Triggered via a Blob + temporary `<a download>` click, the standard browser-download pattern.

## Testing

- **API**: each report type's aggregates are correct against seeded data for the selected month (bills: due-in-month at any status, including paid/waived; salary: `periodMonth` exact match; attendance: per-status tallies across multiple househelps; checklist: due/completed/skipped/missed tallies across a full month including non-daily frequencies); adjacent months' data is excluded from each; `reports.view` denial → 403 (tested the same revoked-override way as Spec 1/Spec 2); an unrecognized `type` → 400; cross-household isolation.
- **Web**: each of the 4 report types renders its table from a mocked response; switching type or month re-fetches; the CSV-building function is unit-tested directly against sample report data (exact string output), not by mocking `Blob`/`URL.createObjectURL`/anchor-click browser APIs.
