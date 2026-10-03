// The patient profile page (/patients/:id).
//
// A dental clinic gets the dental workspace in its place (a flag), so this file
// proves that switch and then covers the general-medical page the flag falls back
// to. What the page must get right:
//  - the banner: who this is (name, MRN, age, sex, blood group), every allergy
//    always visible, and the links to the schedule and the calendar;
//  - the sticky alert bar carries the severe/moderate allergies and the active
//    conditions once the banner scrolls away — mild allergies stay in the banner;
//  - allergies and conditions can be added and removed only by someone with
//    patient.update, and each change reaches the API and refreshes the record;
//  - the wide column is ordered by who is reading (care / front desk / lab), and
//    a reader who holds several lenses can switch between them;
//  - the desk's billing list prints receipts and refunds only what can be refunded,
//    with a reason, and shows the server's refusal in its own words;
//  - visit history opens the read-only record, documents are grouped by type.
import { act, screen, waitFor, within } from "@testing-library/react";
import { useState } from "react";
import { Route, Routes } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

const patients = vi.hoisted(() => ({
  getPatient: vi.fn(), patientOverview: vi.fn(), addAllergy: vi.fn(), removeAllergy: vi.fn(),
  addCondition: vi.fn(), removeCondition: vi.fn(), patientLabs: vi.fn(),
}));
const billing = vi.hoisted(() => ({ patientCharges: vi.fn(), refundCharge: vi.fn() }));
const clinical = vi.hoisted(() => ({ listAllergens: vi.fn(), createAllergen: vi.fn(), listHistory: vi.fn(), getVitalFields: vi.fn() }));
const admin = vi.hoisted(() => ({ getClinic: vi.fn() }));
const print = vi.hoisted(() => ({ printReceipt: vi.fn() }));
const auth = vi.hoisted(() => ({ perms: new Set<string>(), flags: new Set<string>() }));
const toast = vi.hoisted(() => Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn() }));

vi.mock("@/features/patients/api", async (orig) => ({ ...(await orig<object>()), ...patients }));
vi.mock("@/features/billing/api", async (orig) => ({ ...(await orig<object>()), ...billing }));
vi.mock("@/features/clinical/api", async (orig) => ({ ...(await orig<object>()), ...clinical }));
vi.mock("@/features/admin/api", async (orig) => ({ ...(await orig<object>()), ...admin }));
vi.mock("@/features/billing/print", () => print);
vi.mock("@/components/ui/sonner", async (orig) => ({ ...(await orig<object>()), toast }));
vi.mock("@/lib/api-client", async (orig) => {
  const { quietApiFetch } = await import("@/test/render");
  return { ...(await orig<object>()), apiFetch: vi.fn(quietApiFetch) };
});
vi.mock("@/app/auth-context", () => ({
  useAuth: () => ({
    can: (p: string) => auth.perms.has(p),
    flagOn: (f: string) => auth.flags.has(f),
    user: { id: "u1", full_name: "Test" },
  }),
}));
// Components with their own tests: here they only have to be placed, and given the
// right patient and permissions.
vi.mock("@/features/dental/DentalWorkspace", () => ({
  DentalWorkspace: ({ patientId }: { patientId: string }) => <p>dental workspace for {patientId}</p>,
}));
vi.mock("@/features/clinical/components/PatientStory", () => ({
  PatientStoryPanel: ({ patientId }: { patientId: string }) => <p>story panel for {patientId}</p>,
  VisitDetailDialog: ({ item, onClose }: { item: { id: string }; onClose: () => void }) => (
    <div role="dialog" aria-label="Visit record">visit {item.id}<button onClick={onClose}>close visit</button></div>
  ),
}));
vi.mock("@/features/clinical/CertificateCard", () => ({
  CertificateCard: ({ canIssue }: { canIssue: boolean }) => <p>certificates (issue: {String(canIssue)})</p>,
}));
vi.mock("@/features/maternity/PregnancyCalculator", () => ({
  PregnancyDatingCard: ({ patientId }: { patientId: string }) => <p>pregnancy dating for {patientId}</p>,
}));
vi.mock("@/features/patients/components/PatientEditDialog", () => ({
  PatientEditDialog: ({ onClose, onSaved }: { onClose: () => void; onSaved: () => void }) => (
    <div role="dialog" aria-label="Edit patient">
      <button onClick={onSaved}>stub save</button><button onClick={onClose}>stub close</button>
    </div>
  ),
}));

import { PatientProfilePage } from "../PatientProfilePage";
import { AppError } from "@/lib/api-client";
import { currentLocation, renderUI } from "@/test/render";

const NOW = new Date("2026-10-03T12:00:00+03:00");
const patient = (extra: Record<string, unknown> = {}) => ({
  id: "pat_1", mrn: "MRN-42", first_name: "Abebe", middle_name: "Kebede", last_name: "Tesfaye", gender: "male",
  dob: "1990-01-01", phone: "0911223344", email: "abebe@example.com", blood_group: "O+",
  allergies: [], conditions: [], attachments: [], guardians: [], created_at: "", ...extra,
});
const ALG = {
  pen: { id: "a1", substance: "Penicillin", reaction: "Rash", severity: "severe" },
  nsaid: { id: "a2", substance: "Ibuprofen", severity: "moderate" },
  dust: { id: "a3", substance: "Dust", severity: "mild" },
};
const COND = {
  htn: { id: "c1", description: "Hypertension", icd_code: "I10", status: "active" },
  old: { id: "c2", description: "Old fracture", status: "resolved" },
};
const charge = (id: string, extra: Record<string, unknown> = {}) => ({
  id, source: "consultation", description: `Charge ${id}`, amount: "300.00", currency: "ETB", status: "paid",
  created_at: "2026-10-03T07:00:00Z", ...extra,
});
const visit = (id: string, extra: Record<string, unknown> = {}) => ({
  id, started_at: "2026-09-20T07:00:00Z", status: "closed", type: "opd", provider_name: "Dr Hana", primary_dx: `Dx ${id}`, ...extra,
});

