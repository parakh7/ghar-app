import { useState, type FormEvent } from "react";
import { ArrowDown, ArrowUp, Trash2 } from "lucide-react";
import { createBillCategorySchema } from "@household/shared";
import { ApiError } from "../../../lib/api";
import { Alert } from "../../../components/Alert";
import { Button } from "../../../components/Button";
import { TextField } from "../../../components/TextField";
import { useFormErrors } from "../../auth/useFormErrors";
import { zodFieldErrors } from "../../auth/zod-errors";
import { useActiveHousehold } from "../useActiveHousehold";
import { useHousehold } from "../members/useMembers";
import { useBillCategories, useCreateBillCategory, useDeleteBillCategory, useMoveBillCategory, useUpdateBillCategory } from "./useBills";

function messageFrom(err: unknown): string {
  return err instanceof ApiError ? err.message : "Something went wrong. Please try again.";
}

export function BillCategoriesPage() {
  const { household: active } = useActiveHousehold();
  const householdId = active?.id;
  const householdQuery = useHousehold(householdId);
  const categoriesQuery = useBillCategories(householdId);
  const canManage = householdQuery.data?.permissions.includes("bills.manage") ?? false;

  const createCategory = useCreateBillCategory(householdId ?? "");
  const updateCategory = useUpdateBillCategory(householdId ?? "");
  const deleteCategory = useDeleteBillCategory(householdId ?? "");
  const moveCategory = useMoveBillCategory(householdId ?? "");

  const [name, setName] = useState("");
  const [icon, setIcon] = useState("");
  const [pageError, setPageError] = useState<string | null>(null);
  const errors = useFormErrors();

  function onAdd(e: FormEvent) {
    e.preventDefault();
    errors.clear();
    const parsed = createBillCategorySchema.safeParse({ name, icon: icon || undefined });
    if (!parsed.success) return errors.setFields(zodFieldErrors(parsed.error));
    createCategory.mutate(parsed.data, { onSuccess: () => { setName(""); setIcon(""); }, onError: errors.fromError });
  }

  if (!householdId) return null;

  return (
    <>
      <header className="page-head"><h1 className="page-title">Bill categories</h1></header>
      {pageError && <Alert tone="error" title={pageError} />}

      <div className="list">
        {categoriesQuery.data?.map((c, i) => (
          <div key={c.id} className="list__item">
            <span className="list__text">
              <span className="list__label" style={{ display: "block" }}>{c.icon ? `${c.icon} ` : ""}{c.name}</span>
              {!c.isActive && <span className="list__meta">Inactive</span>}
            </span>
            {canManage && (
              <span style={{ display: "flex", alignItems: "center", gap: "var(--space-1)" }}>
                <Button
                  variant="ghost" icon={<ArrowUp size={18} aria-hidden />} aria-label={`Move ${c.name} up`}
                  disabled={i === 0}
                  onClick={() => moveCategory.mutate({ categoryId: c.id, direction: "up" }, { onError: (err) => setPageError(messageFrom(err)) })}
                />
                <Button
                  variant="ghost" icon={<ArrowDown size={18} aria-hidden />} aria-label={`Move ${c.name} down`}
                  disabled={i === (categoriesQuery.data?.length ?? 1) - 1}
                  onClick={() => moveCategory.mutate({ categoryId: c.id, direction: "down" }, { onError: (err) => setPageError(messageFrom(err)) })}
                />
                <button
                  type="button" className="chip" aria-pressed={c.isActive}
                  onClick={() => updateCategory.mutate({ categoryId: c.id, body: { isActive: !c.isActive } }, { onError: (err) => setPageError(messageFrom(err)) })}
                >
                  {c.isActive ? "Active" : "Inactive"}
                </button>
                <Button
                  variant="ghost" icon={<Trash2 size={18} aria-hidden />} aria-label={`Remove ${c.name}`}
                  onClick={() => deleteCategory.mutate(c.id, { onError: (err) => setPageError(messageFrom(err)) })}
                />
              </span>
            )}
          </div>
        ))}
      </div>

      {canManage && (
        <form className="auth__form" onSubmit={onAdd} noValidate style={{ marginTop: "var(--space-6)" }}>
          {errors.formError && <Alert tone="error" title={errors.formError} />}
          <TextField label="Category name" value={name} onChange={(e) => setName(e.target.value)} error={errors.fieldErrors.name} />
          <TextField label="Icon" hint="Optional, e.g. an emoji" value={icon} onChange={(e) => setIcon(e.target.value)} error={errors.fieldErrors.icon} />
          <Button type="submit" block loading={createCategory.isPending}>Add category</Button>
        </form>
      )}
    </>
  );
}
