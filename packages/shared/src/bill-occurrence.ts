import { daysInMonth, parseDateParts } from "./checklist-frequency.js";
import type { BillDTO } from "./dto.js";
import { addDays } from "./time.js";

export class BillOccurrenceError extends Error {}

export type OccurrenceDueDateFields = Pick<BillDTO, "frequency" | "intervalCount" | "intervalUnit" | "firstDueDate">;

/**
 * Add `months` calendar months to `date` (YYYY-MM-DD), clamping the result's day-of-month to the
 * target month's actual length (e.g. Jan 31 + 1 month -> Feb 28/29, never Mar 3).
 * `months` is always >= 0 for this module's callers (sequence is a non-negative occurrence index),
 * but the modulo is written defensively so it stays correct if that ever changes.
 */
function addMonthsClamped(date: string, months: number): string {
  const { year, month, day } = parseDateParts(date);
  const totalMonths = year * 12 + (month - 1) + months;
  const targetYear = Math.floor(totalMonths / 12);
  const targetMonth = ((totalMonths % 12) + 12) % 12 + 1; // 1-based, always in [1, 12]
  const clampedDay = Math.min(day, daysInMonth(targetYear, targetMonth));
  return `${targetYear}-${String(targetMonth).padStart(2, "0")}-${String(clampedDay).padStart(2, "0")}`;
}

/**
 * Pure date-math: the due date of the `sequence`-th occurrence (0-indexed) of a recurring bill,
 * counting forward from `firstDueDate`. No DB access, no clock reads — callers resolve `sequence`
 * (e.g. "how many occurrences exist so far") separately.
 */
export function occurrenceDueDate(bill: OccurrenceDueDateFields, sequence: number): string {
  switch (bill.frequency) {
    case "ONE_TIME":
      if (sequence !== 0) throw new BillOccurrenceError("ONE_TIME bills have exactly one occurrence (sequence must be 0).");
      return bill.firstDueDate;
    case "WEEKLY":
      return addDays(bill.firstDueDate, sequence * 7);
    case "MONTHLY":
      return addMonthsClamped(bill.firstDueDate, sequence * 1);
    case "QUARTERLY":
      return addMonthsClamped(bill.firstDueDate, sequence * 3);
    case "HALF_YEARLY":
      return addMonthsClamped(bill.firstDueDate, sequence * 6);
    case "YEARLY":
      return addMonthsClamped(bill.firstDueDate, sequence * 12);
    case "CUSTOM": {
      switch (bill.intervalUnit) {
        case "day":
          return addDays(bill.firstDueDate, sequence * bill.intervalCount);
        case "week":
          return addDays(bill.firstDueDate, sequence * bill.intervalCount * 7);
        case "month":
          return addMonthsClamped(bill.firstDueDate, sequence * bill.intervalCount);
        default:
          throw new BillOccurrenceError(`CUSTOM bill is missing a valid intervalUnit: ${String(bill.intervalUnit)}`);
      }
    }
    default:
      throw new BillOccurrenceError(`Unknown bill frequency: ${String(bill.frequency)}`);
  }
}
