# Mobile Polish Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Three small consistency fixes — uniform text truncation on long fields, and merging a duplicate badge on Today/Checklist rows.

**Architecture:** Both changes reuse existing CSS/markup patterns already proven elsewhere in the app (`.list__meta--truncate`, the single-`<span>` badge). No new components, no new CSS.

**Tech Stack:** No changes — plain React/CSS edits in existing files.

## Global Constraints

- No new CSS classes. `.list__meta--truncate` (`apps/web/src/features/app/shell.css:108`) already exists and already works correctly wherever applied, because `.list__text` already has `min-width: 0` (`shell.css:109`).
- Every truncated field keeps a `title` attribute carrying the full untruncated text, matching the existing usage on the More page's email (`MorePage.tsx:72`).
- The member-row "cramped" feeling is resolved by truncation alone — no structural/layout change to `MembersPage.tsx`'s row markup.
- Safe-area insets, touch-target sizing, the nav breakpoint, and chip-picker wrapping are confirmed already correct — do not touch them.

---

### Task 1: Consistent text truncation

**Files:**
- Modify: `apps/web/src/features/app/members/MembersPage.tsx` (active-member email at line 64, pending-invite email at line 100)
- Modify: `apps/web/src/features/app/bills/BillDetailPage.tsx` (bill notes at line 288, combined payment line at line 182)
- Test: `apps/web/src/features/app/members/MembersPage.test.tsx`, `apps/web/src/features/app/bills/BillDetailPage.test.tsx`

**Interfaces:** None — this task only changes JSX attributes on existing elements, no new functions or types.

- [ ] **Step 1: Write the failing tests**

Add to `apps/web/src/features/app/members/MembersPage.test.tsx`, inside the existing `describe("MembersPage", ...)` block:

```typescript
  it("truncates long member and invite emails with a title tooltip carrying the full text", async () => {
    const LONG_EMAIL = "riya.very.long.email.address.for.testing@example-household.com";
    mockFetch(["members.view", "members.manage"], { members: [MEMBERS[0]!, { ...MEMBERS[1]!, email: LONG_EMAIL }] });
    renderPage();
    const emailEl = await screen.findByText(LONG_EMAIL);
    expect(emailEl).toHaveClass("list__meta--truncate");
    expect(emailEl).toHaveAttribute("title", LONG_EMAIL);
  });
```

