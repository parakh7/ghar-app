import { expect, test } from "@playwright/test";

const password = "correct horse battery";

test("new user: sign up → name household → home → sign out → session revoked", async ({ page }) => {
  const email = `e2e-${Date.now()}-${Math.random().toString(36).slice(2, 7)}@example.com`;
  const consoleErrors: string[] = [];
  page.on("pageerror", (e) => consoleErrors.push(e.message));

  await page.goto("/");
  await expect(page).toHaveURL(/\/signin$/);

  await page.getByRole("link", { name: "Create an account" }).click();
  await page.getByLabel("Your name").fill("Parakh Shah");
  await page.getByLabel("Email").fill(email);

  // client-side validation before any request
  await page.getByRole("button", { name: "Create account" }).click();
  await expect(page.getByText("Use at least 8 characters")).toBeVisible();

  await page.getByLabel("Password", { exact: true }).fill(password);
  await page.getByRole("button", { name: "Create account" }).click();

  await expect(page).toHaveURL(/\/onboarding$/);
  await expect(page.getByLabel("Household name")).toHaveValue("Shah Family"); // suggested from surname
  await page.getByRole("button", { name: "Continue" }).click();

  await expect(page).toHaveURL(/\/$/);
  await expect(page.getByText("Today at Shah Family")).toBeVisible();
  await expect(page.getByText("Confirm your email")).toBeVisible();

  await page.getByRole("link", { name: "More" }).click();
  await expect(page.getByRole("radio", { name: /Shah Family/ })).toHaveAttribute("aria-checked", "true");
  await page.getByRole("button", { name: "Sign out" }).click();
  await expect(page).toHaveURL(/\/signin$/);

  const me = await page.request.get("/api/auth/me");
  expect(me.status()).toBe(401);
  expect(consoleErrors).toEqual([]);
});

test("seeded user signs in and lands on Shah Family", async ({ page }) => {
  await page.goto("/signin");
  await page.getByLabel("Email").fill("parakh@example.com");
  await page.getByLabel("Password", { exact: true }).fill("demo-password-123");
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).toHaveURL(/\/$/);
  await expect(page.getByText("Today at Shah Family")).toBeVisible();
  await expect(page.getByText("Confirm your email")).toHaveCount(0); // seed users are verified
});

test("wrong password shows a friendly error and stays on sign-in", async ({ page }) => {
  await page.goto("/signin");
  await page.getByLabel("Email").fill("parakh@example.com");
  await page.getByLabel("Password", { exact: true }).fill("definitely-wrong");
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByRole("alert")).toHaveText("Email or password is incorrect.");
  await expect(page).toHaveURL(/\/signin$/);
});

test("signed-out users are sent to sign-in and returned afterwards", async ({ page }) => {
  await page.goto("/more");
  await expect(page).toHaveURL(/\/signin$/);
  await page.getByLabel("Email").fill("parakh@example.com");
  await page.getByLabel("Password", { exact: true }).fill("demo-password-123");
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).toHaveURL(/\/more$/);
});

test("forgot password never reveals whether an account exists", async ({ page }) => {
  await page.goto("/forgot-password");
  await page.getByLabel("Email").fill("nobody-here@example.com");
  await page.getByRole("button", { name: "Send reset link" }).click();
  await expect(page.getByText("Check your email")).toBeVisible();
});
