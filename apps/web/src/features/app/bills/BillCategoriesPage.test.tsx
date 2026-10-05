import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { meKey } from "../../auth/session";
import { BillCategoriesPage } from "./BillCategoriesPage";

const HOUSEHOLD = { id: "h1", name: "Shah Family", timezone: "Asia/Kolkata", role: "OWNER" as const, memberCount: 2 };

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function renderPage() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  qc.setQueryData(meKey, { user: { id: "u1", name: "Parakh", email: "p@example.com", emailVerified: true, createdAt: "2026-01-01T00:00:00.000Z" }, households: [HOUSEHOLD] });
  return render(<QueryClientProvider client={qc}><MemoryRouter><BillCategoriesPage /></MemoryRouter></QueryClientProvider>);
}

function mockFetch(permissions: string[]) {
  return vi.spyOn(globalThis, "fetch").mockImplementation((async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.endsWith("/households/h1")) return jsonResponse({ success: true, data: { ...HOUSEHOLD, permissions }, message: null });
    if (init?.method === "POST" && url.endsWith("/bill-categories")) return jsonResponse({ success: true, data: { id: "c2", name: "Utilities", icon: null, sortOrder: 1, isActive: true }, message: null });
    if (url.endsWith("/bill-categories")) return jsonResponse({ success: true, data: [{ id: "c1", name: "Housing", icon: "🏠", sortOrder: 0, isActive: true }], message: null });
    throw new Error(`unexpected fetch ${url}`);
  }) as typeof fetch);
}

describe("BillCategoriesPage", () => {
  beforeEach(() => { vi.restoreAllMocks(); });

  it("lists categories and posts a new one from the add form", async () => {
    const fetchSpy = mockFetch(["bills.view", "bills.manage"]);
    renderPage();
    expect(await screen.findByText(/Housing/)).toBeInTheDocument();
    await userEvent.type(screen.getByLabelText("Category name"), "Utilities");
    await userEvent.click(screen.getByRole("button", { name: "Add category" }));
    const postCall = fetchSpy.mock.calls.find(([, init]) => (init as RequestInit | undefined)?.method === "POST");
    expect(postCall).toBeDefined();
    expect(JSON.parse((postCall![1] as RequestInit).body as string)).toEqual({ name: "Utilities" });
  });

  it("clicking a move button posts the move request with the correct direction", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation((async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/households/h1")) return jsonResponse({ success: true, data: { ...HOUSEHOLD, permissions: ["bills.view", "bills.manage"] }, message: null });
      if (init?.method === "POST" && url.endsWith("/move")) return jsonResponse({ success: true, data: null, message: null });
      if (url.endsWith("/bill-categories")) {
        return jsonResponse({
          success: true,
          data: [{ id: "c1", name: "Housing", icon: null, sortOrder: 0, isActive: true }, { id: "c2", name: "Utilities", icon: null, sortOrder: 1, isActive: true }],
          message: null,
        });
      }
      throw new Error(`unexpected fetch ${url}`);
    }) as typeof fetch);
    renderPage();
    expect(await screen.findByText("Housing")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Move Utilities up" }));
    const moveCall = fetchSpy.mock.calls.find(([u, init]) => String(u).endsWith("/move") && (init as RequestInit | undefined)?.method === "POST");
    expect(moveCall).toBeDefined();
    expect(String(moveCall![0])).toContain("/bill-categories/c2/move");
    expect(JSON.parse((moveCall![1] as RequestInit).body as string)).toEqual({ direction: "up" });
  });

  it("hides the add-category form and per-row controls for a viewer without bills.manage", async () => {
    mockFetch(["bills.view"]);
    renderPage();
    await screen.findByText(/Housing/);
    expect(screen.queryByRole("button", { name: "Add category" })).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Category name")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Move Housing up" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Remove Housing" })).not.toBeInTheDocument();
  });
});
