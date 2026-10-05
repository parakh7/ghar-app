import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { meKey } from "../../auth/session";
import { BillDetailPage } from "./BillDetailPage";

const HOUSEHOLD = { id: "h1", name: "Shah Family", timezone: "Asia/Kolkata", role: "OWNER" as const, memberCount: 2 };

const ACTIVE_BILL = {
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
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={["/bills/b1"]}>
        <Routes><Route path="/bills/:id" element={<BillDetailPage />} /></Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe("BillDetailPage", () => {
  beforeEach(() => { vi.restoreAllMocks(); });

  it("shows an active bill's details and posts a pause request", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation((async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/households/h1")) return jsonResponse({ success: true, data: { ...HOUSEHOLD, permissions: ["bills.view", "bills.manage"] }, message: null });
      if (url.endsWith("/bill-categories")) return jsonResponse({ success: true, data: [], message: null });
      if (url.endsWith("/bills/b1")) return jsonResponse({ success: true, data: ACTIVE_BILL, message: null });
      if (init?.method === "POST" && url.endsWith("/bills/b1/pause")) return jsonResponse({ success: true, data: null, message: null });
      throw new Error(`unexpected fetch ${url}`);
    }) as typeof fetch);
    renderPage();
    await screen.findByText("Electricity");
    expect(screen.getByText("Active")).toBeInTheDocument();
    expect(screen.getByText("BESCOM")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Pause" }));
    const pauseCall = fetchSpy.mock.calls.find(([u, i]) => String(u).endsWith("/bills/b1/pause") && (i as RequestInit | undefined)?.method === "POST");
    expect(pauseCall).toBeDefined();
  });

  it("shows a Restore button for an archived bill and posts an unarchive request", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation((async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/households/h1")) return jsonResponse({ success: true, data: { ...HOUSEHOLD, permissions: ["bills.view", "bills.manage"] }, message: null });
      if (url.endsWith("/bill-categories")) return jsonResponse({ success: true, data: [], message: null });
      if (url.endsWith("/bills/b1")) {
        return jsonResponse({ success: true, data: { ...ACTIVE_BILL, status: "ARCHIVED", archivedAt: "2026-10-01T00:00:00.000Z" }, message: null });
      }
      if (init?.method === "POST" && url.endsWith("/bills/b1/unarchive")) return jsonResponse({ success: true, data: null, message: null });
      throw new Error(`unexpected fetch ${url}`);
    }) as typeof fetch);
    renderPage();
    await screen.findByText("Electricity");
    expect(screen.getByText(/this bill is archived/i)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Pause" })).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Restore" }));
    const unarchiveCall = fetchSpy.mock.calls.find(([u, i]) => String(u).endsWith("/bills/b1/unarchive") && (i as RequestInit | undefined)?.method === "POST");
    expect(unarchiveCall).toBeDefined();
  });

  it("hides management actions for a viewer without bills.manage", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation((async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/households/h1")) return jsonResponse({ success: true, data: { ...HOUSEHOLD, permissions: ["bills.view"] }, message: null });
      if (url.endsWith("/bill-categories")) return jsonResponse({ success: true, data: [], message: null });
      if (url.endsWith("/bills/b1")) return jsonResponse({ success: true, data: ACTIVE_BILL, message: null });
      throw new Error(`unexpected fetch ${url}`);
    }) as typeof fetch);
    renderPage();
    await screen.findByText("Electricity");
    expect(screen.queryByRole("button", { name: "Pause" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Edit details" })).not.toBeInTheDocument();
  });
});
