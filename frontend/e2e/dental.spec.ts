// Dental journeys a clinic lives on, in a real browser against the real API.
//
// Each test arranges its own patient (and, where the journey starts mid-way, its
// own treatment) through the API, then does the part under test through the UI the
// way staff do. Selectors are roles and visible words only.
import { expect, test, type Page } from "@playwright/test";

import { apiAs, login, uniq } from "./stack";

// A date on the clinic's calendar (Addis), the same calendar the browser runs on
// (playwright.config.ts timezoneId). The test process itself runs on the host's zone,
// so a plain new Date() here disagreed with the browser for part of every night.
const iso = (offsetDays = 0) => {
  const today = new Intl.DateTimeFormat("en-CA", { timeZone: "Africa/Addis_Ababa" }).format(new Date());
  const d = new Date(`${today}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + offsetDays);
  return d.toISOString().slice(0, 10);
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
  // Pick a condition, then tap the tooth: no cycling.
  await page.getByRole("group", { name: "Conditions" }).getByRole("button", { name: /^Healthy$/ }).click();
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

const chartChips = (page: import("@playwright/test").Page) => page.getByRole("group", { name: "Conditions" });
const tooth = (page: import("@playwright/test").Page, code: string) => page.getByRole("button", { name: new RegExp(`^${code}( —|$)`) });

test("REG-E2E-021 a whole mouth is charted in a few taps, survives a reload, and can be cleared and undone", async ({ page }) => {
  const p = await newPatient();
  await login(page, "doctor");
  await page.goto(`/patients/${p.id}`);
  await page.getByRole("button", { name: /^Tooth chart/ }).click();
  await expect(tooth(page, "UR1")).toBeEnabled();

  // Two decayed teeth and one extracted, then everything else healthy.
  await chartChips(page).getByRole("button", { name: /^Decayed$/ }).click();
  await tooth(page, "UR6").click();
  await tooth(page, "LL5").click();
  await chartChips(page).getByRole("button", { name: /^Extracted$/ }).click();
  await tooth(page, "UL8").click();
  await page.getByRole("tab", { name: "Select" }).click();
  await page.getByRole("group", { name: "Quick selects" }).getByRole("button", { name: "Not marked" }).click();
  await expect(page.getByText("29 teeth selected")).toBeVisible();
  const saved = page.waitForResponse((r) => r.url().includes(`/dental/patients/${p.id}/chart`) && r.request().method() === "PUT"
    && (r.request().postData() ?? "").includes("UR1"));
  await chartChips(page).getByRole("button", { name: /^Healthy$/ }).click();
  expect((await saved).ok()).toBe(true);
  await expect(tooth(page, "UR1")).toHaveAccessibleName("UR1 — Healthy");
  await expect(tooth(page, "UR6")).toHaveAccessibleName("UR6 — Decayed");
  await expect(page.getByText(/32 marked: 29 Healthy/)).toBeVisible();

  await page.reload();
  await page.getByRole("button", { name: /^Tooth chart/ }).click();
  await expect(tooth(page, "LL5")).toHaveAccessibleName("LL5 — Decayed");
  await expect(tooth(page, "UL8")).toHaveAccessibleName("UL8 — Extracted");

  // Clear it all, then take it back.
  await page.getByRole("button", { name: "Clear all" }).click();
  const cleared = page.waitForResponse((r) => r.url().includes(`/dental/patients/${p.id}/chart`) && r.request().method() === "PUT");
  await page.getByRole("button", { name: /^Clear 32 marks$/ }).click();
  expect((await cleared).ok()).toBe(true);
  await expect(tooth(page, "UR6")).toHaveAccessibleName("UR6");
  const back = page.waitForResponse((r) => r.url().includes(`/dental/patients/${p.id}/chart`) && r.request().method() === "PUT");
  await page.getByRole("button", { name: "Undo" }).first().click();
  expect((await back).ok()).toBe(true);
  await expect(tooth(page, "UR6")).toHaveAccessibleName("UR6 — Decayed");
});

test("REG-E2E-022 on a phone the condition bar is at the bottom and a tap on a tooth with nothing chosen offers a menu", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const p = await newPatient();
  await login(page, "doctor");
  await page.goto(`/patients/${p.id}`);
  await page.getByRole("button", { name: /^Tooth chart/ }).click();
  await expect(tooth(page, "UR1")).toBeEnabled();
  const bar = chartChips(page);
  await expect(bar).toBeVisible();
  const chart = await tooth(page, "UR1").boundingBox();
  const barBox = await bar.boundingBox();
  expect(barBox!.y).toBeGreaterThan(chart!.y);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);

  await tooth(page, "LR3").click();
  await page.getByRole("menuitem", { name: "Filled" }).click();
  await expect(tooth(page, "LR3")).toHaveAccessibleName("LR3 — Filled");
});

test("REG-E2E-023 an extra added at the chair is sent to the cashier, paid there, and the chair turns green by itself", async ({ page }) => {
  const p = await newPatient(uniq("Hana"));
  const { plan, doctor } = await newPlan(p.id, "Filling", [0, 14], "1000");
  const v1 = plan.sessions[0].id;
  const svc = await doctor<{ id: string }>("POST", "/billing/services", {
    code: uniq("XR"), name: uniq("Periapical X-ray "), category: "dental", price: 2000, assignable_by: "either",
  });
  await doctor("POST", `/dental/patients/${p.id}/sessions/${v1}/extras`, { service_id: svc.id });

  await login(page, "doctor");
  await page.goto(`/patients/${p.id}`);
  await page.getByRole("button", { name: "Start visit 1" }).click();
  // The visit's own fee on a promise, so the record form opens.
  await page.getByRole("button", { name: "Treat now, pay later" }).click();
  const ask = page.getByRole("dialog", { name: "Treat now, pay later?" });
  await ask.getByPlaceholder(/Next visit/).fill("Next visit");
  await ask.getByRole("button", { name: "Treat now, pay later" }).click();
  await expect(ask).toBeHidden();

  // The extra is there, not billed, with the button that was missing.
  await expect(page.getByText("Also done at this visit")).toBeVisible();
  await expect(page.getByText("Not billed", { exact: true })).toBeVisible();
  await page.getByRole("list", { name: "Payment progress" }).locator("xpath=ancestor::div[contains(@class,'rounded-lg')][1]")
    .getByRole("button", { name: /Send to cashier/ }).click();
  await expect(page.getByText(/Waiting for the patient to pay at the cashier/)).toBeVisible();

  // The cashier takes the money (through the API, as another person would at the desk).
  const cashier = await apiAs("cashier");
  const pending = await cashier<{ id: string; patient_id: string }[]>("GET", "/billing/charges/pending");
  const mine = pending.filter((c) => c.patient_id === p.id).map((c) => c.id);
  expect(mine.length).toBeGreaterThan(0);
  await cashier("POST", "/billing/checkout", { patient_id: p.id, method: "cash", charge_ids: mine });

  // No reload: the chair finds out within a few seconds.
  await expect(page.getByText("✓ Paid — go ahead")).toBeVisible({ timeout: 20_000 });
});
