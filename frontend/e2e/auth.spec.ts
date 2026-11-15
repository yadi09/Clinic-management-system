import { expect, test } from "@playwright/test";

import { login, stack } from "./stack";

test("REG-E2E-001 owner logs in and sees the dashboard", async ({ page }) => {
  await login(page, "owner");
  await expect(page).toHaveURL(/\/$/);
  await expect(page.getByRole("heading", { level: 1, name: /^Good (morning|afternoon|evening)/ })).toBeVisible();
  // Either the attention list or its all-clear line, never the load-error state.
  await expect(page.getByRole("heading", { name: "Needs you" }).or(page.getByText(/Nothing needs you right now/)).first())
    .toBeVisible();
  await expect(page.getByText(/Could not load/)).toHaveCount(0);
});

test("REG-E2E-005 a wrong password shows an error and stays on the login page", async ({ page }) => {
  const s = stack();
  // Step one through the form: the clinic code, then that clinic's sign-in.
  await page.goto("/login");
  await page.locator("#workspace").fill(s.slug.toUpperCase());
  await page.getByRole("button", { name: "Continue" }).click();
  await page.locator("#email").fill(s.ownerEmail);
  await page.locator("#password").fill("definitely-not-the-password");
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByRole("alert")).toBeVisible();
  await expect(page).toHaveURL(/\/login/);
  await expect(page.getByRole("button", { name: "Sign in" })).toBeEnabled();
});
