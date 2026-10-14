# Daily Screens UX Redesign Implementation Plan

> **Status: Superseded** by `docs/superpowers/specs/2026-10-14-ghar-home-redesign-design.md` — the
> user provided a more complete design handoff covering tokens, shared components, shell/nav, and
> the home page. Task 1 (tokens) partially landed as commit `aff4bf0` before this was superseded;
> its values get corrected to the new spec's exact palette in the new plan's own Task 1. Tasks 2-3
> (picker collapse, Home direct actions) were never built and are not part of the new plan's scope.

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the "Sunrise" gradient/orange-violet theme with a flat Indigo + Warm Gray palette and all-sans typography, and cut the tap count for daily attendance/checklist marking by adding direct one-tap actions to the Home dashboard and collapsing the Attendance/Checklist status picker from a 2-step expand-then-pick into a single native-select interaction.

**Architecture:** This app's theme lives entirely in CSS custom properties in one file (`apps/web/src/styles/tokens.css`), so the visual change is a token-value edit plus updating the handful of places that reference the two tokens being removed (`--hero-gradient`, `--font-display`). The interaction changes reuse existing React Query mutation hooks (`useSetAttendance`, `useMarkCompletion`) — no new mutation logic, no backend changes.

**Tech Stack:** React 19, Vite, TanStack Query, vitest + @testing-library/react + @testing-library/user-event, existing `@household/shared` DTOs.

## Global Constraints

- No gradients anywhere after this plan — `--hero-gradient` is deleted, not just recolored.
- No orange or violet in the primary/decorative accent tokens (`--accent-*`, `--dusk`). Semantic status colors (`--ok`, `--overdue`, `--due-soon`, `--info`) are unchanged — they were not part of the complaint.
- `--font-display` (Fraunces serif) is deleted entirely. `--font` (the existing Atkinson Hyperlegible sans stack) is the only type family after this plan.
- Both the light (`:root`) and dark (`@media (prefers-color-scheme: dark)`) blocks in `tokens.css` get every changed variable updated in the same task/commit — never ship one without the other.
- No live-screenshot/visual-regression verification this round (explicit user decision) — verification is via grep (confirming removed tokens have zero remaining references) and the automated test suite.
- Existing attendance/checklist status *options* are unchanged (Present/Absent/Half-day/Leave/Holiday; Done/Skipped) — only how fast you reach them changes.
- Full `apps/web` test suite must stay green after every task.

---

### Task 1: Flat Indigo + Warm Gray tokens, no gradients, all-sans

**Files:**
- Modify: `apps/web/src/styles/tokens.css` (full palette/font rewrite, light + dark)
- Modify: `apps/web/src/styles/components.css:12` (`.btn--primary`)
- Modify: `apps/web/src/features/app/shell.css:74-100` (`.today`, `.today__date`, `.chip[aria-pressed="true"]`, delete the now-dead `hero-drift` keyframes)

**Interfaces:**
- Consumes: nothing new — this is a token-value-only change, no component props or function signatures change.
- Produces: `--accent-700` etc. now resolve to indigo instead of coral; `--dusk` resolves to the same indigo as `--accent-700`; `--today-500`/`--today-100` resolve to a muted ochre instead of bright amber-orange; `--font-display` no longer exists (any later task must not reintroduce a reference to it). These are the values later tasks and the self-review step check against.

- [ ] **Step 1: Rewrite the light and dark token blocks**

Replace the full contents of `apps/web/src/styles/tokens.css` with:

```css
/* Design tokens — the single source for colour, type, space and motion. */
:root {
  --font: "Atkinson Hyperlegible Next", "Atkinson Hyperlegible", system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;

  /* palette — flat "Indigo + Warm Gray", no gradients */
  --accent-900: #332C7A;
  --accent-700: #4F46B8;   /* primary */
  --accent-600: #6C63D6;
  --accent-100: #E3E0F7;
  --accent-50:  #F4F3FC;
  --today-500: #8A6D1E;  /* "today" marker — muted ochre, not orange */
  --today-100: #F2ECD8;
  --dusk: #4F46B8;        /* same indigo as the primary accent — no separate violet hue */
  --paper: #F6F5F3;
  --surface: #FFFFFF;
  --ink: #211F2B;
  --ink-2: #5B596A;
  --ink-3: #807E8F;
  --line: #E4E2EA;
  --line-strong: #D2CFDC;

  /* status — always paired with an icon or word, never colour alone */
  --overdue: #B3261E;  --overdue-bg: #FBE9E7;
  --due-soon: #9A5B00; --due-soon-bg: #FFF1DB;
  --ok: #1E6B40;       --ok-bg: #E3F2E8;
  --info: #1F5C8A;     --info-bg: #E5F0F8;

  /* type scale (17px base, 1.2 ratio) */
  --text-xs: 0.8125rem;
  --text-sm: 0.9375rem;
  --text-md: 1.0625rem;
  --text-lg: 1.275rem;
  --text-xl: 1.53rem;
  --text-2xl: 1.84rem;
  --text-3xl: 2.2rem;

  --space-1: 4px; --space-2: 8px; --space-3: 12px; --space-4: 16px;
  --space-5: 20px; --space-6: 24px; --space-8: 32px; --space-10: 40px; --space-12: 48px;

  --radius-sm: 8px;   /* inputs, badges */
  --radius-md: 14px;  /* cards */
  --radius-lg: 22px;  /* sheets */
  --touch: 48px;      /* ≥44px minimum target */

  --shadow-sheet: 0 -8px 32px rgba(33, 31, 43, 0.14);
  --shadow-card: 0 1px 2px rgba(33, 31, 43, 0.06), 0 8px 24px rgba(33, 31, 43, 0.08);
  --shadow-accent: 0 10px 24px -10px rgba(79, 70, 184, 0.4);
  --shadow-hero: 0 20px 50px -18px rgba(79, 70, 184, 0.3);
  --ease: cubic-bezier(0.2, 0.8, 0.2, 1);
  --dur: 180ms;

  --focus: 0 0 0 3px var(--paper), 0 0 0 5px var(--accent-700);

  --safe-top: env(safe-area-inset-top, 0px);
  --safe-bottom: env(safe-area-inset-bottom, 0px);
  --nav-h: 64px;

  color-scheme: light;
}

@media (prefers-color-scheme: dark) {
  :root {
    --accent-900: #D8D4FA;
    --accent-700: #8B82E8;
    --accent-600: #A79EF2;
    --accent-100: #2B2650;
    --accent-50: #211D3E;
    --today-500: #D4B86B;
    --today-100: #3A331C;
    --dusk: #8B82E8;
    --paper: #18171C;
    --surface: #221F29;
    --ink: #EFEDF2;
    --ink-2: #B8B5C4;
    --ink-3: #8D8A9B;
    --line: #332F3E;
    --line-strong: #423D4F;
    --overdue: #FF8A80;  --overdue-bg: #3A1714;
    --due-soon: #FFC266; --due-soon-bg: #3A2A10;
    --ok: #7FD6A0;       --ok-bg: #133222;
    --info: #8CC4F0;     --info-bg: #122838;
    --shadow-sheet: 0 -8px 32px rgba(0, 0, 0, 0.5);
    --shadow-card: 0 1px 2px rgba(0, 0, 0, 0.3), 0 8px 24px rgba(0, 0, 0, 0.35);
    --shadow-accent: 0 10px 24px -10px rgba(139, 130, 232, 0.4);
    --shadow-hero: 0 20px 50px -16px rgba(139, 130, 232, 0.25);
    color-scheme: dark;
  }
}
```

