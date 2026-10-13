# Phase 8 Spec 3 — Reports & Exports Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 4 month-scoped reports (bills spend, salary payout, attendance, checklist completion) behind the previously-unused `reports.view` permission, with client-side CSV export. Last spec in Phase 8.

**Architecture:** One `GET /households/:householdId/reports?type=<...>&month=YYYY-MM` endpoint dispatches to one of 4 functions in a new `report.service.ts`. Bills/salary/attendance mostly reuse existing service functions (one new household-wide, date-ranged bills query is needed since nothing existing fits); checklist is a new day-by-day aggregation using the pure `isTaskDueOn`/`daysInMonth` helpers already in `@household/shared`. `ReportDTO` is a discriminated union (`{type: "bills", ...} | {type: "salary", ...} | ...`) so the web side can type-narrow on `report.type` when rendering. CSV generation is a pure function operating on the already-fetched report JSON, unit-tested directly — never via mocked browser download APIs.

**Tech Stack:** Express 5, Drizzle ORM (API); React 19, TanStack Query (web); Vitest, Supertest, Testing Library.

## Global Constraints

- No new database tables/columns.
- Gated on `reports.view` alone — no additional per-entity permission check (confirmed: this is the single, deliberate gate for the whole feature).
- 4 report types only: `bills`, `salary`, `attendance`, `checklist`. An unrecognized `type` query param is a 400.
- Bills report includes occurrences at **any** status due in the month (not just open ones — this is what makes it a spend report, not a due-items report).
- CSV export is 100% client-side, generated from data the page already has — no new server endpoint, no server-side CSV library.
- **Design refinement during planning**: the approved spec described each report's shape loosely; this plan makes them a proper discriminated union (`ReportDTO = BillsReportDTO | SalaryReportDTO | AttendanceReportDTO | ChecklistReportDTO`, each carrying its own `type` literal) for type-safe rendering — a concretization, not a scope change.
- Per project testing cadence: targeted test files only per task; full suite at merge time (unless told otherwise).

---

## File Structure

- Modify: `packages/shared/src/dto.ts` — add `ReportType` and the 4 report DTO pairs + the `ReportDTO` union.
- Modify: `packages/shared/src/schemas.ts` — add `reportTypeSchema`.
- Modify: `apps/api/src/services/bill-occurrence.service.ts` — add `listOccurrencesDueInMonth`.
- Create: `apps/api/src/services/report.service.ts`.
- Modify: `apps/api/src/routes/household.routes.ts` — 1 new route.
- Create: `apps/api/tests/report.test.ts`.
- Create: `apps/web/src/features/reports/useReports.ts`.
- Create: `apps/web/src/features/reports/csv.ts`.
- Create: `apps/web/src/features/reports/csv.test.ts`.
- Create: `apps/web/src/features/reports/ReportsPage.tsx`.
- Create: `apps/web/src/features/reports/ReportsPage.test.tsx`.
- Modify: `apps/web/src/App.tsx` — new `/reports` route.
- Modify: `apps/web/src/features/app/MorePage.tsx` — new "Reports" row.

---

### Task 1: Backend — report.service.ts, route, and tests

**Files:**
- Modify: `packages/shared/src/dto.ts` (append after `SearchResultsDTO`, end of file)
- Modify: `packages/shared/src/schemas.ts` (append at end of file)
- Modify: `apps/api/src/services/bill-occurrence.service.ts:3` (add `daysInMonth` to the existing `@household/shared` import), append `listOccurrencesDueInMonth` after `listDueOccurrencesForHousehold`
- Create: `apps/api/src/services/report.service.ts`
- Modify: `apps/api/src/routes/household.routes.ts` (add `reportTypeSchema` to the big shared-schema import, add a new service import, append 1 route before `return r;`)
- Test: `apps/api/tests/report.test.ts`

**Interfaces:**
- Consumes: `listSettlementsForHousehold(deps, householdId): Promise<SettlementDTO[]>`, `listHousehelps(db, householdId, includeArchived): Promise<HousehelpDTO[]>`, `getMonthAttendance(db, householdId, househelpId, month): Promise<AttendanceRecordDTO[]>` (`attendance.service.ts:161`), `daysInMonth(year, month): number` and `isTaskDueOn(task, date): boolean` (both `@household/shared`), `req.membership.permissions: Set<Permission>`.
- Produces: `ReportDTO` (discriminated union, see Step 1), `listOccurrencesDueInMonth(deps, householdId, month): Promise<MonthOccurrenceRow[]>`, `getReport(deps, membership, type, month): Promise<ReportDTO>`, registered at `GET /households/:householdId/reports?type=<...>&month=YYYY-MM`.

- [ ] **Step 1: Add the shared types**

