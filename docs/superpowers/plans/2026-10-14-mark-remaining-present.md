# Mark Remaining as Present Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a "Mark remaining as present" bulk action to the per-househelp attendance calendar.

**Architecture:** A new backend service function mirrors the existing `markHoliday` bulk-write pattern (one transaction, one summary audit entry) to insert PRESENT rows for every scheduled, unmarked, already-occurred day in a given month. A new frontend button on `HousehelpCalendarPage` calls it after a confirm dialog.

**Tech Stack:** Express 5 + Drizzle (API), React 19 + TanStack Query (web) — no new dependencies.

## Global Constraints

- Only touches days with no existing attendance record of any status (never overwrites, including HOLIDAY).
- Only scheduled weekdays per the househelp's **current** schedule (`getCurrentSchedule` — not historical per-date versions, matching the page's own existing simplification).
- Only days ≤ today in the household's timezone.
- Route requires `attendance.mark`; the service additionally requires `attendance.editHistory` if any eligible date isn't today (same two-tier rule `assertWritable` already enforces elsewhere in this file).
- One summary audit entry (`attendance.remainingMarkedPresent`) when any eligible date isn't today; no audit entry and no-op when there's nothing to mark.
- Confirm dialog before committing: `window.confirm("Mark N remaining day(s) as present?")`.

---

### Task 1: Backend — service, route, tests

**Files:**
- Modify: `packages/shared/src/dto.ts` (add `MarkRemainingPresentResultDTO` after `MarkHolidayResultDTO` at line 63)
- Modify: `packages/shared/src/schemas.ts` (add `markRemainingPresentSchema` after `markHolidaySchema` at line 126)
- Modify: `apps/api/src/services/attendance.service.ts` (add `markRemainingPresent`, import `getCurrentSchedule`)
- Modify: `apps/api/src/routes/household.routes.ts` (add route after line 367, add `markRemainingPresentSchema` to the shared-schema import on line 3)
- Test: `apps/api/tests/attendance.test.ts`

**Interfaces:**
- Produces: `markRemainingPresent(deps: Deps, actorUserId: string, membership: AuthedMembership, househelpId: string, month: string, ip?: string): Promise<MarkRemainingPresentResultDTO>` in `attendance.service.ts`.
- Produces: `MarkRemainingPresentResultDTO = { month: string; count: number }` in `@household/shared`.
- Produces: route `POST /households/:householdId/househelps/:id/attendance/remaining-present`, body `{ month: string }`.
- Consumes: `getCurrentSchedule(deps, membership, househelpId): Promise<ScheduleDTO | null>` (existing, `schedule.service.ts`). `getMonthAttendance(db, householdId, househelpId, month): Promise<AttendanceRecordDTO[]>` (existing, same file, line 161). `isoWeekdayOf(date: string): number` (existing, same file, line 18). `recordAudit` (existing, `audit.service.ts`).

- [ ] **Step 1: Write the failing tests**

