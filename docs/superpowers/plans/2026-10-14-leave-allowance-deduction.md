# Leave Allowance Deduction Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `FIXED_MONTHLY` househelps get a configurable "leaves allowed per month"; exceeding it (ABSENT+LEAVE, HALF_DAY=0.5) deducts pay at a per-day rate.

**Architecture:** A new `allowedLeavesPerMonth` column on `househelps` (default 0) flows through the existing CRUD plumbing unchanged (both `createHousehelp`/`updateHousehelp` already spread their full input into the Drizzle call). `computeBasePay`'s `FIXED_MONTHLY` branch gains the same half-day-unit proration technique `ATTENDANCE_BASED` already uses, writing its result into the existing `absenceDeductionPaise` field — no new settlement DTO field, no settlement-page UI change needed.

**Tech Stack:** Drizzle ORM + drizzle-kit migrations (API), Zod (shared schemas), React 19 (web) — no new dependencies.

## Global Constraints

- Applies to `FIXED_MONTHLY` only. `ATTENDANCE_BASED` and `DAILY_RATE` must be provably unaffected even when `allowedLeavesPerMonth` is set on them.
- Counts toward the allowance: ABSENT (1 unit), LEAVE (1 unit), HALF_DAY (0.5 unit). HOLIDAY and PRESENT never count.
- `allowedLeavesPerMonth`: integer, 0-31, **defaults to 0** — this is an intentional, confirmed behavior change (every existing `FIXED_MONTHLY` househelp starts incurring deductions for any ABSENT/LEAVE day once this ships).
- Calculation (paise-safe, no floating point):
  ```
  unworkedHalfDayUnits = absentDays*2 + leaveDays*2 + halfDays
  allowedHalfDayUnits  = allowedLeavesPerMonth * 2
  excessHalfDayUnits   = max(0, unworkedHalfDayUnits - allowedHalfDayUnits)
  absenceDeductionPaise = workingDays > 0 ? prorate(monthlySalaryPaise, excessHalfDayUnits, workingDays * 2) : 0
  ```
  `prorate` is `@household/shared`'s existing paise-safe proration helper (half-up rounding via `(n*2+d)/(2d)` integer division) — already imported in `salary-settlement.service.ts`.

---

### Task 1: Schema, DTO, and CRUD round-trip

**Files:**
- Modify: `apps/api/src/db/schema.ts` (add `allowedLeavesPerMonth` column + check constraint on `househelps`, mirroring `salaryDueDay` at lines 182/190)
- Modify: `packages/shared/src/dto.ts` (add field to `HousehelpDTO`, line 41-48)
- Modify: `packages/shared/src/schemas.ts` (add field to `createHousehelpSchema`/`updateHousehelpSchema`, lines 72-98)
- Modify: `apps/api/src/services/househelp.service.ts` (map the field in `toHousehelpDTO`, line 11-19)
- Create: migration file via `npm run db:generate` (output path determined by drizzle-kit — inspect `apps/api/drizzle/` after running it)
- Test: `apps/api/tests/househelps.test.ts`

**Interfaces:**
- Produces: `HousehelpDTO.allowedLeavesPerMonth: number`. `CreateHousehelpInput`/`UpdateHousehelpInput` both carry `allowedLeavesPerMonth?: number`.
- Consumes: nothing from other tasks — this is the foundation task.

- [ ] **Step 1: Write the failing test**

Add to `apps/api/tests/househelps.test.ts`, inside the existing `describe("househelps", ...)` block, right after the `"creates a househelp with defaults applied"` test:

