import { describe, expect, it, vi, beforeEach } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { meKey } from "../../auth/session";
import { SalaryListPage } from "./SalaryListPage";

const HOUSEHOLD = { id: "h1", name: "Shah Family", timezone: "Asia/Kolkata", role: "OWNER" as const, memberCount: 2 };
const SUNITA = { id: "hh1", name: "Sunita", phone: null, roleTitle: null, status: "ACTIVE" as const, startDate: null, endDate: null, salaryMode: "FIXED_MONTHLY" as const, monthlySalaryPaise: 5000000, dailyRatePaise: null, halfDayRatePaise: null, salaryDueDay: 1, notes: null, archivedAt: null, categoryIds: [], createdAt: "2026-01-01T00:00:00.000Z" };
const SETTLEMENT = {
  id: "s1", househelpId: "hh1", periodMonth: "2026-09-01", dueDate: "2026-09-05",
  basePaise: 5000000, workingDays: 26, presentDays: 26, halfDays: 0, absentDays: 0, leaveDays: 0, holidayDays: 0,
  absenceDeductionPaise: 0, additionsPaise: 0, deductionsPaise: 0, advancePaise: 0,
  netPayablePaise: 5000000, amountPaidPaise: 0, status: "PENDING" as const, note: null, paidAt: null,
};

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function renderPage() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  qc.setQueryData(meKey, { user: { id: "u1", name: "Parakh", email: "p@example.com", emailVerified: true, createdAt: "2026-01-01T00:00:00.000Z" }, households: [HOUSEHOLD] });
  return render(<QueryClientProvider client={qc}><MemoryRouter><SalaryListPage /></MemoryRouter></QueryClientProvider>);
}

describe("SalaryListPage", () => {
  beforeEach(() => { vi.restoreAllMocks(); });

  it("lists a househelp's settlements with a status badge, and hides Generate for a VIEWER", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation((async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/households/h1")) return jsonResponse({ success: true, data: { ...HOUSEHOLD, permissions: ["salaries.view"] }, message: null });
      if (url.endsWith("/households/h1/househelps")) return jsonResponse({ success: true, data: [SUNITA], message: null });
      if (url.endsWith("/households/h1/househelps/hh1/salary/settlements")) return jsonResponse({ success: true, data: [SETTLEMENT], message: null });
      throw new Error(`unexpected fetch ${url}`);
    }) as typeof fetch);
    renderPage();
    expect(await screen.findByText("Sunita")).toBeInTheDocument();
    expect(await screen.findByText("September 2026")).toBeInTheDocument();
    expect(screen.getByText("Pending")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /generate settlement/i })).not.toBeInTheDocument();
  });

  it("generates a settlement for the selected househelp and month", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation((async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/households/h1")) return jsonResponse({ success: true, data: { ...HOUSEHOLD, permissions: ["salaries.view", "salaries.manage"] }, message: null });
      if (url.endsWith("/households/h1/househelps")) return jsonResponse({ success: true, data: [SUNITA], message: null });
      if (init?.method === "POST" && url.endsWith("/households/h1/househelps/hh1/salary/settlements")) {
        return jsonResponse({ success: true, data: { ...SETTLEMENT, id: "s2", periodMonth: "2026-11-01" }, message: null }, 200);
      }
      if (url.endsWith("/households/h1/househelps/hh1/salary/settlements")) return jsonResponse({ success: true, data: [], message: null });
      throw new Error(`unexpected fetch ${url}`);
    }) as typeof fetch);
    renderPage();
    expect(await screen.findByRole("heading", { name: "Sunita" })).toBeInTheDocument();
    const monthInput = screen.getByLabelText("Month");
    fireEvent.change(monthInput, { target: { value: "2026-11" } });
    await userEvent.click(screen.getByRole("button", { name: "Generate settlement" }));
    await waitFor(() => {
      const postCall = fetchSpy.mock.calls.find(([u, i]) => String(u).endsWith("/households/h1/househelps/hh1/salary/settlements") && (i as RequestInit | undefined)?.method === "POST");
      expect(postCall).toBeDefined();
      const body = JSON.parse((postCall![1] as RequestInit).body as string);
      expect(body).toEqual({ periodMonth: "2026-11-01" });
    });
  });
});
