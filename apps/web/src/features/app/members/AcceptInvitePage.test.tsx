import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { meKey, useSession } from "../../auth/session";
import { AcceptInvitePage } from "./AcceptInvitePage";

function renderAt(path: string) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={[path]}><AcceptInvitePage /></MemoryRouter>
    </QueryClientProvider>,
  );
}

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

describe("AcceptInvitePage", () => {
  beforeEach(() => { vi.restoreAllMocks(); });

  it("shows an error when the link has no token", async () => {
    renderAt("/invites/accept");
    expect(await screen.findByText("This invite link is incomplete.")).toBeInTheDocument();
  });

  it("posts the token from the URL and shows the server's error on mismatch", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(
      JSON.stringify({ success: false, error: { code: "FORBIDDEN", message: "This invite is for other@example.com. Sign out and sign in as that address to accept it." } }),
      { status: 403, headers: { "content-type": "application/json" } },
    ));
    renderAt("/invites/accept?token=abc123&email=other@example.com");
    expect(await screen.findByRole("alert")).toHaveTextContent("This invite is for other@example.com");
    const [url, init] = fetchSpy.mock.calls[0]!;
    expect(String(url)).toContain("/invites/accept");
    expect((init as RequestInit).method).toBe("POST");
  });

  it("awaits the session refetch before navigating away, so a new invitee isn't bounced to onboarding", async () => {
    let resolveMe!: (r: Response) => void;
    const mePromise = new Promise<Response>((resolve) => { resolveMe = resolve; });

    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation((async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/invites/accept")) {
        return jsonResponse({
          success: true,
          data: { id: "h1", name: "Shah Family", timezone: "Asia/Kolkata", role: "MEMBER", memberCount: 2, permissions: [], createdAt: "2026-01-01T00:00:00.000Z" },
          message: null,
        });
      }
      if (url.includes("/auth/me")) return mePromise; // stays pending until resolved below, simulating a slow refetch
      throw new Error(`unexpected fetch ${url}`);
    }) as typeof fetch);

    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    qc.setQueryData(meKey, {
      user: { id: "u1", name: "New Invitee", email: "invitee@example.com", emailVerified: true, createdAt: "2026-01-01T00:00:00.000Z" },
      households: [],
    });

    function Wrapper() {
      useSession(); // an active observer on meKey, so invalidateQueries actually triggers a refetch
      return <AcceptInvitePage />;
    }

    render(
      <QueryClientProvider client={qc}>
        <MemoryRouter initialEntries={["/invites/accept?token=abc123"]}>
          <Routes>
            <Route path="/invites/accept" element={<Wrapper />} />
            <Route path="/" element={<div>HOME PAGE</div>} />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>,
    );

    // The accept POST fires, and the session refetch it triggers is still pending — navigation must
    // not have happened yet. If onSuccess didn't await invalidateQueries, "HOME PAGE" would already be visible.
    await waitFor(() => expect(fetchSpy).toHaveBeenCalledWith(expect.stringContaining("/invites/accept"), expect.anything()));
    await waitFor(() => expect(fetchSpy).toHaveBeenCalledWith(expect.stringContaining("/auth/me"), expect.anything()));
    expect(screen.queryByText("HOME PAGE")).not.toBeInTheDocument();

    resolveMe(jsonResponse({
      success: true,
      data: { user: { id: "u1", name: "New Invitee", email: "invitee@example.com", emailVerified: true, createdAt: "2026-01-01T00:00:00.000Z" }, households: [{ id: "h1", name: "Shah Family", timezone: "Asia/Kolkata", role: "MEMBER", memberCount: 2 }] },
      message: null,
    }));

    expect(await screen.findByText("HOME PAGE")).toBeInTheDocument();
  });
});
