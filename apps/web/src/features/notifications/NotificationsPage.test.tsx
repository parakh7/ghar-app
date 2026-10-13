import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { meKey } from "../auth/session";
import { NotificationsPage } from "./NotificationsPage";

const HOUSEHOLD = { id: "h1", name: "Shah Family", timezone: "Asia/Kolkata", role: "OWNER" as const, memberCount: 2 };

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function renderPage() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  qc.setQueryData(meKey, { user: { id: "u1", name: "Parakh", email: "p@example.com", emailVerified: true, createdAt: "2026-01-01T00:00:00.000Z" }, households: [HOUSEHOLD] });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={["/notifications"]}>
        <Routes>
          <Route path="/notifications" element={<NotificationsPage />} />
          <Route path="/bills/:id" element={<div>Bill detail page</div>} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe("NotificationsPage", () => {
  beforeEach(() => { vi.restoreAllMocks(); });
  afterEach(() => { vi.restoreAllMocks(); });

  it("marks a notification read and navigates to its linkPath on tap", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation((async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (init?.method === "PATCH" && url.includes("/notifications/n1")) return jsonResponse({ success: true, data: { id: "n1", category: "BILL", severity: "INFO", title: "Electricity due in 7 day(s)", body: null, linkPath: "/bills/b1", readAt: "2026-09-29T00:00:00.000Z", dismissedAt: null, createdAt: "2026-09-29T00:00:00.000Z" }, message: null });
      if (url.endsWith("/households/h1/notifications")) {
        return jsonResponse({ success: true, data: [{ id: "n1", category: "BILL", severity: "INFO", title: "Electricity due in 7 day(s)", body: null, linkPath: "/bills/b1", readAt: null, dismissedAt: null, createdAt: "2026-09-29T00:00:00.000Z" }] }, 200);
      }
      throw new Error(`unexpected fetch ${url}`);
    }) as typeof fetch);
    renderPage();
    const row = await screen.findByText("Electricity due in 7 day(s)");
    await userEvent.click(row);
    const patchCall = fetchSpy.mock.calls.find(([u, init]) => String(u).includes("/notifications/n1") && (init as RequestInit | undefined)?.method === "PATCH");
    expect(patchCall).toBeDefined();
    expect(JSON.parse((patchCall![1] as RequestInit).body as string)).toEqual({ action: "read" });
    await screen.findByText("Bill detail page");
  });

  it("dismisses a notification, removing it from the list after the post-dismiss refetch", async () => {
    let listCallCount = 0;
    vi.spyOn(globalThis, "fetch").mockImplementation((async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (init?.method === "PATCH" && url.includes("/notifications/n1")) return jsonResponse({ success: true, data: null, message: null });
      if (url.endsWith("/households/h1/notifications")) {
        listCallCount += 1;
        const data = listCallCount === 1
          ? [{ id: "n1", category: "BILL", severity: "INFO", title: "Electricity due in 7 day(s)", body: null, linkPath: "/bills/b1", readAt: null, dismissedAt: null, createdAt: "2026-09-29T00:00:00.000Z" }]
          : [];
        return jsonResponse({ success: true, data }, 200);
      }
      throw new Error(`unexpected fetch ${url}`);
    }) as typeof fetch);
    renderPage();
    await screen.findByText("Electricity due in 7 day(s)");
    await userEvent.click(screen.getByRole("button", { name: "Dismiss" }));
    await screen.findByText("No notifications");
  });

  it("shows an empty state when there are no notifications", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation((async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/households/h1/notifications")) return jsonResponse({ success: true, data: [] }, 200);
      throw new Error(`unexpected fetch ${url}`);
    }) as typeof fetch);
    renderPage();
    await screen.findByText("No notifications");
  });
});
