// The front desk, in a real browser: a patient with an earlier unpaid bill is found by
// search, the receptionist ticks the bill the patient agrees to pay and sends them to
// the cashier, and the cashier sees why the patient is there.
import { expect, test } from "@playwright/test";

import { apiAs, login, uniq } from "./stack";

test("REG-E2E-020 reception ticks an earlier bill, the cashier sees it was agreed at the desk", async ({ page }) => {
  const reception = await apiAs("receptionist");
  const first = uniq("Selam");
  const p = await reception<{ id: string }>("POST", "/patients", {
    first_name: first, last_name: uniq("Bekele"), gender: "female", dob: "1988-04-02", force: true,
  });
  const desc = uniq("Old extraction ");
  await reception("POST", "/billing/charges", { patient_id: p.id, source: "service", description: desc, amount: 640 });

  await login(page, "receptionist");
  await page.goto("/reception");
  await page.getByPlaceholder(/Search any patient/).fill(first);
  await page.getByRole("button", { name: new RegExp(first) }).click();

  // The card itemises the bill, nothing ticked, and says what it covers.
  const box = page.getByRole("checkbox", { name: new RegExp(desc) });
  await expect(box).toBeVisible();
  await expect(box).not.toBeChecked();
  await expect(page.getByText("No missed visits in the last 90 days.")).toBeVisible();
  await box.check();

  // Route the patient, then send to the cashier.
  const combos = page.getByRole("combobox");
  await combos.nth(0).click();
  await page.getByRole("option").first().click();
  await combos.nth(1).click();
  await page.getByRole("option").first().click();
  await page.getByRole("button", { name: /Send to cashier/ }).first().click();
  await expect(page.getByText(/sent to the cashier/i).first()).toBeVisible();

  // The cashier's worklist says why this patient is here.
  const cashier = await apiAs("cashier");
  const pending = await cashier<{ id: string; description: string; desk_selected: boolean }[]>("GET", "/billing/charges/pending");
  const ticked = pending.find((c) => c.description === desc);
  expect(ticked?.desk_selected).toBe(true);

  await login(page, "cashier");
  await page.goto("/cashier");
  await expect(page.getByText(/Agreed at reception/).first()).toBeVisible();
  await expect(page.getByText("Picked at reception").first()).toBeVisible();
});