In `packages/shared/src/dto.ts`, append after the `SearchResultsDTO` type (end of file):

```typescript

export type ReportType = "bills" | "salary" | "attendance" | "checklist";

export type BillsReportRowDTO = {
  occurrenceId: string; billId: string; billName: string; dueDate: string;
  amountDuePaise: number; amountPaidPaise: number; status: OccurrenceStatus;
};
export type BillsReportDTO = { type: "bills"; rows: BillsReportRowDTO[]; totalDuePaise: number; totalPaidPaise: number };

export type SalaryReportRowDTO = {
  settlementId: string; househelpId: string; househelpName: string;
  netPayablePaise: number; amountPaidPaise: number; status: SettlementStatus;
};
export type SalaryReportDTO = { type: "salary"; rows: SalaryReportRowDTO[]; totalNetPayablePaise: number; totalPaidPaise: number };

export type AttendanceReportRowDTO = {
  househelpId: string; name: string; present: number; absent: number; halfDay: number; leave: number; holiday: number;
};
export type AttendanceReportDTO = { type: "attendance"; rows: AttendanceReportRowDTO[] };

export type ChecklistReportRowDTO = {
  taskId: string; name: string; dueCount: number; completedCount: number; skippedCount: number; missedCount: number;
};
export type ChecklistReportDTO = { type: "checklist"; rows: ChecklistReportRowDTO[] };

export type ReportDTO = BillsReportDTO | SalaryReportDTO | AttendanceReportDTO | ChecklistReportDTO;
```

In `packages/shared/src/schemas.ts`, append at the end of the file:

```typescript

export const reportTypeSchema = z.enum(["bills", "salary", "attendance", "checklist"]);
```

- [ ] **Step 2: Write the failing test file**

Create `apps/api/tests/report.test.ts`:

