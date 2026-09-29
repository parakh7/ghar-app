import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { meKey } from "../../auth/session";
import { ScheduleEditorPage } from "./ScheduleEditorPage";

const HOUSEHOLD = { id: "h1", name: "Shah Family", timezone: "Asia/Kolkata", role: "OWNER" as const, memberCount: 2 };

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function renderPage(configureCache?: (qc: QueryClient) => void) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  qc.setQueryData(meKey, { user: { id: "u1", name: "Parakh", email: "p@example.com", emailVerified: true, createdAt: "2026-01-01T00:00:00.000Z" }, households: [HOUSEHOLD] });
  configureCache?.(qc);
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={["/househelps/hh1/schedule"]}>
        <Routes><Route path="/househelps/:id/schedule" element={<ScheduleEditorPage />} /></Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe("ScheduleEditorPage", () => {
  beforeEach(() => { vi.restoreAllMocks(); });

  it("toggles weekday chips and saves via PUT", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation((async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/households/h1")) return jsonResponse({ success: true, data: { ...HOUSEHOLD, permissions: ["househelps.manage"] }, message: null });
      if (init?.method === "PUT") return jsonResponse({ success: true, data: { id: "s1", weekdays: [1], startTime: null, endTime: null, effectiveFrom: "2026-09-29" }, message: null });
      if (url.includes("/schedule")) return jsonResponse({ success: true, data: null, message: null });
      throw new Error(`unexpected fetch ${url}`);
    }) as typeof fetch);
    renderPage();
    await userEvent.click(await screen.findByRole("button", { name: "Monday" }));
    await userEvent.click(screen.getByRole("button", { name: "Save schedule" }));
    const putCall = fetchSpy.mock.calls.find(([, init]) => (init as RequestInit | undefined)?.method === "PUT");
    expect(putCall).toBeDefined();
    expect(JSON.parse((putCall![1] as RequestInit).body as string)).toEqual({ weekdays: [1] });
  });

  it("pre-fills the form from an already-warm schedule cache (e.g. reopening the editor)", async () => {
    // Regression test: this is the real navigation path — save a schedule, navigate back to the
    // detail page (which warms ["schedule", householdId, id] via useSchedule), then reopen the
    // editor. The cache is already populated on the very first render, so the seeding logic must
    // not rely on a "did the query value change" comparison seeded from that same value.
    vi.spyOn(globalThis, "fetch").mockImplementation((async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/households/h1")) return jsonResponse({ success: true, data: { ...HOUSEHOLD, permissions: ["househelps.manage"] }, message: null });
      if (url.endsWith("/househelps/hh1")) return jsonResponse({ success: true, data: { id: "hh1", name: "Radha" }, message: null });
      throw new Error(`unexpected fetch ${url}`);
    }) as typeof fetch);

    renderPage((qc) =>
      qc.setQueryData(["schedule", "h1", "hh1"], { id: "s1", weekdays: [2, 4], startTime: "09:00", endTime: "13:00", effectiveFrom: "2026-09-01" }),
    );

    expect(await screen.findByRole("button", { name: "Tuesday" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: "Thursday" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: "Monday" })).toHaveAttribute("aria-pressed", "false");
    expect(screen.getByLabelText("Start time")).toHaveValue("09:00");
    expect(screen.getByLabelText("End time")).toHaveValue("13:00");
  });
});
