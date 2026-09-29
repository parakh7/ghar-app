# Warm Minimal Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the app's green/turmeric visual identity with the approved Warm Minimal palette (off-white paper, charcoal ink, terracotta accent, ochre-gold "today"), across every existing web screen, without changing layout, spacing, type, radius, or behavior.

**Architecture:** Rename and revalue the CSS custom properties in `apps/web/src/styles/tokens.css` (light block + `prefers-color-scheme: dark` block), then update the 6 files that reference the old token names by name. Every screen consumes these same tokens through the existing class system, so no per-page changes are needed beyond that.

**Tech Stack:** Plain CSS custom properties (no CSS-in-JS, no build-time token generation), React 19 + Vite 8 for the consuming components.

## Global Constraints

- Font (`Atkinson Hyperlegible Next` stack), type scale, spacing scale, radius scale (`--radius-sm: 8px`, `--radius-md: 14px`, `--radius-lg: 22px`), touch target (`--touch: 48px`), and motion tokens (`--ease`, `--dur`) are **unchanged** — do not touch them.
- Status colors (`--overdue`, `--due-soon`, `--ok`, `--info` and their `-bg` pairs) are **unchanged** in both light and dark — they predate the green theme and stay as-is.
- Status is always shown as a word or icon *plus* color, never color alone — this is an existing rule in the codebase (see `Alert`/badge usage), not something this plan changes, but don't break it while editing.
- No new files, no backend changes, no component logic changes — this is a token rename/revalue plus mechanical find-and-replace of the old token names in the 6 consuming files.
- Spec: `docs/superpowers/specs/2026-09-29-warm-minimal-redesign-design.md`.

---

### Task 1: Rename and revalue design tokens across all 7 files

**Files:**
- Modify: `apps/web/src/styles/tokens.css` (full rewrite of the palette block, light and dark)
- Modify: `apps/web/src/styles/base.css:16`
- Modify: `apps/web/src/styles/components.css` (multiple lines)
- Modify: `apps/web/src/features/app/shell.css` (multiple lines)
- Modify: `apps/web/src/features/auth/auth.css:8`
- Modify: `apps/web/src/components/Logo.tsx`
- Modify: `apps/web/src/features/app/MorePage.tsx:41`

**Interfaces:**
- Consumes: nothing from earlier tasks (this is the first task).
- Produces: the renamed tokens `--accent-900`, `--accent-700`, `--accent-600`, `--accent-100`, `--accent-50`, `--today-500`, `--today-100` (replacing `--neem-900`, `--neem-700`, `--neem-600`, `--neem-100`, `--neem-50`, `--haldi-500`, `--haldi-100` respectively) — Task 2's grep-based verification checks that the old names are gone everywhere.

- [ ] **Step 1: Replace the entire contents of `apps/web/src/styles/tokens.css`**

```css
/* Design tokens — the single source for colour, type, space and motion. */
:root {
  --font: "Atkinson Hyperlegible Next", "Atkinson Hyperlegible", system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;

  /* palette */
  --accent-900: #7A2708;
  --accent-700: #C2410C;   /* primary */
  --accent-600: #D6551F;
  --accent-100: #F5DDD0;
  --accent-50:  #FBEEE6;
  --today-500: #B8790C;  /* reserved for "today" */
  --today-100: #F6E6C6;
  --paper: #FAF7F2;
  --surface: #FFFFFF;
  --ink: #2D2A26;
  --ink-2: #5C554C;
  --ink-3: #8A7F70;
  --line: #E8E1D6;
  --line-strong: #D8CFC0;

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

  --shadow-sheet: 0 -8px 32px rgba(45, 42, 26, 0.14);
  --ease: cubic-bezier(0.2, 0.8, 0.2, 1);
  --dur: 180ms;

  --focus: 0 0 0 3px var(--paper), 0 0 0 5px var(--accent-600);

  --safe-top: env(safe-area-inset-top, 0px);
  --safe-bottom: env(safe-area-inset-bottom, 0px);
  --nav-h: 64px;

  color-scheme: light;
}

@media (prefers-color-scheme: dark) {
  :root {
    --accent-700: #E68A5C;
    --accent-600: #EF9B70;
    --accent-900: #F5CDB5;
    --accent-100: #3D2A1F;
    --accent-50: #2E211A;
    --today-500: #D9A441;
    --today-100: #3D3016;
    --paper: #1C1815;
    --surface: #241F1A;
    --ink: #F3EDE4;
    --ink-2: #C9BFB2;
    --ink-3: #A69C8E;
    --line: #3A332C;
    --line-strong: #4E463C;
    --overdue: #FF8A80;  --overdue-bg: #3A1714;
    --due-soon: #FFC266; --due-soon-bg: #3A2A10;
    --ok: #7FD6A0;       --ok-bg: #133222;
    --info: #8CC4F0;     --info-bg: #122838;
    --shadow-sheet: 0 -8px 32px rgba(0, 0, 0, 0.5);
    color-scheme: dark;
  }
}
```

- [ ] **Step 2: Update `apps/web/src/styles/base.css`**

