import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { meKey } from "../../auth/session";
import { HousehelpsListPage } from "./HousehelpsListPage";

const HOUSEHOLD = { id: "h1", name: "Shah Family", timezone: "Asia/Kolkata", role: "OWNER" as const, memberCount: 2 };

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function renderPage() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  qc.setQueryData(meKey, { user: { id: "u1", name: "Parakh", email: "p@example.com", emailVerified: true, createdAt: "2026-01-01T00:00:00.000Z" }, households: [HOUSEHOLD] });
  return render(<QueryClientProvider client={qc}><MemoryRouter><HousehelpsListPage /></MemoryRouter></QueryClientProvider>);
}

describe("HousehelpsListPage", () => {
  beforeEach(() => { vi.restoreAllMocks(); });

  it("lists househelps and shows an add button when the viewer can manage", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation((async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/households/h1")) return jsonResponse({ success: true, data: { ...HOUSEHOLD, permissions: ["househelps.view", "househelps.manage", "categories.manage"] }, message: null });
      if (url.endsWith("/categories")) return jsonResponse({ success: true, data: [{ id: "c1", name: "Cleaning", sortOrder: 0, isActive: true }], message: null });
      if (url.includes("/households/h1/househelps")) {
        return jsonResponse({ success: true, data: [{ id: "hh1", name: "Sunita", phone: null, roleTitle: "Cook", status: "ACTIVE", startDate: null, endDate: null, salaryMode: "FIXED_MONTHLY", monthlySalaryPaise: 1000000, dailyRatePaise: null, halfDayRatePaise: null, salaryDueDay: 1, notes: null, archivedAt: null, categoryIds: [], createdAt: "2026-01-01T00:00:00.000Z" }], message: null });
      }
      throw new Error(`unexpected fetch ${url}`);
    }) as typeof fetch);
    renderPage();
    expect(await screen.findByText("Sunita")).toBeInTheDocument();
    expect(await screen.findByRole("button", { name: /add househelp/i })).toBeInTheDocument();
  });

  it("groups househelps by category and puts categoryless ones under Uncategorized", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation((async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/households/h1")) return jsonResponse({ success: true, data: { ...HOUSEHOLD, permissions: ["househelps.view"] }, message: null });
      if (url.endsWith("/categories")) {
        return jsonResponse({
          success: true,
          data: [{ id: "c1", name: "Cleaning", sortOrder: 0, isActive: true }, { id: "c2", name: "Cooking", sortOrder: 1, isActive: true }],
          message: null,
        });
      }
      if (url.includes("/households/h1/househelps")) {
        return jsonResponse({
          success: true,
          data: [
            { id: "hh1", name: "Sunita", phone: null, roleTitle: "Cook", status: "ACTIVE", startDate: null, endDate: null, salaryMode: "FIXED_MONTHLY", monthlySalaryPaise: null, dailyRatePaise: null, halfDayRatePaise: null, salaryDueDay: 1, notes: null, archivedAt: null, categoryIds: ["c1"], createdAt: "2026-01-01T00:00:00.000Z" },
            { id: "hh2", name: "Ramesh", phone: null, roleTitle: "Driver", status: "ACTIVE", startDate: null, endDate: null, salaryMode: "FIXED_MONTHLY", monthlySalaryPaise: null, dailyRatePaise: null, halfDayRatePaise: null, salaryDueDay: 1, notes: null, archivedAt: null, categoryIds: [], createdAt: "2026-01-01T00:00:00.000Z" },
          ],
          message: null,
        });
      }
      throw new Error(`unexpected fetch ${url}`);
    }) as typeof fetch);
    renderPage();
    expect(await screen.findByText("Sunita")).toBeInTheDocument();
    expect(screen.getByText("Cleaning")).toBeInTheDocument();
    expect(screen.queryByText("Cooking")).not.toBeInTheDocument(); // no househelp tagged with it — section omitted
    expect(screen.getByText("Uncategorized")).toBeInTheDocument();
    expect(screen.getByText("Ramesh")).toBeInTheDocument();
    expect(screen.queryByText("Manage categories")).not.toBeInTheDocument(); // gated on categories.manage, not househelps.view
  });
});
