// The new-treatment dialog, opened from the patient page the way a dentist opens
// it ("Start a treatment"). Covers the schedule editor — total, down payment,
// cadence, per-visit date and amount edits, the mismatch guard — and asserts the
// exact body that reaches createPlan.
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

// These render the whole dental page and type into it; under a full parallel run
// (with coverage) a test can take longer than the 5 s default.
vi.setConfig({ testTimeout: 60_000 });

const api = vi.hoisted(() => ({
  dentalSummary: vi.fn(), createPlan: vi.fn(), saveChart: vi.fn(), listToothStatuses: vi.fn(), listDentalImages: vi.fn(),
}));
const patients = vi.hoisted(() => ({ getPatient: vi.fn() }));
const billing = vi.hoisted(() => ({ listServices: vi.fn() }));
const toast = vi.hoisted(() => Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn() }));

vi.mock("@/features/dental/api", async (orig) => ({ ...(await orig<object>()), ...api }));
vi.mock("@/features/patients/api", async (orig) => ({ ...(await orig<object>()), ...patients }));
vi.mock("@/features/billing/api", async (orig) => ({ ...(await orig<object>()), ...billing }));
vi.mock("@/components/ui/sonner", async (orig) => ({ ...(await orig<object>()), toast }));
vi.mock("@/lib/api-client", async (orig) => {
  const { quietApiFetch } = await import("@/test/render");
  return { ...(await orig<object>()), apiFetch: vi.fn(quietApiFetch), apiList: vi.fn(async () => ({ items: [], meta: {} })) };
});
vi.mock("@/app/auth-context", () => ({
  useAuth: () => ({ can: () => true, flagOn: () => true, user: { id: "u1", full_name: "Dr Test" }, activeBranchId: null }),
}));

import { DentalWorkspace } from "@/features/dental/DentalWorkspace";
import type { Summary } from "@/features/dental/api";
import { FLAT_TEETH } from "@/features/dental/shared/pickers";
import { AppError } from "@/lib/api-client";
import { ETH_MONTHS, ethiopianToGregorianISO, formatEthiopian, toEthiopian } from "@/lib/ethiopian";
import { freezeToday, renderUI } from "@/test/render";

const T = "2026-08-12";
const SUMMARY = {
  chart: { teeth: {} }, plans: [], image_limit: -1,
  balance: { owed: "0", paid: "0", balance: "0", due: "0", at_cashier: "0", waived: "0", overdue: false },
} as unknown as Summary;
const MONTHLY = ["2026-08-12", "2026-09-12", "2026-10-12", "2026-11-12", "2026-12-12", "2027-01-12"];

async function openDialog() {
  const r = renderUI(<DentalWorkspace patientId="pat_1" />, { route: "/patients/pat_1" });
  await r.user.click(await screen.findByRole("button", { name: /start a treatment/i }));
  const dlg = await screen.findByRole("dialog", { name: "New treatment plan" });
  return { ...r, dlg };
}
const dialog = () => screen.getByRole("dialog", { name: "New treatment plan" });
/** The input under a (non-associated) label in the dialog. */
const field = (label: string) =>
  within(dialog()).getByText(label, { selector: "label" }).parentElement!.querySelector("input") as HTMLInputElement;
const setField = (label: string, value: string) => fireEvent.change(field(label), { target: { value } });
const schedule = () => within(dialog()).getByText(/^Schedule — /).closest(".rounded-md.border") as HTMLElement;
const amounts = () => within(schedule()).getAllByPlaceholderText("0.00") as HTMLInputElement[];
const rowDates = () => within(schedule()).getAllByDisplayValue(/^\d{4}-\d{2}-\d{2}$/) as HTMLInputElement[];
/** A popover trigger (role=combobox), found by the text it shows. */
const pickerBtn = (text: string) => within(dialog()).getByText(text).closest("button") as HTMLElement;
const createBtn = () => within(dialog()).getByRole("button", { name: "Create plan" });
async function gregorianRows(user: ReturnType<typeof renderUI>["user"]) {
  await user.click(within(schedule()).getByRole("button", { name: "Gregorian" }));
}
/** Name the treatment by typing one that is not on the clinic's list. */
async function freeTitle(user: ReturnType<typeof renderUI>["user"], name: string) {
  await user.click(pickerBtn("e.g. Root canal"));
  await user.type(await screen.findByPlaceholderText("Search the clinic's list…"), name);
  await user.click(await screen.findByText((_, el) => el?.tagName === "BUTTON" && el.textContent === `Use “${name}” without a price`));
}
const sent = () => api.createPlan.mock.calls[0][1];