```typescript
import { eq } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { attendanceRecords, billOccurrences, checklistCompletions, checklistTasks, households, householdMembers, househelps, salarySettlements } from "../src/db/schema.js";
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

async function createBill(h: { id: string }, cookie: string, firstDueDate: string) {
  const res = await ctx.request.post(`/api/households/${h.id}/bills`).set(csrf).set("cookie", cookie)
    .send({ name: "Electricity", frequency: "ONE_TIME", firstDueDate, amountPaise: 50000 });
  expect(res.status).toBe(201);
  const bill = res.body.data as { id: string };
  const [occurrence] = await ctx.db.select().from(billOccurrences).where(eq(billOccurrences.billId, bill.id));
  return { bill, occurrence: occurrence! };
}

async function createSettlement(householdId: string, househelpId: string, periodMonth: string, dueDate: string, overrides: Record<string, unknown> = {}) {
  const [row] = await ctx.db.insert(salarySettlements).values({
    householdId, househelpId, periodMonth, dueDate, basePaise: 1000000, workingDays: 26, netPayablePaise: 1000000, ...overrides,
  }).returning();
  return row!;
}

async function addMember(householdId: string, userId: string, overrides: Record<string, unknown> = {}) {
  // listMembers()'s toMemberDTO (and any route that touches it) non-null-asserts joinedAt — must set
  // it here or a 500 surfaces the instant anything in the request path touches member listing.
  await ctx.db.insert(householdMembers).values({ householdId, userId, role: "MEMBER", status: "ACTIVE", joinedAt: ctx.clock.now(), ...overrides });
}

async function report(h: { id: string }, cookie: string, type: string, month: string) {
  return ctx.request.get(`/api/households/${h.id}/reports?type=${type}&month=${month}`).set("cookie", cookie);
}

describe("GET /reports", () => {
  it("bills: includes occurrences due in the month at any status, with correct totals, excluding other months", async () => {
    const owner = await signupUser(ctx);
    const h = await createHousehold(ctx, owner.cookie);
    const { occurrence: pending } = await createBill(h, owner.cookie, "2026-09-15");
    const { occurrence: paid } = await createBill(h, owner.cookie, "2026-09-20");
    await ctx.db.update(billOccurrences).set({ status: "PAID", amountPaidPaise: 50000 }).where(eq(billOccurrences.id, paid.id));
    await createBill(h, owner.cookie, "2026-10-01"); // different month — excluded

    const res = await report(h, owner.cookie, "bills", "2026-09");
    expect(res.status).toBe(200);
    const ids = res.body.data.rows.map((r: { occurrenceId: string }) => r.occurrenceId);
    expect(ids).toContain(pending.id);
    expect(ids).toContain(paid.id);
    expect(ids).toHaveLength(2);
    expect(res.body.data.totalDuePaise).toBe(100000);
    expect(res.body.data.totalPaidPaise).toBe(50000);
  });

  it("salary: filters to the selected period month, with totals", async () => {
    const owner = await signupUser(ctx);
    const h = await createHousehold(ctx, owner.cookie);
    const help = await createHousehelp(h.id, "Sunita");
    const included = await createSettlement(h.id, help.id, "2026-09-01", "2026-09-05", { amountPaidPaise: 400000 });
    await createSettlement(h.id, help.id, "2026-10-01", "2026-10-05"); // different month — excluded

    const res = await report(h, owner.cookie, "salary", "2026-09");
    expect(res.status).toBe(200);
    expect(res.body.data.rows).toEqual([
      { settlementId: included.id, househelpId: help.id, househelpName: "Sunita", netPayablePaise: 1000000, amountPaidPaise: 400000, status: "PENDING" },
    ]);
    expect(res.body.data.totalNetPayablePaise).toBe(1000000);
    expect(res.body.data.totalPaidPaise).toBe(400000);
  });

  it("attendance: tallies status counts per househelp for the month, excluding other months", async () => {
    const owner = await signupUser(ctx);
    const h = await createHousehold(ctx, owner.cookie);
    const help = await createHousehelp(h.id, "Sunita");
    await ctx.db.insert(attendanceRecords).values([
      { householdId: h.id, househelpId: help.id, date: "2026-09-01", status: "PRESENT" },
      { householdId: h.id, househelpId: help.id, date: "2026-09-02", status: "PRESENT" },
      { householdId: h.id, househelpId: help.id, date: "2026-09-03", status: "ABSENT" },
      { householdId: h.id, househelpId: help.id, date: "2026-09-04", status: "LEAVE" },
      { householdId: h.id, househelpId: help.id, date: "2026-10-01", status: "PRESENT" },
    ]);

    const res = await report(h, owner.cookie, "attendance", "2026-09");
    expect(res.status).toBe(200);
    expect(res.body.data.rows).toEqual([
      { househelpId: help.id, name: "Sunita", present: 2, absent: 1, halfDay: 0, leave: 1, holiday: 0 },
    ]);
  });

  it("checklist: tallies due/completed/skipped/missed across the month, respecting frequency", async () => {
    const owner = await signupUser(ctx);
    const h = await createHousehold(ctx, owner.cookie);
    const [daily] = await ctx.db.insert(checklistTasks).values({ householdId: h.id, name: "Wash dishes", frequency: "DAILY" }).returning();
    const [weekly] = await ctx.db.insert(checklistTasks).values({ householdId: h.id, name: "Vacuum", frequency: "WEEKLY", weekdays: [1] }).returning();
    await ctx.db.insert(checklistCompletions).values({ householdId: h.id, taskId: daily!.id, date: "2026-09-01", status: "COMPLETED" });
    await ctx.db.insert(checklistCompletions).values({ householdId: h.id, taskId: daily!.id, date: "2026-09-02", status: "SKIPPED" });

    const res = await report(h, owner.cookie, "checklist", "2026-09");
    expect(res.status).toBe(200);
    const dailyRow = res.body.data.rows.find((r: { taskId: string }) => r.taskId === daily!.id);
    expect(dailyRow).toMatchObject({ dueCount: 30, completedCount: 1, skippedCount: 1, missedCount: 28 });
    const weeklyRow = res.body.data.rows.find((r: { taskId: string }) => r.taskId === weekly!.id);
    expect(weeklyRow.dueCount).toBeGreaterThan(0);
    expect(weeklyRow.dueCount).toBeLessThan(30);
    expect(weeklyRow.completedCount + weeklyRow.skippedCount + weeklyRow.missedCount).toBe(weeklyRow.dueCount);
  });

  it("403s without reports.view", async () => {
    const owner = await signupUser(ctx);
    const h = await createHousehold(ctx, owner.cookie);
    const member = await signupUser(ctx);
    await addMember(h.id, member.id);
    await ctx.db.update(households).set({ rolePermissionOverrides: { MEMBER: { revoke: ["reports.view"] } } }).where(eq(households.id, h.id));

    const res = await report(h, member.cookie, "bills", "2026-09");
    expect(res.status).toBe(403);
  });

  it("400s for an invalid report type", async () => {
    const owner = await signupUser(ctx);
    const h = await createHousehold(ctx, owner.cookie);
    const res = await report(h, owner.cookie, "nonsense", "2026-09");
    expect(res.status).toBe(400);
  });

  it("never reflects another household's data", async () => {
    const ownerA = await signupUser(ctx);
    const hA = await createHousehold(ctx, ownerA.cookie, "Household A");
    await createBill(hA, ownerA.cookie, "2026-09-10");

    const ownerB = await signupUser(ctx);
    const hB = await createHousehold(ctx, ownerB.cookie, "Household B");

    const res = await report(hB, ownerB.cookie, "bills", "2026-09");
    expect(res.body.data.rows).toEqual([]);
  });
});
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `npm run test --workspace @household/api -- report.test`
Expected: FAIL — `Cannot find module '../src/services/report.service.js'` (and/or 404s from the unregistered route).

- [ ] **Step 4: Add the bills report query**

In `apps/api/src/services/bill-occurrence.service.ts`, change the `@household/shared` import on line 3 to add `daysInMonth`:

```typescript
import { dateInZone, daysBetween, daysInMonth, occurrenceDueDate, parseDateParts } from "@household/shared";
```

Append this function after `listDueOccurrencesForHousehold` (after its closing `}`):

```typescript
export type MonthOccurrenceRow = {
  occurrenceId: string; billId: string; billName: string; dueDate: string;
  amountDuePaise: number; amountPaidPaise: number; status: OccurrenceStatus;
};

