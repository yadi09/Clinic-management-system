// One patient's schedule: booked appointments and dental treatment sessions on one
// timeline (/patients/:id/schedule).
//
// What it must get right: the "next visit" answer comes first and counts the days
// to it; the two sources merge in date order (cancelled sessions dropped); a
// planned session whose day has passed is MISSED and is raised, with a way to fix
// it for whoever may reschedule; two changeable sessions on one day are flagged as
// a possible double-booking (never blocked); Upcoming / Past / All split on the
// clinic's today; a reschedule refreshes the timeline and the clinic calendar; a
// non-dental clinic never asks for dental data.
import { screen, waitFor, within } from "@testing-library/react";
import { Route, Routes } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

const patients = vi.hoisted(() => ({ getPatient: vi.fn() }));
const scheduling = vi.hoisted(() => ({ listPatientAppointments: vi.fn() }));
const dental = vi.hoisted(() => ({ dentalSummary: vi.fn() }));
const auth = vi.hoisted(() => ({ perms: new Set<string>(["appointment.manage"]), dental: true }));

vi.mock("@/features/patients/api", async (orig) => ({ ...(await orig<object>()), ...patients }));
vi.mock("@/features/scheduling/api", async (orig) => ({ ...(await orig<object>()), ...scheduling }));
vi.mock("@/features/dental/api", async (orig) => ({ ...(await orig<object>()), ...dental }));
vi.mock("@/lib/api-client", async (orig) => {
  const { quietApiFetch } = await import("@/test/render");
  return { ...(await orig<object>()), apiFetch: vi.fn(quietApiFetch) };
});
vi.mock("@/app/auth-context", () => ({
  useAuth: () => ({
    can: (p: string) => auth.perms.has(p),
    flagOn: (f: string) => (f === "dental" ? auth.dental : false),
  }),
}));
// The move dialog is its own tested component; here it only has to receive the
// right session and hand back the page's clash check and refresh.
vi.mock("@/features/dental/shared/MoveSessionDialog", () => ({
  MoveSessionDialog: (p: {
    sessionId: string; planTitle: string; currentDate: string; detail: string; missed?: boolean;
    clashes: (iso: string) => { id: string; label: string; done?: boolean }[];
    onClose: () => void; onMoved: () => void;
  }) => (
    <div role="dialog" aria-label="Move session">
      <p data-testid="move-props">{[p.sessionId, p.planTitle, p.currentDate, p.detail, String(!!p.missed)].join("|")}</p>
      <p data-testid="move-clashes">{JSON.stringify(p.clashes(p.currentDate))}</p>
      <button onClick={p.onMoved}>stub moved</button>
      <button onClick={p.onClose}>stub close</button>
    </div>
  ),
}));

import { PatientSchedulePage } from "../PatientSchedulePage";
import { currentLocation, freezeToday, renderUI } from "@/test/render";

const T = "2026-10-03";
const [Y, M, D] = T.split("-").map(Number);
/** The local calendar day `n` days from the frozen today, as YYYY-MM-DD. */
const day = (n: number) => {
  const d = new Date(Y, M - 1, D + n);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};
const at = (n: number, h: number) => new Date(Y, M - 1, D + n, h, 0).toISOString();

const patient = (extra: Record<string, unknown> = {}) => ({
  id: "pat_1", mrn: "MRN-42", first_name: "Abebe", middle_name: "Kebede", last_name: "Tesfaye", gender: "male",
  dob: "1990-01-01", phone: "", allergies: [], conditions: [], attachments: [], guardians: [], created_at: "", ...extra,
});
const appt = (id: string, n: number, extra: Record<string, unknown> = {}) => ({
  id, starts_at: at(n, 10), ends_at: at(n, 11), status: "booked", is_followup: false,
  provider_name: "Dr Selam", reason: "Check-up", patient_id: "pat_1", ...extra,
});
const sess = (id: string, seq: number, n: number, extra: Record<string, unknown> = {}) => ({
  id, seq, scheduled_date: day(n), amount_due: "0", status: "planned", payment: "unpaid", images: [], prescriptions: [], ...extra,
});
const plan = (title: string, sessions: unknown[]) => ({ id: title, title, session_count: sessions.length, sessions });
const summary = (...plans: unknown[]) => ({ chart: { teeth: {} }, plans, balance: {}, image_limit: -1 });

