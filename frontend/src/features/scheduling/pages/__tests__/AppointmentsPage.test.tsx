// The Appointments page: the front desk's calendar for a dental clinic. What it must
// get right:
//  - the day / week / month views fetch exactly the window they show (local days)
//    and put each appointment and each dental treatment session on its own day;
//  - the day view is one lane per doctor, with the status, follow-up cover and
//    "needs handoff" a receptionist acts on, and the treatment sessions beside them
//    coloured by money (owes / paid / free / at cashier / unpaid);
//  - the filters (patient, provider) live in the URL, reach the sessions too, and
//    say plainly that the calendar is filtered;
//  - every row action reaches the server for THAT appointment: check in, confirm,
//    complete, no-show, cancel, reschedule (the booking dialog) and reassign (the
//    in-file ReassignDialog, which keeps who ordered the follow-up);
//  - the follow-ups lens fetches the follow-ups and wires its actions back here.
// The APIs are mocked and answer by window, so a test sees what a real week would.
// "Today" is frozen at 11:00 local on 2026-10-05 (a Monday) and every appointment is
// built from local wall-clock parts, so nothing depends on the zone or the hour.
import { act, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

vi.setConfig({ testTimeout: 30000 });

const auth = vi.hoisted(() => ({
  perms: new Set<string>(), flags: new Set<string>(["dental"]), branch: "br1" as string | null,
}));
vi.mock("@/app/auth-context", () => ({
  useAuth: () => ({
    can: (p: string) => auth.perms.has(p), flagOn: (f: string) => auth.flags.has(f),
    user: { id: "u1", full_name: "Hanna Desta" }, activeBranchId: auth.branch,
  }),
}));

const sched = vi.hoisted(() => ({
  listAppointments: vi.fn(), listFollowups: vi.fn(), reassignProvider: vi.fn(), setAppointmentStatus: vi.fn(),
  checkInAppointment: vi.fn(), bookAppointment: vi.fn(), rescheduleAppointment: vi.fn(),
}));
vi.mock("@/features/scheduling/api", async (orig) => ({ ...(await orig<object>()), ...sched }));

const admin = vi.hoisted(() => ({ listBranches: vi.fn(), listProviders: vi.fn(), listDepartments: vi.fn(), getSettings: vi.fn() }));
vi.mock("@/features/admin/api", async (orig) => ({ ...(await orig<object>()), ...admin }));

const pats = vi.hoisted(() => ({ getPatient: vi.fn(), searchPatients: vi.fn() }));
vi.mock("@/features/patients/api", async (orig) => ({ ...(await orig<object>()), ...pats }));

const dental = vi.hoisted(() => ({ listDentalSessions: vi.fn() }));
vi.mock("@/features/dental/api", async (orig) => ({ ...(await orig<object>()), ...dental }));

const tst = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }));
vi.mock("@/components/ui/sonner", async (orig) => ({ ...(await orig<object>()), toast: tst }));

import { AppointmentsPage } from "@/features/scheduling/pages/AppointmentsPage";
import type { Appointment } from "@/features/scheduling/api";
import type { DentalSessionCal } from "@/features/dental/api";
import { AppError } from "@/lib/api-client";
import { currentLocation, freezeToday, renderUI } from "@/test/render";

const STAFF = ["appointment.manage", "queue.manage", "dental.manage"];
const local = (y: number, m: number, d: number, h: number, min = 0) => new Date(y, m - 1, d, h, min).toISOString();
const at = (d: number, h: number, min = 0) => local(2026, 10, d, h, min);

const A = (id: string, startsAt: string, over: Partial<Appointment> = {}): Appointment => ({
  id, patient_id: `pat_${id}`, provider_id: "doc1", department_id: "dep1", starts_at: startsAt,
  ends_at: new Date(new Date(startsAt).getTime() + 30 * 60000).toISOString(), status: "booked",
  is_followup: false, patient_name: `Patient ${id}`, mrn: `MRN-${id}`, provider_name: "Dr Sara",
  provider_active: true, ...over,
});
const S = (id: string, date: string, over: Partial<DentalSessionCal> = {}): DentalSessionCal => ({
  session_id: id, plan_id: `plan_${id}`, patient_id: `pat_${id}`, patient_name: `Sess ${id}`, mrn: "M",
  scheduled_date: date, seq: 2, session_count: 5, title: "Root canal", amount_due: "2000", status: "planned",
  payment: "unpaid", pay_later: false, kind: "visit", ...over,
});

const PROVIDERS = [{ id: "doc1", full_name: "Dr Sara" }, { id: "doc2", full_name: "Dr Abebe" }];

