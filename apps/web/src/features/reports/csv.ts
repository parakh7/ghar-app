import type { ReportDTO } from "@household/shared";

function escapeCsvCell(value: string | number): string {
  const str = String(value);
  return /[",\n]/.test(str) ? `"${str.replace(/"/g, '""')}"` : str;
}

function toCSVLines(headers: string[], rows: (string | number)[][]): string {
  return [headers, ...rows].map((row) => row.map(escapeCsvCell).join(",")).join("\n");
}

export function reportToCSV(report: ReportDTO): string {
  if (report.type === "bills") {
    return toCSVLines(
      ["Bill", "Due date", "Status", "Amount due (paise)", "Amount paid (paise)"],
      report.rows.map((r) => [r.billName, r.dueDate, r.status, r.amountDuePaise, r.amountPaidPaise]),
    );
  }
  if (report.type === "salary") {
    return toCSVLines(
      ["Househelp", "Status", "Net payable (paise)", "Amount paid (paise)"],
      report.rows.map((r) => [r.househelpName, r.status, r.netPayablePaise, r.amountPaidPaise]),
    );
  }
  if (report.type === "attendance") {
    return toCSVLines(
      ["Househelp", "Present", "Absent", "Half day", "Leave", "Holiday"],
      report.rows.map((r) => [r.name, r.present, r.absent, r.halfDay, r.leave, r.holiday]),
    );
  }
  return toCSVLines(
    ["Task", "Due", "Completed", "Skipped", "Missed"],
    report.rows.map((r) => [r.name, r.dueCount, r.completedCount, r.skippedCount, r.missedCount]),
  );
}
