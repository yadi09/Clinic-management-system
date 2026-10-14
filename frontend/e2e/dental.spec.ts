// Dental journeys a clinic lives on, in a real browser against the real API.
//
// Each test arranges its own patient (and, where the journey starts mid-way, its
// own treatment) through the API, then does the part under test through the UI the
// way staff do. Selectors are roles and visible words only.
import { expect, test, type Page } from "@playwright/test";

import { apiAs, login, stack, uniq } from "./stack";

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

/** Which tooth chart the test clinic draws on — the clinic admin's setting. */
async function chartStyle(style: "simple" | "anatomical") {
  const owner = await apiAs("owner");
  await owner("PUT", "/dental/settings", { chart_style: style });
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
  await chartStyle("simple");
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
  await chartStyle("simple");
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
  await chartStyle("simple");
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

test("REG-E2E-024 anyone with the paper can check a prescription without an account, and sees it cancelled once the clinic withdraws it", async ({ browser }, testInfo) => {
  const p = await newPatient(uniq("Abebe"));
  const { plan, doctor } = await newPlan(p.id, "Extraction", [0]);
  const rx = await doctor<{ id: string }>("POST", `/dental/patients/${p.id}/sessions/${plan.sessions[0].id}/prescriptions`, {
    note: "After extraction", items: [
      { drug_name: "Amoxicillin 500 mg", dose: "1 capsule", frequency: "3 times a day", duration: "7 days" },
      { drug_name: "Ibuprofen 400 mg", dose: "1 tablet", frequency: "3 times a day", duration: "3 days" },
    ],
  });
  // What the print screen does while the paper is being printed.
  const issued = await doctor<{ path: string; code: string; slug: string }>("POST", "/verify/issue", { kind: "dental_rx", id: rx.id });

  // A pharmacist: a phone with no account, signed in nowhere.
  const context = await browser.newContext({
    baseURL: testInfo.project.use.baseURL, viewport: { width: 390, height: 844 }, timezoneId: "Africa/Addis_Ababa",
  });
  const phone = await context.newPage();
  await phone.goto(issued.path);
  await expect(phone.getByRole("heading", { name: "Genuine prescription" })).toBeVisible();
  await expect(phone.getByText("Amoxicillin 500 mg")).toBeVisible();
  await expect(phone.getByText("Ibuprofen 400 mg")).toBeVisible();
  await expect(phone.getByText(/7 days/).first()).toBeVisible();
  // Not the surname, the card number or the phone: first name and an initial.
  await expect(phone.getByText(new RegExp(`^${p.first} [A-Z]\\.`))).toBeVisible();

  // The same paper typed by hand, as when a camera will not read the QR.
  await phone.goto("/v");
  await phone.getByLabel(/Clinic/).fill(stack().slug);
  await phone.getByLabel(/Code/).fill(issued.code);
  await phone.getByRole("button", { name: "Check this paper" }).click();
  await expect(phone.getByRole("heading", { name: "Genuine prescription" })).toBeVisible();
  await expect(phone.getByText(/Checked once before/)).toBeVisible();

  // The doctor withdraws it; the same paper now says so and shows no medicines.
  await doctor("DELETE", `/dental/patients/${p.id}/prescriptions/${rx.id}`, { reason: "Wrong drug" });
  await phone.goto(issued.path);
  await expect(phone.getByRole("heading", { name: "Cancelled by the clinic" })).toBeVisible();
  await expect(phone.getByRole("status")).toContainText("Do not dispense.");
  await expect(phone.getByText("Amoxicillin 500 mg")).toHaveCount(0);
  await context.close();
});

// --- the anatomical chart ---------------------------------------------------------

const anat = (page: Page, n: number) => page.getByRole("button", { name: new RegExp(`^Tooth ${n},`) });
const anatTool = (page: Page, name: string) => page.getByRole("toolbar", { name: "Chart tools" }).getByRole("button", { name: new RegExp(`^${name}$`) });
const anatSurface = (page: Page, name: string) => page.getByRole("group", { name: "Tooth surfaces" }).getByRole("button", { name: new RegExp(`^${name}`) });
const anatInfo = (page: Page) => page.getByTestId("tooth-info");

test("REG-E2E-025 the admin turns on the anatomical chart; every condition, every position and gaps on both arches survive a reload", async ({ page, browser }, testInfo) => {
  await chartStyle("simple");
  // The admin chooses the chart in Settings, on their own computer.
  const adminCtx = await browser.newContext({ baseURL: testInfo.project.use.baseURL, timezoneId: "Africa/Addis_Ababa" });
  const admin = await adminCtx.newPage();
  await login(admin, "owner");
  await admin.goto("/settings?section=toothchart");
  const choice = admin.getByRole("radiogroup", { name: "Tooth chart" });
  await choice.getByRole("radio", { name: /^Anatomical/ }).click();
  await expect(choice.getByRole("radio", { name: /^Anatomical/ })).toHaveAttribute("aria-checked", "true");
  await adminCtx.close();

  const p = await newPatient();
  await login(page, "doctor");
  await page.goto(`/patients/${p.id}`);
  await page.getByRole("button", { name: /^Tooth chart/ }).click();
  await expect(page.getByRole("radio", { name: "Adult (32)" })).toHaveAttribute("aria-checked", "true");
  await expect(page.getByRole("button", { name: /^Tooth \d+,/ })).toHaveCount(32);

  const saved = () => page.waitForResponse((r) => r.url().includes(`/dental/patients/${p.id}/chart/anatomy`) && r.request().method() === "PUT");

  // Surfaces: caries and filling.
  await anat(page, 16).click();
  await anatTool(page, "Caries").click();
  await anatSurface(page, "Occlusal").click();
  await anatTool(page, "Filling").click();
  let s = saved();
  await anatSurface(page, "Mesial").click();
  expect((await s).ok()).toBe(true);
  // Whole tooth: crown, root canal, missing.
  await anat(page, 26).click();
  await anatTool(page, "Crown").click();
  s = saved();
  await anatTool(page, "Root canal").click();
  expect((await s).ok()).toBe(true);
  await anat(page, 46).click();
  s = saved();
  await anatTool(page, "Missing").click();
  expect((await s).ok()).toBe(true);
  // Every position slider on one tooth.
  await anat(page, 12).click();
  await page.getByLabel("Rotation").fill("35");
  await page.getByLabel("Tipping").fill("-10");
  await page.getByLabel("Buccal/lingual").fill("1.5");
  await page.getByLabel("Vertical").fill("-2.5");
  s = saved();
  await page.getByLabel("Gap (mesial)").fill("2");
  expect((await s).ok()).toBe(true);
  // Gaps on both sides of both arches.
  for (const [n, g] of [[11, "2"], [24, "1"], [35, "3"], [45, "1.5"]] as const) {
    await anat(page, n).click();
    s = saved();
    await page.getByLabel("Gap (mesial)").fill(g);
    expect((await s).ok()).toBe(true);
  }
  // The child chart is separate.
  await page.getByRole("radio", { name: "Child (20)" }).click();
  await expect(page.getByRole("button", { name: /^Tooth \d+,/ })).toHaveCount(20);
  await anat(page, 54).click();
  await anatTool(page, "Caries").click();
  s = saved();
  await anatSurface(page, "Distal").click();
  expect((await s).ok()).toBe(true);
  await page.getByRole("radio", { name: "Adult (32)" }).click();
  await page.locator(".tooth-anatomy").screenshot({ path: testInfo.outputPath("anatomical-adult.png") });

  // Reload: everything is still there.
  await page.reload();
  await page.getByRole("button", { name: /^Tooth chart/ }).click();
  await anat(page, 16).click();
  await expect(anatInfo(page)).toHaveText("Upper right first molar. caries (occlusal), filling (mesial)");
  await anat(page, 26).click();
  await expect(anatInfo(page)).toHaveText("Upper left first molar. crown, root canal");
  await anat(page, 46).click();
  await expect(anatInfo(page)).toHaveText("Lower right first molar. missing");
  await anat(page, 12).click();
  await expect(anatInfo(page)).toHaveText("Upper right lateral incisor. rotated 35° clockwise, tipped 10° distally, 1.5mm buccal, 2.5mm intruded, 2mm gap on mesial side");
  for (const [n, g] of [[11, "2mm"], [24, "1mm"], [35, "3mm"], [45, "1.5mm"]] as const) {
    await anat(page, n).click();
    await expect(anatInfo(page)).toContainText(`${g} gap on mesial side`);
  }
  // The gap pills show the real size on the chart.
  for (const g of ["2mm", "1mm", "3mm", "1.5mm"]) await expect(page.locator(".tooth-anatomy svg text", { hasText: new RegExp(`^${g.replace(".", "\\.")}$`) }).first()).toBeVisible();
  await page.getByRole("radio", { name: "Child (20)" }).click();
  await anat(page, 54).click();
  await expect(anatInfo(page)).toHaveText("Upper right primary first molar. caries (distal)");

  // Switching the clinic back to the simple chart hides nothing.
  await chartStyle("simple");
  await page.reload();
  await page.getByRole("button", { name: /^Tooth chart/ }).click();
  const note = page.getByRole("region", { name: "Recorded on the anatomical chart" });
  await expect(note).toContainText("16 (UR6) Upper right first molar: caries (occlusal), filling (mesial)");
  await expect(note).toContainText("54 Upper right primary first molar: caries (distal)");
});

test("REG-E2E-026 on a phone the anatomical chart fits the screen and a tooth is chosen with a tap", async ({ page }, testInfo) => {
  await chartStyle("anatomical");
  await page.setViewportSize({ width: 390, height: 844 });
  const p = await newPatient();
  await login(page, "doctor");
  await page.goto(`/patients/${p.id}`);
  await page.getByRole("button", { name: /^Tooth chart/ }).click();
  const svg = page.getByRole("group", { name: "Adult tooth chart" });
  await expect(svg).toBeVisible();
  // The arches keep a tappable size and scroll in their own box…
  const scroller = page.locator(".ta-chart-scroll");
  const box = (await scroller.boundingBox())!;
  expect(box.x).toBeGreaterThanOrEqual(0);
  expect(box.x + box.width).toBeLessThanOrEqual(390);
  expect((await svg.boundingBox())!.width).toBeGreaterThanOrEqual(640);
  const slot = (await anat(page, 36).boundingBox())!;
  expect(slot.width).toBeGreaterThanOrEqual(16); // a fingertip, not a pixel
  // …and the page itself never scrolls sideways.
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  await anat(page, 28).click(); // the far end: scrolled to, then tapped — opens the editor
  const dlg = page.getByRole("dialog", { name: "Tooth chart" });
  await expect(dlg.getByText("Tooth 28", { exact: true })).toBeVisible();
  await dlg.getByRole("button", { name: /^Tooth 36,/ }).click();
  await expect(dlg.getByText("Tooth 36", { exact: true })).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath("anatomical-phone.png") });
  await chartStyle("simple");
});

