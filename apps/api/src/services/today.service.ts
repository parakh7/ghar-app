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

/** Sections are independent of each other — fetched concurrently so total latency is the slowest section, not their sum. */
export async function getTodayDashboard(deps: Deps, membership: AuthedMembership): Promise<TodayDashboardDTO> {
  const today = dateInZone(deps.clock.now(), membership.timezone);
  const dashboard: TodayDashboardDTO = {};

  const [attendance, checklist, bills, salary] = await Promise.all([
    membership.permissions.has("attendance.view") ? getAttendanceSection(deps, membership) : undefined,
    membership.permissions.has("checklists.view") ? getChecklistSection(deps, membership) : undefined,
    membership.permissions.has("bills.view") ? getBillsSection(deps, membership.householdId, today) : undefined,
    membership.permissions.has("salaries.view") ? getSalarySection(deps, membership.householdId) : undefined,
  ]);
  if (attendance) dashboard.attendance = attendance;
  if (checklist) dashboard.checklist = checklist;
  if (bills) dashboard.bills = bills;
  if (salary) dashboard.salary = salary;

  return dashboard;
}
