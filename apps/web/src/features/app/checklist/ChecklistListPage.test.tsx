import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { meKey } from "../../auth/session";
import { ChecklistListPage } from "./ChecklistListPage";

const HOUSEHOLD = { id: "h1", name: "Shah Family", timezone: "Asia/Kolkata", role: "OWNER" as const, memberCount: 2 };

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function renderPage() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  qc.setQueryData(meKey, { user: { id: "u1", name: "Parakh", email: "p@example.com", emailVerified: true, createdAt: "2026-01-01T00:00:00.000Z" }, households: [HOUSEHOLD] });
  return render(<QueryClientProvider client={qc}><MemoryRouter><ChecklistListPage /></MemoryRouter></QueryClientProvider>);
}

describe("ChecklistListPage", () => {
  beforeEach(() => { vi.restoreAllMocks(); });

  it("groups tasks by category and puts categoryless ones under Uncategorized", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation((async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/households/h1")) return jsonResponse({ success: true, data: { ...HOUSEHOLD, permissions: ["checklists.view"] }, message: null });
      if (url.endsWith("/categories")) return jsonResponse({ success: true, data: [{ id: "c1", name: "Cleaning", sortOrder: 0, isActive: true }], message: null });
      if (url.includes("/checklist-tasks")) {
        return jsonResponse({
          success: true,
          data: [
            { id: "t1", name: "Sweep floors", description: null, categoryId: "c1", frequency: "DAILY", weekdays: null, dayOfMonth: null, specificDate: null, intervalDays: null, anchorDate: null, preferredTime: null, priority: "NORMAL", sortOrder: 0, isActive: true, archivedAt: null, createdAt: "2026-01-01T00:00:00.000Z" },
            { id: "t2", name: "Pay rent reminder", description: null, categoryId: null, frequency: "MONTHLY", weekdays: null, dayOfMonth: 5, specificDate: null, intervalDays: null, anchorDate: null, preferredTime: null, priority: "HIGH", sortOrder: 1, isActive: true, archivedAt: null, createdAt: "2026-01-01T00:00:00.000Z" },
          ],
          message: null,
        });
      }
      throw new Error(`unexpected fetch ${url}`);
    }) as typeof fetch);
    renderPage();
    expect(await screen.findByText("Sweep floors")).toBeInTheDocument();
    expect(screen.getByText("Cleaning")).toBeInTheDocument();
    expect(screen.getByText("Uncategorized")).toBeInTheDocument();
    expect(screen.getByText("Pay rent reminder")).toBeInTheDocument();
    expect(screen.getByText(/High priority/)).toBeInTheDocument();
  });

  it("hides the add-task action for a VIEWER", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation((async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/households/h1")) return jsonResponse({ success: true, data: { ...HOUSEHOLD, permissions: ["checklists.view"] }, message: null });
      if (url.endsWith("/categories")) return jsonResponse({ success: true, data: [], message: null });
      if (url.includes("/checklist-tasks")) {
        return jsonResponse({ success: true, data: [{ id: "t1", name: "Sweep floors", description: null, categoryId: null, frequency: "DAILY", weekdays: null, dayOfMonth: null, specificDate: null, intervalDays: null, anchorDate: null, preferredTime: null, priority: "NORMAL", sortOrder: 0, isActive: true, archivedAt: null, createdAt: "2026-01-01T00:00:00.000Z" }] });
      }
      throw new Error(`unexpected fetch ${url}`);
    }) as typeof fetch);
    renderPage();
    await screen.findByText("Sweep floors");
    expect(screen.queryByRole("button", { name: /add task/i })).not.toBeInTheDocument();
  });
});
