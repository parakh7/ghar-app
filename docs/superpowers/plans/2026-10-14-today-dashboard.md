# Phase 8 Spec 1 — Today Dashboard Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace `HomePage.tsx`'s 3 permanently-empty placeholder cards with real data, and fix the existing Salaries card's N+1 client-side fan-out, via one new aggregated `GET /households/:householdId/today` endpoint.

**Architecture:** A `today.service.ts` composes 4 already-existing service functions (`getToday`, `getTodayChecklist`, `listDueOccurrencesForHousehold`, `listSettlementsForHousehold`) into one response, gating each section on the caller's existing permission (`attendance.view`/`checklists.view`/`bills.view`/`salaries.view`) via `req.membership.permissions` (already resolved by `requireHousehold`). A section a caller lacks permission for is **omitted from the response object entirely** (the key is absent) — this is deliberately different from "present but empty," which represents a real zero-item state the caller IS allowed to see.

**Tech Stack:** Express 5, Drizzle ORM (API); React 19, TanStack Query (web); Vitest, Supertest, Testing Library.

## Global Constraints

- No new database tables or columns — pure aggregation of existing data.
- No new permission — reuse `attendance.view`, `checklists.view`, `bills.view`, `salaries.view` exactly as already defined (`permissions.ts:17-28`).
- The `GET /today` route itself is gated on `household.view` only; per-section visibility happens inside the response, not via route-level 403s — a VIEWER-only member should see their permitted sections.
- **Design refinement from the approved spec**: the spec described denied sections as `null`. Implementing that literally collides with salary's own legitimate `null` ("permitted, but nothing currently due") — the two meanings would be indistinguishable to the web client. This plan instead uses **optional/absent keys** for "no permission" and keeps each section's own natural empty representation (`{marked:0,total:0}`, `{done:0,total:0,pending:[]}`, `[]`, or `{upcoming:null,hasAnySettlement:false}`) for "permitted, nothing to show." This is a bug-fix refinement to the design, not a scope change — flag it to the user when the plan is reviewed.
- Per project testing cadence: targeted test files only per task; full suite at merge time.

---

## File Structure

- Modify: `packages/shared/src/dto.ts` — add `TodayAttendanceSummaryDTO`, `TodayChecklistSummaryDTO`, `TodayBillDTO`, `TodaySalaryDTO`, `TodaySalarySectionDTO`, `TodayDashboardDTO`.
- Create: `apps/api/src/services/today.service.ts`.
- Modify: `apps/api/src/routes/household.routes.ts` — 1 new route.
- Create: `apps/api/tests/today.test.ts`.
- Create: `apps/web/src/features/app/useTodayDashboard.ts`.
- Modify: `apps/web/src/features/app/HomePage.tsx` — all 4 cards wired to the new hook.
- Modify: `apps/web/src/features/app/salary/useSalary.ts` — remove the now-unused `useUpcomingSettlement` and its dead imports.
- Create: `apps/web/src/features/app/HomePage.test.tsx`.

---

### Task 1: Backend — today.service.ts, route, and tests

**Files:**
- Modify: `packages/shared/src/dto.ts` (append after `NotificationPreferenceDTO`, end of file)
- Create: `apps/api/src/services/today.service.ts`
- Modify: `apps/api/src/routes/household.routes.ts:20` (new service import, alphabetically before `household.service.js`'s own import... actually insert after line 22's `member.service.js` import and before `notification-preference.service.js`, i.e. directly before line 23), append 1 route after the `notification-preferences` block (after the `PATCH .../:category` block added in the previous plan), before `return r;`
- Test: `apps/api/tests/today.test.ts`