/**
 * Household-wide, cross-bill, cross-status view of occurrences due within a specific month — for
 * Phase 8's reports. Unlike `listDueOccurrencesForHousehold` (household-wide but still-open-only),
 * a spend report needs paid/waived occurrences too, scoped to one month rather than "everything
 * currently open."
 */
export async function listOccurrencesDueInMonth(deps: Deps, householdId: string, month: string): Promise<MonthOccurrenceRow[]> {
  const [y, m] = month.split("-").map(Number);
  const start = `${month}-01`;
  const end = `${month}-${String(daysInMonth(y!, m!)).padStart(2, "0")}`;
  const rows = await deps.db.select({
    occurrenceId: billOccurrences.id, billId: billOccurrences.billId, billName: bills.name,
    dueDate: billOccurrences.dueDate, amountDuePaise: billOccurrences.amountDuePaise,
    amountPaidPaise: billOccurrences.amountPaidPaise, status: billOccurrences.status,
  }).from(billOccurrences)
    .innerJoin(bills, and(eq(bills.householdId, billOccurrences.householdId), eq(bills.id, billOccurrences.billId)))
    .where(and(eq(billOccurrences.householdId, householdId), gte(billOccurrences.dueDate, start), lte(billOccurrences.dueDate, end)))
    .orderBy(asc(billOccurrences.dueDate));
  return rows;
}
```

- [ ] **Step 5: Implement report.service.ts**

Create `apps/api/src/services/report.service.ts`:

```typescript
import { and, eq, gte, isNull, lte } from "drizzle-orm";
import { daysInMonth, isTaskDueOn } from "@household/shared";
import type { ReportDTO, ReportType } from "@household/shared";
import { checklistCompletions, checklistTasks } from "../db/schema.js";
import { getMonthAttendance } from "./attendance.service.js";
import { listOccurrencesDueInMonth } from "./bill-occurrence.service.js";
import type { Deps } from "./deps.js";
import type { Membership } from "./household.service.js";
import { listHousehelps } from "./househelp.service.js";
import { listSettlementsForHousehold } from "./salary-settlement.service.js";

function monthDates(month: string): string[] {
  const [y, m] = month.split("-").map(Number);
  const total = daysInMonth(y!, m!);
  return Array.from({ length: total }, (_, i) => `${month}-${String(i + 1).padStart(2, "0")}`);
}

async function getBillsReport(deps: Deps, householdId: string, month: string): Promise<ReportDTO> {
  const rows = await listOccurrencesDueInMonth(deps, householdId, month);
  const totalDuePaise = rows.reduce((sum, r) => sum + r.amountDuePaise, 0);
  const totalPaidPaise = rows.reduce((sum, r) => sum + r.amountPaidPaise, 0);
  return { type: "bills", rows, totalDuePaise, totalPaidPaise };
}

async function getSalaryReport(deps: Deps, householdId: string, month: string): Promise<ReportDTO> {
  const periodMonth = `${month}-01`;
  const [settlements, helps] = await Promise.all([
    listSettlementsForHousehold(deps, householdId),
    listHousehelps(deps.db, householdId, false),
  ]);
  const nameById = new Map(helps.map((h) => [h.id, h.name]));
  const rows = settlements
    .filter((s) => s.periodMonth === periodMonth)
    .map((s) => ({
      settlementId: s.id, househelpId: s.househelpId, househelpName: nameById.get(s.househelpId) ?? "",
      netPayablePaise: s.netPayablePaise, amountPaidPaise: s.amountPaidPaise, status: s.status,
    }));
  const totalNetPayablePaise = rows.reduce((sum, r) => sum + r.netPayablePaise, 0);
  const totalPaidPaise = rows.reduce((sum, r) => sum + r.amountPaidPaise, 0);
  return { type: "salary", rows, totalNetPayablePaise, totalPaidPaise };
}

