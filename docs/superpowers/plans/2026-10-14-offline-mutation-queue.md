# Offline Mutation Queue Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Attendance and checklist "mark today" writes made while offline queue in IndexedDB and replay automatically when connectivity returns.

**Architecture:** The API gains an optional `clientMutationId` idempotency key on the two mark endpoints (the DB columns/unique indexes already exist). A new `apps/web/src/lib/offline-queue.ts` module (IndexedDB via `idb`) stores queued writes and drains them on an `online` event. The two mutation hooks catch `ApiError`'s existing `"NETWORK_ERROR"` code, enqueue instead of erroring, and optimistically patch the React Query cache; the two "today" pages render a small pending badge for any row whose key is in the queue.

**Tech Stack:** `idb` (new, promise-based IndexedDB wrapper), `fake-indexeddb` (new, test-only, polyfills `indexedDB` under Vitest/jsdom).

## Global Constraints

- In scope: only `PUT /households/:householdId/attendance/:househelpId` and `PUT /households/:householdId/checklist/:taskId/completion`. Clearing a mark and the bulk mark-remaining-present action are out of scope.
- `clientMutationId` is purely a replay-idempotency guard (dedup against a retried request) — it introduces no new conflict-resolution logic. Last-write-wins stays exactly as it already works for two independent online writes today.
- No DB migration needed — `attendanceRecords.clientMutationId` and `checklistCompletions.clientMutationId` (plus their per-household unique indexes) already exist in `apps/api/src/db/schema.ts`.
- Replay trigger: `window`'s `online` event, plus one drain attempt on initial app load. No Background Sync API (no Safari/iOS support).
- Pending-key format: `` `attendance:${househelpId}:${date}` `` / `` `checklist:${taskId}:${date}` ``.

---

### Task 1: API idempotency for both mark endpoints

**Files:**
- Modify: `packages/shared/src/schemas.ts` (`markAttendanceSchema` at line 121, `markCompletionSchema` at line 219)
- Modify: `apps/api/src/services/attendance.service.ts` (`setAttendance`, lines 74-105)
- Modify: `apps/api/src/services/checklist-completion.service.ts` (`markCompletion`, lines 71-102)
- Test: `apps/api/tests/attendance.test.ts`, `apps/api/tests/checklist-completion.test.ts`

**Interfaces:**
- Produces: `MarkAttendanceInput`/`MarkCompletionInput` both gain an optional `clientMutationId: string`. Both services accept and use it identically — no other task depends on new names here.

- [ ] **Step 1: Write the failing tests**

Add to `apps/api/tests/attendance.test.ts`, inside `describe("attendance — today marking", ...)`:

```typescript
  it("a repeated clientMutationId returns the original row without a second audit entry", async () => {
    const owner = await signupUser(ctx);
    const h = await createHousehold(ctx, owner.cookie);
    const help = await createHousehelp(ctx, owner.cookie, h.id);
    const first = await ctx.request.put(`/api/households/${h.id}/attendance/${help.id}`).set(csrf).set("cookie", owner.cookie)
      .send({ date: "2026-09-28", status: "ABSENT", clientMutationId: "11111111-1111-1111-1111-111111111111" });
    expect(first.status).toBe(200);
    const replay = await ctx.request.put(`/api/households/${h.id}/attendance/${help.id}`).set(csrf).set("cookie", owner.cookie)
      .send({ date: "2026-09-28", status: "PRESENT", clientMutationId: "11111111-1111-1111-1111-111111111111" });
    expect(replay.status).toBe(200);
    expect(replay.body.data).toEqual(first.body.data); // returns the ORIGINAL (ABSENT), not re-applied as PRESENT
    const logs = await ctx.db.select().from(auditLogs).where(and(eq(auditLogs.householdId, h.id), eq(auditLogs.action, "attendance.corrected")));
    expect(logs).toHaveLength(1);
  });

  it("a different clientMutationId for the same date still upserts normally (last write wins)", async () => {
    const owner = await signupUser(ctx);
    const h = await createHousehold(ctx, owner.cookie);
    const help = await createHousehelp(ctx, owner.cookie, h.id);
    await ctx.request.put(`/api/households/${h.id}/attendance/${help.id}`).set(csrf).set("cookie", owner.cookie)
      .send({ date: "2026-09-28", status: "ABSENT", clientMutationId: "22222222-2222-2222-2222-222222222222" });
    const second = await ctx.request.put(`/api/households/${h.id}/attendance/${help.id}`).set(csrf).set("cookie", owner.cookie)
      .send({ date: "2026-09-28", status: "PRESENT", clientMutationId: "33333333-3333-3333-3333-333333333333" });
    expect(second.status).toBe(200);
    expect(second.body.data.status).toBe("PRESENT");
  });
```

