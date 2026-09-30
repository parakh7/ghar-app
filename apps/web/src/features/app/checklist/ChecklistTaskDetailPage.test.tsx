import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { meKey } from "../../auth/session";
import { ChecklistTaskDetailPage } from "./ChecklistTaskDetailPage";

const HOUSEHOLD = { id: "h1", name: "Shah Family", timezone: "Asia/Kolkata", role: "OWNER" as const, memberCount: 2 };
const TASK = { id: "t1", name: "Sweep floors", description: null, categoryId: null, frequency: "DAILY" as const, weekdays: null, dayOfMonth: null, specificDate: null, intervalDays: null, anchorDate: null, preferredTime: null, priority: "NORMAL" as const, sortOrder: 0, isActive: true, archivedAt: null, createdAt: "2026-01-01T00:00:00.000Z" };
const SUNITA = { id: "hh1", name: "Sunita", phone: null, roleTitle: null, status: "ACTIVE" as const, startDate: null, endDate: null, salaryMode: "FIXED_MONTHLY" as const, monthlySalaryPaise: null, dailyRatePaise: null, halfDayRatePaise: null, salaryDueDay: 1, notes: null, archivedAt: null, categoryIds: [], createdAt: "2026-01-01T00:00:00.000Z" };

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function renderPage() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  qc.setQueryData(meKey, { user: { id: "u1", name: "Parakh", email: "p@example.com", emailVerified: true, createdAt: "2026-01-01T00:00:00.000Z" }, households: [HOUSEHOLD] });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={["/checklist/t1"]}>
        <Routes><Route path="/checklist/:id" element={<ChecklistTaskDetailPage />} /></Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe("ChecklistTaskDetailPage", () => {
  beforeEach(() => { vi.restoreAllMocks(); });

  it("toggles a househelp and saves the assignment", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation((async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/households/h1")) return jsonResponse({ success: true, data: { ...HOUSEHOLD, permissions: ["checklists.manage"] }, message: null });
      if (url.endsWith("/checklist-tasks/t1")) return jsonResponse({ success: true, data: TASK, message: null });
      if (url.endsWith("/checklist-tasks/t1/assignments") && (!init || init.method === undefined)) return jsonResponse({ success: true, data: [], message: null });
      if (init?.method === "PUT" && url.endsWith("/assignments")) return jsonResponse({ success: true, data: ["hh1"], message: null });
      if (url.includes("/househelps")) return jsonResponse({ success: true, data: [SUNITA], message: null });
      throw new Error(`unexpected fetch ${url}`);
    }) as typeof fetch);
    renderPage();
    await screen.findByText("Sweep floors");
    await userEvent.click(screen.getByRole("button", { name: "Sunita" }));
    await userEvent.click(screen.getByRole("button", { name: "Save assignment" }));
    const putCall = fetchSpy.mock.calls.find(([u, init]) => String(u).endsWith("/assignments") && (init as RequestInit | undefined)?.method === "PUT");
    expect(putCall).toBeDefined();
    const body = JSON.parse((putCall![1] as RequestInit).body as string);
    expect(body).toEqual({ househelpIds: ["hh1"] });
  });
});
