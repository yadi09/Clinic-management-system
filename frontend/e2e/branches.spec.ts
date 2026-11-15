// Branches as separate workspaces, in a real browser against the real API: the owner
// moves between a clinic's branches from the top bar, and each branch shows only its
// own patients. The spec provisions a clinic of its own through the vendor console API,
// so the shared e2e clinic (and every other spec) is untouched.
import { expect, test } from "@playwright/test";

import { dismissSignInDialog, platformApi, stack, uniq } from "./stack";

test("REG-E2E-040 the owner moves between branches from the top bar; each branch shows only its own patients", async ({ page }) => {
  test.setTimeout(120_000);
  const s = stack();
  const vendor = await platformApi();
  const slug = uniq("brw-");
  const owner = `owner@${slug}.test`;
  const made = await vendor<{ clinic: { id: string } }>("POST", "/platform/clinics", {
    clinic_name: "Selam Dental", slug, owner_name: "Selam Owner", owner_email: owner, owner_password: s.password, clinic_type: "dental",
  });
  await vendor("POST", `/platform/clinics/${made.clinic.id}/plan`, {
    plan_id: (await vendor<{ id: string; code: string }[]>("GET", "/platform/plans")).find((p) => p.code)!.id,
    storage_gb_override: null, patient_limit_override: null, user_limit_override: null, branch_limit_override: 3,
  });
  const branchSlug = `${slug}-bole`;
  await vendor("POST", `/platform/clinics/${made.clinic.id}/branches`, { name: "Selam Dental — Bole", slug: branchSlug });

  // A patient at the main branch, registered through the API.
  const login = await fetch(`${s.apiBase}/auth/login`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ workspace: slug, email: owner, password: s.password }) });
  const tok = ((await login.json()) as { data: { access_token: string } }).data.access_token;
  const mainPatient = uniq("Abebe");
  const reg = await fetch(`${s.apiBase}/patients`, {
    method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${tok}` },
    body: JSON.stringify({ first_name: mainPatient, last_name: "Main", gender: "male", dob: "1990-01-01", force: true }),
  });
  expect(reg.ok).toBe(true);

  await page.goto(`/login/${slug}`);
  await page.locator("#email").fill(owner);
  await page.locator("#password").fill(s.password);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).not.toHaveURL(/\/login/);
  await dismissSignInDialog(page);

  const switcher = page.getByRole("button", { name: "Switch branch" });
  await expect(switcher).toContainText("Selam Dental");
  await page.goto(`/patients?q=${mainPatient}`);
  await expect(page.getByText(`${mainPatient} Main`).filter({ visible: true }).first()).toBeVisible();

  // Into the branch: the app starts over there, and the main branch's patient is not here.
  await page.getByRole("button", { name: "Switch branch" }).click();
  await page.getByRole("menuitem", { name: /Bole/ }).click();
  await expect(page.getByRole("button", { name: "Switch branch" })).toContainText("Bole");
  await dismissSignInDialog(page);
  await page.goto(`/patients?q=${mainPatient}`);
  await expect(page.getByText(`${mainPatient} Main`).filter({ visible: true })).toHaveCount(0);
  await expect(page.getByText(/0 registered|No patients/i).first()).toBeVisible();
  // A reload stays in the branch: the session moved with the switch.
  await page.reload();
  await expect(page.getByRole("button", { name: "Switch branch" })).toContainText("Bole");

  // And back.
  await page.getByRole("button", { name: "Switch branch" }).click();
  await page.getByRole("menuitem", { name: /^Selam Dental/ }).first().click();
  await expect(page.getByRole("button", { name: "Switch branch" })).not.toContainText("Bole");
  await dismissSignInDialog(page);
  await page.goto(`/patients?q=${mainPatient}`);
  await expect(page.getByText(`${mainPatient} Main`).filter({ visible: true }).first()).toBeVisible();
});
