// Reception: the front desk of a dental clinic. What the screen must get right:
//   - the day as four lists (expected, waiting, seen, to settle) with honest counts,
//     and an empty list that means "nobody", never "the request failed";
//   - search as the fallback, recognising someone already in the clinic today so the
//     desk cannot take their fee a second time;
//   - receiving a booked patient through the appointment's own check-in (so the
//     covered-follow-up rule fires and nothing is charged inside its window), and a
//     walk-in through the walk-in door, with department/clinician routing;
//   - money: collect exactly the charges THIS arrival raised, send to the cashier,
//     waive with a reason, defer with a reason, refuse a payment the bank contradicts
//     (with a recorded manager override), and settle what a waiting patient owes;
//   - desktop shows the panel beside the list, a phone gets it as a sheet.
// The APIs are mocked; each test asserts what the desk sees and what reached the API.
// Times are built relative to "now" so the tests hold at any hour in any zone.
import { act, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, test, vi } from "vitest";

vi.setConfig({ testTimeout: 60_000 });

const auth = vi.hoisted(() => ({ perms: new Set<string>(), flags: new Set<string>() }));
vi.mock("@/app/auth-context", () => ({
  useAuth: () => ({
    can: (p: string) => auth.perms.has(p), flagOn: (f: string) => auth.flags.has(f),
    user: { id: "u1", full_name: "Desk Person" }, activeBranchId: "br1",
  }),
}));
const media = vi.hoisted(() => ({ wide: true }));
vi.mock("@/hooks/useMediaQuery", async (orig) => ({ ...(await orig<object>()), useIsLargeScreen: () => media.wide }));

const sched = vi.hoisted(() => ({ receptionToday: vi.fn(), checkInAppointment: vi.fn(), walkIn: vi.fn() }));
vi.mock("@/features/scheduling/api", async (orig) => ({ ...(await orig<object>()), ...sched }));
const pats = vi.hoisted(() => ({ searchPatients: vi.fn() }));
vi.mock("@/features/patients/api", async (orig) => ({ ...(await orig<object>()), ...pats }));
const admin = vi.hoisted(() => ({
  listDepartments: vi.fn(), listProviders: vi.fn(), getSettings: vi.fn(), listPaymentRails: vi.fn(),
}));
vi.mock("@/features/admin/api", async (orig) => ({ ...(await orig<object>()), ...admin }));
const bill = vi.hoisted(() => ({
  listServices: vi.fn(), raiseCharge: vi.fn(), settleVisit: vi.fn(), waiveCharge: vi.fn(), waiverReasons: vi.fn(),
  deferVisit: vi.fn(), verificationAvailable: vi.fn(), verifyPayment: vi.fn(),
}));
vi.mock("@/features/billing/api", async (orig) => ({ ...(await orig<object>()), ...bill }));
vi.mock("@/lib/api-client", async (orig) => {
  const { quietApiFetch } = await import("@/test/render");
  return { ...(await orig<object>()), apiFetch: vi.fn(quietApiFetch) };
});
const tst = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }));
vi.mock("sonner", async (orig) => ({ ...(await orig<object>()), toast: tst }));

import { ReceptionPage } from "@/features/scheduling/pages/ReceptionPage";
import type { ReceptionPatient, ReceptionToday } from "@/features/scheduling/api";
import type { PatientSummary } from "@/features/patients/api";
import type { ServiceItem } from "@/features/billing/api";
import type { PaymentRail } from "@/features/admin/api";
import { clock, day } from "@/features/scheduling/reception/ArrivalList";
import { AppError } from "@/lib/api-client";
import { renderUI } from "@/test/render";

const MIN = 60_000;
const DAY = 864e5;
const at = (ms: number) => new Date(Date.now() + ms).toISOString();

const DESK = ["payment.collect", "payment.charge", "patient.read"];
const MANAGER = [...DESK, "payment.waive"];
const as = (perms: string[], flags: string[] = ["dental"]) => { auth.perms = new Set(perms); auth.flags = new Set(flags); };

const P = (over: Partial<ReceptionPatient>): ReceptionPatient => ({
  patient_id: "pat_x", name: "Someone", mrn: "MRN-X", age: 30, sex: "female", is_followup: false, late_minutes: 0, ...over,
});
const almaz = () => P({
  patient_id: "pat_a", name: "Almaz Haile", mrn: "MRN-A", age: 34, phone: "0911000000",
  appointment_id: "apt_a", starts_at: at(-20 * MIN), late_minutes: 20, provider_id: "doc1", provider_name: "Dr Sara",
  department_id: "dep1", reason: "Cleaning", owed: "300", owed_oldest_days: 12,
});
const bekele = () => P({
  patient_id: "pat_b", name: "Bekele Tesfaye", mrn: "MRN-B", sex: "male", appointment_id: "apt_b", starts_at: at(60 * MIN),
  provider_id: "doc1", provider_name: "Dr Sara", department_id: "dep1", is_followup: true, free_until: at(5 * DAY),
});
const chaltu = () => P({
  patient_id: "pat_c", name: "Chaltu Abdi", mrn: "MRN-C", waiting_since: at(-25 * MIN), department_name: "Dental",
  owed: "500", owed_agreed: true,
});
const dawit = () => P({ patient_id: "pat_d", name: "Dawit Alemu", mrn: "MRN-D", waiting_since: at(-3 * 60 * MIN), finished: true, owed: "800" });
const eden = () => P({ patient_id: "pat_e", name: "Eden Girma", mrn: "MRN-E", waiting_since: at(-2 * 60 * MIN), finished: true, owed: "0", unbilled: "1500" });
const fikir = () => P({ patient_id: "pat_f", name: "Fikir Lemma", mrn: "MRN-F", waiting_since: at(-90 * MIN), finished: true, owed: "0" });
const day0 = (): ReceptionToday => ({ expected: [almaz(), bekele()], waiting: [chaltu()], seen: [dawit(), eden(), fikir()] });

