import { describe, expect, it } from "vitest";
import type { AttendanceRecordDTO } from "@household/shared";
import { summarizeMonth } from "./summarize";

const WEEKDAYS = [1, 2, 3, 4, 5]; // Mon–Fri

function rec(date: string, status: AttendanceRecordDTO["status"]): AttendanceRecordDTO {
  return { date, status, note: null };
}

describe("summarizeMonth", () => {
  it("counts every scheduled weekday in a full past month, with unmarked days as not-yet-marked", () => {
    // August 2026 has 21 weekdays (Mon–Fri) total; "today" is well past the month, so all 21 count.
    const records = [
      rec("2026-08-03", "PRESENT"),
      rec("2026-08-04", "ABSENT"),
      rec("2026-08-05", "HALF_DAY"),
      rec("2026-08-06", "LEAVE"),
    ];
    const summary = summarizeMonth(records, WEEKDAYS, "2026-08", "2026-09-29");
    expect(summary).toEqual({
      countedDays: 21, present: 1, absent: 1, halfDay: 1, leave: 1, holiday: 0, notYetMarked: 17,
      rate: 1.5 / 21,
    });
  });

  it("stops counting at today for the current (in-progress) month, not the whole month", () => {
    // September 2026's 1st–10th has 8 weekdays (Sept 5–6 is a weekend); "today" is the 10th.
    const records = [rec("2026-09-01", "PRESENT")];
    const summary = summarizeMonth(records, WEEKDAYS, "2026-09", "2026-09-10");
    expect(summary).toEqual({
      countedDays: 8, present: 1, absent: 0, halfDay: 0, leave: 0, holiday: 0, notYetMarked: 7,
      rate: 1 / 8,
    });
  });

  it("excludes holidays from both counted days and the rate numerator", () => {
    // Same August weekdays as the first test, but one is a declared holiday.
    const records = [
      rec("2026-08-03", "PRESENT"),
      rec("2026-08-04", "HOLIDAY"),
      rec("2026-08-05", "ABSENT"),
    ];
    const summary = summarizeMonth(records, WEEKDAYS, "2026-08", "2026-09-29");
    expect(summary).toEqual({
      countedDays: 20, present: 1, absent: 1, halfDay: 0, leave: 0, holiday: 1, notYetMarked: 18,
      rate: 1 / 20,
    });
  });

  it("returns a null rate when no scheduled day in the month has occurred yet", () => {
    // October 2026 is entirely after "today" of 2026-09-29.
    const summary = summarizeMonth([], WEEKDAYS, "2026-10", "2026-09-29");
    expect(summary).toEqual({ countedDays: 0, present: 0, absent: 0, halfDay: 0, leave: 0, holiday: 0, notYetMarked: 0, rate: null });
  });

  it("weights a half-day as 0.5 present, not 0 and not 1", () => {
    // Sept 1–4, 2026 are Tue/Wed/Thu/Fri — 4 scheduled weekdays, no weekend in between.
    const records = [
      rec("2026-09-01", "PRESENT"),
      rec("2026-09-02", "HALF_DAY"),
      rec("2026-09-03", "HALF_DAY"),
      rec("2026-09-04", "ABSENT"),
    ];
    const summary = summarizeMonth(records, WEEKDAYS, "2026-09", "2026-09-04");
    expect(summary.countedDays).toBe(4);
    expect(summary.rate).toBe(0.5);
  });
});