**Interfaces:**
- Consumes: `getToday(deps, membership): Promise<TodayAttendanceDTO>` (`attendance.service.ts:35`, returns `{date, entries: {househelpId, name, roleTitle, scheduledToday, status, note}[]}`), `getTodayChecklist(deps, membership): Promise<TodayChecklistDTO>` (`checklist-completion.service.ts:41`, returns `{date, entries: {taskId, name, status, note}[]}`), `listDueOccurrencesForHousehold(deps, householdId): Promise<{occurrenceId, billId, billName, dueDate, amountDuePaise}[]>` (`bill-occurrence.service.ts:358`), `listSettlementsForHousehold(deps, householdId): Promise<SettlementDTO[]>` (`salary-settlement.service.ts:331`), `listHousehelps(db, householdId, includeArchived): Promise<HousehelpDTO[]>` (`househelp.service.ts:27`), `dateInZone(instant, timeZone): ISODate` (`@household/shared`), `Membership` type + `req.membership.permissions: Set<Permission>` (already attached by `requireHousehold`, `types.d.ts:10`).
- Produces: `TodayDashboardDTO = { attendance?: TodayAttendanceSummaryDTO; checklist?: TodayChecklistSummaryDTO; bills?: TodayBillDTO[]; salary?: TodaySalarySectionDTO }` and `getTodayDashboard(deps, membership): Promise<TodayDashboardDTO>`, registered at `GET /households/:householdId/today`.

- [ ] **Step 1: Add the shared types**

In `packages/shared/src/dto.ts`, append after the `NotificationPreferenceDTO` type (end of file):

```typescript

export type TodayAttendanceSummaryDTO = { marked: number; total: number };
export type TodayChecklistSummaryDTO = { done: number; total: number; pending: string[] };
export type TodayBillDTO = {
  occurrenceId: string; billId: string; billName: string;
  amountDuePaise: number; dueDate: string; isOverdue: boolean;
};
export type TodaySalaryDTO = {
  settlementId: string; househelpName: string; periodMonth: string;
  dueDate: string; netDuePaise: number; status: SettlementStatus;
};
export type TodaySalarySectionDTO = { upcoming: TodaySalaryDTO | null; hasAnySettlement: boolean };

export type TodayDashboardDTO = {
  attendance?: TodayAttendanceSummaryDTO;
  checklist?: TodayChecklistSummaryDTO;
  bills?: TodayBillDTO[];
  salary?: TodaySalarySectionDTO;
};
```

- [ ] **Step 2: Write the failing test file**

Create `apps/api/tests/today.test.ts`:

```typescript
import { eq } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { addDays } from "@household/shared";
import { attendanceRecords, billOccurrences, checklistCompletions, checklistTasks, households, householdMembers, househelps, salarySettlements } from "../src/db/schema.js";
import { createTestContext, csrf, signupUser, truncateAll, type TestContext } from "./helpers.js";

const ctx = createTestContext();
const NOW = "2026-09-29T04:30:00Z"; // 10:00 IST
const TODAY = "2026-09-29";

beforeEach(async () => { await truncateAll(ctx.db); ctx.clock.set(NOW); });
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

async function createBill(h: { id: string }, cookie: string, firstDueDate: string) {
  const res = await ctx.request.post(`/api/households/${h.id}/bills`).set(csrf).set("cookie", cookie)
    .send({ name: "Electricity", frequency: "ONE_TIME", firstDueDate, amountPaise: 50000 });
  expect(res.status).toBe(201);
  const bill = res.body.data as { id: string };
  const [occurrence] = await ctx.db.select().from(billOccurrences).where(eq(billOccurrences.billId, bill.id));
  return { bill, occurrence: occurrence! };
}

async function addMember(householdId: string, userId: string, role: "MEMBER" | "VIEWER" = "MEMBER") {
  await ctx.db.insert(householdMembers).values({ householdId, userId, role, status: "ACTIVE" });
}

let seq = 0;
async function createSettlement(householdId: string, househelpId: string, dueDate: string, overrides: Record<string, unknown> = {}) {
  seq += 1;
  const periodMonth = `2026-${String((seq % 12) + 1).padStart(2, "0")}-01`;
  const [row] = await ctx.db.insert(salarySettlements).values({
    householdId, househelpId, periodMonth, dueDate, basePaise: 1000000, workingDays: 26, netPayablePaise: 1000000, ...overrides,
  }).returning();
  return row!;
}

describe("GET /today", () => {
  it("includes a section only when the caller has its permission", async () => {
    const owner = await signupUser(ctx);
    const h = await createHousehold(ctx, owner.cookie);
    const member = await signupUser(ctx);
    await addMember(h.id, member.id, "MEMBER");
    await ctx.db.update(households).set({ rolePermissionOverrides: { MEMBER: { revoke: ["bills.view"] } } }).where(eq(households.id, h.id));

    const res = await ctx.request.get(`/api/households/${h.id}/today`).set("cookie", member.cookie);
    expect(res.status).toBe(200);
    expect(res.body.data).not.toHaveProperty("bills");
    expect(res.body.data).toHaveProperty("attendance");
    expect(res.body.data).toHaveProperty("checklist");
    expect(res.body.data).toHaveProperty("salary");

    const ownerRes = await ctx.request.get(`/api/households/${h.id}/today`).set("cookie", owner.cookie);
    expect(ownerRes.body.data).toHaveProperty("bills"); // OWNER's permissions can never be revoked
  });

  it("returns empty/zero sections for a household with nothing yet", async () => {
    const owner = await signupUser(ctx);
    const h = await createHousehold(ctx, owner.cookie);

    const res = await ctx.request.get(`/api/households/${h.id}/today`).set("cookie", owner.cookie);
    expect(res.body.data).toEqual({
      attendance: { marked: 0, total: 0 },
      checklist: { done: 0, total: 0, pending: [] },
      bills: [],
      salary: { upcoming: null, hasAnySettlement: false },
    });
  });

  it("computes attendance marked/total from today's active househelps and records", async () => {
    const owner = await signupUser(ctx);
    const h = await createHousehold(ctx, owner.cookie);
    const marked = await createHousehelp(h.id, "Sunita");
    await createHousehelp(h.id, "Geeta");
    await ctx.db.insert(attendanceRecords).values({ householdId: h.id, househelpId: marked.id, date: TODAY, status: "PRESENT" });

    const res = await ctx.request.get(`/api/households/${h.id}/today`).set("cookie", owner.cookie);
    expect(res.body.data.attendance).toEqual({ marked: 1, total: 2 });
  });

  it("computes checklist done/total/pending from today's due tasks and completions", async () => {
    const owner = await signupUser(ctx);
    const h = await createHousehold(ctx, owner.cookie);
    const [doneTask] = await ctx.db.insert(checklistTasks).values({ householdId: h.id, name: "Wash dishes", frequency: "DAILY" }).returning();
    await ctx.db.insert(checklistTasks).values({ householdId: h.id, name: "Sweep floor", frequency: "DAILY" });
    await ctx.db.insert(checklistCompletions).values({ householdId: h.id, taskId: doneTask!.id, date: TODAY, status: "COMPLETED" });

    const res = await ctx.request.get(`/api/households/${h.id}/today`).set("cookie", owner.cookie);
    expect(res.body.data.checklist).toEqual({ done: 1, total: 2, pending: ["Sweep floor"] });
  });

  it("includes bills due today or overdue, excludes future-due bills", async () => {
    const owner = await signupUser(ctx);
    const h = await createHousehold(ctx, owner.cookie);
    const { occurrence: todayOcc } = await createBill(h, owner.cookie, TODAY);
    const { occurrence: overdueOcc } = await createBill(h, owner.cookie, addDays(TODAY, -3));
    await createBill(h, owner.cookie, addDays(TODAY, 5)); // future — excluded

    const res = await ctx.request.get(`/api/households/${h.id}/today`).set("cookie", owner.cookie);
    const ids = res.body.data.bills.map((b: { occurrenceId: string }) => b.occurrenceId);
    expect(ids).toContain(todayOcc.id);
    expect(ids).toContain(overdueOcc.id);
    expect(ids).toHaveLength(2);
    expect(res.body.data.bills.find((b: { occurrenceId: string }) => b.occurrenceId === overdueOcc.id).isOverdue).toBe(true);
    expect(res.body.data.bills.find((b: { occurrenceId: string }) => b.occurrenceId === todayOcc.id).isOverdue).toBe(false);
  });

  it("excludes a paid occurrence due today", async () => {
    const owner = await signupUser(ctx);
    const h = await createHousehold(ctx, owner.cookie);
    const { occurrence } = await createBill(h, owner.cookie, TODAY);
    await ctx.db.update(billOccurrences).set({ status: "PAID", amountPaidPaise: 50000, paidAt: ctx.clock.now() }).where(eq(billOccurrences.id, occurrence.id));

    const res = await ctx.request.get(`/api/households/${h.id}/today`).set("cookie", owner.cookie);
    expect(res.body.data.bills).toEqual([]);
  });

  it("salary picks the single nearest-due unpaid settlement across househelps", async () => {
    const owner = await signupUser(ctx);
    const h = await createHousehold(ctx, owner.cookie);
    const a = await createHousehelp(h.id, "Sunita");
    const b = await createHousehelp(h.id, "Geeta");
    await createSettlement(h.id, a.id, addDays(TODAY, 10));
    const nearer = await createSettlement(h.id, b.id, addDays(TODAY, 3));

    const res = await ctx.request.get(`/api/households/${h.id}/today`).set("cookie", owner.cookie);
    expect(res.body.data.salary.upcoming).toMatchObject({ settlementId: nearer.id, househelpName: "Geeta" });
    expect(res.body.data.salary.hasAnySettlement).toBe(true);
  });

  it("salary reports hasAnySettlement true but upcoming null when everything is paid", async () => {
    const owner = await signupUser(ctx);
    const h = await createHousehold(ctx, owner.cookie);
    const help = await createHousehelp(h.id, "Sunita");
    await createSettlement(h.id, help.id, TODAY, { status: "PAID", amountPaidPaise: 1000000, paidAt: ctx.clock.now() });

    const res = await ctx.request.get(`/api/households/${h.id}/today`).set("cookie", owner.cookie);
    expect(res.body.data.salary).toEqual({ upcoming: null, hasAnySettlement: true });
  });

  it("never reflects another household's data", async () => {
    const ownerA = await signupUser(ctx);
    const hA = await createHousehold(ctx, ownerA.cookie, "Household A");
    const helpA = await createHousehelp(hA.id, "Sunita");
    await ctx.db.insert(attendanceRecords).values({ householdId: hA.id, househelpId: helpA.id, date: TODAY, status: "PRESENT" });

    const ownerB = await signupUser(ctx);
    const hB = await createHousehold(ctx, ownerB.cookie, "Household B");

    const res = await ctx.request.get(`/api/households/${hB.id}/today`).set("cookie", ownerB.cookie);
    expect(res.body.data.attendance).toEqual({ marked: 0, total: 0 });
  });

  it("404s for a non-member", async () => {
    const owner = await signupUser(ctx);
    const h = await createHousehold(ctx, owner.cookie);
    const stranger = await signupUser(ctx);
    const res = await ctx.request.get(`/api/households/${h.id}/today`).set("cookie", stranger.cookie);
    expect(res.status).toBe(404);
  });
});
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `npm run test --workspace @household/api -- today`
Expected: FAIL — `Cannot find module '../src/services/today.service.js'` (and/or 404s from the unregistered route).

- [ ] **Step 4: Implement the service**

Create `apps/api/src/services/today.service.ts`:

```typescript
import { dateInZone } from "@household/shared";
import type { Permission, TodayAttendanceSummaryDTO, TodayBillDTO, TodayChecklistSummaryDTO, TodayDashboardDTO, TodaySalarySectionDTO } from "@household/shared";
import { getToday } from "./attendance.service.js";
import { listDueOccurrencesForHousehold } from "./bill-occurrence.service.js";
import { getTodayChecklist } from "./checklist-completion.service.js";
import type { Deps } from "./deps.js";
import type { Membership } from "./household.service.js";
import { listHousehelps } from "./househelp.service.js";
import { listSettlementsForHousehold } from "./salary-settlement.service.js";

