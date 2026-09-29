import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { SignInPage } from "./SignInPage";

function renderPage() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={qc}><MemoryRouter><SignInPage /></MemoryRouter></QueryClientProvider>);
}

describe("SignInPage", () => {
  beforeEach(() => { vi.restoreAllMocks(); });

  it("validates before calling the server", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    renderPage();
    await userEvent.click(screen.getByRole("button", { name: "Sign in" }));
    expect(await screen.findByText("Enter a valid email address")).toBeInTheDocument();
    expect(screen.getByLabelText("Email")).toHaveAttribute("aria-invalid", "true");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("shows the server's friendly message on wrong credentials and sends the CSRF header", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(
      JSON.stringify({ success: false, error: { code: "INVALID_CREDENTIALS", message: "Email or password is incorrect." } }),
      { status: 401, headers: { "content-type": "application/json" } },
    ));
    renderPage();
    await userEvent.type(screen.getByLabelText("Email"), "parakh@example.com");
    await userEvent.type(screen.getByLabelText("Password"), "wrong-password");
    await userEvent.click(screen.getByRole("button", { name: "Sign in" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Email or password is incorrect.");
    const [, init] = fetchSpy.mock.calls[0]!;
    expect((init as RequestInit).headers).toMatchObject({ "x-household-client": "web" });
    expect((init as RequestInit).credentials).toBe("include");
  });

  it("shows an offline message when the network is down", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new TypeError("Failed to fetch"));
    renderPage();
    await userEvent.type(screen.getByLabelText("Email"), "parakh@example.com");
    await userEvent.type(screen.getByLabelText("Password"), "whatever1");
    await userEvent.click(screen.getByRole("button", { name: "Sign in" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(/offline/i);
  });

  it("lets the user reveal the password", async () => {
    renderPage();
    const input = screen.getByLabelText("Password");
    expect(input).toHaveAttribute("type", "password");
    await userEvent.click(screen.getByRole("button", { name: "Show password" }));
    expect(input).toHaveAttribute("type", "text");
  });
});
