import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { AcceptInvitePage } from "./AcceptInvitePage";

function renderAt(path: string) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={[path]}><AcceptInvitePage /></MemoryRouter>
    </QueryClientProvider>,
  );
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
});