Change line 16 from:
```css
a { color: var(--neem-700); text-underline-offset: 3px; }
```
to:
```css
a { color: var(--accent-700); text-underline-offset: 3px; }
```

- [ ] **Step 3: Update `apps/web/src/styles/components.css`**

Replace lines 12-17 (the `.btn--primary`/`.btn--secondary`/`.btn--ghost` block) from:
```css
.btn--primary { background: var(--neem-700); color: var(--paper); }
.btn--primary:hover:not(:disabled) { background: var(--neem-600); }
.btn--secondary { background: var(--surface); color: var(--neem-700); border-color: var(--line-strong); }
.btn--secondary:hover:not(:disabled) { border-color: var(--neem-700); }
.btn--ghost { background: transparent; color: var(--neem-700); padding: 0 var(--space-3); }
.btn--ghost:hover:not(:disabled) { background: var(--neem-50); }
```
to:
```css
.btn--primary { background: var(--accent-700); color: var(--paper); }
.btn--primary:hover:not(:disabled) { background: var(--accent-600); }
.btn--secondary { background: var(--surface); color: var(--accent-700); border-color: var(--line-strong); }
.btn--secondary:hover:not(:disabled) { border-color: var(--accent-700); }
.btn--ghost { background: transparent; color: var(--accent-700); padding: 0 var(--space-3); }
.btn--ghost:hover:not(:disabled) { background: var(--accent-50); }
```

Change line 37 from:
```css
.input:focus { outline: none; border-color: var(--neem-700); box-shadow: 0 0 0 3px var(--neem-100); }
```
to:
```css
.input:focus { outline: none; border-color: var(--accent-700); box-shadow: 0 0 0 3px var(--accent-100); }
```

Change line 60 from:
```css
.empty__icon { width: 44px; height: 44px; border-radius: 12px; display: grid; place-items: center; background: var(--neem-50); color: var(--neem-700); }
```
to:
```css
.empty__icon { width: 44px; height: 44px; border-radius: 12px; display: grid; place-items: center; background: var(--accent-50); color: var(--accent-700); }
```

Change line 65 from:
```css
.skeleton { background: linear-gradient(90deg, var(--line) 0%, var(--neem-50) 50%, var(--line) 100%); background-size: 200% 100%; animation: shimmer 1.2s linear infinite; border-radius: var(--radius-sm); }
```
to:
```css
.skeleton { background: linear-gradient(90deg, var(--line) 0%, var(--accent-50) 50%, var(--line) 100%); background-size: 200% 100%; animation: shimmer 1.2s linear infinite; border-radius: var(--radius-sm); }
```

Change line 71 from:
```css
.badge--neutral { background: var(--neem-50); color: var(--neem-700); }
```
to:
```css
.badge--neutral { background: var(--accent-50); color: var(--accent-700); }
```

- [ ] **Step 4: Update `apps/web/src/features/app/shell.css`**

Change line 23 from:
```css
.shell__link.active { color: var(--neem-700); }
```
to:
```css
.shell__link.active { color: var(--accent-700); }
```

Change line 25 from:
```css
  content: ""; position: absolute; top: 0; left: 30%; right: 30%; height: 3px; border-radius: 0 0 3px 3px; background: var(--neem-700);
```
to:
```css
  content: ""; position: absolute; top: 0; left: 30%; right: 30%; height: 3px; border-radius: 0 0 3px 3px; background: var(--accent-700);
```

Change line 36 from:
```css
  .shell__app { font-weight: 800; color: var(--neem-700); line-height: 1.1; }
```
to:
```css
  .shell__app { font-weight: 800; color: var(--accent-700); line-height: 1.1; }
```

Change lines 40-41 from:
```css
  .shell__link:hover { background: var(--neem-50); }
  .shell__link.active { background: var(--neem-50); }
```
to:
```css
  .shell__link:hover { background: var(--accent-50); }
  .shell__link.active { background: var(--accent-50); }
```

Change line 56 from:
```css
.today__date mark { background: none; color: inherit; box-shadow: inset 0 -0.28em 0 var(--haldi-100); padding: 0 0.04em; }
```
to:
```css
.today__date mark { background: none; color: inherit; box-shadow: inset 0 -0.28em 0 var(--today-100); padding: 0 0.04em; }
```

Change line 58 from:
```css
.today__dot { width: 10px; height: 10px; border-radius: 50%; background: var(--haldi-500); }
```
to:
```css
.today__dot { width: 10px; height: 10px; border-radius: 50%; background: var(--today-500); }
```

Change line 63 from:
```css
.chip[aria-pressed="true"] { border-color: var(--neem-700); background: var(--neem-50); color: var(--neem-700); font-weight: 700; }
```
to:
```css
.chip[aria-pressed="true"] { border-color: var(--accent-700); background: var(--accent-50); color: var(--accent-700); font-weight: 700; }
```

- [ ] **Step 5: Update `apps/web/src/features/auth/auth.css`**

