# Sunrise Redesign — Layout, Mobile, and Visual Identity

**Status:** approved, ready for implementation plan
**Date:** 2026-09-30
**Scope:** Fix desktop space utilization (a hard-coded 820px content cap), audit and harden mobile responsiveness, and replace the current flat "warm-minimal" terracotta identity with a third direction — "Sunrise": a violet→coral→amber gradient used as a sparing accent, a serif display face for hero moments, and functional micro-animations — validated against an approved interactive mockup before this spec was written (`https://claude.ai/code/artifact/45a82b56-628b-46cc-a33f-9c7a51910d3a`).

## Context

This is the third color/visual attempt for this app (see project memory: green/turmeric and flat-terracotta warm-minimal were both rejected after being fully built and seen live). This time the direction was validated *before* implementation, via a self-contained HTML mockup with a working mobile/desktop toggle and a live one-tap animation demo — the user's reaction was positive ("looks coooool") before any app code changed.

The existing token architecture (`apps/web/src/styles/tokens.css` — semantic CSS custom properties, `--accent-*`/`--today-*`/status tokens, light+dark blocks) was never criticized and is preserved. This redesign **reuses the existing token names** and recolors them, rather than introducing a parallel naming scheme — every component (`components.css`, `shell.css`) already reads color exclusively through these tokens, so recoloring them is the majority of the visual change. `--font` (Atkinson Hyperlegible Next) stays as the body/UI typeface everywhere — it was chosen specifically for legibility for the app's non-technical/senior audience and is not being replaced. One new display typeface is added for hero moments only (see Typography).

## Layout fix

`apps/web/src/features/app/shell.css`'s desktop rule (`@media (min-width: 900px)`) sets `.shell__main { max-width: 820px; margin: 0; }` — capped width, not centered, so wide screens waste everything past ~820px+sidebar. Fix: raise to `max-width: 1200px` and keep `margin: 0` (the grid column itself is `1fr`, and at 1200px the content still won't reach typical ultra-wide edges, so explicit centering isn't needed at realistic laptop/monitor widths — verify visually at 1440px and 1920px during implementation and add `margin: 0 auto` if it still reads as flush-left at common widths).

## Mobile hardening (audit, not a rewrite)

