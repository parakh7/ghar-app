import { and, asc, desc, eq, gte, inArray, isNull, lt, lte, or } from "drizzle-orm";
import type {
  AdjustmentDTO, GenerateSettlementInput, Permission, SalaryPaymentDTO, SettlementDTO, SettlementStatus,
} from "@household/shared";
import { addDays, dateInZone, prorate, sumPaise } from "@household/shared";
import { attendanceRecords, attendanceSchedules, househelps, salaryAdjustments, salaryPayments, salarySettlements } from "../db/schema.js";
import type { DbOrTx } from "../db/client.js";
import { Errors } from "../lib/errors.js";
import { recordAudit } from "./audit.service.js";
import type { Deps } from "./deps.js";
import type { Membership } from "./household.service.js";

type AuthedMembership = Membership & { permissions: Set<Permission> };
type SettlementRow = typeof salarySettlements.$inferSelect;
type AdjustmentRow = typeof salaryAdjustments.$inferSelect;
type PaymentRow = typeof salaryPayments.$inferSelect;
type HousehelpRow = typeof househelps.$inferSelect;

/** 1=Mon … 7=Sun, matching `attendance_schedules.weekdays`'s convention — same formula as `attendance.service.ts`. */
function isoWeekdayOf(date: string): number {
  return ((new Date(`${date}T00:00:00Z`).getUTCDay() + 6) % 7) + 1;
}

/** "YYYY-MM" -> "YYYY-MM" of the next month. */
function nextMonth(month: string): string {
  const [y, m] = month.split("-").map(Number);
  return m === 12 ? `${y! + 1}-01` : `${y}-${String(m! + 1).padStart(2, "0")}`;
}

/** Every calendar date "YYYY-MM-DD" in `periodMonth` ("YYYY-MM-01"). */
function daysInMonth(periodMonth: string): string[] {
  const ym = periodMonth.slice(0, 7);
  const start = `${ym}-01`;
  const endExclusive = `${nextMonth(ym)}-01`;
  const days: string[] = [];
  for (let d = start; d < endExclusive; d = addDays(d, 1)) days.push(d);
  return days;
}

/** Last calendar day ("YYYY-MM-DD") of `periodMonth`. */
function lastDayOfMonth(periodMonth: string): string {
  const ym = periodMonth.slice(0, 7);
  return addDays(`${nextMonth(ym)}-01`, -1);
}

/**
 * Due date for a settlement: `salaryDueDay` of the month immediately AFTER `periodMonth`
 * (salary for a month is paid early the following month), clamped to that month's length —
 * mirrors the "months shorter than this due on their last day" comment on `households.salaryDueDay`.
 * Not spelled out verbatim in the plan; this is the calc's own reasoned-through interpretation.
 */
function computeDueDate(periodMonth: string, salaryDueDay: number): string {
  const ym = periodMonth.slice(0, 7);
  const dueYm = nextMonth(ym);
  const [y, m] = dueYm.split("-").map(Number);
  const daysInDueMonth = new Date(Date.UTC(y!, m!, 0)).getUTCDate();
  const day = Math.min(salaryDueDay, daysInDueMonth);
  return `${dueYm}-${String(day).padStart(2, "0")}`;
}

export async function requireHousehelpInHousehold(db: DbOrTx, householdId: string, househelpId: string): Promise<HousehelpRow> {
  const [row] = await db.select().from(househelps).where(and(eq(househelps.householdId, householdId), eq(househelps.id, househelpId)));
  if (!row) throw Errors.notFound("Househelp");
  return row;
}

type MonthAttendanceAgg = {
  workingDays: number; presentDays: number; halfDays: number; absentDays: number; leaveDays: number; holidayDays: number;
  unmarkedDays: number;
};

/**
 * Whole-month extension of `attendance.service.ts`'s `getToday` schedule join and
 * `getMonthAttendance`'s date-range query: counts `workingDays` across every day of
 * `periodMonth`, then buckets each working day's attendance record by status.
 */
