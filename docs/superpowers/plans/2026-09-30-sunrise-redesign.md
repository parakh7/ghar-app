# Sunrise Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Recolor the existing token architecture to the approved "Sunrise" palette (violet→coral→amber), add a gradient hero card with a serif display headline, add functional micro-animations, fix the desktop layout's wasted space, and verify mobile responsiveness — no new components, no new routes, no backend changes.

**Architecture:** Every visual change flows through the existing token layer (`apps/web/src/styles/tokens.css`) and the two shared stylesheets that already read from it (`components.css`, `shell.css`) — the same architecture the (rejected) warm-minimal redesign used, per project convention of recoloring rather than restructuring. Two small, targeted component edits (`HomePage.tsx`, `TodayPage.tsx`) opt specific elements into the new animation classes; nothing else changes.

**Tech Stack:** Plain CSS custom properties, CSS `@keyframes`, React 19 (no new dependencies, no new components).

## Global Constraints

- No new npm dependencies (Fraunces loads via the existing Google Fonts `<link>` mechanism already used for Atkinson Hyperlegible Next — just adds a family to the same request).
- `--font` (Atkinson Hyperlegible Next) remains the typeface for every heading, label, button, and body string except one: the Home page's greeting/date headline, which is the only place `--font-display` (Fraunces) is used. Don't introduce Fraunces anywhere else in this plan.
- Every new `@keyframes` animation must be silently neutralized by `base.css`'s existing global rule (`@media (prefers-reduced-motion: reduce) { *, *::before, *::after { animation-duration: 1ms !important; ... } }`) — this already applies automatically to any animation using the standard `animation`/`transition` properties, so no per-animation opt-out code is needed; just don't bypass it (e.g. don't hardcode a JS-driven animation loop that ignores CSS).
- **This plan has no automated coverage for its actual subject (color/contrast/layout)** — the existing web test suite asserts on text content and ARIA roles, not computed styles, so it will pass trivially and is not meaningful evidence of correctness here. Each task's real verification is: (a) `npm run build -w @household/web` and `npm run typecheck` succeed (catches CSS syntax errors Vite would reject and any TS errors from the two component edits), and (b) a WCAG contrast check computed directly from the hex values (formula below) for every text/background pairing this plan changes. Task 4 adds a manual dev-server visual pass across breakpoints and both themes as the final gate.
- **Contrast check method:** relative luminance `L = 0.2126*R + 0.7152*G + 0.0722*B` where each of R/G/B is `c/255` linearized via `c ≤ 0.03928 ? c/12.92 : ((c+0.055)/1.055)^2.4`; contrast ratio `(L1+0.05)/(L2+0.05)` with `L1` the lighter of the two. Required: ≥4.5:1 for body-sized text, ≥3:1 for large text (≥24px or ≥19px bold) and UI component boundaries. Compute this with a short Node one-liner (`node -e "..."`) rather than eyeballing — exact code given in Task 1.
- Spec: `docs/superpowers/specs/2026-09-30-sunrise-redesign-design.md`.

---

### Task 1: Palette and typography tokens

**Files:**
- Modify: `apps/web/src/styles/tokens.css`
- Modify: `apps/web/index.html`

**Interfaces:**
- Produces: recolored `--accent-900/700/600/100/50`, `--today-500/100` (same names, new Sunrise values); new `--dusk`, `--hero-gradient`, `--font-display`, `--shadow-hero` tokens — consumed by Task 2 (hero card), Task 3 (badge tones already read `--accent-*`/status tokens unchanged), and every existing component that already reads `--accent-*`/`--today-*` (buttons, links, badges, chips, calendar grid — no changes needed in those files, they inherit the new colors automatically).

- [ ] **Step 1: Replace the palette and add new tokens in `tokens.css`**

Replace the `:root` block's `/* palette */` section (from `--accent-900` through `--line-strong`) with:

```css
  /* palette — "Sunrise": violet-dusk to coral to amber */
  --accent-900: #7A2B1D;
  --accent-700: #C8452F;   /* primary */
  --accent-600: #E85D4A;
  --accent-100: #FBDCD4;
  --accent-50:  #FDEEEA;
  --today-500: #F5A83C;  /* "today" marker, and the gradient's warm end */
  --today-100: #FDEED7;
  --dusk: #4A3B72;        /* gradient's cool end — decorative only, never body text */
  --hero-gradient: linear-gradient(155deg, var(--dusk) 0%, var(--accent-600) 58%, var(--today-500) 100%);
  --paper: #FAF7F2;
  --surface: #FFFFFF;
  --ink: #2D2A26;
  --ink-2: #5C554C;
  --ink-3: #6F6355;
  --line: #E8E1D6;
  --line-strong: #D8CFC0;
```

Add `--font-display` right after the existing `--font` line:

```css
  --font: "Atkinson Hyperlegible Next", "Atkinson Hyperlegible", system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
  --font-display: "Fraunces", Georgia, serif;
```

Add `--shadow-hero` right after the existing `--shadow-sheet` line:

```css
  --shadow-sheet: 0 -8px 32px rgba(45, 42, 26, 0.14);
  --shadow-hero: 0 20px 50px -18px rgba(74, 59, 114, 0.35);
```

- [ ] **Step 2: Update the dark-mode block**

Replace the `@media (prefers-color-scheme: dark) { :root { ... } }` block's contents with:

```css
    --accent-700: #F0846B;
    --accent-600: #F5987F;
    --accent-900: #FBD8CB;
    --accent-100: #3A2621;
    --accent-50: #2E1D19;
    --today-500: #FBC067;
    --today-100: #3D2E16;
    --dusk: #9686CC;
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
    --shadow-hero: 0 20px 50px -16px rgba(150, 134, 204, 0.3);
    color-scheme: dark;
```

(Only the accent/today/dusk/shadow-hero lines are new or changed — `--overdue`/`--due-soon`/`--ok`/`--info` and their `-bg` pairs are copied unchanged from the current file; don't alter them.)

- [ ] **Step 3: Add Fraunces to the existing Google Fonts request**

In `apps/web/index.html`, change the existing stylesheet `<link>`:

```html
    <link href="https://fonts.googleapis.com/css2?family=Atkinson+Hyperlegible+Next:wght@400;500;700;800&display=swap" rel="stylesheet" />
```

to:

```html
    <link href="https://fonts.googleapis.com/css2?family=Atkinson+Hyperlegible+Next:wght@400;500;700;800&family=Fraunces:wght@700&display=swap" rel="stylesheet" />
```

- [ ] **Step 4: Verify contrast on every changed text/background pairing**

Run this (adjust nothing — it's the exact pairing list this task touches):

```bash
node -e '
function lin(c){c/=255;return c<=0.03928?c/12.92:((c+0.055)/1.055)**2.4;}
function lum([r,g,b]){return 0.2126*lin(r)+0.7152*lin(g)+0.0722*lin(b);}
function hex(h){h=h.replace("#","");return [0,2,4].map(i=>parseInt(h.slice(i,i+2),16));}
function ratio(a,b){const [l1,l2]=[lum(hex(a)),lum(hex(b))].sort((x,y)=>y-x);return (l1+0.05)/(l2+0.05);}
const pairs = [
  ["accent-700 on paper (light, links/buttons text)", "#C8452F", "#FAF7F2"],
  ["paper on accent-700 (light, primary button text)", "#FAF7F2", "#C8452F"],
  ["accent-700 on accent-50 (light, ghost hover text)", "#C8452F", "#FDEEEA"],
  ["accent-700 dark on paper dark", "#F0846B", "#1C1815"],
  ["paper dark on accent-700 dark", "#1C1815", "#F0846B"],
  ["ink on paper (light, body text — unchanged but confirm)", "#2D2A26", "#FAF7F2"],
  ["white on dusk (hero gradient cool end)", "#FFFFFF", "#4A3B72"],
  ["white-85pct-approx on accent-600 (hero gradient mid — treat as opaque white for a floor check)", "#FFFFFF", "#E85D4A"],
  ["white on today-500 (hero gradient warm end)", "#FFFFFF", "#F5A83C"],
];
for (const [label, fg, bg] of pairs) console.log(label, "->", ratio(fg,bg).toFixed(2) + ":1");
'
```

Expected: every "text" pairing (accent-700-on-paper, paper-on-accent-700, accent-700-on-accent-50, both dark variants, ink-on-paper) is **≥4.5:1**. The three "white on {dusk,accent-600,today-500}" hero-gradient pairings only need **≥3:1** (the hero text is large — `text-3xl`/`text-sm`-bold — per WCAG's large-text threshold), since that text sits over a gradient, not a flat single-color background, and this checks the floor (the gradient's most saturated points) rather than an exact rendered pixel.

If any pairing fails its threshold, darken/lighten that one token slightly (keep the same hue family) and re-run this exact script until all pass — do not proceed to commit with a failing ratio.

- [ ] **Step 5: Build and typecheck**

Run: `npm run build -w @household/web && npm run typecheck -w @household/web`
Expected: both succeed (pure CSS/HTML changes, no TS surface changed yet).

- [ ] **Step 6: Commit**

```bash
git add apps/web/src/styles/tokens.css apps/web/index.html
git commit -m "feat(web): recolor tokens to the Sunrise palette, add Fraunces display face"
```

---

### Task 2: Hero gradient card and dashboard entrance animation

**Files:**
- Modify: `apps/web/src/features/app/shell.css`
- Modify: `apps/web/src/styles/components.css`
- Modify: `apps/web/src/features/app/HomePage.tsx`

**Interfaces:**
- Consumes: `--hero-gradient`, `--font-display`, `--shadow-hero`, `--today-500` (Task 1).
- Produces: `.card--enter` (new opt-in animation class in `components.css`) — used only by `HomePage.tsx` in this plan; available for other pages later without being forced on them.

- [ ] **Step 1: Turn `.today` into the gradient hero card**

In `apps/web/src/features/app/shell.css`, replace the entire "home 'today' header" block (`.today` through `.today__dot`) with:

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

- [ ] **Step 2: Add the card entrance animation to `components.css`**

Append to `apps/web/src/styles/components.css`:

```css
/* ── Card entrance (opt-in — applied per-page, not baked into the base .card rule) ── */
.card--enter { animation: fade-up 420ms var(--ease) both; }
@keyframes fade-up { from { opacity: 0; transform: translateY(10px); } to { opacity: 1; transform: translateY(0); } }
```

- [ ] **Step 3: Opt `HomePage.tsx`'s four cards into the entrance animation**

In `apps/web/src/features/app/HomePage.tsx`, each of the four `<section className="card" ...>` elements gets `card--enter` added to its `className` and a staggered `animationDelay` inline style. The four sections currently read (in order) `id="h-help"`, `id="h-work"`, `id="h-pay"`, `id="h-sal"` — change each opening tag to:

```tsx
<section className="card card--enter" style={{ animationDelay: "0ms" }} aria-labelledby="h-help">
```
```tsx
<section className="card card--enter" style={{ animationDelay: "70ms" }} aria-labelledby="h-work">
```
```tsx
<section className="card card--enter" style={{ animationDelay: "140ms" }} aria-labelledby="h-pay">
```
```tsx
<section className="card card--enter" style={{ animationDelay: "210ms" }} aria-labelledby="h-sal">
```

(Only the `className` and added `style` change on each line — the rest of each section's contents are untouched.)

- [ ] **Step 4: Verify contrast on the hero's white-on-gradient text (re-run if Task 1's tokens changed)**

If Task 1's Step 4 script already passed for the three "white on {dusk, accent-600, today-500}" pairings, no action needed here. If any token value changed since (e.g. during Task 1's fix loop), re-run that same script before proceeding.

- [ ] **Step 5: Build and typecheck**

Run: `npm run build -w @household/web && npm run typecheck -w @household/web`
Expected: both succeed.

- [ ] **Step 6: Run a smoke-check test file**

`HomePage.tsx` has no dedicated test file, so run a page that also renders a `.card` element as a smoke check that nothing about the shared `.card`/`components.css` rules broke:

Run: `npm run test --workspace @household/web -- HousehelpsListPage`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add apps/web/src/features/app/shell.css apps/web/src/styles/components.css apps/web/src/features/app/HomePage.tsx
git commit -m "feat(web): gradient hero card with drift animation and dashboard entrance fade"
```

---

### Task 3: One-tap status "pop" on the attendance Today screen

**Files:**
- Modify: `apps/web/src/styles/components.css`
- Modify: `apps/web/src/features/app/attendance/TodayPage.tsx`

**Interfaces:**
- Produces: `.pop-in` (new animation class in `components.css`).
- Consumes: `TodayPage.tsx`'s existing `setAttendance`/`clearAttendance` mutations (Phase 3) — no service/hook changes, only a new local `poppedId` state and a class/handler added to the existing badge `<span>`.

- [ ] **Step 1: Add the pop animation to `components.css`**

Append to `apps/web/src/styles/components.css`:

```css
/* ── Status pop (plays once, right after a user-driven status change) ── */
.pop-in { animation: pop 380ms var(--ease); }
@keyframes pop { 0% { transform: scale(1); } 45% { transform: scale(1.28); } 100% { transform: scale(1); } }
```

- [ ] **Step 2: Track "just changed" state in `TodayPage.tsx`**

Add a new state line right after the existing `const [pageError, setPageError] = useState<string | null>(null);`:

```tsx
  const [poppedId, setPoppedId] = useState<string | null>(null);
```

- [ ] **Step 3: Trigger the pop only after a successful mutation, on the specific row that changed**

Replace `onTap` and `onPick` with versions that set `poppedId` in `onSuccess` (not immediately on click — the badge's visible status doesn't actually change until the mutation succeeds and the query refetches, so popping before that would animate a badge whose text hasn't updated yet):

```tsx
  function onTap(househelpId: string, current: AttendanceStatus | null) {
    const next: AttendanceStatus = current === "PRESENT" ? "ABSENT" : "PRESENT";
    setAttendance.mutate(
      { househelpId, body: { date, status: next } },
      { onSuccess: () => setPoppedId(househelpId), onError: (err) => setPageError(messageFrom(err)) },
    );
  }

  function onPick(househelpId: string, status: AttendanceStatus | null) {
    setOpenFor(null);
    if (status === null) {
      clearAttendance.mutate(
        { househelpId, date },
        { onSuccess: () => setPoppedId(househelpId), onError: (err) => setPageError(messageFrom(err)) },
      );
    } else {
      setAttendance.mutate(
        { househelpId, body: { date, status } },
        { onSuccess: () => setPoppedId(househelpId), onError: (err) => setPageError(messageFrom(err)) },
      );
    }
  }
```

- [ ] **Step 4: Apply the class conditionally and self-clear it after the animation**

Replace the existing badge line:

```tsx
              <span className={`badge badge--${toneOf(e.status)}`}>{e.status ? STATUS_LABEL[e.status] : "Not marked"}</span>
```

with:

```tsx
              <span
                className={`badge badge--${toneOf(e.status)}${poppedId === e.househelpId ? " pop-in" : ""}`}
                onAnimationEnd={() => setPoppedId((id) => (id === e.househelpId ? null : id))}
              >
                {e.status ? STATUS_LABEL[e.status] : "Not marked"}
              </span>
```

The `onAnimationEnd` functional update (rather than unconditionally calling `setPoppedId(null)`) avoids a race where a second, different row's pop was already in flight and this handler firing late would incorrectly clear it — it only clears state if the id it was watching is still the current one.

- [ ] **Step 5: Run the existing TodayPage tests**

Run: `npm run test --workspace @household/web -- TodayPage`
Expected: PASS — the existing 4 tests assert on PUT/POST call bodies and DOM text/roles, none of which this change alters (the class list gains a conditional suffix and the span gains an event handler; neither affects `getByText`/`getByRole` queries or the mutation payloads).

- [ ] **Step 6: Commit**

```bash
git add apps/web/src/styles/components.css apps/web/src/features/app/attendance/TodayPage.tsx
git commit -m "feat(web): pop micro-animation on attendance status change"
```

---

### Task 4: Desktop layout fix, mobile hardening audit, final visual QA

**Files:**
- Modify: `apps/web/src/features/app/shell.css`

**Interfaces:** none new — this task's deliverable is the layout fix plus a verification pass, not new code surface.

- [ ] **Step 1: Raise the desktop content max-width**

In `apps/web/src/features/app/shell.css`, inside the `@media (min-width: 900px) { ... }` block, change:

```css
  .shell__main { padding: var(--space-10) var(--space-10) var(--space-12); margin: 0; max-width: 820px; }
```

to:

```css
  .shell__main { padding: var(--space-10) var(--space-10) var(--space-12); margin: 0; max-width: 1200px; }
```

- [ ] **Step 2: Start the dev server**

Run: `npm run dev:web` (leave running in the background for the checks below; it prints a local URL, default `http://localhost:5173`).

- [ ] **Step 3: Check desktop space utilization**

Open the app in a browser, sign in (or use an existing session), and resize the window to at least 1440px wide. Check:
- Home, Househelps list, Attendance Today, Attendance calendar, Checklist list.
Expected: content now extends meaningfully wider than before (up to 1200px inside the content column) instead of stopping at ~820px with empty space to the right. At 1920px there will still be some empty margin past 1200px+sidebar — that's expected and fine (1200px was chosen as a readable cap, not "fill every pixel").

- [ ] **Step 4: Check mobile widths**

Using the browser's device toolbar (or an actual phone), check the same pages at 360px and 390px wide. For each, confirm:
- No horizontal scrollbar / no content clipped off the right edge — pay particular attention to the checklist form's weekday chip row and the attendance calendar's 7-column day grid, the two widest/most element-dense rows in the app.
- Every tappable control (buttons, chips, calendar day cells, list rows) is comfortably tappable — none should look thumb-cramped.
- The bottom tab bar doesn't visually collide with the new hero gradient card on Home.

Expected: no fixes needed (the shell's mobile layout already existed and this plan didn't touch its structural breakpoint, only the desktop max-width and the hero's own styling) — but if something IS found broken, fix it now, re-check, and note the fix in the commit message.

- [ ] **Step 5: Check both color themes at the 900px breakpoint boundary**

At approximately 900px width (right at the mobile↔desktop breakpoint) and in both light and dark mode (toggle via OS setting or browser dev tools' "Emulate CSS media feature prefers-color-scheme"), confirm:
- The hero gradient and its white text are legible in both themes (this was already numerically verified in Task 1/2's contrast script — this step is a real-eyes sanity check on top of that, not a replacement for it).
- No leftover flat-terracotta color from the prior palette is visible anywhere (a stray hardcoded hex would be the only way this could happen, since this plan changed only `tokens.css`'s values — spot check there isn't one by running `grep -rn "#C2410C\|#D6551F\|#7A2708" apps/web/src` and confirming no output).

- [ ] **Step 6: Run the full web suite, typecheck, and lint once**

Run: `npm run test --workspace @household/web && npm run typecheck && npm run lint`
Expected: all three PASS — this is the plan's one full-suite checkpoint (per project convention, targeted tests run per-task above; the full suite runs once here since this is the last task).

- [ ] **Step 7: Commit**

```bash
git add apps/web/src/features/app/shell.css
git commit -m "fix(web): widen desktop content max-width from 820px to 1200px"
```

(If Step 4 required a fix, include it in this same commit with an amended message describing both changes, or a second commit right after — controller's judgment at execution time based on what, if anything, was found.)