async function getAttendanceReport(deps: Deps, householdId: string, month: string): Promise<ReportDTO> {
  const helps = await listHousehelps(deps.db, householdId, false);
  const rows = await Promise.all(helps.map(async (h) => {
    const records = await getMonthAttendance(deps.db, householdId, h.id, month);
    const counts = { present: 0, absent: 0, halfDay: 0, leave: 0, holiday: 0 };
    for (const r of records) {
      if (r.status === "PRESENT") counts.present += 1;
      else if (r.status === "ABSENT") counts.absent += 1;
      else if (r.status === "HALF_DAY") counts.halfDay += 1;
      else if (r.status === "LEAVE") counts.leave += 1;
      else if (r.status === "HOLIDAY") counts.holiday += 1;
    }
    return { househelpId: h.id, name: h.name, ...counts };
  }));
  return { type: "attendance", rows };
}

async function getChecklistReport(deps: Deps, householdId: string, month: string): Promise<ReportDTO> {
  const dates = monthDates(month);
  const tasks = await deps.db.select({
    id: checklistTasks.id, name: checklistTasks.name, frequency: checklistTasks.frequency,
    weekdays: checklistTasks.weekdays, dayOfMonth: checklistTasks.dayOfMonth,
    specificDate: checklistTasks.specificDate, intervalDays: checklistTasks.intervalDays, anchorDate: checklistTasks.anchorDate,
  }).from(checklistTasks)
    .where(and(eq(checklistTasks.householdId, householdId), eq(checklistTasks.isActive, true), isNull(checklistTasks.archivedAt)));

  if (tasks.length === 0) return { type: "checklist", rows: [] };

  const completions = await deps.db.select({ taskId: checklistCompletions.taskId, date: checklistCompletions.date, status: checklistCompletions.status })
    .from(checklistCompletions)
    .where(and(eq(checklistCompletions.householdId, householdId), gte(checklistCompletions.date, dates[0]!), lte(checklistCompletions.date, dates[dates.length - 1]!)));
  const completionByKey = new Map(completions.map((c) => [`${c.taskId}:${c.date}`, c.status]));

  const rows = tasks.map((task) => {
    let dueCount = 0, completedCount = 0, skippedCount = 0, missedCount = 0;
    for (const date of dates) {
      if (!isTaskDueOn(task, date)) continue;
      dueCount += 1;
      const status = completionByKey.get(`${task.id}:${date}`);
      if (status === "COMPLETED") completedCount += 1;
      else if (status === "SKIPPED") skippedCount += 1;
      else missedCount += 1;
    }
    return { taskId: task.id, name: task.name, dueCount, completedCount, skippedCount, missedCount };
  });
  return { type: "checklist", rows };
}

export async function getReport(deps: Deps, membership: Membership, type: ReportType, month: string): Promise<ReportDTO> {
  if (type === "bills") return getBillsReport(deps, membership.householdId, month);
  if (type === "salary") return getSalaryReport(deps, membership.householdId, month);
  if (type === "attendance") return getAttendanceReport(deps, membership.householdId, month);
  return getChecklistReport(deps, membership.householdId, month);
}
```

- [ ] **Step 6: Wire the route**

In `apps/api/src/routes/household.routes.ts`, add `reportTypeSchema` to the existing destructured import from `"@household/shared"` (insert alphabetically, e.g. right after `recordPaymentSchema`), and add a new service import after the `search.service.js` import:

```typescript
import * as reportService from "../services/report.service.js";
```

Append this route before the final `return r;` (after the `GET /:householdId/search` block):

```typescript
  r.get("/:householdId/reports", requireHousehold(deps, "reports.view"), async (req, res) => {
    const typeParsed = reportTypeSchema.safeParse(req.query.type);
    if (!typeParsed.success) throw Errors.validation({ type: "Use bills, salary, attendance, or checklist." });
    const monthParsed = monthSchema.safeParse(req.query.month);
    if (!monthParsed.success) throw Errors.validation({ month: "Use YYYY-MM." });
    ok(res, await reportService.getReport(deps, req.membership!, typeParsed.data, monthParsed.data));
  });
