import { useState, type FormEvent } from "react";
import { useNavigate, useParams } from "react-router-dom";
import {
  dateInZone, formatINR, MoneyError, recordBillPaymentSchema, rupeesToPaise,
  updateOccurrenceAmountSchema, type BillOccurrenceDTO,
} from "@household/shared";
import { ApiError } from "../../../lib/api";
import { Alert } from "../../../components/Alert";
import { Button } from "../../../components/Button";
import { TextField } from "../../../components/TextField";
import { useActiveHousehold } from "../useActiveHousehold";
import { useHousehold } from "../members/useMembers";
import { formatBillFrequency } from "./billFrequency";
import { STATUS_LABEL, toneOf } from "./statusTone";
import { STATUS_LABEL as OCCURRENCE_STATUS_LABEL, toneOf as occurrenceToneOf } from "./occurrenceStatusTone";
import {
  useArchiveBill, useBill, useBillCategories, useOccurrencePayments, useOccurrences, usePauseBill,
  useRecordPayment, useResumeBill, useUnarchiveBill, useUnwaiveOccurrence, useUpdateOccurrenceAmount,
  useVoidPayment, useWaiveOccurrence,
} from "./useBills";

const AMOUNT_HINT = "Enter a valid rupee amount, e.g. 1500 or 1,500.50";

const PAYMENT_METHODS = [
  { value: "CASH", label: "Cash" },
  { value: "UPI", label: "UPI" },
  { value: "BANK_TRANSFER", label: "Bank transfer" },
  { value: "CARD", label: "Card" },
  { value: "AUTO_DEBIT", label: "Auto-debit" },
  { value: "CHEQUE", label: "Cheque" },
  { value: "OTHER", label: "Other" },
] as const;

function messageFrom(err: unknown): string {
  return err instanceof ApiError ? err.message : "Something went wrong. Please try again.";
}

