# Phase 7 Spec 6 — Notification Preferences Settings UI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a user turn BILL/SALARY reminders on/off and opt into email for each — the last spec in Phase 7, closing the loop that makes Spec 5's email dispatcher reachable.

**Architecture:** A `notification-preference.service.ts` reads/upserts `notification_preferences` rows, computing defaults for categories with no row yet (mirrors Spec 3's own "no row = enabled, default channels" read-time fallback). The web side adds the app's first settings-style page, reusing the existing `.chip[aria-pressed]` toggle-pill pattern already used elsewhere (completion picker, frequency pickers) — no new UI component needed.

**Tech Stack:** Express 5, Drizzle ORM, Postgres (API); React 19, TanStack Query, React Router (web); Vitest, Supertest, Testing Library.

## Global Constraints

- No schema migration — `notification_preferences` already exists.
- Exactly 2 settable categories: `BILL`, `SALARY`. Any other category in the PATCH URL is a 400.
- Exactly 2 exposed fields: `enabled` (boolean) and `emailEnabled` (boolean, maps to presence of `"EMAIL"` in the row's `channels` array). No IN_APP/WEB_PUSH/SMS/WHATSAPP controls, no `offsetsDays`/`sendHour` controls.
- No new permission — gate both routes on `household.view` (same reasoning as `reminder-rules`/`notifications`/`notification` list).
- GET must return a default (`enabled: true, emailEnabled: false`) for a category with no row — never 404 or omit it.
- PATCH upserts: creates the row (layering the request's fields onto the defaults) if none exists, otherwise updates only the field(s) given, leaving the other untouched.
- Toggling `emailEnabled` must only add/remove `"EMAIL"` in `channels` — `IN_APP`/`WEB_PUSH` (or anything else already there) must survive untouched.
- Per project testing cadence: targeted test files only per task; full suite at merge time (unless told otherwise for this round).

---

## File Structure

- Modify: `packages/shared/src/dto.ts` — add `NotificationPreferenceDTO`.
- Modify: `packages/shared/src/schemas.ts` — add `updateNotificationPreferenceSchema`.
- Create: `apps/api/src/services/notification-preference.service.ts`.
- Modify: `apps/api/src/routes/household.routes.ts` — 2 new routes.
- Create: `apps/api/tests/notification-preference.test.ts`.
- Create: `apps/web/src/features/settings/useNotificationPreferences.ts`.
- Create: `apps/web/src/features/settings/NotificationSettingsPage.tsx`.
- Create: `apps/web/src/features/settings/NotificationSettingsPage.test.tsx`.
- Modify: `apps/web/src/App.tsx` — new `/settings/notifications` route.
- Modify: `apps/web/src/features/app/MorePage.tsx`, `apps/web/src/features/app/MorePage.test.tsx` — new settings row.

---

### Task 1: Backend — notification-preference service, routes, and tests

**Files:**
- Modify: `packages/shared/src/dto.ts` (append after `NotificationDTO`, end of file)
- Modify: `packages/shared/src/schemas.ts` (append after `notificationActionSchema`, end of file)
- Create: `apps/api/src/services/notification-preference.service.ts`
- Modify: `apps/api/src/routes/household.routes.ts:3` (import line), `:23` (new service import, alphabetically after `notificationsService`), append 2 routes after line 469 (the `mark-all-read` block), before `return r;`
- Test: `apps/api/tests/notification-preference.test.ts`

**Interfaces:**
- Produces: `NotificationPreferenceDTO = { category: "BILL" | "SALARY"; enabled: boolean; emailEnabled: boolean }`, `UpdateNotificationPreferenceInput = { enabled?: boolean; emailEnabled?: boolean }` (both from `@household/shared`). `listNotificationPreferences(deps, userId, membership): Promise<NotificationPreferenceDTO[]>`, `updateNotificationPreference(deps, userId, membership, category, input): Promise<NotificationPreferenceDTO>` (from `notification-preference.service.ts`).
- Routes: `GET /households/:householdId/notification-preferences`, `PATCH /households/:householdId/notification-preferences/:category`.

- [ ] **Step 1: Add the shared types**

In `packages/shared/src/dto.ts`, append after `NotificationDTO`:

```typescript

export type SettableNotificationCategory = "BILL" | "SALARY";

export type NotificationPreferenceDTO = {
  category: SettableNotificationCategory; enabled: boolean; emailEnabled: boolean;
};
```

In `packages/shared/src/schemas.ts`, append after `notificationActionSchema`/`NotificationActionInput`:

```typescript

export const updateNotificationPreferenceSchema = z.object({
  enabled: z.boolean().optional(),
  emailEnabled: z.boolean().optional(),
}).refine((v) => v.enabled !== undefined || v.emailEnabled !== undefined, { message: "Provide at least one field to update." });
export type UpdateNotificationPreferenceInput = z.infer<typeof updateNotificationPreferenceSchema>;
```

- [ ] **Step 2: Write the failing test file**

Create `apps/api/tests/notification-preference.test.ts`:

```typescript
import { and, eq } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { householdMembers, notificationPreferences } from "../src/db/schema.js";
import { createTestContext, csrf, signupUser, truncateAll, type TestContext } from "./helpers.js";

const ctx = createTestContext();

beforeEach(async () => { await truncateAll(ctx.db); });
afterAll(() => ctx.close());

async function createHousehold(c: TestContext, cookie: string) {
  const res = await c.request.post("/api/households").set(csrf).set("cookie", cookie).send({ name: "Shah Family" });
  expect(res.status).toBe(201);
  return res.body.data as { id: string };
}

async function addActiveMember(householdId: string, userId: string) {
  await ctx.db.insert(householdMembers).values({ householdId, userId, role: "MEMBER", status: "ACTIVE" });
}

describe("notification preferences", () => {
  describe("GET /notification-preferences", () => {
    it("returns default enabled/no-email for a member with no seeded row", async () => {
      const owner = await signupUser(ctx);
      const h = await createHousehold(ctx, owner.cookie);
      const other = await signupUser(ctx);
      await addActiveMember(h.id, other.id);

      const res = await ctx.request.get(`/api/households/${h.id}/notification-preferences`).set("cookie", other.cookie);
      expect(res.status).toBe(200);
      expect(res.body.data).toEqual([
        { category: "BILL", enabled: true, emailEnabled: false },
        { category: "SALARY", enabled: true, emailEnabled: false },
      ]);
    });

    it("returns real stored values for a category with a row", async () => {
      const owner = await signupUser(ctx);
      const h = await createHousehold(ctx, owner.cookie);
      await ctx.db.update(notificationPreferences)
        .set({ enabled: false, channels: ["IN_APP", "WEB_PUSH", "EMAIL"] })
        .where(and(eq(notificationPreferences.householdId, h.id), eq(notificationPreferences.userId, owner.id), eq(notificationPreferences.category, "BILL")));

      const res = await ctx.request.get(`/api/households/${h.id}/notification-preferences`).set("cookie", owner.cookie);
      const bill = res.body.data.find((p: { category: string }) => p.category === "BILL");
      expect(bill).toEqual({ category: "BILL", enabled: false, emailEnabled: true });
    });

    it("never returns another member's preferences", async () => {
      const owner = await signupUser(ctx);
      const h = await createHousehold(ctx, owner.cookie);
      await ctx.db.update(notificationPreferences)
        .set({ enabled: false })
        .where(and(eq(notificationPreferences.householdId, h.id), eq(notificationPreferences.userId, owner.id), eq(notificationPreferences.category, "SALARY")));
      const other = await signupUser(ctx);
      await addActiveMember(h.id, other.id);

      const res = await ctx.request.get(`/api/households/${h.id}/notification-preferences`).set("cookie", other.cookie);
      const salary = res.body.data.find((p: { category: string }) => p.category === "SALARY");
      expect(salary).toEqual({ category: "SALARY", enabled: true, emailEnabled: false }); // default, not owner's disabled row
    });

    it("404s for a non-member", async () => {
      const owner = await signupUser(ctx);
      const h = await createHousehold(ctx, owner.cookie);
      const stranger = await signupUser(ctx);
      const res = await ctx.request.get(`/api/households/${h.id}/notification-preferences`).set("cookie", stranger.cookie);
      expect(res.status).toBe(404);
    });
  });

  describe("PATCH /notification-preferences/:category", () => {
    it("creates a row on a member's first-ever write, layering the request onto defaults", async () => {
      const owner = await signupUser(ctx);
      const h = await createHousehold(ctx, owner.cookie);
      const other = await signupUser(ctx);
      await addActiveMember(h.id, other.id);

      const res = await ctx.request.patch(`/api/households/${h.id}/notification-preferences/BILL`).set(csrf).set("cookie", other.cookie).send({ emailEnabled: true });
      expect(res.status).toBe(200);
      expect(res.body.data).toEqual({ category: "BILL", enabled: true, emailEnabled: true });

      const [row] = await ctx.db.select().from(notificationPreferences)
        .where(and(eq(notificationPreferences.householdId, h.id), eq(notificationPreferences.userId, other.id), eq(notificationPreferences.category, "BILL")));
      expect(row).toBeDefined();
      expect(row!.channels).toContain("EMAIL");
      expect(row!.channels).toContain("IN_APP");
    });

    it("updates only the given field on an existing row, leaving the other untouched", async () => {
      const owner = await signupUser(ctx);
      const h = await createHousehold(ctx, owner.cookie);

      const first = await ctx.request.patch(`/api/households/${h.id}/notification-preferences/SALARY`).set(csrf).set("cookie", owner.cookie).send({ emailEnabled: true });
      expect(first.body.data).toEqual({ category: "SALARY", enabled: true, emailEnabled: true });

      const second = await ctx.request.patch(`/api/households/${h.id}/notification-preferences/SALARY`).set(csrf).set("cookie", owner.cookie).send({ enabled: false });
      expect(second.body.data).toEqual({ category: "SALARY", enabled: false, emailEnabled: true }); // emailEnabled untouched
    });

    it("round-trips emailEnabled true then false without disturbing IN_APP/WEB_PUSH", async () => {
      const owner = await signupUser(ctx);
      const h = await createHousehold(ctx, owner.cookie);

      await ctx.request.patch(`/api/households/${h.id}/notification-preferences/BILL`).set(csrf).set("cookie", owner.cookie).send({ emailEnabled: true });
      const off = await ctx.request.patch(`/api/households/${h.id}/notification-preferences/BILL`).set(csrf).set("cookie", owner.cookie).send({ emailEnabled: false });
      expect(off.body.data).toEqual({ category: "BILL", enabled: true, emailEnabled: false });

      const [row] = await ctx.db.select().from(notificationPreferences)
        .where(and(eq(notificationPreferences.householdId, h.id), eq(notificationPreferences.userId, owner.id), eq(notificationPreferences.category, "BILL")));
      expect(row!.channels).toEqual(expect.arrayContaining(["IN_APP", "WEB_PUSH"]));
      expect(row!.channels).not.toContain("EMAIL");
    });

    it("400s for a category outside BILL/SALARY", async () => {
      const owner = await signupUser(ctx);
      const h = await createHousehold(ctx, owner.cookie);
      const res = await ctx.request.patch(`/api/households/${h.id}/notification-preferences/ATTENDANCE`).set(csrf).set("cookie", owner.cookie).send({ enabled: false });
      expect(res.status).toBe(400);
    });

    it("never writes another member's preferences", async () => {
      const owner = await signupUser(ctx);
      const h = await createHousehold(ctx, owner.cookie);
      const other = await signupUser(ctx);
      await addActiveMember(h.id, other.id);

      await ctx.request.patch(`/api/households/${h.id}/notification-preferences/BILL`).set(csrf).set("cookie", other.cookie).send({ enabled: false });

      const [ownerRow] = await ctx.db.select().from(notificationPreferences)
        .where(and(eq(notificationPreferences.householdId, h.id), eq(notificationPreferences.userId, owner.id), eq(notificationPreferences.category, "BILL")));
      expect(ownerRow!.enabled).toBe(true); // untouched — only `other`'s row was created/changed
    });
  });
});
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `npm run test --workspace @household/api -- notification-preference`
Expected: FAIL — `Cannot find module '../src/services/notification-preference.service.js'` (and/or 404s from unregistered routes).

- [ ] **Step 4: Implement the service**

Create `apps/api/src/services/notification-preference.service.ts`:

```typescript
import { and, eq } from "drizzle-orm";
import type { NotificationPreferenceDTO, SettableNotificationCategory, UpdateNotificationPreferenceInput } from "@household/shared";
import { notificationPreferences } from "../db/schema.js";
import { Errors } from "../lib/errors.js";
import type { Deps } from "./deps.js";
import type { Membership } from "./household.service.js";

type PrefRow = typeof notificationPreferences.$inferSelect;
type ChannelValue = "IN_APP" | "WEB_PUSH" | "EMAIL" | "SMS" | "WHATSAPP";

const DEFAULT_CHANNELS: ChannelValue[] = ["IN_APP", "WEB_PUSH"];
const SETTABLE_CATEGORIES: SettableNotificationCategory[] = ["BILL", "SALARY"];

function toDTO(category: SettableNotificationCategory, row: PrefRow | undefined): NotificationPreferenceDTO {
  const enabled = row?.enabled ?? true;
  const channels = row?.channels ?? DEFAULT_CHANNELS;
  return { category, enabled, emailEnabled: channels.includes("EMAIL") };
}

export async function listNotificationPreferences(deps: Deps, userId: string, membership: Membership): Promise<NotificationPreferenceDTO[]> {
  const rows = await deps.db.select().from(notificationPreferences)
    .where(and(eq(notificationPreferences.householdId, membership.householdId), eq(notificationPreferences.userId, userId)));
  const byCategory = new Map(rows.map((r) => [r.category, r]));
  return SETTABLE_CATEGORIES.map((category) => toDTO(category, byCategory.get(category)));
}

export async function updateNotificationPreference(
  deps: Deps, userId: string, membership: Membership, category: string, input: UpdateNotificationPreferenceInput,
): Promise<NotificationPreferenceDTO> {
  if (!SETTABLE_CATEGORIES.includes(category as SettableNotificationCategory)) throw Errors.validation({ category: "Unsupported category." });
  const cat = category as SettableNotificationCategory;

  const result = await deps.db.transaction(async (tx) => {
    const [existing] = await tx.select().from(notificationPreferences)
      .where(and(eq(notificationPreferences.householdId, membership.householdId), eq(notificationPreferences.userId, userId), eq(notificationPreferences.category, cat)))
      .for("update");

    const enabled = input.enabled ?? existing?.enabled ?? true;
    const currentChannels = existing?.channels ?? DEFAULT_CHANNELS;
    const channels: ChannelValue[] = input.emailEnabled === undefined
      ? currentChannels
      : input.emailEnabled
        ? currentChannels.includes("EMAIL") ? currentChannels : [...currentChannels, "EMAIL"]
        : currentChannels.filter((c) => c !== "EMAIL");

    if (existing) {
      await tx.update(notificationPreferences).set({ enabled, channels }).where(eq(notificationPreferences.id, existing.id));
    } else {
      await tx.insert(notificationPreferences).values({ householdId: membership.householdId, userId, category: cat, enabled, channels });
    }
    return { enabled, channels };
  });

  return { category: cat, enabled: result.enabled, emailEnabled: result.channels.includes("EMAIL") };
}
```

- [ ] **Step 5: Wire the routes**

In `apps/api/src/routes/household.routes.ts`, add `updateNotificationPreferenceSchema` to the existing destructured import from `"@household/shared"` on line 3 (insert alphabetically, e.g. right after `updateMemberSchema`), and add a new service import after line 23 (`import * as notificationsService from "../services/notification.service.js";`):

```typescript
import * as notificationPreferencesService from "../services/notification-preference.service.js";
```

Then append these 2 routes right after the `mark-all-read` block (after line 469), before the final `return r;`:

```typescript
  r.get("/:householdId/notification-preferences", requireHousehold(deps, "household.view"), async (req, res) => {
    ok(res, await notificationPreferencesService.listNotificationPreferences(deps, req.auth!.user.id, req.membership!));
  });

  r.patch("/:householdId/notification-preferences/:category", requireHousehold(deps, "household.view"), async (req, res) => {
    const input = parseBody(req, updateNotificationPreferenceSchema);
    ok(res, await notificationPreferencesService.updateNotificationPreference(deps, req.auth!.user.id, req.membership!, req.params.category as string, input));
  });
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `npm run test --workspace @household/api -- notification-preference`
Expected: PASS

- [ ] **Step 7: Typecheck and build**

Run: `npm run build --workspace @household/shared && npm run typecheck --workspace @household/api && npm run build --workspace @household/api`
Expected: PASS (the 2 pre-existing, unrelated `TS18048` failures in `tests/bill-category.test.ts`/`tests/bill.test.ts` are not part of this change).

- [ ] **Step 8: Commit**

```bash
git add packages/shared/src/dto.ts packages/shared/src/schemas.ts apps/api/src/services/notification-preference.service.ts apps/api/src/routes/household.routes.ts apps/api/tests/notification-preference.test.ts
git commit -m "feat(api): notification preferences enabled/email-opt-in endpoints"
```

---

### Task 2: Web — notification settings page

**Files:**
- Create: `apps/web/src/features/settings/useNotificationPreferences.ts`
- Create: `apps/web/src/features/settings/NotificationSettingsPage.tsx`
- Create: `apps/web/src/features/settings/NotificationSettingsPage.test.tsx`
- Modify: `apps/web/src/App.tsx` (import + new route)
- Modify: `apps/web/src/features/app/MorePage.tsx`, `apps/web/src/features/app/MorePage.test.tsx`

**Interfaces:**
- Consumes: `NotificationPreferenceDTO`, `UpdateNotificationPreferenceInput` (Task 1, `@household/shared`), the 2 routes from Task 1.
- Produces: `useNotificationPreferences(householdId)`, `useUpdateNotificationPreference(householdId)` from `useNotificationPreferences.ts`.

- [ ] **Step 1: Write the hooks**

Create `apps/web/src/features/settings/useNotificationPreferences.ts`:

```typescript
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { NotificationPreferenceDTO, UpdateNotificationPreferenceInput } from "@household/shared";
import { get, patch } from "../../lib/api";

export function useNotificationPreferences(householdId: string | undefined) {
  return useQuery({
    queryKey: ["notification-preferences", householdId],
    queryFn: ({ signal }) => get<NotificationPreferenceDTO[]>(`/households/${householdId}/notification-preferences`, signal).then((r) => r.data),
    enabled: !!householdId,
  });
}

export function useUpdateNotificationPreference(householdId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ category, body }: { category: string; body: UpdateNotificationPreferenceInput }) =>
      patch<NotificationPreferenceDTO>(`/households/${householdId}/notification-preferences/${category}`, body),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["notification-preferences", householdId] }),
  });
}
```

- [ ] **Step 2: Write the failing test file**

Create `apps/web/src/features/settings/NotificationSettingsPage.test.tsx`:

```typescript
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { meKey } from "../auth/session";
import { NotificationSettingsPage } from "./NotificationSettingsPage";

const HOUSEHOLD = { id: "h1", name: "Shah Family", timezone: "Asia/Kolkata", role: "OWNER" as const, memberCount: 2 };

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function renderPage() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  qc.setQueryData(meKey, { user: { id: "u1", name: "Parakh", email: "p@example.com", emailVerified: true, createdAt: "2026-01-01T00:00:00.000Z" }, households: [HOUSEHOLD] });
  return render(<QueryClientProvider client={qc}><MemoryRouter><NotificationSettingsPage /></MemoryRouter></QueryClientProvider>);
}

describe("NotificationSettingsPage", () => {
  beforeEach(() => { vi.restoreAllMocks(); });
  afterEach(() => { vi.restoreAllMocks(); });

  it("renders both categories' current state", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation((async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/households/h1/notification-preferences")) {
        return jsonResponse({ success: true, data: [
          { category: "BILL", enabled: true, emailEnabled: false },
          { category: "SALARY", enabled: false, emailEnabled: false },
        ] }, 200);
      }
      throw new Error(`unexpected fetch ${url}`);
    }) as typeof fetch);
    renderPage();
    await screen.findByText("Bills");
    await screen.findByText("Salary");
    const billToggle = screen.getAllByRole("button", { name: "On" })[0]!;
    expect(billToggle).toHaveAttribute("aria-pressed", "true");
  });

  it("hides the email toggle when enabled is off", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation((async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/households/h1/notification-preferences")) {
        return jsonResponse({ success: true, data: [
          { category: "BILL", enabled: false, emailEnabled: false },
          { category: "SALARY", enabled: true, emailEnabled: false },
        ] }, 200);
      }
      throw new Error(`unexpected fetch ${url}`);
    }) as typeof fetch);
    renderPage();
    await screen.findByText("Bills");
    // Only Salary (enabled) shows its "Also email me" toggle
    expect(screen.getAllByRole("button", { name: "Also email me" })).toHaveLength(1);
  });

  it("toggling enabled fires the correct PATCH body", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation((async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (init?.method === "PATCH" && url.includes("/notification-preferences/BILL")) {
        return jsonResponse({ success: true, data: { category: "BILL", enabled: false, emailEnabled: false }, message: null });
      }
      if (url.endsWith("/households/h1/notification-preferences")) {
        return jsonResponse({ success: true, data: [
          { category: "BILL", enabled: true, emailEnabled: false },
          { category: "SALARY", enabled: true, emailEnabled: false },
        ] }, 200);
      }
      throw new Error(`unexpected fetch ${url}`);
    }) as typeof fetch);
    renderPage();
    await screen.findByText("Bills");
    const toggles = screen.getAllByRole("button", { name: "On" });
    await userEvent.click(toggles[0]!); // BILL is first card
    const patchCall = fetchSpy.mock.calls.find(([u, init]) => String(u).includes("/notification-preferences/BILL") && (init as RequestInit | undefined)?.method === "PATCH");
    expect(patchCall).toBeDefined();
    expect(JSON.parse((patchCall![1] as RequestInit).body as string)).toEqual({ enabled: false });
  });

  it("toggling email opt-in fires the correct PATCH body", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation((async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (init?.method === "PATCH" && url.includes("/notification-preferences/SALARY")) {
        return jsonResponse({ success: true, data: { category: "SALARY", enabled: true, emailEnabled: true }, message: null });
      }
      if (url.endsWith("/households/h1/notification-preferences")) {
        return jsonResponse({ success: true, data: [
          { category: "BILL", enabled: true, emailEnabled: false },
          { category: "SALARY", enabled: true, emailEnabled: false },
        ] }, 200);
      }
      throw new Error(`unexpected fetch ${url}`);
    }) as typeof fetch);
    renderPage();
    await screen.findByText("Salary");
    const emailToggles = screen.getAllByRole("button", { name: "Also email me" });
    await userEvent.click(emailToggles[1]!); // SALARY is the second card
    const patchCall = fetchSpy.mock.calls.find(([u, init]) => String(u).includes("/notification-preferences/SALARY") && (init as RequestInit | undefined)?.method === "PATCH");
    expect(patchCall).toBeDefined();
    expect(JSON.parse((patchCall![1] as RequestInit).body as string)).toEqual({ emailEnabled: true });
  });
});
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `npm run test --workspace @household/web -- NotificationSettingsPage`
Expected: FAIL — `Cannot find module './NotificationSettingsPage'`.

- [ ] **Step 4: Implement the page**

Create `apps/web/src/features/settings/NotificationSettingsPage.tsx`:

```tsx
import type { NotificationPreferenceDTO, SettableNotificationCategory } from "@household/shared";
import { useActiveHousehold } from "../app/useActiveHousehold";
import { useNotificationPreferences, useUpdateNotificationPreference } from "./useNotificationPreferences";

const CATEGORY_LABEL: Record<SettableNotificationCategory, string> = { BILL: "Bills", SALARY: "Salary" };

export function NotificationSettingsPage() {
  const { household } = useActiveHousehold();
  const householdId = household?.id;
  const prefsQuery = useNotificationPreferences(householdId);
  const updatePref = useUpdateNotificationPreference(householdId ?? "");

  if (!householdId || !prefsQuery.data) return null;

  function onToggleEnabled(pref: NotificationPreferenceDTO) {
    updatePref.mutate({ category: pref.category, body: { enabled: !pref.enabled } });
  }

  function onToggleEmail(pref: NotificationPreferenceDTO) {
    updatePref.mutate({ category: pref.category, body: { emailEnabled: !pref.emailEnabled } });
  }

  return (
    <>
      <header className="page-head"><h1 className="page-title">Notification settings</h1></header>
      <div className="list">
        {prefsQuery.data.map((pref) => (
          <div key={pref.category} className="list__item" style={{ flexDirection: "column", alignItems: "stretch", gap: "var(--space-2)" }}>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
              <span className="list__label">{CATEGORY_LABEL[pref.category]}</span>
              <button type="button" className="chip" aria-pressed={pref.enabled} onClick={() => onToggleEnabled(pref)}>
                {pref.enabled ? "On" : "Off"}
              </button>
            </div>
            {pref.enabled && (
              <button type="button" className="chip" aria-pressed={pref.emailEnabled} onClick={() => onToggleEmail(pref)}>
                Also email me
              </button>
            )}
          </div>
        ))}
      </div>
    </>
  );
}
```

- [ ] **Step 5: Wire the route**

In `apps/web/src/App.tsx`, add the import after `import { NotificationsPage } from "./features/notifications/NotificationsPage";` (line 28):

```typescript
import { NotificationSettingsPage } from "./features/settings/NotificationSettingsPage";
```

Add the route after `<Route path="notifications" element={<NotificationsPage />} />` (line 67):

```tsx
        <Route path="notifications" element={<NotificationsPage />} />
        <Route path="settings/notifications" element={<NotificationSettingsPage />} />
```

- [ ] **Step 6: Add the entry point in MorePage**

In `apps/web/src/features/app/MorePage.tsx`, change the "Household" section (currently lines 52-61):

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
        <Link to="/settings/notifications" className="list__item">
          <span className="list__label">Notification settings</span>
        </Link>
      </div>
```

In `apps/web/src/features/app/MorePage.test.tsx`, add one assertion to the existing `"shows a Notifications row with the unread badge"` test (after its final `expect`):

```typescript
    await screen.findByText("Notification settings");
```

- [ ] **Step 7: Run the tests to verify they pass**

Run: `npm run test --workspace @household/web -- NotificationSettingsPage MorePage`
Expected: PASS

- [ ] **Step 8: Commit**

```bash
git add apps/web/src/features/settings/useNotificationPreferences.ts apps/web/src/features/settings/NotificationSettingsPage.tsx apps/web/src/features/settings/NotificationSettingsPage.test.tsx apps/web/src/App.tsx apps/web/src/features/app/MorePage.tsx apps/web/src/features/app/MorePage.test.tsx
git commit -m "feat(web): notification settings page"
```

---

## Self-Review Notes

- **Spec coverage:** GET default-for-missing-row ✓, GET real-values-for-existing-row ✓, PATCH upsert-creates ✓, PATCH upsert-updates-partial ✓, emailEnabled round-trip preserving other channels ✓, category restricted to BILL/SALARY with 400 otherwise ✓, no new permission (`household.view` reused) ✓, cross-user isolation ✓ (all tested in Task 1); settings page with enabled+email toggles using the existing `.chip` pattern (no new component) ✓, email toggle hidden when disabled ✓, immediate-mutation-on-tap (no save button) ✓, MorePage entry point distinct from the inbox link ✓ (all in Task 2). ATTENDANCE/CHECKLIST/SYSTEM and IN_APP/WEB_PUSH/SMS/WHATSAPP are correctly absent everywhere, per the design's explicit scope.
- **Type consistency:** `NotificationPreferenceDTO`/`SettableNotificationCategory` (Task 1) used identically in Task 2's page (`CATEGORY_LABEL: Record<SettableNotificationCategory, string>`) and hooks (`UpdateNotificationPreferenceInput`).
- **No placeholders:** every step has runnable code.
