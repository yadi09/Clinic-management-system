// Follow-ups: everyone the clinic expects back, as four tabs with one job each.
// The view is given sessions and appointments the way the Appointments page fetches
// them; these tests check which tab each lands in, the counts, what is left out
// (down payments, unpaid finished work), and that the actions reach the right row.
import { screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

const api = vi.hoisted(() => ({ rescheduleSession: vi.fn() }));
vi.mock("@/features/dental/api", async (orig) => ({ ...(await orig<object>()), ...api }));

import { FollowupsView, type FollowupActions } from "@/features/scheduling/components/FollowupsView";
import type { DentalSessionCal } from "@/features/dental/api";
import type { Appointment } from "@/features/scheduling/api";
import { currentLocation, freezeToday, renderUI } from "@/test/render";

const T = "2026-08-12";

const V = (id: string, date: string, seq: number, extra: Partial<DentalSessionCal> = {}): DentalSessionCal => ({
  session_id: id, plan_id: "plan_a", patient_id: "pat_a", patient_name: "Almaz Haile", mrn: "M1",
  scheduled_date: date, seq, session_count: 5, title: "Root canal", amount_due: "2000", status: "planned",
  payment: "unpaid", pay_later: false, kind: "visit", ...extra,
});
const A = (id: string, startsAt: string, extra: Partial<Appointment> = {}): Appointment => ({
  id, patient_id: "pat_b", provider_id: "doc1", starts_at: startsAt, ends_at: startsAt, status: "booked",
  is_followup: true, patient_name: "Bekele Tesfaye", mrn: "M2", provider_name: "Dr Sara", provider_active: true, ...extra,
});

function view(sessions: DentalSessionCal[], appts: Appointment[] = [], opts: { route?: string; patientFilter?: string; dentalOn?: boolean; loading?: boolean } = {}) {
  const actions: FollowupActions = { onReassign: vi.fn(), onReschedule: vi.fn(), onOpenPatient: vi.fn() };
  const r = renderUI(
    <FollowupsView sessions={{ data: sessions, isLoading: !!opts.loading }} appts={{ data: appts, isLoading: false }}
      dentalOn={opts.dentalOn ?? true} patientFilter={opts.patientFilter ?? ""} actions={actions} />,
    { route: opts.route ?? "/appointments?view=followups" },
  );
  return { ...r, actions };
}
const tab = (name: RegExp) => within(screen.getByRole("tablist", { name: "Follow-ups" })).getByRole("tab", { name });

describe("REG-FE-FOLLOWUP follow-ups tabs", () => {
  beforeEach(() => { freezeToday(T, 10); api.rescheduleSession.mockReset(); });
  afterEach(() => vi.useRealTimers());

  const mixed = () => [
    V("m1", "2026-08-01", 2), V("m2", "2026-08-05", 3), // one treatment, two missed visits: one person to call
    V("m3", "2026-07-20", 1, { plan_id: "plan_c", patient_id: "pat_c", patient_name: "Chaltu Abdi", title: "Scaling", session_count: 2 }),
    V("d1", "2026-08-02", 1, { status: "done", payment: "paid" }), // happened: not missed
    V("t1", T, 4),
    V("u1", "2026-08-20", 5), V("u2", "2026-08-20", 1, { plan_id: "plan_d", patient_id: "pat_d", patient_name: "Dawit" }),
  ];
  const mixedAppts = () => [
    A("a_missed", "2026-08-10T06:00:00Z"),
    A("a_today", `${T}T12:00:00Z`, { patient_id: "pat_e", patient_name: "Eden" }),
    A("a_next", "2026-08-15T06:00:00Z", { patient_id: "pat_f", patient_name: "Fikir" }),
    A("a_left", "2026-08-14T06:00:00Z", { provider_active: false, provider_name: "Dr Gone", patient_name: "Genet" }),
    A("a_cancel", "2026-08-01T06:00:00Z", { status: "cancelled" }),
  ];

  test("REG-FE-FOLLOWUP-001 each row lands in one tab, and the counts say how many people", () => {
    view(mixed(), mixedAppts());
    expect(tab(/Missed/)).toHaveTextContent("Missed3");
    expect(tab(/Today/)).toHaveTextContent("Today2");
    expect(tab(/Coming up/)).toHaveTextContent("Coming up3");
    expect(tab(/Needs a new doctor/)).toHaveTextContent("1");
  });

  test("REG-FE-FOLLOWUP-002 Missed: one row per treatment, longest missed first, visits named together", () => {
    view(mixed(), mixedAppts());
    expect(tab(/Missed/)).toHaveAttribute("aria-selected", "true");
    const names = screen.getAllByRole("button", { name: /Almaz Haile|Chaltu Abdi|Bekele Tesfaye/ }).map((b) => b.textContent);
    expect(names[0]).toMatch(/Chaltu Abdi/); // missed since 20 Jul
    expect(names[1]).toMatch(/Almaz Haile.*Root canal · visits 2 and 3 of 5/);
    expect(names[2]).toMatch(/Bekele Tesfaye.*Follow-up with Dr Sara/);
    expect(screen.getByRole("button", { name: /Rebook visit 2/ })).toBeInTheDocument();
    expect(screen.getByText("missed 23 days ago")).toBeInTheDocument();
  });

  test("REG-FE-FOLLOWUP-003 down payments and other non-visit rows are never a follow-up", () => {
    view([
      V("dep", "2026-08-01", 0, { kind: "deposit" }),
      V("ext", "2026-08-01", 1, { kind: "extra" }),
      V("old", "2026-08-01", 0, { kind: undefined }), // an older server: seq 0 is the deposit
    ], [], { route: "/appointments?tab=missed" });
    expect(tab(/Missed/)).toHaveTextContent(/^Missed$/);
    expect(screen.getByText(/Nobody has missed a visit/)).toBeInTheDocument();
  });

  test("REG-FE-FOLLOWUP-004 finished but unpaid treatment is named once, as billing, with the link to it", () => {
    view([
      V("o1", "2026-08-01", 1, { status: "done", payment: "unpaid" }),
      V("o2", "2026-08-03", 2, { status: "done", payment: "refunded" }),
      V("p1", "2026-08-04", 3, { status: "done", payment: "paid" }),
    ], [], { route: "/appointments?tab=missed" });
    const link = screen.getByRole("link", { name: /2 treated visits are done but not paid/ });
    expect(link).toHaveAttribute("href", "/dental/unbilled");
    // None of them is a missed visit.
    expect(tab(/Missed/)).toHaveTextContent(/^Missed$/);
  });

  test("REG-FE-FOLLOWUP-005 the unpaid banner is for dental clinics, on the Missed tab only", async () => {
    const owed = [V("o1", "2026-08-01", 1, { status: "done" }), V("t1", T, 2)];
    const { user, unmount } = view(owed, [], { route: "/appointments?tab=missed" });
    expect(screen.getByText(/1 treated visit is done but not paid/)).toBeInTheDocument();
    await user.click(tab(/Today/));
    expect(screen.queryByText(/done but not paid/)).not.toBeInTheDocument();
    unmount();
    view(owed, [], { dentalOn: false, route: "/appointments?tab=missed" });
    expect(screen.queryByText(/done but not paid/)).not.toBeInTheDocument();
  });

  test("REG-FE-FOLLOWUP-006 the tab is in the URL: it opens from it and writes to it", async () => {
    const { user } = view(mixed(), mixedAppts(), { route: "/appointments?view=followups&tab=upcoming" });
    expect(tab(/Coming up/)).toHaveAttribute("aria-selected", "true");
    expect(screen.getByText("Everyone booked to come back, a day at a time.")).toBeInTheDocument();
    await user.click(tab(/Today/));
    expect(currentLocation()).toBe("/appointments?view=followups&tab=today");
    expect(tab(/Today/)).toHaveAttribute("aria-selected", "true");
  });

  test("REG-FE-FOLLOWUP-007 with nothing missed it opens on Today, then Coming up", () => {
    const { unmount } = view([V("t1", T, 1), V("u1", "2026-08-20", 2)]);
    expect(tab(/Today/)).toHaveAttribute("aria-selected", "true");
    unmount();
    view([V("u1", "2026-08-20", 2)]);
    expect(tab(/Coming up/)).toHaveAttribute("aria-selected", "true");
  });

  test("REG-FE-FOLLOWUP-008 ?tab=handoff with nobody to hand off falls back instead of an empty tab", () => {
    view([V("m1", "2026-08-01", 1)], [], { route: "/appointments?tab=handoff" });
    expect(screen.queryByRole("tab", { name: /Needs a new doctor/ })).not.toBeInTheDocument();
    expect(tab(/Missed/)).toHaveAttribute("aria-selected", "true");
  });

  test("REG-FE-FOLLOWUP-009 the patient filter keeps only that patient's rows", () => {
    view(mixed(), mixedAppts(), { patientFilter: "pat_c" });
    expect(tab(/Missed/)).toHaveTextContent("Missed1");
    expect(tab(/Today/)).toHaveTextContent(/^Today$/);
    expect(screen.getByText("Chaltu Abdi")).toBeInTheDocument();
    expect(screen.queryByText("Almaz Haile")).not.toBeInTheDocument();
  });

  test("REG-FE-FOLLOWUP-010 Rebook visit N opens the reschedule dialog for that visit, marked missed", async () => {
    const { user } = view([V("m1", "2026-08-01", 2), V("m2", "2026-08-05", 3)]);
    await user.click(screen.getByRole("button", { name: /Rebook visit 2/ }));
    const dlg = await screen.findByRole("dialog");
    expect(within(dlg).getByText("Root canal")).toBeInTheDocument();
    expect(within(dlg).getByText(/Visit 2 of 5 · Almaz Haile/)).toBeInTheDocument();
    expect(within(dlg).getByText(/missed 11 days ago/)).toBeInTheDocument();
  });

  test("REG-FE-FOLLOWUP-011 a missed follow-up appointment is rebooked through the page's own action", async () => {
    const appt = A("a_missed", "2026-08-10T06:00:00Z");
    const { user, actions } = view([], [appt]);
    await user.click(screen.getByRole("button", { name: /^Rebook$/ }));
    expect(actions.onReschedule).toHaveBeenCalledWith(appt);
  });

  test("REG-FE-FOLLOWUP-012 a doctor who left: the handoff tab, with Reassign", async () => {
    const appt = A("a_left", "2026-08-14T06:00:00Z", { provider_active: false, provider_name: "Dr Gone" });
    const { user, actions } = view([], [appt], { route: "/appointments?tab=handoff" });
    expect(screen.getByText(/who no longer works here/)).toHaveTextContent("Dr Gone");
    await user.click(screen.getByRole("button", { name: /Reassign/ }));
    expect(actions.onReassign).toHaveBeenCalledWith(appt);
  });

  test("REG-FE-FOLLOWUP-013 opening a missed treatment row opens the patient on that visit", async () => {
    const { user, actions } = view([V("m1", "2026-08-01", 2)]);
    await user.click(screen.getByRole("button", { name: /Almaz Haile/ }));
    expect(actions.onOpenPatient).toHaveBeenCalledWith("pat_a", "m1");
  });

  test("REG-FE-FOLLOWUP-014 a missed visit already paid for says the patient is owed the treatment", () => {
    view([V("m1", "2026-08-01", 2, { payment: "paid" })]);
    expect(screen.getByText("Already paid for, so the patient is owed this treatment.")).toBeInTheDocument();
  });

  test("REG-FE-FOLLOWUP-015 Today: each visit with its money word, and a phone to call", async () => {
    const { user } = view([V("t1", T, 4, { phone: "0911 223344", payment: "billed" }), V("t2", T, 1, { status: "done", payment: "paid", patient_name: "Zed", plan_id: "z" })]);
    expect(tab(/Today/)).toHaveAttribute("aria-selected", "true");
    expect(screen.getByText("At cashier")).toBeInTheDocument();
    expect(screen.getByText("done")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Call 0911 223344" })).toHaveAttribute("href", "tel:0911223344");
    await user.click(tab(/Coming up/));
    expect(screen.getByText(/Nothing booked ahead yet/)).toBeInTheDocument();
  });

  test("REG-FE-FOLLOWUP-016 Coming up is grouped a day at a time with a head count", () => {
    view([V("u1", "2026-08-20", 5), V("u2", "2026-08-20", 1, { plan_id: "x", patient_name: "Dawit" }), V("u3", "2026-08-13", 2, { plan_id: "y", patient_name: "Hana" })],
      [], { route: "/appointments?tab=upcoming" });
    const days = screen.getAllByRole("region");
    expect(days).toHaveLength(2);
    expect(days[0]).toHaveTextContent("Tomorrow");
    expect(days[0]).toHaveTextContent("1 patient");
    expect(days[1]).toHaveTextContent("In 8 days");
    expect(days[1]).toHaveTextContent("2 patients");
  });

  test("REG-FE-FOLLOWUP-017 while loading there are no tabs to misread as empty", () => {
    view([], [], { loading: true });
    expect(screen.queryByRole("tablist")).not.toBeInTheDocument();
  });

  test("REG-FE-FOLLOWUP-018 a checked-in appointment from an earlier day is not 'missed'", () => {
    view([], [A("a1", "2026-08-10T06:00:00Z", { status: "checked_in" })]);
    expect(tab(/Missed/)).toHaveTextContent(/^Missed$/);
  });

  // The patient card numbers visits in calendar order (REG-FE-FOCUS-013), so a visit
  // moved earlier than its neighbour keeps reading 1, 2, 3. This list prints the raw
  // seq instead: the same missed visit is "Rebook visit 2" on the card and "Rebook
  // visit 3" here, and the row reads "visits 3 and 2 of 5".
  test.fails("REG-FE-FOLLOWUP-019 KNOWN BUG NEW-FOLLOWUP-1 a moved visit is numbered as on the patient card", () => {
    view([
      V("s3", "2026-08-03", 3), // visit 3, moved earlier than visit 2
      V("s2", "2026-08-08", 2),
    ]);
    expect(screen.getByRole("button", { name: /Almaz Haile/ })).toHaveTextContent("visits 2 and 3 of 5");
    expect(screen.getByRole("button", { name: /Rebook visit 2/ })).toBeInTheDocument();
  });
});
