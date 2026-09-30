# Sunrise Polish Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the gap between the approved Sunrise mockup and what actually shipped — the prior redesign branch only touched the Home page's hero card; the rest of the app (buttons, cards, toggles, icons) still looked like the pre-redesign flat styling with just recolored tokens. This plan applies four specific, mockup-matched visual treatments app-wide: card shadows, pill-shaped buttons, gradient primary buttons/pressed-toggles, and per-card icon-tone variety.

**Architecture:** Same token-driven approach as the prior redesign — every change flows through `tokens.css` (two new tokens) and the two shared stylesheets (`components.css`'s `.card`/`.btn`/`.chip`/`.empty__icon` rules), so it applies to every page automatically. One small, additive prop is added to the shared `EmptyState` component for icon-tone variety; only `HomePage.tsx` opts into non-default tones (every other page keeps the existing single tone, unchanged in appearance).

**Tech Stack:** Plain CSS custom properties (no new dependencies), one small React prop addition.

## Global Constraints

- This is a polish pass on the ALREADY-APPROVED Sunrise direction (mockup: `https://claude.ai/code/artifact/45a82b56-628b-46cc-a33f-9c7a51910d3a`) — not a new color/identity direction. No hue changes, no new brand colors; this plan only adds shadow, shape, and gradient-fill treatments using tokens that already exist (`--hero-gradient`, `--accent-*`, `--today-500`, `--dusk`) or are added here as pure visual-weight tokens (shadows).
- `EmptyState`'s new `tone` prop must default to the same visual result every existing caller already has today (i.e., adding the prop must not change any other page's appearance) — only `HomePage.tsx` passes a non-default tone.
- `.btn`'s border-radius change to a full pill applies to every button variant (`primary`/`secondary`/`ghost`/`danger`) and every page — this is intentional (the mockup's buttons and chips are both pills; today only chips are, buttons aren't, which is part of the inconsistency being fixed).
- Every new/changed color or shadow token gets both a light and dark value, following this codebase's existing pattern (see `tokens.css`'s dark-mode media block).
- Spec/plan for the underlying direction: `docs/superpowers/specs/2026-09-30-sunrise-redesign-design.md`. This plan doesn't need its own separate design spec — the mockup already is the approved reference, and the gap being closed was identified by direct side-by-side comparison against it (documented in this session's conversation, not re-derived here).

---

### Task 1: Card shadows, pill buttons, gradient fills, and icon-tone variety

**Files:**
- Modify: `apps/web/src/styles/tokens.css`
- Modify: `apps/web/src/styles/components.css`
- Modify: `apps/web/src/components/EmptyState.tsx`
- Modify: `apps/web/src/features/app/HomePage.tsx`

**Interfaces:**
- Produces: `--shadow-card`, `--shadow-accent` (new tokens); `EmptyState`'s new optional `tone?: "coral" | "amber" | "dusk"` prop (defaults to `"coral"`, which renders identically to the current unconditional styling — no visual change for any caller that doesn't pass it).

- [ ] **Step 1: Add two new shadow tokens to `tokens.css`**

Add these two lines right after the existing `--shadow-sheet` line in the `:root` block:

```css
  --shadow-card: 0 1px 2px rgba(45, 42, 26, 0.06), 0 8px 24px rgba(45, 42, 26, 0.08);
  --shadow-accent: 0 10px 24px -10px rgba(232, 93, 74, 0.45);
```

