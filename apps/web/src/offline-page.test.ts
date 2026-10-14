import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

// jsdom's global `URL` (active in this test environment) parses `new URL(relative, import.meta.url)`
// differently from Node's `node:url`, so `fileURLToPath` rejects the result — resolve via cwd instead.
const html = readFileSync(resolve(process.cwd(), "public/offline.html"), "utf-8");

describe("offline fallback page", () => {
  it("tells the user they're offline", () => {
    expect(html).toContain("You're offline");
  });

  it("has a retry button that reloads the page", () => {
    const doc = new DOMParser().parseFromString(html, "text/html");
    const retry = doc.getElementById("retry");
    expect(retry).toBeTruthy();
    expect(retry?.getAttribute("onclick")).toBe("location.reload()");
  });
});
