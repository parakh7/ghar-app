import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
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

function mockPreferencesFetch(overrides: { onPatch?: (url: string, body: unknown) => unknown } = {}) {
  return vi.spyOn(globalThis, "fetch").mockImplementation((async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (init?.method === "PATCH" && overrides.onPatch) {
      const result = overrides.onPatch(url, init.body ? JSON.parse(init.body as string) : {});
      if (result) return jsonResponse({ success: true, data: result, message: null });
    }
    if (url.endsWith("/households/h1/notification-preferences")) {
      return jsonResponse({ success: true, data: [
        { category: "BILL", enabled: true, emailEnabled: false, pushEnabled: false },
        { category: "SALARY", enabled: true, emailEnabled: false, pushEnabled: false },
      ] }, 200);
    }
    throw new Error(`unexpected fetch ${url}`);
  }) as typeof fetch);
}

function stubPushSupport({ permission, subscription }: { permission: NotificationPermission; subscription: unknown }) {
  (window as unknown as { PushManager: unknown }).PushManager = class {};
  (window as unknown as { Notification: unknown }).Notification = { permission, requestPermission: vi.fn().mockResolvedValue(permission) };
  const registration = {
    pushManager: {
      getSubscription: vi.fn().mockResolvedValue(subscription),
      subscribe: vi.fn().mockResolvedValue({ endpoint: "https://push.example/abc", toJSON: () => ({ endpoint: "https://push.example/abc", keys: { p256dh: "p", auth: "a" } }) }),
    },
  };
  Object.defineProperty(navigator, "serviceWorker", { value: { ready: Promise.resolve(registration) }, configurable: true });
}

function clearPushStubs() {
  delete (window as unknown as { PushManager?: unknown }).PushManager;
  delete (window as unknown as { Notification?: unknown }).Notification;
  Reflect.deleteProperty(navigator, "serviceWorker");
}

