// Registering a patient: a three-step wizard (Demographics → Contact & IDs →
// Review). What it must get right: only the first name is required; an age ("about
// 40") is the default and becomes an estimated birthdate counted back from TODAY's
// local date (29 February stands in as 28 February); a real birthdate can be given
// instead (Ethiopian by default) and switching between the two never leaves both;
// a bad email stops the second step; nothing is sent before the explicit Register
// press on Review; a duplicate answer opens a side-by-side comparison from which the
// clerk either opens the existing record or forces a new one; and success lands on
// the new patient's page.
//
// Time: every test freezes "today" (local) itself, so the time-sweep (FAKE_NOW + TZ)
// cannot move the expected birthdates.
//
// KNOWN-BUG CONVENTION: `test.fails("REG-... KNOWN BUG <id> ...")` asserts the
// CORRECT behaviour, so it fails today and Vitest counts it as an expected failure.
import { screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

const api = vi.hoisted(() => ({ createPatient: vi.fn() }));
vi.mock("@/features/patients/api", async (orig) => ({ ...(await orig<object>()), ...api }));
const tst = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }));
vi.mock("sonner", async (orig) => ({ ...(await orig<object>()), toast: tst }));

import { PatientRegisterPage } from "@/features/patients/pages/PatientRegisterPage";
import { patientSchema } from "@/features/patients/schemas";
import { AppError } from "@/lib/api-client";
import { currentLocation, freezeToday, renderUI } from "@/test/render";

type User = ReturnType<typeof renderUI>["user"];

/** The input under a field label (the page's labels are not bound with htmlFor). */
const fieldBox = (label: RegExp) => screen.getByText(label, { selector: "label" }).parentElement!;
const input = (label: RegExp) => within(fieldBox(label)).getByRole("textbox");
const btn = (name: string | RegExp) => screen.getByRole("button", { name });
const ageBox = () => screen.getByRole("textbox", { name: "Age in years" });

function show(route = "/patients/new") {
  return renderUI(<PatientRegisterPage />, { route });
}

async function fillStep1(user: User, { first = "Abebe", middle = "", last = "Kebede", age = "40" } = {}) {
  if (first) await user.type(input(/^First name/), first);
  if (middle) await user.type(input(/^Middle name/), middle);
  if (last) await user.type(input(/^Last name/), last);
  if (age) await user.type(ageBox(), age);
}

async function toReview(user: User, opts?: Parameters<typeof fillStep1>[1], contact: { phone?: string; email?: string } = {}) {
  await fillStep1(user, opts);
  await user.click(btn(/Continue/));
  await screen.findByText(/Step 2 of 3/);
  if (contact.phone) await user.type(input(/^Phone/), contact.phone);
  if (contact.email) await user.type(input(/^Email/), contact.email);
  await user.click(btn(/Continue/));
  await screen.findByText(/Step 3 of 3/);
}

const sent = () => api.createPatient.mock.calls.at(-1) as [Record<string, unknown>, boolean];

