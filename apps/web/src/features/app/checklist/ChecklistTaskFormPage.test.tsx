import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { meKey } from "../../auth/session";
import { ChecklistTaskFormPage } from "./ChecklistTaskFormPage";

const HOUSEHOLD = { id: "h1", name: "Shah Family", timezone: "Asia/Kolkata", role: "OWNER" as const, memberCount: 2 };

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function renderPage() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  qc.setQueryData(meKey, { user: { id: "u1", name: "Parakh", email: "p@example.com", emailVerified: true, createdAt: "2026-01-01T00:00:00.000Z" }, households: [HOUSEHOLD] });
  return render(<QueryClientProvider client={qc}><MemoryRouter><ChecklistTaskFormPage mode="create" /></MemoryRouter></QueryClientProvider>);
}

describe("ChecklistTaskFormPage — create mode", () => {
  beforeEach(() => { vi.restoreAllMocks(); });

  it("switching frequency to Weekly reveals the weekday picker, and submits the picked days", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation((async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/households/h1")) return jsonResponse({ success: true, data: { ...HOUSEHOLD, permissions: ["checklists.manage"] }, message: null });
      if (url.endsWith("/categories")) return jsonResponse({ success: true, data: [], message: null });
      if (init?.method === "POST" && url.endsWith("/checklist-tasks")) return jsonResponse({ success: true, data: { id: "t1" }, message: null }, 201);
      throw new Error(`unexpected fetch ${url}`);
    }) as typeof fetch);
    renderPage();
    await userEvent.type(await screen.findByLabelText("Name"), "Water plants");
    await userEvent.selectOptions(screen.getByLabelText("Repeats"), "WEEKLY");
    await userEvent.click(screen.getByRole("button", { name: "Monday" }));
    await userEvent.click(screen.getByRole("button", { name: "Wednesday" }));
    await userEvent.click(screen.getByRole("button", { name: /add task/i }));
    const postCall = fetchSpy.mock.calls.find(([u, init]) => String(u).endsWith("/checklist-tasks") && (init as RequestInit | undefined)?.method === "POST");
    expect(postCall).toBeDefined();
    const body = JSON.parse((postCall![1] as RequestInit).body as string);
    expect(body).toMatchObject({ name: "Water plants", frequency: "WEEKLY", weekdays: [1, 3] });
  });

  it("rejects submitting a Monthly task with no day of month picked", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation((async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/households/h1")) return jsonResponse({ success: true, data: { ...HOUSEHOLD, permissions: ["checklists.manage"] }, message: null });
      if (url.endsWith("/categories")) return jsonResponse({ success: true, data: [], message: null });
      throw new Error(`unexpected fetch ${url}`);
    }) as typeof fetch);
    renderPage();
    await userEvent.type(await screen.findByLabelText("Name"), "Pay rent reminder");
    await userEvent.selectOptions(screen.getByLabelText("Repeats"), "MONTHLY");
    await userEvent.clear(screen.getByLabelText("Day of month"));
    await userEvent.click(screen.getByRole("button", { name: /add task/i }));
    expect(await screen.findByText(/give the day of the month/i)).toBeInTheDocument();
  });
});
