# Web Visual Redesign — Warm Minimal

**Status:** approved, ready for implementation plan
**Date:** 2026-09-29
**Scope:** Replace the app's visual identity (palette, token naming) across every existing web screen. Layout, spacing, radius scale, type scale, touch targets, and the Atkinson Hyperlegible Next typeface are unchanged — this is a reskin, not a restructure.

## Context

Phase 1 shipped a green/turmeric identity (`--neem-*`, `--haldi-*` tokens). The user found it — and the general visual feel — didn't work, independent of any functional concerns. Explored four style directions (Warm Minimal, Bold Modern, Soft Rounded, Editorial Neutral) via mockup comparison; **Warm Minimal** was chosen decisively. Accent and "today" colors were then chosen from curated options within that direction.

The existing design-token architecture (`apps/web/src/styles/tokens.css`) — semantic CSS custom properties, a light block plus a `prefers-color-scheme: dark` override block, consumed by `base.css`/`components.css`/feature-scoped CSS (`shell.css`, `auth.css`) and by `Logo.tsx` inline — is sound and stays. Only token names and values change, plus the couple of component files that reference old names directly.

## Palette

| Old token | New token | Light value | Dark value | Role |
|---|---|---|---|---|
| `--neem-900` | `--accent-900` | `#7A2708` | `#F5CDB5` | darkest accent shade — defined but currently unused in any file; kept for scale completeness, same as `--neem-900` today |
| `--neem-700` | `--accent-700` | `#C2410C` | `#E68A5C` | primary actions, links, active nav, focus ring |
| `--neem-600` | `--accent-600` | `#D6551F` | `#EF9B70` | hover states |
| `--neem-100` | `--accent-100` | `#F5DDD0` | `#3D2A1F` | subtle accent background (badges, selected rows) |
| `--neem-50` | `--accent-50` | `#FBEEE6` | `#2E211A` | faintest accent tint |
| `--haldi-500` | `--today-500` | `#B8790C` | `#D9A441` | the one "today" signal — reserved, never reused for anything else |
| `--haldi-100` | `--today-100` | `#F6E6C6` | `#3D3016` | today's subtle background |
| `--paper` | `--paper` | `#FAF7F2` | `#1C1815` | app background |
| `--surface` | `--surface` | `#FFFFFF` | `#241F1A` | cards, sheets, inputs |
| `--ink` | `--ink` | `#2D2A26` | `#F3EDE4` | primary text |
| `--ink-2` | `--ink-2` | `#5C554C` | `#C9BFB2` | secondary text |
| `--ink-3` | `--ink-3` | `#8A7F70` | `#A69C8E` | tertiary text, placeholders |
| `--line` | `--line` | `#E8E1D6` | `#3A332C` | default borders/dividers |
| `--line-strong` | `--line-strong` | `#D8CFC0` | `#4E463C` | emphasized borders |

**Status colors (`--overdue`, `--due-soon`, `--ok`, `--info`, plus their `-bg` pairs) are unchanged in both light and dark** — they were already neutral utility colors independent of the green theme, and remain legible on the new paper/surface values. The existing rule stays: status is always a word or icon *plus* color, never color alone.

**Shadow tint** (`--shadow-sheet`) changes from the old green-tinted `rgba(18, 48, 31, 0.14)` to an ink-neutral `rgba(45, 42, 26, 0.14)` in light mode; the dark-mode shadow (`rgba(0, 0, 0, 0.5)`) is unchanged.

**Focus ring** (`--focus`) keeps its shape, swapping the color source from `--neem-600` to `--accent-600`.

## Unchanged (explicitly, so implementation doesn't second-guess it)

- Font: `Atkinson Hyperlegible Next` stack, 17px base, type scale (`--text-xs` through `--text-3xl`).
- Spacing scale (`--space-1` through `--space-12`).
- Radius scale (`--radius-sm: 8px`, `--radius-md: 14px`, `--radius-lg: 22px`).
- Touch target minimum (`--touch: 48px`).
- Motion (`--ease`, `--dur`).
- Layout: bottom tab bar on mobile, sidebar ≥900px, all existing page structure.

## Component-level changes

- **`Logo.tsx`**: body fill `var(--neem-700)` → `var(--accent-700)`; stroke stays `var(--paper)`; dot fill `var(--haldi-500)` → `var(--today-500)`. No structural change.
- **`Button`, `Alert`, badges (`.badge--neutral`), `TextField` focus states, bottom-nav/sidebar active link states, calendar "today" highlight**: all consume the renamed tokens through existing CSS classes in `components.css`/`shell.css`/`auth.css` — no component logic changes, only the token values and names they reference.
- **`MorePage.tsx`**: the one `.tsx` file (besides `Logo.tsx`) with an inline token reference (`var(--neem-700)` on the household-switcher checkmark icon) — update to `var(--accent-700)`.

## Files touched

`apps/web/src/styles/tokens.css` (token rename + revalue, both light and dark blocks), `apps/web/src/styles/base.css`, `apps/web/src/styles/components.css`, `apps/web/src/features/app/shell.css`, `apps/web/src/features/auth/auth.css` (replace old token names with new ones — no value changes needed in these files, since they reference tokens by name, not literal colors), `apps/web/src/components/Logo.tsx`, `apps/web/src/features/app/MorePage.tsx`.

No new files. No backend changes. No test logic changes expected — existing component tests assert behavior and text content, not computed CSS values, so they should pass unchanged; a final manual pass across each screen (light + dark) confirms the reskin reads correctly.

## Testing / verification approach

- `grep -r "neem\|haldi"` across `apps/web/src` returns zero results when done (currently 43 occurrences across 7 files) — a mechanical completeness check.
- Existing web test suite (component tests) must stay green — they don't assert on color values, so a pure token/CSS change shouldn't break them; if any test does incidentally break, that's a signal the change strayed into markup/behavior and needs review.
- Manual visual pass: run the dev server, check each existing screen (sign-in, sign-up, forgot/reset password, verify-email, onboarding, home, coming-soon ×3, more, members, accept-invite) in both light and dark (`prefers-color-scheme`), confirm no leftover green, adequate contrast, and the "today" color still reads as a single, reserved signal.