type AuthedMembership = Membership & { permissions: Set<Permission> };

async function getAttendanceSection(deps: Deps, membership: Membership): Promise<TodayAttendanceSummaryDTO> {
  const { entries } = await getToday(deps, membership);
  return { marked: entries.filter((e) => e.status !== null).length, total: entries.length };
}

async function getChecklistSection(deps: Deps, membership: Membership): Promise<TodayChecklistSummaryDTO> {
  const { entries } = await getTodayChecklist(deps, membership);
  return {
    done: entries.filter((e) => e.status !== null).length,
    total: entries.length,
    pending: entries.filter((e) => e.status === null).map((e) => e.name),
  };
}

async function getBillsSection(deps: Deps, householdId: string, today: string): Promise<TodayBillDTO[]> {
  const rows = await listDueOccurrencesForHousehold(deps, householdId);
  return rows.filter((r) => r.dueDate <= today).map((r) => ({ ...r, isOverdue: r.dueDate < today }));
}

/** Mirrors the web's existing `useUpcomingSettlement` selection logic (nearest-due, not PAID/CANCELLED), moved server-side with one query instead of a per-househelp fan-out. */
async function getSalarySection(deps: Deps, householdId: string): Promise<TodaySalarySectionDTO> {
  const [settlements, helps] = await Promise.all([
    listSettlementsForHousehold(deps, householdId),
    listHousehelps(deps.db, householdId, false),
  ]);
  const nameById = new Map(helps.map((h) => [h.id, h.name]));
  const unpaid = settlements.filter((s) => s.status !== "PAID" && s.status !== "CANCELLED").sort((a, b) => a.dueDate.localeCompare(b.dueDate));
  const next = unpaid[0];
  const upcoming = next
    ? {
        settlementId: next.id, househelpName: nameById.get(next.househelpId) ?? "", periodMonth: next.periodMonth,
        dueDate: next.dueDate, netDuePaise: next.netPayablePaise - next.amountPaidPaise, status: next.status,
      }
    : null;
  return { upcoming, hasAnySettlement: settlements.length > 0 };
}

