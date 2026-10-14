# Offline Mutation Queue — Design Spec

**Phase:** 9 (PWA, offline cache and mutation queue, mobile polish) — Spec 2 of 3.

**Status:** Approved.

## Context

Phase 9 Spec 1 (PWA shell, shipped) made the app installable and load instantly offline, but writes made while offline still just fail. The `attendanceRecords` and `checklistCompletions` tables already carry a `clientMutationId` column with a per-household unique index (`attendance_client_mutation_uq`, `checklist_completions_client_mutation_uq`) — pre-seeded groundwork from an earlier phase — but nothing reads or writes it anywhere: not the Zod schemas, not the services, not any frontend hook. This spec is the first thing to actually use it.

## Scope

Only the two "mark today" writes:
- `PUT /households/:householdId/attendance/:househelpId` (`attendance.service.ts`'s `setAttendance`, called by `useSetAttendance` in `apps/web/src/features/app/attendance/useAttendance.ts`)
- `PUT /households/:householdId/checklist/:taskId/completion` (`checklist-completion.service.ts`'s `markCompletion`, called by `useMarkCompletion` in `apps/web/src/features/app/checklist/useChecklistCompletion.ts`)

**Explicitly out of scope:** clearing a mark (`clearAttendance`/`clearCompletion`), the bulk mark-remaining-present action, and any read/GET caching (that's Spec 1's territory, already decided against).

## Idempotency (API)

Add optional `clientMutationId: z.string().uuid().optional()` to `markAttendanceSchema` and `markCompletionSchema`. In `setAttendance`/`markCompletion`, when `clientMutationId` is present: before doing anything else, look up whether a row already exists for this household with that `clientMutationId` (the existing unique index). If found, return it as-is — no re-upsert, no duplicate audit entry. This is purely a guard against a replay being retried after a dropped network ack (the client sent it once, lost the response, and retries); it does **not** add any new conflict-resolution logic. The existing upsert-by-`(househelpId, date)` / `(taskId, date)` behavior is untouched — if the same day was independently marked by someone else before a queued write replays, last write wins, exactly as it already does for two normal online writes today.

## Client-side queue

New module `apps/web/src/lib/offline-queue.ts`, backed by IndexedDB via the `idb` package (a small promise-based wrapper — hand-rolling raw IndexedDB's callback API for two mutation types isn't worth it; flag this as a new dependency to verify installs cleanly, same spirit as Spec 1's Vite-version compatibility check).

Each queued item: `{ id: number (IndexedDB autoincrement); type: "attendance" | "checklist"; clientMutationId: string; endpoint: string; body: unknown; createdAt: string }`.

Exports:
- `enqueueMutation(item): Promise<void>` — writes to IndexedDB and adds the item's pending-key to an in-memory `Set` (see below).
- `drainQueue(): Promise<void>` — walks the queue in insertion order; for each item, POSTs/PUTs `endpoint` with `body`; on success, deletes it from IndexedDB, removes its pending-key, and invalidates the relevant React Query key; on a `NETWORK_ERROR` failure, stops draining entirely (still offline — the next `online` event retries from the top); on any other error (e.g. a real 403), deletes the item from IndexedDB, removes its pending-key, and adds a message to a `syncFailures` list for the caller to surface, then continues with the next item.
- `usePendingKeys(): Set<string>` — a small hook (subscribes to the in-memory pending-key `Set` via a plain pub-sub, not a React Query cache) that pages use to render a "not yet synced" badge. Pending-key format: `` `attendance:${househelpId}:${date}` `` / `` `checklist:${taskId}:${date}` ``.

Wiring: `window.addEventListener("online", drainQueue)`, registered once from `apps/web/src/main.tsx`. Also call `drainQueue()` once on initial app load (covers the case where items were queued in a previous session that's reopened already-online).

## Frontend hook changes

`useSetAttendance` and `useMarkCompletion` both gain a `onError` check: if `err instanceof ApiError && err.code === "NETWORK_ERROR"`, instead of surfacing the error, generate a `clientMutationId` (`crypto.randomUUID()`), call `enqueueMutation(...)`, optimistically write the new status directly into the relevant React Query cache entry (`["attendance", "today", ...]` / `["checklist", "today", ...]`, matching the shape `TodayAttendanceDTO`/`TodayChecklistDTO` already use), and resolve successfully from the mutation's point of view (no error state shown to the calling page). The calling pages (`TodayPage.tsx`, `ChecklistTodayPage.tsx`) need one small addition each: render a small "sync pending" indicator (icon/dot) on any row whose pending-key is in `usePendingKeys()`.

## Testing

- API: `markAttendanceSchema`/`markCompletionSchema` accept and ignore an absent `clientMutationId`; a repeated call with the same `clientMutationId` returns the original row and writes no second audit entry; two different `clientMutationId`s for the same date still upsert normally (last write wins, matching existing behavior); a `clientMutationId` already used by a different household doesn't collide (the unique index is per-household).
- Web: `offline-queue.ts` is tested as a pure module against a fake IndexedDB (via the `fake-indexeddb` test-only package) — enqueue, drain success, drain stops on `NETWORK_ERROR`, drain drops and reports a non-network error. The two mutation hooks are tested for the "goes offline mid-mark" path: a mocked `fetch` rejection surfaces as queued + optimistic update, not an error. A page-level test confirms the pending badge appears/disappears around a queued-then-replayed write.
