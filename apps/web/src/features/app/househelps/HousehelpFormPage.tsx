import { useState, type FormEvent } from "react";
import { Navigate, useNavigate, useParams } from "react-router-dom";
import { createHousehelpSchema, MoneyError, rupeesToPaise, updateHousehelpSchema } from "@household/shared";
import { Alert } from "../../../components/Alert";
import { Button } from "../../../components/Button";
import { TextField } from "../../../components/TextField";
import { useFormErrors } from "../../auth/useFormErrors";
import { zodFieldErrors } from "../../auth/zod-errors";
import { useActiveHousehold } from "../useActiveHousehold";
import { useHousehold } from "../members/useMembers";
import { useCategories, useCreateHousehelp, useHousehelp, useUpdateHousehelp } from "./useHousehelps";

const SALARY_MODES = [
  { value: "FIXED_MONTHLY", label: "Fixed monthly" },
  { value: "ATTENDANCE_BASED", label: "Attendance-based monthly" },
  { value: "DAILY_RATE", label: "Daily rate" },
] as const;

function paiseToInput(paise: number | null | undefined): string {
  return paise == null ? "" : (paise / 100).toFixed(2);
}

const AMOUNT_HINT = "Enter a valid rupee amount, e.g. 1500 or 1,500.50";

export function HousehelpFormPage({ mode }: { mode: "create" | "edit" }) {
  const { id } = useParams();
  const navigate = useNavigate();
  const { household: active } = useActiveHousehold();
  const householdId = active?.id;
  const householdQuery = useHousehold(householdId);
  const canManage = householdQuery.data?.permissions.includes("househelps.manage") ?? false;
  const categoriesQuery = useCategories(householdId);
  const existing = useHousehelp(householdId, mode === "edit" ? id : undefined);
  const createHousehelp = useCreateHousehelp(householdId ?? "");
  const updateHousehelp = useUpdateHousehelp(householdId ?? "");
  const errors = useFormErrors();

  const [form, setForm] = useState({
    name: "", phone: "", roleTitle: "", status: "ACTIVE" as "ACTIVE" | "INACTIVE",
    salaryMode: "FIXED_MONTHLY" as (typeof SALARY_MODES)[number]["value"],
    monthlySalaryPaise: "", dailyRatePaise: "", halfDayRatePaise: "", salaryDueDay: "1", notes: "",
  });
  const [categoryIds, setCategoryIds] = useState<string[]>([]);
  const [seeded, setSeeded] = useState(false);

  // Seed form state from the loaded househelp once. The tracker starts at a constant (`false`),
  // never at the query value itself — if the cache is already warm at mount (the normal
  // navigation path: open the detail page, click "Edit details"), `existing.data` is populated
  // on the very first render, and a tracker initialized from that same value would equal it
  // immediately, so the seeding block would never run and the form would render blank.
  // Updating state during render (guarded by `!seeded`) rather than in a useEffect avoids an
  // extra commit-and-rerender pass for this one-time initialization.
  if (mode === "edit" && existing.data && !seeded) {
    const h = existing.data;
    setSeeded(true);
    setForm({
      name: h.name, phone: h.phone ?? "", roleTitle: h.roleTitle ?? "", status: h.status, salaryMode: h.salaryMode,
      monthlySalaryPaise: paiseToInput(h.monthlySalaryPaise), dailyRatePaise: paiseToInput(h.dailyRatePaise), halfDayRatePaise: paiseToInput(h.halfDayRatePaise),
      salaryDueDay: String(h.salaryDueDay), notes: h.notes ?? "",
    });
    setCategoryIds(h.categoryIds);
  }

  function set<K extends keyof typeof form>(key: K) {
    return (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => setForm((f) => ({ ...f, [key]: e.target.value }));
  }

  function toggleCategory(categoryId: string) {
    setCategoryIds((ids) => (ids.includes(categoryId) ? ids.filter((c) => c !== categoryId) : [...ids, categoryId]));
  }

  function onSubmit(e: FormEvent) {
    e.preventDefault();
    errors.clear();

    const isMonthlyMode = form.salaryMode === "FIXED_MONTHLY" || form.salaryMode === "ATTENDANCE_BASED";
    const isDailyMode = form.salaryMode === "DAILY_RATE";
    const moneyErrors: Record<string, string> = {};

    // Converts a rupee-input field to paise, using the app's own `rupeesToPaise` parser (so it
    // accepts what `formatINR` displays, e.g. "1,250"). A field that's irrelevant to the currently
    // selected salaryMode — or left blank — resolves to `undefined` on create (omit it) or `null`
    // on edit (explicitly clear the stale value, including when switching salaryMode away from it).
    function money(fieldKey: string, raw: string, relevant: boolean): number | null | undefined {
      if (!relevant) return mode === "create" ? undefined : null;
      const trimmed = raw.trim();
      if (!trimmed) return mode === "create" ? undefined : null;
      try {
        return rupeesToPaise(trimmed);
      } catch (err) {
        if (err instanceof MoneyError) moneyErrors[fieldKey] = AMOUNT_HINT;
        return undefined;
      }
    }

    const monthlySalaryPaise = money("monthlySalaryPaise", form.monthlySalaryPaise, isMonthlyMode);
    const dailyRatePaise = money("dailyRatePaise", form.dailyRatePaise, isDailyMode);
    const halfDayRatePaise = money("halfDayRatePaise", form.halfDayRatePaise, isDailyMode);

    if (Object.keys(moneyErrors).length > 0) return errors.setFields(moneyErrors);

    if (mode === "create") {
      const body = {
        name: form.name, phone: form.phone || undefined, roleTitle: form.roleTitle || undefined, salaryMode: form.salaryMode,
        monthlySalaryPaise, dailyRatePaise, halfDayRatePaise,
        salaryDueDay: Number(form.salaryDueDay), notes: form.notes || undefined, categoryIds,
      };
      const parsed = createHousehelpSchema.safeParse(body);
      if (!parsed.success) return errors.setFields(zodFieldErrors(parsed.error));
      createHousehelp.mutate(parsed.data, { onSuccess: (result) => navigate(`/househelps/${result.data.id}`, { replace: true }), onError: errors.fromError });
    } else {
      const body = {
        name: form.name,
        phone: form.phone.trim() ? form.phone : null,
        roleTitle: form.roleTitle.trim() ? form.roleTitle : null,
        status: form.status,
        salaryMode: form.salaryMode,
        monthlySalaryPaise, dailyRatePaise, halfDayRatePaise,
        salaryDueDay: Number(form.salaryDueDay),
        notes: form.notes.trim() ? form.notes : null,
        categoryIds,
      };
      const parsed = updateHousehelpSchema.safeParse(body);
      if (!parsed.success) return errors.setFields(zodFieldErrors(parsed.error));
      updateHousehelp.mutate({ id: id!, body: parsed.data }, { onSuccess: () => navigate(`/househelps/${id}`, { replace: true }), onError: errors.fromError });
    }
  }

  if (!householdId) return null;
  if (householdQuery.data && !canManage) return <Navigate to="/househelps" replace />;

  return (
    <>
      <header className="page-head"><h1 className="page-title">{mode === "create" ? "Add househelp" : "Edit househelp"}</h1></header>
      <form className="auth__form" onSubmit={onSubmit} noValidate>
        {errors.formError && <Alert tone="error" title={errors.formError} />}
        <TextField label="Name" value={form.name} onChange={set("name")} error={errors.fieldErrors.name} autoFocus />
        <TextField label="Phone" type="tel" value={form.phone} onChange={set("phone")} error={errors.fieldErrors.phone} />
        <TextField label="Role" hint="e.g. Cook, Full-time help" value={form.roleTitle} onChange={set("roleTitle")} error={errors.fieldErrors.roleTitle} />

        {mode === "edit" && (
          <div className="field">
            <span className="field__label">Status</span>
            <div>
              <button
                type="button" className="chip" aria-pressed={form.status === "ACTIVE"}
                onClick={() => setForm((f) => ({ ...f, status: f.status === "ACTIVE" ? "INACTIVE" : "ACTIVE" }))}
              >
                {form.status === "ACTIVE" ? "Active" : "Inactive"}
              </button>
            </div>
          </div>
        )}

        <div className="field">
          <label className="field__label" htmlFor="salary-mode">Salary type</label>
          <select id="salary-mode" className="input" value={form.salaryMode} onChange={set("salaryMode")}>
            {SALARY_MODES.map((m) => <option key={m.value} value={m.value}>{m.label}</option>)}
          </select>
        </div>

        {(form.salaryMode === "FIXED_MONTHLY" || form.salaryMode === "ATTENDANCE_BASED") && (
          <TextField label="Monthly salary (₹)" inputMode="decimal" value={form.monthlySalaryPaise} onChange={set("monthlySalaryPaise")} error={errors.fieldErrors.monthlySalaryPaise} />
        )}
        {form.salaryMode === "DAILY_RATE" && (
          <>
            <TextField label="Daily rate (₹)" inputMode="decimal" value={form.dailyRatePaise} onChange={set("dailyRatePaise")} error={errors.fieldErrors.dailyRatePaise} />
            <TextField label="Half-day rate (₹)" inputMode="decimal" value={form.halfDayRatePaise} onChange={set("halfDayRatePaise")} error={errors.fieldErrors.halfDayRatePaise} />
          </>
        )}
        <TextField label="Salary due day" hint="Day of the month (1-31)" inputMode="numeric" value={form.salaryDueDay} onChange={set("salaryDueDay")} error={errors.fieldErrors.salaryDueDay} />
        <TextField label="Notes" value={form.notes} onChange={set("notes")} error={errors.fieldErrors.notes} />

        {(categoriesQuery.data?.length ?? 0) > 0 && (
          <div className="field">
            <span className="field__label">Categories</span>
            <div className="chips">
              {categoriesQuery.data!.filter((c) => c.isActive).map((c) => (
                <button key={c.id} type="button" className="chip" aria-pressed={categoryIds.includes(c.id)} onClick={() => toggleCategory(c.id)}>{c.name}</button>
              ))}
            </div>
          </div>
        )}

        <Button type="submit" block loading={createHousehelp.isPending || updateHousehelp.isPending}>
          {mode === "create" ? "Add househelp" : "Save changes"}
        </Button>
      </form>
    </>
  );
}
