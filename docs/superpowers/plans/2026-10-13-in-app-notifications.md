# Phase 7 Spec 4 — In-App Notifications Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Surface the `notifications` rows Spec 3's `evaluate-reminders` job already writes: list/unread-count/read/dismiss/mark-all-read API endpoints, a `/notifications` web page, and bell+badge entry points in the desktop sidebar and mobile More page.

**Architecture:** A new `notification.service.ts` resolves each notification's deep-link path server-side (BILL rows store an occurrence id but link to `/bills/:billId`; SALARY rows link straight to `/salary/:settlementId`) so the web client never branches on `entityType`. The web side adds one polled unread-count hook (this app's first polling pattern, 60s interval) feeding two badge locations plus the notifications page itself.

**Tech Stack:** Express 5 + Drizzle (API), React 19 + TanStack Query + React Router (web), Vitest + Supertest / Testing Library.

## Global Constraints

- No schema migration — `notifications`/`notification_deliveries` already exist and are written by Spec 3's job.
- No new permission — gate every route on the existing `household.view` (same reasoning as `reminder-rules`' GET: low-sensitivity, per-user, visible to anyone who can see the household).
- Per-user resource: every query/mutation filters by `req.auth!.user.id` in addition to household scoping. A notification that doesn't belong to the caller is a 404, never a 403 (don't leak existence of another user's row).
- List endpoint returns the most recent 50 non-dismissed notifications, no pagination.
- Read/dismiss actions are idempotent — re-marking an already-read/dismissed row is a no-op, not an error.
- Unread-count badge polls every 60 seconds (`refetchInterval: 60_000`) — this is the only query in the app that polls; don't generalize it into a shared utility.
- Per project testing cadence: targeted test files only per task; full suite runs once, at merge time.

---

## File Structure

- Modify: `packages/shared/src/dto.ts` — add `NotificationCategory`, `NotificationSeverity`, `NotificationDTO`.
- Modify: `packages/shared/src/schemas.ts` — add `notificationActionSchema`.
- Create: `apps/api/src/services/notification.service.ts` — list, unread-count, mark-read/dismiss, mark-all-read, and the BILL `linkPath` resolution.
- Modify: `apps/api/src/routes/household.routes.ts` — 4 new routes.
- Create: `apps/api/tests/notification.test.ts`.
- Create: `apps/web/src/features/notifications/useNotifications.ts` — list/unread-count queries, read/dismiss/mark-all-read mutations.
- Create: `apps/web/src/features/notifications/NotificationsPage.tsx`.
- Create: `apps/web/src/features/notifications/NotificationsPage.test.tsx`.
- Create: `apps/web/src/features/notifications/NotificationBadge.tsx` — tiny shared count-pill, used by both entry points.
- Modify: `apps/web/src/App.tsx` — new `/notifications` route.
- Modify: `apps/web/src/features/app/AppShell.tsx`, `apps/web/src/features/app/shell.css` — desktop bell+badge.
- Modify: `apps/web/src/features/app/MorePage.tsx` — mobile Notifications row+badge.
- Create: `apps/web/src/features/app/AppShell.test.tsx`, `apps/web/src/features/app/MorePage.test.tsx`.

---

### Task 1: Backend — notification service, routes, and tests

**Files:**
- Modify: `packages/shared/src/dto.ts` (append after line 116, the end of `ReminderRuleDTO`)
- Modify: `packages/shared/src/schemas.ts` (append after line 375, the end of the reminder-rules section)
- Create: `apps/api/src/services/notification.service.ts`
- Modify: `apps/api/src/routes/household.routes.ts:3` (import line), and append 4 routes after line 450 (the end of the `reminder-rules` block, before `return r;`)
- Test: `apps/api/tests/notification.test.ts`

**Interfaces:**
- Produces: `NotificationDTO = { id: string; category: NotificationCategory; severity: NotificationSeverity; title: string; body: string | null; linkPath: string | null; readAt: string | null; dismissedAt: string | null; createdAt: string }`, `NotificationActionInput = { action: "read" | "dismiss" }` (both exported from `@household/shared`). `listNotifications(deps, userId, membership): Promise<NotificationDTO[]>`, `getUnreadCount(deps, userId, membership): Promise<number>`, `markNotification(deps, userId, membership, notificationId, action): Promise<NotificationDTO>`, `markAllRead(deps, userId, membership): Promise<void>` (all from `notification.service.ts`) — Task 2 does not call these directly (it only consumes the HTTP routes), but later maintainers will.
- Routes: `GET /households/:householdId/notifications`, `GET /households/:householdId/notifications/unread-count` → `{ count: number }`, `PATCH /households/:householdId/notifications/:id` (body `NotificationActionInput`), `POST /households/:householdId/notifications/mark-all-read`.

- [ ] **Step 1: Add the shared types**

In `packages/shared/src/dto.ts`, append after the `ReminderRuleDTO` type (end of file, after line 116):

```typescript

export type NotificationCategory = "BILL" | "SALARY" | "ATTENDANCE" | "CHECKLIST" | "SYSTEM";
export type NotificationSeverity = "INFO" | "SUCCESS" | "WARNING" | "URGENT";

export type NotificationDTO = {
  id: string; category: NotificationCategory; severity: NotificationSeverity;
  title: string; body: string | null; linkPath: string | null;
  readAt: string | null; dismissedAt: string | null; createdAt: string;
};
```

In `packages/shared/src/schemas.ts`, append after the reminder-rules section (end of file, after line 375):

```typescript

export const notificationActionSchema = z.object({ action: z.enum(["read", "dismiss"]) });
export type NotificationActionInput = z.infer<typeof notificationActionSchema>;
```

- [ ] **Step 2: Write the failing test file**

Create `apps/api/tests/notification.test.ts`:

```typescript
import { and, eq, isNull } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { billOccurrences, householdMembers, notifications } from "../src/db/schema.js";
import { createTestContext, csrf, signupUser, truncateAll, type TestContext } from "./helpers.js";

const ctx = createTestContext();

beforeEach(async () => { await truncateAll(ctx.db); });
afterAll(() => ctx.close());

async function createHousehold(c: TestContext, cookie: string, name = "Shah Family") {
  const res = await c.request.post("/api/households").set(csrf).set("cookie", cookie).send({ name });
  expect(res.status).toBe(201);
  return res.body.data as { id: string };
}

async function createBill(h: { id: string }, cookie: string) {
  const res = await ctx.request.post(`/api/households/${h.id}/bills`).set(csrf).set("cookie", cookie)
    .send({ name: "Electricity", frequency: "ONE_TIME", firstDueDate: "2026-09-29", amountPaise: 50000 });
  expect(res.status).toBe(201);
  const bill = res.body.data as { id: string };
  const [occurrence] = await ctx.db.select().from(billOccurrences).where(eq(billOccurrences.billId, bill.id));
  return { bill, occurrence: occurrence! };
}

async function addActiveMember(householdId: string, userId: string) {
  await ctx.db.insert(householdMembers).values({ householdId, userId, role: "MEMBER", status: "ACTIVE" });
}

let seq = 0;
async function insertNotification(householdId: string, userId: string, overrides: Record<string, unknown> = {}) {
  seq += 1;
  const [row] = await ctx.db.insert(notifications).values({
    householdId, userId, category: "BILL", title: "Electricity due in 7 day(s)",
    idempotencyKey: `test-key-${seq}`, ...overrides,
  }).returning();
  return row!;
}

describe("notifications", () => {
  describe("GET /notifications", () => {
    it("lists the caller's non-dismissed notifications, newest first, resolving a BILL linkPath", async () => {
      const owner = await signupUser(ctx);
      const h = await createHousehold(ctx, owner.cookie);
      const { bill, occurrence } = await createBill(h, owner.cookie);
      await insertNotification(h.id, owner.id, { entityType: "bill_occurrence", entityId: occurrence.id });

      const res = await ctx.request.get(`/api/households/${h.id}/notifications`).set("cookie", owner.cookie);
      expect(res.status).toBe(200);
      expect(res.body.data).toHaveLength(1);
      expect(res.body.data[0]).toMatchObject({ category: "BILL", title: "Electricity due in 7 day(s)", linkPath: `/bills/${bill.id}`, readAt: null, dismissedAt: null });
    });

    it("resolves a SALARY notification's linkPath directly from entityId", async () => {
      const owner = await signupUser(ctx);
      const h = await createHousehold(ctx, owner.cookie);
      await insertNotification(h.id, owner.id, { category: "SALARY", entityType: "salary_settlement", entityId: "11111111-1111-1111-1111-111111111111" });

      const res = await ctx.request.get(`/api/households/${h.id}/notifications`).set("cookie", owner.cookie);
      expect(res.body.data[0]).toMatchObject({ linkPath: "/salary/11111111-1111-1111-1111-111111111111" });
    });

    it("returns a null linkPath for a BILL notification whose occurrence no longer exists", async () => {
      const owner = await signupUser(ctx);
      const h = await createHousehold(ctx, owner.cookie);
      await insertNotification(h.id, owner.id, { entityType: "bill_occurrence", entityId: "22222222-2222-2222-2222-222222222222" });

      const res = await ctx.request.get(`/api/households/${h.id}/notifications`).set("cookie", owner.cookie);
      expect(res.body.data[0]).toMatchObject({ linkPath: null });
    });

    it("excludes dismissed notifications but includes read ones", async () => {
      const owner = await signupUser(ctx);
      const h = await createHousehold(ctx, owner.cookie);
      await insertNotification(h.id, owner.id, { dismissedAt: ctx.clock.now() });
      const read = await insertNotification(h.id, owner.id, { readAt: ctx.clock.now() });

      const res = await ctx.request.get(`/api/households/${h.id}/notifications`).set("cookie", owner.cookie);
      expect(res.body.data).toHaveLength(1);
      expect(res.body.data[0].id).toBe(read.id);
      expect(res.body.data[0].readAt).not.toBeNull();
    });

    it("never returns another household member's notifications", async () => {
      const owner = await signupUser(ctx);
      const h = await createHousehold(ctx, owner.cookie);
      const other = await signupUser(ctx);
      await addActiveMember(h.id, other.id);
      await insertNotification(h.id, other.id);

      const res = await ctx.request.get(`/api/households/${h.id}/notifications`).set("cookie", owner.cookie);
      expect(res.body.data).toHaveLength(0);
    });

    it("404s for a non-member", async () => {
      const owner = await signupUser(ctx);
      const h = await createHousehold(ctx, owner.cookie);
      const stranger = await signupUser(ctx);
      const res = await ctx.request.get(`/api/households/${h.id}/notifications`).set("cookie", stranger.cookie);
      expect(res.status).toBe(404);
    });
  });

  describe("GET /notifications/unread-count", () => {
    it("counts only notifications with both readAt and dismissedAt null", async () => {
      const owner = await signupUser(ctx);
      const h = await createHousehold(ctx, owner.cookie);
      await insertNotification(h.id, owner.id);
      await insertNotification(h.id, owner.id);
      await insertNotification(h.id, owner.id, { readAt: ctx.clock.now() });
      await insertNotification(h.id, owner.id, { dismissedAt: ctx.clock.now() });

      const res = await ctx.request.get(`/api/households/${h.id}/notifications/unread-count`).set("cookie", owner.cookie);
      expect(res.status).toBe(200);
      expect(res.body.data).toEqual({ count: 2 });
    });
  });

  describe("PATCH /notifications/:id", () => {
    it("marks a notification read, idempotently", async () => {
      const owner = await signupUser(ctx);
      const h = await createHousehold(ctx, owner.cookie);
      const n = await insertNotification(h.id, owner.id);

      const res1 = await ctx.request.patch(`/api/households/${h.id}/notifications/${n.id}`).set(csrf).set("cookie", owner.cookie).send({ action: "read" });
      expect(res1.status).toBe(200);
      expect(res1.body.data.readAt).not.toBeNull();

      const res2 = await ctx.request.patch(`/api/households/${h.id}/notifications/${n.id}`).set(csrf).set("cookie", owner.cookie).send({ action: "read" });
      expect(res2.status).toBe(200);
      expect(res2.body.data.readAt).toBe(res1.body.data.readAt);
    });

    it("marks a notification dismissed", async () => {
      const owner = await signupUser(ctx);
      const h = await createHousehold(ctx, owner.cookie);
      const n = await insertNotification(h.id, owner.id);

      const res = await ctx.request.patch(`/api/households/${h.id}/notifications/${n.id}`).set(csrf).set("cookie", owner.cookie).send({ action: "dismiss" });
      expect(res.status).toBe(200);
      expect(res.body.data.dismissedAt).not.toBeNull();

      const list = await ctx.request.get(`/api/households/${h.id}/notifications`).set("cookie", owner.cookie);
      expect(list.body.data).toHaveLength(0);
    });

    it("404s for another user's notification, even in the same household", async () => {
      const owner = await signupUser(ctx);
      const h = await createHousehold(ctx, owner.cookie);
      const other = await signupUser(ctx);
      await addActiveMember(h.id, other.id);
      const n = await insertNotification(h.id, other.id);

      const res = await ctx.request.patch(`/api/households/${h.id}/notifications/${n.id}`).set(csrf).set("cookie", owner.cookie).send({ action: "read" });
      expect(res.status).toBe(404);
    });
  });

  describe("POST /notifications/mark-all-read", () => {
    it("marks every unread, non-dismissed notification read for the caller only", async () => {
      const owner = await signupUser(ctx);
      const h = await createHousehold(ctx, owner.cookie);
      const other = await signupUser(ctx);
      await addActiveMember(h.id, other.id);
      const a = await insertNotification(h.id, owner.id);
      const b = await insertNotification(h.id, owner.id, { dismissedAt: ctx.clock.now() });
      const c = await insertNotification(h.id, other.id);

      const res = await ctx.request.post(`/api/households/${h.id}/notifications/mark-all-read`).set(csrf).set("cookie", owner.cookie);
      expect(res.status).toBe(200);

      const rows = await ctx.db.select().from(notifications).where(eq(notifications.householdId, h.id));
      expect(rows.find((r) => r.id === a.id)!.readAt).not.toBeNull();
      expect(rows.find((r) => r.id === b.id)!.readAt).toBeNull(); // dismissed rows aren't touched
      expect(rows.find((r) => r.id === c.id)!.readAt).toBeNull(); // another user's row untouched
    });
  });
});
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `npm run test --workspace @household/api -- notification`
Expected: FAIL — `Cannot find module '../src/services/notification.service.js'` (routes not registered yet either, but the module-not-found error surfaces first since the test file doesn't import the service directly — the failure will actually be 404s from unregistered routes; either way, FAIL is expected).

- [ ] **Step 4: Implement the service**

Create `apps/api/src/services/notification.service.ts`:

```typescript
import { and, count, desc, eq, isNull } from "drizzle-orm";
import type { NotificationActionInput, NotificationDTO } from "@household/shared";
import { billOccurrences, notifications } from "../db/schema.js";
import { Errors } from "../lib/errors.js";
import type { Deps } from "./deps.js";
import type { Membership } from "./household.service.js";

type NotificationRow = typeof notifications.$inferSelect;

/**
 * BILL notifications store the bill OCCURRENCE id as entityId (set by evaluate-reminders.job.ts),
 * but the only bill detail route is /bills/:billId. Resolved here, at read time, rather than
 * touching the job's write-time shape or adding a migration — a SALARY row's entityId already IS
 * the settlement id the /salary/:id route expects, so it passes through unchanged.
 */
async function resolveLinkPath(deps: Deps, row: NotificationRow): Promise<string | null> {
  if (row.entityType === "bill_occurrence" && row.entityId) {
    const [occ] = await deps.db.select({ billId: billOccurrences.billId }).from(billOccurrences).where(eq(billOccurrences.id, row.entityId));
    return occ ? `/bills/${occ.billId}` : null;
  }
  if (row.entityType === "salary_settlement" && row.entityId) {
    return `/salary/${row.entityId}`;
  }
  return null;
}

async function toNotificationDTO(deps: Deps, row: NotificationRow): Promise<NotificationDTO> {
  return {
    id: row.id, category: row.category, severity: row.severity,
    title: row.title, body: row.body, linkPath: await resolveLinkPath(deps, row),
    readAt: row.readAt?.toISOString() ?? null, dismissedAt: row.dismissedAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
  };
}

export async function listNotifications(deps: Deps, userId: string, membership: Membership): Promise<NotificationDTO[]> {
  const rows = await deps.db.select().from(notifications)
    .where(and(eq(notifications.userId, userId), eq(notifications.householdId, membership.householdId), isNull(notifications.dismissedAt)))
    .orderBy(desc(notifications.createdAt))
    .limit(50);
  return Promise.all(rows.map((row) => toNotificationDTO(deps, row)));
}

export async function getUnreadCount(deps: Deps, userId: string, membership: Membership): Promise<number> {
  const [{ n } = { n: 0 }] = await deps.db.select({ n: count() }).from(notifications)
    .where(and(eq(notifications.userId, userId), eq(notifications.householdId, membership.householdId), isNull(notifications.readAt), isNull(notifications.dismissedAt)));
  return Number(n);
}

export async function markNotification(
  deps: Deps, userId: string, membership: Membership, notificationId: string, action: NotificationActionInput["action"],
): Promise<NotificationDTO> {
  const [row] = await deps.db.select().from(notifications)
    .where(and(eq(notifications.userId, userId), eq(notifications.householdId, membership.householdId), eq(notifications.id, notificationId)));
  if (!row) throw Errors.notFound("Notification");

  if (action === "read" && !row.readAt) {
    await deps.db.update(notifications).set({ readAt: new Date() }).where(eq(notifications.id, notificationId));
  } else if (action === "dismiss" && !row.dismissedAt) {
    await deps.db.update(notifications).set({ dismissedAt: new Date() }).where(eq(notifications.id, notificationId));
  }
  const [updated] = await deps.db.select().from(notifications).where(eq(notifications.id, notificationId));
  return toNotificationDTO(deps, updated!);
}

export async function markAllRead(deps: Deps, userId: string, membership: Membership): Promise<void> {
  await deps.db.update(notifications).set({ readAt: new Date() })
    .where(and(eq(notifications.userId, userId), eq(notifications.householdId, membership.householdId), isNull(notifications.readAt), isNull(notifications.dismissedAt)));
}
```

- [ ] **Step 5: Wire the routes**

In `apps/api/src/routes/household.routes.ts`, add `notificationActionSchema` to the existing destructured import from `"@household/shared"` on line 3 (insert alphabetically among the existing names, e.g. right after `monthSchema`), and add a new import line after line 22 (`import * as members from "../services/member.service.js";`):

```typescript
import * as notificationsService from "../services/notification.service.js";
```

Then append these 4 routes right after the `reminder-rules` block (after line 450, the `r.delete("/:householdId/reminder-rules/:ruleId", ...)` block's closing `});`), before the final `return r;`:

```typescript
  r.get("/:householdId/notifications", requireHousehold(deps, "household.view"), async (req, res) => {
    ok(res, await notificationsService.listNotifications(deps, req.auth!.user.id, req.membership!));
  });

  r.get("/:householdId/notifications/unread-count", requireHousehold(deps, "household.view"), async (req, res) => {
    ok(res, { count: await notificationsService.getUnreadCount(deps, req.auth!.user.id, req.membership!) });
  });

  r.patch("/:householdId/notifications/:id", requireHousehold(deps, "household.view"), async (req, res) => {
    const { action } = parseBody(req, notificationActionSchema);
    ok(res, await notificationsService.markNotification(deps, req.auth!.user.id, req.membership!, req.params.id as string, action));
  });

  r.post("/:householdId/notifications/mark-all-read", requireHousehold(deps, "household.view"), async (req, res) => {
    await notificationsService.markAllRead(deps, req.auth!.user.id, req.membership!);
    ok(res, null);
  });
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `npm run test --workspace @household/api -- notification`
Expected: PASS

