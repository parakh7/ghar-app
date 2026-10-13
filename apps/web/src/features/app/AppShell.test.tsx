import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { meKey } from "../auth/session";
import { AppShell } from "./AppShell";

const HOUSEHOLD = { id: "h1", name: "Shah Family", timezone: "Asia/Kolkata", role: "OWNER" as const, memberCount: 2 };

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function renderShell(unreadCount: number) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  qc.setQueryData(meKey, { user: { id: "u1", name: "Parakh", email: "p@example.com", emailVerified: true, createdAt: "2026-01-01T00:00:00.000Z" }, households: [HOUSEHOLD] });
  vi.spyOn(globalThis, "fetch").mockImplementation((async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.endsWith("/notifications/unread-count")) return jsonResponse({ success: true, data: { count: unreadCount }, message: null });
    throw new Error(`unexpected fetch ${url}`);
  }) as typeof fetch);
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={["/"]}>
        <Routes>
          <Route element={<AppShell />}><Route index element={<div>Home page body</div>} /></Route>
          <Route path="/search" element={<div>Search results page</div>} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe("AppShell", () => {
  beforeEach(() => { vi.restoreAllMocks(); });
  afterEach(() => { vi.restoreAllMocks(); });

  it("shows the unread-count badge on the bell when there are unread notifications", async () => {
    renderShell(3);
    expect(await screen.findByLabelText("3 unread notifications")).toBeInTheDocument();
  });

  it("hides the badge when there are no unread notifications", async () => {
    renderShell(0);
    await screen.findByText("Home page body");
    expect(screen.queryByLabelText(/unread notifications/)).not.toBeInTheDocument();
  });

  it("has a mobile search icon linking to /search", async () => {
    renderShell(0);
    await screen.findByText("Home page body");
    expect(screen.getByLabelText("Open search")).toHaveAttribute("href", "/search");
  });

  it("navigates to /search after typing in the desktop search input (debounced)", async () => {
    renderShell(0);
    const input = await screen.findByPlaceholderText("Search");
    await userEvent.type(input, "sunita");
    await new Promise((r) => setTimeout(r, 350));
    await screen.findByText("Search results page");
  });
});
