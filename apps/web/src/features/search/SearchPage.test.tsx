import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { meKey } from "../auth/session";
import { SearchPage } from "./SearchPage";

const HOUSEHOLD = { id: "h1", name: "Shah Family", timezone: "Asia/Kolkata", role: "OWNER" as const, memberCount: 2 };

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function renderPage(initialQuery: string, responseData: unknown) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  qc.setQueryData(meKey, { user: { id: "u1", name: "Parakh", email: "p@example.com", emailVerified: true, createdAt: "2026-01-01T00:00:00.000Z" }, households: [HOUSEHOLD] });
  vi.spyOn(globalThis, "fetch").mockImplementation((async (input: RequestInfo | URL) => {
    const url = new URL(String(input), "http://localhost");
    if (url.pathname === "/api/households/h1/search") return jsonResponse({ success: true, data: responseData }, 200);
    throw new Error(`unexpected fetch ${url}`);
  }) as typeof fetch);
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={[`/search?q=${initialQuery}`]}>
        <Routes><Route path="/search" element={<SearchPage />} /></Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe("SearchPage", () => {
  beforeEach(() => { vi.restoreAllMocks(); });
  afterEach(() => { vi.restoreAllMocks(); });

  it("renders grouped results from the search response", async () => {
    renderPage("sunita", {
      househelps: [{ id: "hh1", name: "Sunita Devi" }],
      bills: [{ id: "b1", name: "Electricity", provider: "BESCOM" }],
      checklistTasks: [{ id: "t1", name: "Wash dishes" }],
      members: [{ userId: "u2", name: "Priya Shah", email: "priya@example.com" }],
    });
    await screen.findByText("Sunita Devi");
    await screen.findByText("Electricity");
    await screen.findByText("Wash dishes");
    await screen.findByText("Priya Shah");
  });

  it("renders no heading for a section absent from the response", async () => {
    renderPage("x", { househelps: [] });
    await screen.findByText("Househelps");
    expect(screen.queryByText("Bills")).not.toBeInTheDocument();
    expect(screen.queryByText("Checklist")).not.toBeInTheDocument();
    expect(screen.queryByText("Members")).not.toBeInTheDocument();
  });
});
