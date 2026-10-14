# Ghar home redesign: handoff for Claude Code

**Status:** Approved. Supersedes `2026-10-14-daily-screens-ux-redesign-design.md`. Mockups:
`2026-10-14-ghar-home-redesign-mockups/`.

**Implementation decisions made alongside this handoff:**
- Recent activity is deferred — no GET endpoint exists over the audit log today (write-only). Home
  ships without that section for this pass, flagged as needing backend support.
- Token values are retinted onto the *existing* token names in `tokens.css` (`--accent-700` becomes
  coral, `--dusk` becomes indigo, etc.) rather than renaming every token and touching every consumer
  — same visual result, far smaller diff, zero behavior change to components not being rebuilt yet.
- `/today`'s bills section only returns due-today-or-overdue; Needs-attention/Today's-agenda also
  need a 7-day lookahead. The salary section only returns the single nearest-due settlement; both
  sections need the full pending list. Both are small widenings of the existing endpoint/service
  functions already computing household-wide data internally — not new endpoints.
- Execution is staged as 5 tasks, each committed, tested, and merged before the next: (1) tokens,
  (2) shared components, (3) shell/nav rebuild, (4) `/today` API extension, (5) home page rebuild.

Save this file as `C:/ClaudeCodes/household-app/DESIGN_HANDOFF.md`, open that folder in Claude Code, and paste the prompt at the bottom.

This is a design reference, not code to paste in. Inspect the project first and reuse its framework, routes, components, data layer and styling system. Preserve all existing functionality, auth and business logic.

---

## 1. Theme: Indigo + Warm Gray (dark default)

