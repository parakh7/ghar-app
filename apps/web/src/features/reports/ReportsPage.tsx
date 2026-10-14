import { useState } from "react";
import { formatINR } from "@household/shared";
import type { ReportType } from "@household/shared";
import { Button } from "../../components/Button";
import { useActiveHousehold } from "../app/useActiveHousehold";
import { reportToCSV } from "./csv";
import { useReport } from "./useReports";

const TYPES: { value: ReportType; label: string }[] = [
  { value: "bills", label: "Bills" },
  { value: "salary", label: "Salary" },
  { value: "attendance", label: "Attendance" },
  { value: "checklist", label: "Checklist" },
];

function currentMonth(): string {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
}

export function ReportsPage() {
  const { household } = useActiveHousehold();
  const [type, setType] = useState<ReportType>("bills");
  const [month, setMonth] = useState(currentMonth());
  const report = useReport(household?.id, type, month).data;

  function onDownload() {
    if (!report) return;
    const csv = reportToCSV(report);
    const blob = new Blob([csv], { type: "text/csv" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${type}-${month}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }

  return (
    <>
      <header className="page-head"><h1 className="page-title">Reports</h1></header>
      <div className="chips" role="group" aria-label="Report type">
        {TYPES.map((t) => (
          <button key={t.value} type="button" className="chip" aria-pressed={type === t.value} onClick={() => setType(t.value)}>{t.label}</button>
        ))}
      </div>
      <input
        type="month" value={month} onChange={(e) => setMonth(e.target.value)} aria-label="Month"
        style={{
          margin: "var(--space-4) 0", height: "var(--touch)", padding: "0 var(--space-3)", borderRadius: "var(--radius-sm)",
          border: "1.5px solid var(--line-strong)", background: "var(--card)", color: "var(--text)",
        }}
      />
      {report && (
        <>
          <div style={{ marginBottom: "var(--space-4)" }}>
            <Button variant="secondary" onClick={onDownload}>Download CSV</Button>
          </div>
          {report.type === "bills" && (
            <div className="list">
              {report.rows.map((r) => (
                <div key={r.occurrenceId} className="list__item">
                  <span className="list__text"><span className="list__label" style={{ display: "block" }}>{r.billName}</span><span className="list__meta">{r.dueDate} · {r.status}</span></span>
                  <span className="list__meta">{formatINR(r.amountDuePaise)} / {formatINR(r.amountPaidPaise)}</span>
                </div>
              ))}
            </div>
          )}
          {report.type === "salary" && (
            <div className="list">
              {report.rows.map((r) => (
                <div key={r.settlementId} className="list__item">
                  <span className="list__text"><span className="list__label" style={{ display: "block" }}>{r.househelpName}</span><span className="list__meta">{r.status}</span></span>
                  <span className="list__meta">{formatINR(r.netPayablePaise)} / {formatINR(r.amountPaidPaise)}</span>
                </div>
              ))}
            </div>
          )}
          {report.type === "attendance" && (
            <div className="list">
              {report.rows.map((r) => (
                <div key={r.househelpId} className="list__item">
                  <span className="list__label">{r.name}</span>
                  <span className="list__meta">P{r.present} A{r.absent} H{r.halfDay} L{r.leave} Ho{r.holiday}</span>
                </div>
              ))}
            </div>
          )}
          {report.type === "checklist" && (
            <div className="list">
              {report.rows.map((r) => (
                <div key={r.taskId} className="list__item">
                  <span className="list__label">{r.name}</span>
                  <span className="list__meta">{r.completedCount}/{r.dueCount} done, {r.skippedCount} skipped, {r.missedCount} missed</span>
                </div>
              ))}
            </div>
          )}
        </>
      )}
    </>
  );
}