export async function getTodayDashboard(deps: Deps, membership: AuthedMembership): Promise<TodayDashboardDTO> {
  const today = dateInZone(deps.clock.now(), membership.timezone);
  const dashboard: TodayDashboardDTO = {};

  if (membership.permissions.has("attendance.view")) dashboard.attendance = await getAttendanceSection(deps, membership);
  if (membership.permissions.has("checklists.view")) dashboard.checklist = await getChecklistSection(deps, membership);
  if (membership.permissions.has("bills.view")) dashboard.bills = await getBillsSection(deps, membership.householdId, today);
  if (membership.permissions.has("salaries.view")) dashboard.salary = await getSalarySection(deps, membership.householdId);

  return dashboard;
}
```

- [ ] **Step 5: Wire the route**

In `apps/api/src/routes/household.routes.ts`, add a new service import before `import * as notificationPreferencesService from "../services/notification-preference.service.js";`:

```typescript
import * as today from "../services/today.service.js";
```

Append this route after the `notification-preferences` `PATCH .../:category` block, before the final `return r;`:

```typescript
  r.get("/:householdId/today", requireHousehold(deps, "household.view"), async (req, res) => {
    ok(res, await today.getTodayDashboard(deps, req.membership!));
  });
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `npm run test --workspace @household/api -- today`
Expected: PASS

- [ ] **Step 7: Typecheck and build**

Run: `npm run build --workspace @household/shared && npm run typecheck --workspace @household/api && npm run build --workspace @household/api`
Expected: PASS (the 2 pre-existing, unrelated `TS18048` failures in `tests/bill-category.test.ts`/`tests/bill.test.ts` are not part of this change).

- [ ] **Step 8: Commit**

```bash
git add packages/shared/src/dto.ts apps/api/src/services/today.service.ts apps/api/src/routes/household.routes.ts apps/api/tests/today.test.ts
git commit -m "feat(api): today dashboard aggregation endpoint"
```

---

### Task 2: Web — wire HomePage to the dashboard, remove the old fan-out

**Files:**
- Create: `apps/web/src/features/app/useTodayDashboard.ts`
- Modify: `apps/web/src/features/app/HomePage.tsx` (full rewrite of the component body)
- Modify: `apps/web/src/features/app/salary/useSalary.ts` (remove `useUpcomingSettlement` and its now-dead imports)
- Create: `apps/web/src/features/app/HomePage.test.tsx`

**Interfaces:**
- Consumes: `TodayDashboardDTO` (Task 1, `@household/shared`), `GET /households/:householdId/today` (Task 1).
- Produces: `useTodayDashboard(householdId): UseQueryResult<TodayDashboardDTO>`.

- [ ] **Step 1: Write the hook**

Create `apps/web/src/features/app/useTodayDashboard.ts`:

