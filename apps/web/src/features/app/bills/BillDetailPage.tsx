import { useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { formatINR } from "@household/shared";
import { ApiError } from "../../../lib/api";
import { Alert } from "../../../components/Alert";
import { Button } from "../../../components/Button";
import { useActiveHousehold } from "../useActiveHousehold";
import { useHousehold } from "../members/useMembers";
import { formatBillFrequency } from "./billFrequency";
import { STATUS_LABEL, toneOf } from "./statusTone";
import { useArchiveBill, useBill, useBillCategories, usePauseBill, useResumeBill, useUnarchiveBill } from "./useBills";

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
