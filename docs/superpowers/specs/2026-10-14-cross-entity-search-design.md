# Phase 8, Spec 2 — Cross-Entity Search

**Status:** approved, ready for implementation plan
**Date:** 2026-10-14
**Scope:** Second spec of Phase 8 (Today Dashboard → **Search** → Reports & Exports). This is the first search feature in the app — no existing search code, generic filter UI, or full-text search infrastructure exists anywhere. Covers 4 entity types: househelps (by name), bills (by name/provider), checklist tasks (by name), members (by name/email). No new tables, no full-text search engine (`tsvector`/Postgres FTS) — plain case-insensitive substring matching (`ILIKE '%q%'`) is sufficient at this household-app scale.

## Context

`listBills(deps, membership, filters)` (`bill.service.ts:37`) is the only existing filter pattern in the codebase, and it's entity-local (status/category filters), not a search. No `DataTable` or generic list-filter UI component exists in `apps/web/src/components/`. Mobile has no shared top bar at all — every page renders its own local `<header className="page-head">` — confirmed during Spec 1's research. Permission names already exist and are exactly right: `househelps.view`, `bills.view`, `checklists.view`, `members.view`.

## API

- **New file** `apps/api/src/services/search.service.ts`, exporting `search(deps, membership, query): Promise<SearchResultsDTO>`.
- `GET /households/:householdId/search?q=<text>` (`household.view` — same reasoning as the dashboard: the route is reachable by anyone who can see the household, each *section* is independently gated inside the response).
- Per entity type, `ILIKE '%q%'` (Postgres, case-insensitive) against:
  - Househelps: `name`.
  - Bills: `name` OR `provider`.
  - Checklist tasks: `name`.
  - Members: the user's real `name`, OR their household-specific `displayName` (if set), OR the underlying user's `email`.
- Each section capped at 10 results (no pagination — guards against a short/common query matching everything, not a real pagination need at this scale).
- `SearchResultsDTO`, following Spec 1's permission-gating convention (**absent key = no permission**, not an error, not conflated with "no matches"):
  ```
  {
    househelps?: { id, name }[];
    bills?: { id, name, provider }[];
    checklistTasks?: { id, name }[];
    members?: { userId, name, email }[];
  }
  ```
- A missing/empty `q` query param returns every permitted section as an empty array (not an error, not all sections omitted) — "search for nothing" is a valid, empty-result request, distinct from "no permission."

## Web

- **Desktop**: a search input added to `AppShell.tsx`'s `.shell__brand` area (same spot Spec 4 of Phase 7 put the notification bell), debounced, navigating to `/search?q=<text>` as the user types.
- **Mobile**: since no shared mobile header exists, a fixed-position search icon button added directly in `AppShell.tsx`, shown only below the desktop breakpoint via CSS (the inverse of how `.shell__brand` is desktop-only), linking to `/search` (no pre-filled query — the search page owns its own input for mobile).
- **`/search` page** (new route + `MorePage` is NOT touched — search is reachable only via the two affordances above, not a third More-page row, since it's meant to be a fast, always-available action, not a settings-style destination): one text input, 4 result sections (Househelps/Bills/Checklist/Members), each rendered only when its key is present in the response; each result links to its entity's existing detail page (`/households/:id` equivalents already exist — e.g. `/bills/:billId`, `/checklist/:taskId`, no new detail pages needed).

## Testing

- **API**: each entity type matches case-insensitively and by substring (not just prefix) on its documented field(s); bills match on either `name` or `provider`; members match on real name, display name, or email; each section absent when the caller lacks its permission (tested the same revoked-override way as Spec 1); an empty/missing `q` returns empty arrays for every permitted section, never omits them; the 10-result cap is enforced (seed 11+ matching rows for one entity, assert exactly 10 returned — not asserting which 10, to avoid a brittle ordering dependency); cross-household isolation; 404 for a non-member.
- **Web**: the search page renders grouped results from a mocked response; an absent section renders nothing; the desktop sidebar input and the mobile icon both navigate to `/search` with the expected query param.
