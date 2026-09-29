import { defineConfig, devices } from "@playwright/test";

/**
 * End-to-end tests run the real stack: built API + Postgres + Vite dev server.
 * Prerequisites: Postgres running, `npm run db:migrate && npm run db:seed`, apps/api/.env present.
 */
export default defineConfig({
  testDir: "./e2e",
  fullyParallel: false,
  retries: process.env.CI ? 1 : 0,
  reporter: [["list"], ["html", { open: "never" }]],
  use: { baseURL: "http://localhost:5173", timezoneId: "Asia/Kolkata", trace: "retain-on-failure" },
  projects: [
    { name: "mobile-android", use: { ...devices["Pixel 7"] } },
    { name: "mobile-iphone", use: { ...devices["iPhone 14"], browserName: "chromium" } },
    { name: "desktop", use: { ...devices["Desktop Chrome"], viewport: { width: 1280, height: 820 } } },
  ],
  webServer: [
    { command: "npm run build -w @household/shared && npm run build -w @household/api && npm run start -w @household/api", url: "http://localhost:4000/api/health/ready", reuseExistingServer: !process.env.CI, timeout: 120_000 },
    { command: "npm run dev -w @household/web", url: "http://localhost:5173", reuseExistingServer: !process.env.CI, timeout: 60_000 },
  ],
});