(`rgba(232, 93, 74, ...)` is `--accent-600`'s exact RGB value — keeps the shadow color tied to the same accent the gradient/buttons use, not an arbitrary color.)

Add the dark-mode equivalents inside the existing `@media (prefers-color-scheme: dark) { :root { ... } }` block, right after the existing `--shadow-hero` line:

```css
    --shadow-card: 0 1px 2px rgba(0, 0, 0, 0.3), 0 8px 24px rgba(0, 0, 0, 0.35);
    --shadow-accent: 0 10px 24px -10px rgba(245, 152, 127, 0.4);
```

(`rgba(245, 152, 127, ...)` is dark mode's `--accent-600` value, `#F5987F`.)

- [ ] **Step 2: Give every card a soft shadow**

In `apps/web/src/styles/components.css`, change the existing `.card` rule from:

```css
.card { background: var(--surface); border: 1px solid var(--line); border-radius: var(--radius-md); padding: var(--space-5); }
```

to:

```css
.card { background: var(--surface); border: 1px solid var(--line); border-radius: var(--radius-md); padding: var(--space-5); box-shadow: var(--shadow-card); }
```

- [ ] **Step 3: Make every button a pill**

In `apps/web/src/styles/components.css`, change the existing `.btn` rule's `border-radius: var(--radius-sm);` to `border-radius: 999px;`. The full rule currently reads:

```css
.btn {
  display: inline-flex; align-items: center; justify-content: center; gap: var(--space-2);
  min-height: var(--touch); padding: 0 var(--space-5);
  border-radius: var(--radius-sm); border: 1.5px solid transparent;
  font-weight: 700; font-size: var(--text-md); cursor: pointer; text-decoration: none;
  transition: background var(--dur) var(--ease), transform 80ms var(--ease), border-color var(--dur) var(--ease);
  user-select: none;
}
```

Change only the `border-radius` value:

```css
.btn {
  display: inline-flex; align-items: center; justify-content: center; gap: var(--space-2);
  min-height: var(--touch); padding: 0 var(--space-5);
  border-radius: 999px; border: 1.5px solid transparent;
  font-weight: 700; font-size: var(--text-md); cursor: pointer; text-decoration: none;
  transition: background var(--dur) var(--ease), transform 80ms var(--ease), border-color var(--dur) var(--ease);
  user-select: none;
}
```

- [ ] **Step 4: Give the primary button the gradient fill**

In `apps/web/src/styles/components.css`, change:

```css
.btn--primary { background: var(--accent-700); color: var(--paper); }
.btn--primary:hover:not(:disabled) { background: var(--accent-900); }
```

to:

```css
.btn--primary { background: var(--hero-gradient); color: var(--paper); box-shadow: var(--shadow-accent); }
.btn--primary:hover:not(:disabled) { filter: brightness(1.08); }
```

- [ ] **Step 5: Give the pressed/active chip state the gradient fill**

In `apps/web/src/styles/components.css` (`shell.css` actually — the `.chip` rules live in `apps/web/src/features/app/shell.css`, not `components.css`; check both files if unsure, but as of this plan's writing they're in `shell.css`), change:

```css
.chip[aria-pressed="true"] { border-color: var(--accent-700); background: var(--accent-50); color: var(--accent-700); font-weight: 700; }
```

to:

```css
.chip[aria-pressed="true"] { border-color: transparent; background: var(--hero-gradient); color: var(--paper); font-weight: 700; }
```

- [ ] **Step 6: Add icon-tone variants and wire the new prop into `EmptyState`**

Append to `apps/web/src/styles/components.css`, right after the existing `.empty__icon` rule:

```css
.empty__icon--coral { background: var(--accent-50); color: var(--accent-700); }
.empty__icon--amber { background: var(--today-100); color: var(--today-500); }
.empty__icon--dusk { background: color-mix(in srgb, var(--dusk) 16%, transparent); color: var(--dusk); }
```

Change the existing `.empty__icon` rule from:

```css
.empty__icon { width: 44px; height: 44px; border-radius: 12px; display: grid; place-items: center; background: var(--accent-50); color: var(--accent-700); }
```

to (drop the hardcoded color — the tone variant now supplies it):

```css
.empty__icon { width: 44px; height: 44px; border-radius: 12px; display: grid; place-items: center; }
```

Update `apps/web/src/components/EmptyState.tsx` to:

```tsx
import type { ReactNode } from "react";

export function EmptyState({ icon, title, text, action, tone = "coral" }: {
  icon: ReactNode; title: string; text: string; action?: ReactNode; tone?: "coral" | "amber" | "dusk";
}) {
  return (
    <div className="empty">
      <div className={`empty__icon empty__icon--${tone}`} aria-hidden>{icon}</div>
      <p className="empty__title">{title}</p>
      <p className="empty__text">{text}</p>
      {action}
    </div>
  );
}
```

Every existing caller of `EmptyState` across the app doesn't pass `tone`, so it defaults to `"coral"` — visually identical to today's single hardcoded color (both resolve to `background: var(--accent-50); color: var(--accent-700);`). No other file needs to change for this to be true.

- [ ] **Step 7: Give Home page's four cards varied icon tones**

In `apps/web/src/features/app/HomePage.tsx`, the four `<EmptyState .../>` calls (inside the "Househelp", "Today's work", "Payments", "Salaries" cards, in that order) each get a `tone` prop added, matching the mockup's coral/amber/dusk/coral sequence:

```tsx
<EmptyState icon={<Users size={22} />} title="No househelps yet" text="Add the people who help at home to track who's coming each day." tone="coral" />
```
```tsx
<EmptyState icon={<ClipboardCheck size={22} />} title="No tasks for today" text="Create a checklist — daily dusting, Saturday bathrooms — and tick things off as they're done." tone="amber" />
```
```tsx
<EmptyState icon={<ReceiptIndianRupee size={22} />} title="No bills tracked" text="Keep track of electricity, WiFi, maintenance and more. We'll remind you before they're due." tone="dusk" />
```
```tsx
<EmptyState icon={<Wallet size={22} />} title="Nothing due" text="Salaries appear here a few days before they're due." tone="coral" />
```

(Only the `tone="..."` prop is added to each existing line — `icon`/`title`/`text`/`action` stay exactly as they are today.)

- [ ] **Step 8: Build and typecheck**

Run: `npm run build -w @household/web && npm run typecheck -w @household/web`
Expected: both succeed.

- [ ] **Step 9: Run the web test suite**

Run: `npm run test --workspace @household/web`
Expected: PASS — no test asserts on `border-radius`/`box-shadow`/exact class-name suffixes in a way a `tone` suffix or shape change would break; a few tests do query `EmptyState`'s rendered text (`getByText`), which is unaffected by the new wrapping `className` or the `tone` prop.

- [ ] **Step 10: Lint**

Run: `npm run lint`
Expected: PASS.

- [ ] **Step 11: Commit**

```bash
git add apps/web/src/styles/tokens.css apps/web/src/styles/components.css apps/web/src/features/app/shell.css apps/web/src/components/EmptyState.tsx apps/web/src/features/app/HomePage.tsx
git commit -m "feat(web): card shadows, pill buttons, gradient fills, and icon-tone variety"
```