const SVC = (id: string, name: string, price: string, isDefault: boolean): ServiceItem => ({
  id, code: id, name, category: "consultation", price, currency: "ETB", is_active: true, is_default: isDefault, assignable_by: "reception",
});
const services = [SVC("svc_reg", "Registration", "100", true), SVC("svc_xray", "X-ray", "250", false)];
const RAIL = (id: string, over: Partial<PaymentRail> = {}): PaymentRail => ({
  id, key: "cash", label: "Cash", kind: "cash", needs_reference: false, active: true, sort_order: 0, ...over,
});
const cash = RAIL("rail_cash");
const telebirr = RAIL("rail_tb", { key: "telebirr", label: "Telebirr", kind: "wallet", bank_key: "telebirr", needs_reference: true, sort_order: 1 });
const PS = (id: string, first: string, last: string, over: Partial<PatientSummary> = {}): PatientSummary => ({
  id, mrn: `MRN-${id}`, first_name: first, last_name: last, gender: "female", dob: "1990-01-01", ...over,
});

function page(today: ReceptionToday | Promise<never> | Error = day0()) {
  if (today instanceof Promise) sched.receptionToday.mockReturnValue(today);
  else if (today instanceof Error) sched.receptionToday.mockRejectedValue(today);
  else sched.receptionToday.mockResolvedValue(today);
  return renderUI(<ReceptionPage />, { route: "/reception" });
}
const tab = (name: RegExp) => within(screen.getByRole("tablist", { name: "Which patients" })).getByRole("tab", { name });
const btn = (name: string | RegExp) => screen.getByRole("button", { name });
const searchBox = () => screen.getByPlaceholderText(/Search any patient/);

/** Open a Radix select and pick an option. */
async function choose(user: ReturnType<typeof renderUI>["user"], trigger: HTMLElement, option: string) {
  await user.click(trigger);
  await user.click(await screen.findByRole("option", { name: option }));
}
/** Department, Clinician, then Payment method — in the order the panel draws them. */
const combos = () => screen.getAllByRole("combobox");

async function pick(user: ReturnType<typeof renderUI>["user"], name: RegExp) {
  await user.click(await screen.findByRole("button", { name }));
}