Add to `apps/web/src/features/app/bills/BillDetailPage.test.tsx`, inside the existing `describe("BillDetailPage", ...)` block (mirror the fetch-mock structure of the file's first test, `"shows an active bill's details and posts a pause request"`, but with a bill that has notes and a payment with a reference + note):

```typescript
  it("truncates long bill notes and the combined payment line with a title tooltip", async () => {
    const LONG_NOTE = "Call the provider before the 5th if the smart meter reading looks unusually high this month";
    vi.spyOn(globalThis, "fetch").mockImplementation((async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/households/h1")) return jsonResponse({ success: true, data: { ...HOUSEHOLD, permissions: ["bills.view", "bills.manage"] }, message: null });
      if (url.endsWith("/bill-categories")) return jsonResponse({ success: true, data: [], message: null });
      if (url.endsWith("/bills/b1")) return jsonResponse({ success: true, data: { ...ACTIVE_BILL, notes: LONG_NOTE }, message: null });
      if (init?.method === "POST" && url.endsWith("/bills/b1/occurrences/sync")) return jsonResponse({ success: true, data: [PENDING_OCCURRENCE], message: null });
      if (url.endsWith("/bills/b1/occurrences")) return jsonResponse({ success: true, data: [PENDING_OCCURRENCE], message: null });
      if (init?.method === "GET" && url.endsWith("/occurrences/occ1/payments")) {
        return jsonResponse({ success: true, data: [{ ...ACTIVE_PAYMENT, transactionRef: "UPI-REF-00123456789", notes: LONG_NOTE }], message: null });
      }
      throw new Error(`unexpected fetch ${url}`);
    }) as typeof fetch);
    renderPage();
    const noteEl = await screen.findByText(LONG_NOTE);
    expect(noteEl).toHaveClass("list__meta--truncate");
    expect(noteEl).toHaveAttribute("title", LONG_NOTE);
    const expectedPaymentLine = `2026-10-05 · UPI-REF-00123456789 · ${LONG_NOTE}`;
    const paymentLineEl = await screen.findByText(expectedPaymentLine);
    expect(paymentLineEl).toHaveClass("list__meta--truncate");
    expect(paymentLineEl).toHaveAttribute("title", expectedPaymentLine);
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd apps/web && npm run test -- MembersPage BillDetailPage`
Expected: FAIL — neither element has the `list__meta--truncate` class or a `title` attribute yet.

- [ ] **Step 3: Apply truncation in `MembersPage.tsx`**

Change line 64 from:

```tsx
              <span className="list__meta">{m.email}</span>
```

to:

```tsx
              <span className="list__meta list__meta--truncate" title={m.email}>{m.email}</span>
```

Change line 100 from:

```tsx
                  <span className="list__label" style={{ display: "block" }}>{inv.email}</span>
```

to:

```tsx
                  <span className="list__label list__meta--truncate" style={{ display: "block" }} title={inv.email}>{inv.email}</span>
```

(This one uses `list__label` as its base class, not `list__meta` — `list__meta--truncate` only sets `display/overflow/text-overflow/white-space`, it doesn't depend on which other class it's paired with, so this is safe to combine.)

- [ ] **Step 4: Apply truncation in `BillDetailPage.tsx`**

Change line 288 from:

```tsx
        {b.notes && <div className="list__item"><span className="list__text"><span className="list__label" style={{ display: "block" }}>Notes</span><span className="list__meta">{b.notes}</span></span></div>}
```

to:

```tsx
        {b.notes && <div className="list__item"><span className="list__text"><span className="list__label" style={{ display: "block" }}>Notes</span><span className="list__meta list__meta--truncate" title={b.notes}>{b.notes}</span></span></div>}
```

Change line 182 from:

```tsx
                <span className="list__meta">{p.paidOn}{p.transactionRef && ` · ${p.transactionRef}`}{p.notes && ` · ${p.notes}`}</span>
```

to:

```tsx
                <span className="list__meta list__meta--truncate" title={`${p.paidOn}${p.transactionRef ? ` · ${p.transactionRef}` : ""}${p.notes ? ` · ${p.notes}` : ""}`}>{p.paidOn}{p.transactionRef && ` · ${p.transactionRef}`}{p.notes && ` · ${p.notes}`}</span>
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `cd apps/web && npm run test -- MembersPage BillDetailPage`
Expected: PASS (all tests in both files)

- [ ] **Step 6: Run the full web test suite as a regression check**

Run: `cd apps/web && npm run test`
Expected: PASS, no regressions

- [ ] **Step 7: Typecheck**

Run: `cd apps/web && npm run typecheck`
Expected: PASS

- [ ] **Step 8: Commit**

```bash
git add apps/web/src/features/app/members/MembersPage.tsx apps/web/src/features/app/members/MembersPage.test.tsx apps/web/src/features/app/bills/BillDetailPage.tsx apps/web/src/features/app/bills/BillDetailPage.test.tsx
git commit -m "fix(web): consistent text truncation for long emails, notes, and payment references"
```

---

### Task 2: Merge the pending-sync badge into the status badge

**Files:**
- Modify: `apps/web/src/features/app/attendance/TodayPage.tsx`
- Modify: `apps/web/src/features/app/checklist/ChecklistTodayPage.tsx`
- Test: `apps/web/src/features/app/attendance/TodayPage.test.tsx`, `apps/web/src/features/app/checklist/ChecklistTodayPage.test.tsx`

**Interfaces:** None — this only changes where the pending-sync indicator renders (inside the existing status badge instead of as a sibling), not any data flow.

- [ ] **Step 1: Write the failing tests**

Both files already have a test named `"queues the mark and shows a pending badge when the PUT fails with a network error"` (added by the offline-mutation-queue spec). Replace its final assertion.

In `apps/web/src/features/app/attendance/TodayPage.test.tsx`, change:

```typescript
    expect(await screen.findByLabelText("Not yet synced")).toBeInTheDocument();
```

to:

```typescript
    const indicator = await screen.findByLabelText("Not yet synced");
    expect(indicator.closest(".badge")?.textContent).toContain("Present");
    expect(document.querySelectorAll(".badge--muted")).toHaveLength(0);
```

In `apps/web/src/features/app/checklist/ChecklistTodayPage.test.tsx`, change the same final assertion line in its equivalent test to:

```typescript
    const indicator = await screen.findByLabelText("Not yet synced");
    expect(indicator.closest(".badge")?.textContent).toContain("Done");
    expect(document.querySelectorAll(".badge--muted")).toHaveLength(0);
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd apps/web && npm run test -- TodayPage ChecklistTodayPage`
Expected: FAIL — the pending indicator currently renders as its own `badge badge--muted` sibling element, so `document.querySelectorAll(".badge--muted")` has length 1, not 0, and the status badge's `textContent` doesn't include the hourglass.

- [ ] **Step 3: Merge the badge in `TodayPage.tsx`**

Change:

```tsx
              <span
                className={`badge badge--${toneOf(e.status)}${poppedId === e.househelpId ? " pop-in" : ""}`}
                onAnimationEnd={() => setPoppedId((id) => (id === e.househelpId ? null : id))}
              >
                {e.status ? STATUS_LABEL[e.status] : "Not marked"}
              </span>
              {pendingKeys.has(`attendance:${e.househelpId}:${date}`) && (
                <span className="badge badge--muted" aria-label="Not yet synced" title="Will sync when you're back online">⏳</span>
              )}
```

to:

```tsx
              <span
                className={`badge badge--${toneOf(e.status)}${poppedId === e.househelpId ? " pop-in" : ""}`}
                onAnimationEnd={() => setPoppedId((id) => (id === e.househelpId ? null : id))}
              >
                {e.status ? STATUS_LABEL[e.status] : "Not marked"}
                {pendingKeys.has(`attendance:${e.househelpId}:${date}`) && (
                  <span aria-label="Not yet synced" title="Will sync when you're back online"> ⏳</span>
                )}
              </span>
```

- [ ] **Step 4: Merge the badge in `ChecklistTodayPage.tsx`**

Change:

```tsx
                {labelOf(e.status)}
              </button>
              {pendingKeys.has(`checklist:${e.taskId}:${date}`) && (
                <span className="badge badge--muted" aria-label="Not yet synced" title="Will sync when you're back online">⏳</span>
              )}
```

to:

```tsx
                {labelOf(e.status)}
                {pendingKeys.has(`checklist:${e.taskId}:${date}`) && (
                  <span aria-label="Not yet synced" title="Will sync when you're back online"> ⏳</span>
                )}
              </button>
```

(This status indicator is a `<button>`, not a `<span>` — the status indicator element itself already carries the `badge` class on this page, same merge principle applies: nest the indicator inside it instead of adding a sibling.)

- [ ] **Step 5: Run the tests to verify they pass**

Run: `cd apps/web && npm run test -- TodayPage ChecklistTodayPage`
Expected: PASS (all tests in both files)

- [ ] **Step 6: Run the full web test suite as a regression check**

Run: `cd apps/web && npm run test`
Expected: PASS, no regressions

- [ ] **Step 7: Typecheck**

Run: `cd apps/web && npm run typecheck`
Expected: PASS

- [ ] **Step 8: Commit**

```bash
git add apps/web/src/features/app/attendance/TodayPage.tsx apps/web/src/features/app/attendance/TodayPage.test.tsx apps/web/src/features/app/checklist/ChecklistTodayPage.tsx apps/web/src/features/app/checklist/ChecklistTodayPage.test.tsx
git commit -m "fix(web): merge the pending-sync indicator into the status badge instead of a sibling badge"
```

---

## Self-Review Notes

- **Spec coverage:** truncation (Task 1, covers spec items 1 and 2 — item 2 is explicitly a side-effect of item 1, no separate task needed), badge merge (Task 2, spec item 3). Everything the spec marked "explicitly out of scope" has no task, correctly.
- **Placeholder scan:** every step has concrete before/after code or a concrete test.
- **Type consistency:** no new types introduced in either task; existing `PENDING_OCCURRENCE`/`ACTIVE_PAYMENT`/`ACTIVE_BILL`/`MEMBERS` fixtures are reused as-is via spread (`{ ...ACTIVE_BILL, notes: LONG_NOTE }`), matching each file's existing test conventions exactly.