async function aggregateMonth(db: DbOrTx, householdId: string, househelpId: string, periodMonth: string): Promise<MonthAttendanceAgg> {
  const ym = periodMonth.slice(0, 7);
  const monthStart = `${ym}-01`;
  const monthEndExclusive = `${nextMonth(ym)}-01`;
  const lastDay = lastDayOfMonth(periodMonth);

  const schedules = await db.select({ weekdays: attendanceSchedules.weekdays, effectiveFrom: attendanceSchedules.effectiveFrom, effectiveTo: attendanceSchedules.effectiveTo })
    .from(attendanceSchedules)
    .where(and(
      eq(attendanceSchedules.householdId, householdId),
      eq(attendanceSchedules.househelpId, househelpId),
      lte(attendanceSchedules.effectiveFrom, lastDay),
      or(isNull(attendanceSchedules.effectiveTo), gte(attendanceSchedules.effectiveTo, monthStart)),
    ));

  const workingDaySet = new Set<string>();
  for (const day of daysInMonth(periodMonth)) {
    const isoWeekday = isoWeekdayOf(day);
    const applicable = schedules.some((s) => s.effectiveFrom <= day && (s.effectiveTo === null || s.effectiveTo >= day) && s.weekdays.includes(isoWeekday));
    if (applicable) workingDaySet.add(day);
  }

  const records = await db.select({ date: attendanceRecords.date, status: attendanceRecords.status })
    .from(attendanceRecords)
    .where(and(eq(attendanceRecords.householdId, householdId), eq(attendanceRecords.househelpId, househelpId), gte(attendanceRecords.date, monthStart), lt(attendanceRecords.date, monthEndExclusive)));
  const statusByDate = new Map(records.map((r) => [r.date, r.status]));

  let presentDays = 0, halfDays = 0, absentDays = 0, leaveDays = 0, holidayDays = 0, unmarkedDays = 0;
  for (const day of workingDaySet) {
    const status = statusByDate.get(day);
    if (!status) { unmarkedDays += 1; continue; }
    switch (status) {
      case "PRESENT": presentDays += 1; break;
      case "HALF_DAY": halfDays += 1; break;
      case "ABSENT": absentDays += 1; break;
      case "LEAVE": leaveDays += 1; break;
      case "HOLIDAY": holidayDays += 1; break;
    }
  }

  return { workingDays: workingDaySet.size, presentDays, halfDays, absentDays, leaveDays, holidayDays, unmarkedDays };
}

type BasePay = { basePaise: number; absenceDeductionPaise: number };

/** The three `salaryMode` semantics — see this plan's Global Constraints; no other doc defines this. */
function computeBasePay(help: HousehelpRow, agg: MonthAttendanceAgg): BasePay {
  switch (help.salaryMode) {
    case "FIXED_MONTHLY": {
      if (help.monthlySalaryPaise == null) throw Errors.validation({ monthlySalaryPaise: "This househelp has no monthly salary set." });
      return { basePaise: help.monthlySalaryPaise, absenceDeductionPaise: 0 };
    }
    case "ATTENDANCE_BASED": {
      if (help.monthlySalaryPaise == null) throw Errors.validation({ monthlySalaryPaise: "This househelp has no monthly salary set." });
      const base = help.monthlySalaryPaise;
      const absenceDeductionPaise = agg.workingDays > 0
        ? sumPaise([prorate(base, agg.absentDays, agg.workingDays), prorate(base, agg.halfDays, agg.workingDays * 2)])
        : 0;
      return { basePaise: base, absenceDeductionPaise };
    }
    case "DAILY_RATE": {
      if (help.dailyRatePaise == null) throw Errors.validation({ dailyRatePaise: "This househelp has no daily rate set." });
      const halfRate = help.halfDayRatePaise ?? prorate(help.dailyRatePaise, 1, 2);
      // HOLIDAY and LEAVE are paid, per the locked decision ("ABSENT reduces pay; LEAVE and HOLIDAY
      // do not") — under DAILY_RATE (which has no monthly figure to simply not-deduct from) that
      // means both pay the full daily rate, same as a present day.
      const fullDays = agg.presentDays + agg.holidayDays + agg.leaveDays;
      const basePaise = sumPaise([help.dailyRatePaise * fullDays, halfRate * agg.halfDays]);
      return { basePaise, absenceDeductionPaise: 0 };
    }
  }
}

type AdjustmentSums = { additionsPaise: number; deductionsPaise: number; advancePaise: number; ids: string[] };

/**
 * Non-voided adjustments for `(householdId, househelpId, periodMonth)` that are either still
 * unattached (`settlementId IS NULL` — newly created since the last generate) OR already attached
 * to `existingSettlementId` (from a prior generate of this same settlement) — re-summing both is
 * what makes regeneration safe: a plain `settlementId IS NULL` filter would, on the second generate,
 * see zero rows for everything attached on the first pass and silently zero out real totals.
 * Matches by the adjustment's `periodMonth` falling anywhere within the target calendar month
 * (not exact equality) since Task 3 doesn't guarantee that date is normalized to the 1st.
 * `ADJUSTMENT` behaves exactly like `BONUS`/`OVERTIME` — a straight addition; `amountPaise` is
 * always non-negative (enforced by `createAdjustmentSchema`), so there is no signed/subtract path.
 */