Note what changed from the previous file: `--font-display` and `--hero-gradient` are gone entirely; every other variable name is unchanged (so no renames needed in consuming files) but most hex values moved.

- [ ] **Step 2: Update `.btn--primary` to a flat background**

In `apps/web/src/styles/components.css`, change:

```css
.btn--primary { background: var(--hero-gradient); color: var(--paper); box-shadow: var(--shadow-accent); }
```

to:

```css
.btn--primary { background: var(--accent-700); color: var(--paper); box-shadow: var(--shadow-accent); }
```

- [ ] **Step 3: Update the Home hero header, date heading, and selected chip to flat colors**

In `apps/web/src/features/app/shell.css`, change:

```css
/* home "today" header — the Sunrise gradient hero */
.today {
  display: grid; gap: var(--space-2); margin-bottom: var(--space-8);
  background: var(--hero-gradient); background-size: 160% 160%;
  border-radius: var(--radius-lg); padding: var(--space-6) var(--space-5);
  color: #fff; box-shadow: var(--shadow-hero);
  animation: hero-drift 14s ease-in-out infinite alternate;
}
.today__greet { color: rgba(255, 255, 255, 0.85); font-weight: 500; }
.today__date {
  font-family: var(--font-display); font-size: var(--text-3xl); font-weight: 700;
  letter-spacing: -0.01em; line-height: 1.08; text-wrap: balance;
}
.today__date mark { background: none; color: inherit; box-shadow: inset 0 -0.28em 0 rgba(255, 255, 255, 0.35); padding: 0 0.04em; }
.today__stamp {
  display: inline-flex; align-items: center; gap: 6px; font-size: var(--text-sm); font-weight: 700;
  color: rgba(255, 255, 255, 0.9); background: rgba(255, 255, 255, 0.16);
  padding: var(--space-1) var(--space-3) var(--space-1) var(--space-2); border-radius: 999px; width: fit-content;
}
.today__dot { width: 8px; height: 8px; border-radius: 50%; background: #fff; }

@keyframes hero-drift { from { background-position: 0% 30%; } to { background-position: 100% 70%; } }
```

to:

```css
/* home "today" header — flat indigo */
.today {
  display: grid; gap: var(--space-2); margin-bottom: var(--space-8);
  background: var(--accent-700);
  border-radius: var(--radius-lg); padding: var(--space-6) var(--space-5);
  color: #fff; box-shadow: var(--shadow-hero);
}
.today__greet { color: rgba(255, 255, 255, 0.85); font-weight: 500; }
.today__date {
  font-size: var(--text-3xl); font-weight: 700;
  letter-spacing: -0.01em; line-height: 1.08; text-wrap: balance;
}
.today__date mark { background: none; color: inherit; box-shadow: inset 0 -0.28em 0 rgba(255, 255, 255, 0.35); padding: 0 0.04em; }
.today__stamp {
  display: inline-flex; align-items: center; gap: 6px; font-size: var(--text-sm); font-weight: 700;
  color: rgba(255, 255, 255, 0.9); background: rgba(255, 255, 255, 0.16);
  padding: var(--space-1) var(--space-3) var(--space-1) var(--space-2); border-radius: 999px; width: fit-content;
}
.today__dot { width: 8px; height: 8px; border-radius: 50%; background: #fff; }
```