/** A Monday's day sheet: every status, cover state and handoff case the lanes show. */
const monday = (): Appointment[] => [
  A("a1", at(5, 9), { patient_id: "pat_a", patient_name: "Almaz Haile", mrn: "M-001", reason: "Toothache" }),
  A("a2", at(5, 10), { patient_name: "Bekele T", status: "confirmed", is_followup: true, free_until: at(20, 12),
    ordered_by: "doc2", ordered_by_name: "Dr Abebe" }),
  A("a3", at(5, 11), { patient_name: "Chaltu A", provider_id: "doc2", provider_name: "Dr Abebe", is_followup: true, free_until: at(1, 12) }),
  A("a4", at(5, 12), { patient_name: "Dawit K", provider_id: "doc3", provider_name: "Dr Left", provider_active: false }),
  A("a5", at(5, 8), { patient_name: "Eden M", provider_id: "doc2", provider_name: "Dr Abebe", status: "completed", is_followup: true }),
  A("a6", at(5, 13), { patient_name: "Fikir B", provider_id: "doc2", provider_name: "Dr Abebe", status: "checked_in", is_followup: true }),
];
const mondaySessions = (): DentalSessionCal[] => [
  S("s1", "2026-10-05", { patient_id: "pat_a", patient_name: "Almaz Haile", procedure: "RCT", tooth: "36" }),
  S("s2", "2026-10-05", { patient_name: "Genet O", status: "done", payment: "unpaid" }),
  S("s3", "2026-10-05", { patient_name: "Hana P", status: "done", payment: "paid" }),
  S("s4", "2026-10-05", { patient_name: "Iman Q", payment: "waived" }),
  S("s5", "2026-10-05", { patient_name: "Jemal R", payment: "billed", amount_due: "1500.5" }),
];

let appts: Appointment[] = [];
let sessions: DentalSessionCal[] = [];

function serve() {
  sched.listAppointments.mockImplementation(async (_b: string, from: string, to: string) =>
    appts.filter((a) => a.starts_at >= from && a.starts_at < to));
  dental.listDentalSessions.mockImplementation(async (from: string, to: string) =>
    sessions.filter((s) => s.scheduled_date >= from && s.scheduled_date <= to));
}

function page(route: string) {
  return renderUI(<AppointmentsPage />, { route });
}
/** Make the md breakpoint match, i.e. a desktop browser. */
function desktop() {
  const mq = (q: string) => ({ matches: true, media: q, onchange: null, addListener() {}, removeListener() {},
    addEventListener() {}, removeEventListener() {}, dispatchEvent: () => false }) as unknown as MediaQueryList;
  vi.spyOn(window, "matchMedia").mockImplementation(mq);
}
const label = () => screen.getByRole("heading", { name: "Appointments" }).nextElementSibling!.textContent ?? "";
const lastWindow = () => sched.listAppointments.mock.calls.at(-1)!.slice(1, 3);
type U = ReturnType<typeof renderUI>["user"];
/** The day-view appointment card for a patient (a session card can carry the same name). */
function apptCard(patient: string) {
  const cards = screen.queryAllByRole("button", { name: patient })
    .map((b) => b.closest("div.rounded-lg") as HTMLElement | null)
    .filter((c): c is HTMLElement => !!c && !!within(c).queryByRole("button", { name: "Appointment actions" }));
  return cards[0] ?? null;
}
/** Wait for the day sheet to be on screen. */
const daySheet = () => screen.findByText("Dawit K");
async function openMenuOf(user: U, patient: string) {
  await user.click(within(apptCard(patient)!).getByRole("button", { name: "Appointment actions" }));
  return screen.findByRole("menu");
}

