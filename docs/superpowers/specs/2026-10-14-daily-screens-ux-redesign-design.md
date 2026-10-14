# Daily Screens UX Redesign — Design Spec

**Status:** Superseded by `2026-10-14-ghar-home-redesign-design.md` — the user provided a more complete,
concrete design handoff (dark-first Indigo/Warm-Gray/Coral tokens, full component list, shell/nav
rebuild, home page structure) covering the same screens plus more. No implementation work from this
spec was built. Kept for history.

## Context

User feedback: the current "Sunrise" theme (violet-dusk/coral/amber gradients, Fraunces serif
headings) looks cheap/unpolished — specifically the gradients and the orange+violet color
combination. Separately, the daily-use flows (Home, Attendance, Checklist) take more taps than
they should for routine actions.

This redesign addresses both, scoped to the daily-use screens first: **Home** (`HomePage.tsx`),
**Attendance** (`TodayPage.tsx`), and **Checklist** (`ChecklistTodayPage.tsx`).

Theme tokens live in one global file (`apps/web/src/styles/tokens.css`), used app-wide — there is
no per-screen theming mechanism. Per the user's explicit decision, the palette/typography change
is applied globally in this spec (it's one file, can't be cleanly scoped), with Home/Attendance/
Checklist as the priority for build-out and the interaction-flow changes. Other screens inherit
the new look for free from the same token change.

## Visual Direction

Replace the Sunrise palette with flat **Indigo + Warm Gray** — no gradients anywhere:

- Primary accent: Indigo `#4f46b8` (light) / a lighter indigo tuned for dark mode contrast.
- Neutrals: warm gray surfaces/borders, replacing the current paper/line warm-brown tones.
- `--hero-gradient` is removed entirely — no component renders a gradient background after this
  spec.
- `--font-display` (Fraunces serif) is removed; `--font` (the existing Atkinson Hyperlegible
  sans) becomes the only type family, used for both headings and body.
- Status colors are redefined on the new neutral base (kept as distinct hue+word pairs, never
  color alone, per the existing a11y convention in `tokens.css`):
  - Present / Done → muted green (reuse `--ok` hue family, re-tuned to sit well with indigo)
  - Absent → muted red/clay (reuse `--overdue` hue family)
  - Half-day → amber (reuse `--due-soon` hue family)
  - Leave → neutral gray-blue (new token)
  - Holiday → the indigo accent itself
- Both the light (`:root`) and dark (`@media (prefers-color-scheme: dark)`) blocks in
  `tokens.css` get every new/changed variable defined together, in the same change — not as a
  follow-up pass. (The last theme rollout shipped dark-mode tokens broken for 3 follow-up passes;
  this spec avoids that by treating light+dark as one edit, not two.)
- Shadows/radii/spacing/motion tokens are unchanged — only color and font-family tokens move.

## Interaction Changes

**Home dashboard direct actions:** `HomePage.tsx` currently only links out to `/attendance` and
`/checklist/today`. It gains direct one-tap marking for the default action, reusing the existing
mutation hooks (`useSetAttendance`, `useMarkCompletion`):
- Household card: tapping a househelp's name toggles Present ⇄ Absent, same semantics as
  `TodayPage.tsx`'s row tap.
- Today's work card: tapping a pending task name marks it Done.
- The card's summary count and the link to the full page stay — this adds a capability, it
  doesn't remove navigation.

**Faster "More" picker:** `AttendancePicker`/`CompletionPicker` currently require tap-to-expand
then tap-to-select (2 taps on top of the already-open row = 3 taps from Home). This collapses to
a single tap that opens the status options directly as a compact popover, cutting it to 2 taps
from Home. The set of statuses offered is unchanged (Half-day/Leave/Holiday/Not-marked for
attendance; Done/Skipped/Not-marked for checklist).

## Technical Approach

- `apps/web/src/styles/tokens.css`: palette and font-family tokens rewritten (light + dark
  together, per above). `--hero-gradient` and any component-level reference to it removed.
- `apps/web/src/features/app/HomePage.tsx`: add tap handlers wired to the existing
  `useSetAttendance`/`useMarkCompletion` hooks (same hooks `TodayPage.tsx`/
  `ChecklistTodayPage.tsx` already use — no new mutation logic).
- `AttendancePicker`/`CompletionPicker` components: collapse the two-step expand+select into a
  single-tap popover trigger.
- Any component currently depending on `--font-display` or the gradient token gets updated to the
  new tokens (a repo-wide grep for both before considering this done).

## Testing

- Existing component tests for `HomePage.tsx`, `TodayPage.tsx`, `ChecklistTodayPage.tsx` get
  extended to cover the new direct-tap-from-Home behavior and the collapsed picker interaction.
- No live-screenshot/visual-regression pass this time — per explicit user decision, this spec
  relies on code-level review (token file correctness, light+dark parity) and the automated test
  suite rather than browser verification.
- Full workspace test suites (api/web/shared) run green at merge time, same cadence as every
  other spec this project.

## Out of Scope

- Screens beyond Home/Attendance/Checklist are not actively redesigned in this spec, though they
  inherit the new global tokens automatically (same file). Any screen-specific layout/copy issues
  on those pages are not addressed here.
- The attendance/checklist status *options* themselves are unchanged — only how fast you reach
  them.
- Bulk actions (mark holiday, mark remaining present) and their `window.confirm` dialogs are
  unchanged — not raised as a complaint in this round.
