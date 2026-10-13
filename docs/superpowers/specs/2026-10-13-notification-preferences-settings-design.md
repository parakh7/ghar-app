# Phase 7, Spec 6 — Notification Preferences Settings UI

**Status:** approved, ready for implementation plan
**Date:** 2026-10-13
**Scope:** The last spec in Phase 7. Lets a user turn BILL/SALARY reminders on/off and opt into email for each, closing the loop that makes Spec 5's email dispatcher actually reachable. No schema migration — `notification_preferences` already exists. ATTENDANCE/CHECKLIST/SYSTEM categories and the IN_APP/WEB_PUSH/SMS/WHATSAPP channel toggles are explicitly out of scope — none of them has an observable effect yet (no evaluator for the first three; no subscribe flow for WEB_PUSH; no provider for SMS/WHATSAPP; and critically, `channels` doesn't gate what appears on `/notifications` at all — only `enabled` does, so an IN_APP toggle would be a pure no-op today).

## Context

`notification_preferences` (`schema.ts:522-534`) is `(id, householdId, userId, category, enabled, channels, offsetsDays, sendHour, createdAt, updatedAt)`, unique on `(householdId, userId, category)`. Household creation seeds all 5 categories for the creator (`household.service.ts:81-83`); invited members never get rows — Spec 3 already established "no row = enabled, default channels `{IN_APP, WEB_PUSH}`" as the read-time fallback, which this spec's GET endpoint reuses verbatim rather than backfilling rows on invite accept.

`evaluate-reminders.job.ts`'s `getRecipients` consults `enabled` and `channels` only — never the row's optional personal `offsetsDays`/`sendHour` override (Spec 3's explicit scope decision, unchanged here). This spec never touches `offsetsDays`/`sendHour` either.

No `NotificationPreferenceDTO`/schema pair exists yet in `packages/shared` — this spec adds the first one. No web settings-style page exists yet — `MorePage.tsx` is a flat list of links/toggleless actions; this is the first page with persisted, immediately-applied toggle controls.

## API

- **New file** `apps/api/src/services/notification-preference.service.ts`.
- `GET /households/:householdId/notification-preferences` (`household.view`) → `NotificationPreferenceDTO[]`, always exactly 2 entries (`BILL`, `SALARY`), in that order. For each category: if a row exists for `(householdId, req.auth!.user.id, category)`, return its real `enabled` and `emailEnabled: channels.includes("EMAIL")`; if no row exists, return the default `{ enabled: true, emailEnabled: false }`.
- `PATCH /households/:householdId/notification-preferences/:category` (`household.view` — same low-sensitivity, per-user-resource reasoning as `reminder-rules`/`notifications`; `:category` restricted to `BILL`/`SALARY`, anything else is a 400) body `{ enabled?: boolean, emailEnabled?: boolean }`, at least one field required. Upserts: if no row exists, insert one with the request's values layered onto the defaults (`enabled: true, channels: ["IN_APP","WEB_PUSH"]` then add/remove `EMAIL` per `emailEnabled`); if a row exists, update only the fields given — `emailEnabled: true` adds `"EMAIL"` to the existing `channels` array (no duplicate, no disturbance to `IN_APP`/`WEB_PUSH` already there), `emailEnabled: false` removes only `"EMAIL"`. Returns the updated `NotificationPreferenceDTO`.
- `NotificationPreferenceDTO = { category: "BILL" | "SALARY"; enabled: boolean; emailEnabled: boolean }` — no `id` (callers never need it; the upsert is keyed by `(householdId, userId, category)`, not a row id).

## Web UI

- New `apps/web/src/features/settings/NotificationSettingsPage.tsx` at route `/settings/notifications`, reached from a new "Notification settings" row in `MorePage.tsx`'s existing "Household" section (distinct label from the existing bell-linked "Notifications" row, which is the inbox — this is its settings).
- Two cards, "Bills" and "Salary": each has an enabled toggle (switch, not a checkbox — this is a settings page, first one in the app, use whatever toggle-switch pattern/component is idiomatic for the existing design system) and, visible only while enabled is on, an "Also email me" checkbox. Each control fires its `PATCH` immediately on change — no separate save button, consistent with the app's existing one-tap-mutation pages (checklist, attendance).
- `apps/web/src/features/settings/useNotificationPreferences.ts`: one query (`GET`) + one mutation (`PATCH`, optimistic-free — invalidate-and-refetch like every other mutation hook in this app).

## Testing

- **API integration**: GET returns the default shape for a category with no row (e.g. an invited member who never got seeded); GET returns real stored values for a category with a row; PATCH creates a row on a member's first-ever write with the request's values correctly layered on the defaults; PATCH on an existing row updates only the given field(s), leaving the other untouched; `emailEnabled: true` then `emailEnabled: false` round-trips `channels` back to not containing `"EMAIL"` without disturbing `IN_APP`/`WEB_PUSH`; a category outside `BILL`/`SALARY` in the PATCH URL is a 400; cross-user isolation (another household member's preferences are never read or written by a different user's request); permission check (non-member 404s via `requireHousehold`).
- **Web**: `NotificationSettingsPage` renders both cards with their current enabled/email state; toggling `enabled` off hides the email checkbox; toggling either control fires the correct `PATCH` body; `MorePage` shows the new settings row.
