# Phase 7, Spec 5 — Email Notification Channel

**Status:** approved, ready for implementation plan
**Date:** 2026-10-13
**Scope:** Dispatch `notification_deliveries` rows with `channel = 'EMAIL'` and `status = 'PENDING'` (written by Spec 3's `evaluate-reminders` job, currently never consumed) via the existing `EmailProvider` infrastructure. No new email provider, no schema migration, no web/shared-package changes. Spec 6 (preferences settings UI, not yet built) is the only thing that will ever let a real user opt into the EMAIL channel — until then this dispatcher has nothing real to process, same as Spec 3 shipped EMAIL/WEB_PUSH as PENDING-only "for a later spec" ahead of any consumer existing.

## Context

`notification_deliveries` (`schema.ts:559-570`) already has `status` (`PENDING|SENT|FAILED|SKIPPED`), `attempts` (smallint, default 0), and `lastError` — columns clearly built for a retrying dispatcher that has never been written. `EmailProvider` (`apps/api/src/services/email/email.provider.ts`) is a one-method interface (`send(message: EmailMessage): Promise<void>`) already used by `auth.service.ts` for verify/reset/password-changed emails, backed by `ConsoleEmailProvider` (logs) or `MemoryEmailProvider` (test double), selected via `EMAIL_PROVIDER` env (`console`/`memory` only — no real ESP integration exists or is being added here). `users.emailVerifiedAt` (nullable) is the existing trust signal auth flows already key off of.

Today, `notification_deliveries.channel = 'EMAIL'` rows can't actually be created in production: `notification_preferences.channels` defaults to `{IN_APP, WEB_PUSH}` and nothing (no route, no UI) lets a user add `EMAIL` to it. This spec builds and fully tests the dispatcher anyway — it stays inert until Spec 6 ships the opt-in, exactly as Spec 3 shipped PENDING EMAIL/WEB_PUSH rows ahead of any consumer.

## Job

- **New file** `apps/api/src/jobs/dispatch-email-deliveries.job.ts`, exporting `runDispatchEmailDeliveries(deps: Deps): Promise<void>`, registered in `worker.ts` as `deps.queue.registerHandler("dispatch-email-deliveries", () => runDispatchEmailDeliveries(deps))` and scheduled via `deps.queue.scheduleRepeating("dispatch-email-deliveries", {}, 5 * 60 * 1000)` (every 5 minutes — independent of `evaluate-reminders`'s hourly cadence, since delivery shouldn't wait a full hour, and a separate job keeps email-provider failures from ever touching the reminder-evaluation job's own error handling, which Spec 3's review already hardened).
- **Query:** up to 100 rows where `notificationDeliveries.channel = 'EMAIL'` and `status = 'PENDING'`, each joined to its parent `notifications` row (`title`, `body`) and the recipient `users` row (`email`, `emailVerifiedAt`) via `notifications.userId`.
- **Per-row processing, each in its own try/catch** (lesson from Spec 3's review: a batch-level catch lets one bad row block every row behind it):
  1. `user.emailVerifiedAt === null` → update the delivery to `status: 'SKIPPED'`. No send attempted, no error recorded.
  2. Otherwise call `deps.email.send({ to: user.email, subject: notification.title, text: notification.body ?? notification.title, tag: "reminder-notification" })` (plain text only — no `html`, matching every existing template's convention).
  3. Send resolves → update `status: 'SENT'`, `sentAt: now`.
  4. Send throws → `attempts += 1`, `lastError: String(error)`; if the new `attempts < 3`, leave `status: 'PENDING'` (the next tick's query picks it up again); on reaching `3`, set `status: 'FAILED'` (terminal — no further automatic retry).
- A delivery whose `notifications` row or `users` row is somehow missing (should be impossible given the FKs, but defensive) is logged via `deps.logger.error` and skipped for that tick, not crashed on.

## Testing

- **API integration** (`dispatch-email-deliveries.job.test.ts`, real test DB, `MemoryEmailProvider`, `FakeQueue`-style direct function call — no actual queue needed since this is a unit-style test of the job function): a PENDING EMAIL delivery for a verified user is sent and marked `SENT` with `sentAt` set; an unverified user's delivery is marked `SKIPPED` with zero calls to the email provider; a provider configured to throw increments `attempts` and sets `lastError`, staying `PENDING` below 3 attempts and flipping to `FAILED` exactly on the 3rd; one row's forced failure doesn't prevent a second, healthy row's delivery from being sent in the same run; non-`EMAIL` channel rows and non-`PENDING` status rows are never touched; a 101st eligible row is left untouched by the 100-row cap (only verify the cap is applied — not that it's exactly 100, to avoid a brittle magic-number-matching test).
- A throwing test double for the email provider (implementing `EmailProvider`, always rejecting) is added alongside `MemoryEmailProvider` for the failure-path tests — a small addition to `email.provider.ts` or inline in the test file, implementer's call based on whether it's reusable elsewhere.
