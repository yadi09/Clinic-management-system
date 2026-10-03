// The patient list is the front desk's first stop. What it must get right: the
// count it says ("registered" vs "matching"), a search that reaches the server
// (debounced) and starts again at page 1, the gender filter, paging that only
// appears when there is more than one page, every row opening that patient (by
// click and by keyboard on the phone cards, while the phone number dials instead),
// the dental "owes" badge, register/import actions only for people allowed to
// create patients, and a failed load shown as a failure with Retry — never as
// "No patients yet".
//
// KNOWN-BUG CONVENTION: `test.fails("REG-... KNOWN BUG <id> ...")` asserts the
// CORRECT behaviour, so it fails today and Vitest counts it as an expected failure.
// When the bug is fixed it turns red and is flipped to `test`. Never weaken it.
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

const auth = vi.hoisted(() => ({ perms: new Set<string>(), flags: new Set<string>() }));
vi.mock("@/app/auth-context", () => ({
  useAuth: () => ({ can: (p: string) => auth.perms.has(p), flagOn: (f: string) => auth.flags.has(f) }),
}));
const api = vi.hoisted(() => ({ searchPatients: vi.fn() }));
vi.mock("@/features/patients/api", async (orig) => ({ ...(await orig<object>()), ...api }));
const dental = vi.hoisted(() => ({ dentalOutstanding: vi.fn() }));
vi.mock("@/features/dental/api", async (orig) => ({ ...(await orig<object>()), ...dental }));

import { PatientsListPage } from "@/features/patients/pages/PatientsListPage";
import type { PatientSummary } from "@/features/patients/api";
import { currentLocation, freezeToday, renderUI } from "@/test/render";

const abebe: PatientSummary = { id: "pat_1", mrn: "MRN-0001", first_name: "Abebe", middle_name: "Kebede", last_name: "Bekele", gender: "male", dob: "1990-05-01", phone: "0911000000" };
const almaz: PatientSummary = { id: "pat_2", mrn: "MRN-0002", first_name: "Almaz", last_name: "Haile", gender: "female", dob: "", phone: undefined };

const page = (items: PatientSummary[], total = items.length) => ({ items, meta: { total } });
const lastCall = () => api.searchPatients.mock.calls.at(-1) as [string, number, number, { gender?: string }];

function show(route = "/patients") {
  return renderUI(<PatientsListPage />, { route });
}

