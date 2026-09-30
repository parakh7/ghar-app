import { useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { ChevronLeft, ChevronRight } from "lucide-react";
import type { AttendanceStatus } from "@household/shared";
import { dateInZone } from "@household/shared";
import { ApiError } from "../../../lib/api";
import { Alert } from "../../../components/Alert";
import { Button } from "../../../components/Button";
import { useActiveHousehold } from "../useActiveHousehold";
import { useHousehold } from "../members/useMembers";
import { useHousehelp, useSchedule } from "../househelps/useHousehelps";
import { AttendancePicker } from "./AttendancePicker";
import { toneOf } from "./statusTone";
import { useClearAttendance, useMonthAttendance, useSetAttendance } from "./useAttendance";

function messageFrom(err: unknown): string {
  return err instanceof ApiError ? err.message : "Something went wrong. Please try again.";
}

function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

/** 0=Mon … 6=Sun, so the grid's first column is always Monday. */
function firstWeekdayIndex(year: number, month: number): number {
  return (new Date(Date.UTC(year, month - 1, 1)).getUTCDay() + 6) % 7;
}

/** 1=Mon … 7=Sun, matching `attendance_schedules.weekdays`'s convention. */
function isoWeekdayOf(date: string): number {
  return ((new Date(`${date}T00:00:00Z`).getUTCDay() + 6) % 7) + 1;
}

function shiftMonth(month: string, delta: number): string {
  const [y, m] = month.split("-").map(Number);
  const total = (y! * 12 + (m! - 1)) + delta;
  return `${Math.floor(total / 12)}-${String((total % 12) + 1).padStart(2, "0")}`;
}

function monthLabel(month: string): string {
  const [y, m] = month.split("-").map(Number);
  return new Date(Date.UTC(y!, m! - 1, 1)).toLocaleDateString("en-IN", { month: "long", year: "numeric", timeZone: "UTC" });
}

export function HousehelpCalendarPage() {
  const { id } = useParams();
  const navigate = useNavigate();
  const { household: active } = useActiveHousehold();
  const householdId = active?.id;
  const householdQuery = useHousehold(householdId);
  const househelpQuery = useHousehelp(householdId, id);
  const scheduleQuery = useSchedule(householdId, id);
  const [month, setMonth] = useState(() => dateInZone(new Date(), active?.timezone ?? "Asia/Kolkata").slice(0, 7));
  const monthQuery = useMonthAttendance(householdId, id, month);
  const setAttendance = useSetAttendance(householdId ?? "");
  const clearAttendance = useClearAttendance(householdId ?? "");
  const canEditHistory = householdQuery.data?.permissions.includes("attendance.editHistory") ?? false;
  const canMarkToday = householdQuery.data?.permissions.includes("attendance.mark") ?? false;
  const [openDate, setOpenDate] = useState<string | null>(null);
  const [pageError, setPageError] = useState<string | null>(null);

  if (!householdId || !id || !househelpQuery.data) return null;

  const today = dateInZone(new Date(), active?.timezone ?? "Asia/Kolkata");
  const [year, m] = month.split("-").map(Number);
  const total = daysInMonth(year!, m!);
  const lead = firstWeekdayIndex(year!, m!);
  const byDate = new Map((monthQuery.data ?? []).map((r) => [r.date, r]));
  const scheduledWeekdays = new Set(scheduleQuery.data?.weekdays ?? []);

  function canEditDate(d: string): boolean {
    return d === today ? canMarkToday : canEditHistory;
  }

  function onPick(d: string, status: AttendanceStatus | null) {
    setOpenDate(null);
    if (status === null) clearAttendance.mutate({ househelpId: id!, date: d }, { onError: (err) => setPageError(messageFrom(err)) });
    else setAttendance.mutate({ househelpId: id!, body: { date: d, status } }, { onError: (err) => setPageError(messageFrom(err)) });
  }

  return (
    <>
      <header className="page-head"><h1 className="page-title">{househelpQuery.data.name}'s attendance</h1></header>
      {pageError && <Alert tone="error" title={pageError} />}

      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: "var(--space-4)" }}>
        <Button variant="ghost" icon={<ChevronLeft size={20} aria-hidden />} onClick={() => setMonth(shiftMonth(month, -1))}>Previous</Button>
        <strong>{monthLabel(month)}</strong>
        <Button variant="ghost" icon={<ChevronRight size={20} aria-hidden />} onClick={() => setMonth(shiftMonth(month, 1))}>Next</Button>
      </div>

      <div className="cal__grid">
        {Array.from({ length: lead }).map((_, i) => <div key={`lead-${i}`} />)}
        {Array.from({ length: total }, (_, i) => i + 1).map((day) => {
          const d = `${month}-${String(day).padStart(2, "0")}`;
          const record = byDate.get(d);
          const dim = !scheduledWeekdays.has(isoWeekdayOf(d));
          return (
            <button
              key={d}
              type="button"
              className={["cal__day", `cal__day--${toneOf(record?.status ?? null)}`, dim && "cal__day--dim"].filter(Boolean).join(" ")}
              disabled={!canEditDate(d)}
              onClick={() => setOpenDate(openDate === d ? null : d)}
            >
              {day}
            </button>
          );
        })}
      </div>

      {openDate && (
        <div style={{ marginTop: "var(--space-4)" }}>
          <AttendancePicker status={byDate.get(openDate)?.status ?? null} onSelect={(status) => onPick(openDate, status)} />
        </div>
      )}

      <div style={{ marginTop: "var(--space-6)" }}><Button variant="ghost" onClick={() => navigate(`/househelps/${id}`)}>Back to {househelpQuery.data.name}</Button></div>
    </>
  );
}
