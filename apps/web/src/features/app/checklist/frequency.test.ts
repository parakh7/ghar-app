import { describe, expect, it } from "vitest";
import type { ChecklistTaskDTO } from "@household/shared";
import { formatFrequency } from "./frequency";

function task(overrides: Partial<ChecklistTaskDTO>): ChecklistTaskDTO {
  return {
    id: "t1", name: "Task", description: null, categoryId: null, frequency: "DAILY",
    weekdays: null, dayOfMonth: null, specificDate: null, intervalDays: null, anchorDate: null,
    preferredTime: null, priority: "NORMAL", sortOrder: 0, isActive: true, archivedAt: null,
    createdAt: "2026-01-01T00:00:00.000Z", ...overrides,
  };
}

describe("formatFrequency", () => {
  it("formats DAILY and WEEKDAYS", () => {
    expect(formatFrequency(task({ frequency: "DAILY" }))).toBe("Every day");
    expect(formatFrequency(task({ frequency: "WEEKDAYS" }))).toBe("Weekdays");
  });

  it("formats WEEKLY as a day-name list", () => {
    expect(formatFrequency(task({ frequency: "WEEKLY", weekdays: [1, 3, 5] }))).toBe("Every Mon, Wed, Fri");
  });

  it("formats MONTHLY with an ordinal day", () => {
    expect(formatFrequency(task({ frequency: "MONTHLY", dayOfMonth: 1 }))).toBe("Monthly on the 1st");
    expect(formatFrequency(task({ frequency: "MONTHLY", dayOfMonth: 22 }))).toBe("Monthly on the 22nd");
  });

  it("formats SPECIFIC_DATE and CUSTOM", () => {
    expect(formatFrequency(task({ frequency: "SPECIFIC_DATE", specificDate: "2026-10-15" }))).toBe("On 2026-10-15");
    expect(formatFrequency(task({ frequency: "CUSTOM", intervalDays: 1 }))).toBe("Every 1 day");
    expect(formatFrequency(task({ frequency: "CUSTOM", intervalDays: 14 }))).toBe("Every 14 days");
  });
});
