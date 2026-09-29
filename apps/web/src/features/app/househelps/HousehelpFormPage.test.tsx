import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { meKey } from "../../auth/session";
import { HousehelpFormPage } from "./HousehelpFormPage";

const HOUSEHOLD = { id: "h1", name: "Shah Family", timezone: "Asia/Kolkata", role: "OWNER" as const, memberCount: 2 };

const HOUSEHELP = {
  id: "hh1", name: "Sunita", phone: "9876543210", roleTitle: "Cook", status: "ACTIVE" as const,
  startDate: null, endDate: null, salaryMode: "FIXED_MONTHLY" as const, monthlySalaryPaise: 1500000,
  dailyRatePaise: null, halfDayRatePaise: null, salaryDueDay: 5, notes: "Prefers mornings",
  archivedAt: null, categoryIds: [], createdAt: "2026-01-01T00:00:00.000Z",
};

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function renderEditPage(configureCache?: (qc: QueryClient) => void) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  qc.setQueryData(meKey, { user: { id: "u1", name: "Parakh", email: "p@example.com", emailVerified: true, createdAt: "2026-01-01T00:00:00.000Z" }, households: [HOUSEHOLD] });
  configureCache?.(qc);
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={["/househelps/hh1/edit"]}>
        <Routes><Route path="/househelps/:id/edit" element={<HousehelpFormPage mode="edit" />} /></Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

function renderCreatePage() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  qc.setQueryData(meKey, { user: { id: "u1", name: "Parakh", email: "p@example.com", emailVerified: true, createdAt: "2026-01-01T00:00:00.000Z" }, households: [HOUSEHOLD] });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={["/househelps/new"]}>
        <Routes><Route path="/househelps/new" element={<HousehelpFormPage mode="create" />} /></Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe("HousehelpFormPage", () => {
  beforeEach(() => { vi.restoreAllMocks(); });

  it("pre-fills the edit form from an already-warm househelp cache (e.g. reopening from the detail page)", async () => {
    // Regression test: the only real path to /househelps/:id/edit is the detail page's "Edit
    // details" button, which already calls useHousehelp with the same query key and warms the
    // cache. So existing.data is populated on the very first render here too — the seeding logic
    // must not rely on a "did the query value change" comparison seeded from that same value.
    vi.spyOn(globalThis, "fetch").mockImplementation((async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/households/h1")) return jsonResponse({ success: true, data: { ...HOUSEHOLD, permissions: ["househelps.manage"] }, message: null });
      if (url.includes("/categories")) return jsonResponse({ success: true, data: [], message: null });
      throw new Error(`unexpected fetch ${url}`);
    }) as typeof fetch);

    renderEditPage((qc) => qc.setQueryData(["househelp", "h1", "hh1"], HOUSEHELP));

    expect(await screen.findByLabelText("Name")).toHaveValue("Sunita");
    expect(screen.getByLabelText("Phone")).toHaveValue("9876543210");
    expect(screen.getByLabelText("Role")).toHaveValue("Cook");
    expect(screen.getByLabelText("Monthly salary (₹)")).toHaveValue("15000.00");
    expect(screen.getByLabelText("Salary due day")).toHaveValue("5");
    expect(screen.getByLabelText("Notes")).toHaveValue("Prefers mornings");
  });
});

describe("HousehelpFormPage — create mode", () => {
  beforeEach(() => { vi.restoreAllMocks(); });

  it("surfaces a field validation error without calling the API when required fields are missing", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation((async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/households/h1")) return jsonResponse({ success: true, data: { ...HOUSEHOLD, permissions: ["househelps.manage"] }, message: null });
      if (url.includes("/categories")) return jsonResponse({ success: true, data: [], message: null });
      throw new Error(`unexpected fetch ${url}`);
    }) as typeof fetch);

    renderCreatePage();
    await screen.findByLabelText("Name");
    await userEvent.click(screen.getByRole("button", { name: "Add househelp" }));

    expect(await screen.findByText("Give the househelp a name")).toBeInTheDocument();
    const postCalls = fetchSpy.mock.calls.filter(([, init]) => (init as RequestInit | undefined)?.method === "POST");
    expect(postCalls).toHaveLength(0);
  });

  it("converts a comma-grouped rupee amount to the correct integer-paise value in the request body", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation((async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/households/h1")) return jsonResponse({ success: true, data: { ...HOUSEHOLD, permissions: ["househelps.manage"] }, message: null });
      if (url.includes("/categories")) return jsonResponse({ success: true, data: [], message: null });
      if (init?.method === "POST" && url.endsWith("/househelps")) return jsonResponse({ success: true, data: { ...HOUSEHELP, id: "hh2" }, message: null }, 201);
      throw new Error(`unexpected fetch ${url}`);
    }) as typeof fetch);

    renderCreatePage();
    await userEvent.type(await screen.findByLabelText("Name"), "Sunita");
    await userEvent.type(screen.getByLabelText("Monthly salary (₹)"), "1,250.50");
    await userEvent.click(screen.getByRole("button", { name: "Add househelp" }));

    const postCall = fetchSpy.mock.calls.find(([u, init]) => String(u).endsWith("/househelps") && (init as RequestInit | undefined)?.method === "POST");
    expect(postCall).toBeDefined();
    const body = JSON.parse((postCall![1] as RequestInit).body as string);
    expect(body.monthlySalaryPaise).toBe(125050);
  });
});
