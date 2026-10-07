import { useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { formatINR, MoneyError, rupeesToPaise, updateOccurrenceAmountSchema } from "@household/shared";
import { ApiError } from "../../../lib/api";
import { Alert } from "../../../components/Alert";
import { Button } from "../../../components/Button";
import { TextField } from "../../../components/TextField";
import { useActiveHousehold } from "../useActiveHousehold";
import { useHousehold } from "../members/useMembers";
import { formatBillFrequency } from "./billFrequency";
import { STATUS_LABEL, toneOf } from "./statusTone";
import { STATUS_LABEL as OCCURRENCE_STATUS_LABEL, toneOf as occurrenceToneOf } from "./occurrenceStatusTone";
import { useArchiveBill, useBill, useBillCategories, useOccurrences, usePauseBill, useResumeBill, useUnarchiveBill, useUpdateOccurrenceAmount } from "./useBills";

const AMOUNT_HINT = "Enter a valid rupee amount, e.g. 1500 or 1,500.50";

function messageFrom(err: unknown): string {
  return err instanceof ApiError ? err.message : "Something went wrong. Please try again.";
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
  const [pageError, setPageError] = useState<string | null>(null);

  const occurrencesQuery = useOccurrences(householdId, id);
  const updateAmount = useUpdateOccurrenceAmount(householdId ?? "", id ?? "");
  const [editingOccurrenceId, setEditingOccurrenceId] = useState<string | null>(null);
  const [amountInput, setAmountInput] = useState("");
  const [amountError, setAmountError] = useState<string | undefined>(undefined);

  function onArchive() {
    if (!window.confirm(`Archive ${billQuery.data?.name}? It'll drop off the main list, but its history stays.`)) return;
    archive.mutate(id!, { onError: (err) => setPageError(messageFrom(err)) });
  }

  function startEditAmount(occurrenceId: string, currentAmountDuePaise: number) {
    setEditingOccurrenceId(occurrenceId);
    setAmountInput((currentAmountDuePaise / 100).toFixed(2));
    setAmountError(undefined);
  }

  function onSaveAmount(occurrenceId: string) {
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
      { occurrenceId, body: parsed.data },
      {
        onSuccess: () => setEditingOccurrenceId(null),
        onError: (err) => setAmountError(messageFrom(err)),
      },
    );
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
            <div key={occ.id} className="list__item" style={{ display: "block" }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                <span className="list__text">
                  <span className="list__label" style={{ display: "block" }}>{occ.dueDate}</span>
                  <span className="list__meta">{formatINR(occ.amountDuePaise)}</span>
                </span>
                <span className={`badge badge--${occurrenceToneOf(occ.status)}`}>{OCCURRENCE_STATUS_LABEL[occ.status]}</span>
              </div>
              {canManage && b.amountPaise === null && occ.status === "PENDING" && (
                editingOccurrenceId === occ.id ? (
                  <div style={{ marginTop: "var(--space-2)", display: "grid", gap: "var(--space-2)" }}>
                    <TextField
                      label="Amount due (₹)" inputMode="decimal" value={amountInput}
                      onChange={(e) => setAmountInput(e.target.value)} error={amountError}
                    />
                    <div style={{ display: "flex", gap: "var(--space-2)" }}>
                      <Button loading={updateAmount.isPending} onClick={() => onSaveAmount(occ.id)}>Save</Button>
                      <Button variant="ghost" onClick={() => setEditingOccurrenceId(null)}>Cancel</Button>
                    </div>
                  </div>
                ) : (
                  <div style={{ marginTop: "var(--space-2)" }}>
                    <Button variant="ghost" onClick={() => startEditAmount(occ.id, occ.amountDuePaise)}>Set amount</Button>
                  </div>
                )
              )}
            </div>
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
