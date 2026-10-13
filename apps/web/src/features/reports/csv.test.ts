import { describe, expect, it } from "vitest";
import { reportToCSV } from "./csv";

describe("reportToCSV", () => {
  it("formats a bills report as CSV", () => {
    const csv = reportToCSV({
      type: "bills",
      rows: [{ occurrenceId: "o1", billId: "b1", billName: "Electricity", dueDate: "2026-09-15", amountDuePaise: 50000, amountPaidPaise: 0, status: "PENDING" }],
      totalDuePaise: 50000, totalPaidPaise: 0,
    });
    expect(csv).toBe("Bill,Due date,Status,Amount due (paise),Amount paid (paise)\nElectricity,2026-09-15,PENDING,50000,0");
  });

  it("escapes commas and quotes in cell values", () => {
    const csv = reportToCSV({
      type: "bills",
      rows: [{ occurrenceId: "o1", billId: "b1", billName: 'Electricity, "City"', dueDate: "2026-09-15", amountDuePaise: 50000, amountPaidPaise: 0, status: "PENDING" }],
      totalDuePaise: 50000, totalPaidPaise: 0,
    });
    expect(csv).toContain('"Electricity, ""City"""');
  });

  it("formats a checklist report as CSV", () => {
    const csv = reportToCSV({
      type: "checklist",
      rows: [{ taskId: "t1", name: "Wash dishes", dueCount: 30, completedCount: 20, skippedCount: 5, missedCount: 5 }],
    });
    expect(csv).toBe("Task,Due,Completed,Skipped,Missed\nWash dishes,30,20,5,5");
  });
});
