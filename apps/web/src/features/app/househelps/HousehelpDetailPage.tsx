import { useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { formatINR } from "@household/shared";
import { ApiError } from "../../../lib/api";
import { Alert } from "../../../components/Alert";
import { Button } from "../../../components/Button";
import { useActiveHousehold } from "../useActiveHousehold";
import { useHousehold } from "../members/useMembers";
import { useArchiveHousehelp, useCategories, useHousehelp, useUnarchiveHousehelp } from "./useHousehelps";

function messageFrom(err: unknown): string {
  return err instanceof ApiError ? err.message : "Something went wrong. Please try again.";
}

export function HousehelpDetailPage() {
  const { id } = useParams();
  const navigate = useNavigate();
  const { household: active } = useActiveHousehold();
  const householdId = active?.id;
  const householdQuery = useHousehold(householdId);
  const househelpQuery = useHousehelp(householdId, id);
  const categoriesQuery = useCategories(householdId);
  const archive = useArchiveHousehelp(householdId ?? "");
  const unarchive = useUnarchiveHousehelp(householdId ?? "");
  const canManage = householdQuery.data?.permissions.includes("househelps.manage") ?? false;
  const [pageError, setPageError] = useState<string | null>(null);

  function onArchive() {
    if (!window.confirm(`Remove ${househelpQuery.data?.name}? Their history stays, but they'll drop off the main list.`)) return;
    archive.mutate(id!, { onError: (err) => setPageError(messageFrom(err)) });
  }

  if (!householdId || !househelpQuery.data) return null;
  const h = househelpQuery.data;
  const categoryNames = (categoriesQuery.data ?? []).filter((c) => h.categoryIds.includes(c.id)).map((c) => c.name);

  return (
    <>
      <header className="page-head"><h1 className="page-title">{h.name}</h1></header>
      {pageError && <Alert tone="error" title={pageError} />}
      {h.archivedAt && <Alert tone="info" title="This househelp is archived." />}

      <div className="list">
        <div className="list__item"><span className="list__text"><span className="list__label" style={{ display: "block" }}>Role</span><span className="list__meta">{h.roleTitle ?? "—"}</span></span></div>
        <div className="list__item"><span className="list__text"><span className="list__label" style={{ display: "block" }}>Phone</span><span className="list__meta">{h.phone ?? "—"}</span></span></div>
        <div className="list__item"><span className="list__text"><span className="list__label" style={{ display: "block" }}>Status</span><span className="list__meta">{h.status === "ACTIVE" ? "Active" : "Inactive"}</span></span></div>
        <div className="list__item"><span className="list__text"><span className="list__label" style={{ display: "block" }}>Salary</span><span className="list__meta">{h.monthlySalaryPaise != null ? formatINR(h.monthlySalaryPaise) + "/month" : h.dailyRatePaise != null ? formatINR(h.dailyRatePaise) + "/day" : "—"}</span></span></div>
        <div className="list__item">
          <span className="list__text">
            <span className="list__label" style={{ display: "block" }}>Categories</span>
            <span className="list__meta">
              {categoryNames.length > 0
                ? categoryNames.map((name) => <span key={name} className="badge badge--neutral" style={{ marginRight: "var(--space-1)" }}>{name}</span>)
                : "—"}
            </span>
          </span>
        </div>
      </div>

      {canManage && (
        <div style={{ marginTop: "var(--space-6)", display: "grid", gap: "var(--space-3)" }}>
          <Button variant="secondary" block onClick={() => navigate(`/househelps/${id}/edit`)}>Edit details</Button>
          <Button variant="secondary" block onClick={() => navigate(`/househelps/${id}/schedule`)}>Set schedule</Button>
          <Button variant="secondary" block onClick={() => navigate(`/househelps/${id}/attendance`)}>View attendance</Button>
          <Button variant="secondary" block onClick={() => navigate(`/salary?househelpId=${id}`)}>View salary</Button>
          {h.archivedAt ? (
            <Button variant="secondary" block loading={unarchive.isPending} onClick={() => unarchive.mutate(id!, { onError: (err) => setPageError(messageFrom(err)) })}>Restore</Button>
          ) : (
            <Button variant="danger" block loading={archive.isPending} onClick={onArchive}>Remove househelp</Button>
          )}
        </div>
      )}
      <div style={{ marginTop: "var(--space-4)" }}><Button variant="ghost" onClick={() => navigate("/househelps")}>Back to list</Button></div>
    </>
  );
}
