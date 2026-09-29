import { useState } from "react";
import { Navigate, useNavigate, useParams } from "react-router-dom";
import { updateScheduleSchema } from "@household/shared";
import { Alert } from "../../../components/Alert";
import { Button } from "../../../components/Button";
import { TextField } from "../../../components/TextField";
import { useFormErrors } from "../../auth/useFormErrors";
import { zodFieldErrors } from "../../auth/zod-errors";
import { useActiveHousehold } from "../useActiveHousehold";
import { useHousehold } from "../members/useMembers";
import { useHousehelp, useSchedule, useUpdateSchedule } from "./useHousehelps";

const WEEKDAYS = [
  { value: 1, label: "Monday" }, { value: 2, label: "Tuesday" }, { value: 3, label: "Wednesday" },
  { value: 4, label: "Thursday" }, { value: 5, label: "Friday" }, { value: 6, label: "Saturday" }, { value: 7, label: "Sunday" },
] as const;

export function ScheduleEditorPage() {
  const { id } = useParams();
  const navigate = useNavigate();
  const { household: active } = useActiveHousehold();
  const householdId = active?.id;
  const householdQuery = useHousehold(householdId);
  const canManage = householdQuery.data?.permissions.includes("househelps.manage") ?? false;
  const househelpQuery = useHousehelp(householdId, id);
  const scheduleQuery = useSchedule(householdId, id);
  const updateSchedule = useUpdateSchedule(householdId ?? "", id ?? "");
  const errors = useFormErrors();

  const [weekdays, setWeekdays] = useState<number[]>([]);
  const [startTime, setStartTime] = useState("");
  const [endTime, setEndTime] = useState("");
  const [seeded, setSeeded] = useState(false);

  // Seed form state from the loaded schedule once. The tracker starts at a constant (`false`),
  // never at the query value itself — if the cache is already warm at mount (the normal
  // navigation path: save a schedule, go back, reopen the editor), `scheduleQuery.data` is
  // populated on the very first render, and a tracker initialized from that same value would
  // equal it immediately, so the seeding block would never run and the form would render blank.
  // Updating state during render (guarded by `!seeded`) rather than in a useEffect avoids an
  // extra commit-and-rerender pass for this one-time initialization.
  if (scheduleQuery.data && !seeded) {
    setSeeded(true);
    setWeekdays(scheduleQuery.data.weekdays);
    setStartTime(scheduleQuery.data.startTime ?? "");
    setEndTime(scheduleQuery.data.endTime ?? "");
  }

  function toggleDay(day: number) {
    setWeekdays((days) => (days.includes(day) ? days.filter((d) => d !== day) : [...days, day]));
  }

  function onSave() {
    errors.clear();
    const body = { weekdays, startTime: startTime || undefined, endTime: endTime || undefined };
    const parsed = updateScheduleSchema.safeParse(body);
    if (!parsed.success) return errors.setFields(zodFieldErrors(parsed.error));
    updateSchedule.mutate(parsed.data, { onSuccess: () => navigate(`/househelps/${id}`), onError: errors.fromError });
  }

  if (!householdId) return null;
  if (householdQuery.data && !canManage) return <Navigate to="/househelps" replace />;

  return (
    <>
      <header className="page-head"><h1 className="page-title">Schedule{househelpQuery.data && ` — ${househelpQuery.data.name}`}</h1></header>
      {errors.formError && <Alert tone="error" title={errors.formError} />}

      <div className="field">
        <span className="field__label">Working days</span>
        <div className="chips">
          {WEEKDAYS.map((d) => (
            <button key={d.value} type="button" className="chip" aria-pressed={weekdays.includes(d.value)} onClick={() => toggleDay(d.value)}>{d.label}</button>
          ))}
        </div>
        {errors.fieldErrors.weekdays && <p className="field__error">{errors.fieldErrors.weekdays}</p>}
      </div>

      <TextField label="Start time" hint="24-hour, e.g. 09:00" value={startTime} onChange={(e) => setStartTime(e.target.value)} error={errors.fieldErrors.startTime} />
      <TextField label="End time" hint="24-hour, e.g. 13:00" value={endTime} onChange={(e) => setEndTime(e.target.value)} error={errors.fieldErrors.endTime} />

      <div style={{ marginTop: "var(--space-6)" }}>
        <Button block loading={updateSchedule.isPending} onClick={onSave}>Save schedule</Button>
      </div>
    </>
  );
}
