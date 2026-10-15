import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { SearchInput } from "./SearchInput";

const navigateSpy = vi.fn();

vi.mock("react-router-dom", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react-router-dom")>();
  // SearchInput lives in AppShell and never unmounts across navigation. This mock simulates the
  // real failure mode: useNavigate() returning a fresh function identity on every call (for
  // whatever reason — AppShell re-rendering on route change, etc.) used to re-fire the effect
  // and silently navigate back to the stale search term on every subsequent navigation.
  return { ...actual, useNavigate: () => (...args: unknown[]) => navigateSpy(...args) };
});

describe("SearchInput", () => {
  beforeEach(() => { navigateSpy.mockClear(); });

  it("does not re-navigate for the same search term when its own navigate reference changes on a later re-render", async () => {
    const { rerender } = render(<MemoryRouter><SearchInput /></MemoryRouter>);
    const input = screen.getByPlaceholderText("Search");
    fireEvent.change(input, { target: { value: "bhag" } });
    await new Promise((r) => setTimeout(r, 350));
    expect(navigateSpy).toHaveBeenCalledTimes(1);
    expect(navigateSpy).toHaveBeenCalledWith("/search?q=bhag");

    rerender(<MemoryRouter><SearchInput /></MemoryRouter>);
    await new Promise((r) => setTimeout(r, 50));
    expect(navigateSpy).toHaveBeenCalledTimes(1);
  });

  it("navigates again for a genuinely new search term", async () => {
    render(<MemoryRouter><SearchInput /></MemoryRouter>);
    const input = screen.getByPlaceholderText("Search");
    fireEvent.change(input, { target: { value: "bhag" } });
    await new Promise((r) => setTimeout(r, 350));
    fireEvent.change(input, { target: { value: "raju" } });
    await new Promise((r) => setTimeout(r, 350));

    expect(navigateSpy).toHaveBeenCalledTimes(2);
    expect(navigateSpy).toHaveBeenNthCalledWith(1, "/search?q=bhag");
    expect(navigateSpy).toHaveBeenNthCalledWith(2, "/search?q=raju");
  });
});