/** Lets a test remount the page inside the same QueryClient (a return visit). */
function Harness() {
  const [k, setK] = useState(0);
  return (
    <>
      <button onClick={() => setK((x) => x + 1)}>remount</button>
      <Routes key={k}>
        <Route path="/patients/:id" element={<PatientProfilePage />} />
        <Route path="*" element={<p>elsewhere</p>} />
      </Routes>
    </>
  );
}
const page = () => renderUI(<Harness />, { route: "/patients/pat_1" });
const loaded = () => screen.findByRole("heading", { level: 2, name: /Abebe/ });
const contact = () => screen.getByText("Contact & identity").parentElement!.parentElement as HTMLElement;
const section = (title: string) => {
  const t = screen.getAllByText(title).find((n) => n.closest("[class*=flex-row]"));
  return t!.closest("[class*=flex-row]")!.parentElement as HTMLElement;
};

/** An IntersectionObserver the test can drive. */
function controllableObserver() {
  const made: IntersectionObserverCallback[] = [];
  vi.stubGlobal("IntersectionObserver", class {
    constructor(cb: IntersectionObserverCallback) { made.push(cb); }
    observe() {} unobserve() {} disconnect() {} takeRecords() { return []; }
  });
  const scrollPast = () => act(() => made[made.length - 1](
    [{ isIntersecting: false, boundingClientRect: { top: -50 } } as unknown as IntersectionObserverEntry],
    {} as IntersectionObserver,
  ));
  return { made, scrollPast };
}