describe("REG-FE-PLIST patients list", () => {
  beforeEach(() => {
    auth.perms = new Set(["patient.create", "patient.read"]);
    auth.flags = new Set(["dental"]);
    api.searchPatients.mockReset();
    dental.dentalOutstanding.mockReset();
    dental.dentalOutstanding.mockResolvedValue([]);
    freezeToday("2026-10-03", 10);
  });
  afterEach(() => vi.useRealTimers());

  test("REG-FE-PLIST-001 first load asks for page 1 of 20, unfiltered, and says how many are registered", async () => {
    api.searchPatients.mockResolvedValue(page([abebe, almaz], 2));
    show();
    expect(screen.getByText("Loading…")).toBeInTheDocument();
    expect(await screen.findByText("2 registered")).toBeInTheDocument();
    expect(api.searchPatients).toHaveBeenCalledWith("", 1, 20, { gender: undefined });
    // Full name joins middle names; MRN, gender and Ethiopian date are shown.
    expect(screen.getAllByText("Abebe Kebede Bekele").length).toBeGreaterThan(0);
    const row = screen.getAllByRole("row").find((r) => r.textContent?.includes("MRN-0001"))!;
    expect(row).toHaveTextContent("1990-05-01");
    expect(row).toHaveTextContent(/EC/);
    expect(row).toHaveTextContent("36 yrs");
    expect(row).toHaveTextContent("0911000000");
    // No paging for a single page.
    expect(screen.queryByRole("button", { name: "Next" })).not.toBeInTheDocument();
  });

  test("REG-FE-PLIST-002 a patient with no phone or birthdate shows dashes, not blanks", async () => {
    api.searchPatients.mockResolvedValue(page([almaz]));
    show();
    const row = (await screen.findAllByRole("row")).find((r) => r.textContent?.includes("MRN-0002"))!;
    expect(within(row).getAllByText("—").length).toBeGreaterThanOrEqual(2); // age and phone
    const card = screen.getAllByRole("link").find((l) => l.textContent?.includes("MRN-0002"))!;
    expect(within(card).getAllByText("—").length).toBeGreaterThanOrEqual(1);
    expect(within(card).queryByText(/EC$/)).not.toBeInTheDocument();
  });

  test("REG-FE-PLIST-003 searching is debounced, reaches the server and says 'matching'", async () => {
    api.searchPatients.mockResolvedValue(page([abebe], 1));
    const { user } = show();
    await screen.findByText("1 registered");
    await user.type(screen.getByPlaceholderText("Name, MRN, or phone"), "abe");
    await waitFor(() => expect(lastCall()[0]).toBe("abe"));
    // Debounced: one request for the whole word, not one per keystroke.
    expect(api.searchPatients.mock.calls.filter((c) => c[0] === "a" || c[0] === "ab")).toHaveLength(0);
    expect(await screen.findByText("1 matching")).toBeInTheDocument();
  });

  test("REG-FE-PLIST-004 a search with no hits says 'No matching patients' and offers no register button in the card", async () => {
    api.searchPatients.mockImplementation(async (q: string) => (q ? page([], 0) : page([abebe], 1)));
    const { user } = show();
    await screen.findByText("1 registered");
    await user.type(screen.getByPlaceholderText("Name, MRN, or phone"), "zzz");
    expect(await screen.findByText("No matching patients")).toBeInTheDocument();
    expect(screen.getByText("Try a different search or clear the filters.")).toBeInTheDocument();
    // Only the header's Register button; the empty-state one is for an empty clinic.
    expect(screen.getAllByRole("button", { name: /Register patient/ })).toHaveLength(1);
  });

  test("REG-FE-PLIST-005 an empty clinic invites the first registration", async () => {
    api.searchPatients.mockResolvedValue(page([], 0));
    const { user } = show();
    expect(await screen.findByText("No patients yet")).toBeInTheDocument();
    expect(screen.getByText("0 registered")).toBeInTheDocument();
    const buttons = screen.getAllByRole("button", { name: /Register patient/ });
    expect(buttons).toHaveLength(2);
    await user.click(buttons[1]);
    expect(currentLocation()).toBe("/patients/new");
  });

  test("REG-FE-PLIST-006 header actions open registration and the import page", async () => {
    api.searchPatients.mockResolvedValue(page([abebe]));
    const { user } = show();
    await user.click(screen.getByRole("button", { name: /Import old records/ }));
    expect(currentLocation()).toBe("/patients/import");
    await user.click(screen.getByRole("button", { name: /Register patient/ }));
    expect(currentLocation()).toBe("/patients/new");
  });

  test("REG-FE-PLIST-007 without patient.create there is no register or import, even on an empty list", async () => {
    auth.perms = new Set(["patient.read"]);
    api.searchPatients.mockResolvedValue(page([], 0));
    show();
    expect(await screen.findByText("No patients yet")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Register patient/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Import old records/ })).not.toBeInTheDocument();
  });

  test("REG-FE-PLIST-008 a failed load says so with a Retry that asks again (never 'No patients yet')", async () => {
    api.searchPatients.mockRejectedValueOnce(new Error("boom")).mockResolvedValue(page([abebe], 1));
    const { user } = show();
    expect(await screen.findByText("Couldn't load patients.")).toBeInTheDocument();
    expect(screen.queryByText("No patients yet")).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Retry" }));
    expect(await screen.findByText("1 registered")).toBeInTheDocument();
    expect(api.searchPatients).toHaveBeenCalledTimes(2);
  });

  test("REG-FE-PLIST-009 a failed search is a failure too, not 'No matching patients'", async () => {
    api.searchPatients.mockImplementation(async (q: string) => {
      if (q) throw new Error("down");
      return page([abebe], 1);
    });
    const { user } = show();
    await screen.findByText("1 registered");
    await user.type(screen.getByPlaceholderText("Name, MRN, or phone"), "abe");
    expect(await screen.findByText("Couldn't load patients.")).toBeInTheDocument();
    expect(screen.queryByText("No matching patients")).not.toBeInTheDocument();
  });

  test("REG-FE-PLIST-010 paging: Next/Previous move pages, edges are disabled, a new search returns to page 1", async () => {
    api.searchPatients.mockImplementation(async (_q: string, p: number) => page([{ ...abebe, id: `pat_p${p}`, mrn: `MRN-P${p}` }], 45));
    const { user } = show();
    expect(await screen.findByText("Page 1 of 3")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Previous" })).toBeDisabled();
    await user.click(screen.getByRole("button", { name: "Next" }));
    expect(await screen.findByText("Page 2 of 3")).toBeInTheDocument();
    expect(lastCall()[1]).toBe(2);
    await user.click(screen.getByRole("button", { name: "Next" }));
    expect(await screen.findByText("Page 3 of 3")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Next" })).toBeDisabled();
    await user.click(screen.getByRole("button", { name: "Previous" }));
    expect(await screen.findByText("Page 2 of 3")).toBeInTheDocument();
    await user.type(screen.getByPlaceholderText("Name, MRN, or phone"), "a");
    await waitFor(() => expect(lastCall()).toEqual(["a", 1, 20, { gender: undefined }]));
    expect(await screen.findByText("Page 1 of 3")).toBeInTheDocument();
  });

  test("REG-FE-PLIST-011 the gender filter narrows the list, resets to page 1 and says 'matching'", async () => {
    api.searchPatients.mockResolvedValue(page([almaz], 1));
    const { user } = show();
    await screen.findByText("1 registered");
    await user.click(screen.getByRole("combobox"));
    await user.click(await screen.findByRole("option", { name: "Female" }));
    await waitFor(() => expect(lastCall()).toEqual(["", 1, 20, { gender: "female" }]));
    expect(await screen.findByText("1 matching")).toBeInTheDocument();
  });

  test("REG-FE-PLIST-012 a filter with no hits says 'No matching patients'", async () => {
    api.searchPatients.mockImplementation(async (_q: string, _p: number, _s: number, f: { gender?: string }) => (f.gender ? page([], 0) : page([abebe], 1)));
    const { user } = show();
    await screen.findByText("1 registered");
    await user.click(screen.getByRole("combobox"));
    await user.click(await screen.findByRole("option", { name: "Unknown" }));
    expect(await screen.findByText("No matching patients")).toBeInTheDocument();
  });

  test("REG-FE-PLIST-013 clicking a table row opens that patient", async () => {
    api.searchPatients.mockResolvedValue(page([abebe, almaz]));
    const { user } = show();
    const row = (await screen.findAllByRole("row")).find((r) => r.textContent?.includes("MRN-0002"))!;
    await user.click(row);
    expect(currentLocation()).toBe("/patients/pat_2");
  });

  test("REG-FE-PLIST-014 phone cards open the patient on tap, Enter and Space; other keys do nothing", async () => {
    api.searchPatients.mockResolvedValue(page([abebe, almaz]));
    const { user } = show();
    await screen.findByText("2 registered");
    const card = (mrn: string) => screen.getAllByRole("link").find((l) => l.tagName === "LI" && l.textContent?.includes(mrn))!;
    expect(card("MRN-0001")).toHaveAttribute("tabindex", "0");
    fireEvent.keyDown(card("MRN-0001"), { key: "a" });
    expect(currentLocation()).toBe("/patients");
    fireEvent.keyDown(card("MRN-0001"), { key: "Enter" });
    expect(currentLocation()).toBe("/patients/pat_1");
    fireEvent.keyDown(card("MRN-0002"), { key: " " });
    expect(currentLocation()).toBe("/patients/pat_2");
    await user.click(card("MRN-0001"));
    expect(currentLocation()).toBe("/patients/pat_1");
  });

  test("REG-FE-PLIST-015 tapping the phone number on a card dials it instead of opening the record", async () => {
    api.searchPatients.mockResolvedValue(page([abebe]));
    show();
    await screen.findByText("1 registered");
    const tel = screen.getByRole("link", { name: "0911000000" });
    expect(tel).toHaveAttribute("href", "tel:0911000000");
    tel.addEventListener("click", (e) => e.preventDefault()); // jsdom cannot dial
    fireEvent.click(tel);
    expect(currentLocation()).toBe("/patients");
  });

  test("REG-FE-PLIST-016 a dental clinic flags patients who owe, with the amount in ETB", async () => {
    dental.dentalOutstanding.mockResolvedValue([{ patient_id: "pat_1", balance: "12500" }]);
    api.searchPatients.mockResolvedValue(page([abebe, almaz]));
    show();
    const badges = await screen.findAllByText(/^Owes .*12.?500 ETB$/);
    expect(badges).toHaveLength(2); // the phone card and the table row
    const row = screen.getAllByRole("row").find((r) => r.textContent?.includes("MRN-0002"))!;
    expect(row).not.toHaveTextContent("Owes");
  });

  test("REG-FE-PLIST-017 a non-dental clinic never asks who owes and shows no badge", async () => {
    auth.flags = new Set();
    api.searchPatients.mockResolvedValue(page([abebe]));
    show();
    await screen.findByText("1 registered");
    expect(dental.dentalOutstanding).not.toHaveBeenCalled();
    expect(screen.queryByText(/^Owes/)).not.toBeInTheDocument();
  });

  test.fails("REG-FE-PLIST-018 KNOWN BUG UX-6 /patients?new=1 (linked from other screens) opens registration", async () => {
    api.searchPatients.mockResolvedValue(page([abebe]));
    show("/patients?new=1");
    await screen.findByText("1 registered");
    await waitFor(() => expect(currentLocation()).toBe("/patients/new"), { timeout: 500 });
  });
});