- [ ] **Step 7: Typecheck and build**

Run: `npm run build --workspace @household/shared && npm run typecheck --workspace @household/api && npm run build --workspace @household/api`
Expected: PASS (ignore the 2 pre-existing, unrelated `TS18048` failures in `tests/bill-category.test.ts`/`tests/bill.test.ts` if `typecheck` surfaces them — confirmed pre-existing on master, not part of this change).

- [ ] **Step 8: Commit**

```bash
git add packages/shared/src/dto.ts packages/shared/src/schemas.ts apps/api/src/services/notification.service.ts apps/api/src/routes/household.routes.ts apps/api/tests/notification.test.ts
git commit -m "feat(api): notifications list/unread-count/read/dismiss endpoints"
```

---

### Task 2: Web — notifications page and hooks

**Files:**
- Create: `apps/web/src/features/notifications/useNotifications.ts`
- Create: `apps/web/src/features/notifications/NotificationsPage.tsx`
- Create: `apps/web/src/features/notifications/NotificationsPage.test.tsx`
- Modify: `apps/web/src/App.tsx` (import + new route)

**Interfaces:**
- Consumes: `NotificationDTO` (Task 1, `@household/shared`), the 4 routes from Task 1.
- Produces: `useNotifications(householdId)`, `useUnreadCount(householdId)`, `useMarkNotificationRead(householdId)`, `useDismissNotification(householdId)`, `useMarkAllRead(householdId)` — all exported from `useNotifications.ts`. Task 3's `AppShell`/`MorePage` badges import `useUnreadCount` from this same file.