```typescript
  it("defaults allowedLeavesPerMonth to 0, accepts an explicit value on create, and updates it", async () => {
    const owner = await signupUser(ctx);
    const h = await createHousehold(ctx, owner.cookie);

    const defaulted = await ctx.request.post(`/api/households/${h.id}/househelps`).set(csrf).set("cookie", owner.cookie).send({ name: "Sunita" });
    expect(defaulted.status).toBe(201);
    expect(defaulted.body.data.allowedLeavesPerMonth).toBe(0);

    const created = await ctx.request.post(`/api/households/${h.id}/househelps`).set(csrf).set("cookie", owner.cookie).send({ name: "Ravi", allowedLeavesPerMonth: 4 });
    expect(created.status).toBe(201);
    expect(created.body.data.allowedLeavesPerMonth).toBe(4);

    const updated = await ctx.request.patch(`/api/households/${h.id}/househelps/${created.body.data.id}`).set(csrf).set("cookie", owner.cookie).send({ allowedLeavesPerMonth: 7 });
    expect(updated.status).toBe(200);
    expect(updated.body.data.allowedLeavesPerMonth).toBe(7);
  });
```

Also extend the existing `"creates a househelp with defaults applied"` test's `toMatchObject` call (around line 145) to additionally assert `allowedLeavesPerMonth: 0`.

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd apps/api && npm run test -- househelps`
Expected: FAIL — `allowedLeavesPerMonth` is `undefined` in the response (field doesn't exist yet anywhere in the stack).

- [ ] **Step 3: Add the column to the Drizzle schema**

In `apps/api/src/db/schema.ts`, find the `salaryDueDay` column (line 182: `salaryDueDay: smallint("salary_due_day").notNull().default(1),`) and add immediately after it:

```typescript
  allowedLeavesPerMonth: smallint("allowed_leaves_per_month").notNull().default(0),
```

Find the check-constraint block containing `"househelps_due_day_ck"` (line 190) and add a sibling constraint immediately after it:

```typescript
  check("househelps_allowed_leaves_ck", sql`${t.allowedLeavesPerMonth} between 0 and 31`),
```

- [ ] **Step 4: Add the field to the shared DTO and Zod schemas**

In `packages/shared/src/dto.ts`, add to `HousehelpDTO` (after `salaryDueDay: number;` on line 46):

```typescript
  allowedLeavesPerMonth: number;
```

In `packages/shared/src/schemas.ts`, in `createHousehelpSchema` (after `salaryDueDay: z.number().int().min(1).max(31).default(1),` at line 80):

```typescript
  allowedLeavesPerMonth: z.number().int().min(0).max(31).default(0),
```

In `updateHousehelpSchema` (after `salaryDueDay: z.number().int().min(1).max(31).optional(),` at line 95):

```typescript
  allowedLeavesPerMonth: z.number().int().min(0).max(31).optional(),
