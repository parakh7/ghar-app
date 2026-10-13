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