describe("REG-FE-RECEP reception desk", () => {
  beforeEach(() => {
    as(MANAGER);
    media.wide = true;
    for (const m of [...Object.values(sched), ...Object.values(pats), ...Object.values(admin), ...Object.values(bill), tst.success, tst.error]) m.mockReset();
    admin.listDepartments.mockResolvedValue([{ id: "dep1", branch_id: "br1", name: "Dental" }, { id: "dep2", branch_id: "br1", name: "General" }]);
    admin.listProviders.mockResolvedValue([{ id: "doc1", full_name: "Dr Sara" }, { id: "doc2", full_name: "Dr Yonas" }]);
    admin.getSettings.mockResolvedValue({ triage_required: false });
    admin.listPaymentRails.mockResolvedValue([cash, telebirr]);
    bill.listServices.mockResolvedValue(services);
    bill.waiverReasons.mockResolvedValue(["Staff", "Charity"]);
    bill.verificationAvailable.mockResolvedValue({ available: true });
    sched.checkInAppointment.mockResolvedValue({ gated: true, charge_ids: ["chg_visit"] });
    sched.walkIn.mockResolvedValue({ status: "waiting", gated: true, charge_ids: ["chg_walk"] });
    bill.raiseCharge.mockResolvedValue({ id: "chg_extra" });
    bill.settleVisit.mockResolvedValue({ receipt_no: 7, total: "100", count: 1 });
    pats.searchPatients.mockResolvedValue({ items: [], meta: {} });
  });

  // --- the day -------------------------------------------------------------------

  test("REG-FE-RECEP-001 four lists with counts; To settle is the seen who still owe or are unbilled", async () => {
    const { user } = page();
    expect(await screen.findByRole("button", { name: /Almaz Haile/ })).toBeInTheDocument();
    expect(tab(/Expected/)).toHaveTextContent("Expected2");
    expect(tab(/Waiting/)).toHaveTextContent("Waiting1");
    expect(tab(/^Seen/)).toHaveTextContent("Seen3");
    expect(tab(/To settle/)).toHaveTextContent("To settle2");
    expect(btn(/Bekele Tesfaye/)).toHaveTextContent(/Free follow-up/);

    await user.click(tab(/Waiting/));
    expect(btn(/Chaltu Abdi/)).toHaveTextContent(/waiting 25 min/);
    expect(screen.queryByRole("button", { name: /Almaz Haile/ })).not.toBeInTheDocument();

    await user.click(tab(/^Seen/));
    for (const n of [/Dawit Alemu/, /Eden Girma/, /Fikir Lemma/]) expect(btn(n)).toBeInTheDocument();

    await user.click(tab(/To settle/));
    expect(btn(/Dawit Alemu/)).toHaveTextContent("To collect 800 ETB");
    expect(btn(/Eden Girma/)).toHaveTextContent(/Not yet billed/);
    expect(screen.queryByRole("button", { name: /Fikir Lemma/ })).not.toBeInTheDocument();
  });

  test("REG-FE-RECEP-002 each empty list says what empty means", async () => {
    const { user } = page({ expected: [], waiting: [], seen: [fikir()] });
    expect(await screen.findByText("Nobody booked today — search for a walk-in.")).toBeInTheDocument();
    await user.click(tab(/Waiting/));
    expect(screen.getByText("Nobody is waiting.")).toBeInTheDocument();
    await user.click(tab(/To settle/));
    expect(screen.getByText("Everyone treated today has paid.")).toBeInTheDocument();
  });

  test("REG-FE-RECEP-003 nobody seen yet; and while the day loads there is no empty-state claim", async () => {
    const { user } = page({ expected: [], waiting: [], seen: [] });
    await user.click(await screen.findByRole("tab", { name: /^Seen/ }));
    expect(screen.getByText("Nobody has been seen yet today.")).toBeInTheDocument();
  });

  test("REG-FE-RECEP-004 while loading, no list and no 'nobody booked'", async () => {
    page(new Promise<never>(() => {}));
    expect(await screen.findByRole("tab", { name: /Expected/ })).toHaveTextContent("Expected0");
    expect(screen.queryByText(/Nobody booked/)).not.toBeInTheDocument();
    expect(screen.getByText("Pick someone from today's list")).toBeInTheDocument();
  });

  // --- receiving a booked patient ---------------------------------------------------

  test("REG-FE-RECEP-005 a booked patient: details, old debt, fee; Collect checks in by the appointment and settles only this visit's charges", async () => {
    const t = day0();
    const { user } = page(t);
    await pick(user, /Almaz Haile/);
    expect(btn(/Almaz Haile/)).toHaveAttribute("aria-current", "true");
    const panel = screen.getByRole("heading", { name: "Almaz Haile" }).closest("div.space-y-4") as HTMLElement;
    expect(panel).toHaveTextContent(/34y · female/);
    expect(within(panel).getByRole("link", { name: "0911000000" })).toHaveAttribute("href", "tel:0911000000");
    expect(panel).toHaveTextContent(`Booked ${clock(t.expected[0].starts_at!)} with Dr Sara · Cleaning`);
    expect(panel).toHaveTextContent("Owes ETB 300.00 from earlier visits · oldest 12 days");
    expect(within(panel).getByRole("link", { name: "See it" })).toHaveAttribute("href", "/cashier");
    expect(panel).toHaveTextContent(/RegistrationETB 100\.00/);
    expect(panel).toHaveTextContent(/TotalETB 100\.00/);

    const collect = await screen.findByRole("button", { name: "Collect ETB 100.00 & send through" });
    await waitFor(() => expect(collect).toBeEnabled());
    await user.click(collect);
    await waitFor(() => expect(bill.settleVisit).toHaveBeenCalled());
    expect(sched.checkInAppointment).toHaveBeenCalledWith("apt_a", { to_triage: false, provider_id: "doc1", department_id: "dep1" });
    expect(sched.walkIn).not.toHaveBeenCalled();
    expect(bill.settleVisit).toHaveBeenCalledWith("pat_a", expect.objectContaining({
      rail_id: "rail_cash", method: "cash", charge_ids: ["chg_visit"],
    }));
    expect(tst.success).toHaveBeenCalledWith("Almaz Haile: ETB 100.00 collected · sent through");
    // Done: the panel closes and the day is reloaded.
    expect(await screen.findByText("Pick someone from today's list")).toBeInTheDocument();
    await waitFor(() => expect(sched.receptionToday.mock.calls.length).toBeGreaterThan(1));
  });

  test("REG-FE-RECEP-006 a covered follow-up: no fee, a plain Check in, nothing settled", async () => {
    sched.checkInAppointment.mockResolvedValue({ gated: false, charge_ids: [] });
    const { user } = page();
    await pick(user, /Bekele Tesfaye/);
    expect(await screen.findByText(/No fee — covered follow-up/)).toBeInTheDocument();
    expect(screen.getByText(new RegExp(`free until ${day(bekele().free_until!)}`))).toBeInTheDocument();
    expect(screen.queryByText("Total")).not.toBeInTheDocument();
    expect(screen.queryByRole("combobox", { name: "Payment method" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Send to cashier|Waive/ })).not.toBeInTheDocument();
    await user.click(btn("Check in"));
    await waitFor(() => expect(tst.success).toHaveBeenCalledWith("Bekele Tesfaye checked in"));
    expect(sched.checkInAppointment).toHaveBeenCalledWith("apt_b", expect.objectContaining({ provider_id: "doc1" }));
    expect(bill.settleVisit).not.toHaveBeenCalled();
  });

  test("REG-FE-RECEP-041 debt the clinic agreed to wait for reads as a plan, not a surprise; walk-in age unknown", async () => {
    const t = day0();
    const startsAt = t.expected[0].starts_at!;
    t.expected[0] = { ...almaz(), starts_at: startsAt, owed_agreed: true, owed_oldest_days: 0, age: 0, phone: undefined, reason: undefined, provider_name: undefined };
    const { user } = page(t);
    await pick(user, /Almaz Haile/);
    const note = await screen.findByText(/Being billed later/);
    expect(note).toHaveTextContent(/^Being billed later — ETB 300\.00 agreed$/);
    expect(screen.queryByText(/from earlier visits/)).not.toBeInTheDocument();
    expect(screen.getByText(/^Booked/)).toHaveTextContent(`Booked ${clock(startsAt)}`, { normalizeWhitespace: false });
  });

  test("REG-FE-RECEP-007 a follow-up past its window is charged like anyone else", async () => {
    const t = day0();
    t.expected[1] = { ...bekele(), free_until: at(-DAY) };
    const { user } = page(t);
    await pick(user, /Bekele Tesfaye/);
    expect(await screen.findByRole("button", { name: "Collect ETB 100.00 & send through" })).toBeInTheDocument();
    expect(screen.queryByText(/covered follow-up/)).not.toBeInTheDocument();
  });

  test("REG-FE-RECEP-008 Send to cashier checks in without taking money", async () => {
    const { user } = page();
    await pick(user, /Almaz Haile/);
    await user.click(await screen.findByRole("button", { name: "Send to cashier" }));
    await waitFor(() => expect(tst.success).toHaveBeenCalledWith("Almaz Haile sent to the cashier"));
    expect(sched.checkInAppointment).toHaveBeenCalled();
    expect(bill.settleVisit).not.toHaveBeenCalled();
  });

  test("REG-FE-RECEP-009 a failed check-in says why and keeps the panel open", async () => {
    sched.checkInAppointment.mockRejectedValueOnce(new AppError(409, "ALREADY", "Already checked in"));
    const { user } = page();
    await pick(user, /Almaz Haile/);
    await user.click(await screen.findByRole("button", { name: /Collect ETB 100\.00/ }));
    await waitFor(() => expect(tst.error).toHaveBeenCalledWith("Already checked in"));
    sched.checkInAppointment.mockRejectedValueOnce(new Error("boom"));
    await user.click(btn(/Collect ETB 100\.00/));
    await waitFor(() => expect(tst.error).toHaveBeenCalledWith("Could not receive this patient"));
    expect(bill.settleVisit).not.toHaveBeenCalled();
    expect(screen.getByRole("heading", { name: "Almaz Haile" })).toBeInTheDocument();
  });

  test("REG-FE-RECEP-010 a reference-only rail blocks Collect until the reference is typed", async () => {
    admin.listPaymentRails.mockResolvedValue([telebirr, cash]);
    const { user } = page();
    await pick(user, /Almaz Haile/);
    const collect = await screen.findByRole("button", { name: /Collect ETB 100\.00/ });
    await waitFor(() => expect(collect).toBeDisabled());
    await user.type(screen.getByLabelText(/Transaction reference/), "CH7K2M9QRS");
    expect(collect).toBeEnabled();
    await user.click(collect);
    await waitFor(() => expect(bill.settleVisit).toHaveBeenCalledWith("pat_a", expect.objectContaining({
      rail_id: "rail_tb", method: "telebirr", reference: "CH7K2M9QRS", charge_ids: ["chg_visit"],
    })));
  });

  test("REG-FE-RECEP-011 a transfer the bank contradicts cannot be collected; a manager's override is sent as force", async () => {
    as(MANAGER, ["dental", "payment_verification"]);
    admin.listPaymentRails.mockResolvedValue([telebirr]);
    bill.verifyPayment.mockResolvedValue({ state: "rejected", reason: "Paid to another account" });
    const { user } = page();
    await pick(user, /Almaz Haile/);
    await user.type(await screen.findByLabelText(/Transaction reference/), "FT123");
    await user.click(await screen.findByRole("button", { name: /Check with the bank/ }));
    expect(await screen.findByRole("button", { name: /The bank did not confirm this payment/ })).toBeDisabled();
    expect(screen.queryByRole("button", { name: /Collect ETB/ })).not.toBeInTheDocument();
    await user.click(btn(/Take it anyway/));
    await waitFor(() => expect(bill.settleVisit).toHaveBeenCalledWith("pat_a", expect.objectContaining({ force: true, charge_ids: ["chg_visit"] })));
  });

  test("REG-FE-RECEP-012 without payment.waive the contradicted transfer has no override", async () => {
    as(DESK, ["dental", "payment_verification"]);
    admin.listPaymentRails.mockResolvedValue([telebirr]);
    bill.verifyPayment.mockResolvedValue({ state: "rejected", reason: "Paid to another account" });
    const { user } = page();
    await pick(user, /Almaz Haile/);
    await user.type(await screen.findByLabelText(/Transaction reference/), "FT123");
    await user.click(await screen.findByRole("button", { name: /Check with the bank/ }));
    expect(await screen.findByText("A manager can override this.")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Take it anyway|Pay later/ })).not.toBeInTheDocument();
  });

  // --- waive and defer ------------------------------------------------------------------

  test("REG-FE-RECEP-013 Waive: needs a reason, checks in, then waives exactly this visit's charges", async () => {
    const { user } = page();
    await pick(user, /Almaz Haile/);
    await user.click(await screen.findByRole("button", { name: "Waive…" }));
    const dlg = await screen.findByRole("dialog", { name: /Waive the fee for Almaz Haile/ });
    const go = within(dlg).getByRole("button", { name: "Waive the fee" });
    expect(go).toBeDisabled();
    await choose(user, within(dlg).getByRole("combobox"), "Charity");
    await user.click(go);
    await waitFor(() => expect(tst.success).toHaveBeenCalledWith("Almaz Haile: fee waived"));
    expect(sched.checkInAppointment).toHaveBeenCalledWith("apt_a", expect.anything());
    expect(bill.waiveCharge).toHaveBeenCalledTimes(1);
    expect(bill.waiveCharge).toHaveBeenCalledWith("chg_visit", "Charity");
    expect(bill.settleVisit).not.toHaveBeenCalled();
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
  });

  test("REG-FE-RECEP-014 Waive failure is reported; Cancel closes without waiving", async () => {
    bill.waiveCharge.mockRejectedValueOnce(new AppError(409, "X", "Already settled")).mockRejectedValueOnce(new Error("x"));
    const { user } = page();
    await pick(user, /Almaz Haile/);
    await user.click(await screen.findByRole("button", { name: "Waive…" }));
    const dlg = await screen.findByRole("dialog");
    await choose(user, within(dlg).getByRole("combobox"), "Staff");
    await user.click(within(dlg).getByRole("button", { name: "Waive the fee" }));
    await waitFor(() => expect(tst.error).toHaveBeenCalledWith("Already settled"));
    await user.click(within(dlg).getByRole("button", { name: "Waive the fee" }));
    await waitFor(() => expect(tst.error).toHaveBeenCalledWith("Could not waive it"));
    await user.click(within(dlg).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
  });

  test("REG-FE-RECEP-015 Pay later: says the money stays owed, needs a reason, and defers it", async () => {
    bill.deferVisit.mockResolvedValueOnce({ deferred: 1 }).mockResolvedValueOnce({ deferred: 2 });
    const { user } = page();
    await pick(user, /Almaz Haile/);
    await user.click(await screen.findByRole("button", { name: "Pay later…" }));
    const dlg = await screen.findByRole("dialog", { name: "Treat now, pay later" });
    expect(dlg).toHaveTextContent(/The ETB 100\.00 stays owed/);
    const go = within(dlg).getByRole("button", { name: "Send through, bill later" });
    expect(go).toBeDisabled();
    await choose(user, within(dlg).getByRole("combobox"), "Staff or dependent");
    await user.click(go);
    await waitFor(() => expect(tst.success).toHaveBeenCalledWith("Almaz Haile can be seen now — 1 charge still owed"));
    expect(bill.deferVisit).toHaveBeenCalledWith("pat_a", expect.objectContaining({ reason: "Staff or dependent" }));
    expect(await screen.findByText("Pick someone from today's list")).toBeInTheDocument();
  });

  test("REG-FE-RECEP-016 Pay later: plural toast, failures reported, Cancel closes", async () => {
    bill.deferVisit.mockRejectedValueOnce(new AppError(409, "NOTHING_TO_DEFER", "Nothing to defer"))
      .mockRejectedValueOnce(new Error("x")).mockResolvedValueOnce({ deferred: 2 });
    const { user } = page();
    await pick(user, /Almaz Haile/);
    await user.click(await screen.findByRole("button", { name: "Pay later…" }));
    const dlg = await screen.findByRole("dialog");
    await choose(user, within(dlg).getByRole("combobox"), "Other");
    const go = within(dlg).getByRole("button", { name: "Send through, bill later" });
    await user.click(go);
    await waitFor(() => expect(tst.error).toHaveBeenCalledWith("Nothing to defer"));
    await user.click(go);
    await waitFor(() => expect(tst.error).toHaveBeenCalledWith("Could not defer this visit"));
    await user.click(within(dlg).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    await user.click(btn("Pay later…"));
    const again = await screen.findByRole("dialog");
    await choose(user, within(again).getByRole("combobox"), "Other");
    await user.click(within(again).getByRole("button", { name: "Send through, bill later" }));
    await waitFor(() => expect(tst.success).toHaveBeenCalledWith("Almaz Haile can be seen now — 2 charges still owed"));
  });

  // --- walk-ins by search ---------------------------------------------------------------

  test("REG-FE-RECEP-017 search needs two letters, shows the count, and a pick becomes a walk-in", async () => {
    pats.searchPatients.mockResolvedValue({ items: [PS("pat_g", "Genet", "Bekele", { phone: "0922" }), PS("pat_h", "Hana", "", { dob: "" })], meta: {} });
    const { user } = page();
    await screen.findByRole("button", { name: /Almaz Haile/ });
    await user.type(searchBox(), "g");
    await new Promise((r) => setTimeout(r, 400));
    expect(pats.searchPatients).not.toHaveBeenCalled();
    await user.type(searchBox(), "e");
    expect(await screen.findByText("2 matching")).toBeInTheDocument();
    expect(pats.searchPatients).toHaveBeenCalledWith("ge", 1, 12);
    expect(btn(/Genet Bekele/)).toHaveTextContent("female · 1990-01-01 · 0922");
    expect(btn(/^Hana/)).toHaveTextContent(/^HanaMRN-pat_hfemale$/);
    // Search takes over the list.
    expect(screen.queryByRole("button", { name: /Almaz Haile/ })).not.toBeInTheDocument();
    await user.click(btn(/Genet Bekele/));
    expect(searchBox()).toHaveValue("");
    const head = await screen.findByRole("heading", { name: "Genet Bekele" });
    expect(head.parentElement?.parentElement).toHaveTextContent(/\d+y · female/);
    expect(screen.queryByText(/Booked/)).not.toBeInTheDocument();
  });

  test("REG-FE-RECEP-018 a walk-in must be routed; extras are raised and collected with the visit", async () => {
    pats.searchPatients.mockResolvedValue({ items: [PS("pat_g", "Genet", "Bekele")], meta: {} });
    sched.walkIn.mockResolvedValue({ status: "waiting", gated: true, charge_ids: ["chg_walk"] });
    bill.settleVisit.mockResolvedValue({ receipt_no: 8, total: "350", count: 2 });
    const { user } = page();
    await user.type(searchBox(), "genet");
    await user.click(await screen.findByRole("button", { name: /Genet Bekele/ }));
    const collect = await screen.findByRole("button", { name: "Collect ETB 100.00 & send through" });
    expect(collect).toBeDisabled();
    await choose(user, combos()[0], "General");
    expect(collect).toBeDisabled(); // a clinician is still needed
    await choose(user, combos()[1], "Dr Yonas");
    expect(collect).toBeEnabled();

    await user.click(screen.getByText("Add a service"));
    await user.click(screen.getByRole("checkbox", { name: /X-ray/ }));
    expect(screen.getByText(/Add a service · 1 added/)).toBeInTheDocument();
    expect(screen.getByText("Added services").parentElement).toHaveTextContent("ETB 250.00");
    // The default fee cannot be added twice as an "extra".
    await user.click(screen.getByRole("checkbox", { name: /Registration/ }));
    expect(screen.getByText(/Add a service · 1 added/)).toBeInTheDocument();
    await user.click(btn("Collect ETB 350.00 & send through"));

    await waitFor(() => expect(bill.settleVisit).toHaveBeenCalled());
    expect(sched.walkIn).toHaveBeenCalledWith({ patient_id: "pat_g", to_triage: false, provider_id: "doc2", department_id: "dep2" });
    expect(sched.checkInAppointment).not.toHaveBeenCalled();
    expect(bill.raiseCharge).toHaveBeenCalledWith(expect.objectContaining({
      patient_id: "pat_g", service_item_id: "svc_xray", amount: 250, description: "X-ray", department_id: "dep2", provider_id: "doc2",
    }));
    expect(bill.settleVisit).toHaveBeenCalledWith("pat_g", expect.objectContaining({ charge_ids: ["chg_walk", "chg_extra"] }));
    expect(tst.success).toHaveBeenCalledWith("Genet Bekele: ETB 350.00 collected · sent through");
  });

  test("REG-FE-RECEP-019 a clinic that triages everyone: no clinician picker, routed to triage", async () => {
    admin.getSettings.mockResolvedValue({ triage_required: true });
    pats.searchPatients.mockResolvedValue({ items: [PS("pat_g", "Genet", "Bekele")], meta: {} });
    const { user } = page();
    await user.type(searchBox(), "genet");
    await user.click(await screen.findByRole("button", { name: /Genet Bekele/ }));
    expect(await screen.findByText("This clinic sends every patient through triage first.")).toBeInTheDocument();
    expect(screen.queryByText("Clinician")).not.toBeInTheDocument();
    await choose(user, combos()[0], "Dental");
    await user.click(btn("Send to cashier"));
    await waitFor(() => expect(sched.walkIn).toHaveBeenCalledWith({ patient_id: "pat_g", to_triage: true, provider_id: undefined, department_id: "dep1" }));
  });

  test("REG-FE-RECEP-020 a clinic with no default fee: 'No fee for this visit' and a plain Check in", async () => {
    bill.listServices.mockResolvedValue([SVC("svc_xray", "X-ray", "250", false)]);
    sched.walkIn.mockResolvedValue({ status: "waiting", gated: false, charge_ids: [] });
    pats.searchPatients.mockResolvedValue({ items: [PS("pat_g", "Genet", "Bekele")], meta: {} });
    const { user } = page();
    await user.type(searchBox(), "genet");
    await user.click(await screen.findByRole("button", { name: /Genet Bekele/ }));
    expect(await screen.findByText("No fee for this visit")).toBeInTheDocument();
    await choose(user, combos()[0], "Dental");
    await choose(user, combos()[1], "Dr Sara");
    expect(screen.queryByRole("combobox", { name: "Payment method" })).not.toBeInTheDocument();
    await user.click(btn("Check in"));
    await waitFor(() => expect(tst.success).toHaveBeenCalledWith("Genet Bekele checked in"));
    expect(bill.settleVisit).not.toHaveBeenCalled();
  });

  test("REG-FE-RECEP-021 search finds someone already waiting: shown as received, never as a fresh arrival", async () => {
    pats.searchPatients.mockResolvedValue({ items: [PS("pat_c", "Chaltu", "Abdi")], meta: {} });
    bill.settleVisit.mockResolvedValue({ receipt_no: 9, total: "500", count: 1 });
    const t = day0();
    const { user } = page(t);
    await screen.findByRole("button", { name: /Almaz Haile/ });
    await user.type(searchBox(), "chaltu");
    await user.click(await screen.findByRole("button", { name: /Chaltu Abdi/ }));
    expect(await screen.findByText(new RegExp(`Already received — waiting since ${clock(t.waiting[0].waiting_since!)}`))).toHaveTextContent("for Dental");
    expect(screen.queryByRole("button", { name: /send through|Check in|Send to cashier/ })).not.toBeInTheDocument();
    expect(screen.getByText("ETB 500.00 still to pay")).toBeInTheDocument();
    expect(screen.getByText(/Agreed to be billed later/)).toBeInTheDocument();
    await user.click(await screen.findByRole("button", { name: "Collect ETB 500.00" }));
    await waitFor(() => expect(bill.settleVisit).toHaveBeenCalledWith("pat_c", expect.objectContaining({ rail_id: "rail_cash", method: "cash", force: false })));
    expect(tst.success).toHaveBeenCalledWith("Chaltu Abdi: ETB 500.00 collected");
    expect(await screen.findByText("Pick someone from today's list")).toBeInTheDocument();
  });

  test("REG-FE-RECEP-022 waiting and owing, uncollected: settling failure is reported; contradicted transfer can be forced", async () => {
    as(MANAGER, ["dental", "payment_verification"]);
    const t = day0();
    t.waiting[0] = { ...chaltu(), owed_agreed: false };
    bill.settleVisit.mockRejectedValueOnce(new AppError(400, "X", "Till closed")).mockRejectedValueOnce(new Error("x"));
    bill.verifyPayment.mockResolvedValue({ state: "rejected", reason: "Wrong account" });
    const { user } = page(t);
    await user.click(await screen.findByRole("tab", { name: /Waiting/ }));
    await pick(user, /Chaltu Abdi/);
    expect(await screen.findByText(/Not yet collected\. Take it before they leave\./)).toBeInTheDocument();
    const collect = await screen.findByRole("button", { name: "Collect ETB 500.00" });
    await user.click(collect);
    await waitFor(() => expect(tst.error).toHaveBeenCalledWith("Till closed"));
    await user.click(collect);
    await waitFor(() => expect(tst.error).toHaveBeenCalledWith("Could not take the payment"));

    await choose(user, screen.getByRole("combobox", { name: "Payment method" }), "Telebirr");
    await user.type(screen.getByLabelText(/Transaction reference/), "FT9");
    await user.click(btn(/Check with the bank/));
    await user.click(await screen.findByRole("button", { name: /Take it anyway/ }));
    await waitFor(() => expect(bill.settleVisit).toHaveBeenLastCalledWith("pat_c", expect.objectContaining({ force: true, rail_id: "rail_tb" })));
  });

  test("REG-FE-RECEP-023 a desk without payment.collect: no money controls on a waiting patient's debt", async () => {
    as(["patient.read", "payment.charge"]);
    const { user } = page();
    await user.click(await screen.findByRole("tab", { name: /Waiting/ }));
    await pick(user, /Chaltu Abdi/);
    expect(await screen.findByText(/Already received/)).toBeInTheDocument();
    expect(screen.queryByText(/still to pay/)).not.toBeInTheDocument();
    expect(bill.waiverReasons).not.toHaveBeenCalled();
  });

  test("REG-FE-RECEP-024 a desk without payment.collect sees no fee breakdown, payment picker, extras or waive", async () => {
    as(["patient.read", "payment.charge"]);
    const { user } = page();
    await pick(user, /Almaz Haile/);
    await screen.findByRole("heading", { name: "Almaz Haile" });
    await screen.findByRole("button", { name: "Send to cashier" });
    expect(screen.queryByText("Total")).not.toBeInTheDocument();
    expect(screen.queryByRole("combobox", { name: "Payment method" })).not.toBeInTheDocument();
    expect(screen.queryByText("Add a service")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Waive|Pay later/ })).not.toBeInTheDocument();
  });

  // --- seen patients ---------------------------------------------------------------------

  test("REG-FE-RECEP-025 someone seen today: the panel says the visit is closed", async () => {
    const t = day0();
    const { user } = page(t);
    await user.click(await screen.findByRole("tab", { name: /^Seen/ }));
    await pick(user, /Fikir Lemma/);
    expect(await screen.findByText(new RegExp(`Seen today — came in at ${clock(t.seen[2].waiting_since!)}`))).toBeInTheDocument();
  });

  test("REG-FE-RECEP-026 unbilled treatment links to the patient to bill it", async () => {
    const { user } = page();
    await user.click(await screen.findByRole("tab", { name: /^Seen/ }));
    await pick(user, /Eden Girma/);
    expect(await screen.findByText(/of treatment has not been sent to the cashier yet/)).toHaveTextContent("ETB 1500.00");
    expect(screen.getByRole("link", { name: "Open to bill it" })).toHaveAttribute("href", "/patients/pat_e");
  });

  // --- keeping in step, and layouts ---------------------------------------------------------

  test("REG-FE-RECEP-027 the open panel follows fresh data: a booked patient who arrives moves to Waiting, debt updates", async () => {
    const { user, qc } = page();
    await pick(user, /Almaz Haile/);
    expect(await screen.findByText(/from earlier visits/)).toHaveTextContent("Owes ETB 300.00");
    const t = day0();
    const arrived = { ...almaz(), owed: "450", waiting_since: at(-MIN), department_name: "Dental" };
    act(() => { qc.setQueryData(["reception-today"], { ...t, expected: [bekele()], waiting: [chaltu(), arrived] }); });
    expect(await screen.findByText(/Already received/)).toBeInTheDocument();
    expect(screen.getByText("ETB 450.00 still to pay")).toBeInTheDocument();
    // Someone the lists no longer mention stays as they were.
    act(() => { qc.setQueryData(["reception-today"], { expected: [], waiting: [], seen: [] }); });
    expect(screen.getByRole("heading", { name: "Almaz Haile" })).toBeInTheDocument();
  });

  test("REG-FE-RECEP-028 a walk-in picked from search follows fresh data by patient", async () => {
    pats.searchPatients.mockResolvedValue({ items: [PS("pat_g", "Genet", "Bekele")], meta: {} });
    const { user, qc } = page();
    await user.type(searchBox(), "genet");
    await user.click(await screen.findByRole("button", { name: /Genet Bekele/ }));
    await screen.findByRole("heading", { name: "Genet Bekele" });
    act(() => { qc.setQueryData(["reception-today"], { ...day0(), waiting: [P({ patient_id: "pat_g", name: "Genet Bekele", waiting_since: at(-MIN) })] }); });
    expect(await screen.findByText(/Already received/)).toBeInTheDocument();
  });

  test("REG-FE-RECEP-029 on a phone the panel is a sheet, not a side panel; closing it clears the pick", async () => {
    media.wide = false;
    const { user } = page();
    expect(await screen.findByRole("button", { name: /Almaz Haile/ })).toBeInTheDocument();
    expect(screen.queryByText("Pick someone from today's list")).toBeInTheDocument(); // hidden by CSS below lg
    await pick(user, /Almaz Haile/);
    const sheet = await screen.findByRole("dialog", { name: "Receive patient" });
    expect(within(sheet).getByRole("heading", { name: "Almaz Haile" })).toBeInTheDocument();
    await waitFor(() => expect(within(sheet).getByRole("button", { name: /Collect ETB 100\.00/ })).toBeEnabled());
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(btn(/Almaz Haile/)).not.toHaveAttribute("aria-current");
  });

  test("REG-FE-RECEP-030 on a phone, receiving closes the sheet", async () => {
    media.wide = false;
    const { user } = page();
    await pick(user, /Almaz Haile/);
    const sheet = await screen.findByRole("dialog", { name: "Receive patient" });
    await user.click(await within(sheet).findByRole("button", { name: "Send to cashier" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(tst.success).toHaveBeenCalledWith("Almaz Haile sent to the cashier");
  });

  test("REG-FE-RECEP-031 a non-dental clinic receives the same way", async () => {
    as(MANAGER, []);
    const { user } = page();
    await pick(user, /Almaz Haile/);
    await user.click(await screen.findByRole("button", { name: "Send to cashier" }));
    await waitFor(() => expect(sched.checkInAppointment).toHaveBeenCalledWith("apt_a", expect.anything()));
  });

  // --- known bugs: these assert the correct behaviour, so they fail today ---------------------

  test.fails("REG-FE-RECEP-032 KNOWN BUG UX-1 a failed load of the day is shown as an error, not 'Nobody booked today'", async () => {
    page(new Error("network down"));
    await waitFor(() => expect(sched.receptionToday).toHaveBeenCalled());
    await new Promise((r) => setTimeout(r, 50));
    expect(screen.queryByText(/Nobody booked today/)).not.toBeInTheDocument();
    expect(screen.getByText(/could not|couldn't|failed|error/i)).toBeInTheDocument();
  });

  test.fails("REG-FE-RECEP-033 KNOWN BUG UX-1 a failed patient search is shown as an error, not 'Nobody matches'", async () => {
    pats.searchPatients.mockRejectedValue(new Error("search down"));
    const { user } = page();
    await user.type(searchBox(), "genet");
    await waitFor(() => expect(pats.searchPatients).toHaveBeenCalled());
    await new Promise((r) => setTimeout(r, 50));
    expect(screen.queryByText(/Nobody matches/)).not.toBeInTheDocument();
    expect(screen.getByText(/could not|couldn't|failed|error/i)).toBeInTheDocument();
  });

  test("REG-FE-RECEP-034 an empty search offers registration", async () => {
    const { user } = page();
    await user.type(searchBox(), "zzz");
    expect(await screen.findByText(/Nobody matches/)).toBeInTheDocument();
    expect(screen.getByText("0 matching")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Register them" })).toBeInTheDocument();
  });

  test.fails("REG-FE-RECEP-035 KNOWN BUG UX-6 'New' opens registration (/patients/new), not the list page that ignores ?new=1", async () => {
    page();
    expect(await screen.findByRole("link", { name: "New" })).toHaveAttribute("href", "/patients/new");
  });

  test.fails("REG-FE-RECEP-036 KNOWN BUG UX-6 'Register them' opens registration (/patients/new)", async () => {
    const { user } = page();
    await user.type(searchBox(), "zzz");
    expect(await screen.findByRole("link", { name: "Register them" })).toHaveAttribute("href", "/patients/new");
  });

  test.fails("REG-FE-RECEP-037 KNOWN BUG FIN-5 settling a waiting patient's debt names the charges shown, not 'everything owed'", async () => {
    const { user } = page();
    await user.click(await screen.findByRole("tab", { name: /Waiting/ }));
    await pick(user, /Chaltu Abdi/);
    await user.click(await screen.findByRole("button", { name: "Collect ETB 500.00" }));
    await waitFor(() => expect(bill.settleVisit).toHaveBeenCalled());
    const body = bill.settleVisit.mock.calls[0][1] as { charge_ids?: string[] };
    expect(Array.isArray(body.charge_ids) && body.charge_ids.length > 0).toBe(true);
  });

  test.fails("REG-FE-RECEP-038 KNOWN BUG NEW-RECEP-1 Pay later checks the patient in and defers only this visit's charges", async () => {
    bill.deferVisit.mockResolvedValue({ deferred: 1 });
    const { user } = page();
    await pick(user, /Almaz Haile/);
    await user.click(await screen.findByRole("button", { name: "Pay later…" }));
    const dlg = await screen.findByRole("dialog");
    await choose(user, within(dlg).getByRole("combobox"), "Cannot pay today");
    await user.click(within(dlg).getByRole("button", { name: "Send through, bill later" }));
    await waitFor(() => expect(bill.deferVisit).toHaveBeenCalled());
    // Correct: the arrival happens (booking marked arrived, today's fee raised) and only
    // what it raised is deferred — not the 300 ETB of older debt this patient also owes.
    expect(sched.checkInAppointment).toHaveBeenCalledWith("apt_a", expect.anything());
    expect(bill.deferVisit).toHaveBeenCalledWith("pat_a", expect.objectContaining({ charge_ids: ["chg_visit"] }));
  });

  test.fails("REG-FE-RECEP-039 KNOWN BUG NEW-RECEP-2 a patient on 'To settle' can be settled from the panel, not offered a new visit fee", async () => {
    const { user } = page();
    await user.click(await screen.findByRole("tab", { name: /To settle/ }));
    await pick(user, /Dawit Alemu/);
    await screen.findByRole("heading", { name: "Dawit Alemu" });
    // Today the panel says "today's fee is already paid, so there is nothing more to
    // collect" for a patient listed as owing 800, and offers a fresh 100 ETB visit.
    expect(screen.queryByText(/nothing more to collect/)).not.toBeInTheDocument();
    expect(await screen.findByRole("button", { name: "Collect ETB 800.00" })).toBeInTheDocument();
  });

  test.fails("REG-FE-RECEP-040 KNOWN BUG NEW-RECEP-3 a desk without payment.collect is not offered 'Collect', and never settles", async () => {
    as(["patient.read", "payment.charge"]);
    const { user } = page();
    await pick(user, /Almaz Haile/);
    await screen.findByRole("button", { name: "Send to cashier" });
    const primary = screen.queryByRole("button", { name: /Collect ETB/ });
    if (primary) await user.click(primary);
    await new Promise((r) => setTimeout(r, 50));
    expect(primary).toBeNull();
    expect(bill.settleVisit).not.toHaveBeenCalled();
  });
});
