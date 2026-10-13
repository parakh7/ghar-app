import { afterEach, describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { meKey } from "../../auth/session";
import { HousehelpCalendarPage } from "./HousehelpCalendarPage";

const HOUSEHOLD = { id: "h1", name: "Shah Family", timezone: "Asia/Kolkata", role: "OWNER" as const, memberCount: 2 };
const HOUSEHELP = { id: "hh1", name: "Sunita", phone: null, roleTitle: "Cook", status: "ACTIVE" as const, startDate: null, endDate: null, salaryMode: "FIXED_MONTHLY" as const, monthlySalaryPaise: null, dailyRatePaise: null, halfDayRatePaise: null, salaryDueDay: 1, notes: null, archivedAt: null, categoryIds: [], createdAt: "2026-01-01T00:00:00.000Z" };

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function renderPage(permissions: string[]) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  qc.setQueryData(meKey, { user: { id: "u1", name: "Parakh", email: "p@example.com", emailVerified: true, createdAt: "2026-01-01T00:00:00.000Z" }, households: [HOUSEHOLD] });
  vi.spyOn(globalThis, "fetch").mockImplementation((async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.endsWith("/households/h1")) return jsonResponse({ success: true, data: { ...HOUSEHOLD, permissions }, message: null });
    if (url.endsWith("/households/h1/househelps/hh1")) return jsonResponse({ success: true, data: HOUSEHELP, message: null });
    if (url.endsWith("/households/h1/househelps/hh1/schedule")) return jsonResponse({ success: true, data: { id: "s1", weekdays: [1, 2, 3, 4, 5], startTime: null, endTime: null, effectiveFrom: "2026-01-01" }, message: null });
    if (init?.method === "PUT" && url.includes("/attendance/hh1")) return jsonResponse({ success: true, data: { date: "2026-09-15", status: "ABSENT", note: null }, message: null });
    if (url.includes("/attendance?month=2026-09")) return jsonResponse({ success: true, data: [{ date: "2026-09-15", status: "PRESENT", note: null }] });
    if (/\/attendance\?month=\d{4}-\d{2}$/.test(url)) return jsonResponse({ success: true, data: [] });
    if (init?.method === "POST" && url.includes("/attendance/remaining-present")) return jsonResponse({ success: true, data: { month: "2026-09", count: 20 }, message: null });
    throw new Error(`unexpected fetch ${url}`);
  }) as typeof fetch);
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={["/househelps/hh1/attendance"]}>
        <Routes><Route path="/househelps/:id/attendance" element={<HousehelpCalendarPage />} /></Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe("HousehelpCalendarPage", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    // Pins `new Date()` (used by the page to compute its default month and "today") to a known
    // instant, so the initial grid always renders September 2026 regardless of when this test runs.
    // `toFake: ["Date"]` deliberately leaves setTimeout/setInterval real — faking those too would
    // hang every `userEvent.click` below, since user-event's internal delays rely on real timers.
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-09-29T04:30:00Z"));
  });
  afterEach(() => { vi.useRealTimers(); });

  it("renders the marked day and opens the picker to post a correction on a past day", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    renderPage(["attendance.view", "attendance.mark", "attendance.editHistory"]);
    await screen.findByText("Sunita's attendance");
    const day15 = await screen.findByRole("button", { name: "15" });
    await userEvent.click(day15);
    await userEvent.click(screen.getByRole("button", { name: "Absent" }));
    const putCall = fetchSpy.mock.calls.find(([u, init]) => String(u).includes("/attendance/hh1") && (init as RequestInit | undefined)?.method === "PUT");
    expect(putCall).toBeDefined();
    const body = JSON.parse((putCall![1] as RequestInit).body as string);
    expect(body).toEqual({ date: "2026-09-15", status: "ABSENT" });
  });

  it("disables editing a past day without attendance.editHistory", async () => {
    renderPage(["attendance.view", "attendance.mark"]);
    await screen.findByText("Sunita's attendance");
    const day15 = await screen.findByRole("button", { name: "15" });
    expect(day15).toBeDisabled();
  });

  it("navigates to the next month and requests its data", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    renderPage(["attendance.view", "attendance.editHistory"]);
    await screen.findByText("September 2026");
    await userEvent.click(screen.getByRole("button", { name: "Next" }));
    await screen.findByText("October 2026");
    expect(fetchSpy.mock.calls.some(([u]) => String(u).includes("/attendance?month=2026-10"))).toBe(true);
  });

  it("disables every day in a future month", async () => {
    renderPage(["attendance.view", "attendance.editHistory"]);
    await screen.findByText("September 2026");
    await userEvent.click(screen.getByRole("button", { name: "Next" }));
    await screen.findByText("October 2026");
    const day1 = await screen.findByRole("button", { name: "1" });
    expect(day1).toBeDisabled();
  });

  it("shows the monthly summary and updates it when the month changes", async () => {
    renderPage(["attendance.view", "attendance.editHistory"]);
    // September 2026: schedule is Mon–Fri, "today" (pinned) is the 29th — 21 scheduled weekdays have
    // occurred by then. The mocked month data has exactly one record: 2026-09-15 → PRESENT.
    await screen.findByText("5% attendance");
    expect(screen.getByText(/Present\s*1/)).toBeInTheDocument();
    expect(screen.getByText(/Not yet marked\s*20/)).toBeInTheDocument();

    // October 2026 is entirely in the future relative to the pinned "today" — nothing has occurred
    // yet, so the rate is unknown rather than a misleading 0%.
    await userEvent.click(screen.getByRole("button", { name: "Next" }));
    await screen.findByText("— attendance");
  });

  it("confirms and posts to the bulk endpoint when 'Mark remaining as present' is clicked", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    vi.spyOn(window, "confirm").mockReturnValue(true);
    renderPage(["attendance.view", "attendance.mark", "attendance.editHistory"]);
    const button = await screen.findByRole("button", { name: "Mark 20 remaining as present" });
    await userEvent.click(button);
    expect(window.confirm).toHaveBeenCalledWith("Mark 20 remaining day(s) as present?");
    const postCall = fetchSpy.mock.calls.find(([u, init]) => String(u).includes("/attendance/remaining-present") && (init as RequestInit | undefined)?.method === "POST");
    expect(postCall).toBeDefined();
    expect(JSON.parse((postCall![1] as RequestInit).body as string)).toEqual({ month: "2026-09" });
  });

  it("hides the mark-remaining button without attendance.editHistory", async () => {
    renderPage(["attendance.view", "attendance.mark"]);
    await screen.findByText("Sunita's attendance");
    expect(screen.queryByRole("button", { name: /Mark \d+ remaining as present/ })).not.toBeInTheDocument();
  });
});
