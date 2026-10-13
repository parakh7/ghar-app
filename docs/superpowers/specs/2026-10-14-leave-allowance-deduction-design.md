# Leave Allowance Deduction — Design Spec

**Status:** Approved.

## Context

`computeBasePay` in `apps/api/src/services/salary-settlement.service.ts` has three `salaryMode` branches. `FIXED_MONTHLY` currently has zero absence-deduction logic — it pays the full monthly salary no matter how many days the househelp was ABSENT or on LEAVE. `ATTENDANCE_BASED` already prorates a deduction for ABSENT and HALF_DAY (never LEAVE — a locked Phase 5 decision). This spec adds a configurable "leaves allowed per month" to `FIXED_MONTHLY`: once ABSENT+LEAVE days (HALF_DAY counting as 0.5) exceed the allowance, the excess is deducted at a per-day rate.

## Scope

- Applies to **`FIXED_MONTHLY` only**. `ATTENDANCE_BASED` and `DAILY_RATE` are unchanged.
- Counts toward the allowance: ABSENT (1), LEAVE (1), HALF_DAY (0.5). HOLIDAY and PRESENT never count.
- New field `allowedLeavesPerMonth` (integer, 0-31) on `househelps`, default **0**.
- **Explicit rollout decision:** defaulting to 0 means every existing `FIXED_MONTHLY` househelp starts incurring a deduction for any ABSENT/LEAVE day as soon as this ships — this reverses the current "always fully paid" behavior. Confirmed intentional; not a bug to guard against.
- Deduction reuses the existing `absenceDeductionPaise` settlement field (currently always 0 for `FIXED_MONTHLY`) — no new DTO field, no settlement-detail-page UI change, since that page already has an unconditional "Absence deduction" line driven by this field.

## Calculation

Mirrors `ATTENDANCE_BASED`'s existing half-day-unit technique (doubling to keep everything integer, paise-exact — no floating point in money math):

```
unworkedHalfDayUnits = absentDays*2 + leaveDays*2 + halfDays
allowedHalfDayUnits  = allowedLeavesPerMonth * 2
excessHalfDayUnits   = max(0, unworkedHalfDayUnits - allowedHalfDayUnits)
absenceDeductionPaise = workingDays > 0 ? prorate(monthlySalaryPaise, excessHalfDayUnits, workingDays * 2) : 0
```

`prorate` is the existing paise-safe proration helper from `@household/shared`, already used identically by `ATTENDANCE_BASED`.

## Data model

- `apps/api/src/db/schema.ts`: new column on `househelps` — `allowedLeavesPerMonth: smallint("allowed_leaves_per_month").notNull().default(0)`, with a check constraint `between 0 and 31` (mirrors the existing `salaryDueDay` column's pattern exactly, including its check constraint style).
- `HousehelpDTO` (`packages/shared/src/dto.ts`): add `allowedLeavesPerMonth: number`.
- `createHousehelpSchema` / `updateHousehelpSchema` (`packages/shared/src/schemas.ts`): add `allowedLeavesPerMonth: z.number().int().min(0).max(31).default(0)` (create) / `.optional()` (update) — mirrors `salaryDueDay`'s schema pattern exactly.
- `toHousehelpDTO` in `apps/api/src/services/househelp.service.ts`: map the new field through. `createHousehelp`/`updateHousehelp` need no other changes — both already spread the full input object into the Drizzle insert/update.

## Frontend

- `HousehelpFormPage.tsx`: a new numeric field "Leaves allowed per month" immediately after the existing "Monthly salary" field, shown only when `form.salaryMode === "FIXED_MONTHLY"` (not `ATTENDANCE_BASED`, since the feature is `FIXED_MONTHLY`-only) — mirrors the existing `form.salaryMode === "FIXED_MONTHLY" || "ATTENDANCE_BASED"` conditional pattern already in that file, just narrower.
- Settlement detail page: no changes — the existing "Absence deduction" line already displays whatever `absenceDeductionPaise` holds.

## Testing

- API: `salary-settlement.test.ts` — the existing test "FIXED_MONTHLY: pays the full monthly salary regardless of absences" gets rewritten to reflect the new default-0-allowance behavior (any absence/leave now deducts). New tests: usage within the allowance (no deduction), usage exceeding it (correct prorated deduction), HALF_DAY counting as 0.5 toward both the allowance and the deduction, `ATTENDANCE_BASED`/`DAILY_RATE` unaffected by a non-zero `allowedLeavesPerMonth` value (defensive — confirms the mode gate).
- API: `househelps.test.ts` — create/update a househelp with `allowedLeavesPerMonth` set, confirm it round-trips; confirm the default is 0 when omitted.
- Web: `HousehelpFormPage.test.tsx` — the field appears for `FIXED_MONTHLY`, is absent for the other two modes, and submits the value in the request body.
