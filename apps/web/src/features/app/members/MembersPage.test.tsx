import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { meKey } from "../../auth/session";
import { MembersPage } from "./MembersPage";

const HOUSEHOLD = { id: "h1", name: "Shah Family", timezone: "Asia/Kolkata", role: "OWNER" as const, memberCount: 2 };

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function renderPage() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  qc.setQueryData(meKey, { user: { id: "u1", name: "Parakh", email: "p@example.com", emailVerified: true, createdAt: "2026-01-01T00:00:00.000Z" }, households: [HOUSEHOLD] });
  return render(<QueryClientProvider client={qc}><MemoryRouter><MembersPage /></MemoryRouter></QueryClientProvider>);
}

function mockFetch(permissions: string[]) {
  vi.spyOn(globalThis, "fetch").mockImplementation((async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.endsWith("/households/h1")) return jsonResponse({ success: true, data: { ...HOUSEHOLD, permissions }, message: null });
    if (url.endsWith("/households/h1/members")) return jsonResponse({ success: true, data: [{ userId: "u1", name: "Parakh", email: "p@example.com", role: "OWNER", displayName: null, joinedAt: "2026-01-01T00:00:00.000Z" }], message: null });
    if (url.endsWith("/households/h1/invites")) return jsonResponse({ success: true, data: [], message: null });
    throw new Error(`unexpected fetch ${url}`);
  }) as typeof fetch);
}

describe("MembersPage", () => {
  beforeEach(() => { vi.restoreAllMocks(); });

  it("shows members and the invite form when the viewer has members.manage", async () => {
    mockFetch(["members.view", "members.manage"]);
    renderPage();
    expect(await screen.findByText("p@example.com")).toBeInTheDocument();
    expect(await screen.findByRole("button", { name: "Send invite" })).toBeInTheDocument();
  });

  it("hides the invite form and role editing for a viewer without members.manage", async () => {
    mockFetch(["members.view"]);
    renderPage();
    await screen.findByText("p@example.com");
    expect(screen.queryByRole("button", { name: "Send invite" })).not.toBeInTheDocument();
  });
});