describe("NotificationSettingsPage", () => {
  beforeEach(() => { vi.restoreAllMocks(); });
  afterEach(() => { vi.restoreAllMocks(); clearPushStubs(); });

  it("renders both categories' current state", async () => {
    mockPreferencesFetch();
    renderPage();
    await screen.findByText("Bills");
    await screen.findByText("Salary");
    const billToggle = screen.getAllByRole("button", { name: "On" })[0]!;
    expect(billToggle).toHaveAttribute("aria-pressed", "true");
  });

  it("hides the email and push toggles when enabled is off", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation((async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/households/h1/notification-preferences")) {
        return jsonResponse({ success: true, data: [
          { category: "BILL", enabled: false, emailEnabled: false, pushEnabled: false },
          { category: "SALARY", enabled: true, emailEnabled: false, pushEnabled: false },
        ] }, 200);
      }
      throw new Error(`unexpected fetch ${url}`);
    }) as typeof fetch);
    renderPage();
    await screen.findByText("Bills");
    expect(screen.getAllByRole("button", { name: "Also email me" })).toHaveLength(1);
    expect(screen.getAllByRole("button", { name: "Also notify on this device" })).toHaveLength(1);
  });

  it("toggling enabled fires the correct PATCH body", async () => {
    const fetchSpy = mockPreferencesFetch({ onPatch: (url, body) => url.includes("/notification-preferences/BILL") ? { category: "BILL", enabled: false, emailEnabled: false, pushEnabled: false, ...(body as object) } : null });
    renderPage();
    await screen.findByText("Bills");
    const toggles = screen.getAllByRole("button", { name: "On" });
    await userEvent.click(toggles[0]!);
    const patchCall = fetchSpy.mock.calls.find(([u, init]) => String(u).includes("/notification-preferences/BILL") && (init as RequestInit | undefined)?.method === "PATCH");
    expect(patchCall).toBeDefined();
    expect(JSON.parse((patchCall![1] as RequestInit).body as string)).toEqual({ enabled: false });
  });

  it("toggling email opt-in fires the correct PATCH body", async () => {
    const fetchSpy = mockPreferencesFetch({ onPatch: (url, body) => url.includes("/notification-preferences/SALARY") ? { category: "SALARY", enabled: true, emailEnabled: true, pushEnabled: false, ...(body as object) } : null });
    renderPage();
    await screen.findByText("Salary");
    const emailToggles = screen.getAllByRole("button", { name: "Also email me" });
    await userEvent.click(emailToggles[1]!);
    const patchCall = fetchSpy.mock.calls.find(([u, init]) => String(u).includes("/notification-preferences/SALARY") && (init as RequestInit | undefined)?.method === "PATCH");
    expect(patchCall).toBeDefined();
    expect(JSON.parse((patchCall![1] as RequestInit).body as string)).toEqual({ emailEnabled: true });
  });

  it("toggling push opt-in fires the correct PATCH body", async () => {
    const fetchSpy = mockPreferencesFetch({ onPatch: (url, body) => url.includes("/notification-preferences/SALARY") ? { category: "SALARY", enabled: true, emailEnabled: false, pushEnabled: true, ...(body as object) } : null });
    renderPage();
    await screen.findByText("Salary");
    const pushToggles = screen.getAllByRole("button", { name: "Also notify on this device" });
    await userEvent.click(pushToggles[1]!);
    const patchCall = fetchSpy.mock.calls.find(([u, init]) => String(u).includes("/notification-preferences/SALARY") && (init as RequestInit | undefined)?.method === "PATCH");
    expect(patchCall).toBeDefined();
    expect(JSON.parse((patchCall![1] as RequestInit).body as string)).toEqual({ pushEnabled: true });
  });

  it("shows a not-supported message when the browser lacks push APIs", async () => {
    mockPreferencesFetch();
    renderPage();
    await screen.findByText(/aren't supported on this device/);
  });

  it("shows the test-notification button once subscribed, and sends a test push on click", async () => {
    stubPushSupport({ permission: "granted", subscription: { endpoint: "https://push.example/abc" } });
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation((async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/households/h1/notifications/test-push") && init?.method === "POST") {
        return jsonResponse({ success: true, data: { delivered: true }, message: null });
      }
      if (url.endsWith("/households/h1/notification-preferences")) {
        return jsonResponse({ success: true, data: [
          { category: "BILL", enabled: true, emailEnabled: false, pushEnabled: false },
          { category: "SALARY", enabled: true, emailEnabled: false, pushEnabled: false },
        ] }, 200);
      }
      throw new Error(`unexpected fetch ${url}`);
    }) as typeof fetch);
    renderPage();
    const testButton = await screen.findByRole("button", { name: "Send test notification" });
    await userEvent.click(testButton);
    await screen.findByText("Sent — check for a notification.");
    expect(fetchSpy.mock.calls.some(([u, init]) => String(u).endsWith("/households/h1/notifications/test-push") && (init as RequestInit | undefined)?.method === "POST")).toBe(true);
  });

  it("re-POSTs an existing browser subscription to the server automatically on render, without the user clicking anything", async () => {
    stubPushSupport({ permission: "granted", subscription: { endpoint: "https://push.example/abc", keys: { p256dh: "p", auth: "a" }, toJSON() { return { endpoint: "https://push.example/abc", keys: { p256dh: "p", auth: "a" } }; } } });
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation((async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/push-subscriptions") && init?.method === "POST") {
        return jsonResponse({ success: true, data: null, message: null });
      }
      if (url.endsWith("/households/h1/notification-preferences")) {
        return jsonResponse({ success: true, data: [
          { category: "BILL", enabled: true, emailEnabled: false, pushEnabled: false },
          { category: "SALARY", enabled: true, emailEnabled: false, pushEnabled: false },
        ] }, 200);
      }
      throw new Error(`unexpected fetch ${url}`);
    }) as typeof fetch);
    renderPage();
    await screen.findByRole("button", { name: "Send test notification" });
    await waitFor(() => {
      expect(fetchSpy.mock.calls.some(([u, init]) => String(u).endsWith("/push-subscriptions") && (init as RequestInit | undefined)?.method === "POST")).toBe(true);
    });
    const [, init] = fetchSpy.mock.calls.find(([u, i]) => String(u).endsWith("/push-subscriptions") && (i as RequestInit | undefined)?.method === "POST")!;
    expect(JSON.parse((init as RequestInit).body as string)).toMatchObject({ endpoint: "https://push.example/abc", keys: { p256dh: "p", auth: "a" } });
  });
});