- [ ] **Step 1: Write the hooks**

Create `apps/web/src/features/notifications/useNotifications.ts`:

```typescript
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { NotificationDTO } from "@household/shared";
import { get, patch, post } from "../../lib/api";

export function useNotifications(householdId: string | undefined) {
  return useQuery({
    queryKey: ["notifications", householdId],
    queryFn: ({ signal }) => get<NotificationDTO[]>(`/households/${householdId}/notifications`, signal).then((r) => r.data),
    enabled: !!householdId,
  });
}

/** This app's only polled query — don't generalize the interval into a shared utility for one caller. */
export function useUnreadCount(householdId: string | undefined) {
  return useQuery({
    queryKey: ["notifications-unread-count", householdId],
    queryFn: ({ signal }) => get<{ count: number }>(`/households/${householdId}/notifications/unread-count`, signal).then((r) => r.data.count),
    enabled: !!householdId,
    refetchInterval: 60_000,
  });
}

function invalidateNotificationQueries(qc: ReturnType<typeof useQueryClient>, householdId: string) {
  return Promise.all([
    qc.invalidateQueries({ queryKey: ["notifications", householdId] }),
    qc.invalidateQueries({ queryKey: ["notifications-unread-count", householdId] }),
  ]);
}

export function useMarkNotificationRead(householdId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => patch<NotificationDTO>(`/households/${householdId}/notifications/${id}`, { action: "read" }),
    onSuccess: () => invalidateNotificationQueries(qc, householdId),
  });
}

export function useDismissNotification(householdId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => patch<NotificationDTO>(`/households/${householdId}/notifications/${id}`, { action: "dismiss" }),
    onSuccess: () => invalidateNotificationQueries(qc, householdId),
  });
}

export function useMarkAllRead(householdId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => post<null>(`/households/${householdId}/notifications/mark-all-read`),
    onSuccess: () => invalidateNotificationQueries(qc, householdId),
  });
}
```