Add to `apps/api/tests/checklist-completion.test.ts`, inside `describe("checklist completion — today marking", ...)` (the file already defines `createHousehold(c, cookie, name?)` and `createTask(c, cookie, householdId, body?)` exactly as used below — confirmed from the file's current content):

```typescript
  it("a repeated clientMutationId returns the original row without a second audit entry", async () => {
    const owner = await signupUser(ctx);
    const h = await createHousehold(ctx, owner.cookie);
    const task = await createTask(ctx, owner.cookie, h.id);
    const first = await ctx.request.put(`/api/households/${h.id}/checklist/${task.id}/completion`).set(csrf).set("cookie", owner.cookie)
      .send({ date: "2026-09-28", status: "SKIPPED", clientMutationId: "44444444-4444-4444-4444-444444444444" });
    expect(first.status).toBe(200);
    const replay = await ctx.request.put(`/api/households/${h.id}/checklist/${task.id}/completion`).set(csrf).set("cookie", owner.cookie)
      .send({ date: "2026-09-28", status: "COMPLETED", clientMutationId: "44444444-4444-4444-4444-444444444444" });
    expect(replay.status).toBe(200);
    expect(replay.body.data).toEqual(first.body.data);
    const logs = await ctx.db.select().from(auditLogs).where(and(eq(auditLogs.householdId, h.id), eq(auditLogs.action, "checklist.completionCorrected")));
    expect(logs).toHaveLength(1);
  });

  it("a different clientMutationId for the same date still upserts normally (last write wins)", async () => {
    const owner = await signupUser(ctx);
    const h = await createHousehold(ctx, owner.cookie);
    const task = await createTask(ctx, owner.cookie, h.id);
    await ctx.request.put(`/api/households/${h.id}/checklist/${task.id}/completion`).set(csrf).set("cookie", owner.cookie)
      .send({ date: "2026-09-28", status: "SKIPPED", clientMutationId: "55555555-5555-5555-5555-555555555555" });
    const second = await ctx.request.put(`/api/households/${h.id}/checklist/${task.id}/completion`).set(csrf).set("cookie", owner.cookie)
      .send({ date: "2026-09-28", status: "COMPLETED", clientMutationId: "66666666-6666-6666-6666-666666666666" });
    expect(second.status).toBe(200);
    expect(second.body.data.status).toBe("COMPLETED");
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd apps/api && npm run test -- attendance checklist-completion`
Expected: FAIL — the replay test gets back the re-applied `PRESENT`/`COMPLETED` value instead of the original, and/or 2 audit entries instead of 1 (there's no `clientMutationId` handling yet, so every call is just a normal correction).

- [ ] **Step 3: Add `clientMutationId` to both schemas**

In `packages/shared/src/schemas.ts`, change `markAttendanceSchema` (around line 121-125):

```typescript
export const markAttendanceSchema = z.object({
  date: dateSchema,
  status: attendanceStatusSchema,
  note: z.string().trim().max(500).optional(),
  clientMutationId: z.string().uuid().optional(),
});
```

Change `markCompletionSchema` (around line 219-223):

```typescript
export const markCompletionSchema = z.object({
  date: dateSchema,
  status: z.enum(["COMPLETED", "SKIPPED"]),
  note: z.string().trim().max(500).optional(),
  clientMutationId: z.string().uuid().optional(),
});
```

Run: `cd packages/shared && npm run build`

- [ ] **Step 4: Add the idempotency check to `setAttendance`**

In `apps/api/src/services/attendance.service.ts`, inside `setAttendance` (the function starting at line 74), add this check immediately after the `assertWritable`/`requireHousehelpInHousehold` calls and before the `deps.db.transaction(...)` call:

```typescript
  if (input.clientMutationId) {
    const [already] = await deps.db.select().from(attendanceRecords)
      .where(and(eq(attendanceRecords.householdId, membership.householdId), eq(attendanceRecords.clientMutationId, input.clientMutationId)));
    if (already) return toRecordDTO(already);
  }
```

Then, inside the transaction's `tx.insert(attendanceRecords).values({...})` call, add `clientMutationId: input.clientMutationId ?? null,` to the values object, and to the matching `.onConflictDoUpdate({ set: {...} })` object add `clientMutationId: input.clientMutationId ?? null,` as well (so a plain online correction without a `clientMutationId` doesn't accidentally retain a stale one from a previous write on that same date).

- [ ] **Step 5: Add the same idempotency check to `markCompletion`**

In `apps/api/src/services/checklist-completion.service.ts`, inside `markCompletion` (starting at line 71), add this check immediately after `requireTaskInHousehold` and before the transaction:

```typescript
  if (input.clientMutationId) {
    const [already] = await deps.db.select().from(checklistCompletions)
      .where(and(eq(checklistCompletions.householdId, membership.householdId), eq(checklistCompletions.clientMutationId, input.clientMutationId)));
    if (already) return toRecordDTO(already);
  }
```

Then add `clientMutationId: input.clientMutationId ?? null,` to both the `tx.insert(checklistCompletions).values({...})` object and its `.onConflictDoUpdate({ set: {...} })` object, same reasoning as Step 4.

- [ ] **Step 6: Run the tests to verify they pass**

Run: `cd apps/api && npm run test -- attendance checklist-completion`
Expected: PASS (all tests in both files)

- [ ] **Step 7: Typecheck and build**

Run: `cd apps/api && npm run typecheck` then `cd apps/api && npm run build`
Expected: both PASS (typecheck may show the 2 pre-existing unrelated failures already known from earlier work in this session — `bill-category.test.ts`/`bill.test.ts` — those are not yours to fix)

- [ ] **Step 8: Commit**

```bash
git add packages/shared/src/schemas.ts apps/api/src/services/attendance.service.ts apps/api/src/services/checklist-completion.service.ts apps/api/tests/attendance.test.ts apps/api/tests/checklist-completion.test.ts
git commit -m "feat(api): clientMutationId idempotency for attendance and checklist marks"
```

---

### Task 2: Client-side offline queue module

**Files:**
- Modify: `apps/web/package.json` (add `idb` devDependency... actually a runtime dependency — the app uses it at runtime, not just in tests; add it under `"dependencies"`. Add `fake-indexeddb` under `"devDependencies"`, test-only.)
- Create: `apps/web/src/lib/offline-queue.ts`
- Test: `apps/web/src/lib/offline-queue.test.ts`

**Interfaces:**
- Produces: `enqueueMutation(item: Omit<QueuedMutation, "id">): Promise<void>`, `drainQueue(qc: QueryClient): Promise<SyncFailure[]>`, `getPendingKeysSnapshot(): ReadonlySet<string>`, `subscribePendingKeys(listener: () => void): () => void`, `usePendingKeys(): ReadonlySet<string>` (a React hook). `QueuedMutation = { id?: number; type: "attendance" | "checklist"; householdId: string; clientMutationId: string; endpoint: string; body: Record<string, unknown>; pendingKey: string; createdAt: string }`. `SyncFailure = { pendingKey: string; message: string }`.
- Consumes: `ApiError`, `put` (both existing, `apps/web/src/lib/api.ts`). `QueryClient` type (existing, `@tanstack/react-query`).

- [ ] **Step 1: Install dependencies**

```bash
cd apps/web && npm install idb && npm install -D fake-indexeddb
```

- [ ] **Step 2: Write the failing tests**

```typescript
// apps/web/src/lib/offline-queue.test.ts
import "fake-indexeddb/auto";
import { IDBFactory } from "fake-indexeddb";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { QueryClient } from "@tanstack/react-query";
import { drainQueue, enqueueMutation, getPendingKeysSnapshot } from "./offline-queue";

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

const ITEM = {
  type: "attendance" as const, householdId: "h1", clientMutationId: "m1",
  endpoint: "/households/h1/attendance/hh1", body: { date: "2026-10-14", status: "PRESENT" },
  pendingKey: "attendance:hh1:2026-10-14", createdAt: "2026-10-14T00:00:00.000Z",
};

describe("offline-queue", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    // Fresh fake IndexedDB per test — without this, items from one test leak into the next
    // (the module never caches a single DB connection, but the underlying fake storage is
    // otherwise shared across the whole file).
    (globalThis as unknown as { indexedDB: IDBFactory }).indexedDB = new IDBFactory();
  });
  afterEach(() => { vi.restoreAllMocks(); });

  it("enqueues a mutation and exposes its pending key", async () => {
    await enqueueMutation(ITEM);
    expect(getPendingKeysSnapshot().has("attendance:hh1:2026-10-14")).toBe(true);
  });

  it("drains a queued mutation on success, clearing its pending key and invalidating the query", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(jsonResponse({ success: true, data: { date: "2026-10-14", status: "PRESENT", note: null }, message: null }));
    await enqueueMutation(ITEM);
    const qc = new QueryClient();
    const invalidateSpy = vi.spyOn(qc, "invalidateQueries");
    const failures = await drainQueue(qc);
    expect(failures).toEqual([]);
    expect(getPendingKeysSnapshot().has("attendance:hh1:2026-10-14")).toBe(false);
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ["attendance", "today", "h1"] });
  });

  it("stops draining on a network error, leaving the item queued", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new TypeError("Failed to fetch"));
    await enqueueMutation(ITEM);
    const qc = new QueryClient();
    const failures = await drainQueue(qc);
    expect(failures).toEqual([]);
    expect(getPendingKeysSnapshot().has("attendance:hh1:2026-10-14")).toBe(true);
  });

  it("drops an item and reports it on a non-network error, then continues", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(jsonResponse({ success: false, error: { code: "FORBIDDEN", message: "You don't have permission to do that." } }, 403));
    await enqueueMutation(ITEM);
    const qc = new QueryClient();
    const failures = await drainQueue(qc);
    expect(failures).toEqual([{ pendingKey: "attendance:hh1:2026-10-14", message: "You don't have permission to do that." }]);
    expect(getPendingKeysSnapshot().has("attendance:hh1:2026-10-14")).toBe(false);
  });
});
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `cd apps/web && npm run test -- offline-queue`
Expected: FAIL — `./offline-queue` doesn't exist yet.

- [ ] **Step 4: Implement the module**

```typescript
// apps/web/src/lib/offline-queue.ts
import { openDB, type DBSchema, type IDBPDatabase } from "idb";
import type { QueryClient } from "@tanstack/react-query";
import { useSyncExternalStore } from "react";
import { ApiError, put } from "./api";

export type QueuedMutationType = "attendance" | "checklist";

export type QueuedMutation = {
  id?: number;
  type: QueuedMutationType;
  householdId: string;
  clientMutationId: string;
  endpoint: string;
  body: Record<string, unknown>;
  pendingKey: string;
  createdAt: string;
};

export type SyncFailure = { pendingKey: string; message: string };

interface QueueDB extends DBSchema {
  mutations: { key: number; value: QueuedMutation };
}

const DB_NAME = "ghar-offline-queue";
const STORE_NAME = "mutations";

// Intentionally not cached at module scope: tests swap out `globalThis.indexedDB` between
// cases to get a clean store, and a cached connection would keep pointing at the old one.
function getDb(): Promise<IDBPDatabase<QueueDB>> {
  return openDB<QueueDB>(DB_NAME, 1, {
    upgrade(db) {
      if (!db.objectStoreNames.contains(STORE_NAME)) db.createObjectStore(STORE_NAME, { keyPath: "id", autoIncrement: true });
    },
  });
}

// Pending-key store as a tiny external store (not React state) — `offline-queue.ts` has no
// React dependency of its own otherwise, and this needs to be readable from plain hook code.
let pendingKeys: ReadonlySet<string> = new Set();
const listeners = new Set<() => void>();

function notify(): void {
  listeners.forEach((listener) => listener());
}

function addPendingKey(key: string): void {
  const next = new Set(pendingKeys);
  next.add(key);
  pendingKeys = next;
  notify();
}

function removePendingKey(key: string): void {
  const next = new Set(pendingKeys);
  next.delete(key);
  pendingKeys = next;
  notify();
}

export function getPendingKeysSnapshot(): ReadonlySet<string> {
  return pendingKeys;
}

export function subscribePendingKeys(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function usePendingKeys(): ReadonlySet<string> {
  return useSyncExternalStore(subscribePendingKeys, getPendingKeysSnapshot, getPendingKeysSnapshot);
}

export async function enqueueMutation(item: Omit<QueuedMutation, "id">): Promise<void> {
  const db = await getDb();
  await db.add(STORE_NAME, item as QueuedMutation);
  addPendingKey(item.pendingKey);
}

function queryKeyFor(item: QueuedMutation): readonly [string, string, string] {
  return item.type === "attendance" ? (["attendance", "today", item.householdId] as const) : (["checklist", "today", item.householdId] as const);
}

export async function drainQueue(qc: QueryClient): Promise<SyncFailure[]> {
  const db = await getDb();
  const failures: SyncFailure[] = [];
  const items = await db.getAll(STORE_NAME);
  for (const item of items) {
    try {
      await put(item.endpoint, item.body);
      await db.delete(STORE_NAME, item.id!);
      removePendingKey(item.pendingKey);
      await qc.invalidateQueries({ queryKey: queryKeyFor(item) });
    } catch (err) {
      if (err instanceof ApiError && err.code === "NETWORK_ERROR") break;
      await db.delete(STORE_NAME, item.id!);
      removePendingKey(item.pendingKey);
      failures.push({ pendingKey: item.pendingKey, message: err instanceof ApiError ? err.message : "Sync failed." });
    }
  }
  return failures;
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `cd apps/web && npm run test -- offline-queue`
Expected: PASS (all 4 tests)

- [ ] **Step 6: Typecheck**

Run: `cd apps/web && npm run typecheck`
Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add apps/web/package.json package-lock.json apps/web/src/lib/offline-queue.ts apps/web/src/lib/offline-queue.test.ts
git commit -m "feat(web): IndexedDB-backed offline mutation queue"
```

---

### Task 3: Hook integration, pending badges, and wiring

**Files:**
- Modify: `apps/web/src/features/app/attendance/useAttendance.ts` (`useSetAttendance`, lines 20-27)
- Modify: `apps/web/src/features/app/checklist/useChecklistCompletion.ts` (`useMarkCompletion`, lines 19-26)
- Modify: `apps/web/src/features/app/attendance/TodayPage.tsx`
- Modify: `apps/web/src/features/app/checklist/ChecklistTodayPage.tsx`
- Modify: `apps/web/src/main.tsx`
- Test: `apps/web/src/features/app/attendance/TodayPage.test.tsx`, `apps/web/src/features/app/checklist/ChecklistTodayPage.test.tsx`

**Interfaces:**
- Consumes: `enqueueMutation`, `usePendingKeys`, `drainQueue` (Task 2). `clientMutationId` field (Task 1).

- [ ] **Step 1: Write the failing tests**

Both test files currently call `fetch` directly against jsdom, which has no native IndexedDB — add `import "fake-indexeddb/auto";` as the very first import in both files (before any other import) so `enqueueMutation`'s `openDB()` call has something to talk to.

Add this test to `apps/web/src/features/app/attendance/TodayPage.test.tsx`, inside the existing `describe("TodayPage", ...)` block:

```typescript
  it("queues the mark and shows a pending badge when the PUT fails with a network error", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation((async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/households/h1")) return jsonResponse({ success: true, data: { ...HOUSEHOLD, permissions: ["attendance.view", "attendance.mark"] }, message: null });
      if (init?.method === "PUT" && url.includes("/attendance/hh1")) throw new TypeError("Failed to fetch");
      if (url.endsWith("/attendance/today")) {
        return jsonResponse({ success: true, data: { date: "2026-09-29", entries: [{ househelpId: "hh1", name: "Sunita", roleTitle: "Cook", scheduledToday: true, status: null, note: null }] } }, 200);
      }
      throw new Error(`unexpected fetch ${url}`);
    }) as typeof fetch);
    renderPage();
    const row = await screen.findByText("Sunita");
    await userEvent.click(row);
    expect(await screen.findByLabelText("Not yet synced")).toBeInTheDocument();
  });
```

Add this test to `apps/web/src/features/app/checklist/ChecklistTodayPage.test.tsx`, inside the existing `describe("ChecklistTodayPage", ...)` block:

```typescript
  it("queues the mark and shows a pending badge when the PUT fails with a network error", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation((async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/households/h1")) return jsonResponse({ success: true, data: { ...HOUSEHOLD, permissions: ["checklists.view", "checklists.complete"] }, message: null });
      if (init?.method === "PUT" && url.includes("/checklist/t1/completion")) throw new TypeError("Failed to fetch");
      if (url.endsWith("/checklist/today")) {
        return jsonResponse({ success: true, data: { date: "2026-09-30", entries: [{ taskId: "t1", name: "Wash dishes", status: null, note: null }] } }, 200);
      }
      throw new Error(`unexpected fetch ${url}`);
    }) as typeof fetch);
    renderPage();
    const row = await screen.findByText("Wash dishes");
    await userEvent.click(row);
    expect(await screen.findByLabelText("Not yet synced")).toBeInTheDocument();
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd apps/web && npm run test -- TodayPage ChecklistTodayPage`
Expected: FAIL — no pending badge exists yet, and a network-error PUT currently surfaces as a visible error alert, not a queued+optimistic update.

- [ ] **Step 3: Update `useSetAttendance`**

In `apps/web/src/features/app/attendance/useAttendance.ts`, add two import lines: `import { ApiError } from "../../../lib/api";` (alongside the existing `import { del, get, post, put } from "../../../lib/api";`) and `import { enqueueMutation } from "../../../lib/offline-queue";`. `TodayAttendanceDTO` is already imported from `@household/shared` in this file (used by `useTodayAttendance`) — no change needed there.

Replace `useSetAttendance`:

```typescript
export function useSetAttendance(householdId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ househelpId, body }: { househelpId: string; body: MarkAttendanceInput }) => {
      try {
        return await put<AttendanceRecordDTO>(`/households/${householdId}/attendance/${househelpId}`, body);
      } catch (err) {
        if (!(err instanceof ApiError) || err.code !== "NETWORK_ERROR") throw err;
        const clientMutationId = crypto.randomUUID();
        await enqueueMutation({
          type: "attendance", householdId, clientMutationId,
          endpoint: `/households/${householdId}/attendance/${househelpId}`,
          body: { ...body, clientMutationId },
          pendingKey: `attendance:${househelpId}:${body.date}`,
          createdAt: new Date().toISOString(),
        });
        const optimistic: AttendanceRecordDTO = { date: body.date, status: body.status, note: body.note ?? null };
        qc.setQueryData(["attendance", "today", householdId], (old: TodayAttendanceDTO | undefined) =>
          old ? { ...old, entries: old.entries.map((e) => (e.househelpId === househelpId ? { ...e, status: optimistic.status, note: optimistic.note } : e)) } : old);
        return { data: optimistic, message: null };
      }
    },
    onSuccess: (_data, { househelpId }) => invalidateAttendance(qc, householdId, househelpId),
  });
}
```

- [ ] **Step 4: Update `useMarkCompletion`**

In `apps/web/src/features/app/checklist/useChecklistCompletion.ts`, add `import { ApiError } from "../../../lib/api";` and `import { enqueueMutation } from "../../../lib/offline-queue";`. Replace `useMarkCompletion`:

```typescript
export function useMarkCompletion(householdId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ taskId, body }: { taskId: string; body: MarkCompletionInput }) => {
      try {
        return await put<ChecklistCompletionRecordDTO>(`/households/${householdId}/checklist/${taskId}/completion`, body);
      } catch (err) {
        if (!(err instanceof ApiError) || err.code !== "NETWORK_ERROR") throw err;
        const clientMutationId = crypto.randomUUID();
        await enqueueMutation({
          type: "checklist", householdId, clientMutationId,
          endpoint: `/households/${householdId}/checklist/${taskId}/completion`,
          body: { ...body, clientMutationId },
          pendingKey: `checklist:${taskId}:${body.date}`,
          createdAt: new Date().toISOString(),
        });
        const optimistic: ChecklistCompletionRecordDTO = { date: body.date, status: body.status, note: body.note ?? null };
        qc.setQueryData(["checklist", "today", householdId], (old: TodayChecklistDTO | undefined) =>
          old ? { ...old, entries: old.entries.map((e) => (e.taskId === taskId ? { ...e, status: optimistic.status, note: optimistic.note } : e)) } : old);
        return { data: optimistic, message: null };
      }
    },
    onSuccess: () => invalidateChecklist(qc, householdId),
  });
}
```

`TodayChecklistDTO` is already imported from `@household/shared` in this file — no change needed there.

- [ ] **Step 5: Add the pending badge to `TodayPage.tsx`**

Add `import { usePendingKeys } from "../../../lib/offline-queue";` and, inside the component, `const pendingKeys = usePendingKeys();`. In the `entries.map((e) => ...)` block, right after the existing status `<span className="badge ...">` element (the one showing `STATUS_LABEL[e.status]`), add:

```tsx
              {pendingKeys.has(`attendance:${e.househelpId}:${date}`) && (
                <span className="badge badge--muted" aria-label="Not yet synced" title="Will sync when you're back online">⏳</span>
              )}
