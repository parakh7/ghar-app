import { useState } from "react";
import { Link } from "react-router-dom";
import { ListChecks } from "lucide-react";
import type { CompletionStatus } from "@household/shared";
import { ApiError } from "../../../lib/api";
import { Alert } from "../../../components/Alert";
import { Button } from "../../../components/Button";
import { EmptyState } from "../../../components/EmptyState";
import { useActiveHousehold } from "../useActiveHousehold";
import { useHousehold } from "../members/useMembers";
import { useClearCompletion, useMarkCompletion, useTodayChecklist } from "./useChecklistCompletion";
import { usePendingKeys } from "../../../lib/offline-queue";

type MarkableStatus = "COMPLETED" | "SKIPPED";

function labelOf(status: CompletionStatus | null): string {
  if (status === "COMPLETED") return "Done";
  if (status === "SKIPPED") return "Skipped";
  return "Not marked";
}

function toneOf(status: CompletionStatus | null): "ok" | "neutral" | "muted" {
  if (status === "COMPLETED") return "ok";
  if (status === "SKIPPED") return "neutral";
  return "muted";
}

function messageFrom(err: unknown): string {
  return err instanceof ApiError ? err.message : "Something went wrong. Please try again.";
}

const PICKER_OPTIONS: { value: MarkableStatus | null; label: string }[] = [
  { value: "COMPLETED", label: "Done" },
  { value: "SKIPPED", label: "Skipped" },
  { value: null, label: "Not marked" },
];

function CompletionPicker({ status, onSelect }: { status: CompletionStatus | null; onSelect: (status: MarkableStatus | null) => void }) {
  return (
    <div className="chips" role="group" aria-label="Completion status">
      {PICKER_OPTIONS.map((opt) => (
        <button key={opt.label} type="button" className="chip" aria-pressed={status === opt.value} onClick={() => onSelect(opt.value)}>
          {opt.label}
        </button>
      ))}
    </div>
  );
}

export function ChecklistTodayPage() {
  const { household: active } = useActiveHousehold();
  const householdId = active?.id;
  const householdQuery = useHousehold(householdId);
  const todayQuery = useTodayChecklist(householdId);
  const markCompletion = useMarkCompletion(householdId ?? "");
  const clearCompletion = useClearCompletion(householdId ?? "");
  const pendingKeys = usePendingKeys();
  const canMark = householdQuery.data?.permissions.includes("checklists.complete") ?? false;
  const [openFor, setOpenFor] = useState<string | null>(null);
  const [pageError, setPageError] = useState<string | null>(null);
  const [poppedId, setPoppedId] = useState<string | null>(null);

  if (!householdId || !todayQuery.data) return null;
  const { date, entries } = todayQuery.data;

  function onTap(taskId: string, current: CompletionStatus | null) {
    if (current !== null) return;
    markCompletion.mutate(
      { taskId, body: { date, status: "COMPLETED" } },
      { onSuccess: () => setPoppedId(taskId), onError: (err) => setPageError(messageFrom(err)) },
    );
  }

  function onSkip(taskId: string) {
    markCompletion.mutate(
      { taskId, body: { date, status: "SKIPPED" } },
      { onSuccess: () => setPoppedId(taskId), onError: (err) => setPageError(messageFrom(err)) },
    );
  }

  function onClearBadge(taskId: string, current: CompletionStatus | null) {
    if (current === null) return;
    clearCompletion.mutate(
      { taskId, date },
      { onSuccess: () => setPoppedId(taskId), onError: (err) => setPageError(messageFrom(err)) },
    );
  }

  function onPick(taskId: string, status: MarkableStatus | null) {
    setOpenFor(null);
    if (status === null) {
      clearCompletion.mutate(
        { taskId, date },
        { onSuccess: () => setPoppedId(taskId), onError: (err) => setPageError(messageFrom(err)) },
      );
    } else {
      markCompletion.mutate(
        { taskId, body: { date, status } },
        { onSuccess: () => setPoppedId(taskId), onError: (err) => setPageError(messageFrom(err)) },
      );
    }
  }

  return (
    <>
      <header className="page-head"><h1 className="page-title">Today's checklist</h1></header>
      {pageError && <Alert tone="error" title={pageError} />}

      {entries.length === 0 && (
        <div className="card">
          <EmptyState icon={<ListChecks size={22} />} title="Nothing due today" text="Tasks due today will show up here for one-tap marking." />
        </div>
      )}

      <div className="list">
        {entries.map((e) => (
          <div key={e.taskId}>
            <div className="list__item">
              <button
                type="button"
                className="list__text"
                style={{ textAlign: "left", background: "none", border: 0, padding: 0, cursor: canMark ? "pointer" : "default" }}
                disabled={!canMark}
                onClick={() => onTap(e.taskId, e.status)}
              >
                <span className="list__label" style={{ display: "block" }}>{e.name}</span>
              </button>
              {canMark && e.status === null && (
                <Button variant="ghost" onClick={() => onSkip(e.taskId)}>Skip</Button>
              )}
              <button
                type="button"
                className={`badge badge--${toneOf(e.status)}${poppedId === e.taskId ? " pop-in" : ""}`}
                style={{ border: 0, font: "inherit", cursor: canMark && e.status !== null ? "pointer" : "default" }}
                disabled={!canMark || e.status === null}
                onAnimationEnd={() => setPoppedId((id) => (id === e.taskId ? null : id))}
                onClick={() => onClearBadge(e.taskId, e.status)}
              >
                {labelOf(e.status)}
                {pendingKeys.has(`checklist:${e.taskId}:${date}`) && (
                  <span aria-label="Not yet synced" title="Will sync when you're back online"> ⏳</span>
                )}
              </button>
              {canMark && <Button variant="ghost" onClick={() => setOpenFor(openFor === e.taskId ? null : e.taskId)}>More</Button>}
            </div>
            {openFor === e.taskId && (
              <div style={{ padding: "0 var(--space-4) var(--space-3)" }}>
                <CompletionPicker status={e.status} onSelect={(status) => onPick(e.taskId, status)} />
              </div>
            )}
          </div>
        ))}
      </div>

      <div style={{ marginTop: "var(--space-4)" }}><Link to="/checklist" className="list__label">Back to checklist</Link></div>
    </>
  );
}