test("REG-E2E-027 the chart and the selected tooth's controls are on screen together, on a laptop, a large monitor and in full screen", async ({ page }, testInfo) => {
  await chartStyle("anatomical");
  test.setTimeout(150_000); // two screen sizes and a phone, each with a save
  const p = await newPatient();
  await login(page, "doctor");
  const inView = async (loc: import("@playwright/test").Locator) => {
    const b = (await loc.boundingBox())!;
    const vp = page.viewportSize()!;
    return b.y >= 0 && b.y + b.height <= vp.height && b.x >= 0 && b.x + b.width <= vp.width;
  };
  for (const [w, h] of [[1366, 768], [1920, 1080]] as const) {
    await page.setViewportSize({ width: w, height: h });
    await page.goto(`/patients/${p.id}`);
    await page.getByRole("button", { name: /^Tooth chart/ }).click();
    await anat(page, 12).click();
    await page.getByRole("group", { name: "Adult tooth chart" }).scrollIntoViewIfNeeded();
    await page.getByLabel("Rotation").fill("35");
    // In the page: the tooth being moved and the slider moving it are both visible.
    expect(await inView(anat(page, 12))).toBe(true);
    expect(await inView(page.getByLabel("Rotation"))).toBe(true);
    await page.locator(".tooth-anatomy").first().screenshot({ path: testInfo.outputPath(`page-${w}.png`) });

    // Full screen: the whole chart AND every slider, with no scrolling at all.
    await page.getByRole("button", { name: "Full screen" }).click();
    const dlg = page.getByRole("dialog", { name: "Tooth chart" });
    await expect(dlg).toBeVisible();
    expect(await inView(dlg.getByRole("group", { name: "Adult tooth chart" }))).toBe(true);
    for (const label of ["Rotation", "Tipping", "Buccal/lingual", "Vertical", "Gap (mesial)"]) expect(await inView(dlg.getByLabel(label)), label).toBe(true);
    const s = page.waitForResponse((r) => r.url().includes(`/dental/patients/${p.id}/chart/anatomy`) && r.request().method() === "PUT");
    const gap = w === 1366 ? "2" : "3"; // a new value each time, or nothing is saved
    await dlg.getByLabel("Gap (mesial)").fill(gap);
    expect((await s).ok()).toBe(true);
    await expect(dlg.locator("svg text", { hasText: new RegExp(`^${gap}mm$`) })).toBeVisible();
    await page.screenshot({ path: testInfo.outputPath(`full-${w}.png`) });
    await page.keyboard.press("Escape");
    await expect(dlg).toBeHidden();
    await expect(anatInfo(page)).toContainText("rotated 35° clockwise");
    await expect(anatInfo(page)).toContainText(`${w === 1366 ? 2 : 3}mm gap on mesial side`);
  }
  // A phone: picking a tooth opens the full-screen editor; the chart stays at the top
  // while the controls scroll under it.
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`/patients/${p.id}`);
  await page.getByRole("button", { name: /^Tooth chart/ }).click();
  await anat(page, 46).click();
  const dlg = page.getByRole("dialog", { name: "Tooth chart" });
  await expect(dlg.getByText("Tooth 46", { exact: true })).toBeVisible();
  await dlg.getByLabel("Gap (mesial)").scrollIntoViewIfNeeded();
  expect(await inView(dlg.getByLabel("Gap (mesial)"))).toBe(true);
  expect(await inView(dlg.locator(".ta-chart-scroll"))).toBe(true);
  await page.screenshot({ path: testInfo.outputPath("full-phone.png") });
  await chartStyle("simple");
});
