# Mobile Polish — Design Spec

**Phase:** 9 (PWA, offline cache and mutation queue, mobile polish) — Spec 3 of 3 (final spec of the phase).

**Status:** Approved.

## Context

A code-level audit (live viewport emulation wasn't available in this environment, so this was a read of every page component under `apps/web/src/features/`) found the app's mobile fundamentals already solid: safe-area insets (`--safe-top`/`--safe-bottom`) are correctly wired into nav/content padding, touch targets are 48px everywhere (`--touch` token), the nav correctly flips from bottom-tabs to sidebar only above 900px, and chip pickers already wrap. "Mobile polish" is therefore a small, consistency-focused cleanup, not a redesign.

## Scope

**1. Consistent text truncation.** A `.list__meta--truncate` utility (`overflow: hidden; text-overflow: ellipsis; white-space: nowrap;`) already exists and is used for the user's email on the More page — `.list__text`'s `min-width: 0` already makes it work correctly wherever applied. Apply it (with a `title` attribute carrying the full untruncated text, matching the existing usage) to:
   - `MembersPage.tsx`: active-member email (`list__item` row, line ~64) and pending-invite email (line ~100)
   - `BillDetailPage.tsx`: the bill notes line (line ~288) and the combined payment line — date · reference · notes (line ~182)

   No new CSS. This is purely applying an existing class in 4 more places.

**2. Member row tightening — resolved by #1, not a separate change.** The "cramped member row" feeling traced back to a long unwrapped email pushing the row to two lines, misaligning against the role-`<select>` + remove-button cluster beside it. Truncating the email (item 1) keeps the row single-line and resolves this without any structural layout change to `MembersPage.tsx`'s row markup.

**3. Badge density on Today/Checklist rows.** Since the offline-mutation-queue spec, a row can show a status badge, a separate "not yet synced" badge, and the "More" button all side by side. Merge the pending-sync indicator into the existing status badge — append the hourglass inside the same `<span>` — instead of rendering a second sibling badge element. Applies to both `TodayPage.tsx` and `ChecklistTodayPage.tsx`. Same information, one fewer element in the row.

**Explicitly out of scope:** safe-area insets, touch target sizing, the nav breakpoint, and chip-picker wrapping — all confirmed already correct by the audit, no changes needed.

## Testing

- Web: for each of the 4 truncation sites, a test confirming the `list__meta--truncate` class and a `title` attribute carrying the full text are present (existing test files for `MembersPage.tsx` and `BillDetailPage.tsx` get new assertions, not new test files).
- Web: `TodayPage.test.tsx` and `ChecklistTodayPage.test.tsx` get an assertion that the "Not yet synced" pending indicator renders inside the same badge element as the status label (not as a sibling), using the existing network-error queued-write test scenario from the offline-mutation-queue spec.
