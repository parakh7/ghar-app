import type { ChecklistTaskDTO } from "./dto.js";

/** ISO weekday, 1=Mon...7=Sun. Same formula as attendance.service.ts's isoWeekdayOf — kept here too since this file can't import from apps/api. */
function isoWeekdayOf(date: string): number {
  return ((new Date(`${date}T00:00:00Z`).getUTCDay() + 6) % 7) + 1;
}

/** Exported so other date-math modules in this package (e.g. bill-occurrence.ts) don't redefine it. */
export function daysInMonth(year: number, month: number): number {
  // Date.UTC's day-0 trick: month (1-based) as the 0-based monthIndex rolls back to the last day of the prior (target) month.
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

/** Exported so other date-math modules in this package (e.g. bill-occurrence.ts) don't redefine it. */
export function parseDateParts(date: string): { year: number; month: number; day: number } {
  const parts = date.split("-");
  return { year: Number(parts[0]), month: Number(parts[1]), day: Number(parts[2]) };
}

export type ChecklistTaskDueFields = Pick<
  ChecklistTaskDTO,
  "frequency" | "weekdays" | "dayOfMonth" | "specificDate" | "intervalDays" | "anchorDate"
>;

/** Pure predicate: is this task due on the given date (YYYY-MM-DD)? */
export function isTaskDueOn(task: ChecklistTaskDueFields, date: string): boolean {
  switch (task.frequency) {
    case "DAILY":
      return true;
    case "WEEKDAYS":
      return isoWeekdayOf(date) <= 5;
    case "WEEKLY":
      return (task.weekdays ?? []).includes(isoWeekdayOf(date));
    case "MONTHLY": {
      if (task.dayOfMonth == null) return false;
      const { year, month, day } = parseDateParts(date);
      const clampedDay = Math.min(task.dayOfMonth, daysInMonth(year, month));
      return day === clampedDay;
    }
    case "SPECIFIC_DATE":
      return task.specificDate != null && date === task.specificDate;
    case "CUSTOM": {
      if (task.anchorDate == null || task.intervalDays == null || task.intervalDays <= 0) return false;
      if (date < task.anchorDate) return false;
      const msPerDay = 24 * 60 * 60 * 1000;
      const anchorMs = new Date(`${task.anchorDate}T00:00:00Z`).getTime();
      const dateMs = new Date(`${date}T00:00:00Z`).getTime();
      const diffDays = Math.round((dateMs - anchorMs) / msPerDay);
      return diffDays % task.intervalDays === 0;
    }
    default:
      return false;
  }
}