```typescript
import { useQuery } from "@tanstack/react-query";
import type { TodayDashboardDTO } from "@household/shared";
import { get } from "../../lib/api";

export function useTodayDashboard(householdId: string | undefined) {
  return useQuery({
    queryKey: ["today-dashboard", householdId],
    queryFn: ({ signal }) => get<TodayDashboardDTO>(`/households/${householdId}/today`, signal).then((r) => r.data),
    enabled: !!householdId,
  });
}
```

- [ ] **Step 2: Write the failing test file**

Create `apps/web/src/features/app/HomePage.test.tsx`:

```typescript
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { meKey } from "../auth/session";
import { HomePage } from "./HomePage";

const HOUSEHOLD = { id: "h1", name: "Shah Family", timezone: "Asia/Kolkata", role: "OWNER" as const, memberCount: 2 };

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function renderPage(dashboard: unknown) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  qc.setQueryData(meKey, { user: { id: "u1", name: "Parakh", email: "p@example.com", emailVerified: true, createdAt: "2026-01-01T00:00:00.000Z" }, households: [HOUSEHOLD] });
  vi.spyOn(globalThis, "fetch").mockImplementation((async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.endsWith("/households/h1/today")) return jsonResponse({ success: true, data: dashboard }, 200);
    throw new Error(`unexpected fetch ${url}`);
  }) as typeof fetch);
  return render(<QueryClientProvider client={qc}><MemoryRouter><HomePage /></MemoryRouter></QueryClientProvider>);
}

describe("HomePage", () => {
  beforeEach(() => { vi.restoreAllMocks(); });
  afterEach(() => { vi.restoreAllMocks(); });

  it("renders real content for every section the caller has permission for", async () => {
    renderPage({
      attendance: { marked: 2, total: 3 },
      checklist: { done: 1, total: 2, pending: ["Sweep floor"] },
      bills: [{ occurrenceId: "o1", billId: "b1", billName: "Electricity", amountDuePaise: 50000, dueDate: "2026-09-29", isOverdue: false }],
      salary: { upcoming: { settlementId: "s1", househelpName: "Sunita", periodMonth: "2026-09-01", dueDate: "2026-10-05", netDuePaise: 1000000, status: "PENDING" }, hasAnySettlement: true },
    });
    await screen.findByText("2 of 3 marked today");
    await screen.findByText("1 of 2 done");
    await screen.findByText("Sweep floor");
    await screen.findByText("Electricity");
    await screen.findByText(/Sunita/);
  });

  it("hides a card entirely when its section is absent (no permission)", async () => {
    renderPage({
      attendance: { marked: 0, total: 0 },
      checklist: { done: 0, total: 0, pending: [] },
      // bills and salary omitted — caller lacks bills.view/salaries.view
    });
    await screen.findByText("No househelps yet");
    expect(screen.queryByText("Payments")).not.toBeInTheDocument();
    expect(screen.queryByText("Salaries")).not.toBeInTheDocument();
  });

  it("shows the all-settled empty state when permitted but nothing is due", async () => {
    renderPage({
      attendance: { marked: 0, total: 0 },
      checklist: { done: 0, total: 0, pending: [] },
      bills: [],
      salary: { upcoming: null, hasAnySettlement: true },
    });
    await screen.findByText("All settled up");
  });

  it("shows the nothing-due empty state when permitted and no settlement exists yet", async () => {
    renderPage({
      attendance: { marked: 0, total: 0 },
      checklist: { done: 0, total: 0, pending: [] },
      bills: [],
      salary: { upcoming: null, hasAnySettlement: false },
    });
    await screen.findByText("Nothing due");
  });
});
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `npm run test --workspace @household/web -- HomePage`
Expected: FAIL — content assertions fail against the current always-placeholder cards.

- [ ] **Step 4: Rewrite HomePage.tsx**

Replace the full contents of `apps/web/src/features/app/HomePage.tsx`:

```tsx
import { ClipboardCheck, ReceiptIndianRupee, Users, Wallet } from "lucide-react";
import { Link, useNavigate } from "react-router-dom";
import { formatINR } from "@household/shared";
import { useSession } from "../auth/session";
import { greeting, longDate } from "../../lib/format";
import { Button } from "../../components/Button";
import { EmptyState } from "../../components/EmptyState";
import { VerifyEmailBanner } from "./VerifyEmailBanner";
import { STATUS_LABEL, toneOf } from "./salary/statusTone";
import { useActiveHousehold } from "./useActiveHousehold";
import { useTodayDashboard } from "./useTodayDashboard";