- [ ] **Step 2: Write the failing test file**

Create `apps/web/src/features/notifications/NotificationsPage.test.tsx`:

```typescript
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { meKey } from "../auth/session";
import { NotificationsPage } from "./NotificationsPage";

const HOUSEHOLD = { id: "h1", name: "Shah Family", timezone: "Asia/Kolkata", role: "OWNER" as const, memberCount: 2 };

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function renderPage() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  qc.setQueryData(meKey, { user: { id: "u1", name: "Parakh", email: "p@example.com", emailVerified: true, createdAt: "2026-01-01T00:00:00.000Z" }, households: [HOUSEHOLD] });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={["/notifications"]}>
        <Routes>
          <Route path="/notifications" element={<NotificationsPage />} />
          <Route path="/bills/:id" element={<div>Bill detail page</div>} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe("NotificationsPage", () => {
  beforeEach(() => { vi.restoreAllMocks(); });
  afterEach(() => { vi.restoreAllMocks(); });

  it("marks a notification read and navigates to its linkPath on tap", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation((async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (init?.method === "PATCH" && url.includes("/notifications/n1")) return jsonResponse({ success: true, data: { id: "n1", category: "BILL", severity: "INFO", title: "Electricity due in 7 day(s)", body: null, linkPath: "/bills/b1", readAt: "2026-09-29T00:00:00.000Z", dismissedAt: null, createdAt: "2026-09-29T00:00:00.000Z" }, message: null });
      if (url.endsWith("/households/h1/notifications")) {
        return jsonResponse({ success: true, data: [{ id: "n1", category: "BILL", severity: "INFO", title: "Electricity due in 7 day(s)", body: null, linkPath: "/bills/b1", readAt: null, dismissedAt: null, createdAt: "2026-09-29T00:00:00.000Z" }] }, 200);
      }
      throw new Error(`unexpected fetch ${url}`);
    }) as typeof fetch);
    renderPage();
    const row = await screen.findByText("Electricity due in 7 day(s)");
    await userEvent.click(row);
    const patchCall = fetchSpy.mock.calls.find(([u, init]) => String(u).includes("/notifications/n1") && (init as RequestInit | undefined)?.method === "PATCH");
    expect(patchCall).toBeDefined();
    expect(JSON.parse((patchCall![1] as RequestInit).body as string)).toEqual({ action: "read" });
    await screen.findByText("Bill detail page");
  });

  it("dismisses a notification, removing it from the list after the post-dismiss refetch", async () => {
    let listCallCount = 0;
    vi.spyOn(globalThis, "fetch").mockImplementation((async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (init?.method === "PATCH" && url.includes("/notifications/n1")) return jsonResponse({ success: true, data: null, message: null });
      if (url.endsWith("/households/h1/notifications")) {
        listCallCount += 1;
        // First call (initial load): the row exists. Second call (after the dismiss mutation
        // invalidates the query, triggering a refetch): the backend would no longer return a
        // dismissed row, so the mock mirrors that real behavior instead of asserting on the PATCH alone.
        const data = listCallCount === 1
          ? [{ id: "n1", category: "BILL", severity: "INFO", title: "Electricity due in 7 day(s)", body: null, linkPath: "/bills/b1", readAt: null, dismissedAt: null, createdAt: "2026-09-29T00:00:00.000Z" }]
          : [];
        return jsonResponse({ success: true, data }, 200);
      }
      throw new Error(`unexpected fetch ${url}`);
    }) as typeof fetch);
    renderPage();
    await screen.findByText("Electricity due in 7 day(s)");
    await userEvent.click(screen.getByRole("button", { name: "Dismiss" }));
    await screen.findByText("No notifications");
  });

  it("shows an empty state when there are no notifications", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation((async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/households/h1/notifications")) return jsonResponse({ success: true, data: [] }, 200);
      throw new Error(`unexpected fetch ${url}`);
    }) as typeof fetch);
    renderPage();
    await screen.findByText("No notifications");
  });
});
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `npm run test --workspace @household/web -- NotificationsPage`
Expected: FAIL — `Cannot find module './NotificationsPage'`.

- [ ] **Step 4: Implement the page**

Create `apps/web/src/features/notifications/NotificationsPage.tsx`:

```tsx
import { useNavigate } from "react-router-dom";
import { Bell, X } from "lucide-react";
import type { NotificationDTO } from "@household/shared";
import { Button } from "../../components/Button";
import { EmptyState } from "../../components/EmptyState";
import { useActiveHousehold } from "../app/useActiveHousehold";
import { useDismissNotification, useMarkAllRead, useMarkNotificationRead, useNotifications } from "./useNotifications";