```

Run: `cd packages/shared && npm run build` (API and web import compiled output, not source — see the project's "stale dist" gotcha).

- [ ] **Step 5: Map the field in the service**

In `apps/api/src/services/househelp.service.ts`, in `toHousehelpDTO` (line 16, which currently reads `salaryDueDay: row.salaryDueDay, notes: row.notes, ...`), add `allowedLeavesPerMonth: row.allowedLeavesPerMonth,` right before `salaryDueDay`.

No other changes needed in this file — `createHousehelp` and `updateHousehelp` both already spread their full input object (`...fields`) into the Drizzle insert/update call.

- [ ] **Step 6: Generate and apply the migration**

Run: `cd apps/api && npm run db:generate`
Expected: a new SQL file appears under `apps/api/drizzle/` adding the `allowed_leaves_per_month` column and its check constraint. Inspect it to confirm it only touches `househelps`.

Run: `cd apps/api && npm run test -- househelps`
Expected: PASS — `tests/global-setup.ts` wipes and re-migrates the test database from scratch on every `npm run test` invocation, so the new migration is applied automatically; no manual `db:migrate` needed for the test DB.

- [ ] **Step 7: Typecheck and build**

Run: `cd apps/api && npm run typecheck` then `cd apps/api && npm run build`
Expected: both PASS

- [ ] **Step 8: Commit**

```bash
git add apps/api/src/db/schema.ts apps/api/drizzle packages/shared/src/dto.ts packages/shared/src/schemas.ts apps/api/src/services/househelp.service.ts apps/api/tests/househelps.test.ts
git commit -m "feat(api): add allowedLeavesPerMonth to househelps"
```

---

### Task 2: Salary calculation

**Files:**
- Modify: `apps/api/src/services/salary-settlement.service.ts` (`computeBasePay`'s `FIXED_MONTHLY` branch, lines 125-128)
- Test: `apps/api/tests/salary-settlement.test.ts`

**Interfaces:**
- Consumes: `HousehelpRow.allowedLeavesPerMonth: number` (Task 1 — the Drizzle-inferred row type already includes every column, so no explicit import change is needed beyond what Task 1 added to `schema.ts`). `MonthAttendanceAgg` (existing, same file, line 67-70). `prorate` (existing import, `@household/shared`).
- Produces: nothing new — this changes `computeBasePay`'s existing return value for one branch.

- [ ] **Step 1: Write the failing tests**

Replace the existing test named `"FIXED_MONTHLY: pays the full monthly salary regardless of absences"` (lines 74-89 of `apps/api/tests/salary-settlement.test.ts`) with these four tests:

```typescript
  it("FIXED_MONTHLY: deducts for every unworked day once the default leave allowance of 0 is exceeded", async () => {
    const owner = await signupUser(ctx);
    const h = await createHousehold(ctx, owner.cookie);
    const help = await createHousehelp(ctx, owner.cookie, h.id, { salaryMode: "FIXED_MONTHLY", monthlySalaryPaise: 3_100_000 });
    await scheduleWholeWeek(ctx, h.id, help.id);
    await markAugust(ctx, h.id, help.id, {
      "2026-08-01": "ABSENT", "2026-08-02": "ABSENT", "2026-08-03": "ABSENT", "2026-08-04": "ABSENT", "2026-08-05": "ABSENT",
      "2026-08-06": "ABSENT", "2026-08-07": "ABSENT", "2026-08-08": "ABSENT", "2026-08-09": "ABSENT", "2026-08-10": "ABSENT",
    });
    const res = await generate(ctx, owner.cookie, h.id, help.id);
    expect(res.status).toBe(200);
    // Default allowance is 0, so all 10 ABSENT days deduct: 10 * (3,100,000/31) = 1,000,000.
    expect(res.body.data).toMatchObject({ basePaise: 3_100_000, absenceDeductionPaise: 1_000_000, netPayablePaise: 2_100_000, workingDays: 31, absentDays: 10 });
  });

  it("FIXED_MONTHLY: no deduction while unworked days stay within the configured allowance", async () => {
    const owner = await signupUser(ctx);
    const h = await createHousehold(ctx, owner.cookie);
    const help = await createHousehelp(ctx, owner.cookie, h.id, { salaryMode: "FIXED_MONTHLY", monthlySalaryPaise: 3_100_000, allowedLeavesPerMonth: 5 });
    await scheduleWholeWeek(ctx, h.id, help.id);
    await markAugust(ctx, h.id, help.id, {
      "2026-08-01": "ABSENT", "2026-08-02": "ABSENT", "2026-08-03": "ABSENT", "2026-08-04": "ABSENT", "2026-08-05": "ABSENT",
    });
    const res = await generate(ctx, owner.cookie, h.id, help.id);
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ basePaise: 3_100_000, absenceDeductionPaise: 0, netPayablePaise: 3_100_000, absentDays: 5 });
  });

  it("FIXED_MONTHLY: deducts only the days beyond the configured allowance", async () => {
    const owner = await signupUser(ctx);
    const h = await createHousehold(ctx, owner.cookie);
    const help = await createHousehelp(ctx, owner.cookie, h.id, { salaryMode: "FIXED_MONTHLY", monthlySalaryPaise: 3_100_000, allowedLeavesPerMonth: 5 });
    await scheduleWholeWeek(ctx, h.id, help.id);
    await markAugust(ctx, h.id, help.id, {
      "2026-08-01": "ABSENT", "2026-08-02": "ABSENT", "2026-08-03": "ABSENT", "2026-08-04": "ABSENT", "2026-08-05": "ABSENT",
      "2026-08-06": "ABSENT", "2026-08-07": "ABSENT", "2026-08-08": "ABSENT", "2026-08-09": "ABSENT", "2026-08-10": "ABSENT",
    });
    const res = await generate(ctx, owner.cookie, h.id, help.id);
    expect(res.status).toBe(200);
    // 10 absences - 5 allowed = 5 excess days * (3,100,000/31) = 500,000.
    expect(res.body.data).toMatchObject({ basePaise: 3_100_000, absenceDeductionPaise: 500_000, netPayablePaise: 2_600_000, absentDays: 10 });
  });

  it("FIXED_MONTHLY: a HALF_DAY counts as 0.5 toward the allowance and deducts at half the per-day rate", async () => {
    const owner = await signupUser(ctx);
    const h = await createHousehold(ctx, owner.cookie);
    const help = await createHousehelp(ctx, owner.cookie, h.id, { salaryMode: "FIXED_MONTHLY", monthlySalaryPaise: 3_100_000 });
    await scheduleWholeWeek(ctx, h.id, help.id);
    await markAugust(ctx, h.id, help.id, { "2026-08-15": "HALF_DAY" });
    const res = await generate(ctx, owner.cookie, h.id, help.id);
    expect(res.status).toBe(200);
    // Default allowance 0: 0.5 excess unit * (3,100,000/31) = 50,000.
    expect(res.body.data).toMatchObject({ basePaise: 3_100_000, absenceDeductionPaise: 50_000, netPayablePaise: 3_050_000, halfDays: 1 });
  });

  it("a non-zero allowedLeavesPerMonth has no effect on ATTENDANCE_BASED's existing deduction formula", async () => {
    const owner = await signupUser(ctx);
    const h = await createHousehold(ctx, owner.cookie);
    const help = await createHousehelp(ctx, owner.cookie, h.id, { salaryMode: "ATTENDANCE_BASED", monthlySalaryPaise: 3_100_000, allowedLeavesPerMonth: 10 });
    await scheduleWholeWeek(ctx, h.id, help.id);
    await markAugust(ctx, h.id, help.id, { "2026-08-05": "ABSENT", "2026-08-06": "ABSENT", "2026-08-07": "HALF_DAY" });
    const res = await generate(ctx, owner.cookie, h.id, help.id);
    expect(res.status).toBe(200);
    // Identical scenario and result to the existing "ATTENDANCE_BASED: prorates absence and half-day
    // deductions" test above, just with allowedLeavesPerMonth set — proves the field has zero effect
    // on this mode's formula: prorate(3,100,000, 2, 31) + prorate(3,100,000, 1, 62) = 200,000 + 50,000 = 250,000.
    expect(res.body.data).toMatchObject({ basePaise: 3_100_000, absenceDeductionPaise: 250_000, netPayablePaise: 2_850_000 });
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd apps/api && npm run test -- salary-settlement`
Expected: FAIL — the four new `FIXED_MONTHLY`/gate tests expect a non-zero or allowance-aware `absenceDeductionPaise` that the current code never produces (it's hardcoded to 0 for `FIXED_MONTHLY`).

- [ ] **Step 3: Implement the calculation**

In `apps/api/src/services/salary-settlement.service.ts`, replace the `FIXED_MONTHLY` case in `computeBasePay` (lines 125-128):

```typescript
    case "FIXED_MONTHLY": {
      if (help.monthlySalaryPaise == null) throw Errors.validation({ monthlySalaryPaise: "This househelp has no monthly salary set." });
      const base = help.monthlySalaryPaise;
      const unworkedHalfDayUnits = agg.absentDays * 2 + agg.leaveDays * 2 + agg.halfDays;
      const allowedHalfDayUnits = help.allowedLeavesPerMonth * 2;
      const excessHalfDayUnits = Math.max(0, unworkedHalfDayUnits - allowedHalfDayUnits);
      const absenceDeductionPaise = agg.workingDays > 0 ? prorate(base, excessHalfDayUnits, agg.workingDays * 2) : 0;
      return { basePaise: base, absenceDeductionPaise };
    }
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd apps/api && npm run test -- salary-settlement`
Expected: PASS (all tests in the file)

- [ ] **Step 5: Typecheck and build**

Run: `cd apps/api && npm run typecheck` then `cd apps/api && npm run build`
Expected: both PASS

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/services/salary-settlement.service.ts apps/api/tests/salary-settlement.test.ts
git commit -m "feat(api): FIXED_MONTHLY leave-allowance deduction"
```

---

### Task 3: Frontend — form field and fixture updates

**Files:**
- Modify: `apps/web/src/features/app/househelps/HousehelpFormPage.tsx`
- Modify: `apps/web/src/features/app/househelps/HousehelpFormPage.test.tsx`
- Modify (fixture only — add `allowedLeavesPerMonth: 0` to each file's `HousehelpDTO`-shaped test object so the web workspace still typechecks; none of these tests otherwise need new assertions):
  - `apps/web/src/features/app/salary/SalaryListPage.test.tsx`
  - `apps/web/src/features/app/attendance/HousehelpCalendarPage.test.tsx`
  - `apps/web/src/features/app/salary/SettlementDetailPage.test.tsx`
  - `apps/web/src/features/app/househelps/HousehelpsListPage.test.tsx`
  - `apps/web/src/features/app/checklist/ChecklistTaskDetailPage.test.tsx`

**Interfaces:**
- Consumes: `HousehelpDTO.allowedLeavesPerMonth`, `createHousehelpSchema`/`updateHousehelpSchema`'s `allowedLeavesPerMonth` field (Task 1).

- [ ] **Step 1: Write the failing test**

In `apps/web/src/features/app/househelps/HousehelpFormPage.test.tsx`:

Add `allowedLeavesPerMonth: 0` to the `HOUSEHELP` fixture object (around line 14, alongside `salaryDueDay: 5`).

Add this test to the `describe("HousehelpFormPage — create mode", ...)` block, after the existing `"converts a comma-grouped rupee amount..."` test:

```typescript
  it("includes allowedLeavesPerMonth in the request body, only for FIXED_MONTHLY", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation((async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/households/h1")) return jsonResponse({ success: true, data: { ...HOUSEHOLD, permissions: ["househelps.manage"] }, message: null });
      if (url.includes("/categories")) return jsonResponse({ success: true, data: [], message: null });
      if (init?.method === "POST" && url.endsWith("/househelps")) return jsonResponse({ success: true, data: { ...HOUSEHELP, id: "hh2" }, message: null }, 201);
      throw new Error(`unexpected fetch ${url}`);
    }) as typeof fetch);

    renderCreatePage();
    await userEvent.type(await screen.findByLabelText("Name"), "Sunita");
    await userEvent.type(screen.getByLabelText("Leaves allowed per month"), "4");
    await userEvent.click(screen.getByRole("button", { name: "Add househelp" }));

    const postCall = fetchSpy.mock.calls.find(([u, init]) => String(u).endsWith("/househelps") && (init as RequestInit | undefined)?.method === "POST");
    expect(postCall).toBeDefined();
    const body = JSON.parse((postCall![1] as RequestInit).body as string);
    expect(body.allowedLeavesPerMonth).toBe(4);
  });

  it("hides the leaves-allowed field for DAILY_RATE", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation((async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/households/h1")) return jsonResponse({ success: true, data: { ...HOUSEHOLD, permissions: ["househelps.manage"] }, message: null });
      if (url.includes("/categories")) return jsonResponse({ success: true, data: [], message: null });
      throw new Error(`unexpected fetch ${url}`);
    }) as typeof fetch);

    renderCreatePage();
    await screen.findByLabelText("Name");
    await userEvent.selectOptions(screen.getByLabelText("Salary type"), "DAILY_RATE");
    expect(screen.queryByLabelText("Leaves allowed per month")).not.toBeInTheDocument();
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd apps/web && npm run test -- HousehelpFormPage`
Expected: FAIL — `screen.getByLabelText("Leaves allowed per month")` finds nothing (field doesn't exist yet).

- [ ] **Step 3: Add the field to the form**

In `apps/web/src/features/app/househelps/HousehelpFormPage.tsx`:

Add `allowedLeavesPerMonth: "0"` to the initial `form` state object (line 41, alongside `salaryDueDay: "1"`).

In the edit-mode seeding block (line 56-60), add `allowedLeavesPerMonth: String(h.allowedLeavesPerMonth),` alongside `salaryDueDay: String(h.salaryDueDay),`.

In `onSubmit`'s create-mode `body` (line 103-107), add `allowedLeavesPerMonth: Number(form.allowedLeavesPerMonth),` alongside `salaryDueDay: Number(form.salaryDueDay),`.

In the edit-mode `body` (line 112-122), add the same line.

Add the field to the JSX, immediately after the `"Monthly salary (₹)"` field block (after line 164, inside the same `{(form.salaryMode === "FIXED_MONTHLY" ...` — but note this new field is `FIXED_MONTHLY`-only, narrower than that existing condition, so give it its own conditional):

```tsx
        {form.salaryMode === "FIXED_MONTHLY" && (
          <TextField label="Leaves allowed per month" hint="Paid ABSENT/LEAVE days before deductions start" inputMode="numeric" value={form.allowedLeavesPerMonth} onChange={set("allowedLeavesPerMonth")} error={errors.fieldErrors.allowedLeavesPerMonth} />
        )}
```

- [ ] **Step 4: Update the other test files' fixtures**

Add `allowedLeavesPerMonth: 0,` to each `HousehelpDTO`-shaped object (search each file for `salaryDueDay:` to find the exact spot) in:
- `apps/web/src/features/app/salary/SalaryListPage.test.tsx`
- `apps/web/src/features/app/attendance/HousehelpCalendarPage.test.tsx`
- `apps/web/src/features/app/salary/SettlementDetailPage.test.tsx`
- `apps/web/src/features/app/househelps/HousehelpsListPage.test.tsx`
- `apps/web/src/features/app/checklist/ChecklistTaskDetailPage.test.tsx`

These are plain object literals, not schema-validated — adding the field doesn't change what any of these tests assert, it only keeps the file typechecking cleanly against the now-wider `HousehelpDTO`.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `cd apps/web && npm run test -- HousehelpFormPage`
Expected: PASS (all tests in the file)

- [ ] **Step 6: Run the full web test suite as a regression check**

Run: `cd apps/web && npm run test`
Expected: PASS, no regressions

- [ ] **Step 7: Typecheck**

Run: `cd apps/web && npm run typecheck`
Expected: PASS

- [ ] **Step 8: Commit**

```bash
git add apps/web/src/features/app/househelps/HousehelpFormPage.tsx apps/web/src/features/app/househelps/HousehelpFormPage.test.tsx apps/web/src/features/app/salary/SalaryListPage.test.tsx apps/web/src/features/app/attendance/HousehelpCalendarPage.test.tsx apps/web/src/features/app/salary/SettlementDetailPage.test.tsx apps/web/src/features/app/househelps/HousehelpsListPage.test.tsx apps/web/src/features/app/checklist/ChecklistTaskDetailPage.test.tsx
git commit -m "feat(web): leaves-allowed-per-month field on the househelp form"
```

---

## Self-Review Notes

- **Spec coverage:** schema/DTO/CRUD (Task 1), calculation + mode gate + half-day handling (Task 2), form field + FIXED_MONTHLY-only visibility (Task 3) — every spec section has a task. The spec's note that the settlement-detail page needs no changes is reflected by Task 2/3 touching no page-display code.
- **Placeholder scan:** every step has concrete code; the migration file's exact name (Task 1 Step 6) is left to drizzle-kit's own output, with an explicit inspection instruction rather than a guessed filename.
- **Type consistency:** `allowedLeavesPerMonth` spelled identically across `dto.ts`, `schemas.ts`, `schema.ts` (as `allowed_leaves_per_month` in SQL), the service mapping, and the frontend form/tests. The deduction formula in Task 2's Global Constraints section matches the implementation code in Task 2 Step 3 exactly.
