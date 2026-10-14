import { useState, type FormEvent } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { Wallet } from "lucide-react";
import type { HousehelpDTO } from "@household/shared";
import { dateInZone, formatINR, generateSettlementSchema } from "@household/shared";
import { ApiError } from "../../../lib/api";
import { Alert } from "../../../components/Alert";
import { Button } from "../../../components/Button";
import { EmptyState } from "../../../components/EmptyState";
import { useActiveHousehold } from "../useActiveHousehold";
import { useHousehold } from "../members/useMembers";
import { useHousehelps } from "../househelps/useHousehelps";
import { STATUS_LABEL, toneOf } from "./statusTone";
import { useGenerateSettlement, useHousehelpSettlements } from "./useSalary";

function messageFrom(err: unknown): string {
  if (!(err instanceof ApiError)) return "Something went wrong. Please try again.";
  const fieldMessage = err.fields ? Object.values(err.fields)[0] : undefined;
  return fieldMessage ?? err.message;
}

/** "2026-10-01" -> "October 2026". */
function monthLabel(periodMonth: string): string {
  const [y, m] = periodMonth.split("-").map(Number);
  return new Date(Date.UTC(y!, m! - 1, 1)).toLocaleDateString("en-IN", { month: "long", year: "numeric", timeZone: "UTC" });
}

/** "YYYY-MM" -> "YYYY-MM" of the previous month — the most recently fully-elapsed month, which is
 * what `generateSettlement` requires (it always rejects the current or a future month). */
function previousMonth(month: string): string {
  const [y, m] = month.split("-").map(Number);
  return m === 1 ? `${y! - 1}-12` : `${y}-${String(m! - 1).padStart(2, "0")}`;
}

function HousehelpSettlements({ householdId, h }: { householdId: string; h: HousehelpDTO }) {
  const settlementsQuery = useHousehelpSettlements(householdId, h.id);
  const settlements = [...(settlementsQuery.data ?? [])].sort((a, b) => b.periodMonth.localeCompare(a.periodMonth));

  return (
    <div>
      <h2 className="section-title">{h.name}</h2>
      {settlements.length === 0 ? (
        <p className="list__meta" style={{ padding: "0 var(--space-1)" }}>No settlements yet.</p>
      ) : (
        <div className="list">
          {settlements.map((s) => (
            <Link key={s.id} to={`/salary/${s.id}`} className="list__item">
              <span className="list__text">
                <span className="list__label" style={{ display: "block" }}>{monthLabel(s.periodMonth)}</span>
                <span className="list__meta">
                  {formatINR(s.amountPaidPaise)} of {formatINR(s.netPayablePaise)} paid
                </span>
              </span>
              <span className={`badge badge--${toneOf(s.status)}`}>{STATUS_LABEL[s.status]}</span>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}

export function SalaryListPage() {
  const { household: active } = useActiveHousehold();
  const householdId = active?.id;
  const householdQuery = useHousehold(householdId);
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const deepLinkedHousehelpId = searchParams.get("househelpId") ?? "";
  const househelpsQuery = useHousehelps(householdId, false);
  const generateSettlement = useGenerateSettlement(householdId ?? "");
  const canManage = householdQuery.data?.permissions.includes("salaries.manage") ?? false;
  const [pageError, setPageError] = useState<string | null>(null);
  const [fieldError, setFieldError] = useState<string | undefined>(undefined);

  const househelps = househelpsQuery.data ?? [];
  const defaultMonth = previousMonth(dateInZone(new Date(), active?.timezone ?? "Asia/Kolkata").slice(0, 7));
  const [form, setForm] = useState({ househelpId: "", month: defaultMonth });
  const selectedHousehelpId = form.househelpId || deepLinkedHousehelpId || househelps[0]?.id || "";

  if (!householdId) return null;

  function onGenerate(e: FormEvent) {
    e.preventDefault();
    setPageError(null);
    setFieldError(undefined);
    if (!selectedHousehelpId) return;
    const parsed = generateSettlementSchema.safeParse({ periodMonth: `${form.month}-01` });
    if (!parsed.success) return setFieldError(parsed.error.issues[0]?.message ?? "Invalid month.");
    generateSettlement.mutate(
      { househelpId: selectedHousehelpId, body: parsed.data },
      { onSuccess: (result) => navigate(`/salary/${result.data.id}`), onError: (err) => setPageError(messageFrom(err)) },
    );
  }

  return (
    <>
      <header className="page-head"><h1 className="page-title">Salaries</h1></header>
      {pageError && <Alert tone="error" title={pageError} />}

      {househelps.length === 0 && (
        <div className="card">
          <EmptyState
            icon={<Wallet size={22} />} title="No househelps yet"
            text="Add a househelp first, then generate their monthly salary settlement here."
          />
        </div>
      )}

      {canManage && househelps.length > 0 && (
        <form className="card" onSubmit={onGenerate} style={{ marginBottom: "var(--space-4)", display: "grid", gap: "var(--space-3)" }}>
          <div className="field">
            <label className="field__label" htmlFor="salary-househelp">Househelp</label>
            <select
              id="salary-househelp" className="input" value={selectedHousehelpId}
              onChange={(e) => setForm((f) => ({ ...f, househelpId: e.target.value }))}
            >
              {househelps.map((h) => <option key={h.id} value={h.id}>{h.name}</option>)}
            </select>
          </div>
          <div className="field">
            <label className="field__label" htmlFor="salary-month">Month</label>
            <input
              id="salary-month" type="month" className="input" value={form.month}
              onChange={(e) => setForm((f) => ({ ...f, month: e.target.value }))}
            />
            {fieldError && <p className="field__error">{fieldError}</p>}
          </div>
          <Button type="submit" loading={generateSettlement.isPending}>Generate settlement</Button>
        </form>
      )}

      {househelps.map((h) => <HousehelpSettlements key={h.id} householdId={householdId} h={h} />)}
    </>
  );
}
