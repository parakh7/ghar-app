import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
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

const MEMBERS = [
  { userId: "u1", name: "Parakh", email: "p@example.com", role: "OWNER", displayName: null, joinedAt: "2026-01-01T00:00:00.000Z" },
  { userId: "u2", name: "Riya", email: "riya@example.com", role: "MEMBER", displayName: null, joinedAt: "2026-01-02T00:00:00.000Z" },
];

function mockFetch(permissions: string[], { members = MEMBERS }: { members?: typeof MEMBERS } = {}) {
  return vi.spyOn(globalThis, "fetch").mockImplementation((async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    if (url.endsWith("/households/h1") && method === "GET") return jsonResponse({ success: true, data: { ...HOUSEHOLD, permissions }, message: null });
    if (url.endsWith("/households/h1/members") && method === "GET") return jsonResponse({ success: true, data: members, message: null });
    if (url.endsWith("/households/h1/invites") && method === "GET") return jsonResponse({ success: true, data: [], message: null });
    if (url.endsWith("/households/h1/invites") && method === "POST") return jsonResponse({ success: true, data: { id: "inv1", email: "new@example.com", role: "MEMBER", expiresAt: "2026-10-06T00:00:00.000Z", createdAt: "2026-09-29T00:00:00.000Z" }, message: null }, 201);
    if (url.includes("/households/h1/members/") && method === "PATCH") return jsonResponse({ success: true, data: { ...members[1]!, role: "ADMIN" }, message: null });
    // A role/remove mutation also invalidates the session query (useActiveHousehold observes it).
    if (url.endsWith("/auth/me") && method === "GET") return jsonResponse({ success: true, data: { user: { id: "u1", name: "Parakh", email: "p@example.com", emailVerified: true, createdAt: "2026-01-01T00:00:00.000Z" }, households: [HOUSEHOLD] }, message: null });
    throw new Error(`unexpected fetch ${method} ${url}`);
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

  it("submits the invite form and posts the email and role", async () => {
    const fetchSpy = mockFetch(["members.view", "members.manage"]);
    const user = userEvent.setup();
    renderPage();
    await screen.findByRole("button", { name: "Send invite" });

    await user.type(screen.getByLabelText("Email"), "new@example.com");
    await user.selectOptions(screen.getByLabelText("Role"), "MEMBER");
    await user.click(screen.getByRole("button", { name: "Send invite" }));

    await waitFor(() => expect(fetchSpy).toHaveBeenCalledWith(
      expect.stringContaining("/households/h1/invites"),
      expect.objectContaining({ method: "POST" }),
    ));
    const inviteCall = fetchSpy.mock.calls.find(([, init]) => (init as RequestInit | undefined)?.method === "POST");
    expect(JSON.parse((inviteCall![1] as RequestInit).body as string)).toEqual({ email: "new@example.com", role: "MEMBER" });

    // the email field clears once the invite succeeds
    await waitFor(() => expect(screen.getByLabelText("Email")).toHaveValue(""));
  });

  it("changes a member's role and patches the new role", async () => {
    const fetchSpy = mockFetch(["members.view", "members.manage"]);
    const user = userEvent.setup();
    renderPage();
    await screen.findByText("riya@example.com");

    await user.selectOptions(screen.getByLabelText("Role for Riya"), "ADMIN");

    await waitFor(() => expect(fetchSpy).toHaveBeenCalledWith(
      expect.stringContaining("/households/h1/members/u2"),
      expect.objectContaining({ method: "PATCH" }),
    ));
    const patchCall = fetchSpy.mock.calls.find(([, init]) => (init as RequestInit | undefined)?.method === "PATCH");
    expect(JSON.parse((patchCall![1] as RequestInit).body as string)).toEqual({ role: "ADMIN" });
  });

  it("truncates long member and invite emails with a title tooltip carrying the full text", async () => {
    const LONG_EMAIL = "riya.very.long.email.address.for.testing@example-household.com";
    mockFetch(["members.view", "members.manage"], { members: [MEMBERS[0]!, { ...MEMBERS[1]!, email: LONG_EMAIL }] });
    renderPage();
    const emailEl = await screen.findByText(LONG_EMAIL);
    expect(emailEl).toHaveClass("list__meta--truncate");
    expect(emailEl).toHaveAttribute("title", LONG_EMAIL);
  });
});
