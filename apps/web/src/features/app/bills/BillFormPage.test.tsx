import { describe, expect, it, vi, beforeEach } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { meKey } from "../../auth/session";
import { BillFormPage } from "./BillFormPage";

const HOUSEHOLD = { id: "h1", name: "Shah Family", timezone: "Asia/Kolkata", role: "OWNER" as const, memberCount: 2 };

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function renderPage() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  qc.setQueryData(meKey, { user: { id: "u1", name: "Parakh", email: "p@example.com", emailVerified: true, createdAt: "2026-01-01T00:00:00.000Z" }, households: [HOUSEHOLD] });
  return render(<QueryClientProvider client={qc}><MemoryRouter><BillFormPage mode="create" /></MemoryRouter></QueryClientProvider>);
}

describe("BillFormPage — create mode", () => {
  beforeEach(() => { vi.restoreAllMocks(); });

  it("switching frequency to Custom reveals the interval fields, and submits with a variable (blank) amount", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation((async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/households/h1")) return jsonResponse({ success: true, data: { ...HOUSEHOLD, permissions: ["bills.manage"] }, message: null });
      if (url.endsWith("/bill-categories")) return jsonResponse({ success: true, data: [], message: null });
      if (init?.method === "POST" && url.endsWith("/bills")) return jsonResponse({ success: true, data: { id: "bill1" }, message: null }, 201);
      throw new Error(`unexpected fetch ${url}`);
    }) as typeof fetch);
    renderPage();
    await userEvent.type(await screen.findByLabelText("Name"), "Gym membership");
    await userEvent.selectOptions(screen.getByLabelText("Repeats"), "CUSTOM");
    expect(screen.getByLabelText("Repeat every")).toBeInTheDocument();
    await userEvent.clear(screen.getByLabelText("Repeat every"));
    await userEvent.type(screen.getByLabelText("Repeat every"), "2");
    await userEvent.selectOptions(screen.getByLabelText("Interval unit"), "week");
    fireEvent.change(screen.getByLabelText("First due date"), { target: { value: "2026-10-10" } });
    await userEvent.click(screen.getByRole("button", { name: /add bill/i }));
    const postCall = fetchSpy.mock.calls.find(([u, init]) => String(u).endsWith("/bills") && (init as RequestInit | undefined)?.method === "POST");
    expect(postCall).toBeDefined();
    const body = JSON.parse((postCall![1] as RequestInit).body as string);
    expect(body).toMatchObject({ name: "Gym membership", frequency: "CUSTOM", intervalCount: 2, intervalUnit: "week", amountPaise: null, firstDueDate: "2026-10-10" });
  });

  it("rejects submitting an invalid amount", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation((async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/households/h1")) return jsonResponse({ success: true, data: { ...HOUSEHOLD, permissions: ["bills.manage"] }, message: null });
      if (url.endsWith("/bill-categories")) return jsonResponse({ success: true, data: [], message: null });
      throw new Error(`unexpected fetch ${url}`);
    }) as typeof fetch);
    renderPage();
    await userEvent.type(await screen.findByLabelText("Name"), "Broadband");
    await userEvent.type(screen.getByLabelText("Amount (₹)"), "not-a-number");
    fireEvent.change(screen.getByLabelText("First due date"), { target: { value: "2026-10-10" } });
    await userEvent.click(screen.getByRole("button", { name: /add bill/i }));
    expect((await screen.findAllByText(/leave blank for a variable amount/i)).length).toBeGreaterThan(1);
  });
});
