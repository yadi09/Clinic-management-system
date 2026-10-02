// Dental journeys a clinic lives on, in a real browser against the real API.
//
// Each test arranges its own patient (and, where the journey starts mid-way, its
// own treatment) through the API, then does the part under test through the UI the
// way staff do. Selectors are roles and visible words only.
import { expect, test, type Page } from "@playwright/test";

import { apiAs, login, uniq } from "./stack";

const iso = (offsetDays = 0) => {
  const d = new Date();
  d.setDate(d.getDate() + offsetDays);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};

interface Plan { id: string; sessions: { id: string; seq: number; scheduled_date: string }[] }

async function newPatient(first = uniq("Meron")) {
  const api = await apiAs("receptionist");
  const p = await api<{ id: string }>("POST", "/patients", {
    first_name: first, last_name: uniq("Ayele"), gender: "female", dob: "1990-01-15", force: true,
  });
  return { id: p.id, first };
}

/** A treatment, created by the doctor through the API, with visits on these days. */
async function newPlan(patientId: string, title: string, days: number[], fee = "1500") {
  const doctor = await apiAs("doctor");
  const sessions = days.map((d) => ({ scheduled_date: iso(d), amount_due: fee }));
  const plan = await doctor<Plan>("POST", `/dental/patients/${patientId}/plans`, {
    title, total_amount: String(Number(fee) * days.length), start_date: sessions[0].scheduled_date,
    interval_unit: "week", interval_count: 1, session_count: days.length, deposit: "0", sessions,
  });
  const summary = await doctor<{ plans: Plan[] }>("GET", `/dental/patients/${patientId}/summary`);
  const full = summary.plans.find((p) => p.id === plan.id)!;
  full.sessions.sort((a, b) => a.scheduled_date.localeCompare(b.scheduled_date) || a.seq - b.seq);
  return { plan: full, doctor };
}

const cardHeading = (page: Page) => page.getByRole("heading", { level: 3, name: /^(Next: visit|Visit) \d/ });

test("REG-E2E-010 doctor starts a treatment from the card and sees visit 1 booked today", async ({ page }) => {
  const p = await newPatient();
  const title = uniq("Root canal ");
  await login(page, "doctor");
  await page.goto(`/patients/${p.id}`);
  await page.getByRole("button", { name: "Start a treatment" }).click();

  const dlg = page.getByRole("dialog", { name: "New treatment plan" });
  // A combobox takes no name from its text, so it is found by the words it shows.
  await dlg.getByRole("combobox").filter({ hasText: "e.g. Root canal" }).click();
  await page.getByPlaceholder("Search the clinic's list…").fill(title);
  await page.getByRole("button", { name: new RegExp(`Use “${title}” without a price`) }).click();
  // The form's labels are not tied to their inputs, so each field is found inside
  // the smallest block that carries its label.
  const field = (label: string) =>
    dlg.locator("div").filter({ has: page.getByText(label, { exact: true }) }).last().getByRole("spinbutton");
  await field("Total cost (ETB)").fill("4500");
  await field("Sessions").fill("3");
  await dlg.getByRole("button", { name: "Create plan" }).click();
  await expect(dlg).toBeHidden();

  await expect(cardHeading(page)).toHaveText("Visit 1 of 3");
  await expect(page.getByText(title, { exact: true }).first()).toBeVisible();
  await expect(page.getByRole("button", { name: "Start visit 1" })).toBeVisible();
  await expect(page.getByText(/Takes the 1,500 ETB fee first/)).toBeVisible();
});

test("REG-E2E-011 doctor records visit 1 on a promise to pay, and the card shows it done", async ({ page }) => {
  const p = await newPatient();
  await newPlan(p.id, "Scaling", [0, 14]);
  await login(page, "doctor");
  await page.goto(`/patients/${p.id}`);

  await page.getByRole("button", { name: "Start visit 1" }).click();
  // Fee first: until it is settled or promised, the notes stay closed.
  await expect(page.getByText("Then the treatment notes")).toBeVisible();
  await page.getByRole("button", { name: "Treat now, pay later" }).click();
  const ask = page.getByRole("dialog", { name: "Treat now, pay later?" });
  await ask.getByPlaceholder(/Next visit/).fill("Next visit");
  await ask.getByRole("button", { name: "Treat now, pay later" }).click();
  await expect(ask).toBeHidden();

  await page.getByPlaceholder(/Crown cemented/).fill("Full-mouth scaling done. Review in two weeks.");
  await page.getByRole("button", { name: /Save & mark done/ }).click();

  await expect(page.getByText("Visit recorded")).toBeVisible();
  // The card moves on to the next step; visit 1 now reads done, and owed (promised).
  await expect(cardHeading(page)).toHaveText(/^Visit 2 of 2/);
  await expect(page.getByRole("button", { name: /^Visit 1, done, .*, owed$/ }).first()).toBeAttached();
  await expect(page.getByText("Last time: visit 1", { exact: false })).toBeVisible();
  // Read back on the card (and again in the unpaid-work callout, which lists it).
  await expect(page.getByText("Full-mouth scaling done. Review in two weeks.").first()).toBeVisible();

  // Survives a reload, and opening visit 1 reads it back as done.
  await page.reload();
  await page.getByRole("button", { name: /^Visit 1, done, .*, owed$/ }).filter({ visible: true }).first().click();
  await expect(cardHeading(page)).toHaveText("Visit 1 of 2 is done");
  await expect(page.getByText("Full-mouth scaling done. Review in two weeks.").first()).toBeVisible();
});