```

(`monthSchema` is already imported in this file — no change needed for it.)

- [ ] **Step 7: Run the tests to verify they pass**

Run: `npm run test --workspace @household/api -- report.test`
Expected: PASS

- [ ] **Step 8: Typecheck and build**

Run: `npm run build --workspace @household/shared && npm run typecheck --workspace @household/api && npm run build --workspace @household/api`
Expected: PASS (the 2 pre-existing, unrelated `TS18048` failures in `tests/bill-category.test.ts`/`tests/bill.test.ts` are not part of this change).

- [ ] **Step 9: Commit**

```bash
git add packages/shared/src/dto.ts packages/shared/src/schemas.ts apps/api/src/services/bill-occurrence.service.ts apps/api/src/services/report.service.ts apps/api/src/routes/household.routes.ts apps/api/tests/report.test.ts
git commit -m "feat(api): reports endpoint (bills, salary, attendance, checklist)"
```

---

### Task 2: Web — Reports page, CSV export, entry point

**Files:**
- Create: `apps/web/src/features/reports/useReports.ts`
- Create: `apps/web/src/features/reports/csv.ts`
- Create: `apps/web/src/features/reports/csv.test.ts`
- Create: `apps/web/src/features/reports/ReportsPage.tsx`
- Create: `apps/web/src/features/reports/ReportsPage.test.tsx`
- Modify: `apps/web/src/App.tsx`
- Modify: `apps/web/src/features/app/MorePage.tsx`

**Interfaces:**
- Consumes: `ReportDTO`, `ReportType` (Task 1, `@household/shared`), `GET /households/:householdId/reports?type=...&month=...` (Task 1).
- Produces: `useReport(householdId, type, month): UseQueryResult<ReportDTO>`, `reportToCSV(report: ReportDTO): string`.

- [ ] **Step 1: Write the CSV function and its tests**

Create `apps/web/src/features/reports/csv.ts`:

```typescript
import type { ReportDTO } from "@household/shared";

