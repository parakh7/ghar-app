import { useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { ApiError } from "../../../lib/api";
import { Alert } from "../../../components/Alert";
import { Button } from "../../../components/Button";
import { useActiveHousehold } from "../useActiveHousehold";
import { useHousehold } from "../members/useMembers";
import { useHousehelps } from "../househelps/useHousehelps";
import { formatFrequency } from "./frequency";
import { useArchiveChecklistTask, useChecklistAssignments, useChecklistTask, usePutChecklistAssignments, useUnarchiveChecklistTask } from "./useChecklist";

function messageFrom(err: unknown): string {
  return err instanceof ApiError ? err.message : "Something went wrong. Please try again.";
}

export function ChecklistTaskDetailPage() {
  const { id } = useParams();
  const navigate = useNavigate();
  const { household: active } = useActiveHousehold();
  const householdId = active?.id;
  const householdQuery = useHousehold(householdId);
  const taskQuery = useChecklistTask(householdId, id);
  const househelpsQuery = useHousehelps(householdId, false);
  const assignmentsQuery = useChecklistAssignments(householdId, id);
  const archive = useArchiveChecklistTask(householdId ?? "");
  const unarchive = useUnarchiveChecklistTask(householdId ?? "");
  const putAssignments = usePutChecklistAssignments(householdId ?? "", id ?? "");
  const canManage = householdQuery.data?.permissions.includes("checklists.manage") ?? false;
  const [pageError, setPageError] = useState<string | null>(null);
  const [selected, setSelected] = useState<string[] | null>(null);

  if (!householdId || !taskQuery.data) return null;
  const t = taskQuery.data;
  const currentIds = selected ?? assignmentsQuery.data ?? [];

  function toggle(hId: string) {
    setSelected(currentIds.includes(hId) ? currentIds.filter((x) => x !== hId) : [...currentIds, hId]);
  }

  function onSaveAssignments() {
    putAssignments.mutate({ househelpIds: currentIds }, { onError: (err) => setPageError(messageFrom(err)) });
  }

  function onArchive() {
    if (!window.confirm(`Remove ${t.name}? Its history stays, but it'll drop off the main list.`)) return;
    archive.mutate(id!, { onError: (err) => setPageError(messageFrom(err)) });
  }

  return (
    <>
      <header className="page-head"><h1 className="page-title">{t.name}</h1></header>
      {pageError && <Alert tone="error" title={pageError} />}
      {t.archivedAt && <Alert tone="info" title="This task is archived." />}

      <div className="list">
        <div className="list__item"><span className="list__text"><span className="list__label" style={{ display: "block" }}>Repeats</span><span className="list__meta">{formatFrequency(t)}</span></span></div>
        <div className="list__item"><span className="list__text"><span className="list__label" style={{ display: "block" }}>Priority</span><span className="list__meta">{t.priority}</span></span></div>
        {t.description && <div className="list__item"><span className="list__text"><span className="list__label" style={{ display: "block" }}>Description</span><span className="list__meta">{t.description}</span></span></div>}
      </div>

      {(househelpsQuery.data?.length ?? 0) > 0 && (
        <div className="field" style={{ marginTop: "var(--space-6)" }}>
          <span className="field__label">Assigned to</span>
          <div className="chips">
            {househelpsQuery.data!.map((h) => (
              <button key={h.id} type="button" className="chip" aria-pressed={currentIds.includes(h.id)} disabled={!canManage} onClick={() => canManage && toggle(h.id)}>{h.name}</button>
            ))}
          </div>
          {canManage && (
            <div style={{ marginTop: "var(--space-3)" }}>
              <Button variant="secondary" loading={putAssignments.isPending} onClick={onSaveAssignments}>Save assignment</Button>
            </div>
          )}
        </div>
      )}

      {canManage && (
        <div style={{ marginTop: "var(--space-6)", display: "grid", gap: "var(--space-3)" }}>
          <Button variant="secondary" block onClick={() => navigate(`/checklist/${id}/edit`)}>Edit details</Button>
          {t.archivedAt ? (
            <Button variant="secondary" block loading={unarchive.isPending} onClick={() => unarchive.mutate(id!, { onError: (err) => setPageError(messageFrom(err)) })}>Restore</Button>
          ) : (
            <Button variant="danger" block loading={archive.isPending} onClick={onArchive}>Remove task</Button>
          )}
        </div>
      )}
      <div style={{ marginTop: "var(--space-4)" }}><Button variant="ghost" onClick={() => navigate("/checklist")}>Back to checklist</Button></div>
    </>
  );
}
