import { describe, expect, it } from "vitest";
import { isTaskDueOn, type ChecklistTaskDueFields } from "./checklist-frequency.js";

const base: ChecklistTaskDueFields = {
  frequency: "DAILY",
  weekdays: null,
  dayOfMonth: null,
  specificDate: null,
  intervalDays: null,
  anchorDate: null,
};

describe("isTaskDueOn", () => {
  it("DAILY is always due", () => {
    expect(isTaskDueOn({ ...base, frequency: "DAILY" }, "2024-01-01")).toBe(true);
    expect(isTaskDueOn({ ...base, frequency: "DAILY" }, "2024-02-29")).toBe(true);
  });

  it("WEEKDAYS is due Mon-Fri, not Sat/Sun", () => {
    const task: ChecklistTaskDueFields = { ...base, frequency: "WEEKDAYS" };
    expect(isTaskDueOn(task, "2024-01-03")).toBe(true); // Wednesday
    expect(isTaskDueOn(task, "2024-01-06")).toBe(false); // Saturday
    expect(isTaskDueOn(task, "2024-01-07")).toBe(false); // Sunday
  });

  it("WEEKLY is due on its configured weekdays only", () => {
    const task: ChecklistTaskDueFields = { ...base, frequency: "WEEKLY", weekdays: [3] }; // Wednesday
    expect(isTaskDueOn(task, "2024-01-03")).toBe(true); // Wednesday
    expect(isTaskDueOn(task, "2024-01-06")).toBe(false); // Saturday
  });

  it("MONTHLY clamps dayOfMonth to the shortest month", () => {
    const task: ChecklistTaskDueFields = { ...base, frequency: "MONTHLY", dayOfMonth: 31 };
    // February 2024 (leap year) has 29 days.
    expect(isTaskDueOn(task, "2024-02-29")).toBe(true);
    expect(isTaskDueOn(task, "2024-02-28")).toBe(false);
    // April has 30 days.
    expect(isTaskDueOn(task, "2024-04-30")).toBe(true);
    expect(isTaskDueOn(task, "2024-04-29")).toBe(false);
  });

  it("SPECIFIC_DATE is due only on that exact date", () => {
    const task: ChecklistTaskDueFields = { ...base, frequency: "SPECIFIC_DATE", specificDate: "2024-05-15" };
    expect(isTaskDueOn(task, "2024-05-15")).toBe(true);
    expect(isTaskDueOn(task, "2024-05-16")).toBe(false);
  });

  it("CUSTOM is not due before its anchor date", () => {
    const task: ChecklistTaskDueFields = { ...base, frequency: "CUSTOM", anchorDate: "2024-01-01", intervalDays: 5 };
    expect(isTaskDueOn(task, "2023-12-31")).toBe(false);
  });

  it("CUSTOM is due exactly on interval boundaries from the anchor", () => {
    const task: ChecklistTaskDueFields = { ...base, frequency: "CUSTOM", anchorDate: "2024-01-01", intervalDays: 5 };
    expect(isTaskDueOn(task, "2024-01-01")).toBe(true); // anchor itself
    expect(isTaskDueOn(task, "2024-01-06")).toBe(true); // +5 days
    expect(isTaskDueOn(task, "2024-01-11")).toBe(true); // +10 days
    expect(isTaskDueOn(task, "2024-01-03")).toBe(false); // +2 days, not a multiple
  });
});