describe("REG-FE-PREG patient registration wizard", () => {
  beforeEach(() => {
    api.createPatient.mockReset();
    tst.success.mockReset();
    freezeToday("2026-10-03", 10);
  });
  afterEach(() => vi.useRealTimers());

  test("REG-FE-PREG-001 starts on Demographics, by age, with Cancel going back to the list", async () => {
    const { user } = show();
    expect(screen.getByText("Step 1 of 3 · Demographics")).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "Age in years" })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByText("Age", { selector: "label" })).toBeInTheDocument();
    await user.click(btn("Cancel"));
    expect(currentLocation()).toBe("/patients");
  });

  test("REG-FE-PREG-002 a missing first name stops the first step", async () => {
    const { user } = show();
    await user.click(btn(/Continue/));
    expect(await screen.findByText("First name is required")).toBeInTheDocument();
    expect(screen.getByText(/Step 1 of 3/)).toBeInTheDocument();
  });

  test("REG-FE-PREG-003 by age: 40 years on 3 Oct 2026 is sent as an estimated 1986-10-03, with everything typed", async () => {
    api.createPatient.mockResolvedValue({ patient: { id: "pat_new", mrn: "MRN-0042" } });
    const { user, qc } = show();
    const inval = vi.spyOn(qc, "invalidateQueries");
    await user.type(input(/^Blood group/), "O+");
    await toReview(user, { first: "Abebe", middle: "Tesfaye", last: "Kebede", age: "40" }, { phone: "0911223344", email: "abe@example.test" });
    // Review shows what will be saved.
    expect(screen.getByText("Abebe Tesfaye Kebede")).toBeInTheDocument();
    expect(screen.getByText("40 years (age given)")).toBeInTheDocument();
    expect(screen.getByText("0911223344")).toBeInTheDocument();
    expect(api.createPatient).not.toHaveBeenCalled();
    await user.click(btn(/Register patient/));
    await waitFor(() => expect(api.createPatient).toHaveBeenCalledTimes(1));
    const [values, force] = sent();
    expect(force).toBe(false);
    expect(values).toMatchObject({
      first_name: "Abebe", middle_name: "Tesfaye", last_name: "Kebede", gender: "unknown",
      dob: "1986-10-03", dob_estimated: true, phone: "0911223344", email: "abe@example.test", blood_group: "O+",
    });
    await waitFor(() => expect(currentLocation()).toBe("/patients/pat_new"));
    expect(tst.success).toHaveBeenCalledWith("Patient registered · MRN-0042");
    expect(inval).toHaveBeenCalledWith({ queryKey: ["patients"] });
  });

  test("REG-FE-PREG-004 only the first name is required: no last name and no age still registers, with no birthdate", async () => {
    api.createPatient.mockResolvedValue({ patient: { id: "pat_x", mrn: "MRN-1" } });
    const { user } = show();
    await toReview(user, { first: "Kidist", last: "", age: "" });
    await user.click(btn(/Register patient/));
    await waitFor(() => expect(api.createPatient).toHaveBeenCalled());
    expect(sent()[0]).toMatchObject({ first_name: "Kidist", dob: "" });
  });

  test("REG-FE-PREG-005 the age box keeps digits only (max 3) and a newborn (0) is born today", async () => {
    api.createPatient.mockResolvedValue({ patient: { id: "pat_b", mrn: "MRN-B" } });
    const { user } = show();
    await user.type(ageBox(), "4a5x67");
    expect(ageBox()).toHaveValue("456");
    await user.clear(ageBox());
    await toReview(user, { age: "0" });
    await user.click(btn(/Register patient/));
    await waitFor(() => expect(api.createPatient).toHaveBeenCalled());
    expect(sent()[0]).toMatchObject({ dob: "2026-10-03", dob_estimated: true });
  });

  test("REG-FE-PREG-006 on 29 February an age counts back to 28 February (no birthday that year)", async () => {
    freezeToday("2028-02-29", 10);
    api.createPatient.mockResolvedValue({ patient: { id: "pat_l", mrn: "MRN-L" } });
    const { user } = show();
    await toReview(user, { age: "3" });
    await user.click(btn(/Register patient/));
    await waitFor(() => expect(api.createPatient).toHaveBeenCalled());
    expect(sent()[0]).toMatchObject({ dob: "2025-02-28", dob_estimated: true });
  });

  test("REG-FE-PREG-007 late at night the age still counts from the local date, not UTC's", async () => {
    freezeToday("2026-10-03", 23); // 23:00 local: UTC may already be 4 Oct (or still 3 Oct)
    api.createPatient.mockResolvedValue({ patient: { id: "pat_n", mrn: "MRN-N" } });
    const { user } = show();
    await toReview(user, { age: "30" });
    await user.click(btn(/Register patient/));
    await waitFor(() => expect(api.createPatient).toHaveBeenCalled());
    expect(sent()[0]).toMatchObject({ dob: "1996-10-03" });
  });

  test("REG-FE-PREG-008 a birthdate in Gregorian is sent as given and not marked estimated", async () => {
    api.createPatient.mockResolvedValue({ patient: { id: "pat_d", mrn: "MRN-D" } });
    const { user } = show();
    await user.type(ageBox(), "40");
    await user.click(screen.getByRole("tab", { name: "Date of birth" }));
    expect(screen.getByText("Date of birth", { selector: "label" })).toBeInTheDocument();
    expect(screen.queryByRole("textbox", { name: "Age in years" })).not.toBeInTheDocument();
    await user.click(btn("Gregorian"));
    const date = document.querySelector('input[type="date"]') as HTMLInputElement;
    await user.type(date, "1990-05-01");
    await fillStep1(user, { age: "" });
    await user.click(btn(/Continue/));
    await user.click(await screen.findByRole("button", { name: /Continue/ }));
    await screen.findByText(/Step 3 of 3/);
    expect(screen.getByText(/^1990-05-01 · .* EC$/)).toBeInTheDocument();
    await user.click(btn(/Register patient/));
    await waitFor(() => expect(api.createPatient).toHaveBeenCalled());
    expect(sent()[0]).toMatchObject({ dob: "1990-05-01", dob_estimated: false });
  });

  test("REG-FE-PREG-009 an Ethiopian birthdate is converted to Gregorian before sending", async () => {
    api.createPatient.mockResolvedValue({ patient: { id: "pat_e", mrn: "MRN-E" } });
    const { user } = show();
    await user.click(screen.getByRole("tab", { name: "Date of birth" }));
    await user.click(screen.getAllByRole("combobox").find((c) => c.textContent === "Month")!);
    await user.click(await screen.findByRole("option", { name: /^Meskerem/ }));
    await user.type(screen.getByPlaceholderText("Day"), "1");
    await user.type(screen.getByPlaceholderText("Year"), "2000");
    await toReview(user, { age: "" });
    await user.click(btn(/Register patient/));
    await waitFor(() => expect(api.createPatient).toHaveBeenCalled());
    // 1 Meskerem 2000 EC = 12 September 2007.
    expect(sent()[0]).toMatchObject({ dob: "2007-09-12", dob_estimated: false });
  });

  test("REG-FE-PREG-010 switching from a birthdate back to age clears the birthdate", async () => {
    api.createPatient.mockResolvedValue({ patient: { id: "pat_s", mrn: "MRN-S" } });
    const { user } = show();
    await user.click(screen.getByRole("tab", { name: "Date of birth" }));
    await user.click(btn("Gregorian"));
    await user.type(document.querySelector('input[type="date"]') as HTMLInputElement, "1990-05-01");
    await user.click(screen.getByRole("tab", { name: "Age in years" }));
    expect(ageBox()).toHaveValue("");
    await toReview(user, { age: "" });
    await user.click(btn(/Register patient/));
    await waitFor(() => expect(api.createPatient).toHaveBeenCalled());
    expect(sent()[0]).toMatchObject({ dob: "", dob_estimated: true });
  });

  test("REG-FE-PREG-011 a bad email stops step 2; Back returns to step 1 keeping what was typed", async () => {
    const { user } = show();
    await fillStep1(user);
    await user.click(btn(/Continue/));
    await screen.findByText(/Step 2 of 3/);
    await user.type(input(/^Email/), "not-an-email");
    await user.click(btn(/Continue/));
    expect(await screen.findByText("Invalid email")).toBeInTheDocument();
    expect(screen.getByText(/Step 2 of 3/)).toBeInTheDocument();
    await user.click(btn(/Back/));
    expect(screen.getByText(/Step 1 of 3/)).toBeInTheDocument();
    expect(input(/^First name/)).toHaveValue("Abebe");
  });

  test("REG-FE-PREG-012 pressing Enter in a field never registers", async () => {
    const { user } = show();
    await fillStep1(user);
    await user.type(input(/^First name/), "{Enter}");
    expect(api.createPatient).not.toHaveBeenCalled();
    expect(screen.getByText(/Step 1 of 3/)).toBeInTheDocument();
  });

  test("REG-FE-PREG-013 the gender chosen is the gender sent", async () => {
    api.createPatient.mockResolvedValue({ patient: { id: "pat_g", mrn: "MRN-G" } });
    const { user } = show();
    await user.click(screen.getByRole("combobox"));
    await user.click(await screen.findByRole("option", { name: "Female" }));
    await toReview(user);
    expect(screen.getByText("female")).toBeInTheDocument();
    await user.click(btn(/Register patient/));
    await waitFor(() => expect(api.createPatient).toHaveBeenCalled());
    expect(sent()[0]).toMatchObject({ gender: "female" });
  });

  test("REG-FE-PREG-014 a server error is shown and the clerk stays on Review", async () => {
    api.createPatient.mockRejectedValueOnce(new AppError(422, "MRN_TAKEN", "That card number is already in use"));
    api.createPatient.mockRejectedValueOnce(new TypeError("Failed to fetch"));
    const { user } = show();
    await toReview(user);
    await user.click(btn(/Register patient/));
    expect(await screen.findByText("That card number is already in use")).toBeInTheDocument();
    await user.click(btn(/Register patient/));
    expect(await screen.findByText("Could not register patient.")).toBeInTheDocument();
    expect(currentLocation()).toBe("/patients/new");
  });

  const dup = { id: "pat_old", mrn: "MRN-0007", full_name: "Abebe Kebede", dob: "1986-10-03", phone: "0911223344", national_id: "N1" };

  test("REG-FE-PREG-015 a possible duplicate opens a side-by-side comparison; Open record goes to the existing patient", async () => {
    api.createPatient.mockResolvedValue({ duplicates: [dup, { ...dup, id: "pat_other", mrn: "MRN-0008", phone: undefined, dob: "1970-01-01" }] });
    const { user } = show();
    await toReview(user, undefined, { phone: "0911223344" });
    await user.click(btn(/Register patient/));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText("Possible duplicate — is this the same patient?")).toBeInTheDocument();
    expect(within(dialog).getByText("MRN-0007")).toBeInTheDocument();
    expect(within(dialog).getByText("MRN-0008")).toBeInTheDocument();
    // Matching phone and birthdate are highlighted on the first match only.
    const phones = within(dialog).getAllByText("0911223344");
    expect(phones.filter((el) => el.className.includes("bg-amber-100"))).toHaveLength(1);
    expect(within(dialog).getAllByText("1986-10-03").filter((el) => el.className.includes("bg-amber-100"))).toHaveLength(1);
    expect(currentLocation()).toBe("/patients/new");
    await user.click(within(dialog).getAllByRole("button", { name: /Open record/ })[0]);
    expect(currentLocation()).toBe("/patients/pat_old");
    expect(api.createPatient).toHaveBeenCalledTimes(1);
  });

  test("REG-FE-PREG-016 'Different person' re-sends the same values with force=true and lands on the new patient", async () => {
    api.createPatient.mockResolvedValueOnce({ duplicates: [dup] }).mockResolvedValueOnce({ patient: { id: "pat_new2", mrn: "MRN-0099" } });
    const { user } = show();
    await toReview(user);
    await user.click(btn(/Register patient/));
    const dialog = await screen.findByRole("dialog");
    await user.click(within(dialog).getByRole("button", { name: "Different person — register new" }));
    await waitFor(() => expect(api.createPatient).toHaveBeenCalledTimes(2));
    const [first, second] = api.createPatient.mock.calls as [Record<string, unknown>, boolean][];
    expect(first[1]).toBe(false);
    expect(second[1]).toBe(true);
    expect(second[0]).toMatchObject({ first_name: "Abebe", last_name: "Kebede", dob: "1986-10-03" });
    await waitFor(() => expect(currentLocation()).toBe("/patients/pat_new2"));
  });

  test("REG-FE-PREG-017 'Back to edit' closes the comparison without registering", async () => {
    api.createPatient.mockResolvedValue({ duplicates: [dup] });
    const { user } = show();
    await toReview(user);
    await user.click(btn(/Register patient/));
    const dialog = await screen.findByRole("dialog");
    await user.click(within(dialog).getByRole("button", { name: "Back to edit" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(api.createPatient).toHaveBeenCalledTimes(1);
    expect(screen.getByText(/Step 3 of 3/)).toBeInTheDocument();
  });

  test("REG-FE-PREG-018 an empty duplicates list is not a duplicate prompt (and not a success)", async () => {
    api.createPatient.mockResolvedValue({ duplicates: [] });
    const { user } = show();
    await toReview(user);
    await user.click(btn(/Register patient/));
    await waitFor(() => expect(api.createPatient).toHaveBeenCalled());
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(currentLocation()).toBe("/patients/new");
  });

  test.fails("REG-FE-PREG-019 KNOWN BUG NEW-PATUI-1 an impossible age (150) is refused, not silently dropped", async () => {
    const { user } = show();
    await fillStep1(user, { age: "150" });
    await user.click(btn(/Continue/));
    // Correct: the clerk is told and kept on step 1. Today the age becomes "no
    // birthdate" with no message and the wizard moves on.
    expect(screen.getByText(/Step 1 of 3/)).toBeInTheDocument();
  });
  test("REG-FE-PREG-040 a name typed into reception search arrives pre-filled: first word first, the rest last", async () => {
    show("/patients/new?name=Abeba%20Kebede%20Tola");
    expect(input(/^First name/)).toHaveValue("Abeba");
    expect(input(/^Last name/)).toHaveValue("Kebede Tola");
  });

  test("REG-FE-PREG-041 a single typed word is only the first name; no name leaves the form empty", async () => {
    show("/patients/new?name=Abeba");
    expect(input(/^First name/)).toHaveValue("Abeba");
    expect(input(/^Last name/)).toHaveValue("");
  });

});

describe("REG-FE-PREG patient schema", () => {
  const base = { first_name: "A", gender: "male" as const, dob: "" };

  test("REG-FE-PREG-020 the schema needs a first name and a known gender, nothing else", () => {
    expect(patientSchema.safeParse(base).success).toBe(true);
    const noName = patientSchema.safeParse({ ...base, first_name: "" });
    expect(noName.success).toBe(false);
    expect(noName.error?.issues[0].message).toBe("First name is required");
    expect(patientSchema.safeParse({ ...base, gender: "x" }).success).toBe(false);
  });

  test("REG-FE-PREG-021 a birthdate is a full YYYY-MM-DD or empty", () => {
    expect(patientSchema.safeParse({ ...base, dob: "1990-05-01" }).success).toBe(true);
    const partial = patientSchema.safeParse({ ...base, dob: "1990-05" });
    expect(partial.success).toBe(false);
    expect(partial.error?.issues.some((i) => i.message === "Enter a full date of birth, or switch to age")).toBe(true);
  });

  test("REG-FE-PREG-022 email may be empty but must be valid when given", () => {
    expect(patientSchema.safeParse({ ...base, email: "" }).success).toBe(true);
    expect(patientSchema.safeParse({ ...base, email: "a@b.co" }).success).toBe(true);
    const bad = patientSchema.safeParse({ ...base, email: "nope" });
    expect(bad.success).toBe(false);
    expect(bad.error?.issues.some((i) => i.message === "Invalid email")).toBe(true);
  });
});
