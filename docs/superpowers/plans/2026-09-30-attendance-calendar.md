# Attendance Marking and Calendar Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** One-tap daily attendance marking for househelps (Present/Absent cycle + a picker for Half-day/Leave/Holiday/Not-marked), a household-wide "mark today as holiday" bulk action, and a per-househelp monthly calendar for reviewing and correcting past days.

**Architecture:** One new API service file (`attendance.service.ts`), mirroring `schedule.service.ts`'s style (plain functions taking `Deps`/`Membership`/`DbOrTx`), with routes appended to the existing `household.routes.ts`. The web side gets one new feature folder (`features/app/attendance/`) with a hooks file, a small shared `AttendancePicker` component (reused by both new pages), a status-tone helper, and two pages (Today, per-househelp Calendar). No schema migration — `attendance_records` and `attendance_schedules` already exist from Phase 1.

**Tech Stack:** Express 5, Drizzle ORM, zod 4, Vitest + Supertest (API, real Postgres), React 19 + TanStack Query + React Router 7, Vitest + Testing Library (web).

## Global Constraints

- TypeScript strict mode, `noUncheckedIndexedAccess` — non-null assertions only where a prior check or `.returning()` guarantees the row exists.
- Business logic lives in `apps/api/src/services/*`; routes only parse input, call a service, and respond.
- Every household-scoped route goes through `requireHousehold(deps, permission)`; downstream code uses `req.membership.householdId`, never the raw URL param. Non-members get 404, not 403.
- **Permission rule specific to this feature:** every attendance write endpoint (`PUT`/`DELETE .../attendance/:househelpId`, `POST .../attendance/holiday`) is gated at the route level on `attendance.mark` (the minimum needed to reach the handler at all), then the service layer checks internally: if the target `date` equals the household's current date, `attendance.mark` is sufficient; any other date requires `attendance.editHistory` (checked against `req.membership.permissions`, a `Set<Permission>`). All three reject a `date` later than the household's current date.
- Every audit-logged mutation writes its `audit_logs` row inside the same transaction as the change, via `recordAudit(tx, entry)`. Per this feature's spec, only corrections (`date !== today`) are audited — routine same-day marks are not, to avoid flooding the log.
- Calendar dates are `"YYYY-MM-DD"` strings in the household's timezone (`packages/shared/src/time.ts`'s `dateInZone`) — never derived from server-local time. `attendance_records.date` is a Postgres `date` column and already round-trips as a plain string (see `apps/api/src/db/client.ts`'s `pg.types.setTypeParser(1082, ...)`) — never call `.toISOString()` on it.
- No new `ErrorCode` values — this feature only needs `VALIDATION_ERROR`, `NOT_FOUND`, `FORBIDDEN` (all already exist).
- No new permissions — `attendance.view`, `attendance.mark`, `attendance.editHistory` already exist in `packages/shared/src/permissions.ts` with their default role grants already correct (OWNER/ADMIN: all three; MEMBER: view+mark; VIEWER: view only).
- No new tables/migration — `attendance_records` (unique on `(househelp_id, date)`, no row = NOT_MARKED) and `attendance_schedules` (already built in Phase 2 Spec 2's `schedule.service.ts`) are both already in `apps/api/src/db/schema.ts`.
- API integration tests run against a real Postgres (`TEST_DATABASE_URL`), following the exact pattern in `apps/api/tests/househelps.test.ts` (same helpers: `createTestContext`, `signupUser`, `csrf`, `truncateAll`, `FakeClock` via `ctx.clock`).
- Web component tests follow `apps/web/src/features/app/househelps/HousehelpsListPage.test.tsx`'s pattern: mock `globalThis.fetch`, wrap in `QueryClientProvider` + `MemoryRouter`.
- Spec: `docs/superpowers/specs/2026-09-30-attendance-calendar-design.md`.

**Implementation-level clarification not fully spelled out in the spec:** the spec says the calendar's day-tap "opens the same status picker used on the Today screen." To make that literal reuse actually useful (a calendar correction is just as likely to be "should've been Absent" as "should've been Half-day"), the shared `AttendancePicker` component built in Task 4 offers all five statuses plus "Not marked", and is used identically by both the Today screen's secondary picker and every calendar-day tap. On the Today screen this is in addition to, not instead of, the fast Present/Absent tap-cycle.

---

### Task 1: Shared schemas and DTOs

**Files:**
- Modify: `packages/shared/src/schemas.ts`
- Modify: `packages/shared/src/dto.ts`

**Interfaces:**
- Produces: `attendanceStatusSchema`, `markAttendanceSchema`, `markHolidaySchema`, `monthSchema` (zod schemas) and `MarkAttendanceInput`, `MarkHolidayInput` (inferred types) from `schemas.ts`; `AttendanceStatus`, `AttendanceRecordDTO`, `TodayAttendanceEntryDTO`, `TodayAttendanceDTO`, `MarkHolidayResultDTO` (types) from `dto.ts`. All re-exported via the existing `packages/shared/src/index.ts` wildcard barrel — no change needed there.

- [ ] **Step 1: Add the schemas to `schemas.ts`**

Add at the end of `packages/shared/src/schemas.ts` (the file already has `dateSchema` defined near the top — reuse it, do not redefine):

```ts
export const attendanceStatusSchema = z.enum(["PRESENT", "ABSENT", "HALF_DAY", "LEAVE", "HOLIDAY"]);
export const monthSchema = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, "Use YYYY-MM");

export const markAttendanceSchema = z.object({
  date: dateSchema,
  status: attendanceStatusSchema,
  note: z.string().trim().max(500).optional(),
});
export const markHolidaySchema = z.object({ date: dateSchema });

export type MarkAttendanceInput = z.infer<typeof markAttendanceSchema>;
export type MarkHolidayInput = z.infer<typeof markHolidaySchema>;
```

- [ ] **Step 2: Add the DTOs to `dto.ts`**

Add at the end of `packages/shared/src/dto.ts`:

```ts
export type AttendanceStatus = "PRESENT" | "ABSENT" | "HALF_DAY" | "LEAVE" | "HOLIDAY";

export type AttendanceRecordDTO = { date: string; status: AttendanceStatus; note: string | null };

export type TodayAttendanceEntryDTO = {
  househelpId: string; name: string; roleTitle: string | null;
  scheduledToday: boolean; status: AttendanceStatus | null; note: string | null;
};

export type TodayAttendanceDTO = { date: string; entries: TodayAttendanceEntryDTO[] };

export type MarkHolidayResultDTO = { date: string; count: number };
```

- [ ] **Step 3: Build and typecheck the shared package**

Run: `npm run build -w @household/shared && npm run typecheck -w @household/shared`
Expected: both succeed with no errors (no dedicated test file for `schemas.ts`/`dto.ts` additions — matches the existing convention from Phase 2 Spec 2's Task 1; build + typecheck is the verification here).

- [ ] **Step 4: Commit**

```bash
git add packages/shared/src/schemas.ts packages/shared/src/dto.ts
git commit -m "feat(shared): add attendance schemas and DTOs"
```

---

### Task 2: API — one-tap marking (today, set, clear)

**Files:**
- Create: `apps/api/src/services/attendance.service.ts`
- Modify: `apps/api/src/routes/household.routes.ts`
- Create: `apps/api/tests/attendance.test.ts` (new file — this task writes the "today marking" describe block; Task 3 appends to the same file)

**Interfaces:**
- Consumes: `Deps`, `Membership` (`apps/api/src/services/household.service.ts`), `Permission` (`@household/shared`), `Errors`, `recordAudit`, `requireHousehold`, `parseBody`, `ok`, `dateInZone` (`@household/shared`), `AttendanceRecordDTO`/`AttendanceStatus`/`MarkAttendanceInput`/`TodayAttendanceDTO`/`markAttendanceSchema`/`dateSchema` (`@household/shared`), `attendanceRecords`/`attendanceSchedules`/`househelps` tables (`apps/api/src/db/schema.ts`).
- Produces: `getToday(deps, membership, dateParam?): Promise<TodayAttendanceDTO>`, `setAttendance(deps, actorUserId, membership, househelpId, input, ip?): Promise<AttendanceRecordDTO>`, `clearAttendance(deps, actorUserId, membership, househelpId, date, ip?): Promise<void>` — all from `attendance.service.ts`. Task 3 adds `markHoliday` and `getMonthAttendance` to this same file.

- [ ] **Step 1: Write the failing integration tests**

Create `apps/api/tests/attendance.test.ts`:

```ts
import { and, eq } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { attendanceRecords, auditLogs, householdMembers } from "../src/db/schema.js";
import { createTestContext, csrf, signupUser, truncateAll, type TestContext } from "./helpers.js";

const ctx = createTestContext();
beforeEach(() => truncateAll(ctx.db));
afterAll(() => ctx.close());

async function createHousehold(c: TestContext, cookie: string, name = "Shah Family") {
  const res = await c.request.post("/api/households").set(csrf).set("cookie", cookie).send({ name });
  expect(res.status).toBe(201);
  return res.body.data as { id: string };
}

async function addMember(householdId: string, userId: string, role: "OWNER" | "ADMIN" | "MEMBER" | "VIEWER") {
  await ctx.db.insert(householdMembers).values({ householdId, userId, role, status: "ACTIVE", joinedAt: ctx.clock.now() });
}

async function createHousehelp(c: TestContext, cookie: string, householdId: string, name = "Sunita") {
  const res = await c.request.post(`/api/households/${householdId}/househelps`).set(csrf).set("cookie", cookie).send({ name });
  expect(res.status).toBe(201);
  return res.body.data as { id: string };
}

describe("attendance — today marking", () => {
  it("lists an active househelp with no mark and scheduledToday false when no schedule is set", async () => {
    const owner = await signupUser(ctx);
    const h = await createHousehold(ctx, owner.cookie);
    await createHousehelp(ctx, owner.cookie, h.id);
    const res = await ctx.request.get(`/api/households/${h.id}/attendance/today`).set("cookie", owner.cookie);
    expect(res.status).toBe(200);
    expect(res.body.data.date).toBe("2026-09-29");
    expect(res.body.data.entries).toHaveLength(1);
    expect(res.body.data.entries[0]).toMatchObject({ name: "Sunita", scheduledToday: false, status: null, note: null });
  });

  it("marks scheduled-today househelps first", async () => {
    const owner = await signupUser(ctx);
    const h = await createHousehold(ctx, owner.cookie);
    const scheduled = await createHousehelp(ctx, owner.cookie, h.id, "Scheduled Today");
    const notScheduled = await createHousehelp(ctx, owner.cookie, h.id, "Not Scheduled");
    // 2026-09-29 is a Tuesday (isoWeekday 2).
    await ctx.request.put(`/api/households/${h.id}/househelps/${scheduled.id}/schedule`).set(csrf).set("cookie", owner.cookie).send({ weekdays: [2] });
    const res = await ctx.request.get(`/api/households/${h.id}/attendance/today`).set("cookie", owner.cookie);
    expect(res.body.data.entries.map((e: { name: string }) => e.name)).toEqual(["Scheduled Today", "Not Scheduled"]);
    expect(res.body.data.entries[0]).toMatchObject({ scheduledToday: true });
    expect(res.body.data.entries[1]).toMatchObject({ scheduledToday: false });
    void notScheduled;
  });

  it("excludes archived househelps from today's list", async () => {
    const owner = await signupUser(ctx);
    const h = await createHousehold(ctx, owner.cookie);
    const gone = await createHousehelp(ctx, owner.cookie, h.id, "Gone");
    await ctx.request.post(`/api/households/${h.id}/househelps/${gone.id}/archive`).set(csrf).set("cookie", owner.cookie);
    const res = await ctx.request.get(`/api/households/${h.id}/attendance/today`).set("cookie", owner.cookie);
    expect(res.body.data.entries).toHaveLength(0);
  });

  it("marks present, then flips to absent, upserting the same row", async () => {
    const owner = await signupUser(ctx);
    const h = await createHousehold(ctx, owner.cookie);
    const help = await createHousehelp(ctx, owner.cookie, h.id);
    const first = await ctx.request.put(`/api/households/${h.id}/attendance/${help.id}`).set(csrf).set("cookie", owner.cookie).send({ date: "2026-09-29", status: "PRESENT" });
    expect(first.status).toBe(200);
    expect(first.body.data).toMatchObject({ date: "2026-09-29", status: "PRESENT", note: null });
    const second = await ctx.request.put(`/api/households/${h.id}/attendance/${help.id}`).set(csrf).set("cookie", owner.cookie).send({ date: "2026-09-29", status: "ABSENT", note: "called in sick" });
    expect(second.status).toBe(200);
    expect(second.body.data).toMatchObject({ date: "2026-09-29", status: "ABSENT", note: "called in sick" });
    const rows = await ctx.db.select().from(attendanceRecords).where(eq(attendanceRecords.househelpId, help.id));
    expect(rows).toHaveLength(1);
  });

  it("rejects marking a future date", async () => {
    const owner = await signupUser(ctx);
    const h = await createHousehold(ctx, owner.cookie);
    const help = await createHousehelp(ctx, owner.cookie, h.id);
    const res = await ctx.request.put(`/api/households/${h.id}/attendance/${help.id}`).set(csrf).set("cookie", owner.cookie).send({ date: "2026-09-30", status: "PRESENT" });
    expect(res.status).toBe(400);
  });

  it("does not audit a same-day mark", async () => {
    const owner = await signupUser(ctx);
    const h = await createHousehold(ctx, owner.cookie);
    const help = await createHousehelp(ctx, owner.cookie, h.id);
    await ctx.request.put(`/api/households/${h.id}/attendance/${help.id}`).set(csrf).set("cookie", owner.cookie).send({ date: "2026-09-29", status: "PRESENT" });
    const logs = await ctx.db.select().from(auditLogs).where(and(eq(auditLogs.householdId, h.id), eq(auditLogs.action, "attendance.corrected")));
    expect(logs).toHaveLength(0);
  });

  it("MEMBER can mark today but not correct yesterday, and it is audited when an ADMIN does", async () => {
    const owner = await signupUser(ctx);
    const member = await signupUser(ctx);
    const h = await createHousehold(ctx, owner.cookie);
    await addMember(h.id, member.id, "MEMBER");
    const help = await createHousehelp(ctx, owner.cookie, h.id);
    const today = await ctx.request.put(`/api/households/${h.id}/attendance/${help.id}`).set(csrf).set("cookie", member.cookie).send({ date: "2026-09-29", status: "PRESENT" });
    expect(today.status).toBe(200);
    const correction = await ctx.request.put(`/api/households/${h.id}/attendance/${help.id}`).set(csrf).set("cookie", member.cookie).send({ date: "2026-09-28", status: "ABSENT" });
    expect(correction.status).toBe(403);
    const ownerCorrection = await ctx.request.put(`/api/households/${h.id}/attendance/${help.id}`).set(csrf).set("cookie", owner.cookie).send({ date: "2026-09-28", status: "ABSENT" });
    expect(ownerCorrection.status).toBe(200);
    const logs = await ctx.db.select().from(auditLogs).where(and(eq(auditLogs.householdId, h.id), eq(auditLogs.action, "attendance.corrected")));
    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatchObject({ newValue: { status: "ABSENT", note: null } });
  });

  it("VIEWER can view today's attendance but not mark it", async () => {
    const owner = await signupUser(ctx);
    const viewer = await signupUser(ctx);
    const h = await createHousehold(ctx, owner.cookie);
    await addMember(h.id, viewer.id, "VIEWER");
    const help = await createHousehelp(ctx, owner.cookie, h.id);
    expect((await ctx.request.get(`/api/households/${h.id}/attendance/today`).set("cookie", viewer.cookie)).status).toBe(200);
    const res = await ctx.request.put(`/api/households/${h.id}/attendance/${help.id}`).set(csrf).set("cookie", viewer.cookie).send({ date: "2026-09-29", status: "PRESENT" });
    expect(res.status).toBe(403);
  });

  it("clears a mark back to not-marked, and clearing an already-unmarked day is a harmless no-op", async () => {
    const owner = await signupUser(ctx);
    const h = await createHousehold(ctx, owner.cookie);
    const help = await createHousehelp(ctx, owner.cookie, h.id);
    await ctx.request.put(`/api/households/${h.id}/attendance/${help.id}`).set(csrf).set("cookie", owner.cookie).send({ date: "2026-09-29", status: "PRESENT" });
    const clear = await ctx.request.delete(`/api/households/${h.id}/attendance/${help.id}?date=2026-09-29`).set(csrf).set("cookie", owner.cookie);
    expect(clear.status).toBe(200);
    const rows = await ctx.db.select().from(attendanceRecords).where(eq(attendanceRecords.househelpId, help.id));
    expect(rows).toHaveLength(0);
    const again = await ctx.request.delete(`/api/households/${h.id}/attendance/${help.id}?date=2026-09-29`).set(csrf).set("cookie", owner.cookie);
    expect(again.status).toBe(200);
  });

  it("a member of household A cannot mark attendance for household B's househelp", async () => {
    const alice = await signupUser(ctx);
    const bob = await signupUser(ctx);
    const a = await createHousehold(ctx, alice.cookie, "A");
    const b = await createHousehold(ctx, bob.cookie, "B");
    const bobsHelp = await createHousehelp(ctx, bob.cookie, b.id);
    const res = await ctx.request.put(`/api/households/${a.id}/attendance/${bobsHelp.id}`).set(csrf).set("cookie", alice.cookie).send({ date: "2026-09-29", status: "PRESENT" });
    expect(res.status).toBe(404);
  });
});
```

Note: the shared `FakeClock` defaults to `2026-09-29T04:30:00Z` (10:00 IST) per `apps/api/tests/helpers.ts` — every test above relies on `"2026-09-29"` being "today" and `"2026-09-30"` being "tomorrow" in the household's default `Asia/Kolkata` timezone under that clock.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm run test --workspace @household/api -- attendance.test.ts`
Expected: FAIL — `/api/households/:id/attendance/*` routes don't exist yet.

- [ ] **Step 3: Implement `attendance.service.ts`**

Create `apps/api/src/services/attendance.service.ts`:

```ts
import { and, asc, eq, gte, isNull, lte, or } from "drizzle-orm";
import type { AttendanceRecordDTO, AttendanceStatus, MarkAttendanceInput, Permission, TodayAttendanceDTO } from "@household/shared";
import { dateInZone } from "@household/shared";
import { attendanceRecords, attendanceSchedules, househelps } from "../db/schema.js";
import type { DbOrTx } from "../db/client.js";
import { Errors } from "../lib/errors.js";
import { recordAudit } from "./audit.service.js";
import type { Deps } from "./deps.js";
import type { Membership } from "./household.service.js";

type AuthedMembership = Membership & { permissions: Set<Permission> };

function toRecordDTO(row: { date: string; status: AttendanceStatus; note: string | null }): AttendanceRecordDTO {
  return { date: row.date, status: row.status, note: row.note };
}

/** 1=Mon … 7=Sun, matching `attendance_schedules.weekdays`'s convention. */
function isoWeekdayOf(date: string): number {
  return ((new Date(`${date}T00:00:00Z`).getUTCDay() + 6) % 7) + 1;
}

/** Same-day writes only need `attendance.mark`; any other date needs `attendance.editHistory`. Never allows a future date. */
function assertWritable(membership: AuthedMembership, date: string, today: string): void {
  if (date > today) throw Errors.validation({ date: "Can't mark a date in the future." });
  if (date !== today && !membership.permissions.has("attendance.editHistory")) throw Errors.forbidden();
}

/** Takes a bare `db`/`Tx`, not `Deps` — Task 3's `getMonthAttendance` only has a `db` handle, no full `Deps`. */
async function requireHousehelpInHousehold(db: DbOrTx, householdId: string, househelpId: string): Promise<void> {
  const [row] = await db.select({ id: househelps.id }).from(househelps)
    .where(and(eq(househelps.householdId, householdId), eq(househelps.id, househelpId)));
  if (!row) throw Errors.notFound("Househelp");
}

export async function getToday(deps: Deps, membership: Membership, dateParam?: string): Promise<TodayAttendanceDTO> {
  const today = dateInZone(deps.clock.now(), membership.timezone);
  const date = dateParam ?? today;
  if (date > today) throw Errors.validation({ date: "Can't view a date in the future." });
  const isoWeekday = isoWeekdayOf(date);

  const activeHousehelps = await deps.db.select({ id: househelps.id, name: househelps.name, roleTitle: househelps.roleTitle })
    .from(househelps)
    .where(and(eq(househelps.householdId, membership.householdId), isNull(househelps.archivedAt)))
    .orderBy(asc(househelps.name));
  if (activeHousehelps.length === 0) return { date, entries: [] };

  const schedules = await deps.db.select({ househelpId: attendanceSchedules.househelpId, weekdays: attendanceSchedules.weekdays })
    .from(attendanceSchedules)
    .where(and(
      eq(attendanceSchedules.householdId, membership.householdId),
      lte(attendanceSchedules.effectiveFrom, date),
      or(isNull(attendanceSchedules.effectiveTo), gte(attendanceSchedules.effectiveTo, date)),
    ));
  const scheduledIds = new Set(schedules.filter((s) => s.weekdays.includes(isoWeekday)).map((s) => s.househelpId));

  const marks = await deps.db.select({ househelpId: attendanceRecords.househelpId, status: attendanceRecords.status, note: attendanceRecords.note })
    .from(attendanceRecords)
    .where(and(eq(attendanceRecords.householdId, membership.householdId), eq(attendanceRecords.date, date)));
  const markByHousehelp = new Map(marks.map((m) => [m.househelpId, m]));

  // `activeHousehelps` is already name-sorted; this stable sort only reorders scheduled-today to the front.
  const entries = activeHousehelps
    .map((h) => ({
      househelpId: h.id, name: h.name, roleTitle: h.roleTitle,
      scheduledToday: scheduledIds.has(h.id),
      status: markByHousehelp.get(h.id)?.status ?? null,
      note: markByHousehelp.get(h.id)?.note ?? null,
    }))
    .sort((a, b) => Number(b.scheduledToday) - Number(a.scheduledToday));

  return { date, entries };
}

export async function setAttendance(
  deps: Deps, actorUserId: string, membership: AuthedMembership, househelpId: string, input: MarkAttendanceInput, ip?: string,
): Promise<AttendanceRecordDTO> {
  const today = dateInZone(deps.clock.now(), membership.timezone);
  assertWritable(membership, input.date, today);
  await requireHousehelpInHousehold(deps.db, membership.householdId, househelpId);
  const note = input.note ?? null;
  const isCorrection = input.date !== today;

  const row = await deps.db.transaction(async (tx) => {
    const [before] = isCorrection
      ? await tx.select({ status: attendanceRecords.status, note: attendanceRecords.note }).from(attendanceRecords)
          .where(and(eq(attendanceRecords.householdId, membership.householdId), eq(attendanceRecords.househelpId, househelpId), eq(attendanceRecords.date, input.date)))
      : [undefined];
    const now = deps.clock.now();
    const [inserted] = await tx.insert(attendanceRecords).values({
      householdId: membership.householdId, househelpId, date: input.date, status: input.status, note,
      markedByUserId: actorUserId, markedAt: now,
    }).onConflictDoUpdate({
      target: [attendanceRecords.househelpId, attendanceRecords.date],
      set: { status: input.status, note, markedByUserId: actorUserId, markedAt: now },
    }).returning();
    if (isCorrection) {
      await recordAudit(tx, {
        householdId: membership.householdId, actorUserId, action: "attendance.corrected", entityType: "attendance_record", entityId: inserted!.id,
        oldValue: before ? { status: before.status, note: before.note } : null, newValue: { status: input.status, note }, ipAddress: ip ?? null,
      });
    }
    return inserted!;
  });
  return toRecordDTO(row);
}

export async function clearAttendance(
  deps: Deps, actorUserId: string, membership: AuthedMembership, househelpId: string, date: string, ip?: string,
): Promise<void> {
  const today = dateInZone(deps.clock.now(), membership.timezone);
  assertWritable(membership, date, today);
  await requireHousehelpInHousehold(deps.db, membership.householdId, househelpId);
  const isCorrection = date !== today;

  await deps.db.transaction(async (tx) => {
    const [before] = await tx.delete(attendanceRecords)
      .where(and(eq(attendanceRecords.householdId, membership.householdId), eq(attendanceRecords.househelpId, househelpId), eq(attendanceRecords.date, date)))
      .returning({ id: attendanceRecords.id, status: attendanceRecords.status, note: attendanceRecords.note });
    if (before && isCorrection) {
      await recordAudit(tx, {
        householdId: membership.householdId, actorUserId, action: "attendance.corrected", entityType: "attendance_record", entityId: before.id,
        oldValue: { status: before.status, note: before.note }, newValue: null, ipAddress: ip ?? null,
      });
    }
  });
}
```

- [ ] **Step 4: Add the attendance routes to `household.routes.ts`**

Add `import { Errors } from "../lib/errors.js";` alongside the existing `import { ok } from "../lib/respond.js";` line.

Extend the existing `@household/shared` import line — it currently reads (after Phase 2 Spec 2):
`createCategorySchema, createHousehelpSchema, createHouseholdSchema, inviteMemberSchema, moveCategorySchema, updateCategorySchema, updateHousehelpSchema, updateHouseholdSchema, updateMemberSchema, updateScheduleSchema`
— add `dateSchema, markAttendanceSchema`, keeping alphabetical order:
`createCategorySchema, createHousehelpSchema, createHouseholdSchema, dateSchema, inviteMemberSchema, markAttendanceSchema, moveCategorySchema, updateCategorySchema, updateHousehelpSchema, updateHouseholdSchema, updateMemberSchema, updateScheduleSchema`

Add this import alongside the existing `* as schedules` import:

```ts
import * as attendance from "../services/attendance.service.js";
```

Append these routes before `return r;`:

```ts
  r.get("/:householdId/attendance/today", requireHousehold(deps, "attendance.view"), async (req, res) => {
    const dateParam = typeof req.query.date === "string" ? req.query.date : undefined;
    ok(res, await attendance.getToday(deps, req.membership!, dateParam));
  });

  r.put("/:householdId/attendance/:househelpId", requireHousehold(deps, "attendance.mark"), async (req, res) => {
    const input = parseBody(req, markAttendanceSchema);
    ok(res, await attendance.setAttendance(deps, req.auth!.user.id, req.membership!, req.params.househelpId as string, input, req.ip), 200, "Attendance updated.");
  });

  r.delete("/:householdId/attendance/:househelpId", requireHousehold(deps, "attendance.mark"), async (req, res) => {
    const parsedDate = dateSchema.safeParse(req.query.date);
    if (!parsedDate.success) throw Errors.validation({ date: "Use YYYY-MM-DD" });
    await attendance.clearAttendance(deps, req.auth!.user.id, req.membership!, req.params.househelpId as string, parsedDate.data, req.ip);
    ok(res, null, 200, "Attendance cleared.");
  });
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npm run test --workspace @household/api -- attendance.test.ts`
Expected: PASS — all cases in the "attendance — today marking" describe block.

- [ ] **Step 6: Run the full API suite to check for regressions**

Run: `npm run test --workspace @household/api`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add apps/api/src/services/attendance.service.ts apps/api/src/routes/household.routes.ts apps/api/tests/attendance.test.ts
git commit -m "feat(api): one-tap attendance marking with same-day/history permission split"
```

---

### Task 3: API — bulk holiday and monthly calendar query

**Files:**
- Modify: `apps/api/src/services/attendance.service.ts`
- Modify: `apps/api/src/routes/household.routes.ts`
- Modify: `apps/api/tests/attendance.test.ts` (append a new describe block)

**Interfaces:**
- Consumes: everything Task 2 produced, plus `monthSchema`/`markHolidaySchema`/`MarkHolidayResultDTO` (`@household/shared`).
- Produces: `markHoliday(deps, actorUserId, membership, date, ip?): Promise<MarkHolidayResultDTO>`, `getMonthAttendance(db, householdId, househelpId, month): Promise<AttendanceRecordDTO[]>` — appended to `attendance.service.ts`.

- [ ] **Step 1: Write the failing integration tests**

Append to `apps/api/tests/attendance.test.ts` (same file as Task 2). No import changes needed — these tests only go through the HTTP API (`ctx.request`), not direct table queries.

```ts
describe("attendance — bulk holiday", () => {
  it("marks every active househelp as holiday, overwriting existing marks", async () => {
    const owner = await signupUser(ctx);
    const h = await createHousehold(ctx, owner.cookie);
    const a = await createHousehelp(ctx, owner.cookie, h.id, "Already Present");
    const b = await createHousehelp(ctx, owner.cookie, h.id, "Unmarked");
    const gone = await createHousehelp(ctx, owner.cookie, h.id, "Archived");
    await ctx.request.post(`/api/households/${h.id}/househelps/${gone.id}/archive`).set(csrf).set("cookie", owner.cookie);
    await ctx.request.put(`/api/households/${h.id}/attendance/${a.id}`).set(csrf).set("cookie", owner.cookie).send({ date: "2026-09-29", status: "PRESENT" });

    const res = await ctx.request.post(`/api/households/${h.id}/attendance/holiday`).set(csrf).set("cookie", owner.cookie).send({ date: "2026-09-29" });
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ date: "2026-09-29", count: 2 });

    const today = await ctx.request.get(`/api/households/${h.id}/attendance/today`).set("cookie", owner.cookie);
    const byName = Object.fromEntries(today.body.data.entries.map((e: { name: string; status: string | null }) => [e.name, e.status]));
    expect(byName["Already Present"]).toBe("HOLIDAY");
    expect(byName["Unmarked"]).toBe("HOLIDAY");
    expect(byName["Archived"]).toBeUndefined();
    void b;
  });

  it("rejects a future date and requires editHistory for a past date, same as single marks", async () => {
    const owner = await signupUser(ctx);
    const member = await signupUser(ctx);
    const h = await createHousehold(ctx, owner.cookie);
    await addMember(h.id, member.id, "MEMBER");
    await createHousehelp(ctx, owner.cookie, h.id);
    const future = await ctx.request.post(`/api/households/${h.id}/attendance/holiday`).set(csrf).set("cookie", owner.cookie).send({ date: "2026-09-30" });
    expect(future.status).toBe(400);
    const memberPast = await ctx.request.post(`/api/households/${h.id}/attendance/holiday`).set(csrf).set("cookie", member.cookie).send({ date: "2026-09-28" });
    expect(memberPast.status).toBe(403);
    const ownerPast = await ctx.request.post(`/api/households/${h.id}/attendance/holiday`).set(csrf).set("cookie", owner.cookie).send({ date: "2026-09-28" });
    expect(ownerPast.status).toBe(200);
  });
});

describe("attendance — monthly calendar", () => {
  it("returns only marked days within the requested month, ordered by date", async () => {
    const owner = await signupUser(ctx);
    const h = await createHousehold(ctx, owner.cookie);
    const help = await createHousehelp(ctx, owner.cookie, h.id);
    await ctx.request.put(`/api/households/${h.id}/attendance/${help.id}`).set(csrf).set("cookie", owner.cookie).send({ date: "2026-09-29", status: "PRESENT" });
    ctx.clock.set("2026-08-15T04:30:00Z");
    await ctx.request.put(`/api/households/${h.id}/attendance/${help.id}`).set(csrf).set("cookie", owner.cookie).send({ date: "2026-08-15", status: "ABSENT" });
    ctx.clock.set("2026-09-29T04:30:00Z");

    const res = await ctx.request.get(`/api/households/${h.id}/househelps/${help.id}/attendance?month=2026-09`).set("cookie", owner.cookie);
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual([{ date: "2026-09-29", status: "PRESENT", note: null }]);
  });

  it("uses the household's timezone, not UTC, to place a mark on the correct side of a month boundary", async () => {
    const owner = await signupUser(ctx);
    const h = await createHousehold(ctx, owner.cookie);
    const help = await createHousehelp(ctx, owner.cookie, h.id);
    // 2026-09-30T19:00:00Z is still September in UTC but already 2026-10-01 00:30 in Asia/Kolkata (UTC+5:30).
    ctx.clock.set("2026-09-30T19:00:00Z");
    const mark = await ctx.request.put(`/api/households/${h.id}/attendance/${help.id}`).set(csrf).set("cookie", owner.cookie).send({ date: "2026-10-01", status: "PRESENT" });
    expect(mark.status).toBe(200);
    const september = await ctx.request.get(`/api/households/${h.id}/househelps/${help.id}/attendance?month=2026-09`).set("cookie", owner.cookie);
    expect(september.body.data).toEqual([]);
    const october = await ctx.request.get(`/api/households/${h.id}/househelps/${help.id}/attendance?month=2026-10`).set("cookie", owner.cookie);
    expect(october.body.data).toEqual([{ date: "2026-10-01", status: "PRESENT", note: null }]);
  });

  it("rejects a malformed month", async () => {
    const owner = await signupUser(ctx);
    const h = await createHousehold(ctx, owner.cookie);
    const help = await createHousehelp(ctx, owner.cookie, h.id);
    const res = await ctx.request.get(`/api/households/${h.id}/househelps/${help.id}/attendance?month=2026-9`).set("cookie", owner.cookie);
    expect(res.status).toBe(400);
  });

  it("still returns a calendar for an archived househelp", async () => {
    const owner = await signupUser(ctx);
    const h = await createHousehold(ctx, owner.cookie);
    const help = await createHousehelp(ctx, owner.cookie, h.id);
    await ctx.request.put(`/api/households/${h.id}/attendance/${help.id}`).set(csrf).set("cookie", owner.cookie).send({ date: "2026-09-29", status: "PRESENT" });
    await ctx.request.post(`/api/households/${h.id}/househelps/${help.id}/archive`).set(csrf).set("cookie", owner.cookie);
    const res = await ctx.request.get(`/api/households/${h.id}/househelps/${help.id}/attendance?month=2026-09`).set("cookie", owner.cookie);
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual([{ date: "2026-09-29", status: "PRESENT", note: null }]);
  });

  it("a member of household A cannot read household B's calendar", async () => {
    const alice = await signupUser(ctx);
    const bob = await signupUser(ctx);
    const a = await createHousehold(ctx, alice.cookie, "A");
    const b = await createHousehold(ctx, bob.cookie, "B");
    const bobsHelp = await createHousehelp(ctx, bob.cookie, b.id);
    const res = await ctx.request.get(`/api/households/${a.id}/househelps/${bobsHelp.id}/attendance?month=2026-09`).set("cookie", alice.cookie);
    expect(res.status).toBe(404);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm run test --workspace @household/api -- attendance.test.ts`
Expected: FAIL on every case in both new describe blocks (routes don't exist yet).

- [ ] **Step 3: Add `markHoliday` and `getMonthAttendance` to `attendance.service.ts`**

Add `lt` to the existing `drizzle-orm` import line (`and, asc, eq, gte, isNull, lte, or` → `and, asc, eq, gte, isNull, lt, lte, or`). Add `MarkHolidayResultDTO` to the existing `@household/shared` type-only import line (`DbOrTx` is already imported from Task 2 — `requireHousehelpInHousehold` was written there to take a bare `db: DbOrTx`, precisely so `getMonthAttendance` below can call it without a `Deps`).

Append to `apps/api/src/services/attendance.service.ts`:

```ts
export async function markHoliday(deps: Deps, actorUserId: string, membership: AuthedMembership, date: string, ip?: string): Promise<MarkHolidayResultDTO> {
  const today = dateInZone(deps.clock.now(), membership.timezone);
  assertWritable(membership, date, today);
  const isCorrection = date !== today;

  const count = await deps.db.transaction(async (tx) => {
    const active = await tx.select({ id: househelps.id }).from(househelps)
      .where(and(eq(househelps.householdId, membership.householdId), isNull(househelps.archivedAt)));
    if (active.length === 0) return 0;
    const now = deps.clock.now();
    await tx.insert(attendanceRecords).values(active.map((h) => ({
      householdId: membership.householdId, househelpId: h.id, date, status: "HOLIDAY" as const, note: null,
      markedByUserId: actorUserId, markedAt: now,
    }))).onConflictDoUpdate({
      target: [attendanceRecords.househelpId, attendanceRecords.date],
      set: { status: "HOLIDAY", note: null, markedByUserId: actorUserId, markedAt: now },
    });
    if (isCorrection) {
      await recordAudit(tx, {
        householdId: membership.householdId, actorUserId, action: "attendance.holidayMarked", entityType: "attendance_record",
        newValue: { date, count: active.length }, ipAddress: ip ?? null,
      });
    }
    return active.length;
  });
  return { date, count };
}

function nextMonth(month: string): string {
  const [y, m] = month.split("-").map(Number);
  return m === 12 ? `${y! + 1}-01` : `${y}-${String(m! + 1).padStart(2, "0")}`;
}

export async function getMonthAttendance(db: DbOrTx, householdId: string, househelpId: string, month: string): Promise<AttendanceRecordDTO[]> {
  await requireHousehelpInHousehold(db, householdId, househelpId);
  const start = `${month}-01`;
  const end = `${nextMonth(month)}-01`;
  const rows = await db.select({ date: attendanceRecords.date, status: attendanceRecords.status, note: attendanceRecords.note })
    .from(attendanceRecords)
    .where(and(eq(attendanceRecords.householdId, householdId), eq(attendanceRecords.househelpId, househelpId), gte(attendanceRecords.date, start), lt(attendanceRecords.date, end)))
    .orderBy(asc(attendanceRecords.date));
  return rows.map(toRecordDTO);
}
```

- [ ] **Step 4: Add the holiday and month-calendar routes to `household.routes.ts`**

Extend the shared import line once more, adding `markHolidaySchema, monthSchema` (alphabetical, full line now):
`createCategorySchema, createHousehelpSchema, createHouseholdSchema, dateSchema, inviteMemberSchema, markAttendanceSchema, markHolidaySchema, monthSchema, moveCategorySchema, updateCategorySchema, updateHousehelpSchema, updateHouseholdSchema, updateMemberSchema, updateScheduleSchema`

Append before `return r;` (after the Task 2 attendance routes):

```ts
  r.post("/:householdId/attendance/holiday", requireHousehold(deps, "attendance.mark"), async (req, res) => {
    const { date } = parseBody(req, markHolidaySchema);
    ok(res, await attendance.markHoliday(deps, req.auth!.user.id, req.membership!, date, req.ip), 200, "Marked as holiday.");
  });

  r.get("/:householdId/househelps/:id/attendance", requireHousehold(deps, "attendance.view"), async (req, res) => {
    const parsedMonth = monthSchema.safeParse(req.query.month);
    if (!parsedMonth.success) throw Errors.validation({ month: "Use YYYY-MM" });
    ok(res, await attendance.getMonthAttendance(deps.db, req.membership!.householdId, req.params.id as string, parsedMonth.data));
  });
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npm run test --workspace @household/api -- attendance.test.ts`
Expected: PASS — all cases across all three describe blocks (Task 2's + Task 3's two).

- [ ] **Step 6: Run the full API suite to check for regressions**

Run: `npm run test --workspace @household/api`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add apps/api/src/services/attendance.service.ts apps/api/src/routes/household.routes.ts apps/api/tests/attendance.test.ts
git commit -m "feat(api): bulk holiday marking and per-househelp monthly calendar query"
```

---

### Task 4: Web — Today screen

**Files:**
- Create: `apps/web/src/features/app/attendance/useAttendance.ts`
- Create: `apps/web/src/features/app/attendance/statusTone.ts`
- Create: `apps/web/src/features/app/attendance/AttendancePicker.tsx`
- Create: `apps/web/src/features/app/attendance/TodayPage.tsx`
- Test: `apps/web/src/features/app/attendance/TodayPage.test.tsx`
- Modify: `apps/web/src/styles/components.css`
- Modify: `apps/web/src/App.tsx`
- Modify: `apps/web/src/features/app/househelps/HousehelpsListPage.tsx`

**Interfaces:**
- Consumes: `get`/`post`/`put`/`del` (`apps/web/src/lib/api.ts`), `ApiError` (same file), `AttendanceStatus`/`AttendanceRecordDTO`/`MarkAttendanceInput`/`TodayAttendanceDTO`/`MarkHolidayResultDTO` (`@household/shared`), `Alert`/`Button`/`EmptyState` (`apps/web/src/components/*`), `useHousehold` (`apps/web/src/features/app/members/useMembers.ts`), `useActiveHousehold` (`apps/web/src/features/app/useActiveHousehold.ts`).
- Produces: `useTodayAttendance`, `useSetAttendance`, `useClearAttendance`, `useMarkHoliday` (`useAttendance.ts` — Task 5 adds `useMonthAttendance` to this same file); `STATUS_LABEL`, `toneOf` (`statusTone.ts`); `AttendancePicker` component (`AttendancePicker.tsx` — reused unmodified by Task 5).

- [ ] **Step 1: Write the failing component test**

Create `apps/web/src/features/app/attendance/TodayPage.test.tsx`:

```tsx
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { meKey } from "../../auth/session";
import { TodayPage } from "./TodayPage";

const HOUSEHOLD = { id: "h1", name: "Shah Family", timezone: "Asia/Kolkata", role: "OWNER" as const, memberCount: 2 };

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function renderPage() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  qc.setQueryData(meKey, { user: { id: "u1", name: "Parakh", email: "p@example.com", emailVerified: true, createdAt: "2026-01-01T00:00:00.000Z" }, households: [HOUSEHOLD] });
  return render(<QueryClientProvider client={qc}><MemoryRouter><TodayPage /></MemoryRouter></QueryClientProvider>);
}
```

The permissions for each test come entirely from that test's own `/households/h1` fetch mock (see below) — `renderPage` takes no arguments. Now the actual test cases (append after `renderPage`):

```tsx
describe("TodayPage", () => {
  beforeEach(() => { vi.restoreAllMocks(); });
  afterEach(() => { vi.restoreAllMocks(); });

  it("cycles a house help between Present and Absent on tap", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation((async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/households/h1")) return jsonResponse({ success: true, data: { ...HOUSEHOLD, permissions: ["attendance.view", "attendance.mark"] }, message: null });
      if (init?.method === "PUT" && url.includes("/attendance/hh1")) return jsonResponse({ success: true, data: { date: "2026-09-29", status: "PRESENT", note: null }, message: null });
      if (url.endsWith("/attendance/today")) {
        return jsonResponse({ success: true, data: { date: "2026-09-29", entries: [{ househelpId: "hh1", name: "Sunita", roleTitle: "Cook", scheduledToday: true, status: null, note: null }] } }, 200);
      }
      throw new Error(`unexpected fetch ${url}`);
    }) as typeof fetch);
    renderPage();
    const row = await screen.findByText("Sunita");
    await userEvent.click(row);
    const putCall = fetchSpy.mock.calls.find(([u, init]) => String(u).includes("/attendance/hh1") && (init as RequestInit | undefined)?.method === "PUT");
    expect(putCall).toBeDefined();
    const body = JSON.parse((putCall![1] as RequestInit).body as string);
    expect(body).toEqual({ date: "2026-09-29", status: "PRESENT" });
  });

  it("opens the picker and sets Half-day", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation((async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/households/h1")) return jsonResponse({ success: true, data: { ...HOUSEHOLD, permissions: ["attendance.view", "attendance.mark"] }, message: null });
      if (init?.method === "PUT" && url.includes("/attendance/hh1")) return jsonResponse({ success: true, data: { date: "2026-09-29", status: "HALF_DAY", note: null }, message: null });
      if (url.endsWith("/attendance/today")) {
        return jsonResponse({ success: true, data: { date: "2026-09-29", entries: [{ househelpId: "hh1", name: "Sunita", roleTitle: "Cook", scheduledToday: true, status: null, note: null }] } }, 200);
      }
      throw new Error(`unexpected fetch ${url}`);
    }) as typeof fetch);
    renderPage();
    await screen.findByText("Sunita");
    await userEvent.click(screen.getByRole("button", { name: "More" }));
    await userEvent.click(screen.getByRole("button", { name: "Half-day" }));
    const putCall = fetchSpy.mock.calls.find(([u, init]) => String(u).includes("/attendance/hh1") && (init as RequestInit | undefined)?.method === "PUT");
    const body = JSON.parse((putCall![1] as RequestInit).body as string);
    expect(body).toEqual({ date: "2026-09-29", status: "HALF_DAY" });
  });

  it("confirms before marking today as a holiday, showing how many are already marked", async () => {
    const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(true);
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation((async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/households/h1")) return jsonResponse({ success: true, data: { ...HOUSEHOLD, permissions: ["attendance.view", "attendance.mark"] }, message: null });
      if (init?.method === "POST" && url.endsWith("/attendance/holiday")) return jsonResponse({ success: true, data: { date: "2026-09-29", count: 1 }, message: null });
      if (url.endsWith("/attendance/today")) {
        return jsonResponse({ success: true, data: { date: "2026-09-29", entries: [{ househelpId: "hh1", name: "Sunita", roleTitle: "Cook", scheduledToday: true, status: "PRESENT", note: null }] } }, 200);
      }
      throw new Error(`unexpected fetch ${url}`);
    }) as typeof fetch);
    renderPage();
    await screen.findByText("Sunita");
    await userEvent.click(screen.getByRole("button", { name: "Mark today as holiday" }));
    expect(confirmSpy).toHaveBeenCalledWith(expect.stringContaining("1 already marked"));
    const postCall = fetchSpy.mock.calls.find(([u, init]) => String(u).endsWith("/attendance/holiday") && (init as RequestInit | undefined)?.method === "POST");
    expect(postCall).toBeDefined();
  });

  it("hides marking controls for a VIEWER", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation((async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/households/h1")) return jsonResponse({ success: true, data: { ...HOUSEHOLD, permissions: ["attendance.view"] }, message: null });
      if (url.endsWith("/attendance/today")) {
        return jsonResponse({ success: true, data: { date: "2026-09-29", entries: [{ househelpId: "hh1", name: "Sunita", roleTitle: "Cook", scheduledToday: true, status: "PRESENT", note: null }] } }, 200);
      }
      throw new Error(`unexpected fetch ${url}`);
    }) as typeof fetch);
    renderPage();
    await screen.findByText("Sunita");
    expect(screen.queryByRole("button", { name: "More" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Mark today as holiday" })).not.toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm run test --workspace @household/web -- TodayPage`
Expected: FAIL — `./TodayPage` doesn't exist yet.

- [ ] **Step 3: Add status-tone helper**

Create `apps/web/src/features/app/attendance/statusTone.ts`:

```ts
import type { AttendanceStatus } from "@household/shared";

export type StatusTone = "ok" | "overdue" | "due-soon" | "info" | "neutral" | "muted";

export const STATUS_LABEL: Record<AttendanceStatus, string> = {
  PRESENT: "Present", ABSENT: "Absent", HALF_DAY: "Half-day", LEAVE: "Leave", HOLIDAY: "Holiday",
};

const STATUS_TONE: Record<AttendanceStatus, StatusTone> = {
  PRESENT: "ok", ABSENT: "overdue", HALF_DAY: "due-soon", LEAVE: "info", HOLIDAY: "neutral",
};

export function toneOf(status: AttendanceStatus | null): StatusTone {
  return status ? STATUS_TONE[status] : "muted";
}
```

- [ ] **Step 4: Add the shared `AttendancePicker` component**

Create `apps/web/src/features/app/attendance/AttendancePicker.tsx`:

```tsx
import type { AttendanceStatus } from "@household/shared";
import { STATUS_LABEL } from "./statusTone";

const OPTIONS: { value: AttendanceStatus | null; label: string }[] = [
  { value: "PRESENT", label: STATUS_LABEL.PRESENT },
  { value: "ABSENT", label: STATUS_LABEL.ABSENT },
  { value: "HALF_DAY", label: STATUS_LABEL.HALF_DAY },
  { value: "LEAVE", label: STATUS_LABEL.LEAVE },
  { value: "HOLIDAY", label: STATUS_LABEL.HOLIDAY },
  { value: null, label: "Not marked" },
];

export function AttendancePicker({ status, onSelect }: { status: AttendanceStatus | null; onSelect: (status: AttendanceStatus | null) => void }) {
  return (
    <div className="chips" role="group" aria-label="Attendance status">
      {OPTIONS.map((opt) => (
        <button key={opt.label} type="button" className="chip" aria-pressed={status === opt.value} onClick={() => onSelect(opt.value)}>
          {opt.label}
        </button>
      ))}
    </div>
  );
}
```

- [ ] **Step 5: Add attendance hooks**

Create `apps/web/src/features/app/attendance/useAttendance.ts`:

```ts
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { AttendanceRecordDTO, MarkAttendanceInput, MarkHolidayResultDTO, TodayAttendanceDTO } from "@household/shared";
import { del, get, post, put } from "../../../lib/api";

export function useTodayAttendance(householdId: string | undefined) {
  return useQuery({
    queryKey: ["attendance", "today", householdId],
    queryFn: ({ signal }) => get<TodayAttendanceDTO>(`/households/${householdId}/attendance/today`, signal).then((r) => r.data),
    enabled: !!householdId,
  });
}

function invalidateAttendance(qc: ReturnType<typeof useQueryClient>, householdId: string, househelpId?: string) {
  return Promise.all([
    qc.invalidateQueries({ queryKey: ["attendance", "today", householdId] }),
    ...(househelpId ? [qc.invalidateQueries({ queryKey: ["attendance", "month", householdId, househelpId] })] : []),
  ]);
}

export function useSetAttendance(householdId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ househelpId, body }: { househelpId: string; body: MarkAttendanceInput }) =>
      put<AttendanceRecordDTO>(`/households/${householdId}/attendance/${househelpId}`, body),
    onSuccess: (_data, { househelpId }) => invalidateAttendance(qc, householdId, househelpId),
  });
}

export function useClearAttendance(householdId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ househelpId, date }: { househelpId: string; date: string }) =>
      del<null>(`/households/${householdId}/attendance/${househelpId}?date=${date}`),
    onSuccess: (_data, { househelpId }) => invalidateAttendance(qc, householdId, househelpId),
  });
}

export function useMarkHoliday(householdId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (date: string) => post<MarkHolidayResultDTO>(`/households/${householdId}/attendance/holiday`, { date }),
    onSuccess: () => invalidateAttendance(qc, householdId),
  });
}
```

- [ ] **Step 6: Add badge tone classes to `components.css`**

Append to the end of `apps/web/src/styles/components.css` (after the existing `.badge`/`.badge--neutral` rules):

```css
.badge--ok { background: var(--ok-bg); color: var(--ok); }
.badge--overdue { background: var(--overdue-bg); color: var(--overdue); }
.badge--due-soon { background: var(--due-soon-bg); color: var(--due-soon); }
.badge--info { background: var(--info-bg); color: var(--info); }
.badge--muted { background: var(--line); color: var(--ink-3); }
```

- [ ] **Step 7: Implement `TodayPage.tsx`**

Create `apps/web/src/features/app/attendance/TodayPage.tsx`:

```tsx
import { useState } from "react";
import { Link } from "react-router-dom";
import { Users } from "lucide-react";
import type { AttendanceStatus } from "@household/shared";
import { ApiError } from "../../../lib/api";
import { Alert } from "../../../components/Alert";
import { Button } from "../../../components/Button";
import { EmptyState } from "../../../components/EmptyState";
import { useActiveHousehold } from "../useActiveHousehold";
import { useHousehold } from "../members/useMembers";
import { AttendancePicker } from "./AttendancePicker";
import { STATUS_LABEL, toneOf } from "./statusTone";
import { useClearAttendance, useMarkHoliday, useSetAttendance, useTodayAttendance } from "./useAttendance";

function messageFrom(err: unknown): string {
  return err instanceof ApiError ? err.message : "Something went wrong. Please try again.";
}

export function TodayPage() {
  const { household: active } = useActiveHousehold();
  const householdId = active?.id;
  const householdQuery = useHousehold(householdId);
  const todayQuery = useTodayAttendance(householdId);
  const setAttendance = useSetAttendance(householdId ?? "");
  const clearAttendance = useClearAttendance(householdId ?? "");
  const markHoliday = useMarkHoliday(householdId ?? "");
  const canMark = householdQuery.data?.permissions.includes("attendance.mark") ?? false;
  const [openFor, setOpenFor] = useState<string | null>(null);
  const [pageError, setPageError] = useState<string | null>(null);

  if (!householdId || !todayQuery.data) return null;
  const { date, entries } = todayQuery.data;

  function onTap(househelpId: string, current: AttendanceStatus | null) {
    const next: AttendanceStatus = current === "PRESENT" ? "ABSENT" : "PRESENT";
    setAttendance.mutate({ househelpId, body: { date, status: next } }, { onError: (err) => setPageError(messageFrom(err)) });
  }

  function onPick(househelpId: string, status: AttendanceStatus | null) {
    setOpenFor(null);
    if (status === null) clearAttendance.mutate({ househelpId, date }, { onError: (err) => setPageError(messageFrom(err)) });
    else setAttendance.mutate({ househelpId, body: { date, status } }, { onError: (err) => setPageError(messageFrom(err)) });
  }

  function onMarkHoliday() {
    const alreadyMarked = entries.filter((e) => e.status !== null && e.status !== "HOLIDAY").length;
    const question = alreadyMarked > 0 ? `${alreadyMarked} already marked — overwrite everyone with Holiday?` : "Mark today as a holiday for everyone?";
    if (!window.confirm(question)) return;
    markHoliday.mutate(date, { onError: (err) => setPageError(messageFrom(err)) });
  }

  return (
    <>
      <header className="page-head"><h1 className="page-title">Today's attendance</h1></header>
      {pageError && <Alert tone="error" title={pageError} />}

      {canMark && entries.length > 0 && (
        <div style={{ marginBottom: "var(--space-4)" }}>
          <Button variant="secondary" loading={markHoliday.isPending} onClick={onMarkHoliday}>Mark today as holiday</Button>
        </div>
      )}

      {entries.length === 0 && (
        <div className="card">
          <EmptyState icon={<Users size={22} />} title="No househelps yet" text="Add a househelp to start marking daily attendance." />
        </div>
      )}

      <div className="list">
        {entries.map((e) => (
          <div key={e.househelpId}>
            <div className="list__item">
              <button
                type="button"
                className="list__text"
                style={{ textAlign: "left", background: "none", border: 0, padding: 0, cursor: canMark ? "pointer" : "default" }}
                disabled={!canMark}
                onClick={() => onTap(e.househelpId, e.status)}
              >
                <span className="list__label" style={{ display: "block" }}>{e.name}{!e.scheduledToday && " (not scheduled today)"}</span>
                <span className="list__meta">{e.roleTitle ?? "Househelp"}</span>
              </button>
              <span className={`badge badge--${toneOf(e.status)}`}>{e.status ? STATUS_LABEL[e.status] : "Not marked"}</span>
              {canMark && <Button variant="ghost" onClick={() => setOpenFor(openFor === e.househelpId ? null : e.househelpId)}>More</Button>}
            </div>
            {openFor === e.househelpId && (
              <div style={{ padding: "0 var(--space-4) var(--space-3)" }}>
                <AttendancePicker status={e.status} onSelect={(status) => onPick(e.househelpId, status)} />
              </div>
            )}
          </div>
        ))}
      </div>

      <div style={{ marginTop: "var(--space-4)" }}><Link to="/househelps" className="list__label">Back to househelps</Link></div>
    </>
  );
}
```

- [ ] **Step 8: Wire the route and a header link**

In `apps/web/src/App.tsx`: the feature imports are ordered alphabetically (case-insensitive) by their full relative path — `./features/app/AppShell`, then `./features/app/ComingSoonPage`, then `./features/app/guards`, etc. `./features/app/attendance/TodayPage` sorts right between the first two, so add it there:

```tsx
import { AppShell } from "./features/app/AppShell";
import { TodayPage } from "./features/app/attendance/TodayPage";
import { ComingSoonPage } from "./features/app/ComingSoonPage";
```

Then add the route inside the existing `<Route element={<RequireAuth><AppShell /></RequireAuth>}>` block, alongside the `househelps` routes:

```tsx
        <Route path="attendance" element={<TodayPage />} />
```

In `apps/web/src/features/app/househelps/HousehelpsListPage.tsx`: add a link to the Today screen next to the existing "Manage categories" link. The current header div reads:

```tsx
        {canManageCategories && <Link to="/househelps/categories" className="list__label">Manage categories</Link>}
```

Change it to also render an always-visible attendance link (anyone with `househelps.view` already reached this page, and `attendance.view` is granted to every role by default, so no extra permission check is needed here — the Today screen itself gates on `attendance.view`):

```tsx
        <div style={{ display: "flex", gap: "var(--space-4)" }}>
          <Link to="/attendance" className="list__label">Today's attendance</Link>
          {canManageCategories && <Link to="/househelps/categories" className="list__label">Manage categories</Link>}
        </div>
```

- [ ] **Step 9: Run the test to verify it passes**

Run: `npm run test --workspace @household/web -- TodayPage`
Expected: PASS — all 4 cases.

- [ ] **Step 10: Run the full web suite to check for regressions**

Run: `npm run test --workspace @household/web`
Expected: PASS (the `HousehelpsListPage.test.tsx` header-link assertions still hold since "Manage categories" is unchanged, just relocated inside a wrapping `div`).

- [ ] **Step 11: Commit**

```bash
git add apps/web/src/features/app/attendance apps/web/src/styles/components.css apps/web/src/App.tsx apps/web/src/features/app/househelps/HousehelpsListPage.tsx
git commit -m "feat(web): Today screen for one-tap attendance marking"
```

---

### Task 5: Web — per-househelp calendar

**Files:**
- Modify: `apps/web/src/features/app/attendance/useAttendance.ts`
- Create: `apps/web/src/features/app/attendance/HousehelpCalendarPage.tsx`
- Test: `apps/web/src/features/app/attendance/HousehelpCalendarPage.test.tsx`
- Modify: `apps/web/src/styles/components.css`
- Modify: `apps/web/src/App.tsx`
- Modify: `apps/web/src/features/app/househelps/HousehelpDetailPage.tsx`

**Interfaces:**
- Consumes: everything Task 4 produced, plus `useHousehelp`/`useSchedule` (`apps/web/src/features/app/househelps/useHousehelps.ts`), `dateInZone` (`@household/shared`).
- Produces: `useMonthAttendance` (appended to `useAttendance.ts`).

- [ ] **Step 1: Write the failing component test**

Create `apps/web/src/features/app/attendance/HousehelpCalendarPage.test.tsx`:

```tsx
import { afterEach, describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { meKey } from "../../auth/session";
import { HousehelpCalendarPage } from "./HousehelpCalendarPage";

const HOUSEHOLD = { id: "h1", name: "Shah Family", timezone: "Asia/Kolkata", role: "OWNER" as const, memberCount: 2 };
const HOUSEHELP = { id: "hh1", name: "Sunita", phone: null, roleTitle: "Cook", status: "ACTIVE" as const, startDate: null, endDate: null, salaryMode: "FIXED_MONTHLY" as const, monthlySalaryPaise: null, dailyRatePaise: null, halfDayRatePaise: null, salaryDueDay: 1, notes: null, archivedAt: null, categoryIds: [], createdAt: "2026-01-01T00:00:00.000Z" };

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function renderPage(permissions: string[]) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  qc.setQueryData(meKey, { user: { id: "u1", name: "Parakh", email: "p@example.com", emailVerified: true, createdAt: "2026-01-01T00:00:00.000Z" }, households: [HOUSEHOLD] });
  vi.spyOn(globalThis, "fetch").mockImplementation((async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.endsWith("/households/h1")) return jsonResponse({ success: true, data: { ...HOUSEHOLD, permissions }, message: null });
    if (url.endsWith("/households/h1/househelps/hh1")) return jsonResponse({ success: true, data: HOUSEHELP, message: null });
    if (url.endsWith("/households/h1/househelps/hh1/schedule")) return jsonResponse({ success: true, data: { id: "s1", weekdays: [1, 2, 3, 4, 5], startTime: null, endTime: null, effectiveFrom: "2026-01-01" }, message: null });
    if (init?.method === "PUT" && url.includes("/attendance/hh1")) return jsonResponse({ success: true, data: { date: "2026-09-15", status: "ABSENT", note: null }, message: null });
    if (url.includes("/attendance?month=2026-09")) return jsonResponse({ success: true, data: [{ date: "2026-09-15", status: "PRESENT", note: null }] });
    if (/\/attendance\?month=\d{4}-\d{2}$/.test(url)) return jsonResponse({ success: true, data: [] });
    throw new Error(`unexpected fetch ${url}`);
  }) as typeof fetch);
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={["/househelps/hh1/attendance"]}>
        <Routes><Route path="/househelps/:id/attendance" element={<HousehelpCalendarPage />} /></Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe("HousehelpCalendarPage", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    // Pins `new Date()` (used by the page to compute its default month and "today") to a known
    // instant, so the initial grid always renders September 2026 regardless of when this test runs.
    // `toFake: ["Date"]` deliberately leaves setTimeout/setInterval real — faking those too would
    // hang every `userEvent.click` below, since user-event's internal delays rely on real timers.
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-09-29T04:30:00Z"));
  });
  afterEach(() => { vi.useRealTimers(); });

  it("renders the marked day and opens the picker to post a correction on a past day", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    renderPage(["attendance.view", "attendance.editHistory"]);
    await screen.findByText("Sunita's attendance");
    const day15 = await screen.findByRole("button", { name: "15" });
    await userEvent.click(day15);
    await userEvent.click(screen.getByRole("button", { name: "Absent" }));
    const putCall = fetchSpy.mock.calls.find(([u, init]) => String(u).includes("/attendance/hh1") && (init as RequestInit | undefined)?.method === "PUT");
    expect(putCall).toBeDefined();
    const body = JSON.parse((putCall![1] as RequestInit).body as string);
    expect(body).toEqual({ date: "2026-09-15", status: "ABSENT" });
  });

  it("disables editing a past day without attendance.editHistory", async () => {
    renderPage(["attendance.view", "attendance.mark"]);
    await screen.findByText("Sunita's attendance");
    const day15 = await screen.findByRole("button", { name: "15" });
    expect(day15).toBeDisabled();
  });

  it("navigates to the next month and requests its data", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    renderPage(["attendance.view", "attendance.editHistory"]);
    await screen.findByText("September 2026");
    await userEvent.click(screen.getByRole("button", { name: "Next" }));
    await screen.findByText("October 2026");
    expect(fetchSpy.mock.calls.some(([u]) => String(u).includes("/attendance?month=2026-10"))).toBe(true);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm run test --workspace @household/web -- HousehelpCalendarPage`
Expected: FAIL — `./HousehelpCalendarPage` doesn't exist yet.

- [ ] **Step 3: Add `useMonthAttendance` to `useAttendance.ts`**

No import changes needed — `AttendanceRecordDTO` is already imported (Task 4 uses it for `useSetAttendance`'s return type).

Append to `useAttendance.ts`:

```ts
export function useMonthAttendance(householdId: string | undefined, househelpId: string | undefined, month: string) {
  return useQuery({
    queryKey: ["attendance", "month", householdId, househelpId, month],
    queryFn: ({ signal }) => get<AttendanceRecordDTO[]>(`/households/${householdId}/househelps/${househelpId}/attendance?month=${month}`, signal).then((r) => r.data),
    enabled: !!householdId && !!househelpId,
  });
}
```

- [ ] **Step 4: Add calendar-grid CSS**

Append to `apps/web/src/styles/components.css`:

```css
.cal__grid { display: grid; grid-template-columns: repeat(7, 1fr); gap: var(--space-1); }
.cal__day { aspect-ratio: 1; min-height: var(--touch); border-radius: var(--radius-sm); border: 1px solid var(--line); font-weight: 700; font-size: var(--text-sm); cursor: pointer; background: var(--surface); color: var(--ink); }
.cal__day:disabled { cursor: not-allowed; }
.cal__day--dim { opacity: 0.55; }
.cal__day--ok { background: var(--ok-bg); color: var(--ok); }
.cal__day--overdue { background: var(--overdue-bg); color: var(--overdue); }
.cal__day--due-soon { background: var(--due-soon-bg); color: var(--due-soon); }
.cal__day--info { background: var(--info-bg); color: var(--info); }
.cal__day--neutral { background: var(--accent-50); color: var(--accent-700); }
.cal__day--muted { background: var(--surface); color: var(--ink-3); }
```

- [ ] **Step 5: Implement `HousehelpCalendarPage.tsx`**

Create `apps/web/src/features/app/attendance/HousehelpCalendarPage.tsx`:

```tsx
import { useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { ChevronLeft, ChevronRight } from "lucide-react";
import type { AttendanceStatus } from "@household/shared";
import { dateInZone } from "@household/shared";
import { ApiError } from "../../../lib/api";
import { Alert } from "../../../components/Alert";
import { Button } from "../../../components/Button";
import { useActiveHousehold } from "../useActiveHousehold";
import { useHousehold } from "../members/useMembers";
import { useHousehelp, useSchedule } from "../househelps/useHousehelps";
import { AttendancePicker } from "./AttendancePicker";
import { toneOf } from "./statusTone";
import { useClearAttendance, useMonthAttendance, useSetAttendance } from "./useAttendance";

function messageFrom(err: unknown): string {
  return err instanceof ApiError ? err.message : "Something went wrong. Please try again.";
}

function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

/** 0=Mon … 6=Sun, so the grid's first column is always Monday. */
function firstWeekdayIndex(year: number, month: number): number {
  return (new Date(Date.UTC(year, month - 1, 1)).getUTCDay() + 6) % 7;
}

/** 1=Mon … 7=Sun, matching `attendance_schedules.weekdays`'s convention. */
function isoWeekdayOf(date: string): number {
  return ((new Date(`${date}T00:00:00Z`).getUTCDay() + 6) % 7) + 1;
}

function shiftMonth(month: string, delta: number): string {
  const [y, m] = month.split("-").map(Number);
  const total = (y! * 12 + (m! - 1)) + delta;
  return `${Math.floor(total / 12)}-${String((total % 12) + 1).padStart(2, "0")}`;
}

function monthLabel(month: string): string {
  const [y, m] = month.split("-").map(Number);
  return new Date(Date.UTC(y!, m! - 1, 1)).toLocaleDateString("en-IN", { month: "long", year: "numeric", timeZone: "UTC" });
}

export function HousehelpCalendarPage() {
  const { id } = useParams();
  const navigate = useNavigate();
  const { household: active } = useActiveHousehold();
  const householdId = active?.id;
  const householdQuery = useHousehold(householdId);
  const househelpQuery = useHousehelp(householdId, id);
  const scheduleQuery = useSchedule(householdId, id);
  const [month, setMonth] = useState(() => dateInZone(new Date(), active?.timezone ?? "Asia/Kolkata").slice(0, 7));
  const monthQuery = useMonthAttendance(householdId, id, month);
  const setAttendance = useSetAttendance(householdId ?? "");
  const clearAttendance = useClearAttendance(householdId ?? "");
  const canEditHistory = householdQuery.data?.permissions.includes("attendance.editHistory") ?? false;
  const canMarkToday = householdQuery.data?.permissions.includes("attendance.mark") ?? false;
  const [openDate, setOpenDate] = useState<string | null>(null);
  const [pageError, setPageError] = useState<string | null>(null);

  if (!householdId || !id || !househelpQuery.data) return null;

  const today = dateInZone(new Date(), active?.timezone ?? "Asia/Kolkata");
  const [year, m] = month.split("-").map(Number);
  const total = daysInMonth(year!, m!);
  const lead = firstWeekdayIndex(year!, m!);
  const byDate = new Map((monthQuery.data ?? []).map((r) => [r.date, r]));
  const scheduledWeekdays = new Set(scheduleQuery.data?.weekdays ?? []);

  function canEditDate(d: string): boolean {
    return d === today ? canMarkToday : canEditHistory;
  }

  function onPick(d: string, status: AttendanceStatus | null) {
    setOpenDate(null);
    if (status === null) clearAttendance.mutate({ househelpId: id!, date: d }, { onError: (err) => setPageError(messageFrom(err)) });
    else setAttendance.mutate({ househelpId: id!, body: { date: d, status } }, { onError: (err) => setPageError(messageFrom(err)) });
  }

  return (
    <>
      <header className="page-head"><h1 className="page-title">{househelpQuery.data.name}'s attendance</h1></header>
      {pageError && <Alert tone="error" title={pageError} />}

      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: "var(--space-4)" }}>
        <Button variant="ghost" icon={<ChevronLeft size={20} aria-hidden />} onClick={() => setMonth(shiftMonth(month, -1))}>Previous</Button>
        <strong>{monthLabel(month)}</strong>
        <Button variant="ghost" icon={<ChevronRight size={20} aria-hidden />} onClick={() => setMonth(shiftMonth(month, 1))}>Next</Button>
      </div>

      <div className="cal__grid">
        {Array.from({ length: lead }).map((_, i) => <div key={`lead-${i}`} />)}
        {Array.from({ length: total }, (_, i) => i + 1).map((day) => {
          const d = `${month}-${String(day).padStart(2, "0")}`;
          const record = byDate.get(d);
          const dim = !scheduledWeekdays.has(isoWeekdayOf(d));
          return (
            <button
              key={d}
              type="button"
              className={["cal__day", `cal__day--${toneOf(record?.status ?? null)}`, dim && "cal__day--dim"].filter(Boolean).join(" ")}
              disabled={!canEditDate(d)}
              onClick={() => setOpenDate(openDate === d ? null : d)}
            >
              {day}
            </button>
          );
        })}
      </div>

      {openDate && (
        <div style={{ marginTop: "var(--space-4)" }}>
          <AttendancePicker status={byDate.get(openDate)?.status ?? null} onSelect={(status) => onPick(openDate, status)} />
        </div>
      )}

      <div style={{ marginTop: "var(--space-6)" }}><Button variant="ghost" onClick={() => navigate(`/househelps/${id}`)}>Back to {househelpQuery.data.name}</Button></div>
    </>
  );
}
```

- [ ] **Step 6: Wire the route and a link from the detail page**

In `apps/web/src/App.tsx`: `./features/app/attendance/HousehelpCalendarPage` sorts (case-insensitive) right before `./features/app/attendance/TodayPage` added in Task 4 — add the import directly above it:

```tsx
import { HousehelpCalendarPage } from "./features/app/attendance/HousehelpCalendarPage";
import { TodayPage } from "./features/app/attendance/TodayPage";
```

Then add the route next to the existing `househelps/:id/schedule` route:

```tsx
        <Route path="househelps/:id/attendance" element={<HousehelpCalendarPage />} />
```

In `apps/web/src/features/app/househelps/HousehelpDetailPage.tsx`: add an "Attendance" action next to the existing "Set schedule" button. The current block reads:

```tsx
          <Button variant="secondary" block onClick={() => navigate(`/househelps/${id}/edit`)}>Edit details</Button>
          <Button variant="secondary" block onClick={() => navigate(`/househelps/${id}/schedule`)}>Set schedule</Button>
```

Add a line right after it:

```tsx
          <Button variant="secondary" block onClick={() => navigate(`/househelps/${id}/attendance`)}>View attendance</Button>
```

This new button is not gated on `canManage` differently from its neighbors — it stays inside the same `{canManage && (...)}` block those two buttons are already in, since viewing attendance from here is part of the same "manage this househelp" action group. (Anyone with just `attendance.view` and not `househelps.manage` can still reach the calendar directly via a URL, or once a future spec adds a viewer-facing entry point — out of scope here, matching the spec's scope cut.)

- [ ] **Step 7: Run the test to verify it passes**

Run: `npm run test --workspace @household/web -- HousehelpCalendarPage`
Expected: PASS — all three cases.

- [ ] **Step 8: Run the full web suite to check for regressions**

Run: `npm run test --workspace @household/web`
Expected: PASS.

- [ ] **Step 9: Run the full monorepo build and typecheck**

Run: `npm run build && npm run typecheck`
Expected: both PASS across `shared`, `api`, `web`.

- [ ] **Step 10: Commit**

```bash
git add apps/web/src/features/app/attendance apps/web/src/styles/components.css apps/web/src/App.tsx apps/web/src/features/app/househelps/HousehelpDetailPage.tsx
git commit -m "feat(web): per-househelp attendance calendar with month navigation"
```