describe("REG-FE-APPT appointments page", () => {
  beforeEach(() => {
    freezeToday("2026-10-05", 11);
    auth.perms = new Set(STAFF);
    auth.flags = new Set(["dental"]);
    auth.branch = "br1";
    for (const f of [...Object.values(sched), ...Object.values(admin), ...Object.values(pats), ...Object.values(dental)]) f.mockReset();
    tst.success.mockReset(); tst.error.mockReset();
    appts = monday();
    sessions = mondaySessions();
    serve();
    sched.listFollowups.mockResolvedValue([]);
    sched.setAppointmentStatus.mockResolvedValue(undefined);
    sched.checkInAppointment.mockResolvedValue({ gated: false, charge_ids: [] });
    sched.reassignProvider.mockResolvedValue(undefined);
    sched.rescheduleAppointment.mockResolvedValue({ id: "a1" });
    admin.listBranches.mockResolvedValue([{ id: "br1", name: "Bole" }]);
    admin.listProviders.mockResolvedValue(PROVIDERS);
    admin.listDepartments.mockResolvedValue([{ id: "dep1", name: "Dental" }]);
    admin.getSettings.mockResolvedValue({ free_window_days: 30 });
    pats.getPatient.mockImplementation(async (id: string) => ({ id, first_name: "Almaz", last_name: "Haile" }));
    pats.searchPatients.mockResolvedValue({ items: [{ id: "pat_b", first_name: "Bekele", last_name: "T", mrn: "M-002" }], meta: {} });
  });
  afterEach(() => vi.useRealTimers());

  test("REG-FE-APPT-001 day view: fetches that one local day, one lane per doctor sorted by name", async () => {
    page("/appointments?date=2026-10-05");
    await daySheet();
    expect(label()).toMatch(/October 5/);
    expect(label()).toContain("Meskerem 25, 2019");
    expect(sched.listAppointments).toHaveBeenCalledWith("br1", at(5, 0), at(6, 0));
    expect(dental.listDentalSessions).toHaveBeenCalledWith("2026-10-05", "2026-10-05");
    const lanes = screen.getAllByText(/^(Dr Abebe|Dr Left|Dr Sara)$/, { selector: "span.truncate" }).map((e) => e.textContent);
    expect(lanes).toEqual(["Dr Abebe", "Dr Left", "Dr Sara"]);
    // Within a lane, earliest first.
    const abebe = screen.getByText("Dr Abebe", { selector: "span.truncate" }).closest(".flex-col") as HTMLElement;
    expect(within(abebe).getAllByRole("button", { name: /Eden|Chaltu|Fikir/ }).map((b) => b.textContent)).toEqual(["Eden M", "Chaltu A", "Fikir B"]);
    expect(screen.getByText(/M-001 · Toothache/)).toBeInTheDocument();
  });

  test("REG-FE-APPT-002 a card says status, follow-up cover, handoff and who ordered it", async () => {
    page("/appointments?date=2026-10-05");
    const card = (name: string) => apptCard(name)!;
    await daySheet();
    expect(card("Almaz Haile")).toHaveTextContent("booked");
    expect(card("Bekele T")).toHaveTextContent(/confirmed.*follow-up.*covered → Oct 20/);
    expect(card("Bekele T")).toHaveTextContent("Ordered by Dr Abebe · handled by Dr Sara");
    expect(card("Chaltu A")).toHaveTextContent("cover expired");
    expect(card("Eden M")).toHaveTextContent("attended");
    expect(card("Fikir B")).toHaveTextContent(/checked in.*covered$/);
    expect(card("Dawit K")).toHaveTextContent("needs handoff");
    expect(card("Almaz Haile")).not.toHaveTextContent(/follow-up|needs handoff|Ordered by/);
  });

  test("REG-FE-APPT-003 day view: treatment sessions in their own lane, each with its money word", async () => {
    const { user } = page("/appointments?date=2026-10-05");
    const lane = (await screen.findByText("Treatment sessions")).closest(".flex-col") as HTMLElement;
    const sess = (name: string) => within(lane).getByRole("button", { name }).parentElement as HTMLElement;
    expect(lane).toHaveTextContent("5");
    expect(sess("Almaz Haile")).toHaveTextContent("Root canal · session 2/5 · RCT (36)");
    expect(sess("Almaz Haile")).toHaveTextContent(/unpaid.*2,000 ETB/);
    expect(sess("Genet O")).toHaveTextContent("owes");
    expect(sess("Hana P")).toHaveTextContent("paid");
    expect(sess("Iman Q")).toHaveTextContent("free of charge");
    expect(sess("Jemal R")).toHaveTextContent(/at cashier.*1,500\.5 ETB/);
    await user.click(within(lane).getByRole("button", { name: "Genet O" }));
    expect(currentLocation()).toBe("/patients/pat_s2?visit=s2");
  });

  test("REG-FE-APPT-004 clicking a patient on a card opens their record", async () => {
    const { user } = page("/appointments?date=2026-10-05");
    await user.click(await screen.findByRole("button", { name: "Dawit K" }));
    expect(currentLocation()).toBe("/patients/pat_a4");
  });

  test("REG-FE-APPT-005 an empty day says so, and on a phone offers the week", async () => {
    appts = []; sessions = [];
    const { user } = page("/appointments?date=2026-10-06");
    expect(await screen.findByText("No appointments or treatment sessions for this day.")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Look at the week" }));
    expect(await screen.findByText("No appointments or treatment sessions this week.")).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "Week" })).toHaveAttribute("aria-selected", "true");
  });

  test("REG-FE-APPT-006 the provider filter is in the URL and narrows the lanes", async () => {
    const { user } = page("/appointments?date=2026-10-05&provider=doc2");
    await screen.findByText("Chaltu A", { selector: "button" });
    expect(apptCard("Almaz Haile")).toBeNull();
    expect(screen.queryByText("Dr Sara", { selector: "span.truncate" })).not.toBeInTheDocument();
    const select = screen.getByRole("combobox");
    expect(select).toHaveTextContent("Dr Abebe");
    await user.click(select);
    await user.click(await screen.findByRole("option", { name: "Dr Sara" }));
    expect(currentLocation()).toBe("/appointments?date=2026-10-05&provider=doc1");
    expect(await screen.findByText("Bekele T", { selector: "button" })).toBeInTheDocument();
    await user.click(screen.getByRole("combobox"));
    await user.click(await screen.findByRole("option", { name: "All providers" }));
    expect(currentLocation()).toBe("/appointments?date=2026-10-05");
  });

  test("REG-FE-APPT-007 a provider with nothing on the day: the empty message names the filter", async () => {
    sessions = [];
    page("/appointments?date=2026-10-05&provider=doc9");
    expect(await screen.findByText("No appointments for this provider today.")).toBeInTheDocument();
  });

  test("REG-FE-APPT-008 the patient filter narrows appointments AND sessions and says so", async () => {
    const { user } = page("/appointments?date=2026-10-05&patient=pat_a");
    expect(await screen.findByText(/Showing/)).toHaveTextContent(/^Showing (this patient|Almaz Haile) only/);
    await waitFor(() => expect(screen.getByText(/Showing/)).toHaveTextContent("Showing Almaz Haile only — appointments and treatment visits."));
    expect(pats.getPatient).toHaveBeenCalledWith("pat_a");
    expect(screen.getByRole("link", { name: "Open their record" })).toHaveAttribute("href", "/patients/pat_a");
    const lane = screen.getByText("Treatment sessions").closest(".flex-col") as HTMLElement;
    expect(within(lane).getAllByRole("button").map((b) => b.textContent)).toEqual(["Almaz Haile"]);
    expect(screen.queryByText("Bekele T")).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /Show everyone/ }));
    expect(currentLocation()).toBe("/appointments?date=2026-10-05");
    expect(await screen.findByText("Bekele T", { selector: "button" })).toBeInTheDocument();
  });

  test("REG-FE-APPT-009 the toolbar patient chip clears the filter; the search sets it", async () => {
    appts = []; sessions = []; // so the only "Almaz Haile" button is the filter chip
    const { user } = page("/appointments?date=2026-10-05&patient=pat_a");
    const chip = await screen.findByRole("button", { name: "Almaz Haile" });
    await user.click(chip);
    expect(currentLocation()).toBe("/appointments?date=2026-10-05");
    await user.click(screen.getByRole("button", { name: /Search patient/ }));
    await user.click(await screen.findByRole("option", { name: /Bekele T/ }));
    expect(currentLocation()).toBe("/appointments?date=2026-10-05&patient=pat_b");
  });

  test("REG-FE-APPT-010 the phone Filters panel holds the filters and the legend, with a count", async () => {
    const { user } = page("/appointments?date=2026-10-05&patient=pat_a&provider=doc1");
    const toggle = await screen.findByRole("button", { name: /Filters \(2\)/ });
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    await user.click(toggle);
    expect(toggle).toHaveAttribute("aria-expanded", "true");
    expect(screen.getAllByRole("combobox")).toHaveLength(2); // the provider select, now in two homes
    expect(screen.getAllByText("Treatment session")).toHaveLength(2); // legend: desktop row + panel
  });

  test("REG-FE-APPT-011 Previous / Next / Today move the day and refetch that window", async () => {
    const { user } = page("/appointments?date=2026-10-05");
    await daySheet();
    await user.click(screen.getAllByRole("button", { name: "Next day" })[0]);
    await waitFor(() => expect(lastWindow()).toEqual([at(6, 0), at(7, 0)]));
    expect(label()).toMatch(/October 6/);
    await user.click(screen.getAllByRole("button", { name: "Previous day" })[0]);
    await user.click(screen.getAllByRole("button", { name: "Previous day" })[1]);
    await waitFor(() => expect(label()).toMatch(/October 4/));
    await user.click(screen.getByRole("button", { name: "Today" }));
    await waitFor(() => expect(label()).toMatch(/October 5/));
  });

  test("REG-FE-APPT-012 the view switcher: week and month fetch Monday-aligned windows", async () => {
    const { user } = page("/appointments?date=2026-10-07");
    await user.click(screen.getByRole("tab", { name: "Week" }));
    await waitFor(() => expect(lastWindow()).toEqual([at(5, 0), at(12, 0)]));
    expect(dental.listDentalSessions).toHaveBeenLastCalledWith("2026-10-05", "2026-10-11");
    expect(label()).toMatch(/Oct 5 – Oct 11, 2026 · Meskerem–Tikimt 2019/);
    await user.click(screen.getAllByRole("button", { name: "Next week" })[0]);
    await waitFor(() => expect(lastWindow()).toEqual([at(12, 0), at(19, 0)]));
    await user.click(screen.getByRole("tab", { name: "Month" }));
    // October 2026 starts on a Thursday: the grid opens on Monday 28 September, six weeks.
    await waitFor(() => expect(lastWindow()).toEqual([local(2026, 9, 28, 0), local(2026, 11, 9, 0)]));
    expect(label()).toMatch(/October 2026 · Meskerem–Tikimt 2019/);
    await user.click(screen.getAllByRole("button", { name: "Next month" })[0]);
    await waitFor(() => expect(label()).toMatch(/November 2026/));
    await user.click(screen.getAllByRole("button", { name: "Previous month" })[0]);
    await waitFor(() => expect(label()).toMatch(/October 2026/));
  });

  test("REG-FE-APPT-013 month view: counts per day, '+N more', and a day opens on click", async () => {
    appts = [...monday(), A("b1", at(14, 9), { patient_name: "Kidus" })];
    sessions = [...mondaySessions(), S("t1", "2026-10-14", { patient_name: "Lulit" })];
    const { user } = page("/appointments?view=month&date=2026-10-15");
    const mon = await screen.findByRole("button", { name: /Monday, October 5, 11 booked/ });
    // 6 appointments + 5 sessions: two of each shown, the rest summed.
    expect(mon).toHaveTextContent("+7 more");
    expect(within(mon).getAllByTitle(/session/)).toHaveLength(2);
    const wed = screen.getByRole("button", { name: /Wednesday, October 14, 2 booked/ });
    expect(wed).toHaveTextContent("Kidus");
    expect(wed).toHaveTextContent("Lulit");
    expect(wed).not.toHaveTextContent("more");
    expect(screen.getAllByRole("button", { name: /day, (September|October|November) \d+/ })).toHaveLength(42);
    expect(screen.getByRole("button", { name: /^Sunday, October 11$/ })).toHaveTextContent("Tikimt"); // 1 Tikimt: the EC month is named
    expect(screen.getByRole("button", { name: /^Thursday, October 1$/ })).toHaveTextContent("121"); // 1 Oct = 21 Meskerem
    await user.click(wed);
    expect(screen.getByRole("tab", { name: "Day" })).toHaveAttribute("aria-selected", "true");
    await waitFor(() => expect(label()).toMatch(/October 14/));
  });

  test("REG-FE-APPT-014 a patient deep link opens on the month; a desktop opens on the week; a phone on the day", async () => {
    const one = page("/appointments?patient=pat_a");
    expect(screen.getByRole("tab", { name: "Month" })).toHaveAttribute("aria-selected", "true");
    one.unmount();
    const two = page("/appointments");
    expect(screen.getByRole("tab", { name: "Day" })).toHaveAttribute("aria-selected", "true");
    await waitFor(() => expect(label()).toMatch(/October 5/));
    two.unmount();
    desktop();
    page("/appointments");
    expect(screen.getByRole("tab", { name: "Week" })).toHaveAttribute("aria-selected", "true");
  });

  test("REG-FE-APPT-015 desktop week grid: a header per day, overlaps side by side, early hours shown", async () => {
    desktop();
    appts = [
      A("w1", at(6, 9), { patient_name: "Over One", ends_at: at(6, 10) }),
      A("w2", at(6, 9, 30), { patient_name: "Over Two", is_followup: true, reason: "check" }),
      A("w3", at(7, 6), { patient_name: "Early Bird", ends_at: at(7, 6, 45) }),
    ];
    sessions = [S("ws", "2026-10-08", { patient_name: "Sess Wed", status: "done", payment: "unpaid" })];
    const { user } = page("/appointments?view=week&date=2026-10-07");
    const one = await screen.findByRole("button", { name: /Over One/ });
    const two = screen.getByRole("button", { name: /Over Two/ });
    expect(one.style.width).toBe("calc(50% - 4px)");
    expect(two.style.left).toBe("calc(50% + 2px)");
    expect(two).toHaveAttribute("title", expect.stringMatching(/Over Two · check$/));
    expect(screen.getByRole("button", { name: /Early Bird/ }).style.width).toBe("calc(100% - 4px)");
    expect(screen.getByText("07:00")).toBeInTheDocument(); // the grid starts at 06:00, not 08:00
    expect(screen.getByText("Sessions")).toBeInTheDocument();
    expect(screen.getByTitle(/Root canal — session 2\/5 · Sess Wed · owes/)).toBeInTheDocument();
    await user.click(screen.getByTitle(/Sess Wed/));
    expect(currentLocation()).toBe("/patients/pat_ws?visit=ws");
    await user.click(screen.getByRole("button", { name: /Over One/ }));
    expect(currentLocation()).toBe("/patients/pat_w1");
  });

  test("REG-FE-APPT-016 desktop week grid: a day header opens that day", async () => {
    desktop();
    appts = []; sessions = [];
    const { user } = page("/appointments?view=week&date=2026-10-07");
    const headers = await screen.findAllByRole("button", { name: /^(Mon|Tue|Wed|Thu|Fri|Sat|Sun)\s*\d+/ });
    expect(headers).toHaveLength(7);
    expect(screen.queryByText("Sessions")).not.toBeInTheDocument();
    await user.click(headers[4]); // Friday 9
    await waitFor(() => expect(label()).toMatch(/Friday, October 9/));
  });

  test("REG-FE-APPT-017 phone week: an agenda by day with counts, money words, and links", async () => {
    appts = [A("w1", at(6, 9), { patient_name: "Tue One", is_followup: true }), A("w2", at(6, 8), { patient_name: "Tue Zero", status: "no_show" })];
    sessions = [S("p1", "2026-10-08", { patient_name: "Paid Wed", status: "done", payment: "paid" }),
      S("o1", "2026-10-08", { patient_name: "Owes Wed", status: "done" }), S("n1", "2026-10-08", { patient_name: "Plain Wed" })];
    const { user } = page("/appointments?view=week&date=2026-10-07");
    const tue = await screen.findByRole("button", { name: /Open Tuesday, October 6/ });
    expect(tue).toHaveTextContent("2");
    const section = tue.closest("section") as HTMLElement;
    expect(within(section).getAllByRole("button").slice(1).map((b) => b.textContent)).toEqual([
      expect.stringMatching(/Tue Zero.*no show/), expect.stringMatching(/Tue One.*booked/)]);
    expect(screen.getByRole("button", { name: /Paid Wed/ })).toHaveTextContent("S2/5 · paid");
    expect(screen.getByRole("button", { name: /Owes Wed/ })).toHaveTextContent("S2/5 · owes");
    expect(screen.getByRole("button", { name: /Plain Wed/ })).toHaveTextContent(/S2\/5$/);
    expect(screen.queryByRole("button", { name: /Open Monday/ })).not.toBeInTheDocument(); // empty days are left out
    await user.click(screen.getByRole("button", { name: /Owes Wed/ }));
    expect(currentLocation()).toBe("/patients/pat_o1?visit=o1");
    await user.click(screen.getByRole("button", { name: /Tue One/ }));
    expect(currentLocation()).toBe("/patients/pat_w1");
    await user.click(screen.getByRole("button", { name: /Open Thursday, October 8/ }));
    await waitFor(() => expect(label()).toMatch(/Thursday, October 8/));
  });

  test("REG-FE-APPT-018 the actions menu offers only what fits the status and the role", async () => {
    const { user } = page("/appointments?date=2026-10-05");
    await daySheet();
    let menu = await openMenuOf(user, "Almaz Haile");
    expect(within(menu).getAllByRole("menuitem").map((m) => m.textContent)).toEqual(
      ["Check in", "Reassign doctor", "Reschedule", "Confirm", "Mark completed", "Mark no-show", "Cancel"]);
    await user.keyboard("{Escape}");
    menu = await openMenuOf(user, "Fikir B"); // already checked in
    expect(within(menu).getAllByRole("menuitem").map((m) => m.textContent)).toEqual(
      ["Reassign doctor", "Reschedule", "Mark completed", "Mark no-show", "Cancel"]);
    await user.keyboard("{Escape}");
    menu = await openMenuOf(user, "Bekele T"); // confirmed
    expect(within(menu).queryByRole("menuitem", { name: "Confirm" })).not.toBeInTheDocument();
    await user.keyboard("{Escape}");
    menu = await openMenuOf(user, "Eden M"); // completed: nothing left to do
    expect(within(menu).queryAllByRole("menuitem")).toHaveLength(0);
  });

  test("REG-FE-APPT-019 without queue rights there is no Check in", async () => {
    auth.perms = new Set(["appointment.manage"]);
    const { user } = page("/appointments?date=2026-10-05");
    await daySheet();
    const menu = await openMenuOf(user, "Almaz Haile");
    expect(within(menu).queryByRole("menuitem", { name: "Check in" })).not.toBeInTheDocument();
    // dental.manage is gone too, but appointment.manage still shows the sessions
    expect(screen.getByText("Treatment sessions")).toBeInTheDocument();
  });

  test("REG-FE-APPT-020 Check in reaches the server for that appointment and says where the patient went", async () => {
    sched.checkInAppointment
      .mockResolvedValueOnce({ gated: false, charge_ids: [] })
      .mockResolvedValueOnce({ gated: true, charge_ids: ["ch1"] })
      .mockRejectedValueOnce(new AppError(409, "no_dept", "This appointment has no department"))
      .mockRejectedValueOnce(new Error("boom"));
    const { user } = page("/appointments?date=2026-10-05");
    await daySheet();
    const checkIn = async () => user.click(within(await openMenuOf(user, "Almaz Haile")).getByRole("menuitem", { name: "Check in" }));
    await checkIn();
    await waitFor(() => expect(tst.success).toHaveBeenCalledWith("Checked in — added to queue."));
    expect(sched.checkInAppointment).toHaveBeenCalledWith("a1");
    await waitFor(() => expect(sched.listAppointments.mock.calls.length).toBeGreaterThan(1)); // refetched
    await checkIn();
    await waitFor(() => expect(tst.success).toHaveBeenLastCalledWith("Checked in — billed; joins the queue once payment is collected."));
    await checkIn();
    await waitFor(() => expect(tst.error).toHaveBeenCalledWith("This appointment has no department"));
    await checkIn();
    await waitFor(() => expect(tst.error).toHaveBeenLastCalledWith("Check-in failed"));
  });

  test.each([
    ["Confirm", "confirmed", "Confirmed"],
    ["Mark completed", "completed", "Marked completed"],
    ["Mark no-show", "no_show", "Marked no-show"],
    ["Cancel", "cancelled", "Appointment cancelled"],
  ])("REG-FE-APPT-021 %s sends status %s for that appointment only", async (item, status, msg) => {
    const { user } = page("/appointments?date=2026-10-05");
    await screen.findByText("Dawit K", { selector: "button" });
    await user.click(within(await openMenuOf(user, "Dawit K")).getByRole("menuitem", { name: item }));
    await waitFor(() => expect(sched.setAppointmentStatus).toHaveBeenCalledWith("a4", status));
    expect(sched.setAppointmentStatus).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(tst.success).toHaveBeenCalledWith(msg));
  });

  test("REG-FE-APPT-022 a refused status change is reported, plain or from the server", async () => {
    sched.setAppointmentStatus
      .mockRejectedValueOnce(new AppError(409, "state", "Already checked in"))
      .mockRejectedValueOnce(new Error("x"));
    const { user } = page("/appointments?date=2026-10-05");
    await screen.findByText("Dawit K", { selector: "button" });
    await user.click(within(await openMenuOf(user, "Dawit K")).getByRole("menuitem", { name: "Cancel" }));
    await waitFor(() => expect(tst.error).toHaveBeenCalledWith("Already checked in"));
    await user.click(within(await openMenuOf(user, "Dawit K")).getByRole("menuitem", { name: "Mark no-show" }));
    await waitFor(() => expect(tst.error).toHaveBeenLastCalledWith("Could not update"));
  });

  test("REG-FE-APPT-023 Reschedule opens the booking dialog on that appointment and saves it", async () => {
    const { user } = page("/appointments?date=2026-10-05");
    await daySheet();
    await user.click(within(await openMenuOf(user, "Almaz Haile")).getByRole("menuitem", { name: "Reschedule" }));
    const dlg = await screen.findByRole("dialog");
    expect(dlg).toHaveTextContent("Reschedule appointment");
    expect(within(dlg).getByDisplayValue("Almaz Haile")).toBeDisabled();
    const save = within(dlg).getByRole("button", { name: "Save changes" });
    await waitFor(() => expect(save).toBeEnabled());
    const before = sched.listAppointments.mock.calls.length;
    await user.click(save);
    await waitFor(() => expect(sched.rescheduleAppointment).toHaveBeenCalledWith("a1", expect.objectContaining({ starts_at: at(5, 9), provider_id: "doc1" })));
    await waitFor(() => expect(sched.listAppointments.mock.calls.length).toBeGreaterThan(before));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
  });

  test("REG-FE-APPT-024 Book opens a blank booking on the day being viewed; hidden without the right", async () => {
    const { user, unmount } = page("/appointments?date=2026-10-08");
    await user.click(await screen.findByRole("button", { name: "Book" }));
    const dlg = await screen.findByRole("dialog");
    expect(dlg).toHaveTextContent("Book appointment");
    expect(dlg.querySelector<HTMLInputElement>('input[type="date"]')!.value).toBe("2026-10-08");
    unmount();
    auth.perms = new Set(["queue.manage"]);
    page("/appointments?date=2026-10-08");
    await waitFor(() => expect(sched.listAppointments).toHaveBeenCalled());
    expect(screen.queryByRole("button", { name: "Book" })).not.toBeInTheDocument();
  });

  test("REG-FE-APPT-025 Reassign: other doctors only, the order stays credited, the note is sent", async () => {
    const { user } = page("/appointments?date=2026-10-05");
    await screen.findByText("Bekele T", { selector: "button" });
    await user.click(within(await openMenuOf(user, "Bekele T")).getByRole("menuitem", { name: "Reassign doctor" }));
    const dlg = await screen.findByRole("dialog");
    expect(dlg).toHaveTextContent("Reassign to another doctor");
    expect(dlg).toHaveTextContent(/Bekele T · Mon, Oct 5 .*Currently with Dr Sara, ordered by Dr Abebe\. The order stays credited/);
    const go = within(dlg).getByRole("button", { name: "Reassign" });
    expect(go).toBeDisabled();
    await user.click(within(dlg).getByRole("combobox"));
    const options = await screen.findAllByRole("option");
    expect(options.map((o) => o.textContent)).toEqual(["Dr Abebe"]); // not the doctor it is already with
    await user.click(options[0]);
    await user.type(within(dlg).getByPlaceholderText(/on leave/), "Dr Sara is away");
    await user.click(go);
    await waitFor(() => expect(sched.reassignProvider).toHaveBeenCalledWith("a2", "doc2", "Dr Sara is away"));
    await waitFor(() => expect(tst.success).toHaveBeenCalledWith("Follow-up handed off"));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
  });

  test("REG-FE-APPT-026 Reassign: no note is sent as none; a refusal is shown and the dialog stays", async () => {
    sched.reassignProvider.mockRejectedValueOnce(new AppError(403, "denied", "Not your patient")).mockRejectedValueOnce(new Error("x"));
    const { user } = page("/appointments?date=2026-10-05");
    await daySheet();
    await user.click(within(await openMenuOf(user, "Almaz Haile")).getByRole("menuitem", { name: "Reassign doctor" }));
    const dlg = await screen.findByRole("dialog");
    expect(dlg).not.toHaveTextContent("ordered by");
    await user.click(within(dlg).getByRole("combobox"));
    await user.click(await screen.findByRole("option", { name: "Dr Abebe" }));
    await user.click(within(dlg).getByRole("button", { name: "Reassign" }));
    await waitFor(() => expect(sched.reassignProvider).toHaveBeenCalledWith("a1", "doc2", undefined));
    await waitFor(() => expect(tst.error).toHaveBeenCalledWith("Not your patient"));
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    await user.click(within(dlg).getByRole("button", { name: "Reassign" }));
    await waitFor(() => expect(tst.error).toHaveBeenLastCalledWith("Could not reassign"));
    await user.click(within(dlg).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
  });

  // NEW-APPT-1. ReassignDialog is mounted once for the whole page and only clears its
  // chosen doctor after a SUCCESSFUL reassign (AppointmentsPage.tsx:868). Pick a
  // doctor, press Cancel, then open Reassign on a different appointment: the old
  // choice is still selected and "Reassign" is live before anyone has chosen — even
  // when the leftover doctor is the one the second appointment is already with (they
  // are filtered out of the list, :886, but still the value), so one click sends a
  // no-op "hand it to its own doctor" to the server.
  test.fails("REG-FE-APPT-027 KNOWN BUG NEW-APPT-1 reopening Reassign for another appointment starts with no doctor chosen", async () => {
    const { user } = page("/appointments?date=2026-10-05");
    await daySheet();
    await user.click(within(await openMenuOf(user, "Almaz Haile")).getByRole("menuitem", { name: "Reassign doctor" }));
    let dlg = await screen.findByRole("dialog");
    await user.click(within(dlg).getByRole("combobox"));
    await user.click(await screen.findByRole("option", { name: "Dr Abebe" }));
    await user.click(within(dlg).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    // Chaltu is already with Dr Abebe.
    await user.click(within(await openMenuOf(user, "Chaltu A")).getByRole("menuitem", { name: "Reassign doctor" }));
    dlg = await screen.findByRole("dialog");
    expect(dlg).toHaveTextContent("Currently with Dr Abebe");
    expect(within(dlg).getByRole("button", { name: "Reassign" })).toBeDisabled();
  });

  test("REG-FE-APPT-028 the follow-ups lens fetches follow-ups, not the calendar, and wires its actions here", async () => {
    sched.listFollowups.mockResolvedValue([
      A("f1", at(1, 9), { patient_name: "Missed Mo", is_followup: true }),
      A("f2", at(9, 9), { patient_name: "Gone Doc", is_followup: true, provider_active: false, provider_name: "Dr Left", provider_id: "doc3" }),
    ]);
    const { user } = page("/appointments?view=followups");
    expect(label()).toBe("Follow-ups needing attention and coming up");
    await screen.findByRole("tablist", { name: "Follow-ups" });
    expect(sched.listFollowups).toHaveBeenCalledWith("br1");
    expect(sched.listAppointments).not.toHaveBeenCalled();
    // The dental follow-up window: 30 days back, 120 ahead of today.
    expect(dental.listDentalSessions).toHaveBeenCalledWith("2026-09-05", "2027-02-02");
    expect(screen.queryByRole("button", { name: "Today" })).not.toBeInTheDocument();
    expect(screen.queryByText("Treatment session")).not.toBeInTheDocument(); // no calendar legend
    await user.click(screen.getByRole("button", { name: /^Rebook$/ }));
    const dlg = await screen.findByRole("dialog");
    expect(dlg).toHaveTextContent("Reschedule appointment");
    expect(within(dlg).getByDisplayValue("Missed Mo")).toBeInTheDocument();
    await user.click(within(dlg).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    await user.click(screen.getByRole("tab", { name: /Needs a new doctor/ }));
    await user.click(screen.getByRole("button", { name: /Reassign/ }));
    expect(await screen.findByRole("dialog")).toHaveTextContent("Currently with Dr Left");
  });

  test("REG-FE-APPT-029 a clinic with no branch is told to add one, and nothing is fetched or bookable", async () => {
    auth.branch = null;
    admin.listBranches.mockResolvedValue([]);
    page("/appointments?date=2026-10-05");
    expect(await screen.findByText("Add a branch in Settings to start booking.")).toBeInTheDocument();
    expect(sched.listAppointments).not.toHaveBeenCalled();
    expect(screen.queryByRole("button", { name: "Book" })).not.toBeInTheDocument();
  });

  test("REG-FE-APPT-030 with no active branch chosen, the clinic's first branch is used", async () => {
    auth.branch = null;
    admin.listBranches.mockResolvedValue([{ id: "br_first" }, { id: "br_second" }]);
    page("/appointments?date=2026-10-05");
    await waitFor(() => expect(sched.listAppointments).toHaveBeenCalledWith("br_first", at(5, 0), at(6, 0)));
  });

  test("REG-FE-APPT-031 not a dental clinic: no sessions fetched, no legend", async () => {
    auth.flags = new Set();
    page("/appointments?date=2026-10-05");
    await daySheet();
    expect(dental.listDentalSessions).not.toHaveBeenCalled();
    expect(screen.queryByText("Treatment sessions")).not.toBeInTheDocument();
    expect(screen.queryByText("Treatment session")).not.toBeInTheDocument();
  });

  test("REG-FE-APPT-032 while the calendar loads nothing claims the day is empty", async () => {
    sched.listAppointments.mockReturnValue(new Promise(() => {}));
    page("/appointments?date=2026-10-05");
    await waitFor(() => expect(sched.listAppointments).toHaveBeenCalled());
    await act(async () => {});
    expect(screen.queryByText(/No appointments/)).not.toBeInTheDocument();
    expect(screen.queryByText("Treatment sessions")).not.toBeInTheDocument();
  });

  test("REG-FE-APPT-033 a single provider gets no provider filter", async () => {
    admin.listProviders.mockResolvedValue([PROVIDERS[0]]);
    page("/appointments?date=2026-10-05");
    await daySheet();
    expect(screen.queryByRole("combobox")).not.toBeInTheDocument();
  });
});