(The `@keyframes hero-drift` rule is deleted along with the `animation` line — it only ever animated a gradient's position, which no longer exists.)

Then, further down in the same file, change:

```css
.chip[aria-pressed="true"] { border-color: transparent; background: var(--hero-gradient); color: var(--paper); font-weight: 700; }
```

to:

```css
.chip[aria-pressed="true"] { border-color: transparent; background: var(--accent-700); color: var(--paper); font-weight: 700; }
```

- [ ] **Step 4: Verify no dangling references to the removed tokens**

Run (from the repo root):

```bash
grep -rn "hero-gradient\|font-display\|Fraunces" apps/web/src
```

Expected: no output (zero matches). If anything matches, fix that file before continuing — this is the plan's substitute for live-screenshot verification per the Global Constraints.

- [ ] **Step 5: Run the full web test suite**

From `apps/web`:

```bash
npx vitest run
```

Expected: all existing tests still pass (this task changes no component logic, only CSS values).

- [ ] **Step 6: Commit**

```bash
git add apps/web/src/styles/tokens.css apps/web/src/styles/components.css apps/web/src/features/app/shell.css
git commit -m "feat(web): flat Indigo + Warm Gray theme, drop gradients and serif font"
```

---

### Task 2: Collapse the status picker from 2-step expand to a single select

**Files:**
- Modify: `apps/web/src/features/app/attendance/AttendancePicker.tsx` (rewrite as a native `<select>`)
- Modify: `apps/web/src/features/app/attendance/TodayPage.tsx:37-115` (remove `openFor` state and the "More" button, always render the picker)
- Modify: `apps/web/src/features/app/checklist/ChecklistTodayPage.tsx:38-153` (rewrite the inline `CompletionPicker` as a native `<select>`, remove `openFor` state and the "More" button)
- Modify: `apps/web/src/styles/components.css` (add `.status-select`)
- Test: `apps/web/src/features/app/attendance/TodayPage.test.tsx:45-62` (rewrite the "opens the picker" test, update the VIEWER test's assertion)
- Test: `apps/web/src/features/app/checklist/ChecklistTodayPage.test.tsx:82-100,102-116` (rewrite the "opens the picker" test, update the VIEWER test's assertion)

**Interfaces:**
- Consumes: `STATUS_LABEL` from `./statusTone.ts` (attendance) — unchanged, already read in Task-gathering research.
- Produces: `AttendancePicker` now takes `{ status, onSelect, label }` (added `label: string` prop, required — used as the select's `aria-label`). `onSelect` signature (`(status: AttendanceStatus | null) => void`) is unchanged, so `TodayPage.tsx`'s existing `onPick` function body does not need to change, only the state/button wiring around it.

- [ ] **Step 1: Write the failing test for the attendance picker (select-based)**

In `apps/web/src/features/app/attendance/TodayPage.test.tsx`, replace the `"opens the picker and sets Half-day"` test (currently lines 45-62) with:

```tsx
  it("sets Half-day via the status picker", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation((async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/households/h1")) return jsonResponse({ success: true, data: { ...HOUSEHOLD, permissions: ["attendance.view", "attendance.mark"] }, message: null });
      if (init?.method === "PUT" && url.includes("/attendance/hh1")) return jsonResponse({ success: true, data: { date: "2026-09-29", status: "HALF_DAY", note: null }, message: null });
      if (url.endsWith("/attendance/today")) {
        return jsonResponse({ success: true, data: { date: "2026-09-29", entries: [{ househelpId: "hh1", name: "Sunita", roleTitle: "Cook", scheduledToday: true, status: null, note: null }] } }, 200);
      }
      throw new Error(`unexpected fetch ${url}`);
    }) as typeof fetch);
    renderPage();
    await screen.findByText("Sunita");
    await userEvent.selectOptions(screen.getByLabelText("Change Sunita's status"), "HALF_DAY");
    const putCall = fetchSpy.mock.calls.find(([u, init]) => String(u).includes("/attendance/hh1") && (init as RequestInit | undefined)?.method === "PUT");
    expect(putCall).toBeDefined();
    const body = JSON.parse((putCall![1] as RequestInit).body as string);
    expect(body).toEqual({ date: "2026-09-29", status: "HALF_DAY" });
  });
```

Also update the `"hides marking controls for a VIEWER"` test (currently lines 101-114): replace

```tsx
    expect(screen.queryByRole("button", { name: "More" })).not.toBeInTheDocument();
```

with

```tsx
    expect(screen.queryByLabelText("Change Sunita's status")).not.toBeInTheDocument();
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
cd apps/web
npx vitest run src/features/app/attendance/TodayPage.test.tsx
```

Expected: FAIL — `screen.getByLabelText("Change Sunita's status")` finds no element (the select doesn't exist yet).

- [ ] **Step 3: Rewrite `AttendancePicker` as a native select**

Replace the full contents of `apps/web/src/features/app/attendance/AttendancePicker.tsx`:

```tsx
import type { AttendanceStatus } from "@household/shared";
import { STATUS_LABEL } from "./statusTone";

type OptionValue = AttendanceStatus | "UNMARKED";

const OPTIONS: { value: OptionValue; label: string }[] = [
  { value: "PRESENT", label: STATUS_LABEL.PRESENT },
  { value: "ABSENT", label: STATUS_LABEL.ABSENT },
  { value: "HALF_DAY", label: STATUS_LABEL.HALF_DAY },
  { value: "LEAVE", label: STATUS_LABEL.LEAVE },
  { value: "HOLIDAY", label: STATUS_LABEL.HOLIDAY },
  { value: "UNMARKED", label: "Not marked" },
];

export function AttendancePicker({ status, onSelect, label }: { status: AttendanceStatus | null; onSelect: (status: AttendanceStatus | null) => void; label: string }) {
  return (
    <select
      className="status-select"
      aria-label={label}
      value={status ?? "UNMARKED"}
      onChange={(e) => onSelect(e.target.value === "UNMARKED" ? null : (e.target.value as AttendanceStatus))}
    >
      {OPTIONS.map((opt) => (
        <option key={opt.value} value={opt.value}>{opt.label}</option>
      ))}
    </select>
  );
}
```

- [ ] **Step 4: Remove the expand/collapse state and "More" button from `TodayPage.tsx`**

In `apps/web/src/features/app/attendance/TodayPage.tsx`:

Remove the `openFor` state line:

```tsx
  const [openFor, setOpenFor] = useState<string | null>(null);
```

Simplify `onPick` by dropping the now-unused `setOpenFor(null);` line — change:

```tsx
  function onPick(househelpId: string, status: AttendanceStatus | null) {
    setOpenFor(null);
    if (status === null) {
```

to:

```tsx
  function onPick(househelpId: string, status: AttendanceStatus | null) {
    if (status === null) {
```

Replace the row rendering block:

```tsx
              {canMark && <Button variant="ghost" onClick={() => setOpenFor(openFor === e.househelpId ? null : e.househelpId)}>More</Button>}
            </div>
            {openFor === e.househelpId && (
              <div style={{ padding: "0 var(--space-4) var(--space-3)" }}>
                <AttendancePicker status={e.status} onSelect={(status) => onPick(e.househelpId, status)} />
              </div>
            )}
          </div>
```

with:

```tsx
              {canMark && (
                <AttendancePicker status={e.status} label={`Change ${e.name}'s status`} onSelect={(status) => onPick(e.househelpId, status)} />
              )}
            </div>
          </div>
```

Since `useState` is still used elsewhere in the file (`pageError`, `poppedId`), leave the `useState` import as-is.

- [ ] **Step 5: Add `.status-select` styling**

In `apps/web/src/styles/components.css`, add (near the `.chip` rules, or anywhere in the file):

```css
/* ── Status select (attendance/checklist picker) ───────── */
.status-select {
  min-height: 40px; padding: 0 var(--space-3); border-radius: var(--radius-sm);
  border: 1.5px solid var(--line-strong); background: var(--surface); color: var(--ink);
  font: inherit; font-weight: 500; cursor: pointer;
}
.status-select:focus { outline: none; border-color: var(--accent-700); box-shadow: 0 0 0 3px var(--accent-100); }
```

- [ ] **Step 6: Run the attendance test to verify it passes**

```bash
cd apps/web
npx vitest run src/features/app/attendance/TodayPage.test.tsx
```

Expected: PASS (all tests in the file, including the rewritten one and the updated VIEWER test).

- [ ] **Step 7: Write the failing test for the checklist picker (select-based)**

In `apps/web/src/features/app/checklist/ChecklistTodayPage.test.tsx`, replace the `"opens the picker and sets Skipped explicitly"` test (currently lines 82-100) with:

```tsx
  it("sets Skipped via the status picker", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation((async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/households/h1")) return jsonResponse({ success: true, data: { ...HOUSEHOLD, permissions: ["checklists.view", "checklists.complete"] }, message: null });
      if (init?.method === "PUT" && url.includes("/checklist/t1/completion")) return jsonResponse({ success: true, data: { date: "2026-09-30", status: "SKIPPED", note: null }, message: null });
      if (url.endsWith("/checklist/today")) {
        return jsonResponse({ success: true, data: { date: "2026-09-30", entries: [{ taskId: "t1", name: "Wash dishes", status: "COMPLETED", note: null }] } }, 200);
      }
      throw new Error(`unexpected fetch ${url}`);
    }) as typeof fetch);
    renderPage();
    await screen.findByText("Wash dishes");
    await userEvent.selectOptions(screen.getByLabelText("Change Wash dishes's status"), "SKIPPED");
    const putCall = fetchSpy.mock.calls.find(([u, init]) => String(u).includes("/checklist/t1/completion") && (init as RequestInit | undefined)?.method === "PUT");
    expect(putCall).toBeDefined();
    const body = JSON.parse((putCall![1] as RequestInit).body as string);
    expect(body).toEqual({ date: "2026-09-30", status: "SKIPPED" });
  });
```

Also update the `"hides marking controls for a VIEWER"` test (currently lines 102-115): replace

```tsx
    expect(screen.queryByRole("button", { name: "Skip" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "More" })).not.toBeInTheDocument();
```

with

```tsx
    expect(screen.queryByRole("button", { name: "Skip" })).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Change Wash dishes's status")).not.toBeInTheDocument();
```

- [ ] **Step 8: Run the test to verify it fails**

```bash
cd apps/web
npx vitest run src/features/app/checklist/ChecklistTodayPage.test.tsx
```

Expected: FAIL — `screen.getByLabelText("Change Wash dishes's status")` finds no element.

- [ ] **Step 9: Rewrite the inline `CompletionPicker` as a native select and remove the "More" button**

In `apps/web/src/features/app/checklist/ChecklistTodayPage.tsx`, replace the inline `CompletionPicker` component:

```tsx
const PICKER_OPTIONS: { value: MarkableStatus | null; label: string }[] = [
  { value: "COMPLETED", label: "Done" },
  { value: "SKIPPED", label: "Skipped" },
  { value: null, label: "Not marked" },
];

function CompletionPicker({ status, onSelect }: { status: CompletionStatus | null; onSelect: (status: MarkableStatus | null) => void }) {
  return (
    <div className="chips" role="group" aria-label="Completion status">
      {PICKER_OPTIONS.map((opt) => (
        <button key={opt.label} type="button" className="chip" aria-pressed={status === opt.value} onClick={() => onSelect(opt.value)}>
          {opt.label}
        </button>
      ))}
    </div>
  );
}
```

with:

```tsx
type PickerValue = MarkableStatus | "UNMARKED";

const PICKER_OPTIONS: { value: PickerValue; label: string }[] = [
  { value: "COMPLETED", label: "Done" },
  { value: "SKIPPED", label: "Skipped" },
  { value: "UNMARKED", label: "Not marked" },
];

function CompletionPicker({ status, onSelect, label }: { status: CompletionStatus | null; onSelect: (status: MarkableStatus | null) => void; label: string }) {
  return (
    <select
      className="status-select"
      aria-label={label}
      value={status ?? "UNMARKED"}
      onChange={(e) => onSelect(e.target.value === "UNMARKED" ? null : (e.target.value as MarkableStatus))}
    >
      {PICKER_OPTIONS.map((opt) => (
        <option key={opt.value} value={opt.value}>{opt.label}</option>
      ))}
    </select>
  );
}
```

Remove the `openFor` state line:

```tsx
  const [openFor, setOpenFor] = useState<string | null>(null);
```

Simplify `onPick` by dropping the now-unused `setOpenFor(null);` line — change:

```tsx
  function onPick(taskId: string, status: MarkableStatus | null) {
    setOpenFor(null);
    if (status === null) {
```

to:

```tsx
  function onPick(taskId: string, status: MarkableStatus | null) {
    if (status === null) {
```

Replace the row rendering block:

```tsx
              {canMark && <Button variant="ghost" onClick={() => setOpenFor(openFor === e.taskId ? null : e.taskId)}>More</Button>}
            </div>
            {openFor === e.taskId && (
              <div style={{ padding: "0 var(--space-4) var(--space-3)" }}>
                <CompletionPicker status={e.status} onSelect={(status) => onPick(e.taskId, status)} />
              </div>
            )}
          </div>
```

with:

```tsx
              {canMark && (
                <CompletionPicker status={e.status} label={`Change ${e.name}'s status`} onSelect={(status) => onPick(e.taskId, status)} />
              )}
            </div>
          </div>
```

- [ ] **Step 10: Run the checklist test to verify it passes**

```bash
cd apps/web
npx vitest run src/features/app/checklist/ChecklistTodayPage.test.tsx
```

Expected: PASS (all tests in the file).

- [ ] **Step 11: Run the full web test suite**

```bash
cd apps/web
npx vitest run
```

Expected: all tests pass.

- [ ] **Step 12: Commit**

```bash
git add apps/web/src/features/app/attendance/AttendancePicker.tsx apps/web/src/features/app/attendance/TodayPage.tsx apps/web/src/features/app/attendance/TodayPage.test.tsx apps/web/src/features/app/checklist/ChecklistTodayPage.tsx apps/web/src/features/app/checklist/ChecklistTodayPage.test.tsx apps/web/src/styles/components.css
git commit -m "feat(web): collapse attendance/checklist status picker to a single select"
```

---

### Task 3: Direct one-tap marking from the Home dashboard

**Files:**
- Modify: `apps/web/src/features/app/HomePage.tsx` (add direct-tap rows to the Household and Today's work cards)
- Test: `apps/web/src/features/app/HomePage.test.tsx` (extend the shared `renderPage` helper, add 2 new tests, update the existing "renders real content" test's fixture)

**Interfaces:**
- Consumes: `useTodayAttendance`, `useSetAttendance` from `./attendance/useAttendance.ts` (already defined, read in research: `useSetAttendance(householdId)` returns a mutation taking `{ househelpId, body: { date, status } }`). `useTodayChecklist`, `useMarkCompletion` from `./checklist/useChecklistCompletion.ts` (`useMarkCompletion(householdId)` takes `{ taskId, body: { date, status } }`). `useHousehold` from `./members/useMembers.ts` (returns `{ data: { permissions: string[] } }`). `toneOf`, `STATUS_LABEL` from `./attendance/statusTone.ts`. `usePendingKeys` from `../../lib/offline-queue.ts`.
- Produces: nothing new consumed by later tasks — this is the last task in the plan.

- [ ] **Step 1: Write the failing tests for direct-tap actions**

In `apps/web/src/features/app/HomePage.test.tsx`, replace the full file contents with:

```tsx
import "fake-indexeddb/auto";
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { meKey } from "../auth/session";
import { HomePage } from "./HomePage";

const HOUSEHOLD = { id: "h1", name: "Shah Family", timezone: "Asia/Kolkata", role: "OWNER" as const, memberCount: 2 };
const FULL_PERMISSIONS = ["attendance.view", "attendance.mark", "checklists.view", "checklists.complete", "bills.view", "salaries.view"];

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function renderPage(
  dashboard: unknown,
  opts?: { permissions?: string[]; attendanceEntries?: unknown[]; checklistEntries?: unknown[] },
) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  qc.setQueryData(meKey, { user: { id: "u1", name: "Parakh", email: "p@example.com", emailVerified: true, createdAt: "2026-01-01T00:00:00.000Z" }, households: [HOUSEHOLD] });
  const permissions = opts?.permissions ?? FULL_PERMISSIONS;
  const attendanceEntries = opts?.attendanceEntries ?? [];
  const checklistEntries = opts?.checklistEntries ?? [];
  vi.spyOn(globalThis, "fetch").mockImplementation((async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.endsWith("/households/h1/today")) return jsonResponse({ success: true, data: dashboard }, 200);
    if (url.endsWith("/households/h1")) return jsonResponse({ success: true, data: { ...HOUSEHOLD, permissions }, message: null });
    if (url.endsWith("/attendance/today")) return jsonResponse({ success: true, data: { date: "2026-09-29", entries: attendanceEntries } }, 200);
    if (url.endsWith("/checklist/today")) return jsonResponse({ success: true, data: { date: "2026-09-29", entries: checklistEntries } }, 200);
    if (init?.method === "PUT" && url.includes("/attendance/")) return jsonResponse({ success: true, data: { date: "2026-09-29", status: "PRESENT", note: null } }, 200);
    if (init?.method === "PUT" && url.includes("/completion")) return jsonResponse({ success: true, data: { date: "2026-09-29", status: "COMPLETED", note: null } }, 200);
    throw new Error(`unexpected fetch ${url}`);
  }) as typeof fetch);
  return { ...render(<QueryClientProvider client={qc}><MemoryRouter><HomePage /></MemoryRouter></QueryClientProvider>), fetchSpy: vi.mocked(globalThis.fetch) };
}

describe("HomePage", () => {
  beforeEach(() => { vi.restoreAllMocks(); });
  afterEach(() => { vi.restoreAllMocks(); });

  it("renders real content for every section the caller has permission for", async () => {
    renderPage(
      {
        attendance: { marked: 2, total: 3 },
        checklist: { done: 1, total: 2, pending: ["Sweep floor"] },
        bills: [{ occurrenceId: "o1", billId: "b1", billName: "Electricity", amountDuePaise: 50000, dueDate: "2026-09-29", isOverdue: false }],
        salary: { upcoming: { settlementId: "s1", househelpName: "Sunita", periodMonth: "2026-09-01", dueDate: "2026-10-05", netDuePaise: 1000000, status: "PENDING" }, hasAnySettlement: true },
      },
      {
        attendanceEntries: [
          { househelpId: "hh1", name: "Sunita", roleTitle: "Cook", scheduledToday: true, status: "PRESENT", note: null },
          { househelpId: "hh2", name: "Geeta", roleTitle: "Maid", scheduledToday: true, status: "PRESENT", note: null },
          { househelpId: "hh3", name: "Ravi", roleTitle: "Driver", scheduledToday: true, status: null, note: null },
        ],
        checklistEntries: [{ taskId: "t1", name: "Sweep floor", status: null, note: null }],
      },
    );
    await screen.findByText("2 of 3 marked today");
    await screen.findByText("1 of 2 done");
    await screen.findByText("Sweep floor");
    await screen.findByText("Electricity");
    await screen.findByText(/Sunita/);
  });

  it("hides a card entirely when its section is absent (no permission)", async () => {
    renderPage({
      attendance: { marked: 0, total: 0 },
      checklist: { done: 0, total: 0, pending: [] },
      // bills and salary omitted — caller lacks bills.view/salaries.view
    });
    await screen.findByText("No househelps yet");
    expect(screen.queryByText("Payments")).not.toBeInTheDocument();
    expect(screen.queryByText("Salaries")).not.toBeInTheDocument();
  });

  it("shows a due-today-agnostic empty state for bills, not a 'no bills tracked' message", async () => {
    renderPage({
      attendance: { marked: 0, total: 0 },
      checklist: { done: 0, total: 0, pending: [] },
      bills: [],
      salary: { upcoming: null, hasAnySettlement: false },
    });
    await screen.findByText("Nothing due today");
    expect(screen.queryByText(/No bills tracked/)).not.toBeInTheDocument();
  });

  it("shows the all-settled empty state when permitted but nothing is due", async () => {
    renderPage({
      attendance: { marked: 0, total: 0 },
      checklist: { done: 0, total: 0, pending: [] },
      bills: [],
      salary: { upcoming: null, hasAnySettlement: true },
    });
    await screen.findByText("All settled up");
  });

  it("shows the nothing-due empty state when permitted and no settlement exists yet", async () => {
    renderPage({
      attendance: { marked: 0, total: 0 },
      checklist: { done: 0, total: 0, pending: [] },
      bills: [],
      salary: { upcoming: null, hasAnySettlement: false },
    });
    await screen.findByText("Nothing due");
  });

  it("marks a househelp Present directly from the Household card", async () => {
    const { fetchSpy } = renderPage(
      { attendance: { marked: 0, total: 1 } },
      { attendanceEntries: [{ househelpId: "hh1", name: "Geeta", roleTitle: "Maid", scheduledToday: true, status: null, note: null }] },
    );
    const row = await screen.findByText("Geeta");
    await userEvent.click(row);
    const putCall = fetchSpy.mock.calls.find(([u, init]) => String(u).includes("/attendance/hh1") && (init as RequestInit | undefined)?.method === "PUT");
    expect(putCall).toBeDefined();
    const body = JSON.parse((putCall![1] as RequestInit).body as string);
    expect(body).toEqual({ date: "2026-09-29", status: "PRESENT" });
  });

  it("marks a checklist task Done directly from the Today's work card", async () => {
    const { fetchSpy } = renderPage(
      { checklist: { done: 0, total: 1, pending: ["Wash dishes"] } },
      { checklistEntries: [{ taskId: "t1", name: "Wash dishes", status: null, note: null }] },
    );
    const row = await screen.findByText("Wash dishes");
    await userEvent.click(row);
    const putCall = fetchSpy.mock.calls.find(([u, init]) => String(u).includes("/checklist/t1/completion") && (init as RequestInit | undefined)?.method === "PUT");
    expect(putCall).toBeDefined();
    const body = JSON.parse((putCall![1] as RequestInit).body as string);
    expect(body).toEqual({ date: "2026-09-29", status: "COMPLETED" });
  });
});
```

- [ ] **Step 2: Run the test to verify the two new tests fail**

```bash
cd apps/web
npx vitest run src/features/app/HomePage.test.tsx
```

Expected: the 6 pre-existing tests pass unchanged (the new `renderPage` helper's defaults preserve their behavior), and the 2 new tests FAIL because `HomePage` doesn't yet render tappable rows or call `/attendance/today` / `/checklist/today`.

- [ ] **Step 3: Add direct-tap rows to `HomePage.tsx`**

Replace the full contents of `apps/web/src/features/app/HomePage.tsx`:

```tsx
import { useState } from "react";
import { ClipboardCheck, ReceiptIndianRupee, Users, Wallet } from "lucide-react";
import { Link, useNavigate } from "react-router-dom";
import type { AttendanceStatus } from "@household/shared";
import { formatINR } from "@household/shared";
import { useSession } from "../auth/session";
import { greeting, longDate } from "../../lib/format";
import { ApiError } from "../../lib/api";
import { Alert } from "../../components/Alert";
import { Button } from "../../components/Button";
import { EmptyState } from "../../components/EmptyState";
import { VerifyEmailBanner } from "./VerifyEmailBanner";
import { STATUS_LABEL, toneOf } from "./attendance/statusTone";
import { useSetAttendance, useTodayAttendance } from "./attendance/useAttendance";
import { useMarkCompletion, useTodayChecklist } from "./checklist/useChecklistCompletion";
import { useHousehold } from "./members/useMembers";
import { STATUS_LABEL as SALARY_STATUS_LABEL, toneOf as salaryToneOf } from "./salary/statusTone";
import { useActiveHousehold } from "./useActiveHousehold";
import { usePendingKeys } from "../../lib/offline-queue";
import { useTodayDashboard } from "./useTodayDashboard";

/** "2026-10-01" -> "October 2026". */
function monthLabel(periodMonth: string): string {
  const [y, m] = periodMonth.split("-").map(Number);
  return new Date(Date.UTC(y!, m! - 1, 1)).toLocaleDateString("en-IN", { month: "long", year: "numeric", timeZone: "UTC" });
}

function messageFrom(err: unknown): string {
  return err instanceof ApiError ? err.message : "Something went wrong. Please try again.";
}

export function HomePage() {
  const { data } = useSession();
  const navigate = useNavigate();
  const { household } = useActiveHousehold();
  const householdId = household?.id;
  const householdQuery = useHousehold(householdId);
  const dashboardQuery = useTodayDashboard(householdId);
  const attendanceQuery = useTodayAttendance(householdId);
  const checklistQuery = useTodayChecklist(householdId);
  const setAttendance = useSetAttendance(householdId ?? "");
  const markCompletion = useMarkCompletion(householdId ?? "");
  const pendingKeys = usePendingKeys();
  const dashboard = dashboardQuery.data;
  const canMarkAttendance = householdQuery.data?.permissions.includes("attendance.mark") ?? false;
  const canMarkChecklist = householdQuery.data?.permissions.includes("checklists.complete") ?? false;
  const [pageError, setPageError] = useState<string | null>(null);
  const [poppedId, setPoppedId] = useState<string | null>(null);
  const tz = household?.timezone ?? "Asia/Kolkata";
  const now = new Date();
  const [weekday, ...rest] = longDate(now, tz).split(" ");
  const firstName = data?.user.name.split(/\s+/)[0];

  function onToggleAttendance(househelpId: string, current: AttendanceStatus | null) {
    const date = attendanceQuery.data?.date;
    if (!date) return;
    const next: AttendanceStatus = current === "PRESENT" ? "ABSENT" : "PRESENT";
    setAttendance.mutate(
      { househelpId, body: { date, status: next } },
      { onSuccess: () => setPoppedId(`a:${househelpId}`), onError: (err) => setPageError(messageFrom(err)) },
    );
  }

  function onMarkDone(taskId: string) {
    const date = checklistQuery.data?.date;
    if (!date) return;
    markCompletion.mutate(
      { taskId, body: { date, status: "COMPLETED" } },
      { onSuccess: () => setPoppedId(`c:${taskId}`), onError: (err) => setPageError(messageFrom(err)) },
    );
  }

  return (
    <>
      <VerifyEmailBanner />
      <header className="today">
        <p className="today__greet">{greeting(now, tz)}{firstName ? `, ${firstName}` : ""}</p>
        <h1 className="today__date"><mark>{weekday?.replace(",", "")}</mark>,<br />{rest.join(" ")}</h1>
        <p className="today__stamp"><span className="today__dot" aria-hidden />Today at {household?.name}</p>
      </header>
      {pageError && <Alert tone="error" title={pageError} />}
      <div className="home-grid">
        {dashboard?.attendance && (
          <section className="card card--enter" style={{ animationDelay: "0ms" }} aria-labelledby="h-help">
            <h2 className="card__title" id="h-help">Househelp</h2>
            {dashboard.attendance.total === 0 ? (
              <EmptyState icon={<Users size={22} />} title="No househelps yet" text="Add the people who help at home to track who's coming each day." tone="coral" />
            ) : (
              <div className="list">
                <Link to="/attendance" className="list__item">
                  <span className="list__label">{dashboard.attendance.marked} of {dashboard.attendance.total} marked today</span>
                </Link>
                {canMarkAttendance && attendanceQuery.data?.entries.map((e) => (
                  <button
                    key={e.househelpId}
                    type="button"
                    className="list__item"
                    style={{ width: "100%", textAlign: "left", background: "none", border: 0, cursor: "pointer" }}
                    onClick={() => onToggleAttendance(e.househelpId, e.status)}
                  >
                    <span className="list__label">{e.name}</span>
                    <span
                      className={`badge badge--${toneOf(e.status)}${poppedId === `a:${e.househelpId}` ? " pop-in" : ""}`}
                      onAnimationEnd={() => setPoppedId((id) => (id === `a:${e.househelpId}` ? null : id))}
                    >
                      {e.status ? STATUS_LABEL[e.status] : "Not marked"}
                      {pendingKeys.has(`attendance:${e.househelpId}:${attendanceQuery.data?.date}`) && (
                        <span aria-label="Not yet synced" title="Will sync when you're back online"> ⏳</span>
                      )}
                    </span>
                  </button>
                ))}
              </div>
            )}
          </section>
        )}
        {dashboard?.checklist && (
          <section className="card card--enter" style={{ animationDelay: "70ms" }} aria-labelledby="h-work">
            <h2 className="card__title" id="h-work">Today's work</h2>
            {dashboard.checklist.total === 0 ? (
              <EmptyState icon={<ClipboardCheck size={22} />} title="No tasks for today" text="Create a checklist — daily dusting, Saturday bathrooms — and tick things off as they're done." tone="amber" />
            ) : (
              <div className="list">
                <Link to="/checklist/today" className="list__item">
                  <span className="list__label">{dashboard.checklist.done} of {dashboard.checklist.total} done</span>
                </Link>
                {canMarkChecklist && checklistQuery.data?.entries.filter((e) => e.status === null).map((e) => (
                  <button
                    key={e.taskId}
                    type="button"
                    className="list__item"
                    style={{ width: "100%", textAlign: "left", background: "none", border: 0, cursor: "pointer" }}
                    onClick={() => onMarkDone(e.taskId)}
                  >
                    <span className="list__label">
                      {e.name}
                      {pendingKeys.has(`checklist:${e.taskId}:${checklistQuery.data?.date}`) && (
                        <span aria-label="Not yet synced" title="Will sync when you're back online"> ⏳</span>
                      )}
                    </span>
                  </button>
                ))}
              </div>
            )}
          </section>
        )}
        {dashboard?.bills && (
          <section className="card card--enter" style={{ animationDelay: "140ms" }} aria-labelledby="h-pay">
            <h2 className="card__title" id="h-pay">Payments</h2>
            {dashboard.bills.length === 0 ? (
              <EmptyState icon={<ReceiptIndianRupee size={22} />} title="Nothing due today" text="Bills due today or overdue show up here. Check the Bills page for everything you're tracking." tone="dusk" />
            ) : (
              <div className="list">
                {dashboard.bills.map((b) => (
                  <Link key={b.occurrenceId} to={`/bills/${b.billId}`} className="list__item">
                    <span className="list__text">
                      <span className="list__label" style={{ display: "block" }}>{b.billName}</span>
                      <span className="list__meta">{formatINR(b.amountDuePaise)} · {b.dueDate}</span>
                    </span>
                    {b.isOverdue && <span className="badge badge--error">Overdue</span>}
                  </Link>
                ))}
              </div>
            )}
          </section>
        )}
        {dashboard?.salary && (
          <section className="card card--enter" style={{ animationDelay: "210ms" }} aria-labelledby="h-sal">
            <h2 className="card__title" id="h-sal">Salaries</h2>
            {dashboard.salary.upcoming ? (
              <div className="list">
                <Link to={`/salary/${dashboard.salary.upcoming.settlementId}`} className="list__item">
                  <span className="list__text">
                    <span className="list__label" style={{ display: "block" }}>{dashboard.salary.upcoming.househelpName} · {monthLabel(dashboard.salary.upcoming.periodMonth)}</span>
                    <span className="list__meta">{formatINR(dashboard.salary.upcoming.netDuePaise)} due</span>
                  </span>
                  <span className={`badge badge--${salaryToneOf(dashboard.salary.upcoming.status)}`}>{SALARY_STATUS_LABEL[dashboard.salary.upcoming.status]}</span>
                </Link>
              </div>
            ) : dashboard.salary.hasAnySettlement ? (
              <EmptyState
                icon={<Wallet size={22} />} title="All settled up" text="Every settlement for this household has been paid in full." tone="coral"
                action={<Button variant="secondary" onClick={() => navigate("/salary")}>View all salaries</Button>}
              />
            ) : (
              <EmptyState
                icon={<Wallet size={22} />} title="Nothing due" text="Salaries appear here a few days before they're due." tone="coral"
                action={<Button variant="secondary" onClick={() => navigate("/salary")}>View all salaries</Button>}
              />
            )}
          </section>
        )}
      </div>
    </>
  );
}
```

Note: the salary section's `STATUS_LABEL`/`toneOf` import is renamed to `SALARY_STATUS_LABEL`/`salaryToneOf` on import (via `as`) because the attendance module now also exports `STATUS_LABEL`/`toneOf` and both are needed in this file — this avoids a naming collision, it does not change either module's actual exports.

- [ ] **Step 4: Run the test to verify it passes**

```bash
cd apps/web
npx vitest run src/features/app/HomePage.test.tsx
```

Expected: all 8 tests pass.

- [ ] **Step 5: Run the full web test suite**

```bash
cd apps/web
npx vitest run
```

Expected: all tests pass.

- [ ] **Step 6: Commit**

```bash
git add apps/web/src/features/app/HomePage.tsx apps/web/src/features/app/HomePage.test.tsx
git commit -m "feat(web): direct one-tap attendance/checklist marking from Home"
```

---

After Task 3, run the full three-workspace test suite (api/web/shared) once at merge time per this project's established cadence, then use superpowers:finishing-a-development-branch.
