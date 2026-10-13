import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { meKey } from "../auth/session";
import { MorePage } from "./MorePage";

const HOUSEHOLD = { id: "h1", name: "Shah Family", timezone: "Asia/Kolkata", role: "OWNER" as const, memberCount: 2 };

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function renderPage(unreadCount: number) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  qc.setQueryData(meKey, { user: { id: "u1", name: "Parakh", email: "p@example.com", emailVerified: true, createdAt: "2026-01-01T00:00:00.000Z" }, households: [HOUSEHOLD] });
  vi.spyOn(globalThis, "fetch").mockImplementation((async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.endsWith("/notifications/unread-count")) return jsonResponse({ success: true, data: { count: unreadCount }, message: null });
    throw new Error(`unexpected fetch ${url}`);
  }) as typeof fetch);
  return render(<QueryClientProvider client={qc}><MemoryRouter><MorePage /></MemoryRouter></QueryClientProvider>);
}

describe("MorePage", () => {
  beforeEach(() => { vi.restoreAllMocks(); });
  afterEach(() => { vi.restoreAllMocks(); });

  it("shows a Notifications row with the unread badge", async () => {
    renderPage(5);
    await screen.findByText("Notifications");
    expect(await screen.findByLabelText("5 unread notifications")).toBeInTheDocument();
    await screen.findByText("Notification settings");
  });
});
