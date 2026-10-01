import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { meKey } from "../../auth/session";
import { ChecklistTodayPage } from "./ChecklistTodayPage";

const HOUSEHOLD = { id: "h1", name: "Shah Family", timezone: "Asia/Kolkata", role: "OWNER" as const, memberCount: 2 };

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function renderPage() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  qc.setQueryData(meKey, { user: { id: "u1", name: "Parakh", email: "p@example.com", emailVerified: true, createdAt: "2026-01-01T00:00:00.000Z" }, households: [HOUSEHOLD] });
  return render(<QueryClientProvider client={qc}><MemoryRouter><ChecklistTodayPage /></MemoryRouter></QueryClientProvider>);
}

describe("ChecklistTodayPage", () => {
  beforeEach(() => { vi.restoreAllMocks(); });
  afterEach(() => { vi.restoreAllMocks(); });

  it("marks an unmarked task Completed on tap", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation((async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/households/h1")) return jsonResponse({ success: true, data: { ...HOUSEHOLD, permissions: ["checklists.view", "checklists.complete"] }, message: null });
      if (init?.method === "PUT" && url.includes("/checklist/t1/completion")) return jsonResponse({ success: true, data: { date: "2026-09-30", status: "COMPLETED", note: null }, message: null });
      if (url.endsWith("/checklist/today")) {
        return jsonResponse({ success: true, data: { date: "2026-09-30", entries: [{ taskId: "t1", name: "Wash dishes", status: null, note: null }] } }, 200);
      }
      throw new Error(`unexpected fetch ${url}`);
    }) as typeof fetch);
    renderPage();
    const row = await screen.findByText("Wash dishes");
    await userEvent.click(row);
    const putCall = fetchSpy.mock.calls.find(([u, init]) => String(u).includes("/checklist/t1/completion") && (init as RequestInit | undefined)?.method === "PUT");
    expect(putCall).toBeDefined();
    const body = JSON.parse((putCall![1] as RequestInit).body as string);
    expect(body).toEqual({ date: "2026-09-30", status: "COMPLETED" });
  });

  it("marks an unmarked task Skipped via the Skip action", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation((async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/households/h1")) return jsonResponse({ success: true, data: { ...HOUSEHOLD, permissions: ["checklists.view", "checklists.complete"] }, message: null });
      if (init?.method === "PUT" && url.includes("/checklist/t1/completion")) return jsonResponse({ success: true, data: { date: "2026-09-30", status: "SKIPPED", note: null }, message: null });
      if (url.endsWith("/checklist/today")) {
        return jsonResponse({ success: true, data: { date: "2026-09-30", entries: [{ taskId: "t1", name: "Wash dishes", status: null, note: null }] } }, 200);
      }
      throw new Error(`unexpected fetch ${url}`);
    }) as typeof fetch);
    renderPage();
    await screen.findByText("Wash dishes");
    await userEvent.click(screen.getByRole("button", { name: "Skip" }));
    const putCall = fetchSpy.mock.calls.find(([u, init]) => String(u).includes("/checklist/t1/completion") && (init as RequestInit | undefined)?.method === "PUT");
    expect(putCall).toBeDefined();
    const body = JSON.parse((putCall![1] as RequestInit).body as string);
    expect(body).toEqual({ date: "2026-09-30", status: "SKIPPED" });
  });

  it("clears a marked task via the badge tap", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation((async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/households/h1")) return jsonResponse({ success: true, data: { ...HOUSEHOLD, permissions: ["checklists.view", "checklists.complete"] }, message: null });
      if (init?.method === "DELETE" && url.includes("/checklist/t1/completion")) return jsonResponse({ success: true, data: null, message: null });
      if (url.endsWith("/checklist/today")) {
        return jsonResponse({ success: true, data: { date: "2026-09-30", entries: [{ taskId: "t1", name: "Wash dishes", status: "COMPLETED", note: null }] } }, 200);
      }
      throw new Error(`unexpected fetch ${url}`);
    }) as typeof fetch);
    renderPage();
    await screen.findByText("Wash dishes");
    await userEvent.click(screen.getByRole("button", { name: "Done" }));
    const delCall = fetchSpy.mock.calls.find(([u, init]) => String(u).includes("/checklist/t1/completion") && (init as RequestInit | undefined)?.method === "DELETE");
    expect(delCall).toBeDefined();
    expect(String(delCall![0])).toContain("date=2026-09-30");
  });

  it("opens the picker and sets Skipped explicitly", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation((async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/households/h1")) return jsonResponse({ success: true, data: { ...HOUSEHOLD, permissions: ["checklists.view", "checklists.complete"] }, message: null });
      if (init?.method === "PUT" && url.includes("/checklist/t1/completion")) return jsonResponse({ success: true, data: { date: "2026-09-30", status: "SKIPPED", note: null }, message: null });
      if (url.endsWith("/checklist/today")) {
        return jsonResponse({ success: true, data: { date: "2026-09-30", entries: [{ taskId: "t1", name: "Wash dishes", status: "COMPLETED", note: null }] } }, 200);
      }
      throw new Error(`unexpected fetch ${url}`);
    }) as typeof fetch);
    renderPage();
    await screen.findByText("Wash dishes");
    await userEvent.click(screen.getByRole("button", { name: "More" }));
    await userEvent.click(screen.getByRole("button", { name: "Skipped" }));
    const putCall = fetchSpy.mock.calls.find(([u, init]) => String(u).includes("/checklist/t1/completion") && (init as RequestInit | undefined)?.method === "PUT");
    expect(putCall).toBeDefined();
    const body = JSON.parse((putCall![1] as RequestInit).body as string);
    expect(body).toEqual({ date: "2026-09-30", status: "SKIPPED" });
  });

  it("hides marking controls for a VIEWER", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation((async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/households/h1")) return jsonResponse({ success: true, data: { ...HOUSEHOLD, permissions: ["checklists.view"] }, message: null });
      if (url.endsWith("/checklist/today")) {
        return jsonResponse({ success: true, data: { date: "2026-09-30", entries: [{ taskId: "t1", name: "Wash dishes", status: "COMPLETED", note: null }] } }, 200);
      }
      throw new Error(`unexpected fetch ${url}`);
    }) as typeof fetch);
    renderPage();
    await screen.findByText("Wash dishes");
    expect(screen.queryByRole("button", { name: "Skip" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "More" })).not.toBeInTheDocument();
  });
});
