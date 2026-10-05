import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { meKey } from "../../auth/session";
import { BillsListPage } from "./BillsListPage";

const HOUSEHOLD = { id: "h1", name: "Shah Family", timezone: "Asia/Kolkata", role: "OWNER" as const, memberCount: 2 };

const BILL = {
  id: "b1", name: "Electricity", categoryId: null, provider: "BESCOM", accountNumber: null,
  amountPaise: 150000, frequency: "MONTHLY" as const, intervalCount: 1, intervalUnit: null,
  firstDueDate: "2026-10-05", endDate: null, paymentMethod: null, autopay: false,
  status: "ACTIVE" as const, notes: null, archivedAt: null, createdAt: "2026-01-01T00:00:00.000Z",
};

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function renderPage() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  qc.setQueryData(meKey, { user: { id: "u1", name: "Parakh", email: "p@example.com", emailVerified: true, createdAt: "2026-01-01T00:00:00.000Z" }, households: [HOUSEHOLD] });
  return render(<QueryClientProvider client={qc}><MemoryRouter><BillsListPage /></MemoryRouter></QueryClientProvider>);
}

describe("BillsListPage", () => {
  beforeEach(() => { vi.restoreAllMocks(); });

  it("lists bills with amount and frequency, and shows an add button when the viewer can manage", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation((async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/households/h1")) return jsonResponse({ success: true, data: { ...HOUSEHOLD, permissions: ["bills.view", "bills.manage"] }, message: null });
      if (url.endsWith("/bill-categories")) return jsonResponse({ success: true, data: [], message: null });
      if (url.includes("/households/h1/bills")) return jsonResponse({ success: true, data: [BILL], message: null });
      throw new Error(`unexpected fetch ${url}`);
    }) as typeof fetch);
    renderPage();
    expect(await screen.findByText("Electricity")).toBeInTheDocument();
    expect(screen.getByText(/₹1,500/)).toBeInTheDocument();
    expect(screen.getByText(/Monthly/)).toBeInTheDocument();
    expect(screen.getByText("Active")).toBeInTheDocument();
    expect(await screen.findByRole("button", { name: /add bill/i })).toBeInTheDocument();
  });

  it("shows a variable-amount bill without an amount figure", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation((async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/households/h1")) return jsonResponse({ success: true, data: { ...HOUSEHOLD, permissions: ["bills.view"] }, message: null });
      if (url.endsWith("/bill-categories")) return jsonResponse({ success: true, data: [], message: null });
      if (url.includes("/households/h1/bills")) return jsonResponse({ success: true, data: [{ ...BILL, amountPaise: null }], message: null });
      throw new Error(`unexpected fetch ${url}`);
    }) as typeof fetch);
    renderPage();
    expect(await screen.findByText(/Variable amount/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /add bill/i })).not.toBeInTheDocument();
  });

  it("toggling Show archived requests archived bills too", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation((async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/households/h1")) return jsonResponse({ success: true, data: { ...HOUSEHOLD, permissions: ["bills.view", "bills.manage"] }, message: null });
      if (url.endsWith("/bill-categories")) return jsonResponse({ success: true, data: [], message: null });
      if (url.includes("/households/h1/bills")) return jsonResponse({ success: true, data: [BILL], message: null });
      throw new Error(`unexpected fetch ${url}`);
    }) as typeof fetch);
    renderPage();
    await screen.findByText("Electricity");
    await userEvent.click(screen.getByRole("button", { name: "Show archived" }));
    expect(await screen.findByRole("button", { name: "Showing archived" })).toBeInTheDocument();
    const archivedCall = fetchSpy.mock.calls.find(([u]) => String(u).includes("includeArchived=true"));
    expect(archivedCall).toBeDefined();
  });
});
