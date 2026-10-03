// The booking dialog: how the front desk books a patient in, and how an existing
// appointment is moved. What it must get right:
//  - nothing can be booked without a patient, a provider AND a department (an
//    appointment with no department can never be checked in);
//  - the time sent is the wall-clock time the receptionist typed, as one instant;
//  - a follow-up is booked covered for the clinic's window (from the later of now and
//    the visit), and the copy says how long;
//  - rescheduling shows the appointment exactly where it is today — same day, same
//    time — so "Save" without touching anything moves nothing;
//  - a server refusal stays on screen inside the dialog.
// The patient search (PatientCombobox) is the same picker the calendar filter uses.
import { useState } from "react";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

vi.setConfig({ testTimeout: 60_000 });

const sched = vi.hoisted(() => ({ bookAppointment: vi.fn(), rescheduleAppointment: vi.fn() }));
vi.mock("@/features/scheduling/api", async (orig) => ({ ...(await orig<object>()), ...sched }));

const admin = vi.hoisted(() => ({ listProviders: vi.fn(), listDepartments: vi.fn(), getSettings: vi.fn() }));
vi.mock("@/features/admin/api", async (orig) => ({ ...(await orig<object>()), ...admin }));

const pats = vi.hoisted(() => ({ searchPatients: vi.fn() }));
vi.mock("@/features/patients/api", async (orig) => ({ ...(await orig<object>()), ...pats }));

const tst = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }));
vi.mock("@/components/ui/sonner", async (orig) => ({ ...(await orig<object>()), toast: tst }));

import { BookingDialog, PatientCombobox } from "@/features/scheduling/components/BookingDialog";
import type { Appointment } from "@/features/scheduling/api";
import type { PatientSummary } from "@/features/patients/api";
import { AppError } from "@/lib/api-client";
import { freezeToday, renderUI } from "@/test/render";

const DAY = 86_400_000;
const PROVIDERS = [{ id: "doc1", full_name: "Dr Sara" }, { id: "doc2", full_name: "Dr Abebe" }];
const DEPTS = [{ id: "dep1", name: "Dental", branch_id: "br1" }, { id: "dep2", name: "General", branch_id: "br1" }];
const P = (id: string, first: string, last: string, mrn: string): PatientSummary =>
  ({ id, first_name: first, last_name: last, mrn, gender: "female", dob: "1990-01-01" });

/** An instant built from LOCAL wall-clock parts, so the test reads the same in any zone. */
const local = (y: number, m: number, d: number, h: number, min = 0) => new Date(y, m - 1, d, h, min).toISOString();

const A = (over: Partial<Appointment> = {}): Appointment => ({
  id: "ap1", patient_id: "pat_a", provider_id: "doc2", department_id: "dep2",
  starts_at: local(2026, 10, 5, 12, 0), ends_at: local(2026, 10, 5, 12, 45), status: "booked",
  reason: "Crown fitting", is_followup: false, patient_name: "Almaz Haile", mrn: "M1",
  provider_name: "Dr Abebe", provider_active: true, ...over,
});

let onOpenChange: ReturnType<typeof vi.fn>;
let onSaved: ReturnType<typeof vi.fn>;

/** The dialog with its open state owned by the test, plus a way to reopen it for a new booking. */
function Harness({ existing = null, defaultDate = "2026-10-05" }: { existing?: Appointment | null; defaultDate?: string }) {
  const [open, setOpen] = useState(true);
  const [ex, setEx] = useState<Appointment | null>(existing);
  return (
    <>
      <button type="button" onClick={() => { setEx(null); setOpen(true); }}>new booking</button>
      <BookingDialog open={open} onOpenChange={(o) => { onOpenChange(o); setOpen(o); }}
        branchId="br1" defaultDate={defaultDate} existing={ex} onSaved={onSaved} />
    </>
  );
}