Change line 8 from:
```css
.auth__wordmark { font-weight: 800; font-size: var(--text-xl); letter-spacing: -0.02em; color: var(--neem-700); }
```
to:
```css
.auth__wordmark { font-weight: 800; font-size: var(--text-xl); letter-spacing: -0.02em; color: var(--accent-700); }
```

- [ ] **Step 6: Update `apps/web/src/components/Logo.tsx`**

Replace the entire file contents with:
```tsx
export function Logo({ size = 36 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 64 64" aria-hidden focusable="false">
      <rect width="64" height="64" rx="14" fill="var(--accent-700)" />
      <path d="M16 30 32 17l16 13v17a2 2 0 0 1-2 2H18a2 2 0 0 1-2-2z" fill="none" stroke="var(--paper)" strokeWidth="4" strokeLinejoin="round" />
      <circle cx="32" cy="37" r="5" fill="var(--today-500)" />
    </svg>
  );
}
```

- [ ] **Step 7: Update `apps/web/src/features/app/MorePage.tsx`**

Change line 41 from:
```tsx
            {h.id === household?.id && <Check size={22} aria-hidden color="var(--neem-700)" />}
```
to:
```tsx
            {h.id === household?.id && <Check size={22} aria-hidden color="var(--accent-700)" />}
```

- [ ] **Step 8: Run the web test suite to confirm no regressions**

Run: `npm run test --workspace @household/web`
Expected: PASS — the existing component tests assert on text content and behavior, not computed CSS values, so a pure token/CSS rename shouldn't affect them. (Baseline before this change: 3 test files, 13 tests passing.)

- [ ] **Step 9: Run typecheck and lint**

Run: `npm run typecheck && npm run lint`
Expected: PASS — `Logo.tsx` and `MorePage.tsx` changes are string-literal edits only, no type changes.

- [ ] **Step 10: Commit**

```bash
git add apps/web/src/styles/tokens.css apps/web/src/styles/base.css apps/web/src/styles/components.css apps/web/src/features/app/shell.css apps/web/src/features/auth/auth.css apps/web/src/components/Logo.tsx apps/web/src/features/app/MorePage.tsx
git commit -m "feat(web): warm-minimal visual redesign — replace green/turmeric tokens"
```

---

### Task 2: Verify the redesign is complete and correct

**Files:**
- No file changes expected in this task unless verification surfaces a leftover reference, in which case fix it in the same file Task 1 already touched.

**Interfaces:**
- Consumes: the renamed tokens from Task 1 (`--accent-*`, `--today-*`).
- Produces: nothing for later tasks — this is the final task in the plan.

- [ ] **Step 1: Grep for leftover old token names**

Run: `grep -rn "neem\|haldi" apps/web/src`
Expected: no output (zero matches). If any file still references `--neem-*` or `--haldi-*`, fix it — Task 1's Step 1-7 listed every current occurrence (verified against the codebase before this plan was written), so any match here means either a fix was missed or a new reference was introduced; find it and replace it with the equivalent `--accent-*`/`--today-*` name per the mapping table in the design spec (`docs/superpowers/specs/2026-09-29-warm-minimal-redesign-design.md`).

- [ ] **Step 2: Start the dev server**

Run: `npm run dev:web`
Expected: Vite starts without error, printing a local URL (default `http://localhost:5173`).

- [ ] **Step 3: Manually check each screen in light mode**

Open the app in a browser at the printed URL and check these screens read correctly (terracotta primary buttons/links, ochre-gold "today" markers only where "today" is shown, no leftover green anywhere, adequate text contrast against the off-white background):
- `/signin`, `/signup`, `/forgot-password` (request a reset to reach `/reset-password` via the emailed link, or navigate directly with a dummy `?token=` to see the page shell), `/verify-email` (same — dummy token is fine for a visual check)
- `/onboarding` (sign in as a fresh account or use the seeded demo accounts per the README's local-setup section)
- Home (`/`), `/more`, `/members` (visit as the seeded OWNER account to see the invite form and role controls), `/invites/accept` (dummy token for the page shell)
- The three "coming soon" screens: `/househelps`, `/checklist`, `/bills`

Expected: every screen shows the new palette; the bottom tab bar (mobile width) and sidebar (≥900px width, resize the browser or use dev tools' device toolbar) both show the terracotta active-state color.

- [ ] **Step 4: Manually check dark mode**

Switch your OS or browser to dark mode (or use browser dev tools' "Emulate CSS media feature prefers-color-scheme: dark") and repeat the same screens from Step 3.

Expected: dark paper/surface/ink read correctly, terracotta and ochre-gold are both lightened enough to stay legible against the dark background, no leftover green.

- [ ] **Step 5: Record the outcome**

If Steps 3-4 look correct with no fixes needed, proceed to commit (Step 6). If any fix was needed, stage and commit that fix with a message describing what was missed, then re-run Step 1's grep and Steps 3-4's visual check on the affected screen(s) before proceeding.

- [ ] **Step 6: Commit (only if a fix was made in this task; otherwise skip — Task 1's commit already covers the redesign)**

```bash
git add -A
git commit -m "fix(web): correct leftover token reference found during redesign verification"
```
