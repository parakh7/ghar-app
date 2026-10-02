import { useState, type FormEvent } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { createAdjustmentSchema, dateInZone, formatINR, MoneyError, recordPaymentSchema, rupeesToPaise } from "@household/shared";
import { ApiError } from "../../../lib/api";
import { Alert } from "../../../components/Alert";
import { Button } from "../../../components/Button";
import { TextField } from "../../../components/TextField";
import { useActiveHousehold } from "../useActiveHousehold";
import { useHousehold } from "../members/useMembers";
import { useHousehelp } from "../househelps/useHousehelps";
import { STATUS_LABEL, toneOf } from "./statusTone";
import { useCreateAdjustment, useRecordPayment, useSettlement, useVoidAdjustment, useVoidPayment } from "./useSalary";

const ADJUSTMENT_TYPES = [
  { value: "BONUS", label: "Bonus" },
  { value: "OVERTIME", label: "Overtime" },
  { value: "DEDUCTION", label: "Deduction" },
  { value: "ADVANCE", label: "Advance" },
  { value: "ADJUSTMENT", label: "Other adjustment" },
] as const;

const PAYMENT_METHODS = [
  { value: "CASH", label: "Cash" },
  { value: "UPI", label: "UPI" },
  { value: "BANK_TRANSFER", label: "Bank transfer" },
  { value: "CARD", label: "Card" },
  { value: "AUTO_DEBIT", label: "Auto-debit" },
  { value: "CHEQUE", label: "Cheque" },
  { value: "OTHER", label: "Other" },
] as const;

const AMOUNT_HINT = "Enter a valid rupee amount, e.g. 1500 or 1,500.50";

function messageFrom(err: unknown): string {
  return err instanceof ApiError ? err.message : "Something went wrong. Please try again.";
}

/** "2026-10-01" -> "October 2026". */
function monthLabel(periodMonth: string): string {
  const [y, m] = periodMonth.split("-").map(Number);
  return new Date(Date.UTC(y!, m! - 1, 1)).toLocaleDateString("en-IN", { month: "long", year: "numeric", timeZone: "UTC" });
}