export async function sumUnattachedAdjustments(
  db: DbOrTx, householdId: string, househelpId: string, periodMonth: string, existingSettlementId?: string,
): Promise<AdjustmentSums> {
  const monthStart = periodMonth;
  const monthEnd = lastDayOfMonth(periodMonth);
  const settlementScope = existingSettlementId
    ? or(isNull(salaryAdjustments.settlementId), eq(salaryAdjustments.settlementId, existingSettlementId))
    : isNull(salaryAdjustments.settlementId);

  const rows = await db.select({ id: salaryAdjustments.id, type: salaryAdjustments.type, amountPaise: salaryAdjustments.amountPaise })
    .from(salaryAdjustments)
    .where(and(
      eq(salaryAdjustments.householdId, householdId), eq(salaryAdjustments.househelpId, househelpId),
      gte(salaryAdjustments.periodMonth, monthStart), lte(salaryAdjustments.periodMonth, monthEnd),
      isNull(salaryAdjustments.voidedAt), settlementScope,
    ));

  let additionsPaise = 0, deductionsPaise = 0, advancePaise = 0;
  for (const r of rows) {
    switch (r.type) {
      case "BONUS":
      case "OVERTIME":
      case "ADJUSTMENT":
        additionsPaise = sumPaise([additionsPaise, r.amountPaise]);
        break;
      case "DEDUCTION":
        deductionsPaise = sumPaise([deductionsPaise, r.amountPaise]);
        break;
      case "ADVANCE":
        advancePaise = sumPaise([advancePaise, r.amountPaise]);
        break;
    }
  }
  return { additionsPaise, deductionsPaise, advancePaise, ids: rows.map((r) => r.id) };
}

/**
 * `salary_settlements` has no `holiday_days` column (the table is locked/pre-designed, Task 2 doesn't
 * migrate it) — `holidayDays` is carried in `calcSnapshot` instead (already stored there for exactly
 * this reason) and surfaced onto the DTO from there so Task 4's UI can reconcile `workingDays` against
 * the visible day-count fields.
 */
function holidayDaysOf(row: SettlementRow): number {
  const snapshot = row.calcSnapshot as { holidayDays?: number } | null;
  return snapshot?.holidayDays ?? 0;
}

function toSettlementDTO(row: SettlementRow): SettlementDTO {
  return {
    id: row.id, househelpId: row.househelpId, periodMonth: row.periodMonth, dueDate: row.dueDate,
    basePaise: row.basePaise, workingDays: row.workingDays, presentDays: row.presentDays, halfDays: row.halfDays,
    absentDays: row.absentDays, leaveDays: row.leaveDays, holidayDays: holidayDaysOf(row), absenceDeductionPaise: row.absenceDeductionPaise,
    additionsPaise: row.additionsPaise, deductionsPaise: row.deductionsPaise, advancePaise: row.advancePaise,
    netPayablePaise: row.netPayablePaise, amountPaidPaise: row.amountPaidPaise, status: row.status,
    note: row.note, paidAt: row.paidAt ? row.paidAt.toISOString() : null,
  };
}

export function toAdjustmentDTO(row: AdjustmentRow): AdjustmentDTO {
  return {
    id: row.id, househelpId: row.househelpId, settlementId: row.settlementId, periodMonth: row.periodMonth,
    type: row.type, amountPaise: row.amountPaise, reason: row.reason,
    voidedAt: row.voidedAt ? row.voidedAt.toISOString() : null, createdAt: row.createdAt.toISOString(),
  };
}

export function toPaymentDTO(row: PaymentRow): SalaryPaymentDTO {
  return {
    id: row.id, settlementId: row.settlementId, amountPaise: row.amountPaise, paidOn: row.paidOn, method: row.method,
    reference: row.reference, notes: row.notes, voidedAt: row.voidedAt ? row.voidedAt.toISOString() : null, createdAt: row.createdAt.toISOString(),
  };
}

/**
 * Creates a settlement for `(househelpId, input.periodMonth)` if none exists, or regenerates one
 * in place while it's still `PENDING` (recomputes everything from current attendance/adjustments).
 * Throws once any payment has moved the settlement past `PENDING` — the locked-decision rule.
 */