describe("REG-FE-PPROFILE the patient profile page", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(NOW);
    auth.perms = new Set(["patient.update", "payment.collect"]);
    auth.flags = new Set();
    [...Object.values(patients), ...Object.values(billing), ...Object.values(clinical), admin.getClinic,
      print.printReceipt, toast, toast.success, toast.error].forEach((f) => f.mockReset());
    patients.getPatient.mockResolvedValue(patient());
    patients.patientOverview.mockResolvedValue({});
    patients.patientLabs.mockResolvedValue([]);
    patients.addAllergy.mockResolvedValue({});
    patients.removeAllergy.mockResolvedValue(undefined);
    patients.addCondition.mockResolvedValue({});
    patients.removeCondition.mockResolvedValue(undefined);
    billing.patientCharges.mockResolvedValue({ rows: [] });
    billing.refundCharge.mockResolvedValue(undefined);
    clinical.listAllergens.mockResolvedValue([]);
    clinical.createAllergen.mockResolvedValue({});
    clinical.listHistory.mockResolvedValue([]);
    clinical.getVitalFields.mockResolvedValue([]);
    admin.getClinic.mockResolvedValue({ name: "Cure Dental" });
  });
  afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

  /* ------------------------------------------------------------ dental flag */

  test("REG-FE-PPROFILE-001 a dental clinic gets the dental workspace for this patient instead of the general page", async () => {
    auth.flags = new Set(["dental"]);
    page();
    expect(screen.getByText("dental workspace for pat_1")).toBeInTheDocument();
    expect(screen.queryByText("Contact & identity")).not.toBeInTheDocument();
  });

  /* ------------------------------------------------------- loading / error */

  test("REG-FE-PPROFILE-002 while loading: placeholders, no banner", () => {
    patients.getPatient.mockReturnValue(new Promise(() => {}));
    const { container } = page();
    expect(container.querySelectorAll(".animate-pulse, [class*=skeleton]").length).toBeGreaterThan(0);
    expect(screen.queryByRole("heading", { level: 2 })).not.toBeInTheDocument();
  });

  test("REG-FE-PPROFILE-003 a patient that cannot be loaded: Patient not found, and a way back to the list", async () => {
    patients.getPatient.mockRejectedValue(new AppError(404, "not_found", "nope"));
    const { user } = page();
    expect(await screen.findByText("Patient not found.")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /Back to patients/ }));
    expect(currentLocation()).toBe("/patients");
  });

  /* ---------------------------------------------------------------- banner */

  test("REG-FE-PPROFILE-004 banner: full name, initials, MRN · age · sex · blood group; no allergies said plainly", async () => {
    page();
    await loaded();
    expect(screen.getByRole("heading", { level: 2 })).toHaveTextContent("Abebe Kebede Tesfaye");
    expect(screen.getByText("AT")).toBeInTheDocument();
    expect(screen.getByText(/^MRN MRN-42/).textContent).toBe("MRN MRN-42 · 36y · male · O+");
    expect(screen.getAllByText(/No known allergies/).length).toBe(2); // banner chip + allergy card
    expect(patients.getPatient).toHaveBeenCalledWith("pat_1");
    expect(patients.patientOverview).toHaveBeenCalledWith("pat_1");
  });

  test("REG-FE-PPROFILE-005 banner without dob, sex or blood group: just the MRN; a bad date is not an age", async () => {
    patients.getPatient.mockResolvedValue(patient({ dob: "", gender: "unknown", blood_group: "", middle_name: "", last_name: "" }));
    page();
    await screen.findByRole("heading", { level: 2, name: "Abebe" });
    expect(screen.getByText(/^MRN MRN-42/).textContent).toBe("MRN MRN-42");
    expect(screen.getByText("A")).toBeInTheDocument();
  });

  test("REG-FE-PPROFILE-006 Schedule opens this patient's timeline", async () => {
    const { user } = page();
    await loaded();
    await user.click(screen.getByRole("button", { name: "Schedule" }));
    expect(currentLocation()).toBe("/patients/pat_1/schedule");
  });

  test("REG-FE-PPROFILE-007 On the calendar opens the clinic calendar narrowed to this patient", async () => {
    const { user } = page();
    await loaded();
    await user.click(screen.getByRole("button", { name: "On the calendar" }));
    expect(currentLocation()).toBe("/appointments?patient=pat_1");
  });

  test("REG-FE-PPROFILE-008 the Patients link returns to the list", async () => {
    const { user } = page();
    await loaded();
    await user.click(screen.getByRole("button", { name: "Patients" }));
    expect(currentLocation()).toBe("/patients");
  });

  test("REG-FE-PPROFILE-009 every allergy, mild included, is a red chip in the banner", async () => {
    patients.getPatient.mockResolvedValue(patient({ allergies: [ALG.pen, ALG.dust] }));
    page();
    await loaded();
    const banner = screen.getByRole("heading", { level: 2 }).closest(".bg-brand") as HTMLElement;
    expect(within(banner).getByText(/Allergy: Penicillin/)).toBeInTheDocument();
    expect(within(banner).getByText(/Allergy: Dust/)).toBeInTheDocument();
    expect(within(banner).queryByText("No known allergies")).not.toBeInTheDocument();
  });

  test("REG-FE-PPROFILE-010 the right-now strip is filled from the overview", async () => {
    patients.patientOverview.mockResolvedValue({ money: { owed: "450", oldest_days: 2, all_agreed: false } });
    page();
    await loaded();
    expect(await screen.findByText("Owes")).toBeInTheDocument();
    expect(screen.getByText(/ETB 450\.00/)).toBeInTheDocument();
  });

  /* ------------------------------------------------------ sticky alert bar */

  test("REG-FE-PPROFILE-011 sticky bar (return visit): severe/moderate allergies and active conditions only, once the banner scrolls away", async () => {
    const io = controllableObserver();
    patients.getPatient.mockResolvedValue(patient({ allergies: [ALG.pen, ALG.nsaid, ALG.dust], conditions: [COND.htn, COND.old] }));
    const { user } = page();
    await loaded();
    // Come back to the page with the record already in hand.
    await user.click(screen.getByRole("button", { name: "remount" }));
    await loaded();
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
    io.scrollPast();
    const bar = await screen.findByRole("status");
    expect(bar).toHaveTextContent("Abebe Kebede Tesfaye");
    expect(bar).toHaveTextContent("Allergy: Penicillin");
    expect(bar).toHaveTextContent("Allergy: Ibuprofen");
    expect(bar).toHaveTextContent("Hypertension");
    expect(bar).not.toHaveTextContent("Dust");
    expect(bar).not.toHaveTextContent("Old fracture");
  });

  test.fails("REG-FE-PPROFILE-012 KNOWN BUG NEW-PROF-6 sticky alert bar on a first visit: must appear once the banner scrolls away", async () => {
    // useScrolledPast (StickyAlertBar.tsx:312-321) attaches its observer in an
    // effect keyed on the ref object, which runs once — on the first render, while
    // PatientProfilePage.tsx:87 is still showing the skeleton and the banner does
    // not exist yet. The effect never re-runs, so on a normal (uncached) open of a
    // patient the severe-allergy bar never appears, however far the user scrolls.
    const io = controllableObserver();
    patients.getPatient.mockResolvedValue(patient({ allergies: [ALG.pen] }));
    page();
    await loaded();
    expect(io.made.length).toBeGreaterThan(0);
    io.scrollPast();
    expect(await screen.findByRole("status")).toHaveTextContent("Allergy: Penicillin");
  });

  /* --------------------------------------------------- contact & identity */

  test("REG-FE-PPROFILE-013 contact & identity: what is on file, a dash for what is not, DOB also in EC", async () => {
    patients.getPatient.mockResolvedValue(patient({ national_id: "ET-123" }));
    page();
    await loaded();
    const c = contact();
    const row = (label: string) => within(c).getByText(label).parentElement!;
    expect(row("Phone")).toHaveTextContent("0911223344");
    expect(row("Email")).toHaveTextContent("abebe@example.com");
    expect(row("National ID")).toHaveTextContent("ET-123");
    expect(row("Passport")).toHaveTextContent("—");
    expect(row("Date of birth")).toHaveTextContent(/^Date of birth1990-01-01 · .+ EC$/);
  });

  test("REG-FE-PPROFILE-014 no date of birth: a dash", async () => {
    patients.getPatient.mockResolvedValue(patient({ dob: "" }));
    page();
    await loaded();
    expect(within(contact()).getByText("Date of birth").parentElement).toHaveTextContent("Date of birth—");
  });

  /* ------------------------------------------------- allergies & conditions */

  test("REG-FE-PPROFILE-015 allergy and condition lists: substance, reaction, severity; description, ICD, status", async () => {
    patients.getPatient.mockResolvedValue(patient({ allergies: [ALG.pen, ALG.nsaid, ALG.dust], conditions: [COND.htn, COND.old] }));
    page();
    await loaded();
    const a = section("Allergies");
    expect(within(a).getByText("Penicillin").closest("li")).toHaveTextContent("Penicillin — Rash severe");
    expect(within(a).getByText("Ibuprofen").closest("li")).toHaveTextContent(/^Ibuprofen moderate/);
    expect(within(a).getByText("Dust").closest("li")).toHaveTextContent(/mild/);
    const c = section("Conditions");
    expect(within(c).getByText("Hypertension").closest("li")).toHaveTextContent("Hypertension — I10 active");
    expect(within(c).getByText("Old fracture").closest("li")).toHaveTextContent("resolved");
  });

  test("REG-FE-PPROFILE-016 empty allergy and condition cards say so", async () => {
    page();
    await loaded();
    expect(within(section("Allergies")).getByText("No known allergies.")).toBeInTheDocument();
    expect(within(section("Conditions")).getByText("No recorded conditions.")).toBeInTheDocument();
  });

  test("REG-FE-PPROFILE-017 Remove reaches the API for that allergy / condition and refreshes the record", async () => {
    patients.getPatient.mockResolvedValue(patient({ allergies: [ALG.pen], conditions: [COND.htn] }));
    const { user } = page();
    await loaded();
    await user.click(within(section("Allergies")).getByRole("button", { name: "Remove" }));
    await waitFor(() => expect(patients.removeAllergy).toHaveBeenCalledWith("pat_1", "a1"));
    await waitFor(() => expect(patients.getPatient).toHaveBeenCalledTimes(2));
    await user.click(within(section("Conditions")).getByRole("button", { name: "Remove" }));
    await waitFor(() => expect(patients.removeCondition).toHaveBeenCalledWith("pat_1", "c1"));
    await waitFor(() => expect(patients.getPatient).toHaveBeenCalledTimes(3));
  });

  test("REG-FE-PPROFILE-018 without patient.update: no Edit details, no Add, no Remove — but allergies still shown", async () => {
    auth.perms = new Set(["payment.collect"]);
    patients.getPatient.mockResolvedValue(patient({ allergies: [ALG.pen], conditions: [COND.htn] }));
    page();
    await loaded();
    expect(screen.queryByRole("button", { name: /Edit details/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Add/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Remove" })).not.toBeInTheDocument();
    expect(within(section("Allergies")).getByText("Penicillin")).toBeInTheDocument();
  });

  test("REG-FE-PPROFILE-019 add a new allergy: teaches the library, records it with reaction and severity, refreshes", async () => {
    const { user } = page();
    await loaded();
    await user.click(within(section("Allergies")).getByRole("button", { name: /Add/ }));
    const dlg = await screen.findByRole("dialog", { name: "Add allergy" });
    await waitFor(() => expect(clinical.listAllergens).toHaveBeenCalled());
    const save = within(dlg).getByRole("button", { name: "Save" });
    expect(save).toBeDisabled();
    const [substance, reaction] = within(dlg).getAllByRole("textbox");
    await user.type(substance, " Latex ");
    expect(within(dlg).getByText("New — will be added to the allergen library.")).toBeInTheDocument();
    await user.type(reaction, " Hives ");
    await user.click(within(dlg).getByRole("combobox"));
    await user.click(await screen.findByRole("option", { name: "Severe" }));
    await user.click(save);
    await waitFor(() => expect(patients.addAllergy).toHaveBeenCalledWith("pat_1", { substance: "Latex", reaction: " Hives ", severity: "severe" }));
    expect(clinical.createAllergen).toHaveBeenCalledWith("Latex", { default_reaction: "Hives", default_severity: "severe" });
    expect(toast.success).toHaveBeenCalledWith("Allergy added");
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    await waitFor(() => expect(patients.getPatient).toHaveBeenCalledTimes(2));
  });

  test("REG-FE-PPROFILE-020 picking a known allergen pre-fills its usual reaction and severity and does not re-create it", async () => {
    clinical.listAllergens.mockResolvedValue([{ id: "al1", name: "Lidocaine", default_reaction: "Swelling", default_severity: "moderate" }]);
    const { user } = page();
    await loaded();
    await user.click(within(section("Allergies")).getByRole("button", { name: /Add/ }));
    const dlg = await screen.findByRole("dialog", { name: "Add allergy" });
    await waitFor(() => expect(clinical.listAllergens).toHaveBeenCalled());
    const [substance, reaction] = within(dlg).getAllByRole("textbox");
    await user.type(substance, "lido");
    await user.click(await within(dlg).findByRole("button", { name: /Lidocaine/ }));
    expect(substance).toHaveValue("Lidocaine");
    expect(reaction).toHaveValue("Swelling");
    expect(within(dlg).getByRole("combobox")).toHaveTextContent("Moderate");
    expect(within(dlg).getByText(/Filled in from the clinic's allergen library/)).toBeInTheDocument();
    expect(within(dlg).queryByText(/New — will be added/)).not.toBeInTheDocument();
    // Editing the name again drops the "filled in" note.
    await user.type(substance, "x");
    expect(within(dlg).queryByText(/Filled in from/)).not.toBeInTheDocument();
    await user.clear(substance);
    await user.type(substance, "Lidocaine");
    await user.click(within(dlg).getByRole("button", { name: "Save" }));
    await waitFor(() => expect(patients.addAllergy).toHaveBeenCalledWith("pat_1", { substance: "Lidocaine", reaction: "Swelling", severity: "moderate" }));
    expect(clinical.createAllergen).not.toHaveBeenCalled();
  });

  test("REG-FE-PPROFILE-021 the library already having it is fine; the allergy is still recorded", async () => {
    clinical.createAllergen.mockRejectedValue(new AppError(409, "exists", "exists"));
    const { user } = page();
    await loaded();
    await user.click(within(section("Allergies")).getByRole("button", { name: /Add/ }));
    const dlg = await screen.findByRole("dialog", { name: "Add allergy" });
    await user.type(within(dlg).getAllByRole("textbox")[0], "Sulfa");
    await user.click(within(dlg).getByRole("button", { name: "Save" }));
    await waitFor(() => expect(patients.addAllergy).toHaveBeenCalledWith("pat_1", { substance: "Sulfa", reaction: "", severity: "mild" }));
    expect(clinical.createAllergen).toHaveBeenCalledWith("Sulfa", { default_reaction: undefined, default_severity: "mild" });
  });

  test("REG-FE-PPROFILE-022 recording the allergy fails: says so and keeps the dialog open; Cancel closes it", async () => {
    patients.addAllergy.mockRejectedValue(new Error("500"));
    const { user } = page();
    await loaded();
    await user.click(within(section("Allergies")).getByRole("button", { name: /Add/ }));
    const dlg = await screen.findByRole("dialog", { name: "Add allergy" });
    await user.type(within(dlg).getAllByRole("textbox")[0], "Sulfa");
    await user.click(within(dlg).getByRole("button", { name: "Save" }));
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith("Could not add allergy"));
    expect(screen.getByRole("dialog", { name: "Add allergy" })).toBeInTheDocument();
    await user.click(within(dlg).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
  });

  test("REG-FE-PPROFILE-023 add a condition: description, ICD-10 and status reach the API; the record refreshes", async () => {
    const { user } = page();
    await loaded();
    await user.click(within(section("Conditions")).getByRole("button", { name: /Add/ }));
    const dlg = await screen.findByRole("dialog", { name: "Add condition" });
    const save = within(dlg).getByRole("button", { name: "Save" });
    expect(save).toBeDisabled();
    const [desc, icd] = within(dlg).getAllByRole("textbox");
    await user.type(desc, "Asthma");
    await user.type(icd, "J45");
    await user.click(within(dlg).getByRole("combobox"));
    await user.click(await screen.findByRole("option", { name: "Inactive" }));
    await user.click(save);
    await waitFor(() => expect(patients.addCondition).toHaveBeenCalledWith("pat_1", { description: "Asthma", icd_code: "J45", status: "inactive" }));
    expect(toast.success).toHaveBeenCalledWith("Condition added");
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    await waitFor(() => expect(patients.getPatient).toHaveBeenCalledTimes(2));
  });

  test("REG-FE-PPROFILE-024 the condition dialog's Cancel closes it without saving", async () => {
    const { user } = page();
    await loaded();
    await user.click(within(section("Conditions")).getByRole("button", { name: /Add/ }));
    const dlg = await screen.findByRole("dialog", { name: "Add condition" });
    await user.click(within(dlg).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(patients.addCondition).not.toHaveBeenCalled();
  });

  test.fails("REG-FE-PPROFILE-025 KNOWN BUG NEW-PROF-7 a condition that fails to save must say so", async () => {
    // ConditionDialog's mutation (PatientProfilePage.tsx:624-634) has no onError:
    // a refused save leaves the dialog open with no message, and the user cannot
    // tell a dropped diagnosis from a slow one. The allergy dialog does toast.
    patients.addCondition.mockRejectedValue(new Error("500"));
    const { user } = page();
    await loaded();
    await user.click(within(section("Conditions")).getByRole("button", { name: /Add/ }));
    const dlg = await screen.findByRole("dialog", { name: "Add condition" });
    await user.type(within(dlg).getAllByRole("textbox")[0], "Asthma");
    await user.click(within(dlg).getByRole("button", { name: "Save" }));
    await waitFor(() => expect(patients.addCondition).toHaveBeenCalled());
    await waitFor(() => expect(toast.error).toHaveBeenCalled(), { timeout: 500 });
  });

  /* -------------------------------------------------------- edit details */

  test("REG-FE-PPROFILE-026 Edit details opens the edit dialog; saving refreshes the record; closing closes it", async () => {
    const { user } = page();
    await loaded();
    await user.click(screen.getByRole("button", { name: /Edit details/ }));
    expect(screen.getByRole("dialog", { name: "Edit patient" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "stub save" }));
    await waitFor(() => expect(patients.getPatient).toHaveBeenCalledTimes(2));
    await user.click(screen.getByRole("button", { name: "stub close" }));
    expect(screen.queryByRole("dialog", { name: "Edit patient" })).not.toBeInTheDocument();
  });

  /* ------------------------------------------------------------- lenses */

  test("REG-FE-PPROFILE-027 one lens (the desk): no switcher; billing, documents and certificates — no clinical panels", async () => {
    page();
    await loaded();
    expect(screen.queryByText("Reading as")).not.toBeInTheDocument();
    expect(await screen.findByText("Billing")).toBeInTheDocument();
    expect(screen.getByText("Documents")).toBeInTheDocument();
    expect(screen.getByText("certificates (issue: false)")).toBeInTheDocument();
    expect(screen.queryByText("Visit history")).not.toBeInTheDocument();
    expect(screen.queryByText(/story panel/)).not.toBeInTheDocument();
    expect(screen.queryByText("Observations")).not.toBeInTheDocument();
  });

  test("REG-FE-PPROFILE-028 no lens at all reads as the desk, without billing", async () => {
    auth.perms = new Set();
    page();
    await loaded();
    expect(screen.getByText("Documents")).toBeInTheDocument();
    expect(screen.queryByText("Billing")).not.toBeInTheDocument();
    expect(billing.patientCharges).not.toHaveBeenCalled();
  });

  test("REG-FE-PPROFILE-029 the care lens: observations, story, visit history, lab, documents, certificates the doctor can issue", async () => {
    auth.perms = new Set(["encounter.manage"]);
    page();
    await loaded();
    expect(screen.getByText("Observations")).toBeInTheDocument();
    expect(screen.getByText("story panel for pat_1")).toBeInTheDocument();
    expect(screen.getByText("Visit history")).toBeInTheDocument();
    expect(screen.getByText("Laboratory")).toBeInTheDocument();
    expect(screen.getByText("Documents")).toBeInTheDocument();
    expect(screen.getByText("certificates (issue: true)")).toBeInTheDocument();
    expect(screen.queryByText("Billing")).not.toBeInTheDocument();
    // Maternity is a flag, and only for a female patient.
    expect(screen.queryByText(/pregnancy dating/)).not.toBeInTheDocument();
  });

  test("REG-FE-PPROFILE-030 triage alone sees observations but not the story, history or lab", async () => {
    auth.perms = new Set(["triage.manage"]);
    page();
    await loaded();
    expect(screen.getByText("Observations")).toBeInTheDocument();
    expect(screen.queryByText(/story panel/)).not.toBeInTheDocument();
    expect(screen.queryByText("Visit history")).not.toBeInTheDocument();
    expect(screen.queryByText("Laboratory")).not.toBeInTheDocument();
  });

  test("REG-FE-PPROFILE-031 maternity clinic, female patient: the pregnancy dating card in the care lens", async () => {
    auth.perms = new Set(["triage.manage", "lab.order"]);
    auth.flags = new Set(["maternity"]);
    patients.getPatient.mockResolvedValue(patient({ gender: "female", first_name: "Almaz" }));
    page();
    await screen.findByRole("heading", { level: 2, name: /Almaz/ });
    expect(screen.getByText("pregnancy dating for pat_1")).toBeInTheDocument();
    expect(screen.getByText("Laboratory")).toBeInTheDocument();
  });

  test("REG-FE-PPROFILE-032 an owner holds all three lenses and can read the page as each", async () => {
    auth.perms = new Set(["encounter.manage", "billing.manage", "lab.manage"]);
    const { user } = page();
    await loaded();
    expect(screen.getByText("Reading as")).toBeInTheDocument();
    const care = screen.getByRole("button", { name: "Care" });
    expect(care.className).toMatch(/bg-brand/);
    expect(screen.getByText(/story panel/)).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Front desk" }));
    expect(await screen.findByText("Billing")).toBeInTheDocument();
    expect(screen.getByText("Visit history")).toBeInTheDocument();
    expect(screen.queryByText(/story panel/)).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Laboratory" }));
    expect(screen.getByRole("heading", { name: /Laboratory/ })).toBeInTheDocument();
    expect(screen.getByText("Observations")).toBeInTheDocument();
    expect(screen.getByText("Documents")).toBeInTheDocument();
    expect(screen.queryByText("Billing")).not.toBeInTheDocument();
    expect(screen.queryByText(/certificates/)).not.toBeInTheDocument();
  });

  /* ------------------------------------------------------------ billing */

  test("REG-FE-PPROFILE-033 billing: each charge with source, status and amount; a refund in red", async () => {
    billing.patientCharges.mockResolvedValue({ rows: [
      charge("c1", { receipt_no: 17 }),
      charge("c2", { status: "pending", source: "dental", amount: "1200.00" }),
      charge("c3", { status: "waived" }),
      charge("c4", { source: "refund", amount: "-300.00", receipt_no: 18 }),
    ] });
    page();
    await loaded();
    const b = await waitFor(() => section("Billing"));
    await within(b).findByText("Charge c1");
    expect(billing.patientCharges).toHaveBeenCalledWith("pat_1");
    const row = (id: string) => within(b).getByText(`Charge ${id}`).closest(".justify-between") as HTMLElement;
    expect(row("c1")).toHaveTextContent(/consultation.*paid.*ETB 300\.00/);
    expect(row("c2")).toHaveTextContent(/dental.*pending.*ETB 1200\.00/);
    expect(row("c3")).toHaveTextContent(/waived/);
    expect(within(row("c4")).getByText("ETB -300.00")).toHaveClass("text-rose-600");
    // Receipts only where one was issued; no refunds without billing.manage.
    expect(within(row("c1")).getByRole("button", { name: "Receipt" })).toBeInTheDocument();
    expect(within(row("c2")).queryByRole("button", { name: "Receipt" })).not.toBeInTheDocument();
    expect(within(b).queryByRole("button", { name: "Refund" })).not.toBeInTheDocument();
  });

  test("REG-FE-PPROFILE-034 no charges: says so", async () => {
    page();
    await loaded();
    expect(await screen.findByText("No charges yet.")).toBeInTheDocument();
  });

  test("REG-FE-PPROFILE-035 Receipt reprints with the clinic's name, the patient, and the cashier who settled it", async () => {
    billing.patientCharges.mockResolvedValue({ rows: [
      charge("c1", { receipt_no: 17, payment_method: "cash", settled_by: "Hiwot", settled_at: "2026-10-03T08:00:00Z" }),
      charge("c4", { source: "refund", amount: "-300.00", receipt_no: 18 }),
    ] });
    const { user } = page();
    await loaded();
    await waitFor(() => expect(admin.getClinic).toHaveBeenCalled());
    await waitFor(() => expect(within(section("Billing")).getAllByRole("button", { name: "Receipt" })).toHaveLength(2));
    const [r1, r2] = within(section("Billing")).getAllByRole("button", { name: "Receipt" });
    await waitFor(() => expect(admin.getClinic).toHaveBeenCalled());
    await screen.findByText("Charge c1");
    await new Promise((r) => setTimeout(r, 0));
    await user.click(r1);
    expect(print.printReceipt).toHaveBeenLastCalledWith({
      clinic: "Cure Dental", receiptNo: 17, patient: "Abebe Kebede Tesfaye", mrn: "MRN-42",
      description: "Charge c1", amount: "300.00", currency: "ETB", method: "cash", cashier: "Hiwot",
      when: "2026-10-03T08:00:00Z", refund: false,
    });
    await user.click(r2);
    expect(print.printReceipt).toHaveBeenLastCalledWith(expect.objectContaining({
      receiptNo: 18, refund: true, when: "2026-10-03T07:00:00Z", cashier: undefined,
    }));
  });

  test("REG-FE-PPROFILE-036 the clinic name unknown: the receipt says Clinic", async () => {
    admin.getClinic.mockRejectedValue(new Error("403"));
    billing.patientCharges.mockResolvedValue({ rows: [charge("c1", { receipt_no: 17 })] });
    const { user } = page();
    await loaded();
    await user.click(await screen.findByRole("button", { name: "Receipt" }));
    expect(print.printReceipt).toHaveBeenCalledWith(expect.objectContaining({ clinic: "Clinic" }));
  });

  test("REG-FE-PPROFILE-037 refund: only a paid, positive, non-refund charge; a reason is required; it reaches the API and refreshes", async () => {
    auth.perms = new Set(["billing.manage"]);
    billing.patientCharges.mockResolvedValue({ rows: [
      charge("c1"), charge("c2", { status: "pending" }), charge("c4", { source: "refund", amount: "-300.00" }),
      charge("c5", { amount: "-5.00" }),
    ] });
    const { user } = page();
    await loaded();
    await screen.findByText("Charge c1");
    const refunds = within(section("Billing")).getAllByRole("button", { name: "Refund" });
    expect(refunds).toHaveLength(1);
    await user.click(refunds[0]);
    const dlg = await screen.findByRole("dialog", { name: "Refund charge" });
    expect(within(dlg).getByText("Charge c1 · ETB 300.00")).toBeInTheDocument();
    const go = within(dlg).getByRole("button", { name: "Refund" });
    expect(go).toBeDisabled();
    await user.click(within(dlg).getByRole("combobox"));
    await user.click(await screen.findByRole("option", { name: "Duplicate payment" }));
    expect(go).toBeEnabled();
    await user.click(go);
    await waitFor(() => expect(billing.refundCharge).toHaveBeenCalledWith("c1", "Duplicate payment"));
    expect(toast.success).toHaveBeenCalledWith("Refund recorded");
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    await waitFor(() => expect(billing.patientCharges).toHaveBeenCalledTimes(2));
  });

  test("REG-FE-PPROFILE-038 a refused refund shows the server's reason; anything else a plain fallback; Cancel clears the reason", async () => {
    auth.perms = new Set(["billing.manage"]);
    billing.patientCharges.mockResolvedValue({ rows: [charge("c1")] });
    billing.refundCharge.mockRejectedValueOnce(new AppError(409, "already_refunded", "Already refunded"))
      .mockRejectedValueOnce(new Error("network"));
    const { user } = page();
    await loaded();
    await user.click(await screen.findByRole("button", { name: "Refund" }));
    let dlg = await screen.findByRole("dialog", { name: "Refund charge" });
    await user.click(within(dlg).getByRole("combobox"));
    await user.click(await screen.findByRole("option", { name: "Overcharged" }));
    await user.click(within(dlg).getByRole("button", { name: "Refund" }));
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith("Already refunded"));
    await user.click(within(dlg).getByRole("button", { name: "Refund" }));
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith("Could not refund"));
    expect(screen.getByRole("dialog", { name: "Refund charge" })).toBeInTheDocument();
    await user.click(within(dlg).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    // Reopened: the old reason is gone.
    await user.click(screen.getByRole("button", { name: "Refund" }));
    dlg = await screen.findByRole("dialog", { name: "Refund charge" });
    expect(within(dlg).getByRole("button", { name: "Refund" })).toBeDisabled();
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
  });

  test.fails("REG-FE-PPROFILE-039 KNOWN BUG NEW-PROF-8 a billing list that fails to load must not say No charges yet", async () => {
    // BillingSection (PatientProfilePage.tsx:315-317) reads q.data?.rows ?? [] with
    // no isError check: a failed load tells the cashier this patient owes nothing
    // (UX-1 pattern).
    billing.patientCharges.mockRejectedValue(new Error("502"));
    page();
    await loaded();
    await new Promise((r) => setTimeout(r, 50));
    expect(screen.queryByText("No charges yet.")).not.toBeInTheDocument();
  });

  /* ------------------------------------------------------ visit history */

  test("REG-FE-PPROFILE-040 visit history: the 5 most recent, All N expands, a visit opens read-only", async () => {
    auth.perms = new Set(["encounter.manage"]);
    clinical.listHistory.mockResolvedValue([
      visit("v1", { status: "open", primary_dx: "", provider_name: "" }),
      ...["v2", "v3", "v4", "v5", "v6", "v7"].map((id) => visit(id)),
    ]);
    const { user } = page();
    await loaded();
    const h = section("Visit history");
    expect(within(h).getByText("Loading…")).toBeInTheDocument();
    expect(await within(h).findByText("No diagnosis recorded")).toBeInTheDocument();
    expect(clinical.listHistory).toHaveBeenCalledWith("pat_1");
    expect(within(h).getByText("open")).toBeInTheDocument();
    expect(within(h).getByText("Dx v2").closest("button")).toHaveTextContent(/2026-09-20|EC · Dr Hana/);
    expect(within(h).queryByText("Dx v6")).not.toBeInTheDocument();
    await user.click(within(h).getByRole("button", { name: "All 7" }));
    expect(within(h).getByText("Dx v7")).toBeInTheDocument();
    await user.click(within(h).getByRole("button", { name: "Show recent" }));
    expect(within(h).queryByText("Dx v7")).not.toBeInTheDocument();
    await user.click(within(h).getByText("Dx v3"));
    expect(screen.getByRole("dialog", { name: "Visit record" })).toHaveTextContent("visit v3");
    await user.click(screen.getByRole("button", { name: "close visit" }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  test("REG-FE-PPROFILE-041 visit history empty: says so, with no expand button", async () => {
    auth.perms = new Set(["encounter.manage"]);
    page();
    await loaded();
    const h = section("Visit history");
    expect(await within(h).findByText("No recorded visits yet.")).toBeInTheDocument();
    expect(within(h).queryByRole("button", { name: /^All/ })).not.toBeInTheDocument();
  });

  test.fails("REG-FE-PPROFILE-042 KNOWN BUG NEW-PROF-9 visit history that fails to load must not say No recorded visits yet", async () => {
    // VisitHistorySection (PatientProfilePage.tsx:376-390) has no isError branch.
    auth.perms = new Set(["encounter.manage"]);
    clinical.listHistory.mockRejectedValue(new Error("502"));
    page();
    await loaded();
    await new Promise((r) => setTimeout(r, 50));
    expect(screen.queryByText("No recorded visits yet.")).not.toBeInTheDocument();
  });

  /* ---------------------------------------------------------- documents */

  test("REG-FE-PPROFILE-043 documents grouped by type, counted, opening in a new tab; none says so", async () => {
    patients.getPatient.mockResolvedValue(patient({ attachments: [
      { id: "d1", type: "image", url: "https://f/d1", filename: "smile.jpg", created_at: "2026-09-01T08:00:00Z" },
      { id: "d2", type: "scan", url: "https://f/d2", filename: "opg.png", created_at: "2026-09-02T08:00:00Z" },
      { id: "d3", type: "report", url: "https://f/d3", filename: "referral.pdf", created_at: "2026-09-03T08:00:00Z" },
      { id: "d4", type: "pdf", url: "https://f/d4", filename: "consent.pdf", created_at: "2026-09-04T08:00:00Z" },
      { id: "d5", type: "pdf", url: "https://f/d5", filename: "id.pdf", created_at: "2026-09-04T08:00:00Z" },
      { id: "d6", type: "audio", url: "https://f/d6", filename: "note.m4a", created_at: "2026-09-05T08:00:00Z" },
    ] }));
    page();
    await loaded();
    const d = section("Documents (6)");
    const groups = [...d.querySelectorAll("p.uppercase")].map((p) => p.textContent);
    expect(groups).toEqual(["Images (1)", "Scans & X-rays (1)", "Reports (1)", "Documents (2)", "Other (1)"]);
    const link = within(d).getByRole("link", { name: /opg\.png/ });
    expect(link).toHaveAttribute("href", "https://f/d2");
    expect(link).toHaveAttribute("target", "_blank");
    expect(link).toHaveAttribute("rel", "noreferrer");
  });

  test("REG-FE-PPROFILE-044 no documents: says so", async () => {
    page();
    await loaded();
    expect(screen.getByText("No documents uploaded.")).toBeInTheDocument();
  });

  /* --------------------------------------------------------------- age */

  test.fails("REG-FE-PPROFILE-045 KNOWN BUG NEW-PROF-1 on the patient's birthday in Addis the banner shows the new age", async () => {
    // age() (PatientProfilePage.tsx:41-46) parses the DOB as UTC midnight and counts
    // elapsed UTC time, so from 00:00 to 03:00 Addis time on a birthday the banner is
    // still a year short (25y for a patient turning 26). Every other screen uses
    // lib/utils ageYears (calendar arithmetic) and disagrees with this one.
    vi.setSystemTime(new Date("2026-10-03T00:20:00+03:00"));
    patients.getPatient.mockResolvedValue(patient({ dob: "2000-10-03" }));
    page();
    await loaded();
    expect(screen.getByText(/^MRN MRN-42/).textContent).toContain(" · 26y");
  });

  test("REG-FE-PPROFILE-046 age at midday on an ordinary day", async () => {
    patients.getPatient.mockResolvedValue(patient({ dob: "2000-10-01" }));
    page();
    await loaded();
    expect(screen.getByText(/^MRN MRN-42/).textContent).toContain(" · 26y");
  });
});
