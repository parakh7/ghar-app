import { describe, expect, it, vi, beforeEach } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { meKey } from "../../auth/session";
import { SettlementDetailPage } from "./SettlementDetailPage";

const HOUSEHOLD = { id: "h1", name: "Shah Family", timezone: "Asia/Kolkata", role: "OWNER" as const, memberCount: 2 };
const SUNITA = { id: "hh1", name: "Sunita", phone: null, roleTitle: null, status: "ACTIVE" as const, startDate: null, endDate: null, salaryMode: "FIXED_MONTHLY" as const, monthlySalaryPaise: 5000000, dailyRatePaise: null, halfDayRatePaise: null, salaryDueDay: 1, allowedLeavesPerMonth: 0, notes: null, archivedAt: null, categoryIds: [], createdAt: "2026-01-01T00:00:00.000Z" };

function settlementDetail(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: "s1", househelpId: "hh1", periodMonth: "2026-10-01", dueDate: "2026-10-05",
    basePaise: 5000000, workingDays: 26, presentDays: 26, halfDays: 0, absentDays: 0, leaveDays: 0, holidayDays: 0,
    absenceDeductionPaise: 0, additionsPaise: 0, deductionsPaise: 0, advancePaise: 0,
    netPayablePaise: 5000000, amountPaidPaise: 0, status: "PENDING" as const, note: null, paidAt: null,
    adjustments: [], payments: [],
    ...overrides,
  };
}

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function renderPage() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  qc.setQueryData(meKey, { user: { id: "u1", name: "Parakh", email: "p@example.com", emailVerified: true, createdAt: "2026-01-01T00:00:00.000Z" }, households: [HOUSEHOLD] });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={["/salary/s1"]}>
        <Routes><Route path="/salary/:id" element={<SettlementDetailPage />} /></Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe("SettlementDetailPage", () => {
  beforeEach(() => { vi.restoreAllMocks(); });

  it("shows the breakdown, adjustments and payments, and hides manage/pay actions for a VIEWER", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation((async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/households/h1")) return jsonResponse({ success: true, data: { ...HOUSEHOLD, permissions: ["salaries.view"] }, message: null });
      if (url.endsWith("/households/h1/salary/settlements/s1")) {
        return jsonResponse({
          success: true,
          data: settlementDetail({
            adjustments: [{ id: "a1", househelpId: "hh1", settlementId: "s1", periodMonth: "2026-10-01", type: "BONUS", amountPaise: 50000, reason: "Diwali bonus", voidedAt: null, createdAt: "2026-10-01T00:00:00.000Z" }],
            payments: [{ id: "p1", settlementId: "s1", amountPaise: 1000000, paidOn: "2026-10-02", method: "CASH", reference: null, notes: null, voidedAt: null, createdAt: "2026-10-02T00:00:00.000Z" }],
          }),
          message: null,
        });
      }
      if (url.endsWith("/households/h1/househelps/hh1")) return jsonResponse({ success: true, data: SUNITA, message: null });
      throw new Error(`unexpected fetch ${url}`);
    }) as typeof fetch);
    renderPage();
    expect(await screen.findByRole("heading", { name: /Sunita/ })).toBeInTheDocument();
    expect(screen.getByText(/Diwali bonus/)).toBeInTheDocument();
    expect(screen.getByText("Pending")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Void" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Add adjustment" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Record payment" })).not.toBeInTheDocument();
  });

  it("records a payment", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation((async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/households/h1")) return jsonResponse({ success: true, data: { ...HOUSEHOLD, permissions: ["salaries.view", "salaries.pay"] }, message: null });
      if (init?.method === "POST" && url.endsWith("/households/h1/salary/settlements/s1/payments")) {
        return jsonResponse({ success: true, data: { id: "p1", settlementId: "s1", amountPaise: 50000, paidOn: "2026-10-02", method: "CASH", reference: null, notes: null, voidedAt: null, createdAt: "2026-10-02T00:00:00.000Z" }, message: null }, 201);
      }
      if (url.endsWith("/households/h1/salary/settlements/s1")) return jsonResponse({ success: true, data: settlementDetail(), message: null });
      if (url.endsWith("/households/h1/househelps/hh1")) return jsonResponse({ success: true, data: SUNITA, message: null });
      throw new Error(`unexpected fetch ${url}`);
    }) as typeof fetch);
    renderPage();
    expect(await screen.findByRole("heading", { name: /Sunita/ })).toBeInTheDocument();
    await userEvent.type(screen.getByLabelText("Amount (₹)"), "500");
    fireEvent.change(screen.getByLabelText("Paid on"), { target: { value: "2026-10-02" } });
    await userEvent.click(screen.getByRole("button", { name: "Record payment" }));
    await waitFor(() => {
      const postCall = fetchSpy.mock.calls.find(([u, i]) => String(u).endsWith("/households/h1/salary/settlements/s1/payments") && (i as RequestInit | undefined)?.method === "POST");
      expect(postCall).toBeDefined();
      const body = JSON.parse((postCall![1] as RequestInit).body as string);
      expect(body).toEqual({ amountPaise: 50000, paidOn: "2026-10-02", method: "CASH" });
    });
  });

  it("adds an adjustment", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation((async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/households/h1")) return jsonResponse({ success: true, data: { ...HOUSEHOLD, permissions: ["salaries.view", "salaries.manage"] }, message: null });
      if (init?.method === "POST" && url.endsWith("/households/h1/househelps/hh1/salary/adjustments")) {
        return jsonResponse({ success: true, data: { id: "a1", househelpId: "hh1", settlementId: "s1", periodMonth: "2026-10-01", type: "OVERTIME", amountPaise: 75000, reason: "Diwali bonus", voidedAt: null, createdAt: "2026-10-01T00:00:00.000Z" }, message: null }, 201);
      }
      if (url.endsWith("/households/h1/salary/settlements/s1")) return jsonResponse({ success: true, data: settlementDetail(), message: null });
      if (url.endsWith("/households/h1/househelps/hh1")) return jsonResponse({ success: true, data: SUNITA, message: null });
      throw new Error(`unexpected fetch ${url}`);
    }) as typeof fetch);
    renderPage();
    expect(await screen.findByRole("heading", { name: /Sunita/ })).toBeInTheDocument();
    await userEvent.selectOptions(screen.getByLabelText("Type"), "OVERTIME");
    const amountField = screen.getByLabelText("Amount (₹)");
    await userEvent.type(amountField, "750");
    await userEvent.type(screen.getByLabelText("Reason (optional)"), "Diwali bonus");
    await userEvent.click(screen.getByRole("button", { name: "Add adjustment" }));
    await waitFor(() => {
      const postCall = fetchSpy.mock.calls.find(([u, i]) => String(u).endsWith("/households/h1/househelps/hh1/salary/adjustments") && (i as RequestInit | undefined)?.method === "POST");
      expect(postCall).toBeDefined();
      const body = JSON.parse((postCall![1] as RequestInit).body as string);
      expect(body).toEqual({ periodMonth: "2026-10-01", type: "OVERTIME", amountPaise: 75000, reason: "Diwali bonus" });
    });
    await waitFor(() => expect(amountField).toHaveValue(""));
  });

  it("disables the add-adjustment form and explains why once the settlement is PARTIALLY_PAID", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation((async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/households/h1")) return jsonResponse({ success: true, data: { ...HOUSEHOLD, permissions: ["salaries.view", "salaries.manage"] }, message: null });
      if (url.endsWith("/households/h1/salary/settlements/s1")) {
        return jsonResponse({ success: true, data: settlementDetail({ status: "PARTIALLY_PAID", amountPaidPaise: 1000000 }), message: null });
      }
      if (url.endsWith("/households/h1/househelps/hh1")) return jsonResponse({ success: true, data: SUNITA, message: null });
      throw new Error(`unexpected fetch ${url}`);
    }) as typeof fetch);
    renderPage();
    expect(await screen.findByRole("heading", { name: /Sunita/ })).toBeInTheDocument();
    expect(screen.getByText(/already partially paid/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Add adjustment" })).toBeDisabled();
    expect(screen.getByLabelText("Amount (₹)")).toBeDisabled();
  });

  it("voids an adjustment", async () => {
    vi.spyOn(window, "confirm").mockReturnValue(true);
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation((async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/households/h1")) return jsonResponse({ success: true, data: { ...HOUSEHOLD, permissions: ["salaries.view", "salaries.manage"] }, message: null });
      if (init?.method === "DELETE" && url.endsWith("/households/h1/salary/adjustments/a1")) return jsonResponse({ success: true, data: null, message: null });
      if (url.endsWith("/households/h1/salary/settlements/s1")) {
        return jsonResponse({
          success: true,
          data: settlementDetail({ adjustments: [{ id: "a1", househelpId: "hh1", settlementId: "s1", periodMonth: "2026-10-01", type: "BONUS", amountPaise: 50000, reason: "Diwali bonus", voidedAt: null, createdAt: "2026-10-01T00:00:00.000Z" }] }),
          message: null,
        });
      }
      if (url.endsWith("/households/h1/househelps/hh1")) return jsonResponse({ success: true, data: SUNITA, message: null });
      throw new Error(`unexpected fetch ${url}`);
    }) as typeof fetch);
    renderPage();
    expect(await screen.findByText(/Diwali bonus/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Void" }));
    await waitFor(() => {
      const delCall = fetchSpy.mock.calls.find(([u, i]) => String(u).endsWith("/households/h1/salary/adjustments/a1") && (i as RequestInit | undefined)?.method === "DELETE");
      expect(delCall).toBeDefined();
    });
  });
});
