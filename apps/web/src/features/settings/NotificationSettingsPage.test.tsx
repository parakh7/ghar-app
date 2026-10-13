import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { meKey } from "../auth/session";
import { NotificationSettingsPage } from "./NotificationSettingsPage";

const HOUSEHOLD = { id: "h1", name: "Shah Family", timezone: "Asia/Kolkata", role: "OWNER" as const, memberCount: 2 };

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function renderPage() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  qc.setQueryData(meKey, { user: { id: "u1", name: "Parakh", email: "p@example.com", emailVerified: true, createdAt: "2026-01-01T00:00:00.000Z" }, households: [HOUSEHOLD] });
  return render(<QueryClientProvider client={qc}><MemoryRouter><NotificationSettingsPage /></MemoryRouter></QueryClientProvider>);
}

describe("NotificationSettingsPage", () => {
  beforeEach(() => { vi.restoreAllMocks(); });
  afterEach(() => { vi.restoreAllMocks(); });

  it("renders both categories' current state", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation((async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/households/h1/notification-preferences")) {
        return jsonResponse({ success: true, data: [
          { category: "BILL", enabled: true, emailEnabled: false },
          { category: "SALARY", enabled: false, emailEnabled: false },
        ] }, 200);
      }
      throw new Error(`unexpected fetch ${url}`);
    }) as typeof fetch);
    renderPage();
    await screen.findByText("Bills");
    await screen.findByText("Salary");
    const billToggle = screen.getAllByRole("button", { name: "On" })[0]!;
    expect(billToggle).toHaveAttribute("aria-pressed", "true");
  });

  it("hides the email toggle when enabled is off", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation((async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/households/h1/notification-preferences")) {
        return jsonResponse({ success: true, data: [
          { category: "BILL", enabled: false, emailEnabled: false },
          { category: "SALARY", enabled: true, emailEnabled: false },
        ] }, 200);
      }
      throw new Error(`unexpected fetch ${url}`);
    }) as typeof fetch);
    renderPage();
    await screen.findByText("Bills");
    // Only Salary (enabled) shows its "Also email me" toggle
    expect(screen.getAllByRole("button", { name: "Also email me" })).toHaveLength(1);
  });

  it("toggling enabled fires the correct PATCH body", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation((async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (init?.method === "PATCH" && url.includes("/notification-preferences/BILL")) {
        return jsonResponse({ success: true, data: { category: "BILL", enabled: false, emailEnabled: false }, message: null });
      }
      if (url.endsWith("/households/h1/notification-preferences")) {
        return jsonResponse({ success: true, data: [
          { category: "BILL", enabled: true, emailEnabled: false },
          { category: "SALARY", enabled: true, emailEnabled: false },
        ] }, 200);
      }
      throw new Error(`unexpected fetch ${url}`);
    }) as typeof fetch);
    renderPage();
    await screen.findByText("Bills");
    const toggles = screen.getAllByRole("button", { name: "On" });
    await userEvent.click(toggles[0]!); // BILL is first card
    const patchCall = fetchSpy.mock.calls.find(([u, init]) => String(u).includes("/notification-preferences/BILL") && (init as RequestInit | undefined)?.method === "PATCH");
    expect(patchCall).toBeDefined();
    expect(JSON.parse((patchCall![1] as RequestInit).body as string)).toEqual({ enabled: false });
  });

  it("toggling email opt-in fires the correct PATCH body", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation((async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (init?.method === "PATCH" && url.includes("/notification-preferences/SALARY")) {
        return jsonResponse({ success: true, data: { category: "SALARY", enabled: true, emailEnabled: true }, message: null });
      }
      if (url.endsWith("/households/h1/notification-preferences")) {
        return jsonResponse({ success: true, data: [
          { category: "BILL", enabled: true, emailEnabled: false },
          { category: "SALARY", enabled: true, emailEnabled: false },
        ] }, 200);
      }
      throw new Error(`unexpected fetch ${url}`);
    }) as typeof fetch);
    renderPage();
    await screen.findByText("Salary");
    const emailToggles = screen.getAllByRole("button", { name: "Also email me" });
    await userEvent.click(emailToggles[1]!); // SALARY is the second card
    const patchCall = fetchSpy.mock.calls.find(([u, init]) => String(u).includes("/notification-preferences/SALARY") && (init as RequestInit | undefined)?.method === "PATCH");
    expect(patchCall).toBeDefined();
    expect(JSON.parse((patchCall![1] as RequestInit).body as string)).toEqual({ emailEnabled: true });
  });
});
