import { useState, type ChangeEvent, type FormEvent } from "react";
import { Navigate, useNavigate, useParams } from "react-router-dom";
import { createBillSchema, MoneyError, rupeesToPaise, updateBillSchema } from "@household/shared";
import { Alert } from "../../../components/Alert";
import { Button } from "../../../components/Button";
import { TextField } from "../../../components/TextField";
import { useFormErrors } from "../../auth/useFormErrors";
import { zodFieldErrors } from "../../auth/zod-errors";
import { useActiveHousehold } from "../useActiveHousehold";
import { useHousehold } from "../members/useMembers";
import { FREQUENCY_OPTIONS, PAYMENT_METHOD_OPTIONS } from "./billFrequency";
import { useBill, useBillCategories, useCreateBill, useUpdateBill } from "./useBills";

const AMOUNT_HINT = "Enter a valid rupee amount, e.g. 1500 or 1,500.50. Leave blank for a variable amount.";

function paiseToInput(paise: number | null | undefined): string {
  return paise == null ? "" : (paise / 100).toFixed(2);
}

export function BillFormPage({ mode }: { mode: "create" | "edit" }) {
  const { id } = useParams();
  const navigate = useNavigate();
  const { household: active } = useActiveHousehold();
  const householdId = active?.id;
  const householdQuery = useHousehold(householdId);
  const canManage = householdQuery.data?.permissions.includes("bills.manage") ?? false;
  const categoriesQuery = useBillCategories(householdId);
  const existing = useBill(householdId, mode === "edit" ? id : undefined);
  const createBill = useCreateBill(householdId ?? "");
  const updateBill = useUpdateBill(householdId ?? "");
  const errors = useFormErrors();

  const [form, setForm] = useState({
    name: "", categoryId: "", provider: "", accountNumber: "", amountPaise: "",
    frequency: "MONTHLY" as (typeof FREQUENCY_OPTIONS)[number]["value"],
    intervalCount: "1", intervalUnit: "month" as "day" | "week" | "month",
    firstDueDate: "", endDate: "", paymentMethod: "" as "" | (typeof PAYMENT_METHOD_OPTIONS)[number]["value"],
    autopay: false, notes: "",
  });
  const [seeded, setSeeded] = useState(false);

  // Seed form state from the loaded bill once — same pattern as HousehelpFormPage/ChecklistTaskFormPage:
  // the tracker starts at a constant, never at the query value, so a warm cache at mount still runs
  // the seeding block instead of rendering blank.
  if (mode === "edit" && existing.data && !seeded) {
    const b = existing.data;
    setSeeded(true);
    setForm({
      name: b.name, categoryId: b.categoryId ?? "", provider: b.provider ?? "", accountNumber: b.accountNumber ?? "",
      amountPaise: paiseToInput(b.amountPaise), frequency: b.frequency,
      intervalCount: String(b.intervalCount ?? 1), intervalUnit: (b.intervalUnit as "day" | "week" | "month" | null) ?? "month",
      firstDueDate: b.firstDueDate, endDate: b.endDate ?? "",
      paymentMethod: b.paymentMethod ?? "", autopay: b.autopay, notes: b.notes ?? "",
    });
  }

  function set<K extends keyof typeof form>(key: K) {
    return (e: ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>) => setForm((f) => ({ ...f, [key]: e.target.value }));
  }

  function onSubmit(e: FormEvent) {
    e.preventDefault();
    errors.clear();

    let amountPaise: number | null | undefined;
    const trimmedAmount = form.amountPaise.trim();
    if (!trimmedAmount) {
      amountPaise = null;
    } else {
      try {
        amountPaise = rupeesToPaise(trimmedAmount);
      } catch (err) {
        if (err instanceof MoneyError) return errors.setFields({ amountPaise: AMOUNT_HINT });
        throw err;
      }
    }

    const configByFrequency: Record<string, Record<string, unknown>> = {
      CUSTOM: { intervalCount: form.intervalCount ? Number(form.intervalCount) : undefined, intervalUnit: form.intervalUnit },
    };

    const common = {
      name: form.name,
      provider: form.provider || undefined,
      accountNumber: form.accountNumber || undefined,
      amountPaise,
      frequency: form.frequency,
      ...(configByFrequency[form.frequency] ?? {}),
      firstDueDate: form.firstDueDate,
      endDate: form.endDate || undefined,
      paymentMethod: form.paymentMethod || undefined,
      autopay: form.autopay,
      notes: form.notes || undefined,
    };

    if (mode === "create") {
      const body = { ...common, categoryId: form.categoryId || undefined };
      const parsed = createBillSchema.safeParse(body);
      if (!parsed.success) return errors.setFields(zodFieldErrors(parsed.error));
      createBill.mutate(parsed.data, { onSuccess: (result) => navigate(`/bills/${result.data.id}`, { replace: true }), onError: errors.fromError });
    } else {
      const body = {
        ...common,
        categoryId: form.categoryId || null,
        endDate: form.endDate || null,
        paymentMethod: form.paymentMethod || null,
        notes: form.notes.trim() ? form.notes : null,
        provider: form.provider.trim() ? form.provider : null,
        accountNumber: form.accountNumber.trim() ? form.accountNumber : null,
      };
      const parsed = updateBillSchema.safeParse(body);
      if (!parsed.success) return errors.setFields(zodFieldErrors(parsed.error));
      updateBill.mutate({ id: id!, body: parsed.data }, { onSuccess: () => navigate(`/bills/${id}`, { replace: true }), onError: errors.fromError });
    }
  }

  if (!householdId) return null;
  if (householdQuery.data && !canManage) return <Navigate to="/bills" replace />;

  return (
    <>
      <header className="page-head"><h1 className="page-title">{mode === "create" ? "Add bill" : "Edit bill"}</h1></header>
      <form className="auth__form" onSubmit={onSubmit} noValidate>
        {errors.formError && <Alert tone="error" title={errors.formError} />}
        <TextField label="Name" value={form.name} onChange={set("name")} error={errors.fieldErrors.name} autoFocus />

        {(categoriesQuery.data?.length ?? 0) > 0 && (
          <div className="field">
            <label className="field__label" htmlFor="category">Category</label>
            <select id="category" className="input" value={form.categoryId} onChange={set("categoryId")}>
              <option value="">No category</option>
              {categoriesQuery.data!.filter((c) => c.isActive).map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
          </div>
        )}

        <TextField label="Provider" hint="e.g. the utility or vendor name (optional)" value={form.provider} onChange={set("provider")} error={errors.fieldErrors.provider} />
        <TextField label="Account number" hint="Optional" value={form.accountNumber} onChange={set("accountNumber")} error={errors.fieldErrors.accountNumber} />
        <TextField label="Amount (₹)" hint={AMOUNT_HINT} inputMode="decimal" value={form.amountPaise} onChange={set("amountPaise")} error={errors.fieldErrors.amountPaise} />

        <div className="field">
          <label className="field__label" htmlFor="frequency">Repeats</label>
          <select id="frequency" className="input" value={form.frequency} onChange={set("frequency")}>
            {FREQUENCY_OPTIONS.map((f) => <option key={f.value} value={f.value}>{f.label}</option>)}
          </select>
        </div>

        {form.frequency === "CUSTOM" && (
          <>
            <TextField label="Repeat every" inputMode="numeric" value={form.intervalCount} onChange={set("intervalCount")} error={errors.fieldErrors.intervalCount} />
            <div className="field">
              <label className="field__label" htmlFor="interval-unit">Interval unit</label>
              <select id="interval-unit" className="input" value={form.intervalUnit} onChange={set("intervalUnit")}>
                <option value="day">Day(s)</option>
                <option value="week">Week(s)</option>
                <option value="month">Month(s)</option>
              </select>
            </div>
          </>
        )}

        <TextField label="First due date" type="date" value={form.firstDueDate} onChange={set("firstDueDate")} error={errors.fieldErrors.firstDueDate} />
        <TextField label="End date" hint="Optional" type="date" value={form.endDate} onChange={set("endDate")} error={errors.fieldErrors.endDate} />

        <div className="field">
          <label className="field__label" htmlFor="payment-method">Payment method</label>
          <select id="payment-method" className="input" value={form.paymentMethod} onChange={set("paymentMethod")}>
            <option value="">Not set</option>
            {PAYMENT_METHOD_OPTIONS.map((m) => <option key={m.value} value={m.value}>{m.label}</option>)}
          </select>
        </div>

        <div className="field">
          <span className="field__label">Autopay</span>
          <div>
            <button type="button" className="chip" aria-pressed={form.autopay} onClick={() => setForm((f) => ({ ...f, autopay: !f.autopay }))}>
              {form.autopay ? "On" : "Off"}
            </button>
          </div>
        </div>

        <TextField label="Notes" value={form.notes} onChange={set("notes")} error={errors.fieldErrors.notes} />

        <Button type="submit" block loading={createBill.isPending || updateBill.isPending}>
          {mode === "create" ? "Add bill" : "Save changes"}
        </Button>
      </form>
    </>
  );
}