export async function generateSettlement(
  deps: Deps, actorUserId: string, membership: AuthedMembership, househelpId: string, input: GenerateSettlementInput, ip?: string,
): Promise<SettlementDTO> {
  const { periodMonth } = input;
  const today = dateInZone(deps.clock.now(), membership.timezone);
  if (lastDayOfMonth(periodMonth) >= today) {
    throw Errors.validation({ periodMonth: "Settlements can only be generated for a month that has fully elapsed." });
  }

  const help = await requireHousehelpInHousehold(deps.db, membership.householdId, househelpId);
  const agg = await aggregateMonth(deps.db, membership.householdId, househelpId, periodMonth);
  if (agg.workingDays === 0) {
    throw Errors.validation({ periodMonth: "This househelp has no active attendance schedule covering this month." });
  }
  if (agg.unmarkedDays > 0) {
    throw Errors.validation({ attendance: `${agg.unmarkedDays} scheduled day(s) this month have no attendance record yet.` });
  }

  const { basePaise, absenceDeductionPaise } = computeBasePay(help, agg);
  const dueDate = computeDueDate(periodMonth, help.salaryDueDay);

  const row = await deps.db.transaction(async (tx) => {
    const [existing] = await tx.select().from(salarySettlements)
      .where(and(eq(salarySettlements.householdId, membership.householdId), eq(salarySettlements.househelpId, househelpId), eq(salarySettlements.periodMonth, periodMonth)))
      .for("update");
    if (existing && existing.status !== "PENDING") {
      throw Errors.validation({ periodMonth: "This settlement already has payments recorded and can no longer be regenerated." });
    }

    const { additionsPaise, deductionsPaise, advancePaise, ids } = await sumUnattachedAdjustments(tx, membership.householdId, househelpId, periodMonth, existing?.id);
    const netPayablePaise = sumPaise([basePaise, -absenceDeductionPaise, additionsPaise, -deductionsPaise, -advancePaise]);
    const calcSnapshot = {
      salaryMode: help.salaryMode, monthlySalaryPaise: help.monthlySalaryPaise, dailyRatePaise: help.dailyRatePaise, halfDayRatePaise: help.halfDayRatePaise,
      workingDays: agg.workingDays, presentDays: agg.presentDays, halfDays: agg.halfDays, absentDays: agg.absentDays, leaveDays: agg.leaveDays, holidayDays: agg.holidayDays,
      generatedAt: deps.clock.now().toISOString(),
    };

    const values = {
      householdId: membership.householdId, househelpId, periodMonth, dueDate, basePaise,
      workingDays: agg.workingDays, presentDays: agg.presentDays, halfDays: agg.halfDays, absentDays: agg.absentDays, leaveDays: agg.leaveDays,
      absenceDeductionPaise, additionsPaise, deductionsPaise, advancePaise, netPayablePaise, calcSnapshot,
    };

    let result: SettlementRow;
    if (existing) {
      const [updated] = await tx.update(salarySettlements).set(values).where(eq(salarySettlements.id, existing.id)).returning();
      result = updated!;
      await recordAudit(tx, {
        householdId: membership.householdId, actorUserId, action: "settlement.regenerated", entityType: "salary_settlement", entityId: result.id,
        oldValue: existing, newValue: values, ipAddress: ip ?? null,
      });
    } else {
      const [inserted] = await tx.insert(salarySettlements).values({ ...values, status: "PENDING" }).returning();
      result = inserted!;
      await recordAudit(tx, {
        householdId: membership.householdId, actorUserId, action: "settlement.generated", entityType: "salary_settlement", entityId: result.id,
        newValue: values, ipAddress: ip ?? null,
      });
    }

    if (ids.length > 0) {
      await tx.update(salaryAdjustments).set({ settlementId: result.id }).where(inArray(salaryAdjustments.id, ids));
    }

    return result;
  });

  return toSettlementDTO(row);
}

export async function listSettlements(
  deps: Deps, membership: Membership, househelpId?: string, filters?: { status?: SettlementStatus },
): Promise<SettlementDTO[]> {
  if (househelpId) await requireHousehelpInHousehold(deps.db, membership.householdId, househelpId);
  const conditions = [eq(salarySettlements.householdId, membership.householdId)];
  if (househelpId) conditions.push(eq(salarySettlements.househelpId, househelpId));
  if (filters?.status) conditions.push(eq(salarySettlements.status, filters.status));
  const rows = await deps.db.select().from(salarySettlements).where(and(...conditions)).orderBy(desc(salarySettlements.periodMonth));
  return rows.map(toSettlementDTO);
}

export async function getSettlement(
  deps: Deps, membership: Membership, settlementId: string,
): Promise<SettlementDTO & { adjustments: AdjustmentDTO[]; payments: SalaryPaymentDTO[] }> {
  const [row] = await deps.db.select().from(salarySettlements)
    .where(and(eq(salarySettlements.householdId, membership.householdId), eq(salarySettlements.id, settlementId)));
  if (!row) throw Errors.notFound("Settlement");

  const adjustments = await deps.db.select().from(salaryAdjustments)
    .where(and(eq(salaryAdjustments.householdId, membership.householdId), eq(salaryAdjustments.settlementId, settlementId)))
    .orderBy(asc(salaryAdjustments.createdAt));
  const payments = await deps.db.select().from(salaryPayments)
    .where(and(eq(salaryPayments.householdId, membership.householdId), eq(salaryPayments.settlementId, settlementId)))
    .orderBy(asc(salaryPayments.paidOn));

  return { ...toSettlementDTO(row), adjustments: adjustments.map(toAdjustmentDTO), payments: payments.map(toPaymentDTO) };
}