The shell already has a real mobile layout (bottom tab bar, `<900px`) — this is due-diligence verification, not a from-scratch build:
- Confirm every interactive control meets the existing `--touch` (48px) minimum at mobile widths — spot-check calendar day cells, chip pickers, and list-row action buttons across attendance, checklist, and househelp pages.
- Confirm no horizontal overflow at 360-390px viewport widths (common Android/iPhone) on every page — particularly the checklist form's weekday chips and the attendance calendar grid, which are the widest/most element-dense rows in the app.
- Confirm form inputs stay at the existing `max(16px, var(--text-md))` font size (already correct in `components.css`'s `.input` — verify no page overrides it smaller).
- Confirm safe-area insets (`--safe-top`/`--safe-bottom`, already wired into `.shell__main` padding and `.shell__nav`) still look correct with the new hero gradient card, which is the one element most likely to visually clash with a notch/status bar if padding regresses.

## Visual identity — "Sunrise"

### Color (token-level changes only, same variable names)

`apps/web/src/styles/tokens.css`, light mode:
- `--accent-900: #7A2B1D` (darkest — hover state on primary buttons)
- `--accent-700: #C8452F` (primary — buttons, links, active nav state; deepened from the mockup's brighter coral so it still passes AA as text-on-paper)
- `--accent-600: #E85D4A` (brighter coral — hover-lighter, and the gradient's middle stop)
- `--accent-100: #FBDCD4` (light tint — focus rings, chip-pressed background)
- `--accent-50: #FDEEEA` (lightest tint — badge/empty-icon backgrounds)
- `--today-500: #F5A83C` (brightened amber — was already amber-family, now also the gradient's warm end)
- `--today-100: #FDEED7` (light tint, unchanged role — the greeting date's underline mark)
- **New:** `--dusk: #4A3B72` (deep violet — the gradient's cool end; not used as body text anywhere, gradient/decorative only)
- **New:** `--hero-gradient: linear-gradient(155deg, var(--dusk) 0%, var(--accent-600) 58%, var(--today-500) 100%)`

Dark mode block (`@media (prefers-color-scheme: dark)`): scale each of the above the same way the existing dark block already scales `--accent-*` (lighter/desaturated versions for a dark ground) — `--accent-700: #F0846B`, `--accent-600: #F5987F`, `--accent-900: #FBD8CB`, `--accent-100: #3A2621`, `--accent-50: #2E1D19`, `--today-500: #FBC067`, `--today-100: #3D2E16`, `--dusk: #9686CC`.

Status tokens (`--overdue`/`--due-soon`/`--ok`/`--info` and their `-bg` pairs) are unchanged — they're semantic (never the brand accent) and already distinct from the old terracotta, so nothing about the sunrise palette collides with them.

**Contrast is a hard requirement, not a nice-to-have** — the prior warm-minimal redesign needed a follow-up fix specifically for AA contrast; this plan's review loop must check every recolored token pairing (text-on-paper, text-on-surface, white-text-on-accent-700 button) against WCAG AA (4.5:1 body text, 3:1 large text/UI) in both light and dark, before merge.

### Typography

Add one display face, **Fraunces** (bold, 700), loaded the same way Atkinson Hyperlegible Next already is — a second `<link>` in `apps/web/index.html` pointing at Google Fonts (no CSP restriction in the real app; the mockup's data-URI embedding was a preview-sandbox-only workaround, not what ships). New token `--font-display: "Fraunces", Georgia, serif`. Used in exactly one place: the Home page's greeting/date headline (`.today__date` in `shell.css`) — nowhere else. Every other heading, label, button, and body string keeps `--font` (Atkinson Hyperlegible Next) untouched, preserving the accessibility rationale that face was chosen for.

### The hero gradient

`.today` (Home page's greeting header, `shell.css`) becomes a full card: gradient background (`--hero-gradient`), rounded corners (`--radius-lg`), white text, the existing greeting/date/stamp content unchanged in structure. A slow ambient `background-position` drift animation (14s, ease-in-out, alternating) matches the mockup — subtle, not attention-grabbing, and disabled under `prefers-reduced-motion` (see Animations).

### Animations

All new animation rules go in `components.css` (or `shell.css` for the hero specifically) as reusable classes, and **every one respects `prefers-reduced-motion`** — `base.css` already has a global reduced-motion override (`animation-duration: 1ms !important`), so new keyframe animations inherit that safety net automatically; no new opt-out logic needed.
- **Hero drift**: slow gradient position shift on `.today`, as above.
- **Card fade-up on load**: cards on list/dashboard pages fade + slide up 10px on mount, staggered ~70ms apart (matches the mockup's `.card:nth-of-type(n)` delay pattern) — apply to `HomePage.tsx`'s four cards first; extend to other list pages (`HousehelpsListPage`, `ChecklistListPage`) only if it reads well there too, judged during implementation rather than mandated everywhere up front.
- **Button press scale**: `.btn:active` already exists (`scale(0.98)`) — leave as-is, it already matches the mockup's feel.
- **One-tap status "pop"**: when a status badge/chip transitions into its "done"-type tone (attendance's Present/Absent chips, checklist completion), the label briefly scales up then settles (mockup's `@keyframes pop`, 420ms) — add as a small reusable class (e.g. `.pop-in`) applied via a one-time CSS class toggle keyed off the status change, not a permanent animation.

## Testing

- No new API/business logic — this is CSS/token/markup only, so no backend tests needed.
- Visual/contrast verification (manual, during implementation and review): every recolored token pair checked against WCAG AA in both themes, both the fixed 820→1200px layout and mobile hardening checked by running the dev server and inspecting at 360px, 390px, 900px (breakpoint boundary), 1440px, and 1920px.
- Existing component tests (assert text content, ARIA roles, permission gating) are unaffected by pure styling changes — run the full web suite once at the end to confirm no test asserts on now-changed class names or removed elements (none are expected to be removed).