```

- [ ] **Step 6: Add the pending badge to `ChecklistTodayPage.tsx`**

Same pattern: `import { usePendingKeys } from "../../../lib/offline-queue";`, `const pendingKeys = usePendingKeys();`, and after the existing status badge button:

```tsx
              {pendingKeys.has(`checklist:${e.taskId}:${date}`) && (
                <span className="badge badge--muted" aria-label="Not yet synced" title="Will sync when you're back online">⏳</span>
              )}
```

- [ ] **Step 7: Wire the replay trigger in `main.tsx`**

In `apps/web/src/main.tsx`, add:

```typescript
import { drainQueue } from "./lib/offline-queue";
```

After `const queryClient = new QueryClient({...});`, add:

```typescript
window.addEventListener("online", () => void drainQueue(queryClient));
void drainQueue(queryClient);
```

(The unconditional call on load handles the case where items were queued in a previous session and the app is reopened already-online — `drainQueue` is a no-op if the queue is empty.)

- [ ] **Step 8: Run the tests to verify they pass**

Run: `cd apps/web && npm run test -- TodayPage ChecklistTodayPage`
Expected: PASS (all tests in both files)

- [ ] **Step 9: Run the full web test suite as a regression check**

Run: `cd apps/web && npm run test`
Expected: PASS, no regressions

- [ ] **Step 10: Typecheck**

Run: `cd apps/web && npm run typecheck`
Expected: PASS

- [ ] **Step 11: Commit**

```bash
git add apps/web/src/features/app/attendance/useAttendance.ts apps/web/src/features/app/checklist/useChecklistCompletion.ts apps/web/src/features/app/attendance/TodayPage.tsx apps/web/src/features/app/checklist/ChecklistTodayPage.tsx apps/web/src/features/app/attendance/TodayPage.test.tsx apps/web/src/features/app/checklist/ChecklistTodayPage.test.tsx apps/web/src/main.tsx
git commit -m "feat(web): queue attendance/checklist marks offline, with a pending-sync badge"
```

---

## Self-Review Notes

- **Spec coverage:** API idempotency (Task 1), IndexedDB queue + drain/failure semantics (Task 2), hook integration + optimistic UI + pending badge + online-event wiring (Task 3) — every spec section has a task.
- **Placeholder scan:** every step has concrete code. Two spots intentionally defer an exact detail to the implementer with explicit instructions on how to resolve it rather than guessing: Task 1 Step 1 (checklist test helper names — "read the file first"), Task 3 Step 1 (exact fetch-mock shape in two existing test files — "read the file first"). Both are existing-file inspections, not vague design decisions.
- **Type consistency:** `QueuedMutation`'s fields match between Task 2's module and Task 3's two call sites (`type`, `householdId`, `clientMutationId`, `endpoint`, `body`, `pendingKey`, `createdAt`). Pending-key format (`attendance:${househelpId}:${date}` / `checklist:${taskId}:${date}`) matches exactly between Task 3's hook code (Steps 3-4) and its badge-rendering code (Steps 5-6).