function relativeTime(iso: string): string {
  const minutes = Math.round((Date.now() - new Date(iso).getTime()) / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

export function NotificationsPage() {
  const { household } = useActiveHousehold();
  const householdId = household?.id;
  const notificationsQuery = useNotifications(householdId);
  const markRead = useMarkNotificationRead(householdId ?? "");
  const dismiss = useDismissNotification(householdId ?? "");
  const markAllRead = useMarkAllRead(householdId ?? "");
  const navigate = useNavigate();

  if (!householdId || !notificationsQuery.data) return null;
  const items = notificationsQuery.data;
  const hasUnread = items.some((n) => !n.readAt);

  function onOpen(n: NotificationDTO) {
    if (!n.readAt) markRead.mutate(n.id);
    if (n.linkPath) navigate(n.linkPath);
  }

  return (
    <>
      <header className="page-head" style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <h1 className="page-title">Notifications</h1>
        <Button variant="ghost" disabled={!hasUnread} onClick={() => markAllRead.mutate()}>Mark all as read</Button>
      </header>

      {items.length === 0 && (
        <div className="card">
          <EmptyState icon={<Bell size={22} />} title="No notifications" text="Reminders about due bills and salary will show up here." />
        </div>
      )}

      <div className="list">
        {items.map((n) => (
          <div key={n.id} className="list__item">
            <button type="button" className="list__text" style={{ textAlign: "left", background: "none", border: 0, padding: 0, cursor: "pointer" }} onClick={() => onOpen(n)}>
              <span className="list__label" style={{ display: "block", fontWeight: n.readAt ? 500 : 700 }}>{n.title}</span>
              {n.body && <span className="list__meta" style={{ display: "block" }}>{n.body}</span>}
              <span className="list__meta">{relativeTime(n.createdAt)}</span>
            </button>
            <button type="button" aria-label="Dismiss" style={{ background: "none", border: 0, cursor: "pointer" }} onClick={() => dismiss.mutate(n.id)}>
              <X size={18} aria-hidden />
            </button>
          </div>
        ))}
      </div>
    </>
  );
}
```

- [ ] **Step 5: Wire the route**

In `apps/web/src/App.tsx`, add the import after `import { MorePage } from "./features/app/MorePage";` (line 27):

```typescript
import { NotificationsPage } from "./features/notifications/NotificationsPage";
```

Add the route after `<Route path="members" element={<MembersPage />} />` (line 65):

```tsx
        <Route path="members" element={<MembersPage />} />
        <Route path="notifications" element={<NotificationsPage />} />
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `npm run test --workspace @household/web -- NotificationsPage`
Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add apps/web/src/features/notifications/useNotifications.ts apps/web/src/features/notifications/NotificationsPage.tsx apps/web/src/features/notifications/NotificationsPage.test.tsx apps/web/src/App.tsx
git commit -m "feat(web): notifications page"
```

---

### Task 3: Web — bell and badge entry points

**Files:**
- Create: `apps/web/src/features/notifications/NotificationBadge.tsx`
- Modify: `apps/web/src/features/app/AppShell.tsx`, `apps/web/src/features/app/shell.css`
- Modify: `apps/web/src/features/app/MorePage.tsx`
- Test: `apps/web/src/features/app/AppShell.test.tsx`, `apps/web/src/features/app/MorePage.test.tsx`

**Interfaces:**
- Consumes: `useUnreadCount(householdId)` (Task 2, `useNotifications.ts`).
- Produces: `NotificationBadge({ count }: { count: number })` — a small presentational component; renders nothing when `count <= 0`.

- [ ] **Step 1: Write the badge component**

Create `apps/web/src/features/notifications/NotificationBadge.tsx`:

```tsx
export function NotificationBadge({ count }: { count: number }) {
  if (count <= 0) return null;
  return <span className="badge-count" aria-label={`${count} unread notifications`}>{count > 99 ? "99+" : count}</span>;
}
```

- [ ] **Step 2: Write the failing tests**

Create `apps/web/src/features/app/AppShell.test.tsx`:

```typescript
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { meKey } from "../auth/session";
import { AppShell } from "./AppShell";

const HOUSEHOLD = { id: "h1", name: "Shah Family", timezone: "Asia/Kolkata", role: "OWNER" as const, memberCount: 2 };

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function renderShell(unreadCount: number) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  qc.setQueryData(meKey, { user: { id: "u1", name: "Parakh", email: "p@example.com", emailVerified: true, createdAt: "2026-01-01T00:00:00.000Z" }, households: [HOUSEHOLD] });
  vi.spyOn(globalThis, "fetch").mockImplementation((async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.endsWith("/notifications/unread-count")) return jsonResponse({ success: true, data: { count: unreadCount }, message: null });
    throw new Error(`unexpected fetch ${url}`);
  }) as typeof fetch);
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={["/"]}>
        <Routes><Route element={<AppShell />}><Route index element={<div>Home page body</div>} /></Route></Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe("AppShell", () => {
  beforeEach(() => { vi.restoreAllMocks(); });
  afterEach(() => { vi.restoreAllMocks(); });

  it("shows the unread-count badge on the bell when there are unread notifications", async () => {
    renderShell(3);
    expect(await screen.findByLabelText("3 unread notifications")).toBeInTheDocument();
  });

  it("hides the badge when there are no unread notifications", async () => {
    renderShell(0);
    await screen.findByText("Home page body");
    expect(screen.queryByLabelText(/unread notifications/)).not.toBeInTheDocument();
  });
});
```

Create `apps/web/src/features/app/MorePage.test.tsx`:

```typescript
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { meKey } from "../auth/session";
import { MorePage } from "./MorePage";

