import type { AttendanceRecordDTO, AttendanceStatus } from "@household/shared";

export type AttendanceSummary = {
  countedDays: number;
  present: number; absent: number; halfDay: number; leave: number; holiday: number;
  notYetMarked: number;
  /** `null` when `countedDays === 0` — render as "—", never "0%"/"NaN". */
  rate: number | null;
};

function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

/** 1=Mon … 7=Sun, matching `attendance_schedules.weekdays`'s convention. */
function isoWeekdayOf(date: string): number {
  return ((new Date(`${date}T00:00:00Z`).getUTCDay() + 6) % 7) + 1;
}

/**
 * Summarizes one househelp's attendance for `month`, counting only days that both (a) fall on a
 * scheduled weekday and (b) have already occurred (up to `today`, inclusive — the whole month if
 * `month` is entirely in the past, zero days if `month` is entirely in the future). A day marked
 * HOLIDAY is excluded from `countedDays` and the rate entirely — it was never "expected attendance".
 * A scheduled, non-holiday day with no record counts toward `countedDays` as `notYetMarked`.
 */
export function summarizeMonth(records: AttendanceRecordDTO[], scheduledWeekdays: number[], month: string, today: string): AttendanceSummary {
  const scheduled = new Set(scheduledWeekdays);
  const byDate = new Map(records.map((r) => [r.date, r.status]));
  const todayMonth = today.slice(0, 7);
  const [year, m] = month.split("-").map(Number);
  const daysTotal = daysInMonth(year!, m!);
  const lastDay = month < todayMonth ? daysTotal : month > todayMonth ? 0 : Number(today.slice(8, 10));

  const counts: Record<AttendanceStatus, number> = { PRESENT: 0, ABSENT: 0, HALF_DAY: 0, LEAVE: 0, HOLIDAY: 0 };
  let countedDays = 0;
  let notYetMarked = 0;

  for (let day = 1; day <= lastDay; day++) {
    const d = `${month}-${String(day).padStart(2, "0")}`;
    if (!scheduled.has(isoWeekdayOf(d))) continue;
    const status = byDate.get(d);
    if (status === "HOLIDAY") { counts.HOLIDAY++; continue; }
    countedDays++;
    if (status === undefined) { notYetMarked++; continue; }
    counts[status]++;
  }

  const rate = countedDays === 0 ? null : (counts.PRESENT + 0.5 * counts.HALF_DAY) / countedDays;
  return {
    countedDays, present: counts.PRESENT, absent: counts.ABSENT, halfDay: counts.HALF_DAY,
    leave: counts.LEAVE, holiday: counts.HOLIDAY, notYetMarked, rate,
  };
}