Append to `apps/api/tests/attendance.test.ts`, inside a new `describe` block (place it after the existing `describe("attendance — monthly calendar", ...)` block, before the file's closing):

```typescript
describe("attendance — mark remaining as present", () => {
  it("marks every unmarked scheduled day up to today as PRESENT, skipping already-marked and off-schedule days", async () => {
    const owner = await signupUser(ctx);
    const h = await createHousehold(ctx, owner.cookie);
    const help = await createHousehelp(ctx, owner.cookie, h.id);
    await ctx.request.put(`/api/households/${h.id}/househelps/${help.id}/schedule`).set(csrf).set("cookie", owner.cookie).send({ weekdays: [1, 2, 3, 4, 5] });
    // 2026-09-15 (Tue) already PRESENT, 2026-09-16 (Wed) already HOLIDAY — both scheduled weekdays.
    await ctx.request.put(`/api/households/${h.id}/attendance/${help.id}`).set(csrf).set("cookie", owner.cookie).send({ date: "2026-09-15", status: "PRESENT" });
    await ctx.request.post(`/api/households/${h.id}/attendance/holiday`).set(csrf).set("cookie", owner.cookie).send({ date: "2026-09-16" });

    const res = await ctx.request.post(`/api/households/${h.id}/househelps/${help.id}/attendance/remaining-present`).set(csrf).set("cookie", owner.cookie).send({ month: "2026-09" });
    expect(res.status).toBe(200);
    // 21 scheduled Mon-Fri weekdays occur in September 2026 by the pinned "today" (the 29th);
    // 2 of those are already recorded (15th, 16th), leaving 19 to mark.
    expect(res.body.data).toEqual({ month: "2026-09", count: 19 });

    const rows = await ctx.db.select().from(attendanceRecords).where(eq(attendanceRecords.househelpId, help.id));
    expect(rows).toHaveLength(21);
    const sep15 = rows.find((r) => r.date === "2026-09-15");
    expect(sep15?.status).toBe("PRESENT");
    const sep16 = rows.find((r) => r.date === "2026-09-16");
    expect(sep16?.status).toBe("HOLIDAY");
    const sep1 = rows.find((r) => r.date === "2026-09-01");
    expect(sep1?.status).toBe("PRESENT");
  });

  it("records one summary audit entry for the bulk action", async () => {
    const owner = await signupUser(ctx);
    const h = await createHousehold(ctx, owner.cookie);
    const help = await createHousehelp(ctx, owner.cookie, h.id);
    await ctx.request.put(`/api/households/${h.id}/househelps/${help.id}/schedule`).set(csrf).set("cookie", owner.cookie).send({ weekdays: [1, 2, 3, 4, 5] });
    await ctx.request.post(`/api/households/${h.id}/househelps/${help.id}/attendance/remaining-present`).set(csrf).set("cookie", owner.cookie).send({ month: "2026-09" });
    const logs = await ctx.db.select().from(auditLogs).where(and(eq(auditLogs.householdId, h.id), eq(auditLogs.action, "attendance.remainingMarkedPresent")));
    expect(logs).toHaveLength(1);
    expect(logs[0]?.newValue).toEqual({ month: "2026-09", count: 21 });
  });

  it("is a no-op with count 0 and no audit entry when there's nothing to mark (no schedule set)", async () => {
    const owner = await signupUser(ctx);
    const h = await createHousehold(ctx, owner.cookie);
    const help = await createHousehelp(ctx, owner.cookie, h.id);
    const res = await ctx.request.post(`/api/households/${h.id}/househelps/${help.id}/attendance/remaining-present`).set(csrf).set("cookie", owner.cookie).send({ month: "2026-09" });
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({ month: "2026-09", count: 0 });
    const logs = await ctx.db.select().from(auditLogs).where(and(eq(auditLogs.householdId, h.id), eq(auditLogs.action, "attendance.remainingMarkedPresent")));
    expect(logs).toHaveLength(0);
  });

  it("403s without attendance.mark", async () => {
    const owner = await signupUser(ctx);
    const h = await createHousehold(ctx, owner.cookie);
    const help = await createHousehelp(ctx, owner.cookie, h.id);
    const viewer = await signupUser(ctx);
    await addMember(h.id, viewer.id, "VIEWER");
    const res = await ctx.request.post(`/api/households/${h.id}/househelps/${help.id}/attendance/remaining-present`).set(csrf).set("cookie", viewer.cookie).send({ month: "2026-09" });
    expect(res.status).toBe(403);
  });

  it("403s without attendance.editHistory when at least one eligible date is in the past", async () => {
    const owner = await signupUser(ctx);
    const h = await createHousehold(ctx, owner.cookie);
    const help = await createHousehelp(ctx, owner.cookie, h.id);
    await ctx.request.put(`/api/households/${h.id}/househelps/${help.id}/schedule`).set(csrf).set("cookie", owner.cookie).send({ weekdays: [1, 2, 3, 4, 5] });
    const member = await signupUser(ctx);
    await addMember(h.id, member.id, "MEMBER");
    const res = await ctx.request.post(`/api/households/${h.id}/househelps/${help.id}/attendance/remaining-present`).set(csrf).set("cookie", member.cookie).send({ month: "2026-09" });
    expect(res.status).toBe(403);
  });

  it("never marks another household's attendance", async () => {
    const ownerA = await signupUser(ctx);
    const a = await createHousehold(ctx, ownerA.cookie, "Household A");
    const helpA = await createHousehelp(ctx, ownerA.cookie, a.id);
    const ownerB = await signupUser(ctx);
    const b = await createHousehold(ctx, ownerB.cookie, "Household B");
    const res = await ctx.request.post(`/api/households/${b.id}/househelps/${helpA.id}/attendance/remaining-present`).set(csrf).set("cookie", ownerB.cookie).send({ month: "2026-09" });
    expect(res.status).toBe(404);
  });
});
```

`signupUser` returns `{ cookie, id, ... }` (confirmed from `apps/api/tests/helpers.ts:61-67`) — `addMember` above uses `.id`, matching every other test in this file.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd apps/api && npm run test -- attendance`
Expected: FAIL — `markRemainingPresentSchema`/route not found, or 404s where 200s are expected.

- [ ] **Step 3: Add the DTO and schema**

In `packages/shared/src/dto.ts`, immediately after line 63 (`export type MarkHolidayResultDTO = { date: string; count: number };`):

```typescript
export type MarkRemainingPresentResultDTO = { month: string; count: number };
```

In `packages/shared/src/schemas.ts`, immediately after line 126 (`export const markHolidaySchema = z.object({ date: dateSchema });`):

```typescript
export const markRemainingPresentSchema = z.object({ month: monthSchema });
export type MarkRemainingPresentInput = z.infer<typeof markRemainingPresentSchema>;
```

Run: `cd packages/shared && npm run build` (the API and web apps import compiled output, not source, for these two files — see the project's "stale dist" gotcha).

- [ ] **Step 4: Implement the service function**

In `apps/api/src/services/attendance.service.ts`, add this import alongside the existing ones at the top of the file:

```typescript
import { getCurrentSchedule } from "./schedule.service.js";
```

Also change the `@household/shared` type import on line 2 to add `MarkRemainingPresentResultDTO`:

```typescript
import type { AttendanceRecordDTO, AttendanceStatus, MarkAttendanceInput, MarkHolidayResultDTO, MarkRemainingPresentResultDTO, Permission, TodayAttendanceDTO } from "@household/shared";
```

Append this function after `markHoliday` (after line 154, before `nextMonth`):

```typescript
export async function markRemainingPresent(
  deps: Deps, actorUserId: string, membership: AuthedMembership, househelpId: string, month: string, ip?: string,
): Promise<MarkRemainingPresentResultDTO> {
  await requireHousehelpInHousehold(deps.db, membership.householdId, househelpId);
  const today = dateInZone(deps.clock.now(), membership.timezone);
  const schedule = await getCurrentSchedule(deps, membership, househelpId);
  const scheduledWeekdays = new Set(schedule?.weekdays ?? []);
  const existing = await getMonthAttendance(deps.db, membership.householdId, househelpId, month);
  const alreadyRecorded = new Set(existing.map((r) => r.date));

  const todayMonth = today.slice(0, 7);
  const [y, m] = month.split("-").map(Number);
  const daysInMonth = new Date(Date.UTC(y!, m!, 0)).getUTCDate();
  const lastDay = month < todayMonth ? daysInMonth : month > todayMonth ? 0 : Number(today.slice(8, 10));

  const dates: string[] = [];
  for (let day = 1; day <= lastDay; day++) {
    const d = `${month}-${String(day).padStart(2, "0")}`;
    if (!scheduledWeekdays.has(isoWeekdayOf(d))) continue;
    if (alreadyRecorded.has(d)) continue;
    dates.push(d);
  }
  if (dates.length === 0) return { month, count: 0 };

  const requiresHistory = dates.some((d) => d !== today);
  if (requiresHistory && !membership.permissions.has("attendance.editHistory")) throw Errors.forbidden();

  const now = deps.clock.now();
  await deps.db.transaction(async (tx) => {
    await tx.insert(attendanceRecords).values(dates.map((d) => ({
      householdId: membership.householdId, househelpId, date: d, status: "PRESENT" as const, note: null,
      markedByUserId: actorUserId, markedAt: now,
    })));
    if (requiresHistory) {
      await recordAudit(tx, {
        householdId: membership.householdId, actorUserId, action: "attendance.remainingMarkedPresent", entityType: "attendance_record",
        newValue: { month, count: dates.length }, ipAddress: ip ?? null,
      });
    }
  });
  return { month, count: dates.length };
}
```

`getMonthAttendance` is defined later in this same file (line 161) — function declarations in a module are usable before their textual position is irrelevant here since both are top-level `export async function` statements in the same module scope, so this is fine without reordering.

- [ ] **Step 5: Wire the route**

In `apps/api/src/routes/household.routes.ts`, add `markRemainingPresentSchema` to the big destructured import on line 3, alphabetically between `markHolidaySchema` and `monthSchema`:

```typescript
..., markHolidaySchema, markRemainingPresentSchema, monthSchema, ...
```

Add this route immediately after the existing `GET /:householdId/househelps/:id/attendance` route (after line 367, before the blank line that precedes the checklist routes):

```typescript
  r.post("/:householdId/househelps/:id/attendance/remaining-present", requireHousehold(deps, "attendance.mark"), async (req, res) => {
    const { month } = parseBody(req, markRemainingPresentSchema);
    ok(res, await attendance.markRemainingPresent(deps, req.auth!.user.id, req.membership!, req.params.id as string, month, req.ip), 200, "Marked remaining days as present.");
  });
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `cd apps/api && npm run test -- attendance`
Expected: PASS (all tests in the file, including the 6 new ones)

- [ ] **Step 7: Typecheck and build**

Run: `cd apps/api && npm run typecheck`
Expected: PASS

Run: `cd apps/api && npm run build`
Expected: PASS

- [ ] **Step 8: Commit**

```bash
git add packages/shared/src/dto.ts packages/shared/src/schemas.ts apps/api/src/services/attendance.service.ts apps/api/src/routes/household.routes.ts apps/api/tests/attendance.test.ts
git commit -m "feat(api): mark-remaining-present bulk attendance action"
```

---

### Task 2: Frontend — hook, button, tests

**Files:**
- Modify: `apps/web/src/features/app/attendance/useAttendance.ts`
- Modify: `apps/web/src/features/app/attendance/HousehelpCalendarPage.tsx`
- Test: `apps/web/src/features/app/attendance/HousehelpCalendarPage.test.tsx`

**Interfaces:**
- Consumes: `POST /households/:householdId/househelps/:id/attendance/remaining-present` (Task 1), body `{ month: string }`, response `MarkRemainingPresentResultDTO`.
- Produces: `useMarkRemainingPresent(householdId: string)` — a mutation hook taking `{ househelpId: string; month: string }`.

- [ ] **Step 1: Write the failing tests**

In `apps/web/src/features/app/attendance/HousehelpCalendarPage.test.tsx`, add a branch to `renderPage`'s fetch mock, immediately before the final `throw new Error(...)` line:

```typescript
    if (init?.method === "POST" && url.includes("/attendance/remaining-present")) return jsonResponse({ success: true, data: { month: "2026-09", count: 20 }, message: null });
```

Add these two tests inside the `describe("HousehelpCalendarPage", ...)` block, after the existing `"shows the monthly summary..."` test:

```typescript
  it("confirms and posts to the bulk endpoint when 'Mark remaining as present' is clicked", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    vi.spyOn(window, "confirm").mockReturnValue(true);
    renderPage(["attendance.view", "attendance.mark", "attendance.editHistory"]);
    const button = await screen.findByRole("button", { name: "Mark 20 remaining as present" });
    await userEvent.click(button);
    expect(window.confirm).toHaveBeenCalledWith("Mark 20 remaining day(s) as present?");
    const postCall = fetchSpy.mock.calls.find(([u, init]) => String(u).includes("/attendance/remaining-present") && (init as RequestInit | undefined)?.method === "POST");
    expect(postCall).toBeDefined();
    expect(JSON.parse((postCall![1] as RequestInit).body as string)).toEqual({ month: "2026-09" });
  });

  it("hides the mark-remaining button without attendance.editHistory", async () => {
    renderPage(["attendance.view", "attendance.mark"]);
    await screen.findByText("Sunita's attendance");
    expect(screen.queryByRole("button", { name: /Mark \d+ remaining as present/ })).not.toBeInTheDocument();
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd apps/web && npm run test -- HousehelpCalendarPage`
Expected: FAIL — button not found (`TestingLibraryElementError`).

- [ ] **Step 3: Add the mutation hook**

In `apps/web/src/features/app/attendance/useAttendance.ts`, change the `@household/shared` type import (line 2) to add `MarkRemainingPresentResultDTO`:

```typescript
import type { AttendanceRecordDTO, MarkAttendanceInput, MarkHolidayResultDTO, MarkRemainingPresentResultDTO, TodayAttendanceDTO } from "@household/shared";
```

Append this hook after `useMarkHoliday` (after line 44, before `useMonthAttendance`):

```typescript
export function useMarkRemainingPresent(householdId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ househelpId, month }: { househelpId: string; month: string }) =>
      post<MarkRemainingPresentResultDTO>(`/households/${householdId}/househelps/${househelpId}/attendance/remaining-present`, { month }),
    onSuccess: (_data, { househelpId }) => invalidateAttendance(qc, householdId, househelpId),
  });
}
```

- [ ] **Step 4: Add the button to the page**

In `apps/web/src/features/app/attendance/HousehelpCalendarPage.tsx`, add `useMarkRemainingPresent` to the import on line 15:

```typescript
import { useClearAttendance, useMarkRemainingPresent, useMonthAttendance, useSetAttendance } from "./useAttendance";
```

Add this line after `const clearAttendance = useClearAttendance(householdId ?? "");` (line 57):

```typescript
  const markRemaining = useMarkRemainingPresent(householdId ?? "");
```

Add this function after `onPick` (after line 84, before the `return (`):

```typescript
  function onMarkRemaining() {
    if (!window.confirm(`Mark ${summary.notYetMarked} remaining day(s) as present?`)) return;
    markRemaining.mutate({ househelpId: id!, month }, { onError: (err) => setPageError(messageFrom(err)) });
  }
```

Add the button inside the month-nav `div` (lines 105-109), immediately after the closing `</Button>` of the "Next" button (after line 108, still inside that same `div`) — i.e. the div ends up with three children instead of two. Since a third item would break the `space-between` layout's visual balance, instead add it as its own row directly below that div, immediately before `<div className="cal__grid">` (before line 111):

```typescript
      {canMarkToday && canEditHistory && summary.notYetMarked > 0 && (
        <div style={{ marginBottom: "var(--space-4)" }}>
          <Button variant="secondary" loading={markRemaining.isPending} onClick={onMarkRemaining}>
            Mark {summary.notYetMarked} remaining as present
          </Button>
        </div>
      )}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `cd apps/web && npm run test -- HousehelpCalendarPage`
Expected: PASS (all tests in the file)

- [ ] **Step 6: Run the full web test suite as a regression check**

Run: `cd apps/web && npm run test`
Expected: PASS, no regressions

- [ ] **Step 7: Typecheck**

Run: `cd apps/web && npm run typecheck`
Expected: PASS

- [ ] **Step 8: Commit**

```bash
git add apps/web/src/features/app/attendance/useAttendance.ts apps/web/src/features/app/attendance/HousehelpCalendarPage.tsx apps/web/src/features/app/attendance/HousehelpCalendarPage.test.tsx
git commit -m "feat(web): mark-remaining-present button on the attendance calendar"
```

---

## Self-Review Notes

- **Spec coverage:** backend bulk-write + permission tiers + audit rule (Task 1), frontend button + confirm + invalidation (Task 2) — every spec section has a task.
- **Placeholder scan:** every step has concrete code; the one open item (`signupUser`'s exact return field name) is flagged with where to check, not left vague — low-risk since the file already imports and uses `signupUser` the same way in every other test.
- **Type consistency:** `MarkRemainingPresentResultDTO` is identical across `dto.ts`, the service return type, and the hook's generic — `{ month: string; count: number }` throughout. Route path (`/households/:householdId/househelps/:id/attendance/remaining-present`) matches between Task 1's route and Task 2's hook/test mocks.
