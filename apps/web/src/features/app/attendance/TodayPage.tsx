import { useState } from "react";
import { Link } from "react-router-dom";
import { Users } from "lucide-react";
import type { AttendanceStatus } from "@household/shared";
import { ApiError } from "../../../lib/api";
import { Alert } from "../../../components/Alert";
import { Button } from "../../../components/Button";
import { EmptyState } from "../../../components/EmptyState";
import { useActiveHousehold } from "../useActiveHousehold";
import { useHousehold } from "../members/useMembers";
import { AttendancePicker } from "./AttendancePicker";
import { STATUS_LABEL, toneOf } from "./statusTone";
import { useClearAttendance, useMarkHoliday, useSetAttendance, useTodayAttendance } from "./useAttendance";
import { usePendingKeys } from "../../../lib/offline-queue";

function messageFrom(err: unknown): string {
  return err instanceof ApiError ? err.message : "Something went wrong. Please try again.";
}

export function TodayPage() {
  const { household: active } = useActiveHousehold();
  const householdId = active?.id;
  const householdQuery = useHousehold(householdId);
  const todayQuery = useTodayAttendance(householdId);
  const setAttendance = useSetAttendance(householdId ?? "");
  const clearAttendance = useClearAttendance(householdId ?? "");
  const markHoliday = useMarkHoliday(householdId ?? "");
  const pendingKeys = usePendingKeys();
  const canMark = householdQuery.data?.permissions.includes("attendance.mark") ?? false;
  const [openFor, setOpenFor] = useState<string | null>(null);
  const [pageError, setPageError] = useState<string | null>(null);
  const [poppedId, setPoppedId] = useState<string | null>(null);

  if (!householdId || !todayQuery.data) return null;
  const { date, entries } = todayQuery.data;

  function onTap(househelpId: string, current: AttendanceStatus | null) {
    const next: AttendanceStatus = current === "PRESENT" ? "ABSENT" : "PRESENT";
    setAttendance.mutate(
      { househelpId, body: { date, status: next } },
      { onSuccess: () => setPoppedId(househelpId), onError: (err) => setPageError(messageFrom(err)) },
    );
  }

  function onPick(househelpId: string, status: AttendanceStatus | null) {
    setOpenFor(null);
    if (status === null) {
      clearAttendance.mutate(
        { househelpId, date },
        { onSuccess: () => setPoppedId(househelpId), onError: (err) => setPageError(messageFrom(err)) },
      );
    } else {
      setAttendance.mutate(
        { househelpId, body: { date, status } },
        { onSuccess: () => setPoppedId(househelpId), onError: (err) => setPageError(messageFrom(err)) },
      );
    }
  }

  function onMarkHoliday() {
    const alreadyMarked = entries.filter((e) => e.status !== null && e.status !== "HOLIDAY").length;
    const question = alreadyMarked > 0 ? `${alreadyMarked} already marked — overwrite everyone with Holiday?` : "Mark today as a holiday for everyone?";
    if (!window.confirm(question)) return;
    markHoliday.mutate(date, { onError: (err) => setPageError(messageFrom(err)) });
  }

  return (
    <>
      <header className="page-head"><h1 className="page-title">Today's attendance</h1></header>
      {pageError && <Alert tone="error" title={pageError} />}

      {canMark && entries.length > 0 && (
        <div style={{ marginBottom: "var(--space-4)" }}>
          <Button variant="secondary" loading={markHoliday.isPending} onClick={onMarkHoliday}>Mark today as holiday</Button>
        </div>
      )}

      {entries.length === 0 && (
        <div className="card">
          <EmptyState icon={<Users size={22} />} title="No househelps yet" text="Add a househelp to start marking daily attendance." />
        </div>
      )}

      <div className="list">
        {entries.map((e) => (
          <div key={e.househelpId}>
            <div className="list__item">
              <button
                type="button"
                className="list__text"
                style={{ textAlign: "left", background: "none", border: 0, padding: 0, cursor: canMark ? "pointer" : "default" }}
                disabled={!canMark}
                onClick={() => onTap(e.househelpId, e.status)}
              >
                <span className="list__label" style={{ display: "block" }}>{e.name}{!e.scheduledToday && " (not scheduled today)"}</span>
                <span className="list__meta">{e.roleTitle ?? "Househelp"}</span>
              </button>
              <span
                className={`badge badge--${toneOf(e.status)}${poppedId === e.househelpId ? " pop-in" : ""}`}
                onAnimationEnd={() => setPoppedId((id) => (id === e.househelpId ? null : id))}
              >
                {e.status ? STATUS_LABEL[e.status] : "Not marked"}
                {pendingKeys.has(`attendance:${e.househelpId}:${date}`) && (
                  <span aria-label="Not yet synced" title="Will sync when you're back online"> ⏳</span>
                )}
              </span>
              {canMark && <Button variant="ghost" onClick={() => setOpenFor(openFor === e.househelpId ? null : e.househelpId)}>More</Button>}
            </div>
            {openFor === e.househelpId && (
              <div style={{ padding: "0 var(--space-4) var(--space-3)" }}>
                <AttendancePicker status={e.status} onSelect={(status) => onPick(e.househelpId, status)} />
              </div>
            )}
          </div>
        ))}
      </div>

      <div style={{ marginTop: "var(--space-4)" }}><Link to="/househelps" className="list__label">Back to househelps</Link></div>
    </>
  );
}