const HOUSEHOLD = { id: "h1", name: "Shah Family", timezone: "Asia/Kolkata", role: "OWNER" as const, memberCount: 2 };

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function renderPage(unreadCount: number) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  qc.setQueryData(meKey, { user: { id: "u1", name: "Parakh", email: "p@example.com", emailVerified: true, createdAt: "2026-01-01T00:00:00.000Z" }, households: [HOUSEHOLD] });
  vi.spyOn(globalThis, "fetch").mockImplementation((async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.endsWith("/notifications/unread-count")) return jsonResponse({ success: true, data: { count: unreadCount }, message: null });
    throw new Error(`unexpected fetch ${url}`);
  }) as typeof fetch);
  return render(<QueryClientProvider client={qc}><MemoryRouter><MorePage /></MemoryRouter></QueryClientProvider>);
}

describe("MorePage", () => {
  beforeEach(() => { vi.restoreAllMocks(); });
  afterEach(() => { vi.restoreAllMocks(); });

  it("shows a Notifications row with the unread badge", async () => {
    renderPage(5);
    await screen.findByText("Notifications");
    expect(await screen.findByLabelText("5 unread notifications")).toBeInTheDocument();
  });
});
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `npm run test --workspace @household/web -- AppShell MorePage`
Expected: FAIL — no unread-count badge rendered yet (neither file wires `useUnreadCount` in).

