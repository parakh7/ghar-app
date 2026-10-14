import "fake-indexeddb/auto";
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { meKey } from "../../auth/session";
import { TodayPage } from "./TodayPage";

const HOUSEHOLD = { id: "h1", name: "Shah Family", timezone: "Asia/Kolkata", role: "OWNER" as const, memberCount: 2 };

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function renderPage() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  qc.setQueryData(meKey, { user: { id: "u1", name: "Parakh", email: "p@example.com", emailVerified: true, createdAt: "2026-01-01T00:00:00.000Z" }, households: [HOUSEHOLD] });
  return render(<QueryClientProvider client={qc}><MemoryRouter><TodayPage /></MemoryRouter></QueryClientProvider>);
}

describe("TodayPage", () => {
  beforeEach(() => { vi.restoreAllMocks(); });
  afterEach(() => { vi.restoreAllMocks(); });

  it("cycles a house help between Present and Absent on tap", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation((async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/households/h1")) return jsonResponse({ success: true, data: { ...HOUSEHOLD, permissions: ["attendance.view", "attendance.mark"] }, message: null });
      if (init?.method === "PUT" && url.includes("/attendance/hh1")) return jsonResponse({ success: true, data: { date: "2026-09-29", status: "PRESENT", note: null }, message: null });
      if (url.endsWith("/attendance/today")) {
        return jsonResponse({ success: true, data: { date: "2026-09-29", entries: [{ househelpId: "hh1", name: "Sunita", roleTitle: "Cook", scheduledToday: true, status: null, note: null }] } }, 200);
      }
      throw new Error(`unexpected fetch ${url}`);
    }) as typeof fetch);
    renderPage();
    const row = await screen.findByText("Sunita");
    await userEvent.click(row);
    const putCall = fetchSpy.mock.calls.find(([u, init]) => String(u).includes("/attendance/hh1") && (init as RequestInit | undefined)?.method === "PUT");
    expect(putCall).toBeDefined();
    const body = JSON.parse((putCall![1] as RequestInit).body as string);
    expect(body).toEqual({ date: "2026-09-29", status: "PRESENT" });
  });

  it("opens the picker and sets Half-day", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation((async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/households/h1")) return jsonResponse({ success: true, data: { ...HOUSEHOLD, permissions: ["attendance.view", "attendance.mark"] }, message: null });
      if (init?.method === "PUT" && url.includes("/attendance/hh1")) return jsonResponse({ success: true, data: { date: "2026-09-29", status: "HALF_DAY", note: null }, message: null });
      if (url.endsWith("/attendance/today")) {
        return jsonResponse({ success: true, data: { date: "2026-09-29", entries: [{ househelpId: "hh1", name: "Sunita", roleTitle: "Cook", scheduledToday: true, status: null, note: null }] } }, 200);
      }
      throw new Error(`unexpected fetch ${url}`);
    }) as typeof fetch);
    renderPage();
    await screen.findByText("Sunita");
    await userEvent.click(screen.getByRole("button", { name: "More" }));
    await userEvent.click(screen.getByRole("button", { name: "Half-day" }));
    const putCall = fetchSpy.mock.calls.find(([u, init]) => String(u).includes("/attendance/hh1") && (init as RequestInit | undefined)?.method === "PUT");
    const body = JSON.parse((putCall![1] as RequestInit).body as string);
    expect(body).toEqual({ date: "2026-09-29", status: "HALF_DAY" });
  });

  it("confirms before marking today as a holiday, showing how many are already marked", async () => {
    const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(true);
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation((async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/households/h1")) return jsonResponse({ success: true, data: { ...HOUSEHOLD, permissions: ["attendance.view", "attendance.mark"] }, message: null });
      if (init?.method === "POST" && url.endsWith("/attendance/holiday")) return jsonResponse({ success: true, data: { date: "2026-09-29", count: 1 }, message: null });
      if (url.endsWith("/attendance/today")) {
        return jsonResponse({ success: true, data: { date: "2026-09-29", entries: [{ househelpId: "hh1", name: "Sunita", roleTitle: "Cook", scheduledToday: true, status: "PRESENT", note: null }] } }, 200);
      }
      throw new Error(`unexpected fetch ${url}`);
    }) as typeof fetch);
    renderPage();
    await screen.findByText("Sunita");
    await userEvent.click(screen.getByRole("button", { name: "Mark today as holiday" }));
    expect(confirmSpy).toHaveBeenCalledWith(expect.stringContaining("1 already marked"));
    const postCall = fetchSpy.mock.calls.find(([u, init]) => String(u).endsWith("/attendance/holiday") && (init as RequestInit | undefined)?.method === "POST");
    expect(postCall).toBeDefined();
  });

  it("queues the mark and shows a pending badge when the PUT fails with a network error", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation((async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/households/h1")) return jsonResponse({ success: true, data: { ...HOUSEHOLD, permissions: ["attendance.view", "attendance.mark"] }, message: null });
      if (init?.method === "PUT" && url.includes("/attendance/hh1")) throw new TypeError("Failed to fetch");
      if (url.endsWith("/attendance/today")) {
        return jsonResponse({ success: true, data: { date: "2026-09-29", entries: [{ househelpId: "hh1", name: "Sunita", roleTitle: "Cook", scheduledToday: true, status: null, note: null }] } }, 200);
      }
      throw new Error(`unexpected fetch ${url}`);
    }) as typeof fetch);
    renderPage();
    const row = await screen.findByText("Sunita");
    await userEvent.click(row);
    const indicator = await screen.findByLabelText("Not yet synced");
    expect(indicator.closest(".badge")?.textContent).toContain("Present");
    expect(document.querySelectorAll(".badge--muted")).toHaveLength(0);
  });

  it("hides marking controls for a VIEWER", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation((async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/households/h1")) return jsonResponse({ success: true, data: { ...HOUSEHOLD, permissions: ["attendance.view"] }, message: null });
      if (url.endsWith("/attendance/today")) {
        return jsonResponse({ success: true, data: { date: "2026-09-29", entries: [{ househelpId: "hh1", name: "Sunita", roleTitle: "Cook", scheduledToday: true, status: "PRESENT", note: null }] } }, 200);
      }
      throw new Error(`unexpected fetch ${url}`);
    }) as typeof fetch);
    renderPage();
    await screen.findByText("Sunita");
    expect(screen.queryByRole("button", { name: "More" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Mark today as holiday" })).not.toBeInTheDocument();
  });
});