const dialog = () => screen.getByRole("dialog");
const field = (type: "date" | "time") => dialog().querySelector<HTMLInputElement>(`input[type="${type}"]`)!;
const selects = () => within(dialog()).getAllByRole("combobox");
type U = ReturnType<typeof renderUI>["user"];
async function pick(user: U, trigger: HTMLElement, name: string | RegExp) {
  await user.click(trigger);
  await user.click(await screen.findByRole("option", { name }));
}
async function pickPatient(user: U, name: RegExp) {
  await user.click(within(dialog()).getByRole("button", { name: /Search patient/ }));
  await user.click(await screen.findByRole("option", { name }));
}
const bookBtn = () => within(dialog()).getByRole("button", { name: "Book" });

describe("REG-FE-BOOK booking dialog", () => {
  beforeEach(() => {
    onOpenChange = vi.fn();
    onSaved = vi.fn();
    Object.values(sched).forEach((f) => f.mockReset());
    Object.values(admin).forEach((f) => f.mockReset());
    pats.searchPatients.mockReset();
    tst.success.mockReset(); tst.error.mockReset();
    admin.listProviders.mockResolvedValue(PROVIDERS);
    admin.listDepartments.mockResolvedValue(DEPTS);
    admin.getSettings.mockResolvedValue({ free_window_days: 14 });
    pats.searchPatients.mockResolvedValue({ items: [P("pat_a", "Almaz", "Haile", "M-001"), P("pat_b", "Bekele", "", "M-002")], meta: {} });
    sched.bookAppointment.mockResolvedValue({ id: "ap_new" });
    sched.rescheduleAppointment.mockResolvedValue({ id: "ap1" });
  });
  afterEach(() => vi.useRealTimers());

  test("REG-FE-BOOK-001 Book stays disabled until patient, provider and department are all chosen", async () => {
    const { user } = renderUI(<Harness />);
    expect(await screen.findByRole("dialog")).toHaveTextContent("Book appointment");
    expect(bookBtn()).toBeDisabled();
    await pickPatient(user, /Almaz Haile/);
    expect(within(dialog()).getByRole("button", { name: /Almaz Haile/ })).toBeInTheDocument();
    expect(bookBtn()).toBeDisabled();
    await pick(user, selects()[0], "Dr Sara");
    expect(bookBtn()).toBeDisabled(); // no department: check-in could never receive it
    await pick(user, selects()[1], "Dental");
    expect(bookBtn()).toBeEnabled();
  });

  test("REG-FE-BOOK-002 a plain booking sends the typed day at 09:00 local, 30 min, and nothing optional", async () => {
    const { user } = renderUI(<Harness />);
    await screen.findByRole("dialog");
    expect(field("date").value).toBe("2026-10-05");
    expect(field("time").value).toBe("09:00");
    // The Ethiopian date of the picked day, under the field.
    expect(within(dialog()).getByText("Meskerem 25, 2019")).toBeInTheDocument();
    await pickPatient(user, /Almaz Haile/);
    await pick(user, selects()[0], "Dr Sara");
    await pick(user, selects()[1], "Dental");
    await user.click(bookBtn());
    await waitFor(() => expect(sched.bookAppointment).toHaveBeenCalledTimes(1));
    expect(sched.bookAppointment.mock.calls[0][0]).toEqual({
      branch_id: "br1", patient_id: "pat_a", provider_id: "doc1", department_id: "dep1",
      starts_at: local(2026, 10, 5, 9, 0), duration_min: 30,
      reason: undefined, is_followup: undefined, free_until: undefined,
    });
    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
    expect(tst.success).toHaveBeenCalledWith("Appointment booked");
    expect(onSaved).toHaveBeenCalled();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  test("REG-FE-BOOK-003 day, time, duration and reason as edited are what is booked", async () => {
    const { user } = renderUI(<Harness />);
    await screen.findByRole("dialog");
    await pickPatient(user, /Bekele/);
    await pick(user, selects()[0], "Dr Abebe");
    await pick(user, selects()[1], "General");
    fireEvent.change(field("date"), { target: { value: "2026-10-07" } });
    fireEvent.change(field("time"), { target: { value: "14:15" } });
    await pick(user, selects()[2], "45 min");
    await user.type(within(dialog()).getByPlaceholderText("Chief complaint"), "Toothache");
    expect(within(dialog()).getByText("Meskerem 27, 2019")).toBeInTheDocument();
    await user.click(bookBtn());
    await waitFor(() => expect(sched.bookAppointment).toHaveBeenCalledTimes(1));
    expect(sched.bookAppointment.mock.calls[0][0]).toMatchObject({
      patient_id: "pat_b", provider_id: "doc2", department_id: "dep2",
      starts_at: local(2026, 10, 7, 14, 15), duration_min: 45, reason: "Toothache",
    });
  });

  test("REG-FE-BOOK-004 a half-typed date shows no Ethiopian date and cannot be booked", async () => {
    const { user } = renderUI(<Harness />);
    await screen.findByRole("dialog");
    await pickPatient(user, /Almaz/);
    await pick(user, selects()[0], "Dr Sara");
    await pick(user, selects()[1], "Dental");
    fireEvent.change(field("date"), { target: { value: "" } });
    expect(within(dialog()).queryByText(/2019/)).not.toBeInTheDocument();
    expect(bookBtn()).toBeDisabled();
  });

  test("REG-FE-BOOK-005 a follow-up in the future is covered for the clinic's window from the visit", async () => {
    const { user } = renderUI(<Harness defaultDate="2030-01-10" />);
    await screen.findByRole("dialog");
    const toggle = within(dialog()).getByRole("button", { name: /This is a follow-up/ });
    expect(toggle).toHaveTextContent("waives the card fee within the clinic's window");
    await user.click(toggle);
    await waitFor(() => expect(toggle).toHaveTextContent("No card fee if attended within 14 days."));
    await pickPatient(user, /Almaz/);
    await pick(user, selects()[0], "Dr Sara");
    await pick(user, selects()[1], "Dental");
    await user.click(bookBtn());
    await waitFor(() => expect(sched.bookAppointment).toHaveBeenCalledTimes(1));
    const body = sched.bookAppointment.mock.calls[0][0];
    expect(body.is_followup).toBe(true);
    expect(body.free_until).toBe(new Date(new Date(2030, 0, 10, 9).getTime() + 14 * DAY).toISOString());
  });

  test("REG-FE-BOOK-006 a follow-up booked into the past is covered from now, not from the visit", async () => {
    freezeToday("2026-10-03", 11);
    const now = Date.now();
    const { user } = renderUI(<Harness defaultDate="2026-09-01" />);
    await screen.findByRole("dialog");
    await user.click(within(dialog()).getByRole("button", { name: /This is a follow-up/ }));
    await pickPatient(user, /Almaz/);
    await pick(user, selects()[0], "Dr Sara");
    await pick(user, selects()[1], "Dental");
    await user.click(bookBtn());
    await waitFor(() => expect(sched.bookAppointment).toHaveBeenCalledTimes(1));
    expect(sched.bookAppointment.mock.calls[0][0].free_until).toBe(new Date(now + 14 * DAY).toISOString());
  });

  test("REG-FE-BOOK-007 with no clinic settings the follow-up window reads as 30 days", async () => {
    admin.getSettings.mockRejectedValue(new Error("forbidden"));
    const { user } = renderUI(<Harness />);
    await screen.findByRole("dialog");
    const toggle = within(dialog()).getByRole("button", { name: /This is a follow-up/ });
    await user.click(toggle);
    await waitFor(() => expect(admin.getSettings).toHaveBeenCalled());
    expect(toggle).toHaveTextContent("No card fee if attended within 30 days.");
  });

  test("REG-FE-BOOK-008 a server refusal stays in the dialog; an unknown failure gets a plain message", async () => {
    sched.bookAppointment.mockRejectedValueOnce(new AppError(409, "conflict", "Dr Sara is already booked at 09:00"));
    sched.bookAppointment.mockRejectedValueOnce(new TypeError("Failed to fetch"));
    const { user } = renderUI(<Harness />);
    await screen.findByRole("dialog");
    await pickPatient(user, /Almaz/);
    await pick(user, selects()[0], "Dr Sara");
    await pick(user, selects()[1], "Dental");
    await user.click(bookBtn());
    expect(await within(dialog()).findByText("Dr Sara is already booked at 09:00")).toBeInTheDocument();
    expect(onOpenChange).not.toHaveBeenCalled();
    expect(onSaved).not.toHaveBeenCalled();
    await user.click(bookBtn());
    expect(await within(dialog()).findByText("Could not save the appointment.")).toBeInTheDocument();
  });

  test("REG-FE-BOOK-009 rescheduling shows the appointment as it is and Save without changes moves nothing", async () => {
    const appt = A();
    const { user } = renderUI(<Harness existing={appt} />);
    await screen.findByRole("dialog");
    expect(dialog()).toHaveTextContent("Reschedule appointment");
    const name = within(dialog()).getByDisplayValue("Almaz Haile");
    expect(name).toBeDisabled();
    expect(within(dialog()).queryByRole("button", { name: /This is a follow-up/ })).not.toBeInTheDocument();
    expect(field("date").value).toBe("2026-10-05");
    expect(field("time").value).toBe("12:00");
    expect(within(dialog()).getByDisplayValue("Crown fitting")).toBeInTheDocument();
    await waitFor(() => expect(selects()[0]).toHaveTextContent("Dr Abebe"));
    await waitFor(() => expect(selects()[1]).toHaveTextContent("General"));
    expect(selects()[2]).toHaveTextContent("45 min");
    await user.click(within(dialog()).getByRole("button", { name: "Save changes" }));
    await waitFor(() => expect(sched.rescheduleAppointment).toHaveBeenCalledTimes(1));
    expect(sched.rescheduleAppointment).toHaveBeenCalledWith("ap1", {
      provider_id: "doc2", department_id: "dep2", starts_at: appt.starts_at, duration_min: 45, reason: "Crown fitting",
    });
    expect(sched.bookAppointment).not.toHaveBeenCalled();
    await waitFor(() => expect(tst.success).toHaveBeenCalledWith("Appointment updated"));
  });

  test("REG-FE-BOOK-010 moving an appointment sends the new slot and provider", async () => {
    const { user } = renderUI(<Harness existing={A({ reason: undefined })} />);
    await screen.findByRole("dialog");
    await waitFor(() => expect(selects()[0]).toHaveTextContent("Dr Abebe"));
    await pick(user, selects()[0], "Dr Sara");
    fireEvent.change(field("date"), { target: { value: "2026-10-09" } });
    fireEvent.change(field("time"), { target: { value: "08:30" } });
    await user.click(within(dialog()).getByRole("button", { name: "Save changes" }));
    await waitFor(() => expect(sched.rescheduleAppointment).toHaveBeenCalledTimes(1));
    expect(sched.rescheduleAppointment.mock.calls[0][1]).toEqual({
      provider_id: "doc1", department_id: "dep2", starts_at: local(2026, 10, 9, 8, 30), duration_min: 45, reason: undefined,
    });
  });

  test("REG-FE-BOOK-011 an old appointment with no department cannot be saved until one is picked", async () => {
    const { user } = renderUI(<Harness existing={A({ department_id: null, ends_at: A().starts_at })} />);
    await screen.findByRole("dialog");
    const save = within(dialog()).getByRole("button", { name: "Save changes" });
    expect(save).toBeDisabled();
    await pick(user, selects()[1], "Dental");
    expect(save).toBeEnabled();
    await user.click(save);
    await waitFor(() => expect(sched.rescheduleAppointment).toHaveBeenCalledTimes(1));
    expect(sched.rescheduleAppointment.mock.calls[0][1]).toMatchObject({ department_id: "dep1", duration_min: 5 });
  });

  test("REG-FE-BOOK-012 Cancel closes; the next new booking starts blank, not from the last appointment", async () => {
    const { user } = renderUI(<Harness existing={A()} />);
    await screen.findByRole("dialog");
    await user.click(within(dialog()).getByRole("button", { name: "Cancel" }));
    expect(onOpenChange).toHaveBeenCalledWith(false);
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    await user.click(screen.getByRole("button", { name: "new booking" }));
    await screen.findByRole("dialog");
    expect(dialog()).toHaveTextContent("Book appointment");
    expect(within(dialog()).getByRole("button", { name: /Search patient/ })).toBeInTheDocument();
    expect(field("date").value).toBe("2026-10-05");
    expect(field("time").value).toBe("09:00");
    expect(within(dialog()).getByPlaceholderText("Chief complaint")).toHaveValue("");
    expect(selects()[0]).toHaveTextContent("Select…");
    expect(bookBtn()).toBeDisabled();
  });

  // APT-9. The dialog splits the stored instant into a date and a time, but takes the
  // DATE from toISOString() (UTC) and the TIME from toTimeString() (local). In Addis
  // (UTC+3) an appointment between 00:00 and 03:00 is still the previous day in UTC,
  // so the dialog shows — and on Save sends — the right time on the day BEFORE.
  // Evidence: BookingDialog.tsx:62 `setDate(s.toISOString().slice(0, 10))` next to
  // :63 `setTime(s.toTimeString().slice(0, 5))`. The clinic runs on Addis time, so the
  // test pins the zone for itself (and puts it back) rather than relying on the run's TZ.
  test.fails("REG-FE-BOOK-013 KNOWN BUG APT-9 an early-morning appointment opens on its own day and Save does not move it", async () => {
    const saved = process.env.TZ;
    process.env.TZ = "Africa/Addis_Ababa";
    try {
      const appt = A({ starts_at: "2026-10-05T01:30:00+03:00", ends_at: "2026-10-05T02:00:00+03:00" });
      const { user } = renderUI(<Harness existing={appt} />);
      await screen.findByRole("dialog");
      await waitFor(() => expect(selects()[1]).toHaveTextContent("General"));
      expect(field("time").value).toBe("01:30");
      await user.click(within(dialog()).getByRole("button", { name: "Save changes" }));
      await waitFor(() => expect(sched.rescheduleAppointment).toHaveBeenCalledTimes(1));
      // Unchanged slot → the same instant goes back. Today it is a day earlier.
      expect(sched.rescheduleAppointment.mock.calls[0][1].starts_at).toBe("2026-10-04T22:30:00.000Z");
      expect(field("date").value).toBe("2026-10-05");
    } finally {
      if (saved === undefined) delete process.env.TZ; else process.env.TZ = saved;
    }
  });
});

describe("REG-FE-BOOK patient search", () => {
  beforeEach(() => {
    pats.searchPatients.mockReset();
    pats.searchPatients.mockImplementation(async (q: string) => ({
      items: q === "zz" ? [] : [P("pat_a", "Almaz", "Haile", "M-001"), P("pat_b", "Bekele", "", "M-002")],
      meta: {},
    }));
  });

  test("REG-FE-BOOK-014 opens on the first patients, searches what is typed (trimmed), and picks one", async () => {
    const onSelect = vi.fn();
    const { user } = renderUI(<PatientCombobox value={null} onSelect={onSelect} />);
    expect(pats.searchPatients).not.toHaveBeenCalled(); // nothing fetched until it is opened
    await user.click(screen.getByRole("button", { name: /Search patient/ }));
    expect(await screen.findByRole("option", { name: /Almaz Haile/ })).toHaveTextContent("M-001");
    expect(pats.searchPatients).toHaveBeenCalledWith("", 1, 8);
    await user.type(screen.getByPlaceholderText(/Search by name/), " zz ");
    await waitFor(() => expect(pats.searchPatients).toHaveBeenCalledWith("zz", 1, 8));
    expect(await screen.findByText("No patients found.")).toBeInTheDocument();
    await user.clear(screen.getByPlaceholderText(/Search by name/));
    await user.click(await screen.findByRole("option", { name: /Bekele/ }));
    expect(onSelect).toHaveBeenCalledWith({ id: "pat_b", name: "Bekele" });
    await waitFor(() => expect(screen.queryByRole("option")).not.toBeInTheDocument());
  });

  test("REG-FE-BOOK-015 the chosen patient is named on the button and ticked in the list", async () => {
    const { user } = renderUI(<PatientCombobox value={{ id: "pat_a", name: "Almaz Haile" }} onSelect={vi.fn()} />);
    await user.click(screen.getByRole("button", { name: /Almaz Haile/ }));
    const ticked = await screen.findByRole("option", { name: /Almaz Haile/ });
    expect(ticked.querySelector("svg")).toHaveClass("opacity-100");
    expect(screen.getByRole("option", { name: /Bekele/ }).querySelector("svg")).toHaveClass("opacity-0");
  });
});