function escapeCsvCell(value: string | number): string {
  const str = String(value);
  return /[",\n]/.test(str) ? `"${str.replace(/"/g, '""')}"` : str;
}

function toCSVLines(headers: string[], rows: (string | number)[][]): string {
  return [headers, ...rows].map((row) => row.map(escapeCsvCell).join(",")).join("\n");
}

export function reportToCSV(report: ReportDTO): string {
  if (report.type === "bills") {
    return toCSVLines(
      ["Bill", "Due date", "Status", "Amount due (paise)", "Amount paid (paise)"],
      report.rows.map((r) => [r.billName, r.dueDate, r.status, r.amountDuePaise, r.amountPaidPaise]),
    );
  }
  if (report.type === "salary") {
    return toCSVLines(
      ["Househelp", "Status", "Net payable (paise)", "Amount paid (paise)"],
      report.rows.map((r) => [r.househelpName, r.status, r.netPayablePaise, r.amountPaidPaise]),
    );
  }
  if (report.type === "attendance") {
    return toCSVLines(
      ["Househelp", "Present", "Absent", "Half day", "Leave", "Holiday"],
      report.rows.map((r) => [r.name, r.present, r.absent, r.halfDay, r.leave, r.holiday]),
    );
  }
  return toCSVLines(
    ["Task", "Due", "Completed", "Skipped", "Missed"],
    report.rows.map((r) => [r.name, r.dueCount, r.completedCount, r.skippedCount, r.missedCount]),
  );
}
```

Create `apps/web/src/features/reports/csv.test.ts`:

```typescript
import { describe, expect, it } from "vitest";
import { reportToCSV } from "./csv";

describe("reportToCSV", () => {
  it("formats a bills report as CSV", () => {
    const csv = reportToCSV({
      type: "bills",
      rows: [{ occurrenceId: "o1", billId: "b1", billName: "Electricity", dueDate: "2026-09-15", amountDuePaise: 50000, amountPaidPaise: 0, status: "PENDING" }],
      totalDuePaise: 50000, totalPaidPaise: 0,
    });
    expect(csv).toBe("Bill,Due date,Status,Amount due (paise),Amount paid (paise)\nElectricity,2026-09-15,PENDING,50000,0");
  });

  it("escapes commas and quotes in cell values", () => {
    const csv = reportToCSV({
      type: "bills",
      rows: [{ occurrenceId: "o1", billId: "b1", billName: 'Electricity, "City"', dueDate: "2026-09-15", amountDuePaise: 50000, amountPaidPaise: 0, status: "PENDING" }],
      totalDuePaise: 50000, totalPaidPaise: 0,
    });
    expect(csv).toContain('"Electricity, ""City"""');
  });

  it("formats a checklist report as CSV", () => {
    const csv = reportToCSV({
      type: "checklist",
      rows: [{ taskId: "t1", name: "Wash dishes", dueCount: 30, completedCount: 20, skippedCount: 5, missedCount: 5 }],
    });
    expect(csv).toBe("Task,Due,Completed,Skipped,Missed\nWash dishes,30,20,5,5");
  });
});
```

Run: `npm run test --workspace @household/web -- csv.test`
Expected: PASS (these are pure-function tests, no page or fetch mocking needed — write and run together, no separate red-green step required for this file since there's nothing to wire yet).

- [ ] **Step 2: Write the data hook**

Create `apps/web/src/features/reports/useReports.ts`:

```typescript
import { useQuery } from "@tanstack/react-query";
import type { ReportDTO, ReportType } from "@household/shared";
import { get } from "../../lib/api";

export function useReport(householdId: string | undefined, type: ReportType, month: string) {
  return useQuery({
    queryKey: ["report", householdId, type, month],
    queryFn: ({ signal }) => get<ReportDTO>(`/households/${householdId}/reports?type=${type}&month=${month}`, signal).then((r) => r.data),
    enabled: !!householdId,
  });
}
```

- [ ] **Step 3: Write the failing test file**

Create `apps/web/src/features/reports/ReportsPage.test.tsx`:

```typescript
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { meKey } from "../auth/session";
import { ReportsPage } from "./ReportsPage";

const HOUSEHOLD = { id: "h1", name: "Shah Family", timezone: "Asia/Kolkata", role: "OWNER" as const, memberCount: 2 };

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function renderPage() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  qc.setQueryData(meKey, { user: { id: "u1", name: "Parakh", email: "p@example.com", emailVerified: true, createdAt: "2026-01-01T00:00:00.000Z" }, households: [HOUSEHOLD] });
  vi.spyOn(globalThis, "fetch").mockImplementation((async (input: RequestInfo | URL) => {
    const url = new URL(String(input), "http://localhost");
    const type = url.searchParams.get("type");
    if (url.pathname === "/api/households/h1/reports" && type === "bills") {
      return jsonResponse({ success: true, data: {
        type: "bills", rows: [{ occurrenceId: "o1", billId: "b1", billName: "Electricity", dueDate: "2026-09-15", amountDuePaise: 50000, amountPaidPaise: 0, status: "PENDING" }],
        totalDuePaise: 50000, totalPaidPaise: 0,
      } }, 200);
    }
    if (url.pathname === "/api/households/h1/reports" && type === "salary") {
      return jsonResponse({ success: true, data: {
        type: "salary", rows: [{ settlementId: "s1", househelpId: "hh1", househelpName: "Sunita", netPayablePaise: 1000000, amountPaidPaise: 0, status: "PENDING" }],
        totalNetPayablePaise: 1000000, totalPaidPaise: 0,
      } }, 200);
    }
    throw new Error(`unexpected fetch ${url}`);
  }) as typeof fetch);
  return render(<QueryClientProvider client={qc}><MemoryRouter><ReportsPage /></MemoryRouter></QueryClientProvider>);
}

describe("ReportsPage", () => {
  beforeEach(() => { vi.restoreAllMocks(); });
  afterEach(() => { vi.restoreAllMocks(); });

  it("renders the bills report by default", async () => {
    renderPage();
    await screen.findByText("Electricity");
  });

  it("switches to the salary report when selected", async () => {
    renderPage();
    await screen.findByText("Electricity");
    await userEvent.click(screen.getByRole("button", { name: "Salary" }));
    await screen.findByText("Sunita");
  });
});
```

- [ ] **Step 4: Run the tests to verify they fail**

Run: `npm run test --workspace @household/web -- ReportsPage`
Expected: FAIL — `Cannot find module './ReportsPage'`.

- [ ] **Step 5: Implement ReportsPage.tsx**

Create `apps/web/src/features/reports/ReportsPage.tsx`:

```tsx
import { useState } from "react";
import { formatINR } from "@household/shared";
import type { ReportType } from "@household/shared";
import { Button } from "../../components/Button";
import { useActiveHousehold } from "../app/useActiveHousehold";
import { reportToCSV } from "./csv";
import { useReport } from "./useReports";

const TYPES: { value: ReportType; label: string }[] = [
  { value: "bills", label: "Bills" },
  { value: "salary", label: "Salary" },
  { value: "attendance", label: "Attendance" },
  { value: "checklist", label: "Checklist" },
];

function currentMonth(): string {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
}

export function ReportsPage() {
  const { household } = useActiveHousehold();
  const [type, setType] = useState<ReportType>("bills");
  const [month, setMonth] = useState(currentMonth());
  const report = useReport(household?.id, type, month).data;

  function onDownload() {
    if (!report) return;
    const csv = reportToCSV(report);
    const blob = new Blob([csv], { type: "text/csv" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${type}-${month}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }

  return (
    <>
      <header className="page-head"><h1 className="page-title">Reports</h1></header>
      <div className="chips" role="group" aria-label="Report type">
        {TYPES.map((t) => (
          <button key={t.value} type="button" className="chip" aria-pressed={type === t.value} onClick={() => setType(t.value)}>{t.label}</button>
        ))}
      </div>
      <input
        type="month" value={month} onChange={(e) => setMonth(e.target.value)} aria-label="Month"
        style={{ margin: "var(--space-4) 0", height: "var(--touch)", padding: "0 var(--space-3)", borderRadius: "var(--radius-sm)", border: "1.5px solid var(--line-strong)" }}
      />
      {report && (
        <>
          <div style={{ marginBottom: "var(--space-4)" }}>
            <Button variant="secondary" onClick={onDownload}>Download CSV</Button>
          </div>
          {report.type === "bills" && (
            <div className="list">
              {report.rows.map((r) => (
                <div key={r.occurrenceId} className="list__item">
                  <span className="list__text"><span className="list__label" style={{ display: "block" }}>{r.billName}</span><span className="list__meta">{r.dueDate} · {r.status}</span></span>
                  <span className="list__meta">{formatINR(r.amountDuePaise)} / {formatINR(r.amountPaidPaise)}</span>
                </div>
              ))}
            </div>
          )}
          {report.type === "salary" && (
            <div className="list">
              {report.rows.map((r) => (
                <div key={r.settlementId} className="list__item">
                  <span className="list__text"><span className="list__label" style={{ display: "block" }}>{r.househelpName}</span><span className="list__meta">{r.status}</span></span>
                  <span className="list__meta">{formatINR(r.netPayablePaise)} / {formatINR(r.amountPaidPaise)}</span>
                </div>
              ))}
            </div>
          )}
          {report.type === "attendance" && (
            <div className="list">
              {report.rows.map((r) => (
                <div key={r.househelpId} className="list__item">
                  <span className="list__label">{r.name}</span>
                  <span className="list__meta">P{r.present} A{r.absent} H{r.halfDay} L{r.leave} Ho{r.holiday}</span>
                </div>
              ))}
            </div>
          )}
          {report.type === "checklist" && (
            <div className="list">
              {report.rows.map((r) => (
                <div key={r.taskId} className="list__item">
                  <span className="list__label">{r.name}</span>
                  <span className="list__meta">{r.completedCount}/{r.dueCount} done, {r.skippedCount} skipped, {r.missedCount} missed</span>
                </div>
              ))}
            </div>
          )}
        </>
      )}
    </>
  );
}
```

- [ ] **Step 6: Wire the route**

In `apps/web/src/App.tsx`, add the import after `import { SearchPage } from "./features/search/SearchPage";`:

```typescript
import { ReportsPage } from "./features/reports/ReportsPage";
```

Add the route after `<Route path="search" element={<SearchPage />} />`:

```tsx
        <Route path="search" element={<SearchPage />} />
        <Route path="reports" element={<ReportsPage />} />
```

- [ ] **Step 7: Add the entry point in MorePage**

In `apps/web/src/features/app/MorePage.tsx`, change the "Household" section's `<div className="list">` to add a Reports row after "Notification settings":

```tsx
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
        <Link to="/reports" className="list__item">
          <span className="list__label">Reports</span>
        </Link>
      </div>
```

- [ ] **Step 8: Run the tests to verify they pass**

Run: `npm run test --workspace @household/web -- ReportsPage csv.test`
Expected: PASS

- [ ] **Step 9: Run the full web suite as a regression check**

Run: `npm run test --workspace @household/web`
Expected: PASS.

- [ ] **Step 10: Typecheck**

Run: `npm run typecheck --workspace @household/web`
Expected: PASS.

- [ ] **Step 11: Commit**

```bash
git add apps/web/src/features/reports apps/web/src/App.tsx apps/web/src/features/app/MorePage.tsx
git commit -m "feat(web): reports page with CSV export"
```

---

## Self-Review Notes

- **Spec coverage:** bills (any status, due-in-month, totals) ✓, salary (periodMonth filter, totals) ✓, attendance (per-status tallies via existing `getMonthAttendance` looped) ✓, checklist (novel day-by-day aggregation via `isTaskDueOn`, including a non-daily frequency case) ✓, `reports.view`-only gating with 403 ✓, invalid `type` → 400 ✓, cross-household isolation ✓ (all Task 1, tested); type selector + month picker (defaults to current month) + per-type table + CSV download via pure client-side function ✓, CSV correctness including escaping tested as a pure function ✓, More-page entry point ✓ (all Task 2).
- **Type consistency:** `ReportDTO`'s discriminated union (Task 1) is consumed identically in `csv.ts` and `ReportsPage.tsx` (Task 2) via `report.type === "..."` narrowing — field names match exactly between the DTO definitions and both consumers.
- **No placeholders:** every step has runnable code.
