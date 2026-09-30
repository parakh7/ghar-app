import { useState, type ChangeEvent, type FormEvent } from "react";
import { Navigate, useNavigate, useParams } from "react-router-dom";
import { createChecklistTaskSchema, updateChecklistTaskSchema } from "@household/shared";
import { Alert } from "../../../components/Alert";
import { Button } from "../../../components/Button";
import { TextField } from "../../../components/TextField";
import { useFormErrors } from "../../auth/useFormErrors";
import { zodFieldErrors } from "../../auth/zod-errors";
import { useActiveHousehold } from "../useActiveHousehold";
import { useHousehold } from "../members/useMembers";
import { useCategories } from "../househelps/useHousehelps";
import { useChecklistTask, useCreateChecklistTask, useUpdateChecklistTask } from "./useChecklist";

const FREQUENCIES = [
  { value: "DAILY", label: "Every day" },
  { value: "WEEKDAYS", label: "Weekdays (Mon–Fri)" },
  { value: "WEEKLY", label: "Specific weekdays" },
  { value: "MONTHLY", label: "Monthly" },
  { value: "SPECIFIC_DATE", label: "One-time, on a date" },
  { value: "CUSTOM", label: "Every N days" },
] as const;

const PRIORITIES = [{ value: "LOW", label: "Low" }, { value: "NORMAL", label: "Normal" }, { value: "HIGH", label: "High" }] as const;

const WEEKDAYS = [
  { value: 1, label: "Monday" }, { value: 2, label: "Tuesday" }, { value: 3, label: "Wednesday" },
  { value: 4, label: "Thursday" }, { value: 5, label: "Friday" }, { value: 6, label: "Saturday" }, { value: 7, label: "Sunday" },
] as const;

