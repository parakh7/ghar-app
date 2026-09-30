import { and, asc, eq, gte, isNull, lt, lte, or } from "drizzle-orm";
import type { AttendanceRecordDTO, AttendanceStatus, MarkAttendanceInput, MarkHolidayResultDTO, Permission, TodayAttendanceDTO } from "@household/shared";
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