test("REG-E2E-012 the cashier takes the payment and the patient owes nothing for treatment", async ({ page }) => {
  const p = await newPatient(uniq("Tigist"));
  const { plan, doctor } = await newPlan(p.id, "Filling", [0, 21], "1200");
  const v1 = plan.sessions[0].id;
  await doctor("PUT", `/dental/patients/${p.id}/sessions/${v1}`, { status: "done", procedure: "Composite filling", tooth: "UR6", notes: "" });
  await doctor("POST", `/dental/patients/${p.id}/sessions/${v1}/collect`);

  await login(page, "cashier");
  await page.goto("/cashier");
  const checkout = page.getByText(p.first, { exact: false }).first().locator("xpath=ancestor::*[.//button[starts-with(normalize-space(.), 'Take payment')]][1]");
  await expect(checkout).toBeVisible();
  await expect(checkout).toContainText("1200");
  await checkout.getByRole("button", { name: /^Take payment/ }).click();
  await expect(page.getByText(/^Paid ETB/).first()).toBeVisible();

  await login(page, "doctor");
  await page.goto(`/patients/${p.id}?visit=${v1}`);
  await expect(cardHeading(page)).toHaveText("Visit 1 of 2 is done");
  await expect(page.getByRole("button", { name: /^Visit 1, done, .*, paid$/ }).first()).toBeAttached();
  await page.getByRole("button", { name: /^Money/ }).click();
  await expect(page.getByText("Nothing is outstanding for treatment given.")).toBeVisible();
  await expect(page.getByText("Owed now for treatment").locator("xpath=following-sibling::p[1]")).toHaveText("0 ETB");
});

test("REG-E2E-013 a tooth set on the chart is still there after a reload", async ({ page }) => {
  const p = await newPatient();
  await login(page, "doctor");
  await page.goto(`/patients/${p.id}`);
  await page.getByRole("button", { name: /^Tooth chart/ }).click();
  const ur6 = page.getByRole("button", { name: /^UR6( —|$)/ });
  await expect(ur6).toBeEnabled();
  await expect(ur6).toHaveAccessibleName("UR6");

  const saved = page.waitForResponse((r) => r.url().includes(`/dental/patients/${p.id}/chart`) && r.request().method() === "PUT");
  await ur6.click();
  await expect(ur6).toHaveAccessibleName(/^UR6 — .+/);
  const label = await ur6.getAttribute("aria-label");
  expect((await saved).ok()).toBe(true);

  await page.reload();
  await page.getByRole("button", { name: /^Tooth chart/ }).click();
  await expect(page.getByRole("button", { name: /^UR6( —|$)/ })).toHaveAccessibleName(label!);
});

test("REG-E2E-014 a missed visit is on Follow-ups → Missed, and Rebook opens the reschedule dialog", async ({ page }) => {
  const p = await newPatient(uniq("Lidya"));
  const title = uniq("Root canal ");
  await newPlan(p.id, title, [-10, 20]);
  await login(page, "receptionist");
  await page.goto(`/appointments?view=followups&tab=missed&patient=${p.id}`);

  const tabs = page.getByRole("tablist", { name: "Follow-ups" });
  await expect(tabs.getByRole("tab", { name: /Missed/ })).toHaveAttribute("aria-selected", "true");
  const row = page.getByRole("button", { name: new RegExp(`${p.first}.*${title} · visit 1 of 2`) });
  await expect(row).toBeVisible();
  await expect(page.getByText("missed 10 days ago")).toBeVisible();

  await page.getByRole("button", { name: "Rebook visit 1" }).click();
  const dlg = page.getByRole("dialog", { name: /Reschedule visit/ });
  await expect(dlg).toBeVisible();
  await expect(dlg.getByText(title)).toBeVisible();
  await expect(dlg.getByText(/missed 10 days ago/)).toBeVisible();
});