- [ ] **Step 4: Wire the bell into AppShell**

In `apps/web/src/features/app/AppShell.tsx`, the existing file (lines 1-13) is:

```tsx
import { NavLink, Outlet } from "react-router-dom";
import { ClipboardCheck, Home, MoreHorizontal, ReceiptIndianRupee, Users } from "lucide-react";
import { Logo } from "../../components/Logo";
import { useActiveHousehold } from "./useActiveHousehold";
import "./shell.css";

const NAV = [
  { to: "/", label: "Home", icon: Home, end: true },
  { to: "/househelps", label: "Househelps", icon: Users },
  { to: "/checklist", label: "Checklist", icon: ClipboardCheck },
  { to: "/bills", label: "Bills", icon: ReceiptIndianRupee },
  { to: "/more", label: "More", icon: MoreHorizontal },
];
```

Change line 2 to add `Bell` to the `lucide-react` import, and add two new imports after line 3 (the `Logo` import):

```typescript
import { Bell, ClipboardCheck, Home, MoreHorizontal, ReceiptIndianRupee, Users } from "lucide-react";
import { Logo } from "../../components/Logo";
import { NotificationBadge } from "../notifications/NotificationBadge";
import { useUnreadCount } from "../notifications/useNotifications";
```

Replace the component body (lines 15-27) to add the bell link inside `.shell__brand`:

