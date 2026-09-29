import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { meKey } from "../../auth/session";
import { CategoriesPage } from "./CategoriesPage";

const HOUSEHOLD = { id: "h1", name: "Shah Family", timezone: "Asia/Kolkata", role: "OWNER" as const, memberCount: 2 };

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function renderPage() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  qc.setQueryData(meKey, { user: { id: "u1", name: "Parakh", email: "p@example.com", emailVerified: true, createdAt: "2026-01-01T00:00:00.000Z" }, households: [HOUSEHOLD] });
  return render(<QueryClientProvider client={qc}><MemoryRouter><CategoriesPage /></MemoryRouter></QueryClientProvider>);
}

function mockFetch(permissions: string[]) {
  return vi.spyOn(globalThis, "fetch").mockImplementation((async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.endsWith("/households/h1")) return jsonResponse({ success: true, data: { ...HOUSEHOLD, permissions }, message: null });
    if (init?.method === "POST" && url.endsWith("/categories")) return jsonResponse({ success: true, data: { id: "c2", name: "Pet care", sortOrder: 1, isActive: true }, message: null });
    if (url.endsWith("/categories")) return jsonResponse({ success: true, data: [{ id: "c1", name: "Cleaning", sortOrder: 0, isActive: true }], message: null });
    throw new Error(`unexpected fetch ${url}`);
  }) as typeof fetch);
}

describe("CategoriesPage", () => {
  beforeEach(() => { vi.restoreAllMocks(); });

  it("lists categories and posts a new one from the add form", async () => {
    const fetchSpy = mockFetch(["househelps.view", "categories.manage"]);
    renderPage();
    expect(await screen.findByText("Cleaning")).toBeInTheDocument();
    await userEvent.type(screen.getByLabelText("Category name"), "Pet care");
    await userEvent.click(screen.getByRole("button", { name: "Add category" }));
    const postCall = fetchSpy.mock.calls.find(([, init]) => (init as RequestInit | undefined)?.method === "POST");
    expect(postCall).toBeDefined();
    expect(JSON.parse((postCall![1] as RequestInit).body as string)).toEqual({ name: "Pet care" });
  });

  it("clicking a move button posts the move request with the correct direction", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation((async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/households/h1")) return jsonResponse({ success: true, data: { ...HOUSEHOLD, permissions: ["househelps.view", "categories.manage"] }, message: null });
      if (init?.method === "POST" && url.endsWith("/move")) return jsonResponse({ success: true, data: null, message: null });
      if (url.endsWith("/categories")) {
        return jsonResponse({
          success: true,
          data: [{ id: "c1", name: "Cleaning", sortOrder: 0, isActive: true }, { id: "c2", name: "Cooking", sortOrder: 1, isActive: true }],
          message: null,
        });
      }
      throw new Error(`unexpected fetch ${url}`);
    }) as typeof fetch);
    renderPage();
    expect(await screen.findByText("Cleaning")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Move Cooking up" }));
    const moveCall = fetchSpy.mock.calls.find(([u, init]) => String(u).endsWith("/move") && (init as RequestInit | undefined)?.method === "POST");
    expect(moveCall).toBeDefined();
    expect(String(moveCall![0])).toContain("/categories/c2/move");
    expect(JSON.parse((moveCall![1] as RequestInit).body as string)).toEqual({ direction: "up" });
  });

  it("hides the add-category form and per-row controls for a viewer without categories.manage", async () => {
    mockFetch(["househelps.view"]);
    renderPage();
    await screen.findByText("Cleaning");
    expect(screen.queryByRole("button", { name: "Add category" })).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Category name")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Move Cleaning up" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Move Cleaning down" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Remove Cleaning" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Active" })).not.toBeInTheDocument();
  });
});