export function ChecklistTaskFormPage({ mode }: { mode: "create" | "edit" }) {
  const { id } = useParams();
  const navigate = useNavigate();
  const { household: active } = useActiveHousehold();
  const householdId = active?.id;
  const householdQuery = useHousehold(householdId);
  const canManage = householdQuery.data?.permissions.includes("checklists.manage") ?? false;
  const categoriesQuery = useCategories(householdId);
  const existing = useChecklistTask(householdId, mode === "edit" ? id : undefined);
  const createTask = useCreateChecklistTask(householdId ?? "");
  const updateTask = useUpdateChecklistTask(householdId ?? "");
  const errors = useFormErrors();

  const [form, setForm] = useState({
    name: "", description: "", categoryId: "", frequency: "DAILY" as (typeof FREQUENCIES)[number]["value"],
    dayOfMonth: "1", specificDate: "", intervalDays: "1", anchorDate: "", preferredTime: "",
    priority: "NORMAL" as (typeof PRIORITIES)[number]["value"],
  });
  const [weekdays, setWeekdays] = useState<number[]>([]);
  const [seeded, setSeeded] = useState(false);

  // Seed form state from the loaded task once — same pattern as HousehelpFormPage/ScheduleEditorPage:
  // the tracker starts at a constant, never at the query value, so a warm cache at mount still runs
  // the seeding block instead of rendering blank.
  if (mode === "edit" && existing.data && !seeded) {
    const t = existing.data;
    setSeeded(true);
    setForm({
      name: t.name, description: t.description ?? "", categoryId: t.categoryId ?? "", frequency: t.frequency,
      dayOfMonth: String(t.dayOfMonth ?? 1), specificDate: t.specificDate ?? "",
      intervalDays: String(t.intervalDays ?? 1), anchorDate: t.anchorDate ?? "", preferredTime: t.preferredTime ?? "",
      priority: t.priority,
    });
    setWeekdays(t.weekdays ?? []);
  }

  function set<K extends keyof typeof form>(key: K) {
    return (e: ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>) => setForm((f) => ({ ...f, [key]: e.target.value }));
  }

  function toggleWeekday(day: number) {
    setWeekdays((days) => (days.includes(day) ? days.filter((d) => d !== day) : [...days, day]));
  }

  function onSubmit(e: FormEvent) {
    e.preventDefault();
    errors.clear();

    const configByFrequency: Record<string, Record<string, unknown>> = {
      DAILY: {}, WEEKDAYS: {}, WEEKLY: { weekdays },
      MONTHLY: { dayOfMonth: form.dayOfMonth ? Number(form.dayOfMonth) : undefined },
      SPECIFIC_DATE: { specificDate: form.specificDate || undefined },
      CUSTOM: { intervalDays: form.intervalDays ? Number(form.intervalDays) : undefined, anchorDate: form.anchorDate || undefined },
    };

    const common = {
      name: form.name, description: form.description || undefined, categoryId: form.categoryId || undefined,
      frequency: form.frequency, preferredTime: form.preferredTime || undefined, priority: form.priority,
      ...configByFrequency[form.frequency],
    };

    if (mode === "create") {
      const parsed = createChecklistTaskSchema.safeParse(common);
      if (!parsed.success) return errors.setFields(zodFieldErrors(parsed.error));
      createTask.mutate(parsed.data, { onSuccess: (result) => navigate(`/checklist/${result.data.id}`, { replace: true }), onError: errors.fromError });
    } else {
      const body = { ...common, description: form.description.trim() ? form.description : null, categoryId: form.categoryId || null, preferredTime: form.preferredTime || null };
      const parsed = updateChecklistTaskSchema.safeParse(body);
      if (!parsed.success) return errors.setFields(zodFieldErrors(parsed.error));
      updateTask.mutate({ id: id!, body: parsed.data }, { onSuccess: () => navigate(`/checklist/${id}`, { replace: true }), onError: errors.fromError });
    }
  }

  if (!householdId) return null;
  if (householdQuery.data && !canManage) return <Navigate to="/checklist" replace />;

  return (
    <>
      <header className="page-head"><h1 className="page-title">{mode === "create" ? "Add task" : "Edit task"}</h1></header>
      <form className="auth__form" onSubmit={onSubmit} noValidate>
        {errors.formError && <Alert tone="error" title={errors.formError} />}
        <TextField label="Name" value={form.name} onChange={set("name")} error={errors.fieldErrors.name} autoFocus />
        <TextField label="Description" value={form.description} onChange={set("description")} error={errors.fieldErrors.description} />

        <div className="field">
          <label className="field__label" htmlFor="frequency">Repeats</label>
          <select id="frequency" className="input" value={form.frequency} onChange={set("frequency")}>
            {FREQUENCIES.map((f) => <option key={f.value} value={f.value}>{f.label}</option>)}
          </select>
        </div>

        {form.frequency === "WEEKLY" && (
          <div className="field">
            <span className="field__label">Which days</span>
            <div className="chips">
              {WEEKDAYS.map((d) => (
                <button key={d.value} type="button" className="chip" aria-pressed={weekdays.includes(d.value)} onClick={() => toggleWeekday(d.value)}>{d.label}</button>
              ))}
            </div>
            {errors.fieldErrors.weekdays && <p className="field__error">{errors.fieldErrors.weekdays}</p>}
          </div>
        )}
        {form.frequency === "MONTHLY" && (
          <TextField label="Day of month" hint="1-31" inputMode="numeric" value={form.dayOfMonth} onChange={set("dayOfMonth")} error={errors.fieldErrors.dayOfMonth} />
        )}
        {form.frequency === "SPECIFIC_DATE" && (
          <TextField label="Date" type="date" value={form.specificDate} onChange={set("specificDate")} error={errors.fieldErrors.specificDate} />
        )}
        {form.frequency === "CUSTOM" && (
          <>
            <TextField label="Repeat every N days" inputMode="numeric" value={form.intervalDays} onChange={set("intervalDays")} error={errors.fieldErrors.intervalDays} />
            <TextField label="Starting from" type="date" value={form.anchorDate} onChange={set("anchorDate")} error={errors.fieldErrors.anchorDate} />
          </>
        )}

        <TextField label="Preferred time" hint="24-hour, e.g. 09:00 (optional)" value={form.preferredTime} onChange={set("preferredTime")} error={errors.fieldErrors.preferredTime} />

        <div className="field">
          <label className="field__label" htmlFor="priority">Priority</label>
          <select id="priority" className="input" value={form.priority} onChange={set("priority")}>
            {PRIORITIES.map((p) => <option key={p.value} value={p.value}>{p.label}</option>)}
          </select>
        </div>

        {(categoriesQuery.data?.length ?? 0) > 0 && (
          <div className="field">
            <label className="field__label" htmlFor="category">Category</label>
            <select id="category" className="input" value={form.categoryId} onChange={set("categoryId")}>
              <option value="">No category</option>
              {categoriesQuery.data!.filter((c) => c.isActive).map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
          </div>
        )}

        <Button type="submit" block loading={createTask.isPending || updateTask.isPending}>
          {mode === "create" ? "Add task" : "Save changes"}
        </Button>
      </form>
    </>
  );
}
