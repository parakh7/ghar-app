import { describe, expect, it } from "vitest";
import { BillOccurrenceError, occurrenceDueDate, type OccurrenceDueDateFields } from "./bill-occurrence.js";

const base: OccurrenceDueDateFields = {
  frequency: "ONE_TIME",
  intervalCount: 1,
  intervalUnit: null,
  firstDueDate: "2024-01-01",
};

describe("occurrenceDueDate", () => {
  describe("ONE_TIME", () => {
    it("sequence 0 returns firstDueDate unchanged", () => {
      const bill: OccurrenceDueDateFields = { ...base, frequency: "ONE_TIME", firstDueDate: "2024-03-17" };
      expect(occurrenceDueDate(bill, 0)).toBe("2024-03-17");
    });

    it("sequence 1 throws (programmer error - ONE_TIME has only one occurrence)", () => {
      const bill: OccurrenceDueDateFields = { ...base, frequency: "ONE_TIME" };
      expect(() => occurrenceDueDate(bill, 1)).toThrow(BillOccurrenceError);
    });
  });

  describe("WEEKLY", () => {
    const bill: OccurrenceDueDateFields = { ...base, frequency: "WEEKLY", firstDueDate: "2024-01-01" };

    it("steps forward 7 days per sequence", () => {
      expect(occurrenceDueDate(bill, 0)).toBe("2024-01-01");
      expect(occurrenceDueDate(bill, 1)).toBe("2024-01-08");
      expect(occurrenceDueDate(bill, 2)).toBe("2024-01-15");
    });

    it("crosses a month boundary correctly", () => {
      const janEnd: OccurrenceDueDateFields = { ...base, frequency: "WEEKLY", firstDueDate: "2024-01-29" };
      expect(occurrenceDueDate(janEnd, 1)).toBe("2024-02-05");
    });
  });

  describe("MONTHLY", () => {
    it("clamps a day-31 anchor to Feb 29 in a leap year", () => {
      const bill: OccurrenceDueDateFields = { ...base, frequency: "MONTHLY", firstDueDate: "2024-01-31" };
      expect(occurrenceDueDate(bill, 1)).toBe("2024-02-29");
    });

    it("clamps a day-31 anchor to Feb 28 in a non-leap year", () => {
      const bill: OccurrenceDueDateFields = { ...base, frequency: "MONTHLY", firstDueDate: "2023-01-31" };
      expect(occurrenceDueDate(bill, 1)).toBe("2023-02-28");
    });

    it("rolls back to the 31st once the target month is long enough again", () => {
      const bill: OccurrenceDueDateFields = { ...base, frequency: "MONTHLY", firstDueDate: "2024-01-31" };
      expect(occurrenceDueDate(bill, 2)).toBe("2024-03-31"); // March has 31 days
    });

    it("clamps a day-31 anchor to the 30th in a 30-day month", () => {
      const bill: OccurrenceDueDateFields = { ...base, frequency: "MONTHLY", firstDueDate: "2024-01-31" };
      expect(occurrenceDueDate(bill, 3)).toBe("2024-04-30"); // April has 30 days
    });

    it("crosses a December -> January year boundary, still clamped", () => {
      const bill: OccurrenceDueDateFields = { ...base, frequency: "MONTHLY", firstDueDate: "2023-12-31" };
      expect(occurrenceDueDate(bill, 1)).toBe("2024-01-31");
    });

    it("keeps a Feb-29 anchor's day-of-month intact stepping into a 31-day March", () => {
      const bill: OccurrenceDueDateFields = { ...base, frequency: "MONTHLY", firstDueDate: "2024-02-29" };
      expect(occurrenceDueDate(bill, 1)).toBe("2024-03-29"); // no truncation - March has 31 days
    });
  });

  describe("QUARTERLY", () => {
    it("clamps across a year-rollover quarter (Nov 30 + 3mo -> Feb 28)", () => {
      const bill: OccurrenceDueDateFields = { ...base, frequency: "QUARTERLY", firstDueDate: "2024-11-30" };
      expect(occurrenceDueDate(bill, 1)).toBe("2025-02-28");
    });

    it("steps 3 months at a time without clamping", () => {
      const bill: OccurrenceDueDateFields = { ...base, frequency: "QUARTERLY", firstDueDate: "2024-01-15" };
      expect(occurrenceDueDate(bill, 2)).toBe("2024-07-15");
    });
  });

  describe("HALF_YEARLY", () => {
    it("clamps 6 months out (Aug 31 -> Feb 28/29)", () => {
      const bill: OccurrenceDueDateFields = { ...base, frequency: "HALF_YEARLY", firstDueDate: "2024-08-31" };
      expect(occurrenceDueDate(bill, 1)).toBe("2025-02-28");
    });

    it("crosses a year boundary (Sep 15 + 6mo -> Mar 15 next year)", () => {
      const bill: OccurrenceDueDateFields = { ...base, frequency: "HALF_YEARLY", firstDueDate: "2024-09-15" };
      expect(occurrenceDueDate(bill, 1)).toBe("2025-03-15");
    });
  });

  describe("YEARLY", () => {
    it("clamps a leap-day anchor (Feb 29) to Feb 28 the following year", () => {
      const bill: OccurrenceDueDateFields = { ...base, frequency: "YEARLY", firstDueDate: "2024-02-29" };
      expect(occurrenceDueDate(bill, 1)).toBe("2025-02-28");
    });

    it("steps a December anchor forward a year, still December", () => {
      const bill: OccurrenceDueDateFields = { ...base, frequency: "YEARLY", firstDueDate: "2023-12-15" };
      expect(occurrenceDueDate(bill, 1)).toBe("2024-12-15");
    });

    it("steps a December anchor forward several years (multi-year rollover)", () => {
      const bill: OccurrenceDueDateFields = { ...base, frequency: "YEARLY", firstDueDate: "2023-12-15" };
      expect(occurrenceDueDate(bill, 5)).toBe("2028-12-15");
    });

    it("un-sticks a leap-day anchor on the next leap year, instead of staying clamped at 28 forever", () => {
      const bill: OccurrenceDueDateFields = { ...base, frequency: "YEARLY", firstDueDate: "2024-02-29" };
      expect(occurrenceDueDate(bill, 1)).toBe("2025-02-28"); // clamped (2025 not a leap year)
      expect(occurrenceDueDate(bill, 4)).toBe("2028-02-29"); // 2028 is a leap year - back to the 29th
    });
  });

  describe("CUSTOM", () => {
    it("intervalUnit 'day' steps sequence * intervalCount days", () => {
      const bill: OccurrenceDueDateFields = { ...base, frequency: "CUSTOM", intervalUnit: "day", intervalCount: 10, firstDueDate: "2024-01-01" };
      expect(occurrenceDueDate(bill, 2)).toBe("2024-01-21");
    });

    it("intervalUnit 'week' steps sequence * intervalCount * 7 days", () => {
      const bill: OccurrenceDueDateFields = { ...base, frequency: "CUSTOM", intervalUnit: "week", intervalCount: 2, firstDueDate: "2024-01-01" };
      expect(occurrenceDueDate(bill, 3)).toBe("2024-02-12");
    });

    it("intervalUnit 'month' uses the same clamped month-math as MONTHLY", () => {
      const bill: OccurrenceDueDateFields = { ...base, frequency: "CUSTOM", intervalUnit: "month", intervalCount: 1, firstDueDate: "2024-01-31" };
      expect(occurrenceDueDate(bill, 1)).toBe("2024-02-29");
    });

    it("intervalUnit 'month' with intervalCount > 1", () => {
      const bill: OccurrenceDueDateFields = { ...base, frequency: "CUSTOM", intervalUnit: "month", intervalCount: 2, firstDueDate: "2024-01-15" };
      expect(occurrenceDueDate(bill, 2)).toBe("2024-05-15");
    });

    it("intervalUnit 'month' clamps the day-of-month like MONTHLY does", () => {
      const bill: OccurrenceDueDateFields = { ...base, frequency: "CUSTOM", intervalUnit: "month", intervalCount: 1, firstDueDate: "2024-01-31" };
      expect(occurrenceDueDate(bill, 3)).toBe("2024-04-30"); // April has 30 days
    });

    it("missing/invalid intervalUnit throws", () => {
      const bill: OccurrenceDueDateFields = { ...base, frequency: "CUSTOM", intervalUnit: null, intervalCount: 1, firstDueDate: "2024-01-01" };
      expect(() => occurrenceDueDate(bill, 1)).toThrow(BillOccurrenceError);
    });
  });
});
