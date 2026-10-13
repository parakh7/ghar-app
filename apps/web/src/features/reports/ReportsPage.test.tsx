import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { meKey } from "../auth/session";
import { ReportsPage } from "./ReportsPage";

const HOUSEHOLD = { id: "h1", name: "Shah Family", timezone: "Asia/Kolkata", role: "OWNER" as const, memberCount: 2 };

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function renderPage() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  qc.setQueryData(meKey, { user: { id: "u1", name: "Parakh", email: "p@example.com", emailVerified: true, createdAt: "2026-01-01T00:00:00.000Z" }, households: [HOUSEHOLD] });
  vi.spyOn(globalThis, "fetch").mockImplementation((async (input: RequestInfo | URL) => {
    const url = new URL(String(input), "http://localhost");
    const type = url.searchParams.get("type");
    if (url.pathname === "/api/households/h1/reports" && type === "bills") {
      return jsonResponse({ success: true, data: {
        type: "bills", rows: [{ occurrenceId: "o1", billId: "b1", billName: "Electricity", dueDate: "2026-09-15", amountDuePaise: 50000, amountPaidPaise: 0, status: "PENDING" }],
        totalDuePaise: 50000, totalPaidPaise: 0,
      } }, 200);
    }
    if (url.pathname === "/api/households/h1/reports" && type === "salary") {
      return jsonResponse({ success: true, data: {
        type: "salary", rows: [{ settlementId: "s1", househelpId: "hh1", househelpName: "Sunita", netPayablePaise: 1000000, amountPaidPaise: 0, status: "PENDING" }],
        totalNetPayablePaise: 1000000, totalPaidPaise: 0,
      } }, 200);
    }
    throw new Error(`unexpected fetch ${url}`);
  }) as typeof fetch);
  return render(<QueryClientProvider client={qc}><MemoryRouter><ReportsPage /></MemoryRouter></QueryClientProvider>);
}

describe("ReportsPage", () => {
  beforeEach(() => { vi.restoreAllMocks(); });
  afterEach(() => { vi.restoreAllMocks(); });

  it("renders the bills report by default", async () => {
    renderPage();
    await screen.findByText("Electricity");
  });

  it("switches to the salary report when selected", async () => {
    renderPage();
    await screen.findByText("Electricity");
    await userEvent.click(screen.getByRole("button", { name: "Salary" }));
    await screen.findByText("Sunita");
  });
});