```tsx
export function AppShell() {
  const { household } = useActiveHousehold();
  const unreadCount = useUnreadCount(household?.id).data ?? 0;
  return (
    <div className="shell">
      <a href="#main" className="skip-link">Skip to content</a>
      <nav className="shell__nav" aria-label="Main">
        <div className="shell__brand">
          <Logo size={32} />
          <div>
            <p className="shell__app">Ghar</p>
            {household && <p className="shell__household">{household.name}</p>}
          </div>
          <NavLink to="/notifications" className="shell__bell" aria-label="Notifications">
            <Bell size={22} aria-hidden strokeWidth={2} />
            <NotificationBadge count={unreadCount} />
          </NavLink>
        </div>
```

(the rest of the component — the `<ul>` nav list and `<main>` — is unchanged from the existing file).

Add to `apps/web/src/features/app/shell.css`, inside the `@media (min-width: 900px)` block (after the `.shell__household` rule, around line 37):

```css
  .shell__bell { position: relative; margin-left: auto; display: flex; color: var(--ink-2); }
  .badge-count {
    position: absolute; top: -4px; right: -6px; min-width: 16px; height: 16px; padding: 0 4px;
    border-radius: 999px; background: var(--accent-700); color: #fff; font-size: 10px; font-weight: 700;
    display: flex; align-items: center; justify-content: center; line-height: 1;
  }
```

- [ ] **Step 5: Wire the row into MorePage**

In `apps/web/src/features/app/MorePage.tsx`, add imports after the existing imports (after line 9, `import { useActiveHousehold } from "./useActiveHousehold";`):

```typescript
import { NotificationBadge } from "../notifications/NotificationBadge";
import { useUnreadCount } from "../notifications/useNotifications";
```

Add `const unreadCount = useUnreadCount(household?.id).data ?? 0;` right after the existing `const leaveHousehold = useLeaveHousehold(household?.id ?? "");` line (line 18).

Change the "Household" section (lines 49-54) to:

```tsx
      <h2 className="section-title">Household</h2>
      <div className="list">
        <Link to="/members" className="list__item">
          <span className="list__label">Members</span>
        </Link>
        <Link to="/notifications" className="list__item">
          <span className="list__label">Notifications</span>
          <NotificationBadge count={unreadCount} />
        </Link>
      </div>
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `npm run test --workspace @household/web -- AppShell MorePage`
Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add apps/web/src/features/notifications/NotificationBadge.tsx apps/web/src/features/app/AppShell.tsx apps/web/src/features/app/AppShell.test.tsx apps/web/src/features/app/shell.css apps/web/src/features/app/MorePage.tsx apps/web/src/features/app/MorePage.test.tsx
git commit -m "feat(web): bell+badge notification entry points in sidebar and More page"
```

---

## Self-Review Notes

- **Spec coverage:** list/unread-count/read/dismiss/mark-all-read endpoints ✓ (Task 1), BILL linkPath resolution + SALARY passthrough ✓ (Task 1, tested both plus the "occurrence gone" edge case), per-user isolation + 404-not-403 ✓ (Task 1 tests), idempotent read/dismiss ✓ (Task 1 test), notifications page with tap-to-read-and-navigate + dismiss + mark-all-read + empty state ✓ (Task 2), 60s-polled badge ✓ (`useUnreadCount`'s `refetchInterval`, consumed by both entry points in Task 3), desktop sidebar bell (visible only ≥900px via existing `.shell__brand` display rule) + mobile More-page row ✓ (Task 3). No pagination, no new permission, no email/push — all correctly out of scope per the design.
- **Type consistency:** `NotificationDTO` (Task 1) fields match exactly what `NotificationsPage.tsx` (Task 2) destructures (`id`, `title`, `body`, `linkPath`, `readAt`, `createdAt`) and what the service's `toNotificationDTO` (Task 1) produces. `useUnreadCount` (Task 2) returns `number` via `.then((r) => r.data.count)`, consumed identically (`.data ?? 0`) in both `AppShell.tsx` and `MorePage.tsx` (Task 3).
- **No placeholders:** every step has runnable code; no "add styling" or "similar to Task N" steps.