function page() {
  return renderUI(
    <Routes>
      <Route path="/patients/:id/schedule" element={<PatientSchedulePage />} />
      <Route path="*" element={<p>elsewhere</p>} />
    </Routes>,
    { route: "/patients/pat_1/schedule" },
  );
}
const loaded = () => screen.findByRole("heading", { level: 1, name: "Schedule" });
const nextCard = () => screen.getByText("Next visit").closest("div.border-l-4, .rounded-lg") as HTMLElement;
const attention = () => screen.getByText("Needs attention").closest(".overflow-hidden") as HTMLElement;
const lensBtn = (name: string) => screen.getByRole("button", { name: new RegExp(`^${name} \\d+$`) });

describe("REG-FE-PSCHED the patient's schedule", () => {
  beforeEach(() => {
    freezeToday(T, 9);
    auth.perms = new Set(["appointment.manage"]);
    auth.dental = true;
    [patients.getPatient, scheduling.listPatientAppointments, dental.dentalSummary].forEach((f) => f.mockReset());
    patients.getPatient.mockResolvedValue(patient());
    scheduling.listPatientAppointments.mockResolvedValue([]);
    dental.dentalSummary.mockResolvedValue(summary());
  });
  afterEach(() => vi.useRealTimers());

  test("REG-FE-PSCHED-001 while the patient loads: placeholders only", () => {
    patients.getPatient.mockReturnValue(new Promise(() => {}));
    const { container } = page();
    expect(container.querySelectorAll(".animate-pulse, [class*=skeleton]").length).toBeGreaterThan(0);
    expect(screen.queryByRole("heading", { level: 1 })).not.toBeInTheDocument();
  });

  test("REG-FE-PSCHED-002 the patient fails to load: says so, and Patients goes back to the list", async () => {
    patients.getPatient.mockRejectedValue(new Error("down"));
    const { user } = page();
    expect(await screen.findByText("Could not load this patient.")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /Patients/ }));
    expect(currentLocation()).toBe("/patients");
  });

  test("REG-FE-PSCHED-003 header: name, MRN and age; back to the profile; Book appointment for the desk", async () => {
    const { user } = page();
    await loaded();
    expect(screen.getByText("Abebe Kebede Tesfaye · MRN MRN-42 · 36 yrs")).toBeInTheDocument();
    // Two years back, two forward, for this patient.
    const [pid, from, to] = scheduling.listPatientAppointments.mock.calls[0];
    expect(pid).toBe("pat_1");
    expect(new Date(from).getFullYear()).toBe(Y - 2);
    expect(new Date(to).getFullYear()).toBe(Y + 2);
    await user.click(screen.getByRole("button", { name: "Book appointment" }));
    expect(currentLocation()).toBe("/appointments");
  });

  test("REG-FE-PSCHED-004 back link opens the patient's profile; no Book button without appointment.manage", async () => {
    auth.perms = new Set();
    patients.getPatient.mockResolvedValue(patient({ middle_name: "" }));
    const { user } = page();
    await loaded();
    expect(screen.queryByRole("button", { name: "Book appointment" })).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Abebe Tesfaye" }));
    expect(currentLocation()).toBe("/patients/pat_1");
  });

  test("REG-FE-PSCHED-005 nothing at all: Nothing booked, and each lens says what it is empty of", async () => {
    const { user } = page();
    await loaded();
    expect(await screen.findByText("Nothing booked")).toBeInTheDocument();
    expect(screen.getByText("No upcoming visits for this patient.")).toBeInTheDocument();
    expect(screen.queryByText("Needs attention")).not.toBeInTheDocument();
    await user.click(lensBtn("Past"));
    expect(screen.getByText("No past visits on record.")).toBeInTheDocument();
    await user.click(lensBtn("All"));
    expect(screen.getByText("Nothing scheduled yet.")).toBeInTheDocument();
  });

  test("REG-FE-PSCHED-006 a non-dental clinic: no dental data is asked for; appointments alone fill the timeline", async () => {
    auth.dental = false;
    scheduling.listPatientAppointments.mockResolvedValue([
      appt("a1", 5, { is_followup: true }),
      appt("a2", 12, { status: "no_show", reason: "" }),
    ]);
    page();
    await loaded();
    expect(await screen.findByText("Follow-up appointment")).toBeInTheDocument();
    expect(dental.dentalSummary).not.toHaveBeenCalled();
    const next = nextCard();
    expect(within(next).getByText(/Follow-up appointment · Dr Selam · Check-up$/)).toHaveTextContent(/ EC · /);
    expect(within(next).getByText("5")).toBeInTheDocument();
    expect(within(next).getByText(/10:00/)).toBeInTheDocument();
    // No Move on an appointment: only treatment sessions are moved here.
    expect(within(next).queryByRole("button", { name: /Move/ })).not.toBeInTheDocument();
    expect(screen.getByText("no show")).toBeInTheDocument();
    expect(screen.getByText(/ · in 12 days$/)).toBeInTheDocument();
    expect(lensBtn("Upcoming")).toHaveAccessibleName("Upcoming 2");
  });

  test("REG-FE-PSCHED-007 the two sources merge in date order; cancelled sessions are dropped", async () => {
    scheduling.listPatientAppointments.mockResolvedValue([appt("a1", 3), appt("a0", 3, { starts_at: at(3, 8) })]);
    dental.dentalSummary.mockResolvedValue(summary(plan("Root canal", [
      sess("s1", 1, 1), sess("s2", 2, 8), sess("s3", 3, 2, { status: "cancelled" }),
    ])));
    const { container } = page();
    await loaded();
    await screen.findByText("Root canal · Session 1 of 3", { exact: false });
    const titles = [...container.querySelectorAll(".divide-y > div .font-medium:first-child")]
      .map((n) => n.textContent);
    expect(titles).toEqual(["Root canal", "Appointment", "Appointment", "Root canal"]);
    expect(screen.queryByText("Session 3 of 3")).not.toBeInTheDocument();
    expect(screen.getByText("tomorrow", { exact: false })).toBeInTheDocument();
  });

  test("REG-FE-PSCHED-008 today's session leads as next visit with 0 days and a Move button; it is marked Today", async () => {
    dental.dentalSummary.mockResolvedValue(summary(plan("Filling", [sess("s1", 1, 0, { amount_due: "1500" })])));
    const { user } = page();
    await loaded();
    const next = await waitFor(() => {
      const n = nextCard();
      expect(within(n).getByText(/Filling · Session 1 of 1/)).toBeInTheDocument();
      return n;
    });
    expect(within(next).getByText("0")).toBeInTheDocument();
    expect(screen.getByText("Today")).toBeInTheDocument();
    expect(screen.getByText(/· today$/)).toBeInTheDocument();
    expect(screen.getByText("1,500 ETB")).toBeInTheDocument();
    await user.click(within(next).getByRole("button", { name: /Move/ }));
    expect(screen.getByTestId("move-props")).toHaveTextContent(`s1|Filling|${day(0)}|Session 1 of 1|false`);
    await user.click(screen.getByRole("button", { name: "stub close" }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  test("REG-FE-PSCHED-009 a planned session whose day has passed is MISSED: raised, rescheduled from here, timeline refreshed", async () => {
    dental.dentalSummary.mockResolvedValue(summary(plan("Crown", [
      sess("s1", 1, -4, { status: "done", payment: "paid", amount_due: "800" }),
      sess("s2", 2, -1),
    ])));
    const { user } = page();
    await loaded();
    const box = await waitFor(attention);
    expect(within(box).getByText("1 missed")).toBeInTheDocument();
    expect(within(box).getByText(/^Was due .+ EC ·$/)).toBeInTheDocument();
    expect(within(box).getByText("yesterday")).toBeInTheDocument();
    // Nothing upcoming: the missed session is not the "next visit".
    expect(screen.getByText("Nothing booked")).toBeInTheDocument();
    await user.click(within(box).getByRole("button", { name: /Reschedule/ }));
    expect(screen.getByTestId("move-props")).toHaveTextContent(`s2|Crown|${day(-1)}|Session 2 of 2|true`);
    // The day being moved has nothing else on it.
    expect(screen.getByTestId("move-clashes")).toHaveTextContent("[]");
    const before = [dental.dentalSummary.mock.calls.length, scheduling.listPatientAppointments.mock.calls.length];
    await user.click(screen.getByRole("button", { name: "stub moved" }));
    await waitFor(() => expect(dental.dentalSummary.mock.calls.length).toBeGreaterThan(before[0]));
    await waitFor(() => expect(scheduling.listPatientAppointments.mock.calls.length).toBeGreaterThan(before[1]));
    // The past lens: newest first, the missed one in red with a Reschedule action.
    await user.click(lensBtn("Past"));
    const rows = screen.getAllByText(/^Session \d of 2$/).map((n) => n.textContent);
    expect(rows).toEqual(["Session 2 of 2", "Session 1 of 2"]);
    expect(screen.getAllByText("Missed").length).toBeGreaterThanOrEqual(2);
    expect(screen.getByText("4 days ago", { exact: false })).toBeInTheDocument();
    expect(screen.getByText("done")).toBeInTheDocument();
  });

  test("REG-FE-PSCHED-010 a reader who cannot reschedule is told the session needs rebooking, with no buttons", async () => {
    auth.perms = new Set();
    dental.dentalSummary.mockResolvedValue(summary(plan("Crown", [sess("s1", 1, -3), sess("s2", 2, 4)])));
    page();
    await loaded();
    expect(await screen.findByText("needs rebooking")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Reschedule|Move/ })).not.toBeInTheDocument();
  });

  test("REG-FE-PSCHED-011 dental.manage alone may reschedule", async () => {
    auth.perms = new Set(["dental.manage"]);
    dental.dentalSummary.mockResolvedValue(summary(plan("Crown", [sess("s1", 1, -3)])));
    page();
    await loaded();
    expect(await screen.findAllByRole("button", { name: /Reschedule/ })).not.toHaveLength(0);
  });

  test("REG-FE-PSCHED-012 two sessions on one day: flagged, the planned one movable, the done one marked, the clash check shared", async () => {
    dental.dentalSummary.mockResolvedValue(summary(
      plan("Root canal", [sess("s1", 1, 6, { status: "done", payment: "unpaid", amount_due: "900" })]),
      plan("Filling", [sess("s2", 1, 6)]),
    ));
    const { user } = page();
    await loaded();
    const box = await waitFor(attention);
    expect(within(box).getByText("1 double-booked day")).toBeInTheDocument();
    expect(within(box).getByText("2 on one day")).toBeInTheDocument();
    expect(within(box).getByText("in 6 days", { exact: false })).toBeInTheDocument();
    expect(within(box).getByText("already done")).toBeInTheDocument();
    expect(within(box).getAllByRole("button", { name: /Move this one/ })).toHaveLength(1);
    expect(screen.getAllByText("2 sessions this day")).toHaveLength(2);
    // A done-but-unpaid session reads as owing (amber), with its amount.
    expect(screen.getByText("900 ETB")).toBeInTheDocument();
    expect(screen.getByText("done").className).toMatch(/amber/);
    await user.click(within(box).getByRole("button", { name: /Move this one/ }));
    expect(screen.getByTestId("move-props")).toHaveTextContent(/^s2\|Filling\|/);
    expect(JSON.parse(screen.getByTestId("move-clashes").textContent!)).toEqual([
      { id: "s1", label: "Root canal · Session 1 of 1", done: true },
    ]);
  });

  test("REG-FE-PSCHED-013 several missed and several double-booked days are counted together", async () => {
    dental.dentalSummary.mockResolvedValue(summary(
      plan("A", [sess("a1", 1, -2), sess("a2", 2, 3), sess("a3", 3, 9)]),
      plan("B", [sess("b1", 1, -5), sess("b2", 2, 3), sess("b3", 3, 9)]),
    ));
    page();
    await loaded();
    expect(await screen.findByText("2 missed · 2 double-booked days")).toBeInTheDocument();
  });

  test("REG-FE-PSCHED-014 a day where both sessions are already done stays quiet", async () => {
    dental.dentalSummary.mockResolvedValue(summary(
      plan("A", [sess("a1", 1, -2, { status: "done", payment: "paid" })]),
      plan("B", [sess("b1", 1, -2, { status: "done", payment: "paid" })]),
    ));
    const { user } = page();
    await loaded();
    await screen.findByText("Nothing booked");
    expect(screen.queryByText("Needs attention")).not.toBeInTheDocument();
    await user.click(lensBtn("All"));
    expect(screen.getAllByText("2 sessions this day")).toHaveLength(2);
    expect(screen.getAllByText("done")[0].className).toMatch(/emerald/);
  });

  test("REG-FE-PSCHED-015 pay-later sessions read as owing; zero amounts are not printed", async () => {
    dental.dentalSummary.mockResolvedValue(summary(plan("Scaling", [sess("s1", 1, 2, { pay_later: true, amount_due: "0" })])));
    page();
    await loaded();
    const status = await screen.findByText("planned");
    expect(status.className).toMatch(/amber/);
    expect(screen.queryByText(/ETB/)).not.toBeInTheDocument();
  });

  test("REG-FE-PSCHED-016 while appointments or the dental record load: placeholders, not an empty timeline", async () => {
    scheduling.listPatientAppointments.mockReturnValue(new Promise(() => {}));
    const { container } = page();
    await loaded();
    expect(container.querySelectorAll(".animate-pulse, [class*=skeleton]").length).toBeGreaterThanOrEqual(2);
    expect(screen.queryByText("Nothing booked")).not.toBeInTheDocument();
    expect(screen.queryByText("No upcoming visits for this patient.")).not.toBeInTheDocument();
  });

  test("REG-FE-PSCHED-017 the All lens lists upcoming then past, grouped under month headings", async () => {
    dental.dentalSummary.mockResolvedValue(summary(plan("Implant", [
      sess("s1", 1, -40, { status: "done", payment: "paid" }), sess("s2", 2, 40),
    ])));
    const { user } = page();
    await loaded();
    await screen.findAllByText(/Session 2 of 2/);
    await user.click(lensBtn("All"));
    expect(lensBtn("All")).toHaveAccessibleName("All 2");
    const months = [day(40), day(-40)].map((iso) =>
      new Date(`${iso.slice(0, 7)}-01T00:00:00`).toLocaleDateString(undefined, { month: "long", year: "numeric" }));
    const headings = screen.getAllByText((_, el) => !!el && el.tagName === "SPAN" && months.includes(el.textContent ?? ""));
    expect(headings.map((h) => h.textContent)).toEqual(months);
  });

  test.fails("REG-FE-PSCHED-018 KNOWN BUG NEW-PROF-5 appointments that fail to load must not read as Nothing booked", async () => {
    // PatientSchedulePage.tsx:191 only waits on isLoading; a failed appointments
    // request is treated as an empty list, so the desk is told "Nothing booked" and
    // "No upcoming visits" for a patient who may be booked tomorrow (UX-1 pattern).
    auth.dental = false;
    scheduling.listPatientAppointments.mockRejectedValue(new Error("502"));
    page();
    await loaded();
    await new Promise((r) => setTimeout(r, 50));
    expect(screen.queryByText("Nothing booked")).not.toBeInTheDocument();
    expect(screen.queryByText("No upcoming visits for this patient.")).not.toBeInTheDocument();
  });
});
