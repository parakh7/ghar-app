# Phase 2, Spec 2 — Househelps, Categories, Schedules

**Status:** approved, ready for implementation plan
**Date:** 2026-09-29
**Scope:** Full CRUD for househelp categories (with reordering), full CRUD for househelps, and versioned schedule management — on top of Phase 1's existing schema. Second and final spec of Phase 2 (Spec 1, members & invites, already shipped).

## Context

Phase 1 already delivered the full schema: `househelp_categories`, `househelps`, `househelp_category_links` (many-to-many), `attendance_schedules` (versioned — `effectiveFrom`/`effectiveTo` — per the existing comment "analytics for past months use the schedule that applied then"). `createHousehold` already seeds ten default categories per household. Permissions `househelps.view`, `househelps.manage`, `categories.manage` already exist in `packages/shared/src/permissions.ts` (OWNER/ADMIN get manage rights by default; all roles get view). No new permissions are needed. No routes or services for any of this exist yet — this spec builds the full vertical slice, replacing the "Coming soon" placeholder currently mounted at `/househelps`.

Money is always an integer number of paise (`packages/shared/src/money.ts`), never floats. The web form collects rupee amounts and converts with `rupeesToPaise` before sending; the API stores and returns paise integers.

## Categories

- **API:** `GET /categories` (any role with `househelps.view` — categories aren't separately permissioned, they're metadata shown wherever househelps are shown), `POST /categories` `{name}`, `PATCH /categories/:id` `{name?, isActive?}`, `DELETE /categories/:id` (soft — sets `deletedAt`, matching the existing unique-name-among-non-deleted index so the name becomes reusable), `POST /categories/:id/move` `{direction: "up" | "down"}`. All writes require `categories.manage`.
- **Reorder.** "Move up/down" finds the adjacent category by current `sortOrder` ordering (not by assuming contiguous integers) and swaps the two rows' `sortOrder` values inside one transaction with a row lock, so concurrent reorders can't corrupt the ordering.
- **List** returns active and inactive categories (both shown, `isActive` toggles whether the category is offered when tagging a househelp — an inactive category already linked to a househelp stays linked and visible on that househelp).

## Househelps

- **API:** `GET /househelps` (`?includeArchived=true` to also return archived ones, default excludes them), `POST /househelps`, `GET /househelps/:id`, `PATCH /househelps/:id` (any subset of: name, phone, roleTitle, status, salaryMode, monthlySalaryPaise, dailyRatePaise, halfDayRatePaise, salaryDueDay, startDate, notes, categoryIds), `POST /househelps/:id/archive`, `POST /househelps/:id/unarchive`. All require `househelps.view`/`househelps.manage` as appropriate.
- **Status vs. archive.** `status` (ACTIVE/INACTIVE) is a simple toggle for "currently working here or not" (e.g. temporary leave) — both states appear in the default list. `archivedAt` is a separate, one-way-by-default action ("Remove househelp") for someone who's truly gone; archived househelps drop out of the default list (still reachable via `includeArchived`) but every historical link (categories, and later salary/attendance records) stays intact — no hard delete, per the project's existing no-hard-deletes-for-historical-data rule. `unarchive` exists for mistake recovery.
- **Category assignment.** `categoryIds` on create/update fully replaces the househelp's set of links (delete-then-reinsert inside the same transaction as the househelp update) — simpler and sufficiently fast at household scale (a handful of categories, a handful of househelps) than diffing.
- **Salary fields.** All three rate fields (`monthlySalaryPaise`, `dailyRatePaise`, `halfDayRatePaise`) are independently optional at the API/DB level (matching the existing schema — no mode-conditional NOT NULL constraint). This spec's form shows/hides the relevant fields based on the selected `salaryMode` as a UX nicety, but doesn't invent business rules about which combination is "valid" for a mode — that validation, if ever needed, belongs to Phase 5 (salary settlement), which is what actually consumes these fields.
- **Cross-household isolation, non-member 404s, and audit logging on every mutation** follow the exact same conventions established in Phase 1 and Spec 1 (`requireHousehold`, `recordAudit` inside the same transaction as the change).

## Schedules

- **API:** `GET /househelps/:id/schedule` (returns the currently-effective version — the row where `effectiveFrom <= today` and (`effectiveTo IS NULL` or `effectiveTo >= today`) — or `null` if none exists yet), `PUT /househelps/:id/schedule` `{weekdays: number[], startTime?, endTime?}`.
- **Versioning.** `PUT` never mutates an existing row. Inside one transaction: if a currently-effective version exists, its `effectiveTo` is set to yesterday (household-timezone "today" minus one day); then a new row is inserted with `effectiveFrom` = today. This preserves history correctly per the schema's design intent, without the UI needing to expose that history yet.
- **Scope cut:** this spec does **not** build a schedule-history view. Nothing consumes historical schedule versions until Phase 3's attendance analytics — the data is safely preserved (that's the whole point of the versioning), but surfacing it in the UI now would be speculative scope. The UI shows only the current version and a "change schedule" action.

## Web UI

- Replace the `/househelps` route's `ComingSoonPage` with a real feature: a list page (grouped by category, with an "Uncategorized" bucket and a filter to show archived), a create/edit form, a detail view (with the archive/unarchive action, gated on `househelps.manage`), and a schedule editor reachable from the detail view.
- **New small UI pieces** (compositions of existing styles, not new design-system primitives): a weekday-picker (seven toggle chips, Mon–Sun, reusing the existing `.chip[aria-pressed]` pattern from `shell.css`), and a rupee-amount `TextField` wrapper that displays/accepts rupees and converts to/from paise at the boundary.
- Category management lives on its own small screen (reachable from the househelps list, similar to how Members is reachable from More) — list with name, active toggle, up/down buttons, add/edit/soft-delete.
- All new pages reuse existing primitives (`Button`, `TextField`, `Alert`, `EmptyState`) and existing permission-gating pattern (`useHousehold`'s `permissions` array, established in Spec 1).

## Testing

- **API integration** (real Postgres, matching the established pattern): category CRUD, reorder correctness (including that a delete or insert doesn't break subsequent moves), soft-delete/name-reuse; househelp CRUD, status toggle, archive/unarchive round-trip, category-link replacement on update, cross-household isolation, permission checks (VIEWER/MEMBER blocked from manage routes); schedule GET-with-no-schedule-yet, PUT creating the first version, PUT versioning correctly (old row's `effectiveTo` closed, new row inserted, both readable), household-timezone-correct "today"/"yesterday" boundary using the existing `FakeClock` test helper.
- **Web:** component tests for the househelps list (rendering + permission-gated actions), the create/edit form (validation, rupee↔paise conversion), the categories screen (reorder button behavior), and the schedule editor (weekday toggle state, versioning-triggers-on-save is verified via the mocked API call shape, not by asserting DB state from a component test).
- **E2E:** not added in this spec, consistent with Spec 1's scope decision — can be added later if wanted.