export function SettlementDetailPage() {
  const { id } = useParams();
  const navigate = useNavigate();
  const { household: active } = useActiveHousehold();
  const householdId = active?.id;
  const householdQuery = useHousehold(householdId);
  const settlementQuery = useSettlement(householdId, id);
  const househelpQuery = useHousehelp(householdId, settlementQuery.data?.househelpId);
  const canManage = householdQuery.data?.permissions.includes("salaries.manage") ?? false;
  const canPay = householdQuery.data?.permissions.includes("salaries.pay") ?? false;

  const createAdjustment = useCreateAdjustment(householdId ?? "");
  const voidAdjustment = useVoidAdjustment(householdId ?? "");
  const recordPayment = useRecordPayment(householdId ?? "");
  const voidPayment = useVoidPayment(householdId ?? "");

  const [pageError, setPageError] = useState<string | null>(null);
  const [adjustmentError, setAdjustmentError] = useState<string | undefined>(undefined);
  const [paymentError, setPaymentError] = useState<string | undefined>(undefined);

  const [adjustmentForm, setAdjustmentForm] = useState({ type: "BONUS" as (typeof ADJUSTMENT_TYPES)[number]["value"], amount: "", reason: "" });
  const [paymentForm, setPaymentForm] = useState(() => ({
    amount: "", paidOn: dateInZone(new Date(), active?.timezone ?? "Asia/Kolkata"),
    method: "CASH" as (typeof PAYMENT_METHODS)[number]["value"], reference: "", notes: "",
  }));

  if (!householdId || !id) return null;
  if (!settlementQuery.data) return <p>Loading…</p>;
  const s = settlementQuery.data;
  const balance = s.netPayablePaise - s.amountPaidPaise;

  function onAddAdjustment(e: FormEvent) {
    e.preventDefault();
    setAdjustmentError(undefined);
    setPageError(null);
    let amountPaise: number;
    try {
      amountPaise = rupeesToPaise(adjustmentForm.amount);
    } catch (err) {
      if (err instanceof MoneyError) return setAdjustmentError(AMOUNT_HINT);
      throw err;
    }
    const parsed = createAdjustmentSchema.safeParse({
      periodMonth: s.periodMonth, type: adjustmentForm.type, amountPaise,
      reason: adjustmentForm.reason.trim() || undefined,
    });
    if (!parsed.success) return setAdjustmentError(parsed.error.issues[0]?.message ?? "Invalid adjustment.");
    createAdjustment.mutate(
      { househelpId: s.househelpId, settlementId: s.id, body: parsed.data },
      {
        onSuccess: () => setAdjustmentForm({ type: "BONUS", amount: "", reason: "" }),
        onError: (err) => setPageError(messageFrom(err)),
      },
    );
  }

  function onVoidAdjustment(adjustmentId: string) {
    if (!window.confirm("Void this adjustment?")) return;
    voidAdjustment.mutate(
      { adjustmentId, househelpId: s.househelpId, settlementId: s.id },
      { onError: (err) => setPageError(messageFrom(err)) },
    );
  }

  function onRecordPayment(e: FormEvent) {
    e.preventDefault();
    setPaymentError(undefined);
    setPageError(null);
    let amountPaise: number;
    try {
      amountPaise = rupeesToPaise(paymentForm.amount);
    } catch (err) {
      if (err instanceof MoneyError) return setPaymentError(AMOUNT_HINT);
      throw err;
    }
    const parsed = recordPaymentSchema.safeParse({
      amountPaise, paidOn: paymentForm.paidOn, method: paymentForm.method,
      reference: paymentForm.reference.trim() || undefined, notes: paymentForm.notes.trim() || undefined,
    });
    if (!parsed.success) return setPaymentError(parsed.error.issues[0]?.message ?? "Invalid payment.");
    recordPayment.mutate(
      { settlementId: s.id, househelpId: s.househelpId, body: parsed.data },
      {
        onSuccess: () => setPaymentForm({ amount: "", paidOn: dateInZone(new Date(), active?.timezone ?? "Asia/Kolkata"), method: "CASH", reference: "", notes: "" }),
        onError: (err) => setPageError(messageFrom(err)),
      },
    );
  }

  function onVoidPayment(paymentId: string) {
    const reason = window.prompt("Reason for voiding this payment (optional):");
    if (reason === null) return;
    voidPayment.mutate(
      { paymentId, reason: reason.trim() || undefined, househelpId: s.househelpId, settlementId: s.id },
      { onError: (err) => setPageError(messageFrom(err)) },
    );
  }

  return (
    <>
      <header className="page-head">
        <h1 className="page-title">{househelpQuery.data?.name ?? "Settlement"} · {monthLabel(s.periodMonth)}</h1>
      </header>
      {pageError && <Alert tone="error" title={pageError} />}

      <div className="card" style={{ marginBottom: "var(--space-4)" }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "var(--space-3)" }}>
          <p style={{ fontSize: "var(--text-2xl)", fontWeight: 700, margin: 0 }}>{formatINR(s.netPayablePaise)}</p>
          <span className={`badge badge--${toneOf(s.status)}`}>{STATUS_LABEL[s.status]}</span>
        </div>
        <div className="list">
          <div className="list__item"><span className="list__text"><span className="list__label" style={{ display: "block" }}>Base pay</span></span><span className="list__meta">{formatINR(s.basePaise)}</span></div>
          <div className="list__item"><span className="list__text"><span className="list__label" style={{ display: "block" }}>Attendance</span></span><span className="list__meta">{s.presentDays} present · {s.halfDays} half-day · {s.absentDays} absent · {s.leaveDays} leave · {s.holidayDays} holiday (of {s.workingDays} working days)</span></div>
          <div className="list__item"><span className="list__text"><span className="list__label" style={{ display: "block" }}>Absence deduction</span></span><span className="list__meta">-{formatINR(s.absenceDeductionPaise)}</span></div>
          <div className="list__item"><span className="list__text"><span className="list__label" style={{ display: "block" }}>Additions</span></span><span className="list__meta">+{formatINR(s.additionsPaise)}</span></div>
          <div className="list__item"><span className="list__text"><span className="list__label" style={{ display: "block" }}>Deductions</span></span><span className="list__meta">-{formatINR(s.deductionsPaise)}</span></div>
          <div className="list__item"><span className="list__text"><span className="list__label" style={{ display: "block" }}>Advance</span></span><span className="list__meta">-{formatINR(s.advancePaise)}</span></div>
          <div className="list__item"><span className="list__text"><span className="list__label" style={{ display: "block" }}>Net payable</span></span><span className="list__meta">{formatINR(s.netPayablePaise)}</span></div>
          <div className="list__item"><span className="list__text"><span className="list__label" style={{ display: "block" }}>Paid so far</span></span><span className="list__meta">{formatINR(s.amountPaidPaise)}</span></div>
          <div className="list__item"><span className="list__text"><span className="list__label" style={{ display: "block" }}>Balance remaining</span></span><span className="list__meta">{formatINR(balance)}</span></div>
        </div>
      </div>

      <h2 className="section-title">Adjustments</h2>
      {s.adjustments.length === 0 ? (
        <p className="list__meta" style={{ padding: "0 var(--space-1)" }}>No adjustments recorded.</p>
      ) : (
        <div className="list" style={{ marginBottom: "var(--space-4)" }}>
          {s.adjustments.map((a) => (
            <div key={a.id} className="list__item">
              <span className="list__text">
                <span className="list__label" style={{ display: "block" }}>
                  {ADJUSTMENT_TYPES.find((t) => t.value === a.type)?.label ?? a.type}{a.voidedAt && " (voided)"}
                </span>
                <span className="list__meta">{formatINR(a.amountPaise)}{a.reason && ` · ${a.reason}`}</span>
              </span>
              {canManage && !a.voidedAt && (
                <Button variant="ghost" loading={voidAdjustment.isPending} onClick={() => onVoidAdjustment(a.id)}>Void</Button>
              )}
            </div>
          ))}
        </div>
      )}

      {canManage && (
        <form className="card" onSubmit={onAddAdjustment} style={{ marginBottom: "var(--space-6)", display: "grid", gap: "var(--space-3)" }}>
          <p className="section-title" style={{ margin: 0 }}>Add adjustment</p>
          <div className="field">
            <label className="field__label" htmlFor="adj-type">Type</label>
            <select
              id="adj-type" className="input" value={adjustmentForm.type}
              onChange={(e) => setAdjustmentForm((f) => ({ ...f, type: e.target.value as typeof f.type }))}
            >
              {ADJUSTMENT_TYPES.map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}
            </select>
          </div>
          <TextField
            label="Amount (₹)" inputMode="decimal" value={adjustmentForm.amount}
            onChange={(e) => setAdjustmentForm((f) => ({ ...f, amount: e.target.value }))} error={adjustmentError}
          />
          <TextField
            label="Reason (optional)" value={adjustmentForm.reason}
            onChange={(e) => setAdjustmentForm((f) => ({ ...f, reason: e.target.value }))}
          />
          <Button type="submit" loading={createAdjustment.isPending}>Add adjustment</Button>
        </form>
      )}

      <h2 className="section-title">Payments</h2>
      {s.payments.length === 0 ? (
        <p className="list__meta" style={{ padding: "0 var(--space-1)" }}>No payments recorded.</p>
      ) : (
        <div className="list" style={{ marginBottom: "var(--space-4)" }}>
          {s.payments.map((p) => (
            <div key={p.id} className="list__item">
              <span className="list__text">
                <span className="list__label" style={{ display: "block" }}>
                  {formatINR(p.amountPaise)} · {PAYMENT_METHODS.find((m) => m.value === p.method)?.label ?? p.method}{p.voidedAt && " (voided)"}
                </span>
                <span className="list__meta">{p.paidOn}{p.reference && ` · ${p.reference}`}{p.notes && ` · ${p.notes}`}</span>
              </span>
              {canPay && !p.voidedAt && (
                <Button variant="ghost" loading={voidPayment.isPending} onClick={() => onVoidPayment(p.id)}>Void</Button>
              )}
            </div>
          ))}
        </div>
      )}

      {canPay && (
        <form className="card" onSubmit={onRecordPayment} style={{ marginBottom: "var(--space-6)", display: "grid", gap: "var(--space-3)" }}>
          <p className="section-title" style={{ margin: 0 }}>Record payment</p>
          <TextField
            label="Amount (₹)" inputMode="decimal" value={paymentForm.amount}
            onChange={(e) => setPaymentForm((f) => ({ ...f, amount: e.target.value }))} error={paymentError}
          />
          <TextField
            label="Paid on" type="date" value={paymentForm.paidOn}
            onChange={(e) => setPaymentForm((f) => ({ ...f, paidOn: e.target.value }))}
          />
          <div className="field">
            <label className="field__label" htmlFor="pay-method">Method</label>
            <select
              id="pay-method" className="input" value={paymentForm.method}
              onChange={(e) => setPaymentForm((f) => ({ ...f, method: e.target.value as typeof f.method }))}
            >
              {PAYMENT_METHODS.map((m) => <option key={m.value} value={m.value}>{m.label}</option>)}
            </select>
          </div>
          <TextField
            label="Reference (optional)" value={paymentForm.reference}
            onChange={(e) => setPaymentForm((f) => ({ ...f, reference: e.target.value }))}
          />
          <TextField
            label="Notes (optional)" value={paymentForm.notes}
            onChange={(e) => setPaymentForm((f) => ({ ...f, notes: e.target.value }))}
          />
          <Button type="submit" loading={recordPayment.isPending}>Record payment</Button>
        </form>
      )}

      <div style={{ marginTop: "var(--space-4)" }}><Button variant="ghost" onClick={() => navigate("/salary")}>Back to salaries</Button></div>
    </>
  );
}
