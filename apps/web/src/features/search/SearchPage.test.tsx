import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes, useNavigate } from "react-router-dom";
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

  it("updates the input and results when the URL's ?q= changes without remounting the page", async () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    qc.setQueryData(meKey, { user: { id: "u1", name: "Parakh", email: "p@example.com", emailVerified: true, createdAt: "2026-01-01T00:00:00.000Z" }, households: [HOUSEHOLD] });
    vi.spyOn(globalThis, "fetch").mockImplementation((async (input: RequestInfo | URL) => {
      const url = new URL(String(input), "http://localhost");
      if (url.pathname === "/api/households/h1/search" && url.searchParams.get("q") === "sunita") {
        return jsonResponse({ success: true, data: { househelps: [{ id: "hh1", name: "Sunita Devi" }] } }, 200);
      }
      if (url.pathname === "/api/households/h1/search" && url.searchParams.get("q") === "akshay") {
        return jsonResponse({ success: true, data: { members: [{ userId: "u2", name: "Akshay Shah", email: "akshay@example.com" }] } }, 200);
      }
      throw new Error(`unexpected fetch ${url}`);
    }) as typeof fetch);

    function Harness() {
      const navigate = useNavigate();
      return (
        <>
          <button onClick={() => navigate("/search?q=akshay")}>Search akshay instead</button>
          <SearchPage />
        </>
      );
    }

    render(
      <QueryClientProvider client={qc}>
        <MemoryRouter initialEntries={["/search?q=sunita"]}>
          <Routes><Route path="/search" element={<Harness />} /></Routes>
        </MemoryRouter>
      </QueryClientProvider>,
    );

    await screen.findByText("Sunita Devi");
    await userEvent.click(screen.getByRole("button", { name: "Search akshay instead" }));
    await screen.findByText("Akshay Shah");
    expect(screen.queryByText("Sunita Devi")).not.toBeInTheDocument();
    expect(screen.getByLabelText("Search")).toHaveValue("akshay");
  });
});
