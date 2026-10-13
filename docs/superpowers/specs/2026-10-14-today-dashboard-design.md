# Phase 8, Spec 1 — Today Dashboard

**Status:** approved, ready for implementation plan
**Date:** 2026-10-14
**Scope:** First spec of Phase 8 ("Today service and dashboard, reports and exports, search" — decomposed into 3 independent specs: this one, then Search, then Reports & Exports). Completes `HomePage.tsx`'s 3 placeholder cards (Househelp, Today's work, Payments — currently always-empty, explicitly earmarked in a doc comment as "driven by the TodayService (Phase 8)") and replaces the existing Salaries card's inefficient client-side fan-out with the same new backend endpoint. No new tables — pure aggregation of data already produced by Phases 2–6.

## Context

`HomePage.tsx:20-22`'s own doc comment: *"Phase 1: real greeting + household-local date. The 'Today' sections are driven by the TodayService (Phase 8); until their data exists they show honest empty states."* Three of the four home cards (Househelp, Today's work, Payments) currently render a static `EmptyState` unconditionally — not driven by any query at all. The fourth (Salaries) is live, via `useUpcomingSettlement` (`useSalary.ts:80-109`), which fans out one HTTP request **per active househelp** client-side because no household-wide settlements endpoint exists — a real inefficiency this spec also fixes, using the already-existing server-side `listSettlementsForHousehold` (`salary-settlement.service.ts:331`).

Per-entity data this spec aggregates, all already built: `getTodayChecklist`-equivalent logic (`checklist-completion.service.ts`, backing the existing `GET /checklist/today` route), today's attendance records (`attendance.service.ts`), `listDueOccurrencesForHousehold` (`bill-occurrence.service.ts:358`, currently internal-only — used by Spec 3 of Phase 7's reminder job, never exposed via a route), and `listSettlementsForHousehold`. Permissions already exist and are exactly right for gating each section: `attendance.view`, `checklists.view`, `bills.view`, `salaries.view` (`permissions.ts:17-28`).

## API

- **New file** `apps/api/src/services/today.service.ts`, exporting `getTodayDashboard(deps, membership): Promise<TodayDashboardDTO>`.
- `GET /households/:householdId/today` (`household.view` — the endpoint itself is reachable by anyone who can see the household; each *section* is independently gated inside the response, not at the route level, since a VIEWER-only member should still see their permitted sections rather than get a blanket 403).
- `TodayDashboardDTO`:
  - `attendance: { marked: number; total: number } | null` — `total` = active househelps count, `marked` = how many already have a today's-date attendance record. `null` if the caller lacks `attendance.view`.
  - `checklist: { done: number; total: number; pending: string[] } | null` — `pending` is the names of today's not-yet-marked tasks only (not the done ones — matches the Payments/Salaries cards' "what still needs action" pattern). `null` without `checklists.view`.
  - `bills: { occurrenceId: string; billId: string; billName: string; amountDuePaise: number; dueDate: ISODate; isOverdue: boolean }[] | null` — every open (`PENDING`/`PARTIALLY_PAID`) occurrence with `dueDate <= today`, not a forward-looking preview. `null` without `bills.view`.
  - `salary: { settlementId: string; househelpName: string; periodMonth: string; dueDate: ISODate; netDuePaise: number; status: SettlementStatus } | null` — the single nearest-due settlement with `status` not `PAID`/`CANCELLED`, household-wide (same selection logic `useUpcomingSettlement` already implements client-side, moved server-side). `null` without `salaries.view`, or if nothing is unpaid.

## Web

- One new `useTodayDashboard(householdId)` hook (single `GET`) replaces `useUpcomingSettlement`'s per-househelp fan-out entirely — `useSalary.ts`'s `useUpcomingSettlement` export is removed once `HomePage.tsx` no longer calls it (confirm nothing else uses it before deleting).
- `HomePage.tsx`'s 4 cards wire to the 4 `TodayDashboardDTO` sections:
  - **Househelp**: `attendance.marked`/`attendance.total` as "X of Y marked today", linking to `/attendance`; existing `EmptyState` ("No househelps yet") only when `total === 0`.
  - **Today's work**: `checklist.done`/`checklist.total` as "X of Y done", listing `checklist.pending` task names below, linking to `/checklist/today`; existing empty state when `total === 0`.
  - **Payments**: list of `bills` entries (name, amount, due date, overdue badge), linking each to `/bills/:billId`; existing empty state when the array is empty.
  - **Salaries**: unchanged rendering logic (`upcoming` / "all settled" / "nothing due" empty states per `HomePage.tsx:59-79`), now sourced from `dashboard.salary` instead of `useUpcomingSettlement`.
- A `null` section (permission denied) renders nothing for that card — not an empty state, not an error — same as today's pattern where `canViewSalaries` already gates the Salaries card's action button.

## Testing

- **API integration**: each section present when the caller has its permission, `null` when not (test all 4 independently, e.g. a VIEWER role per section); attendance `marked`/`total` counts correct against seeded records; checklist `done`/`total` counts and `pending` containing only unmarked task names; bills correctly includes due-today and overdue, excludes future-due/paid/waived occurrences; salary selects the single nearest-due unpaid/non-cancelled settlement across multiple househelps, matching `useUpcomingSettlement`'s existing filter semantics; empty-household case (zero househelps/bills/checklist tasks) returns well-formed zero/empty sections, never an error; cross-household isolation (never aggregates another household's data).
- **Web**: `HomePage` renders each card's real content from one mocked `GET /today` response; a `null` section renders no card content (verify absence, not an empty state); existing Salaries card behavior (all 3 of its existing render branches) preserved under the new data source.
