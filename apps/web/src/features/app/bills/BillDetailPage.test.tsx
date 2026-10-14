import { describe, expect, it, vi, beforeEach } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
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

const VARIABLE_BILL = { ...ACTIVE_BILL, amountPaise: null };

const PENDING_OCCURRENCE = {
  id: "occ1", billId: "b1", sequence: 1, dueDate: "2026-10-05",
  amountDuePaise: 150000, amountPaidPaise: 0, status: "PENDING" as const,
  paidAt: null, waivedAt: null, createdAt: "2026-01-01T00:00:00.000Z",
};

const WAIVED_OCCURRENCE = { ...PENDING_OCCURRENCE, status: "WAIVED" as const, waivedAt: "2026-10-01T00:00:00.000Z" };

const ACTIVE_PAYMENT = {
  id: "p1", occurrenceId: "occ1", amountPaise: 150000, paidOn: "2026-10-05", method: "CASH" as const,
  transactionRef: null, notes: null, voidedAt: null, voidReason: null, createdAt: "2026-10-05T00:00:00.000Z",
};

const VOIDED_PAYMENT = {
  id: "p2", occurrenceId: "occ1", amountPaise: 50000, paidOn: "2026-10-03", method: "UPI" as const,
  transactionRef: null, notes: null, voidedAt: "2026-10-04T00:00:00.000Z", voidReason: "Entered twice", createdAt: "2026-10-03T00:00:00.000Z",
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
      if (init?.method === "POST" && url.endsWith("/bills/b1/occurrences/sync")) return jsonResponse({ success: true, data: [PENDING_OCCURRENCE], message: null });
      if (url.endsWith("/bills/b1/occurrences")) return jsonResponse({ success: true, data: [PENDING_OCCURRENCE], message: null });
      if (init?.method === "POST" && url.endsWith("/bills/b1/pause")) return jsonResponse({ success: true, data: null, message: null });
      throw new Error(`unexpected fetch ${url}`);
    }) as typeof fetch);
    renderPage();
    await screen.findByText("Electricity");
    expect(screen.getByText("Active")).toBeInTheDocument();
    expect(screen.getByText("BESCOM")).toBeInTheDocument();
    expect((await screen.findAllByText("2026-10-05")).length).toBeGreaterThanOrEqual(2);
    expect(screen.getAllByText("₹1,500").length).toBeGreaterThanOrEqual(2);
    expect(screen.getByText("Pending")).toBeInTheDocument();
    const syncCall = fetchSpy.mock.calls.find(([u, i]) => String(u).endsWith("/bills/b1/occurrences/sync") && (i as RequestInit | undefined)?.method === "POST");
    expect(syncCall).toBeDefined();
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
      if (init?.method === "POST" && url.endsWith("/bills/b1/occurrences/sync")) return jsonResponse({ success: true, data: [], message: null });
      if (url.endsWith("/bills/b1/occurrences")) return jsonResponse({ success: true, data: [], message: null });
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
      if (url.endsWith("/bills/b1/occurrences/sync")) return jsonResponse({ success: true, data: [], message: null });
      if (url.endsWith("/bills/b1/occurrences")) return jsonResponse({ success: true, data: [], message: null });
      throw new Error(`unexpected fetch ${url}`);
    }) as typeof fetch);
    renderPage();
    await screen.findByText("Electricity");
    expect(screen.queryByRole("button", { name: "Pause" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Edit details" })).not.toBeInTheDocument();
  });

  it("lets a manager set a variable-amount bill's pending occurrence amount", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation((async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/households/h1")) return jsonResponse({ success: true, data: { ...HOUSEHOLD, permissions: ["bills.view", "bills.manage"] }, message: null });
      if (url.endsWith("/bill-categories")) return jsonResponse({ success: true, data: [], message: null });
      if (url.endsWith("/bills/b1")) return jsonResponse({ success: true, data: VARIABLE_BILL, message: null });
      if (init?.method === "POST" && url.endsWith("/bills/b1/occurrences/sync")) return jsonResponse({ success: true, data: [PENDING_OCCURRENCE], message: null });
      if (init?.method === "GET" && url.endsWith("/bills/b1/occurrences")) return jsonResponse({ success: true, data: [PENDING_OCCURRENCE], message: null });
      if (init?.method === "PATCH" && url.endsWith("/bills/b1/occurrences/occ1")) {
        return jsonResponse({ success: true, data: { ...PENDING_OCCURRENCE, amountDuePaise: 175000 }, message: "Occurrence updated." });
      }
      throw new Error(`unexpected fetch ${url}`);
    }) as typeof fetch);
    renderPage();
    await screen.findByText("Electricity");
    expect(screen.getByText("Variable amount")).toBeInTheDocument();
    await userEvent.click(await screen.findByRole("button", { name: "Set amount" }));
    const amountField = screen.getByLabelText("Amount due (₹)");
    await userEvent.clear(amountField);
    await userEvent.type(amountField, "1750");
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    const patchCall = fetchSpy.mock.calls.find(([u, i]) => String(u).endsWith("/bills/b1/occurrences/occ1") && (i as RequestInit | undefined)?.method === "PATCH");
    expect(patchCall).toBeDefined();
    const body = JSON.parse((patchCall![1] as RequestInit).body as string);
    expect(body).toEqual({ amountDuePaise: 175000 });
  });

  it("hides the set-amount action for a viewer without bills.manage", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation((async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/households/h1")) return jsonResponse({ success: true, data: { ...HOUSEHOLD, permissions: ["bills.view"] }, message: null });
      if (url.endsWith("/bill-categories")) return jsonResponse({ success: true, data: [], message: null });
      if (url.endsWith("/bills/b1")) return jsonResponse({ success: true, data: VARIABLE_BILL, message: null });
      if (init?.method === "POST" && url.endsWith("/bills/b1/occurrences/sync")) return jsonResponse({ success: true, data: [PENDING_OCCURRENCE], message: null });
      if (url.endsWith("/bills/b1/occurrences")) return jsonResponse({ success: true, data: [PENDING_OCCURRENCE], message: null });
      throw new Error(`unexpected fetch ${url}`);
    }) as typeof fetch);
    renderPage();
    await screen.findByText("Electricity");
    await screen.findAllByText("2026-10-05");
    expect(screen.queryByRole("button", { name: "Set amount" })).not.toBeInTheDocument();
  });

  it("records a payment against a pending occurrence", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation((async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/households/h1")) return jsonResponse({ success: true, data: { ...HOUSEHOLD, permissions: ["bills.view", "payments.record"] }, message: null });
      if (url.endsWith("/bill-categories")) return jsonResponse({ success: true, data: [], message: null });
      if (url.endsWith("/bills/b1")) return jsonResponse({ success: true, data: ACTIVE_BILL, message: null });
      if (init?.method === "POST" && url.endsWith("/bills/b1/occurrences/sync")) return jsonResponse({ success: true, data: [PENDING_OCCURRENCE], message: null });
      if (init?.method === "GET" && url.endsWith("/occurrences/occ1/payments")) return jsonResponse({ success: true, data: [], message: null });
      if (init?.method === "POST" && url.endsWith("/occurrences/occ1/payments")) {
        return jsonResponse({ success: true, data: { ...ACTIVE_PAYMENT }, message: null }, 201);
      }
      throw new Error(`unexpected fetch ${url}`);
    }) as typeof fetch);
    renderPage();
    await screen.findByText("Electricity");
    await userEvent.click(await screen.findByRole("button", { name: "Record payment" }));
    await userEvent.type(screen.getByLabelText("Amount (₹)"), "1500");
    fireEvent.change(screen.getByLabelText("Paid on"), { target: { value: "2026-10-05" } });
    await userEvent.click(screen.getByRole("button", { name: "Record payment" }));
    await waitFor(() => {
      const postCall = fetchSpy.mock.calls.find(([u, i]) => String(u).endsWith("/occurrences/occ1/payments") && (i as RequestInit | undefined)?.method === "POST");
      expect(postCall).toBeDefined();
      const body = JSON.parse((postCall![1] as RequestInit).body as string);
      expect(body).toEqual({ amountPaise: 150000, paidOn: "2026-10-05", method: "CASH" });
    });
  });

  it("voids an active payment", async () => {
    vi.spyOn(window, "prompt").mockReturnValue("");
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation((async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/households/h1")) return jsonResponse({ success: true, data: { ...HOUSEHOLD, permissions: ["bills.view", "payments.record"] }, message: null });
      if (url.endsWith("/bill-categories")) return jsonResponse({ success: true, data: [], message: null });
      if (url.endsWith("/bills/b1")) return jsonResponse({ success: true, data: ACTIVE_BILL, message: null });
      if (init?.method === "POST" && url.endsWith("/bills/b1/occurrences/sync")) return jsonResponse({ success: true, data: [PENDING_OCCURRENCE], message: null });
      if (init?.method === "GET" && url.endsWith("/occurrences/occ1/payments")) return jsonResponse({ success: true, data: [ACTIVE_PAYMENT], message: null });
      if (init?.method === "DELETE" && url.endsWith("/occurrences/occ1/payments/p1")) return jsonResponse({ success: true, data: null, message: null });
      throw new Error(`unexpected fetch ${url}`);
    }) as typeof fetch);
    renderPage();
    await screen.findByText("Electricity");
    await userEvent.click(await screen.findByRole("button", { name: "Void" }));
    await waitFor(() => {
      const delCall = fetchSpy.mock.calls.find(([u, i]) => String(u).endsWith("/occurrences/occ1/payments/p1") && (i as RequestInit | undefined)?.method === "DELETE");
      expect(delCall).toBeDefined();
    });
  });

  it("waives a pending occurrence", async () => {
    vi.spyOn(window, "prompt").mockReturnValue("Tenant moved out");
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation((async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/households/h1")) return jsonResponse({ success: true, data: { ...HOUSEHOLD, permissions: ["bills.view", "bills.manage"] }, message: null });
      if (url.endsWith("/bill-categories")) return jsonResponse({ success: true, data: [], message: null });
      if (url.endsWith("/bills/b1")) return jsonResponse({ success: true, data: ACTIVE_BILL, message: null });
      if (init?.method === "POST" && url.endsWith("/bills/b1/occurrences/sync")) return jsonResponse({ success: true, data: [PENDING_OCCURRENCE], message: null });
      if (init?.method === "GET" && url.endsWith("/occurrences/occ1/payments")) return jsonResponse({ success: true, data: [], message: null });
      if (init?.method === "POST" && url.endsWith("/occurrences/occ1/waive")) {
        return jsonResponse({ success: true, data: { ...WAIVED_OCCURRENCE }, message: null });
      }
      throw new Error(`unexpected fetch ${url}`);
    }) as typeof fetch);
    renderPage();
    await screen.findByText("Electricity");
    await userEvent.click(await screen.findByRole("button", { name: "Waive" }));
    await waitFor(() => {
      const waiveCall = fetchSpy.mock.calls.find(([u, i]) => String(u).endsWith("/occurrences/occ1/waive") && (i as RequestInit | undefined)?.method === "POST");
      expect(waiveCall).toBeDefined();
      const body = JSON.parse((waiveCall![1] as RequestInit).body as string);
      expect(body).toEqual({ reason: "Tenant moved out" });
    });
  });

  it("unwaives a waived occurrence and hides the payment action while waived", async () => {
    vi.spyOn(window, "confirm").mockReturnValue(true);
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation((async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/households/h1")) return jsonResponse({ success: true, data: { ...HOUSEHOLD, permissions: ["bills.view", "bills.manage", "payments.record"] }, message: null });
      if (url.endsWith("/bill-categories")) return jsonResponse({ success: true, data: [], message: null });
      if (url.endsWith("/bills/b1")) return jsonResponse({ success: true, data: ACTIVE_BILL, message: null });
      if (init?.method === "POST" && url.endsWith("/bills/b1/occurrences/sync")) return jsonResponse({ success: true, data: [WAIVED_OCCURRENCE], message: null });
      if (init?.method === "GET" && url.endsWith("/occurrences/occ1/payments")) return jsonResponse({ success: true, data: [], message: null });
      if (init?.method === "POST" && url.endsWith("/occurrences/occ1/unwaive")) {
        return jsonResponse({ success: true, data: { ...PENDING_OCCURRENCE }, message: null });
      }
      throw new Error(`unexpected fetch ${url}`);
    }) as typeof fetch);
    renderPage();
    await screen.findByText("Electricity");
    expect(await screen.findByText("Waived")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Record payment" })).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Unwaive" }));
    await waitFor(() => {
      const unwaiveCall = fetchSpy.mock.calls.find(([u, i]) => String(u).endsWith("/occurrences/occ1/unwaive") && (i as RequestInit | undefined)?.method === "POST");
      expect(unwaiveCall).toBeDefined();
    });
  });

  it("shows a voided payment labeled as voided without hiding it, alongside an active payment with a Void button", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation((async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/households/h1")) return jsonResponse({ success: true, data: { ...HOUSEHOLD, permissions: ["bills.view", "payments.record"] }, message: null });
      if (url.endsWith("/bill-categories")) return jsonResponse({ success: true, data: [], message: null });
      if (url.endsWith("/bills/b1")) return jsonResponse({ success: true, data: ACTIVE_BILL, message: null });
      if (init?.method === "POST" && url.endsWith("/bills/b1/occurrences/sync")) return jsonResponse({ success: true, data: [PENDING_OCCURRENCE], message: null });
      if (init?.method === "GET" && url.endsWith("/occurrences/occ1/payments")) return jsonResponse({ success: true, data: [ACTIVE_PAYMENT, VOIDED_PAYMENT], message: null });
      throw new Error(`unexpected fetch ${url}`);
    }) as typeof fetch);
    renderPage();
    await screen.findByText("Electricity");
    expect(await screen.findByText(/₹500 · UPI \(voided\)/)).toBeInTheDocument();
    expect(screen.getByText(/₹1,500 · Cash$/)).toBeInTheDocument();
    // Only the still-active payment gets a Void button — the voided one shows no action.
    expect(screen.getAllByRole("button", { name: "Void" })).toHaveLength(1);
  });

  it("shows an error indicator when the per-occurrence payment history fails to load", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation((async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/households/h1")) return jsonResponse({ success: true, data: { ...HOUSEHOLD, permissions: ["bills.view", "payments.record"] }, message: null });
      if (url.endsWith("/bill-categories")) return jsonResponse({ success: true, data: [], message: null });
      if (url.endsWith("/bills/b1")) return jsonResponse({ success: true, data: ACTIVE_BILL, message: null });
      if (init?.method === "POST" && url.endsWith("/bills/b1/occurrences/sync")) return jsonResponse({ success: true, data: [PENDING_OCCURRENCE], message: null });
      if (init?.method === "GET" && url.endsWith("/occurrences/occ1/payments")) return jsonResponse({ success: false, error: { code: "INTERNAL_ERROR", message: "Boom" } }, 500);
      throw new Error(`unexpected fetch ${url}`);
    }) as typeof fetch);
    renderPage();
    await screen.findByText("Electricity");
    expect(await screen.findByText(/Couldn't load payment history/)).toBeInTheDocument();
  });

  it("hides payment-record, void and waive actions for a viewer without payments.record/bills.manage", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation((async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/households/h1")) return jsonResponse({ success: true, data: { ...HOUSEHOLD, permissions: ["bills.view"] }, message: null });
      if (url.endsWith("/bill-categories")) return jsonResponse({ success: true, data: [], message: null });
      if (url.endsWith("/bills/b1")) return jsonResponse({ success: true, data: ACTIVE_BILL, message: null });
      if (init?.method === "POST" && url.endsWith("/bills/b1/occurrences/sync")) return jsonResponse({ success: true, data: [PENDING_OCCURRENCE], message: null });
      if (init?.method === "GET" && url.endsWith("/occurrences/occ1/payments")) return jsonResponse({ success: true, data: [ACTIVE_PAYMENT], message: null });
      throw new Error(`unexpected fetch ${url}`);
    }) as typeof fetch);
    renderPage();
    await screen.findByText("Electricity");
    await screen.findByText(/Cash/);
    expect(screen.queryByRole("button", { name: "Record payment" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Void" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Waive" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Unwaive" })).not.toBeInTheDocument();
  });

  it("truncates long bill notes and the combined payment line with a title tooltip", async () => {
    const LONG_NOTE = "Call the provider before the 5th if the smart meter reading looks unusually high this month";
    vi.spyOn(globalThis, "fetch").mockImplementation((async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/households/h1")) return jsonResponse({ success: true, data: { ...HOUSEHOLD, permissions: ["bills.view", "bills.manage"] }, message: null });
      if (url.endsWith("/bill-categories")) return jsonResponse({ success: true, data: [], message: null });
      if (url.endsWith("/bills/b1")) return jsonResponse({ success: true, data: { ...ACTIVE_BILL, notes: LONG_NOTE }, message: null });
      if (init?.method === "POST" && url.endsWith("/bills/b1/occurrences/sync")) return jsonResponse({ success: true, data: [PENDING_OCCURRENCE], message: null });
      if (url.endsWith("/bills/b1/occurrences")) return jsonResponse({ success: true, data: [PENDING_OCCURRENCE], message: null });
      if (init?.method === "GET" && url.endsWith("/occurrences/occ1/payments")) {
        return jsonResponse({ success: true, data: [{ ...ACTIVE_PAYMENT, transactionRef: "UPI-REF-00123456789", notes: LONG_NOTE }], message: null });
      }
      throw new Error(`unexpected fetch ${url}`);
    }) as typeof fetch);
    renderPage();
    const noteEl = await screen.findByText(LONG_NOTE);
    expect(noteEl).toHaveClass("list__meta--truncate");
    expect(noteEl).toHaveAttribute("title", LONG_NOTE);
    const expectedPaymentLine = `2026-10-05 · UPI-REF-00123456789 · ${LONG_NOTE}`;
    const paymentLineEl = await screen.findByText(expectedPaymentLine);
    expect(paymentLineEl).toHaveClass("list__meta--truncate");
    expect(paymentLineEl).toHaveAttribute("title", expectedPaymentLine);
  });
});
