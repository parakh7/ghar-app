# Phase 8 Spec 2 — Cross-Entity Search Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a user search househelps, bills, checklist tasks, and members by name (plus bill provider, member email) from anywhere in the app.

**Architecture:** A `search.service.ts` reuses 4 already-existing list functions (`listHousehelps`, `listBills`, `listChecklistTasks`, `listMembers`) and filters their results in-memory by case-insensitive substring match — no new raw SQL queries, and every existing exclusion (archived bills/househelps/tasks, non-ACTIVE members) comes along for free. Each section is gated on its own permission using the same optional-key convention Spec 1 established (absent key = no permission; present-but-empty = permitted, no matches). On the web, a debounced search input lives in the desktop sidebar (navigates to `/search?q=...` as you type) and a fixed search icon on mobile (no shared mobile header exists to put an always-visible input into — confirmed in Spec 1's research), both leading to one `/search` results page.

**Tech Stack:** Express 5, Drizzle ORM (API, via existing service functions only); React 19, TanStack Query, React Router (web).

## Global Constraints

- No new database tables/columns, no new raw SQL — reuse `listHousehelps`, `listBills`, `listChecklistTasks`, `listMembers` exactly as they exist today.
- 4 searchable entity types only: househelps (name), bills (name OR provider), checklist tasks (name), members (name OR displayName OR email).
- Each section capped at 10 results.
- Permission gating follows Spec 1's exact convention: **absent key = no permission**, present array (possibly empty) = permitted. An empty/missing `q` returns every permitted section as an empty array, never an error and never an omitted key.
- No new permission — reuse `househelps.view`, `bills.view`, `checklists.view`, `members.view` exactly as defined.
- Member search results are **not clickable** — there is no member detail page (`MembersPage` is list-only, no `/members/:id` route), so member rows just display name + email with no link. This is a deliberate scope boundary, not a gap: adding a member detail page is out of scope for a search feature.
- Per project testing cadence (user's explicit instruction this round): targeted test file only — **no full-suite run**, not even at merge time.

---

## File Structure

- Modify: `packages/shared/src/dto.ts` — add `SearchHousehelpResultDTO`, `SearchBillResultDTO`, `SearchChecklistTaskResultDTO`, `SearchMemberResultDTO`, `SearchResultsDTO`.
- Create: `apps/api/src/services/search.service.ts`.
- Modify: `apps/api/src/routes/household.routes.ts` — 1 new route.
- Create: `apps/api/tests/search.test.ts`.
- Create: `apps/web/src/features/search/useDebouncedValue.ts` — tiny shared hook (2 real call sites: the sidebar input and the search page's own input).
- Create: `apps/web/src/features/search/useSearch.ts`.
- Create: `apps/web/src/features/search/SearchInput.tsx` — the desktop sidebar input.
- Create: `apps/web/src/features/search/SearchPage.tsx`.
- Create: `apps/web/src/features/search/SearchPage.test.tsx`.
- Modify: `apps/web/src/features/app/AppShell.tsx` — mobile search icon + desktop `SearchInput`.
- Modify: `apps/web/src/features/app/AppShell.test.tsx` — cover both entry points.
- Modify: `apps/web/src/features/app/shell.css` — new classes for the mobile icon and desktop input.
- Modify: `apps/web/src/App.tsx` — new `/search` route.

---

### Task 1: Backend — search.service.ts, route, and tests

**Files:**
- Modify: `packages/shared/src/dto.ts` (append after `TodayDashboardDTO`, end of file)
- Create: `apps/api/src/services/search.service.ts`
- Modify: `apps/api/src/routes/household.routes.ts:29` (new service import, alphabetically after `salary-settlement.service.js`'s own import, before `today.service.js`'s import), append 1 route after the `GET /:householdId/today` block, before `return r;`
- Test: `apps/api/tests/search.test.ts`

**Interfaces:**
- Consumes: `listHousehelps(db, householdId, includeArchived): Promise<HousehelpDTO[]>` (`househelp.service.ts:27`), `listBills(deps, membership, filters): Promise<BillDTO[]>` (`bill.service.ts:37`, called with `{}` — excludes `ARCHIVED` by default), `listChecklistTasks(db, householdId, includeArchived): Promise<ChecklistTaskDTO[]>` (`checklist-task.service.ts:39`), `listMembers(db, householdId): Promise<MemberDTO[]>` (`member.service.ts:22`, ACTIVE members only), `Membership` type + `req.membership.permissions: Set<Permission>` (`types.d.ts:10`).
- Produces: `SearchResultsDTO = { househelps?: {id,name}[]; bills?: {id,name,provider}[]; checklistTasks?: {id,name}[]; members?: {userId,name,email}[] }` and `search(deps, membership, query): Promise<SearchResultsDTO>`, registered at `GET /households/:householdId/search?q=<text>`.

- [ ] **Step 1: Add the shared types**

In `packages/shared/src/dto.ts`, append after the `TodayDashboardDTO` type (end of file):

```typescript

export type SearchHousehelpResultDTO = { id: string; name: string };
export type SearchBillResultDTO = { id: string; name: string; provider: string | null };
export type SearchChecklistTaskResultDTO = { id: string; name: string };
export type SearchMemberResultDTO = { userId: string; name: string; email: string };

export type SearchResultsDTO = {
  househelps?: SearchHousehelpResultDTO[];
  bills?: SearchBillResultDTO[];
  checklistTasks?: SearchChecklistTaskResultDTO[];
  members?: SearchMemberResultDTO[];
};
```

- [ ] **Step 2: Write the failing test file**

Create `apps/api/tests/search.test.ts`:

```typescript
import { eq } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { checklistTasks, households, householdMembers, househelps } from "../src/db/schema.js";
import { createTestContext, csrf, signupUser, truncateAll, type TestContext } from "./helpers.js";

const ctx = createTestContext();

beforeEach(async () => { await truncateAll(ctx.db); });
afterAll(() => ctx.close());

async function createHousehold(c: TestContext, cookie: string, name = "Shah Family") {
  const res = await c.request.post("/api/households").set(csrf).set("cookie", cookie).send({ name });
  expect(res.status).toBe(201);
  return res.body.data as { id: string };
}

async function createHousehelp(householdId: string, name: string) {
  const [row] = await ctx.db.insert(househelps).values({ householdId, name }).returning();
  return row!;
}

async function createBill(h: { id: string }, cookie: string, name: string, provider?: string) {
  const res = await ctx.request.post(`/api/households/${h.id}/bills`).set(csrf).set("cookie", cookie)
    .send({ name, frequency: "ONE_TIME", firstDueDate: "2026-09-29", amountPaise: 50000, ...(provider ? { provider } : {}) });
  expect(res.status).toBe(201);
  return res.body.data as { id: string; name: string; provider: string | null };
}

async function createChecklistTask(householdId: string, name: string) {
  const [row] = await ctx.db.insert(checklistTasks).values({ householdId, name, frequency: "DAILY" }).returning();
  return row!;
}

async function addMember(householdId: string, userId: string, overrides: Record<string, unknown> = {}) {
  // listMembers()'s toMemberDTO non-null-asserts joinedAt (real ACTIVE rows always have it stamped
  // via the invite/add flow) — must set it here too, or any route touching listMembers 500s.
  await ctx.db.insert(householdMembers).values({ householdId, userId, role: "MEMBER", status: "ACTIVE", joinedAt: ctx.clock.now(), ...overrides });
}

async function search(h: { id: string }, cookie: string, q: string) {
  return ctx.request.get(`/api/households/${h.id}/search?q=${encodeURIComponent(q)}`).set("cookie", cookie);
}

describe("GET /search", () => {
  it("matches househelps by name, case-insensitively and by substring", async () => {
    const owner = await signupUser(ctx);
    const h = await createHousehold(ctx, owner.cookie);
    const sunita = await createHousehelp(h.id, "Sunita Devi");
    await createHousehelp(h.id, "Geeta");

    const res = await search(h, owner.cookie, "suNIT");
    expect(res.status).toBe(200);
    expect(res.body.data.househelps).toEqual([{ id: sunita.id, name: "Sunita Devi" }]);
  });

  it("matches bills by name or provider", async () => {
    const owner = await signupUser(ctx);
    const h = await createHousehold(ctx, owner.cookie);
    const electricity = await createBill(h, owner.cookie, "Electricity", "BESCOM");
    await createBill(h, owner.cookie, "Internet", "Airtel");

    const byName = await search(h, owner.cookie, "electric");
    expect(byName.body.data.bills.map((b: { id: string }) => b.id)).toEqual([electricity.id]);

    const byProvider = await search(h, owner.cookie, "bescom");
    expect(byProvider.body.data.bills.map((b: { id: string }) => b.id)).toEqual([electricity.id]);
  });

  it("matches checklist tasks by name", async () => {
    const owner = await signupUser(ctx);
    const h = await createHousehold(ctx, owner.cookie);
    const task = await createChecklistTask(h.id, "Wash dishes");
    await createChecklistTask(h.id, "Sweep floor");

    const res = await search(h, owner.cookie, "dish");
    expect(res.body.data.checklistTasks).toEqual([{ id: task.id, name: "Wash dishes" }]);
  });

  it("matches members by name, display name, or email", async () => {
    const owner = await signupUser(ctx, { name: "Parakh Shah" });
    const h = await createHousehold(ctx, owner.cookie);
    const other = await signupUser(ctx, { name: "Priya Shah" });
    await addMember(h.id, other.id, { displayName: "Mother" });

    const byName = await search(h, owner.cookie, "priya");
    expect(byName.body.data.members.map((m: { userId: string }) => m.userId)).toEqual([other.id]);

    const byDisplayName = await search(h, owner.cookie, "mother");
    expect(byDisplayName.body.data.members.map((m: { userId: string }) => m.userId)).toEqual([other.id]);

    const byEmail = await search(h, owner.cookie, other.email.slice(0, 6));
    expect(byEmail.body.data.members.map((m: { userId: string }) => m.userId)).toEqual([other.id]);
  });

  it("returns empty arrays, not omitted sections, for an empty query", async () => {
    const owner = await signupUser(ctx);
    const h = await createHousehold(ctx, owner.cookie);
    await createHousehelp(h.id, "Sunita");

    const res = await search(h, owner.cookie, "");
    expect(res.body.data).toEqual({ househelps: [], bills: [], checklistTasks: [], members: [] });
  });

  it("omits a section when the caller lacks its permission", async () => {
    const owner = await signupUser(ctx);
    const h = await createHousehold(ctx, owner.cookie);
    const member = await signupUser(ctx);
    await addMember(h.id, member.id);
    await ctx.db.update(households).set({ rolePermissionOverrides: { MEMBER: { revoke: ["members.view"] } } }).where(eq(households.id, h.id));

    const res = await search(h, member.cookie, "a");
    expect(res.body.data).not.toHaveProperty("members");
    expect(res.body.data).toHaveProperty("househelps");
    expect(res.body.data).toHaveProperty("bills");
    expect(res.body.data).toHaveProperty("checklistTasks");
  });

  it("caps results at 10 per section", async () => {
    const owner = await signupUser(ctx);
    const h = await createHousehold(ctx, owner.cookie);
    for (let i = 0; i < 11; i++) await createHousehelp(h.id, `Helper ${i}`);

    const res = await search(h, owner.cookie, "helper");
    expect(res.body.data.househelps).toHaveLength(10);
  });

  it("never reflects another household's data", async () => {
    const ownerA = await signupUser(ctx);
    const hA = await createHousehold(ctx, ownerA.cookie, "Household A");
    await createHousehelp(hA.id, "Sunita");

    const ownerB = await signupUser(ctx);
    const hB = await createHousehold(ctx, ownerB.cookie, "Household B");

    const res = await search(hB, ownerB.cookie, "sunita");
    expect(res.body.data.househelps).toEqual([]);
  });

  it("404s for a non-member", async () => {
    const owner = await signupUser(ctx);
    const h = await createHousehold(ctx, owner.cookie);
    const stranger = await signupUser(ctx);
    const res = await search(h, stranger.cookie, "a");
    expect(res.status).toBe(404);
  });
});
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `npm run test --workspace @household/api -- search.test`
Expected: FAIL — `Cannot find module '../src/services/search.service.js'` (and/or 404s from the unregistered route).

- [ ] **Step 4: Implement the service**

Create `apps/api/src/services/search.service.ts`:

```typescript
import type { Permission, SearchResultsDTO } from "@household/shared";
import { listBills } from "./bill.service.js";
import { listChecklistTasks } from "./checklist-task.service.js";
import type { Deps } from "./deps.js";
import type { Membership } from "./household.service.js";
import { listHousehelps } from "./househelp.service.js";
import { listMembers } from "./member.service.js";

type AuthedMembership = Membership & { permissions: Set<Permission> };

const RESULT_LIMIT = 10;

export async function search(deps: Deps, membership: AuthedMembership, query: string): Promise<SearchResultsDTO> {
  const q = query.trim().toLowerCase();
  const results: SearchResultsDTO = {};

  if (membership.permissions.has("househelps.view")) {
    const matched = q ? (await listHousehelps(deps.db, membership.householdId, false)).filter((h) => h.name.toLowerCase().includes(q)) : [];
    results.househelps = matched.slice(0, RESULT_LIMIT).map((h) => ({ id: h.id, name: h.name }));
  }

  if (membership.permissions.has("bills.view")) {
    const matched = q
      ? (await listBills(deps, membership, {})).filter((b) => b.name.toLowerCase().includes(q) || (b.provider?.toLowerCase().includes(q) ?? false))
      : [];
    results.bills = matched.slice(0, RESULT_LIMIT).map((b) => ({ id: b.id, name: b.name, provider: b.provider }));
  }

  if (membership.permissions.has("checklists.view")) {
    const matched = q ? (await listChecklistTasks(deps.db, membership.householdId, false)).filter((t) => t.name.toLowerCase().includes(q)) : [];
    results.checklistTasks = matched.slice(0, RESULT_LIMIT).map((t) => ({ id: t.id, name: t.name }));
  }

  if (membership.permissions.has("members.view")) {
    const matched = q
      ? (await listMembers(deps.db, membership.householdId)).filter((m) =>
          m.name.toLowerCase().includes(q) || (m.displayName?.toLowerCase().includes(q) ?? false) || m.email.toLowerCase().includes(q))
      : [];
    results.members = matched.slice(0, RESULT_LIMIT).map((m) => ({ userId: m.userId, name: m.name, email: m.email }));
  }

  return results;
}
```

- [ ] **Step 5: Wire the route**

In `apps/api/src/routes/household.routes.ts`, add a new service import before `import * as today from "../services/today.service.js";`:

```typescript
import * as searchService from "../services/search.service.js";
```

Append this route after the `GET /:householdId/today` block, before the final `return r;`:

```typescript
  r.get("/:householdId/search", requireHousehold(deps, "household.view"), async (req, res) => {
    const q = typeof req.query.q === "string" ? req.query.q : "";
    ok(res, await searchService.search(deps, req.membership!, q));
  });
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `npm run test --workspace @household/api -- search.test`
Expected: PASS

- [ ] **Step 7: Typecheck and build**

Run: `npm run build --workspace @household/shared && npm run typecheck --workspace @household/api && npm run build --workspace @household/api`
Expected: PASS (the 2 pre-existing, unrelated `TS18048` failures in `tests/bill-category.test.ts`/`tests/bill.test.ts` are not part of this change).

- [ ] **Step 8: Commit**

```bash
git add packages/shared/src/dto.ts apps/api/src/services/search.service.ts apps/api/src/routes/household.routes.ts apps/api/tests/search.test.ts
git commit -m "feat(api): cross-entity search endpoint"
```

---

### Task 2: Web — search entry points and results page

**Files:**
- Create: `apps/web/src/features/search/useDebouncedValue.ts`
- Create: `apps/web/src/features/search/useSearch.ts`
- Create: `apps/web/src/features/search/SearchInput.tsx`
- Create: `apps/web/src/features/search/SearchPage.tsx`
- Create: `apps/web/src/features/search/SearchPage.test.tsx`
- Modify: `apps/web/src/features/app/AppShell.tsx`
- Modify: `apps/web/src/features/app/AppShell.test.tsx`
- Modify: `apps/web/src/features/app/shell.css`
- Modify: `apps/web/src/App.tsx`

**Interfaces:**
- Consumes: `SearchResultsDTO` (Task 1, `@household/shared`), `GET /households/:householdId/search?q=...` (Task 1).
- Produces: `useDebouncedValue<T>(value: T, delayMs: number): T`, `useSearch(householdId, query): UseQueryResult<SearchResultsDTO>`, `SearchInput` component (desktop sidebar), `SearchPage` component.

- [ ] **Step 1: Write the debounce hook**

Create `apps/web/src/features/search/useDebouncedValue.ts`:

```typescript
import { useEffect, useState } from "react";

export function useDebouncedValue<T>(value: T, delayMs: number): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), delayMs);
    return () => clearTimeout(timer);
  }, [value, delayMs]);
  return debounced;
}
```

- [ ] **Step 2: Write the search query hook**

Create `apps/web/src/features/search/useSearch.ts`:

```typescript
import { useQuery } from "@tanstack/react-query";
import type { SearchResultsDTO } from "@household/shared";
import { get } from "../../lib/api";

export function useSearch(householdId: string | undefined, query: string) {
  const trimmed = query.trim();
  return useQuery({
    queryKey: ["search", householdId, trimmed],
    queryFn: ({ signal }) => get<SearchResultsDTO>(`/households/${householdId}/search?q=${encodeURIComponent(trimmed)}`, signal).then((r) => r.data),
    enabled: !!householdId && trimmed.length > 0,
  });
}
```

- [ ] **Step 3: Write the failing test files**

Create `apps/web/src/features/search/SearchPage.test.tsx`:

```typescript
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { meKey } from "../auth/session";
import { SearchPage } from "./SearchPage";

const HOUSEHOLD = { id: "h1", name: "Shah Family", timezone: "Asia/Kolkata", role: "OWNER" as const, memberCount: 2 };

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function renderPage(initialQuery: string, responseData: unknown) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  qc.setQueryData(meKey, { user: { id: "u1", name: "Parakh", email: "p@example.com", emailVerified: true, createdAt: "2026-01-01T00:00:00.000Z" }, households: [HOUSEHOLD] });
  vi.spyOn(globalThis, "fetch").mockImplementation((async (input: RequestInfo | URL) => {
    const url = new URL(String(input), "http://localhost");
    if (url.pathname === "/api/households/h1/search") return jsonResponse({ success: true, data: responseData }, 200);
    throw new Error(`unexpected fetch ${url}`);
  }) as typeof fetch);
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={[`/search?q=${initialQuery}`]}>
        <Routes><Route path="/search" element={<SearchPage />} /></Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe("SearchPage", () => {
  beforeEach(() => { vi.restoreAllMocks(); });
  afterEach(() => { vi.restoreAllMocks(); });

  it("renders grouped results from the search response", async () => {
    renderPage("sunita", {
      househelps: [{ id: "hh1", name: "Sunita Devi" }],
      bills: [{ id: "b1", name: "Electricity", provider: "BESCOM" }],
      checklistTasks: [{ id: "t1", name: "Wash dishes" }],
      members: [{ userId: "u2", name: "Priya Shah", email: "priya@example.com" }],
    });
    await screen.findByText("Sunita Devi");
    await screen.findByText("Electricity");
    await screen.findByText("Wash dishes");
    await screen.findByText("Priya Shah");
  });

  it("renders no heading for a section absent from the response", async () => {
    renderPage("x", { househelps: [] });
    await screen.findByText("Househelps");
    expect(screen.queryByText("Bills")).not.toBeInTheDocument();
    expect(screen.queryByText("Checklist")).not.toBeInTheDocument();
    expect(screen.queryByText("Members")).not.toBeInTheDocument();
  });
});
```

- [ ] **Step 4: Run the tests to verify they fail**

Run: `npm run test --workspace @household/web -- SearchPage`
Expected: FAIL — `Cannot find module './SearchPage'`.

- [ ] **Step 5: Implement SearchInput and SearchPage**

Create `apps/web/src/features/search/SearchInput.tsx`:

```tsx
import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useDebouncedValue } from "./useDebouncedValue";

export function SearchInput() {
  const [value, setValue] = useState("");
  const debounced = useDebouncedValue(value, 300);
  const navigate = useNavigate();

  useEffect(() => {
    if (debounced.trim()) navigate(`/search?q=${encodeURIComponent(debounced.trim())}`);
  }, [debounced, navigate]);

  return (
    <div className="shell__search">
      <input type="search" value={value} onChange={(e) => setValue(e.target.value)} placeholder="Search" aria-label="Search" />
    </div>
  );
}
```

Create `apps/web/src/features/search/SearchPage.tsx`:

```tsx
import { useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { useActiveHousehold } from "../app/useActiveHousehold";
import { useDebouncedValue } from "./useDebouncedValue";
import { useSearch } from "./useSearch";

export function SearchPage() {
  const { household } = useActiveHousehold();
  const [searchParams] = useSearchParams();
  const [input, setInput] = useState(searchParams.get("q") ?? "");
  const debounced = useDebouncedValue(input, 300);
  const results = useSearch(household?.id, debounced).data;

  return (
    <>
      <header className="page-head"><h1 className="page-title">Search</h1></header>
      <input
        type="search" value={input} onChange={(e) => setInput(e.target.value)}
        placeholder="Search househelps, bills, checklist, members" aria-label="Search"
        style={{ width: "100%", height: "var(--touch)", padding: "0 var(--space-3)", borderRadius: "var(--radius-sm)", border: "1.5px solid var(--line-strong)", marginBottom: "var(--space-4)" }}
      />
      {results?.househelps && (
        <>
          <h2 className="section-title">Househelps</h2>
          <div className="list">
            {results.househelps.map((h) => (
              <Link key={h.id} to={`/househelps/${h.id}`} className="list__item"><span className="list__label">{h.name}</span></Link>
            ))}
          </div>
        </>
      )}
      {results?.bills && (
        <>
          <h2 className="section-title">Bills</h2>
          <div className="list">
            {results.bills.map((b) => (
              <Link key={b.id} to={`/bills/${b.id}`} className="list__item">
                <span className="list__text">
                  <span className="list__label" style={{ display: "block" }}>{b.name}</span>
                  {b.provider && <span className="list__meta">{b.provider}</span>}
                </span>
              </Link>
            ))}
          </div>
        </>
      )}
      {results?.checklistTasks && (
        <>
          <h2 className="section-title">Checklist</h2>
          <div className="list">
            {results.checklistTasks.map((t) => (
              <Link key={t.id} to={`/checklist/${t.id}`} className="list__item"><span className="list__label">{t.name}</span></Link>
            ))}
          </div>
        </>
      )}
      {results?.members && (
        <>
          <h2 className="section-title">Members</h2>
          <div className="list">
            {results.members.map((m) => (
              <div key={m.userId} className="list__item">
                <span className="list__text">
                  <span className="list__label" style={{ display: "block" }}>{m.name}</span>
                  <span className="list__meta">{m.email}</span>
                </span>
              </div>
            ))}
          </div>
        </>
      )}
    </>
  );
}
```

- [ ] **Step 6: Wire the route**

In `apps/web/src/App.tsx`, add the import after `import { NotificationSettingsPage } from "./features/settings/NotificationSettingsPage";`:

```typescript
import { SearchPage } from "./features/search/SearchPage";
```

Add the route after `<Route path="settings/notifications" element={<NotificationSettingsPage />} />`:

```tsx
        <Route path="settings/notifications" element={<NotificationSettingsPage />} />
        <Route path="search" element={<SearchPage />} />
```

- [ ] **Step 7: Run the tests to verify they pass**

Run: `npm run test --workspace @household/web -- SearchPage`
Expected: PASS

- [ ] **Step 8: Add the two entry points to AppShell**

The existing `apps/web/src/features/app/AppShell.tsx` (post-Phase-7):

```tsx
import { NavLink, Outlet } from "react-router-dom";
import { Bell, ClipboardCheck, Home, MoreHorizontal, ReceiptIndianRupee, Users } from "lucide-react";
import { Logo } from "../../components/Logo";
import { NotificationBadge } from "../notifications/NotificationBadge";
import { useUnreadCount } from "../notifications/useNotifications";
import { useActiveHousehold } from "./useActiveHousehold";
import "./shell.css";
```

Change the `lucide-react` import to add `Search`, and add a new import for `SearchInput`:

```typescript
import { Bell, ClipboardCheck, Home, MoreHorizontal, ReceiptIndianRupee, Search, Users } from "lucide-react";
import { Logo } from "../../components/Logo";
import { NotificationBadge } from "../notifications/NotificationBadge";
import { useUnreadCount } from "../notifications/useNotifications";
import { SearchInput } from "../search/SearchInput";
import { useActiveHousehold } from "./useActiveHousehold";
```

Change the component body to add the mobile icon (right after the opening `<div className="shell">` and its skip-link, before `<nav>`) and the desktop `SearchInput` (right after `.shell__brand`'s closing `</div>`, before `<ul>`):

```tsx
export function AppShell() {
  const { household } = useActiveHousehold();
  const unreadCount = useUnreadCount(household?.id).data ?? 0;
  return (
    <div className="shell">
      <a href="#main" className="skip-link">Skip to content</a>
      <NavLink to="/search" className="shell__mobile-search" aria-label="Open search">
        <Search size={20} aria-hidden strokeWidth={2} />
      </NavLink>
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
        <SearchInput />
        <ul>
          {NAV.map(({ to, label, icon: Icon, end }) => (
            <li key={to}>
              <NavLink to={to} end={end} className="shell__link">
                <Icon size={24} aria-hidden strokeWidth={2} />
                <span>{label}</span>
              </NavLink>
            </li>
          ))}
        </ul>
      </nav>
      <main id="main" className="shell__main" tabIndex={-1}>
        <Outlet />
      </main>
    </div>
  );
}
```

(the `NAV` array above the component and everything else in the file is unchanged)

- [ ] **Step 9: Add the CSS**

In `apps/web/src/features/app/shell.css`, add after `.shell__brand { display: none; }` (mobile-default section, near the top of the file):

```css
.shell__search { display: none; }
.shell__mobile-search {
  position: fixed; top: calc(var(--safe-top) + var(--space-3)); right: var(--space-4); z-index: 20;
  display: flex; align-items: center; justify-content: center; width: 40px; height: 40px;
  border-radius: 999px; background: var(--surface); border: 1px solid var(--line); color: var(--ink-2);
}
```

Inside the existing `@media (min-width: 900px)` block, add after the `.badge-count` rule:

```css
  .shell__mobile-search { display: none; }
  .shell__search { display: block; padding: 0 var(--space-3) var(--space-4); margin-bottom: var(--space-4); border-bottom: 1px solid var(--line); }
  .shell__search input {
    width: 100%; height: var(--touch); padding: 0 var(--space-3); border-radius: var(--radius-sm);
    border: 1.5px solid var(--line-strong); background: var(--paper); font-size: var(--text-sm);
  }
```

- [ ] **Step 10: Extend AppShell.test.tsx**

The existing `renderShell` helper in `apps/web/src/features/app/AppShell.test.tsx` only registers an index route. Change its `<Routes>` to also register a `/search` destination route (as a sibling, not nested under the shell layout):

```tsx
      <MemoryRouter initialEntries={["/"]}>
        <Routes>
          <Route element={<AppShell />}><Route index element={<div>Home page body</div>} /></Route>
          <Route path="/search" element={<div>Search results page</div>} />
        </Routes>
      </MemoryRouter>
```

Add these 2 tests to the existing `describe("AppShell", ...)` block:

```typescript
  it("has a mobile search icon linking to /search", async () => {
    renderShell(0);
    await screen.findByText("Home page body");
    expect(screen.getByLabelText("Open search")).toHaveAttribute("href", "/search");
  });

  it("navigates to /search after typing in the desktop search input (debounced)", async () => {
    renderShell(0);
    const input = await screen.findByPlaceholderText("Search");
    await userEvent.type(input, "sunita");
    await new Promise((r) => setTimeout(r, 350));
    await screen.findByText("Search results page");
  });
```

This requires `userEvent` in the test file — add it to the existing imports at the top:

```typescript
import userEvent from "@testing-library/user-event";
```

- [ ] **Step 11: Run the tests to verify they pass**

Run: `npm run test --workspace @household/web -- AppShell SearchPage`
Expected: PASS

- [ ] **Step 12: Run the full web suite as a regression check**

Run: `npm run test --workspace @household/web`
Expected: PASS — confirms the `AppShell`/`shell.css` changes didn't break any other page that renders inside the shell.

- [ ] **Step 13: Typecheck**

Run: `npm run typecheck --workspace @household/web`
Expected: PASS.

- [ ] **Step 14: Commit**

```bash
git add apps/web/src/features/search apps/web/src/features/app/AppShell.tsx apps/web/src/features/app/AppShell.test.tsx apps/web/src/features/app/shell.css apps/web/src/App.tsx
git commit -m "feat(web): cross-entity search entry points and results page"
```

---

## Self-Review Notes

- **Spec coverage:** all 4 entity types with their exact documented match fields (househelps name; bills name-or-provider; checklist tasks name; members real-name-or-displayName-or-email) ✓, 10-result cap ✓ (tested without asserting ordering), per-section permission gating via absent keys ✓ (tested the same way as Spec 1), empty query → empty arrays not omitted keys ✓, cross-household isolation ✓, 404 for non-member ✓ (all Task 1); desktop sidebar debounced input + mobile icon (distinct `aria-label`s — "Search" for the input, "Open search" for the icon — avoiding an ambiguous dual-match in tests, since jsdom doesn't evaluate the CSS media queries that visually hide one or the other) ✓, results page renders grouped sections, a section only renders its content when present ✓, both entry points navigate to `/search` ✓ (all Task 2). Members are explicitly non-clickable per Global Constraints — no detail page exists, and adding one is out of scope.
- **Type consistency:** `SearchResultsDTO`'s 4 optional fields (Task 1) match exactly what `SearchPage.tsx` (Task 2) destructures (`results?.househelps`, `.bills`, `.checklistTasks`, `.members`); `useSearch`'s return type flows through unchanged.
- **No placeholders:** every step has runnable code.
