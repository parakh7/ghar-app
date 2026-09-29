import { and, desc, eq, gte, isNull, lte, or } from "drizzle-orm";
import type { ScheduleDTO, UpdateScheduleInput } from "@household/shared";
import { addDays, dateInZone } from "@household/shared";
import { attendanceSchedules } from "../db/schema.js";
import { recordAudit } from "./audit.service.js";
import type { Deps } from "./deps.js";
import type { Membership } from "./household.service.js";

/** Postgres `time` columns round-trip as "HH:MM:SS" — trim to "HH:MM" to match the API contract. */
function toHHMM(t: string | null): string | null {
  return t === null ? null : t.slice(0, 5);
}

function toScheduleDTO(row: { id: string; weekdays: number[]; startTime: string | null; endTime: string | null; effectiveFrom: string }): ScheduleDTO {
  return { id: row.id, weekdays: row.weekdays, startTime: toHHMM(row.startTime), endTime: toHHMM(row.endTime), effectiveFrom: row.effectiveFrom };
}

function currentlyEffective(householdId: string, househelpId: string, today: string) {
  return and(
    eq(attendanceSchedules.householdId, householdId),
    eq(attendanceSchedules.househelpId, househelpId),
    lte(attendanceSchedules.effectiveFrom, today),
    or(isNull(attendanceSchedules.effectiveTo), gte(attendanceSchedules.effectiveTo, today)),
  );
}

export async function getCurrentSchedule(deps: Deps, membership: Membership, househelpId: string): Promise<ScheduleDTO | null> {
  const today = dateInZone(deps.clock.now(), membership.timezone);
  const [row] = await deps.db.select().from(attendanceSchedules)
    .where(currentlyEffective(membership.householdId, househelpId, today))
    .orderBy(desc(attendanceSchedules.effectiveFrom))
    .limit(1);
  return row ? toScheduleDTO(row) : null;
}

export async function putSchedule(deps: Deps, actorUserId: string, membership: Membership, househelpId: string, input: UpdateScheduleInput, ip?: string): Promise<ScheduleDTO> {
  const today = dateInZone(deps.clock.now(), membership.timezone);
  const yesterday = addDays(today, -1);
  const row = await deps.db.transaction(async (tx) => {
    const [current] = await tx.select({ id: attendanceSchedules.id }).from(attendanceSchedules)
      .where(currentlyEffective(membership.householdId, househelpId, today))
      .for("update");
    if (current) {
      await tx.update(attendanceSchedules).set({ effectiveTo: yesterday }).where(eq(attendanceSchedules.id, current.id));
    }
    const [inserted] = await tx.insert(attendanceSchedules).values({
      householdId: membership.householdId, househelpId, weekdays: input.weekdays,
      startTime: input.startTime ?? null, endTime: input.endTime ?? null, effectiveFrom: today,
    }).returning();
    await recordAudit(tx, {
      householdId: membership.householdId, actorUserId, action: "schedule.updated", entityType: "attendance_schedule", entityId: inserted!.id,
      newValue: { weekdays: input.weekdays, startTime: input.startTime ?? null, endTime: input.endTime ?? null }, ipAddress: ip ?? null,
    });
    return inserted!;
  });
  return toScheduleDTO(row);
}