/** "2026-10-01" -> "October 2026". */
function monthLabel(periodMonth: string): string {
  const [y, m] = periodMonth.split("-").map(Number);
  return new Date(Date.UTC(y!, m! - 1, 1)).toLocaleDateString("en-IN", { month: "long", year: "numeric", timeZone: "UTC" });
}

export function HomePage() {
  const { data } = useSession();
  const navigate = useNavigate();
  const { household } = useActiveHousehold();
  const dashboardQuery = useTodayDashboard(household?.id);
  const dashboard = dashboardQuery.data;
  const tz = household?.timezone ?? "Asia/Kolkata";
  const now = new Date();
  const [weekday, ...rest] = longDate(now, tz).split(" ");
  const firstName = data?.user.name.split(/\s+/)[0];

  return (
    <>
      <VerifyEmailBanner />
      <header className="today">
        <p className="today__greet">{greeting(now, tz)}{firstName ? `, ${firstName}` : ""}</p>
        <h1 className="today__date"><mark>{weekday?.replace(",", "")}</mark>,<br />{rest.join(" ")}</h1>
        <p className="today__stamp"><span className="today__dot" aria-hidden />Today at {household?.name}</p>
      </header>
      <div className="home-grid">
        {dashboard?.attendance && (
          <section className="card card--enter" style={{ animationDelay: "0ms" }} aria-labelledby="h-help">
            <h2 className="card__title" id="h-help">Househelp</h2>
            {dashboard.attendance.total === 0 ? (
              <EmptyState icon={<Users size={22} />} title="No househelps yet" text="Add the people who help at home to track who's coming each day." tone="coral" />
            ) : (
              <div className="list">
                <Link to="/attendance" className="list__item">
                  <span className="list__label">{dashboard.attendance.marked} of {dashboard.attendance.total} marked today</span>
                </Link>
              </div>
            )}
          </section>
        )}
        {dashboard?.checklist && (
          <section className="card card--enter" style={{ animationDelay: "70ms" }} aria-labelledby="h-work">
            <h2 className="card__title" id="h-work">Today's work</h2>
            {dashboard.checklist.total === 0 ? (
              <EmptyState icon={<ClipboardCheck size={22} />} title="No tasks for today" text="Create a checklist — daily dusting, Saturday bathrooms — and tick things off as they're done." tone="amber" />
            ) : (
              <div className="list">
                <Link to="/checklist/today" className="list__item">
                  <span className="list__label">{dashboard.checklist.done} of {dashboard.checklist.total} done</span>
                </Link>
                {dashboard.checklist.pending.map((name) => (
                  <div key={name} className="list__item"><span className="list__meta">{name}</span></div>
                ))}
              </div>
            )}
          </section>
        )}
        {dashboard?.bills && (
          <section className="card card--enter" style={{ animationDelay: "140ms" }} aria-labelledby="h-pay">
            <h2 className="card__title" id="h-pay">Payments</h2>
            {dashboard.bills.length === 0 ? (
              <EmptyState icon={<ReceiptIndianRupee size={22} />} title="No bills tracked" text="Keep track of electricity, WiFi, maintenance and more. We'll remind you before they're due." tone="dusk" />
            ) : (
              <div className="list">
                {dashboard.bills.map((b) => (
                  <Link key={b.occurrenceId} to={`/bills/${b.billId}`} className="list__item">
                    <span className="list__text">
                      <span className="list__label" style={{ display: "block" }}>{b.billName}</span>
                      <span className="list__meta">{formatINR(b.amountDuePaise)} · {b.dueDate}</span>
                    </span>
                    {b.isOverdue && <span className="badge badge--error">Overdue</span>}
                  </Link>
                ))}
              </div>
            )}
          </section>
        )}
        {dashboard?.salary && (
          <section className="card card--enter" style={{ animationDelay: "210ms" }} aria-labelledby="h-sal">
            <h2 className="card__title" id="h-sal">Salaries</h2>
            {dashboard.salary.upcoming ? (
              <div className="list">
                <Link to={`/salary/${dashboard.salary.upcoming.settlementId}`} className="list__item">
                  <span className="list__text">
                    <span className="list__label" style={{ display: "block" }}>{dashboard.salary.upcoming.househelpName} · {monthLabel(dashboard.salary.upcoming.periodMonth)}</span>
                    <span className="list__meta">{formatINR(dashboard.salary.upcoming.netDuePaise)} due</span>
                  </span>
                  <span className={`badge badge--${toneOf(dashboard.salary.upcoming.status)}`}>{STATUS_LABEL[dashboard.salary.upcoming.status]}</span>
                </Link>
              </div>
            ) : dashboard.salary.hasAnySettlement ? (
              <EmptyState
                icon={<Wallet size={22} />} title="All settled up" text="Every settlement for this household has been paid in full." tone="coral"
                action={<Button variant="secondary" onClick={() => navigate("/salary")}>View all salaries</Button>}
              />
            ) : (
              <EmptyState
                icon={<Wallet size={22} />} title="Nothing due" text="Salaries appear here a few days before they're due." tone="coral"
                action={<Button variant="secondary" onClick={() => navigate("/salary")}>View all salaries</Button>}
              />
            )}
          </section>
        )}
      </div>
    </>
  );
}
```

- [ ] **Step 5: Remove the now-unused `useUpcomingSettlement`**

In `apps/web/src/features/app/salary/useSalary.ts`:
1. Delete the entire `useUpcomingSettlement` function (its doc comment at the top of the function through its closing `}`).
2. Remove `useMemo` from the `"react"` import (line 1) — it was only used inside the deleted function. If the import line becomes `import { useMemo } from "react";` with nothing else needed from `"react"` elsewhere in the file, delete the whole import line.
3. Remove `useQueries` from the `"@tanstack/react-query"` import (line 2) — only used inside the deleted function.
4. Remove the `import { useHousehelps } from "../househelps/useHousehelps";` line (line 8) — only used inside the deleted function.

(Verify with a search inside the file that none of `useMemo`/`useQueries`/`useHousehelps` are referenced anywhere else in `useSalary.ts` before deleting their imports — the task brief above already confirmed this via a repo-wide grep, but re-check the file itself since this step edits it directly.)

- [ ] **Step 6: Run the tests to verify they pass**

Run: `npm run test --workspace @household/web -- HomePage`
Expected: PASS

- [ ] **Step 7: Run the full web suite as a regression check**

Run: `npm run test --workspace @household/web`
Expected: PASS — confirms removing `useUpcomingSettlement` didn't break anything else (`useSalary.test.ts` or similar, if any exists).

- [ ] **Step 8: Typecheck**

Run: `npm run typecheck --workspace @household/web`
Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add apps/web/src/features/app/useTodayDashboard.ts apps/web/src/features/app/HomePage.tsx apps/web/src/features/app/salary/useSalary.ts apps/web/src/features/app/HomePage.test.tsx
git commit -m "feat(web): wire HomePage to the today dashboard endpoint"
```

---

## Self-Review Notes

- **Spec coverage:** aggregated endpoint with per-section permission gating ✓ (Task 1, tested for both a revoked-permission MEMBER and an always-permitted OWNER), attendance marked/total ✓, checklist done/total/pending-names-only ✓, bills due-today-or-overdue excluding future/paid ✓, salary nearest-due-unpaid selection fixing the N+1 fan-out ✓ (all tested in Task 1); HomePage's 4 cards wired to real data, permission-denied sections hidden entirely, all 3 original Salaries empty-state branches preserved ✓ (Task 2). The **null-ambiguity fix** (optional keys instead of a universal `null`) is called out explicitly in Global Constraints as a deliberate, flagged deviation from the literal spec text — the user should confirm this is acceptable when reviewing the plan, same as any other plan-time correction.
- **Type consistency:** `TodayDashboardDTO`'s 4 optional fields (Task 1) match exactly what `HomePage.tsx` (Task 2) destructures and null-checks (`dashboard?.attendance`, `dashboard?.checklist`, `dashboard?.bills`, `dashboard?.salary`); `TodaySalarySectionDTO.upcoming`/`hasAnySettlement` match the 3-branch render exactly.
- **No placeholders:** every step has runnable code.
