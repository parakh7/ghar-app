import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { meKey } from "../auth/session";
import { HomePage } from "./HomePage";

const HOUSEHOLD = { id: "h1", name: "Shah Family", timezone: "Asia/Kolkata", role: "OWNER" as const, memberCount: 2 };

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function renderPage(dashboard: unknown) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  qc.setQueryData(meKey, { user: { id: "u1", name: "Parakh", email: "p@example.com", emailVerified: true, createdAt: "2026-01-01T00:00:00.000Z" }, households: [HOUSEHOLD] });
  vi.spyOn(globalThis, "fetch").mockImplementation((async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.endsWith("/households/h1/today")) return jsonResponse({ success: true, data: dashboard }, 200);
    throw new Error(`unexpected fetch ${url}`);
  }) as typeof fetch);
  return render(<QueryClientProvider client={qc}><MemoryRouter><HomePage /></MemoryRouter></QueryClientProvider>);
}

describe("HomePage", () => {
  beforeEach(() => { vi.restoreAllMocks(); });
  afterEach(() => { vi.restoreAllMocks(); });

  it("renders real content for every section the caller has permission for", async () => {
    renderPage({
      attendance: { marked: 2, total: 3 },
      checklist: { done: 1, total: 2, pending: ["Sweep floor"] },
      bills: [{ occurrenceId: "o1", billId: "b1", billName: "Electricity", amountDuePaise: 50000, dueDate: "2026-09-29", isOverdue: false }],
      salary: { upcoming: { settlementId: "s1", househelpName: "Sunita", periodMonth: "2026-09-01", dueDate: "2026-10-05", netDuePaise: 1000000, status: "PENDING" }, hasAnySettlement: true },
    });
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
});