describe("REG-FE-PLAN the new-treatment dialog", () => {
  beforeEach(() => {
    freezeToday(T);
    sessionStorage.clear();
    [...Object.values(api), ...Object.values(patients), ...Object.values(billing), toast, toast.success, toast.error]
      .forEach((f) => f.mockReset());
    api.dentalSummary.mockResolvedValue(SUMMARY);
    api.listToothStatuses.mockResolvedValue([]);
    api.listDentalImages.mockResolvedValue([]);
    api.createPlan.mockResolvedValue({ id: "new" });
    billing.listServices.mockResolvedValue([
      { id: "svc1", code: "RCT", name: "Root canal", category: "Dental", price: "12000", currency: "ETB", is_active: true, is_default: false, assignable_by: "clinician" },
      { id: "svc2", code: "XR", name: "X-ray", category: "Radiology", price: "300", currency: "ETB", is_active: true, is_default: false, assignable_by: "clinician" },
    ]);
    patients.getPatient.mockResolvedValue({
      id: "pat_1", mrn: "M1", first_name: "Abebe", last_name: "T", gender: "male", dob: "1990-01-01", phone: "",
      allergies: [{ id: "a1", substance: "Lidocaine", severity: "severe", created_at: "" }],
    });
  });
  afterEach(() => vi.useRealTimers());

  test("REG-FE-PLAN-001 opens with the allergy line, six monthly visits from today in Ethiopian dates, and Create disabled until named", async () => {
    await openDialog();
    expect(within(dialog()).getByRole("alert")).toHaveTextContent("Lidocaine");
    expect(field("Sessions")).toHaveValue(6);
    expect(within(dialog()).getByText(`Schedule — 6 sessions, ends ${formatEthiopian(MONTHLY[5])} EC`)).toBeInTheDocument();
    expect(within(dialog()).getByRole("button", { name: "Once a month" })).toHaveClass("bg-brand");
    // Each row is an Ethiopian month/day/year triple for the generated date.
    const days = within(schedule()).getAllByLabelText("Day") as HTMLInputElement[];
    expect(days).toHaveLength(6);
    const e0 = toEthiopian(MONTHLY[0]);
    expect(days[0]).toHaveValue(String(e0.day));
    expect((within(schedule()).getAllByLabelText("Year")[0] as HTMLInputElement).value).toBe(String(e0.year));
    expect(within(dialog()).getByText("Optional. Leave empty to divide the whole cost across the sessions.")).toBeInTheDocument();
    expect(createBtn()).toBeDisabled();
  });

  test("REG-FE-PLAN-002 total divides evenly across the visits; Create sends the whole schedule", async () => {
    const { user } = await openDialog();
    await freeTitle(user, "Crown prep");
    setField("Total cost (ETB)", "6000");
    setField("Note (optional)", "  upper left  ");
    await gregorianRows(user);
    expect(rowDates().map((i) => i.value)).toEqual(MONTHLY);
    expect(amounts().map((i) => i.value)).toEqual(Array(6).fill("1000"));
    expect(within(schedule()).getByText("Σ 6,000 ETB")).toHaveClass("text-emerald-600");
    expect(within(dialog()).getByText("Schedule — 6 sessions, ends 2027-01-12")).toBeInTheDocument();
    await user.click(createBtn());
    await waitFor(() => expect(api.createPlan).toHaveBeenCalledTimes(1));
    expect(api.createPlan.mock.calls[0][0]).toBe("pat_1");
    expect(sent()).toEqual({
      title: "Crown prep", tooth: "", total_amount: "6000", start_date: T,
      interval_unit: "month", interval_count: 1, session_count: 6, note: "upper left", deposit: "0", service_id: undefined,
      sessions: MONTHLY.map((d) => ({ scheduled_date: d, amount_due: "1000" })),
    });
    expect(toast.success).toHaveBeenCalledWith("Treatment plan created");
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "New treatment plan" })).not.toBeInTheDocument());
    await waitFor(() => expect(api.dentalSummary).toHaveBeenCalledTimes(2)); // the page re-reads
  });

  test("REG-FE-PLAN-003 an uneven total rounds every visit but the last, which takes the remainder", async () => {
    const { user } = await openDialog();
    setField("Total cost (ETB)", "10000");
    setField("Sessions", "3");
    await gregorianRows(user);
    expect(amounts().map((i) => i.value)).toEqual(["3300", "3300", "3400"]);
  });

  test("REG-FE-PLAN-004 a down payment comes off the top; the visits divide the rest", async () => {
    const { user } = await openDialog();
    await freeTitle(user, "Implant");
    setField("Total cost (ETB)", "6000");
    setField("Down payment (ETB)", "1500");
    expect(within(dialog()).getByText(/Paid up front\. The remaining/)).toHaveTextContent("The remaining 4,500 ETB is divided across the sessions.");
    expect(within(schedule()).getByText("Down payment")).toBeInTheDocument();
    expect(within(schedule()).getByText("1,500 ETB")).toBeInTheDocument();
    expect(amounts().map((i) => i.value)).toEqual(Array(6).fill("750"));
    expect(within(schedule()).getByText("Σ 6,000 ETB (1,500 ETB down)")).toBeInTheDocument();
    await user.click(createBtn());
    await waitFor(() => expect(api.createPlan).toHaveBeenCalled());
    expect(sent()).toMatchObject({ total_amount: "6000", deposit: "1500" });
    expect(sent().sessions.every((s: { amount_due: string }) => s.amount_due === "750")).toBe(true);
  });

  test("REG-FE-PLAN-005 a down payment larger than the total is capped at the total; no total means the deposit stands alone", async () => {
    await openDialog();
    setField("Total cost (ETB)", "6000");
    setField("Down payment (ETB)", "9000");
    expect(within(schedule()).getByText("Σ 6,000 ETB (6,000 ETB down)")).toBeInTheDocument();
    expect(amounts().map((i) => i.value)).toEqual(Array(6).fill("0"));
    setField("Total cost (ETB)", "");
    expect(within(schedule()).getByText("Σ 9,000 ETB (9,000 ETB down)")).toBeInTheDocument();
  });

  test("REG-FE-PLAN-006 quick schedules: weekly, twice a week, every 2 months — each restarts from today", async () => {
    const { user } = await openDialog();
    await freeTitle(user, "Ortho");
    setField("Sessions", "3");
    await gregorianRows(user);
    await user.click(within(dialog()).getByRole("button", { name: "Weekly" }));
    expect(rowDates().map((i) => i.value)).toEqual(["2026-08-12", "2026-08-19", "2026-08-26"]);
    await user.click(within(dialog()).getByRole("button", { name: "Twice a week" }));
    expect(rowDates().map((i) => i.value)).toEqual(["2026-08-12", "2026-08-15", "2026-08-18"]);
    await user.click(within(dialog()).getByRole("button", { name: "Every 2 months" }));
    expect(rowDates().map((i) => i.value)).toEqual(["2026-08-12", "2026-10-12", "2026-12-12"]);
    expect(within(dialog()).getByRole("button", { name: "Every 2 months" })).toHaveClass("bg-brand");
    await user.click(createBtn());
    await waitFor(() => expect(api.createPlan).toHaveBeenCalled());
    expect(sent()).toMatchObject({ interval_unit: "month", interval_count: 2, session_count: 3 });
  });

  test("REG-FE-PLAN-007 frequency 'Every 2 weeks' and 'Every N days' (with its own days box) set the interval sent", async () => {
    const { user } = await openDialog();
    await freeTitle(user, "Scaling");
    setField("Sessions", "3");
    await gregorianRows(user);
    const freq = within(field("Sessions").closest(".grid") as HTMLElement).getByRole("combobox");
    await user.click(freq);
    await user.click(await screen.findByRole("option", { name: "Every 2 weeks" }));
    expect(rowDates().map((i) => i.value)).toEqual(["2026-08-12", "2026-08-26", "2026-09-09"]);
    expect(within(dialog()).queryByText("Every (days)")).not.toBeInTheDocument();
    await user.click(freq);
    await user.click(await screen.findByRole("option", { name: "Every N days" }));
    expect(field("Every (days)")).toHaveValue(30);
    setField("Every (days)", "10");
    expect(rowDates().map((i) => i.value)).toEqual(["2026-08-12", "2026-08-22", "2026-09-01"]);
    // Nonsense days fall back to one day apart rather than stacking every visit on today.
    setField("Every (days)", "0");
    expect(rowDates().map((i) => i.value)).toEqual(["2026-08-12", "2026-08-13", "2026-08-14"]);
    setField("Every (days)", "10");
    await user.click(createBtn());
    await waitFor(() => expect(api.createPlan).toHaveBeenCalled());
    expect(sent()).toMatchObject({ interval_unit: "day", interval_count: 10, session_count: 3 });
  });

  test("REG-FE-PLAN-008 the session count is kept between 1 and 60", async () => {
    await openDialog();
    setField("Sessions", "0");
    expect(within(dialog()).getByText(/^Schedule — 1 session,/)).toBeInTheDocument();
    setField("Sessions", "");
    expect(amounts()).toHaveLength(1);
    setField("Sessions", "500");
    expect(within(dialog()).getByText(/^Schedule — 60 sessions,/)).toBeInTheDocument();
  });

  test("REG-FE-PLAN-009 a monthly course starting on the 31st lands on each month's last day, not the next month", async () => {
    const { user } = await openDialog();
    setField("Sessions", "3");
    // Start date, Gregorian mode of the start-date picker (the first toggle in the dialog).
    await user.click(within(dialog()).getAllByRole("button", { name: "Gregorian" })[0]);
    fireEvent.change(within(dialog()).getByDisplayValue(T), { target: { value: "2027-01-31" } });
    await gregorianRows(user);
    expect(rowDates().map((i) => i.value)).toEqual(["2027-01-31", "2027-02-28", "2027-03-31"]);
  });

  test("REG-FE-PLAN-010 a changed visit amount that breaks the total is flagged as over, blocks Create, and Balance fixes it", async () => {
    const { user } = await openDialog();
    await freeTitle(user, "Bridge");
    setField("Total cost (ETB)", "3000");
    setField("Sessions", "3");
    await gregorianRows(user);
    fireEvent.change(amounts()[0], { target: { value: "1500" } });
    const warn = within(dialog()).getByText(/The sessions add up to/);
    expect(warn).toHaveTextContent("The sessions add up to 3,500 ETB — that's 500 ETB over the 3,000 ETB total cost.");
    expect(within(schedule()).getByText("Σ 3,500 ETB")).toHaveClass("text-amber-600");
    await user.click(createBtn());
    expect(toast.error).toHaveBeenCalledWith("Sessions add up to 3,500 ETB, which doesn't match the 3,000 ETB total cost. Balance them first.");
    expect(api.createPlan).not.toHaveBeenCalled();
    await user.click(within(dialog()).getByRole("button", { name: "Balance the last session to match" }));
    expect(amounts().map((i) => i.value)).toEqual(["1500", "1000", "500"]);
    expect(within(dialog()).queryByText(/The sessions add up to/)).not.toBeInTheDocument();
    await user.click(createBtn());
    await waitFor(() => expect(api.createPlan).toHaveBeenCalled());
    expect(sent().sessions.map((s: { amount_due: string }) => s.amount_due)).toEqual(["1500", "1000", "500"]);
  });

  test("REG-FE-PLAN-011 short of the total reads 'under'; earlier visits already over the total cannot be balanced", async () => {
    await openDialog();
    setField("Total cost (ETB)", "3000");
    setField("Sessions", "3");
    fireEvent.change(amounts()[2], { target: { value: "" } });
    expect(within(dialog()).getByText(/The sessions add up to/)).toHaveTextContent("2,000 ETB — that's 1,000 ETB under the 3,000 ETB");
    fireEvent.change(amounts()[0], { target: { value: "5000" } });
    expect(within(dialog()).getByText("The earlier sessions already exceed the total — lower them, or raise the total cost.")).toBeInTheDocument();
    expect(within(dialog()).queryByRole("button", { name: /Balance the last session/ })).not.toBeInTheDocument();
  });

  test("REG-FE-PLAN-012 with no total, visit amounts define the course — no warning, total sent as 0, blank amounts as 0", async () => {
    const { user } = await openDialog();
    await freeTitle(user, "Check-ups");
    setField("Sessions", "2");
    fireEvent.change(amounts()[0], { target: { value: "400" } });
    fireEvent.change(amounts()[1], { target: { value: "" } });
    expect(within(dialog()).queryByText(/The sessions add up to/)).not.toBeInTheDocument();
    await user.click(createBtn());
    await waitFor(() => expect(api.createPlan).toHaveBeenCalled());
    expect(sent()).toMatchObject({ total_amount: "0", deposit: "0" });
    expect(sent().sessions.map((s: { amount_due: string }) => s.amount_due)).toEqual(["400", "0"]);
  });

  test("REG-FE-PLAN-013 a visit's date can be moved in Gregorian mode and is sent as edited", async () => {
    const { user } = await openDialog();
    await freeTitle(user, "Veneers");
    setField("Sessions", "2");
    await gregorianRows(user);
    fireEvent.change(rowDates()[1], { target: { value: "2026-09-20" } });
    expect(within(dialog()).getByText("Schedule — 2 sessions, ends 2026-09-20")).toBeInTheDocument();
    await user.click(createBtn());
    await waitFor(() => expect(api.createPlan).toHaveBeenCalled());
    expect(sent().sessions.map((s: { scheduled_date: string }) => s.scheduled_date)).toEqual(["2026-08-12", "2026-09-20"]);
  });

  test("REG-FE-PLAN-014 a visit's date can be moved in Ethiopian mode; an impossible day is ignored", async () => {
    const { user } = await openDialog();
    await freeTitle(user, "Veneers");
    setField("Sessions", "2");
    const e1 = toEthiopian(MONTHLY[1]);
    const day = within(schedule()).getAllByLabelText("Day")[1] as HTMLInputElement;
    // Non-digits are stripped; an out-of-range day (31 in a 30-day month) does not commit.
    fireEvent.change(day, { target: { value: "3x1" } });
    expect(day).toHaveValue("31");
    fireEvent.change(day, { target: { value: "20" } });
    const day20 = ethiopianToGregorianISO(e1.year, e1.month, 20);
    expect(within(dialog()).getByText(`Schedule — 2 sessions, ends ${formatEthiopian(day20)} EC`)).toBeInTheDocument();
    const year = within(schedule()).getAllByLabelText("Year")[1] as HTMLInputElement;
    fireEvent.change(year, { target: { value: "" } }); // half-typed: nothing commits
    expect(within(dialog()).getByText(`Schedule — 2 sessions, ends ${formatEthiopian(day20)} EC`)).toBeInTheDocument();
    fireEvent.change(year, { target: { value: String(e1.year) } });
    // The month select moves it a month on.
    await user.click(within(day.parentElement as HTMLElement).getByRole("combobox"));
    await user.click(await screen.findByRole("option", { name: ETH_MONTHS[e1.month] }));
    const moved = ethiopianToGregorianISO(e1.year, e1.month + 1, 20);
    await user.click(createBtn());
    await waitFor(() => expect(api.createPlan).toHaveBeenCalled());
    expect(sent().sessions[1].scheduled_date).toBe(moved);
  });

  test("REG-FE-PLAN-015 choosing a procedure from the clinic's list names the course, fills the price and sends its id", async () => {
    const { user } = await openDialog();
    await user.click(pickerBtn("e.g. Root canal"));
    // Only the dental-category, active procedures are offered.
    expect(await screen.findByRole("option", { name: /Root canal/ })).toBeInTheDocument();
    expect(screen.queryByRole("option", { name: /X-ray/ })).not.toBeInTheDocument();
    await user.click(screen.getByRole("option", { name: /Root canal/ }));
    expect(field("Total cost (ETB)")).toHaveValue(12000);
    expect(within(dialog()).getByText("List price 12,000 ETB.")).toBeInTheDocument();
    setField("Total cost (ETB)", "10000");
    expect(within(dialog()).getByText("2,000 ETB discount")).toBeInTheDocument();
    await user.click(createBtn());
    await waitFor(() => expect(api.createPlan).toHaveBeenCalled());
    expect(sent()).toMatchObject({ title: "Root canal", service_id: "svc1", total_amount: "10000" });
  });

  test("REG-FE-PLAN-016 the teeth picker's Upper arch is sent as the course's teeth, in chart order", async () => {
    const { user } = await openDialog();
    await freeTitle(user, "Whitening");
    await user.click(pickerBtn("No specific tooth"));
    await user.click(await screen.findByRole("button", { name: "Upper" }));
    await user.keyboard("{Escape}");
    await user.click(createBtn());
    await waitFor(() => expect(api.createPlan).toHaveBeenCalled());
    expect(sent().tooth).toBe(FLAT_TEETH.filter((c) => c.startsWith("U")).join(", "));
  });

  test("REG-FE-PLAN-017 a refused create shows the server's reason and keeps the dialog open; an unknown failure a fallback", async () => {
    api.createPlan.mockRejectedValueOnce(new AppError(422, "bad", "Start date is in the past")).mockRejectedValueOnce(new Error("x"));
    const { user } = await openDialog();
    await freeTitle(user, "Crown");
    await user.click(createBtn());
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith("Start date is in the past"));
    expect(dialog()).toBeInTheDocument();
    await user.click(createBtn());
    await waitFor(() => expect(toast.error).toHaveBeenLastCalledWith("Could not create the plan"));
    expect(toast.success).not.toHaveBeenCalled();
  });

  test("REG-FE-PLAN-018 while the create is in flight the button is disabled, so a double tap sends one plan", async () => {
    let finish!: (v: unknown) => void;
    api.createPlan.mockImplementation(() => new Promise((r) => { finish = r; }));
    const { user } = await openDialog();
    await freeTitle(user, "Crown");
    await user.click(createBtn());
    await waitFor(() => expect(createBtn()).toBeDisabled());
    await user.click(createBtn());
    expect(api.createPlan).toHaveBeenCalledTimes(1);
    finish({ id: "new" });
    await waitFor(() => expect(toast.success).toHaveBeenCalled());
  });

  test("REG-FE-PLAN-019 a blank (spaces-only) name cannot be created", async () => {
    const { user } = await openDialog();
    await user.click(pickerBtn("e.g. Root canal"));
    fireEvent.change(await screen.findByPlaceholderText("Search the clinic's list…"), { target: { value: "   " } });
    expect(screen.queryByRole("button", { name: /without a price/ })).not.toBeInTheDocument();
    await user.keyboard("{Escape}");
    expect(createBtn()).toBeDisabled();
  });

  test("REG-FE-PLAN-020 Cancel closes the dialog without creating anything", async () => {
    const { user } = await openDialog();
    await freeTitle(user, "Crown");
    await user.click(within(dialog()).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "New treatment plan" })).not.toBeInTheDocument());
    expect(api.createPlan).not.toHaveBeenCalled();
  });

  test.fails("REG-FE-PLAN-021 KNOWN BUG UX-7 Esc on a half-filled plan must not throw the input away", async () => {
    const { user } = await openDialog();
    await freeTitle(user, "Crown");
    setField("Total cost (ETB)", "6000");
    await user.keyboard("{Escape}");
    // Correct: the dialog stays (or asks before discarding) and the typed values survive.
    await new Promise((r) => setTimeout(r, 50));
    expect(screen.getByRole("dialog", { name: "New treatment plan" })).toBeInTheDocument();
    expect(field("Total cost (ETB)")).toHaveValue(6000);
  });

  test.fails("REG-FE-PLAN-022 KNOWN BUG UX-7 a click outside a half-filled plan must not throw the input away", async () => {
    await openDialog();
    setField("Total cost (ETB)", "6000");
    const overlay = document.querySelector("[data-state=open].fixed.inset-0") as HTMLElement;
    fireEvent.pointerDown(overlay);
    fireEvent.pointerUp(overlay);
    fireEvent.click(overlay);
    await new Promise((r) => setTimeout(r, 50));
    expect(screen.getByRole("dialog", { name: "New treatment plan" })).toBeInTheDocument();
    expect(field("Total cost (ETB)")).toHaveValue(6000);
  });
});