Define these once as design tokens (CSS variables or the project's theme config). No raw hex values in components.

```css
:root {
  /* surfaces */
  --page: #17141F;
  --side: #1D1A2A;
  --card: #221E31;
  --card-hover: #272238;
  --hover: #2A2538;
  --active-bg: #2B2236;
  --chip: #2E2940;
  /* borders */
  --border: #34304A;
  --border-soft: #2C2840;
  /* text (warm gray) */
  --text: #F3EEE8;
  --text-2: #BDB5AD;
  --text-3: #9C948D;
  /* brand */
  --indigo: #3B3382;
  --indigo-soft: #B9AFF8;
  --focus: #B9AFF8;
  /* action accent (coral), reserved for actions and active state */
  --coral: #F4906F;
  --coral-hover: #F7A284;
  --coral-ink: #2E1209;
  /* status */
  --green-bg: #1E3A2C;  --green-fg: #8FD4A8;   /* paid, done, all clear */
  --amber-bg: #3D3115;  --amber-fg: #F2C867;   /* upcoming, pending */
  --red-bg:   #43212A;  --red-fg:   #FFA394;   /* overdue */
}
```

Rules:
- Coral is for actions (links, primary buttons, active nav, icons in quick actions) and never for decoration.
- One filled coral button per view. Everything else is outlined or ghost.
- Status is always shown with text, not colour alone.
- Visible keyboard focus: `outline: 2px solid var(--focus); outline-offset: 2px`.
- Respect `prefers-reduced-motion`. Hover and press transitions only.
- Optional later: a light theme using the same token names (cream surfaces, plum text, terracotta `#B4492E` for text-on-light actions).

## 2. Type, spacing, shape

- Sans: DM Sans (400, 500). Serif for the date headline and brand wordmark only: Fraunces 500.
- Sizes: page title 34px desktop and 28px mobile, section heading 18px, body 15px, secondary 14px, caption and badge 12 to 13px, stat number 32px desktop and 28px mobile.
- Radii: cards 16px, controls and nav items 10 to 12px, badges 999px.
- Touch targets: 44px minimum for buttons and nav. Row action buttons are 40px on desktop and 44px on mobile.
- Spacing scale: 4, 8, 12, 16, 20, 24, 32, 40.
- Cards use a flat fill and a 1px border. No shadows, no gradients, no nested cards.

## 3. Home page structure (desktop 1440, content max about 1240)

Sidebar 256px, then main with padding `32px 40px`.

1. Header: greeting ("Good evening, Parakh"), date in serif, a one-line summary generated from data ("1 bill is overdue and Lata's attendance isn't marked yet."). Right side: notifications button (with unread dot and aria-label) and profile button.
2. Overview: 4 cards in a responsive grid, `repeat(auto-fit, minmax(220px, 1fr))`.
   - Attendance today: `marked of total`, badge "N not recorded" (amber) or "All marked" (green).
   - Pending tasks: open count, badge "N due today" (amber) or "Nothing due today" (green).
   - Bills due or overdue: count of overdue plus due within 7 days, badge "N overdue" (red), else "Due this week" (amber), else "None due" (green).
   - Salaries to settle: pending settlement count, badge "Next: <date>" (amber) or "All settled" (green).
   - Each card is a link to its screen. Counts come from real data, never hardcoded.
3. Two columns below (wrap on narrow screens):
   - Left, about 2/3: **Needs attention**, then **Recent activity**.
   - Right, about 1/3: **Today's agenda**, then **Quick actions**.

### Needs attention
- Items: overdue bills, bills due within 7 days, househelps with no attendance recorded today, open tasks due today (grouped into one row), pending salary settlements.
- Sort by urgency: days until due ascending (overdue is negative), with attendance and today's tasks at 0.
- Show the top 5, then "See all N items".
- Each row: icon tile (tone by status), title, one-line detail (amount, due date, days late), status badge, one action button.
- Actions: Record payment, Mark attendance, Open checklist, Record settlement.
- When there are no items, hide the rows and show an all-clear state ("You're all caught up").

### Today's agenda
- "Today" group: missing attendance, open tasks (with time if any), overdue bills.
- "Coming up" group: unpaid bills and pending salaries with future dates, sorted by date.
- Link: "Full calendar".

### Quick actions
Mark attendance, Add a task, Add a bill, Record a payment, Record salary settlement. Include this note under them: "Payments and settlements are recorded manually. Ghar doesn't move any money."

### Recent activity
Last 4 or so events from existing data (payments, attendance marks, checklist completions, settlements), each with initials, text and time. Only include event types the data actually supports.

## 4. Navigation

- Desktop sidebar groups: **Main** (Home, Househelps, Checklist, Calendar, Bills, Salaries) and **More** (Reports, Family members, Settings). Household switcher at the top, profile row at the bottom, collapse button. Active item uses `--active-bg` and coral text with `aria-current="page"`. No left-border accents.
- Mobile: compact top bar (household switcher, notifications, profile) and a sticky bottom bar with Home, Househelps, Checklist, Bills, More. Calendar and Salaries sit under More on mobile. Pad the bottom bar with `env(safe-area-inset-bottom)`. No horizontal overflow at 360 and 390px.

## 5. Components to build (shared, presentational)

`SummaryCard`, `StatusBadge` (tones: red, amber, green, neutral), `ActionButton` (primary, secondary), `ListRow`, `SectionCard`, `EmptyState`, `PageHeader`, `AgendaItem`, `ActivityItem`, `NavItem`.

Keep calculations (counts, urgency sorting, status rules, date maths) in one place, such as selectors or hooks. Components receive ready values. Use one status calculation shared by every screen so the dashboard and the Bills/Salaries pages never disagree.

## 6. Content rules

- Sentence case. Buttons start with a verb: "Record payment", "Mark attendance".
- Never imply money moved. Say "Record payment" and "Mark as paid", not "Pay now", unless a payment is genuinely processed.
- Indian formatting: `₹` and `toLocaleString('en-IN')`. Dates like "3 Oct".
- Empty, loading, error and success states are all designed. Destructive actions get confirm or undo.

## 7. Done when

- Home page matches the structure above at 360, 390, 768, 1024 and 1440px with no horizontal overflow or clipped content.
- Every number on the page comes from real app data. List any section that has no real data source.
- Existing routes, auth and business logic still work.
- The project's lint, type-check, build and tests pass.

---

## First prompt to paste into Claude Code

```
Read DESIGN_HANDOFF.md in this project. Then inspect the codebase before changing anything: framework, styling system, routes, shared layout, existing components, and the data model. Tell me what's real data and what's mocked on the current dashboard.

Then implement the redesign in the existing app (do not replace it with a demo):
1. Add the design tokens from section 1 using the project's existing styling approach.
2. Build the shared components from section 5.
3. Rebuild the app shell (sidebar on desktop, bottom nav on mobile) per section 4.
4. Rebuild the home page per section 3, using real data for every number and a shared status calculation.
5. Run lint, type-check, build and tests, fix what you broke, and summarise files changed, what's preserved, and anything that needs backend support.

Pause after step 2 and show me the component list before continuing. Do not add a payment gateway, notification service or new backend dependency.
```
