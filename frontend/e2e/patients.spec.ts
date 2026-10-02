import { expect, test } from "@playwright/test";

import { apiAs, login, uniq } from "./stack";

test("REG-E2E-002 receptionist registers a new patient and finds them in search", async ({ page }) => {
  const first = uniq("Selam");
  const last = uniq("Tadesse");
  await login(page, "receptionist");

  await page.goto("/patients/new");
  // The register form's labels are not tied to inputs, so fields are found by name.
  await page.locator('input[name="first_name"]').fill(first);
  await page.locator('input[name="last_name"]').fill(last);
  await page.getByRole("textbox", { name: "Age in years" }).fill("34");
  await page.getByRole("button", { name: "Continue" }).click();
  await page.locator('input[name="phone"]').fill("0911" + String(Date.now()).slice(-6));
  await page.getByRole("button", { name: "Continue" }).click();
  await page.getByRole("button", { name: "Register patient" }).click();

  await expect(page).toHaveURL(/\/patients\/[^/]+$/);
  await expect(page.getByText(/Patient registered/)).toBeVisible();

  await page.goto("/patients");
  await page.getByPlaceholder("Name, MRN, or phone").fill(first);
  // The list renders both a phone layout and a table; only one is visible.
  await expect(page.getByText(new RegExp(`${first}.*${last}`)).filter({ visible: true }).first()).toBeVisible();
});

test("REG-E2E-003 doctor opens a dental patient and sees the visit card", async ({ page }) => {
  const api = await apiAs("receptionist");
  const p = await api<{ id: string }>("POST", "/patients", {
    first_name: uniq("Hana"), last_name: uniq("Girma"), gender: "female", dob: "1992-03-04", force: true,
  });
  await login(page, "doctor");
  await page.goto(`/patients/${p.id}`);
  await expect(page.getByText("No treatment in progress")).toBeVisible();
  await expect(page.getByRole("button", { name: "Start a treatment" })).toBeVisible();
});