function OccurrenceRow({
  occ, householdId, billId, billAmountIsVariable, canManage, canRecordPayment, timezone, onError,
}: {
  occ: BillOccurrenceDTO; householdId: string; billId: string; billAmountIsVariable: boolean;
  canManage: boolean; canRecordPayment: boolean; timezone: string; onError: (err: unknown) => void;
}) {
  const paymentsQuery = useOccurrencePayments(householdId, billId, occ.id);
  const updateAmount = useUpdateOccurrenceAmount(householdId, billId);
  const recordPayment = useRecordPayment(householdId, billId);
  const voidPayment = useVoidPayment(householdId, billId);
  const waive = useWaiveOccurrence(householdId, billId);
  const unwaive = useUnwaiveOccurrence(householdId, billId);

  const [editingAmount, setEditingAmount] = useState(false);
  const [amountInput, setAmountInput] = useState("");
  const [amountError, setAmountError] = useState<string | undefined>(undefined);

  const [showPaymentForm, setShowPaymentForm] = useState(false);
  const [paymentError, setPaymentError] = useState<string | undefined>(undefined);
  const [paymentForm, setPaymentForm] = useState(() => ({
    amount: "", paidOn: dateInZone(new Date(), timezone),
    method: "CASH" as (typeof PAYMENT_METHODS)[number]["value"], transactionRef: "", notes: "",
  }));

  function startEditAmount() {
    setEditingAmount(true);
    setAmountInput((occ.amountDuePaise / 100).toFixed(2));
    setAmountError(undefined);
  }

  function onSaveAmount() {
    setAmountError(undefined);
    let amountDuePaise: number;
    try {
      amountDuePaise = rupeesToPaise(amountInput);
    } catch (err) {
      if (err instanceof MoneyError) return setAmountError(AMOUNT_HINT);
      throw err;
    }
    const parsed = updateOccurrenceAmountSchema.safeParse({ amountDuePaise });
    if (!parsed.success) return setAmountError(parsed.error.issues[0]?.message ?? "Invalid amount.");
    updateAmount.mutate(
      { occurrenceId: occ.id, body: parsed.data },
      { onSuccess: () => setEditingAmount(false), onError: (err) => setAmountError(messageFrom(err)) },
    );
  }

  function onRecordPayment(e: FormEvent) {
    e.preventDefault();
    setPaymentError(undefined);
    let amountPaise: number;
    try {
      amountPaise = rupeesToPaise(paymentForm.amount);
    } catch (err) {
      if (err instanceof MoneyError) return setPaymentError(AMOUNT_HINT);
      throw err;
    }
    const parsed = recordBillPaymentSchema.safeParse({
      amountPaise, paidOn: paymentForm.paidOn, method: paymentForm.method,
      transactionRef: paymentForm.transactionRef.trim() || undefined, notes: paymentForm.notes.trim() || undefined,
    });
    if (!parsed.success) return setPaymentError(parsed.error.issues[0]?.message ?? "Invalid payment.");
    recordPayment.mutate(
      { occurrenceId: occ.id, body: parsed.data },
      {
        onSuccess: () => {
          setShowPaymentForm(false);
          setPaymentForm({ amount: "", paidOn: dateInZone(new Date(), timezone), method: "CASH", transactionRef: "", notes: "" });
        },
        onError: (err) => onError(err),
      },
    );
  }

  function onVoidPayment(paymentId: string) {
    const reason = window.prompt("Reason for voiding this payment (optional):");
    if (reason === null) return;
    voidPayment.mutate(
      { occurrenceId: occ.id, paymentId, reason: reason.trim() || undefined },
      { onError: (err) => onError(err) },
    );
  }

  function onWaive() {
    const reason = window.prompt("Reason for waiving this occurrence (optional):");
    if (reason === null) return;
    waive.mutate({ occurrenceId: occ.id, body: { reason: reason.trim() || undefined } }, { onError: (err) => onError(err) });
  }

  function onUnwaive() {
    if (!window.confirm("Restore this occurrence to pending?")) return;
    unwaive.mutate(occ.id, { onError: (err) => onError(err) });
  }

  const payments = paymentsQuery.data ?? [];
  const canRecordThisPayment = canRecordPayment && occ.status !== "WAIVED" && occ.amountPaidPaise < occ.amountDuePaise;

  return (
    <div className="list__item" style={{ display: "block" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <span className="list__text">
          <span className="list__label" style={{ display: "block" }}>{occ.dueDate}</span>
          <span className="list__meta">
            {formatINR(occ.amountDuePaise)}{occ.amountPaidPaise > 0 && ` · ${formatINR(occ.amountPaidPaise)} paid`}
          </span>
        </span>
        <span className={`badge badge--${occurrenceToneOf(occ.status)}`}>{OCCURRENCE_STATUS_LABEL[occ.status]}</span>
      </div>

      {canManage && billAmountIsVariable && occ.status === "PENDING" && (
        editingAmount ? (
          <div style={{ marginTop: "var(--space-2)", display: "grid", gap: "var(--space-2)" }}>
            <TextField
              label="Amount due (₹)" inputMode="decimal" value={amountInput}
              onChange={(e) => setAmountInput(e.target.value)} error={amountError}
            />
            <div style={{ display: "flex", gap: "var(--space-2)" }}>
              <Button loading={updateAmount.isPending} onClick={onSaveAmount}>Save</Button>
              <Button variant="ghost" onClick={() => setEditingAmount(false)}>Cancel</Button>
            </div>
          </div>
        ) : (
          <div style={{ marginTop: "var(--space-2)" }}>
            <Button variant="ghost" onClick={startEditAmount}>Set amount</Button>
          </div>
        )
      )}

      {paymentsQuery.isError && (
        <div style={{ marginTop: "var(--space-2)" }}>
          <Alert tone="error" title="Couldn't load payment history." />
        </div>
      )}

      {payments.length > 0 && (
        <div className="list" style={{ marginTop: "var(--space-2)" }}>
          {payments.map((p) => (
            <div key={p.id} className="list__item">
              <span className="list__text">
                <span className="list__label" style={{ display: "block" }}>
                  {formatINR(p.amountPaise)} · {PAYMENT_METHODS.find((m) => m.value === p.method)?.label ?? p.method}{p.voidedAt && " (voided)"}
                </span>
                <span className="list__meta">{p.paidOn}{p.transactionRef && ` · ${p.transactionRef}`}{p.notes && ` · ${p.notes}`}</span>
              </span>
              {canRecordPayment && !p.voidedAt && (
                <Button variant="ghost" loading={voidPayment.isPending} onClick={() => onVoidPayment(p.id)}>Void</Button>
              )}
            </div>
          ))}
        </div>
      )}

      <div style={{ marginTop: "var(--space-2)", display: "flex", gap: "var(--space-2)", flexWrap: "wrap" }}>
        {canRecordThisPayment && !showPaymentForm && (
          <Button variant="ghost" onClick={() => setShowPaymentForm(true)}>Record payment</Button>
        )}
        {canManage && occ.status === "PENDING" && (
          <Button variant="ghost" loading={waive.isPending} onClick={onWaive}>Waive</Button>
        )}
        {canManage && occ.status === "WAIVED" && (
          <Button variant="ghost" loading={unwaive.isPending} onClick={onUnwaive}>Unwaive</Button>
        )}
      </div>

      {showPaymentForm && (
        <form onSubmit={onRecordPayment} style={{ marginTop: "var(--space-2)", display: "grid", gap: "var(--space-2)" }}>
          <TextField
            label="Amount (₹)" inputMode="decimal" value={paymentForm.amount}
            onChange={(e) => setPaymentForm((f) => ({ ...f, amount: e.target.value }))} error={paymentError}
          />
          <TextField
            label="Paid on" type="date" value={paymentForm.paidOn}
            onChange={(e) => setPaymentForm((f) => ({ ...f, paidOn: e.target.value }))}
          />
          <div className="field">
            <label className="field__label" htmlFor={`pay-method-${occ.id}`}>Method</label>
            <select
              id={`pay-method-${occ.id}`} className="input" value={paymentForm.method}
              onChange={(e) => setPaymentForm((f) => ({ ...f, method: e.target.value as typeof f.method }))}
            >
              {PAYMENT_METHODS.map((m) => <option key={m.value} value={m.value}>{m.label}</option>)}
            </select>
          </div>
          <TextField
            label="Reference (optional)" value={paymentForm.transactionRef}
            onChange={(e) => setPaymentForm((f) => ({ ...f, transactionRef: e.target.value }))}
          />
          <TextField
            label="Notes (optional)" value={paymentForm.notes}
            onChange={(e) => setPaymentForm((f) => ({ ...f, notes: e.target.value }))}
          />
          <div style={{ display: "flex", gap: "var(--space-2)" }}>
            <Button type="submit" loading={recordPayment.isPending}>Record payment</Button>
            <Button variant="ghost" onClick={() => setShowPaymentForm(false)}>Cancel</Button>
          </div>
        </form>
      )}
    </div>
  );
}

export function BillDetailPage() {
  const { id } = useParams();
  const navigate = useNavigate();
  const { household: active } = useActiveHousehold();
  const householdId = active?.id;
  const householdQuery = useHousehold(householdId);
  const billQuery = useBill(householdId, id);
  const categoriesQuery = useBillCategories(householdId);
  const pause = usePauseBill(householdId ?? "");
  const resume = useResumeBill(householdId ?? "");
  const archive = useArchiveBill(householdId ?? "");
  const unarchive = useUnarchiveBill(householdId ?? "");
  const canManage = householdQuery.data?.permissions.includes("bills.manage") ?? false;
  const canRecordPayment = householdQuery.data?.permissions.includes("payments.record") ?? false;
  const [pageError, setPageError] = useState<string | null>(null);

  const occurrencesQuery = useOccurrences(householdId, id);

  function onArchive() {
    if (!window.confirm(`Archive ${billQuery.data?.name}? It'll drop off the main list, but its history stays.`)) return;
    archive.mutate(id!, { onError: (err) => setPageError(messageFrom(err)) });
  }

  if (!householdId || !billQuery.data) return null;
  const b = billQuery.data;
  const categoryName = (categoriesQuery.data ?? []).find((c) => c.id === b.categoryId)?.name;

  return (
    <>
      <header className="page-head"><h1 className="page-title">{b.name}</h1></header>
      {pageError && <Alert tone="error" title={pageError} />}
      {b.status === "ARCHIVED" && <Alert tone="info" title="This bill is archived." />}

      <div style={{ marginBottom: "var(--space-4)" }}>
        <span className={`badge badge--${toneOf(b.status)}`}>{STATUS_LABEL[b.status]}</span>
      </div>

      <div className="list">
        <div className="list__item"><span className="list__text"><span className="list__label" style={{ display: "block" }}>Category</span><span className="list__meta">{categoryName ?? "—"}</span></span></div>
        <div className="list__item"><span className="list__text"><span className="list__label" style={{ display: "block" }}>Provider</span><span className="list__meta">{b.provider ?? "—"}</span></span></div>
        <div className="list__item"><span className="list__text"><span className="list__label" style={{ display: "block" }}>Account number</span><span className="list__meta">{b.accountNumber ?? "—"}</span></span></div>
        <div className="list__item"><span className="list__text"><span className="list__label" style={{ display: "block" }}>Amount</span><span className="list__meta">{b.amountPaise != null ? formatINR(b.amountPaise) : "Variable amount"}</span></span></div>
        <div className="list__item"><span className="list__text"><span className="list__label" style={{ display: "block" }}>Repeats</span><span className="list__meta">{formatBillFrequency(b)}</span></span></div>
        <div className="list__item"><span className="list__text"><span className="list__label" style={{ display: "block" }}>First due date</span><span className="list__meta">{b.firstDueDate}</span></span></div>
        <div className="list__item"><span className="list__text"><span className="list__label" style={{ display: "block" }}>End date</span><span className="list__meta">{b.endDate ?? "—"}</span></span></div>
        <div className="list__item"><span className="list__text"><span className="list__label" style={{ display: "block" }}>Payment method</span><span className="list__meta">{b.paymentMethod ?? "—"}</span></span></div>
        <div className="list__item"><span className="list__text"><span className="list__label" style={{ display: "block" }}>Autopay</span><span className="list__meta">{b.autopay ? "On" : "Off"}</span></span></div>
        {b.notes && <div className="list__item"><span className="list__text"><span className="list__label" style={{ display: "block" }}>Notes</span><span className="list__meta">{b.notes}</span></span></div>}
      </div>

      <h2 className="section-title">Occurrences</h2>
      {occurrencesQuery.isPending ? (
        <p className="list__meta" style={{ padding: "0 var(--space-1)" }}>Loading…</p>
      ) : (occurrencesQuery.data ?? []).length === 0 ? (
        <p className="list__meta" style={{ padding: "0 var(--space-1)" }}>No occurrences yet.</p>
      ) : (
        <div className="list" style={{ marginBottom: "var(--space-6)" }}>
          {(occurrencesQuery.data ?? []).map((occ) => (
            <OccurrenceRow
              key={occ.id} occ={occ} householdId={householdId} billId={id!}
              billAmountIsVariable={b.amountPaise === null} canManage={canManage} canRecordPayment={canRecordPayment}
              timezone={active?.timezone ?? "Asia/Kolkata"} onError={(err) => setPageError(messageFrom(err))}
            />
          ))}
        </div>
      )}

      {canManage && (
        <div style={{ marginTop: "var(--space-6)", display: "grid", gap: "var(--space-3)" }}>
          <Button variant="secondary" block onClick={() => navigate(`/bills/${id}/edit`)}>Edit details</Button>
          {b.status === "ACTIVE" && (
            <>
              <Button variant="secondary" block loading={pause.isPending} onClick={() => pause.mutate(id!, { onError: (err) => setPageError(messageFrom(err)) })}>Pause</Button>
              <Button variant="danger" block loading={archive.isPending} onClick={onArchive}>Archive bill</Button>
            </>
          )}
          {b.status === "PAUSED" && (
            <>
              <Button variant="secondary" block loading={resume.isPending} onClick={() => resume.mutate(id!, { onError: (err) => setPageError(messageFrom(err)) })}>Resume</Button>
              <Button variant="danger" block loading={archive.isPending} onClick={onArchive}>Archive bill</Button>
            </>
          )}
          {b.status === "ARCHIVED" && (
            <Button variant="secondary" block loading={unarchive.isPending} onClick={() => unarchive.mutate(id!, { onError: (err) => setPageError(messageFrom(err)) })}>Restore</Button>
          )}
        </div>
      )}
      <div style={{ marginTop: "var(--space-4)" }}><Button variant="ghost" onClick={() => navigate("/bills")}>Back to bills</Button></div>
    </>
  );
}
