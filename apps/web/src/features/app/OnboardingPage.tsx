import { useState, type FormEvent } from "react";
import { useNavigate } from "react-router-dom";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { createHouseholdSchema, type HouseholdDTO } from "@household/shared";
import { post } from "../../lib/api";
import { setActiveHouseholdId } from "../../lib/active-household";
import { Alert } from "../../components/Alert";
import { Button } from "../../components/Button";
import { TextField } from "../../components/TextField";
import { AuthLayout } from "../auth/AuthLayout";
import { meKey, useSession } from "../auth/session";
import { useFormErrors } from "../auth/useFormErrors";
import { zodFieldErrors } from "../auth/zod-errors";

const SUGGESTIONS = ["Shah Family", "Mumbai Home", "Parents' Home"];

/** Onboarding step 1. Steps 2–4 (househelp, bills, reminder timing) arrive with their features. */
export function OnboardingPage() {
  const { data } = useSession();
  const surname = data?.user.name.trim().split(/\s+/).slice(1).join(" ");
  const [name, setName] = useState(surname ? `${surname} Family` : "");
  const errors = useFormErrors();
  const qc = useQueryClient();
  const navigate = useNavigate();

  const mutation = useMutation({
    mutationFn: (body: { name: string; timezone: string }) => post<HouseholdDTO>("/households", body),
    onSuccess: async ({ data: h }) => {
      setActiveHouseholdId(h.id);
      await qc.invalidateQueries({ queryKey: meKey });
      navigate("/", { replace: true });
    },
    onError: errors.fromError,
  });

  function onSubmit(e: FormEvent) {
    e.preventDefault();
    errors.clear();
    const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone || "Asia/Kolkata";
    const parsed = createHouseholdSchema.safeParse({ name, timezone });
    if (!parsed.success) return errors.setFields(zodFieldErrors(parsed.error));
    mutation.mutate({ name: parsed.data.name, timezone: parsed.data.timezone });
  }

  return (
    <AuthLayout title="Name your household" subtitle="This is what your family will see. You can add more homes later — like your parents' place.">
      <form className="auth__form" onSubmit={onSubmit} noValidate>
        {errors.formError && <Alert tone="error" title={errors.formError} />}
        <TextField label="Household name" value={name} onChange={(e) => setName(e.target.value)} error={errors.fieldErrors.name} placeholder="Shah Family" autoFocus maxLength={60} />
        <div className="chips" role="group" aria-label="Suggestions">
          {SUGGESTIONS.map((s) => (
            <button key={s} type="button" className="chip" onClick={() => setName(s)} aria-pressed={name === s}>{s}</button>
          ))}
        </div>
        <Button type="submit" block loading={mutation.isPending}>Continue</Button>
      </form>
    </AuthLayout>
  );
}
