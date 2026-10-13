# Phase 7, Spec 4 — In-App Notifications

**Status:** approved, ready for implementation plan
**Date:** 2026-10-13
**Scope:** Surface the `notifications` rows Spec 3's `evaluate-reminders` job already writes: a notifications list page, a bell/badge entry point (desktop sidebar + mobile More-page row), read/dismiss/mark-all-read actions, and a 60s-polled unread count. No migration — `notifications`/`notification_deliveries` already exist and are being written to (Spec 3). No new permission — gated on the existing `household.view`, same low-sensitivity reasoning already used for `reminder_rules` (`household.routes.ts:429-432`). Email dispatch (Spec 5) and the preferences settings UI (Spec 6) are explicitly out of scope.

## Context

`notifications` (`schema.ts:536-557`) has `userId`, `householdId`, `category`, `severity`, `title`, `body`, `entityType`/`entityId`, `data` (jsonb), `idempotencyKey`, `readAt`, `dismissedAt`, plus a partial index `notifications_user_unread_idx` on `(userId, householdId)` where `readAt IS NULL AND dismissedAt IS NULL` — purpose-built for a cheap unread-count query. No API route or web UI exists yet for this table (confirmed: no `notifications` route in `household.routes.ts`, no `/notifications` path in `apps/web/src/App.tsx`, zero "notification" matches anywhere in `apps/web/src`).

The web app has no top app bar and no existing polling pattern (`refetchInterval`/`WebSocket`/`EventSource` — zero hits repo-wide). Nav is a single responsive `shell__nav` (`AppShell.tsx`): a fixed 5-column bottom-tab grid on mobile, a sidebar on desktop (`shell.css:10-44`) where `.shell__brand` (logo + household name) is `display: none` on mobile and `display: flex` above 900px (`shell.css:16,35`) — exactly where a desktop-only bell belongs without any nav-grid change.

**BILL notifications' `entityId` is an occurrence id, not a bill id** — the only bill detail route is `/bills/:billId` (`App.tsx:63`). Rather than touch Spec 3's job (which would mean re-deriving its idempotency keys or adding a migration), the new list endpoint resolves this at read time: for each BILL-category row, one lookup from `billOccurrences` (`occurrenceId → billId`) produces a ready `linkPath`. SALARY rows need no resolution — `entityId` already is the `salarySettlements.id` used by `/salary/:id` (`App.tsx:59`).

## API

- `GET /households/:householdId/notifications` — `requireHousehold(deps, "household.view")`. Returns the caller's (`req.auth!.user.id`) most recent 50 non-dismissed (`dismissedAt IS NULL`) notifications for this household, newest first, each enriched with `linkPath: string` (`/bills/<billId>` or `/salary/<settlementId>`, resolved per the Context section above). No pagination in this spec (reminder volume is low; add it later if that stops being true).
- `GET /households/:householdId/notifications/unread-count` — same permission. Returns `{ count: number }`, a single `count(*)` against `notifications_user_unread_idx`'s exact predicate (`userId`, `householdId`, `readAt IS NULL`, `dismissedAt IS NULL`) — this is the endpoint the 60s poll hits.
- `PATCH /households/:householdId/notifications/:id` — body `{ action: "read" | "dismiss" }`. Sets `readAt`/`dismissedAt` to now if not already set (idempotent — re-marking an already-read notification read is a no-op, not an error). 404 if the notification doesn't belong to `(req.auth!.user.id, householdId)` — never leak another user's row via a 403 vs 404 distinction.
- `POST /households/:householdId/notifications/mark-all-read` — sets `readAt = now()` on every currently-unread, non-dismissed row for `(req.auth!.user.id, householdId)` in one `UPDATE ... WHERE`.
- New file `apps/api/src/services/notification.service.ts` for all four; routes added to `household.routes.ts` following the exact `requireHousehold` + `parseBody` + `ok(res, ...)` pattern already used for `reminder-rules` (`household.routes.ts:433-450`).

## Web UI

- **Desktop**: a bell icon + unread-count badge added inside `.shell__brand` (`AppShell.tsx:21-27`), next to the household name — visible only ≥900px since `.shell__brand` is already display-none below that. Clicking navigates to `/notifications`.
- **Mobile**: a "Notifications" row (with the same badge) added to `MorePage.tsx`'s existing `list` under a new or existing section (near "Members", `MorePage.tsx:49-54`).
- **`/notifications` page** (new route in `App.tsx`, same nesting level as `/members`): flat list, newest first, no grouping/pagination. Each row: title, body, relative timestamp, unread rows visually distinct (bold/dot, following `.list__item` conventions already used in `ChecklistTodayPage`/`MorePage`), a dismiss (×) control. A "Mark all as read" action in the page header, disabled when nothing is unread.
- **Interaction**: tapping a row's main area calls `PATCH .../:id {action:"read"}` and navigates to its `linkPath` in the same handler (optimistic navigate; the read-mark is fire-and-forget — don't block navigation on it). Tapping × calls `PATCH .../:id {action:"dismiss"}` and removes the row from the list (React Query `invalidateQueries`, same pattern as `useChecklist.ts:28-34` — no optimistic cache patching, consistent with the rest of the app).
- **Badge polling**: one `useNotificationUnreadCount()` hook (`apps/web/src/features/notifications/useNotifications.ts`), `useQuery` with `refetchInterval: 60_000`, feeding both badge locations and the page. This is the app's first polling hook — scope it to exactly this one query, not a generalized polling utility (YAGNI; generalize only if a second feature needs it).

## File Structure

- Create: `apps/api/src/services/notification.service.ts` (list/unread-count/mark-read/dismiss/mark-all-read + the BILL `linkPath` resolution).
- Modify: `apps/api/src/routes/household.routes.ts` (4 new routes, mirroring the `reminder-rules` block).
- Modify: `packages/shared/src/dto.ts` (a `NotificationDTO` type: id, category, severity, title, body, linkPath, readAt, dismissedAt, createdAt) and `packages/shared/src/schemas.ts` (the `{action}` patch-body schema).
- Create: `apps/web/src/features/notifications/useNotifications.ts` (list query, unread-count query with polling, read/dismiss/mark-all-read mutations).
- Create: `apps/web/src/features/notifications/NotificationsPage.tsx`.
- Modify: `apps/web/src/features/app/AppShell.tsx` (bell + badge in `.shell__brand`), `apps/web/src/features/app/MorePage.tsx` (Notifications row + badge), `apps/web/src/App.tsx` (new `/notifications` route).

## Testing

- **API integration**: list excludes dismissed, includes read+unread, orders newest-first, caps at 50; `linkPath` correctly resolves a BILL notification's occurrence→bill and passes a SALARY notification's settlement id straight through; unread-count matches a hand-counted expectation against the same predicate as the partial index; read/dismiss are idempotent (second call on an already-read/dismissed row is a no-op, not an error); mark-all-read only touches the caller's own unread rows; cross-user isolation (another member of the *same* household never sees or can mutate your notifications — 404, not 403); permission check (a non-member gets 404 via `requireHousehold`, same as every other household-scoped route).
- **Web**: `NotificationsPage` renders rows, tap-to-read-and-navigate, dismiss removes a row from the list; badge components render the polled count and hide/show at zero; `useNotifications` hook's `refetchInterval` is configured (a cheap way to assert the polling contract without waiting 60s in a test — fake timers advancing past the interval and asserting a refetch occurred).
