// Settings as a dental clinic uses it: account and workspace, clinic profile and
// plan usage, visit flow, payment methods, the drug library, and the clinic's own
// procedures and tooth conditions. Plus the general-clinic panes reachable by URL.
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, test, vi } from "vitest";

// Whole-page flows with many clicks; the shared 5s budget is too tight when the full
// suite runs in parallel (and under scripts/test/time-sweep.sh).
vi.setConfig({ testTimeout: 60_000 });

vi.mock("@/app/auth-context", async () => (await import("@/test/admin")).authModule);
vi.mock("@/components/ui/sonner", async (orig) => ({ ...(await orig<object>()), toast: (await import("@/test/admin")).toastSpy }));
const admin = vi.hoisted(() => ({
  getClinic: vi.fn(), saveClinic: vi.fn(), getWorkspace: vi.fn(), updateWorkspace: vi.fn(), planUsage: vi.fn(),
  listBranches: vi.fn(), createBranch: vi.fn(), updateBranch: vi.fn(), deleteBranch: vi.fn(), branchUsage: vi.fn(),
  getBranchModules: vi.fn(), setBranchModules: vi.fn(), listDepartments: vi.fn(), createDepartment: vi.fn(),
  updateDepartment: vi.fn(), deleteDepartment: vi.fn(), getSettings: vi.fn(), saveSettings: vi.fn(),
  listPaymentRails: vi.fn(), createPaymentRail: vi.fn(), updatePaymentRail: vi.fn(), deletePaymentRail: vi.fn(),
}));
vi.mock("@/features/admin/api", async (orig) => ({ ...(await orig<object>()), ...admin }));
const dental = vi.hoisted(() => ({
  listProcedures: vi.fn(), createProcedure: vi.fn(), updateProcedure: vi.fn(), deleteProcedure: vi.fn(), reorderProcedures: vi.fn(),
  listToothStatuses: vi.fn(), createToothStatus: vi.fn(), updateToothStatus: vi.fn(), deleteToothStatus: vi.fn(), reorderToothStatuses: vi.fn(),
}));
vi.mock("@/features/dental/api", async (orig) => ({ ...(await orig<object>()), ...dental }));
const auth = vi.hoisted(() => ({ changeEmailApi: vi.fn(), changePasswordApi: vi.fn(), signOutOtherDevicesApi: vi.fn() }));
vi.mock("@/features/auth/api", async (orig) => ({ ...(await orig<object>()), ...auth }));
const clin = vi.hoisted(() => ({
  getVitalFields: vi.fn(), saveVitalFields: vi.fn(), listAllergens: vi.fn(), deleteAllergen: vi.fn(), createAllergen: vi.fn(),
  searchDrugs: vi.fn(), createDrug: vi.fn(), updateDrug: vi.fn(), deleteDrug: vi.fn(),
  listDiagnosisCategories: vi.fn(), searchCatalog: vi.fn(), createCategory: vi.fn(), updateCategory: vi.fn(), deleteCategory: vi.fn(),
  createCatalogEntry: vi.fn(), updateCatalogEntry: vi.fn(), deleteCatalogEntry: vi.fn(),
}));
vi.mock("@/features/clinical/api", async (orig) => ({ ...(await orig<object>()), ...clin }));

import { SettingsPage } from "@/features/admin/pages/SettingsPage";
import { AppError } from "@/lib/api-client";
import { authFns, OWNER_PERMS, resetToasts, setAuth, toastSpy } from "@/test/admin";
import { currentLocation, renderUI } from "@/test/render";

const open = (section?: string) => renderUI(<SettingsPage />, { route: section ? `/settings?section=${section}` : "/settings" });
/** The four password boxes on the account pane, in order: email-confirm, current, new, confirm. */
const pw = (i: number) => document.querySelectorAll<HTMLInputElement>("input[type=password]")[i];
const rail = () => screen.getByRole("heading", { name: "Settings" }).parentElement!.querySelector("nav")!;

const RAILS = [
  { id: "r1", key: "cash", label: "Cash", kind: "cash", needs_reference: false, active: true, sort_order: 1 },
  { id: "r2", key: "mobile", label: "Mobile money", kind: "wallet", needs_reference: false, active: true, sort_order: 2 },
  { id: "r3", key: "cbe", label: "CBE", kind: "bank", bank_key: "cbe", account_number: "1000123", needs_reference: true, active: false, sort_order: 3 },
];

beforeEach(() => {
  setAuth();
  resetToasts();
  for (const m of [admin, dental, auth, clin]) for (const f of Object.values(m)) f.mockResolvedValue(undefined);
  admin.getClinic.mockResolvedValue({ name: "Cure Dental", timezone: "Africa/Addis_Ababa", locale: "en" });
  admin.getWorkspace.mockResolvedValue({ name: "Cure Dental", slug: "cure" });
  admin.updateWorkspace.mockResolvedValue({ name: "Cure Dental", slug: "cure-bole" });
  admin.planUsage.mockResolvedValue({
    plan_name: "Chair", features: [],
    patients: { used: 950, limit: 1000 }, storage: { used: 3 * 1024 ** 3, limit: 5 * 1024 ** 3 },
    users: { used: 4, limit: -1 }, branches: { used: 1, limit: 0 },
  });
  admin.getSettings.mockResolvedValue({ card_fee_enabled: true, card_fee_amount: "100", card_currency: "", free_window_days: 14, triage_required: true, doctor_assignment: "manual" });
  admin.listPaymentRails.mockResolvedValue(RAILS);
  admin.listBranches.mockResolvedValue([]);
  admin.listDepartments.mockResolvedValue([]);
  admin.branchUsage.mockResolvedValue({ used: 0, limit: null });
  admin.getBranchModules.mockResolvedValue([]);
  auth.signOutOtherDevicesApi.mockResolvedValue({ revoked: 2 });
  dental.listProcedures.mockResolvedValue([
    { id: "p1", name: "Scaling", is_active: true, sort_order: 1 },
    { id: "p2", name: "Root canal", is_active: true, sort_order: 2 },
    { id: "p3", name: "Dentures", is_active: false, sort_order: 3 },
  ]);
  dental.listToothStatuses.mockResolvedValue([
    { id: "t1", code: "healthy", label: "Healthy", color: "#0a7c59", is_active: true },
    { id: "t2", code: "decayed", label: "Decayed", color: "#c0392b", is_active: true },
    { id: "t3", code: "implant", label: "Implant", color: "#555555", is_active: false },
  ]);
  clin.listAllergens.mockResolvedValue([
    { id: "a1", name: "Penicillin", is_active: true, default_reaction: "Rash", default_severity: "severe" },
    { id: "a2", name: "Latex", is_active: false },
  ]);
  clin.searchDrugs.mockResolvedValue([
    { id: "d1", name: "Amoxicillin 500mg", default_dose: "1 cap", default_frequency: "tds", default_duration: "5 days", is_active: true, allergens: ["Penicillin"] },
    { id: "d2", name: "Ibuprofen", is_active: false, allergens: [] },
  ]);
  clin.getVitalFields.mockResolvedValue([
    { key: "bp_sys", label: "Systolic", unit: "mmHg", decimals: 0, enabled: true, required: true, order: 1, min: 50, low: 90, high: 140, max: 260 },
    { key: "temp", label: "Temp", unit: "°C", decimals: 1, enabled: false, required: false, order: 2 },
  ]);
  clin.listDiagnosisCategories.mockResolvedValue([
    { id: "c1", name: "Respiratory", sort_order: 1, is_active: true },
    { id: "c2", name: "Skin", sort_order: 2, is_active: false },
  ]);
  clin.searchCatalog.mockResolvedValue([
    { id: "e1", category_id: "c1", category_name: "Respiratory", code: "J02.9", name: "Pharyngitis", is_active: true },
    { id: "e2", category_id: "c1", category_name: "Respiratory", name: "Cough", is_active: true },
  ]);
});

describe("REG-FE-SETTINGS sections", () => {
  test("REG-FE-SETTINGS-001 a dental clinic's rail: its procedures and tooth conditions; no vitals, no diagnosis catalog, no branches", () => {
    open();
    const items = within(rail()).getAllByRole("button").map((b) => b.textContent);
    expect(items).toEqual(["Account & security", "Clinic profile", "Printing", "Visit flow", "Payment methods", "Drugs & allergens", "Dental procedures", "Tooth conditions"]);
  });

  test("REG-FE-SETTINGS-002 a general clinic's rail has vitals and diagnoses, not dental", () => {
    setAuth({ flags: [] });
    open();
    const items = within(rail()).getAllByRole("button").map((b) => b.textContent);
    expect(items).toEqual(["Account & security", "Clinic profile", "Printing", "Visit flow", "Payment methods", "Vitals form", "Diagnosis catalog", "Drugs & allergens"]);
  });

  test("REG-FE-SETTINGS-003 a section is in the URL so a prompt elsewhere can link straight to it", async () => {
    const { user } = open("payments");
    expect(await screen.findByText("Payment methods", { selector: "h3,div" })).toBeInTheDocument();
    await user.click(within(rail()).getByRole("button", { name: "Tooth conditions" }));
    expect(currentLocation()).toBe("/settings?section=toothconditions");
    await user.click(within(rail()).getByRole("button", { name: "Account & security" }));
    expect(currentLocation()).toBe("/settings");
  });
});

describe("REG-FE-SETTINGS account & security", () => {
  test("REG-FE-SETTINGS-010 change email: needs a new address and the password; refreshes the session", async () => {
    const { user } = open();
    expect(screen.getByText("owner@cure.et")).toBeInTheDocument();
    const btn = screen.getByRole("button", { name: "Update email" });
    expect(btn).toBeDisabled();
    await user.type(screen.getByPlaceholderText("you@clinic.com"), "owner@cure.et");
    await user.type(pw(0), "pw");
    expect(btn).toBeDisabled(); // same address
    await user.clear(screen.getByPlaceholderText("you@clinic.com"));
    await user.type(screen.getByPlaceholderText("you@clinic.com"), " new@cure.et ");
    await user.click(btn);
    await waitFor(() => expect(auth.changeEmailApi).toHaveBeenCalledWith({ new_email: "new@cure.et", current_password: "pw" }));
    await waitFor(() => expect(authFns.refresh).toHaveBeenCalled());
    expect(toastSpy.success).toHaveBeenCalledWith("Email updated — sign in with it next time");
    expect(screen.getByPlaceholderText("you@clinic.com")).toHaveValue("");
  });

  test("REG-FE-SETTINGS-011 change password: 8+ characters, the two must match; a wrong current password is said", async () => {
    auth.changePasswordApi.mockRejectedValueOnce(new AppError(401, "BAD_PASSWORD", "Current password is wrong"));
    const { user } = open();
    const btn = screen.getByRole("button", { name: "Update password" });
    await user.type(pw(1), "old");
    await user.type(pw(2), "newpass12");
    await user.type(pw(3), "newpass1");
    expect(screen.getByText("The new passwords don't match.")).toBeInTheDocument();
    expect(btn).toBeDisabled();
    await user.type(pw(3), "2");
    await user.click(btn);
    await waitFor(() => expect(toastSpy.error).toHaveBeenCalledWith("Current password is wrong"));
    await user.click(btn);
    await waitFor(() => expect(toastSpy.success).toHaveBeenCalledWith("Password updated — other devices have been signed out"));
    expect(auth.changePasswordApi).toHaveBeenLastCalledWith({ current_password: "old", new_password: "newpass12" });
    expect(pw(2)).toHaveValue("");
  });

  test("REG-FE-SETTINGS-012 sign out other devices: how many, none, or why not", async () => {
    const { user } = open();
    const btn = screen.getByRole("button", { name: "Sign out all other devices" });
    await user.click(btn);
    await waitFor(() => expect(toastSpy.success).toHaveBeenCalledWith("Signed out 2 other devices"));
    auth.signOutOtherDevicesApi.mockResolvedValueOnce({ revoked: 1 });
    await user.click(btn);
    await waitFor(() => expect(toastSpy.success).toHaveBeenCalledWith("Signed out 1 other device"));
    auth.signOutOtherDevicesApi.mockResolvedValueOnce({ revoked: 0 });
    await user.click(btn);
    await waitFor(() => expect(toastSpy.success).toHaveBeenCalledWith("No other devices were signed in"));
    auth.signOutOtherDevicesApi.mockRejectedValueOnce(new Error("offline"));
    await user.click(btn);
    await waitFor(() => expect(toastSpy.error).toHaveBeenCalledWith("offline"));
  });

  test("REG-FE-SETTINGS-013 workspace: shows the handle, lowercases a change, and reports a taken one", async () => {
    const { user } = open();
    const input = screen.getByPlaceholderText("my-clinic");
    await waitFor(() => expect(input).toHaveValue("cure"));
    const btn = screen.getByRole("button", { name: "Update" });
    expect(btn).toBeDisabled();
    await user.clear(input);
    await user.type(input, "Cure-Bole");
    await user.click(btn);
    await waitFor(() => expect(admin.updateWorkspace).toHaveBeenCalledWith({ slug: "cure-bole" }));
    expect(toastSpy.success).toHaveBeenCalledWith("Workspace updated");
    admin.updateWorkspace.mockRejectedValueOnce(new AppError(409, "TAKEN", "That workspace is taken"));
    await user.clear(input);
    await user.type(input, "other");
    await user.click(btn);
    await waitFor(() => expect(toastSpy.error).toHaveBeenCalledWith("That workspace is taken"));
  });

  test("REG-FE-SETTINGS-014 every account error has a fallback sentence", async () => {
    for (const f of [auth.changeEmailApi, auth.changePasswordApi, auth.signOutOtherDevicesApi, admin.updateWorkspace]) f.mockRejectedValue("x");
    const { user } = open();
    await user.type(screen.getByPlaceholderText("you@clinic.com"), "a@b.co");
    await user.type(pw(0), "p");
    await user.click(screen.getByRole("button", { name: "Update email" }));
    await user.type(pw(1), "p");
    await user.type(pw(2), "12345678");
    await user.click(screen.getByRole("button", { name: "Update password" }));
    await user.click(screen.getByRole("button", { name: "Sign out all other devices" }));
    await user.type(screen.getByPlaceholderText("my-clinic"), "x");
    await user.click(screen.getByRole("button", { name: "Update" }));
    await waitFor(() => expect(toastSpy.error.mock.calls.map((c) => c[0])).toEqual(expect.arrayContaining([
      "Could not update the email", "Could not update the password", "Could not sign out other devices", "Could not update the workspace",
    ])));
  });
});

describe("REG-FE-SETTINGS clinic profile and plan", () => {
  test("REG-FE-SETTINGS-020 rename the clinic; usage bars for patients, storage, staff, branches", async () => {
    const { user } = open("profile");
    const name = await screen.findByDisplayValue("Cure Dental");
    expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();
    expect(await screen.findByText("Plan & usage — Chair")).toBeInTheDocument();
    expect(screen.getByText("950 / 1,000")).toBeInTheDocument();
    expect(screen.getByText("3.0 GB / 5.0 GB")).toBeInTheDocument();
    expect(screen.getByText("4")).toBeInTheDocument(); // unlimited staff: no "/ limit"
    expect(screen.getByText("1 / 0")).toBeInTheDocument();
    await user.clear(name);
    await user.type(name, "Cure Dental Bole");
    await user.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(admin.saveClinic).toHaveBeenCalledWith({ name: "Cure Dental Bole" }));
    expect(toastSpy.success).toHaveBeenCalledWith("Clinic profile saved");
    admin.saveClinic.mockRejectedValueOnce(new Error("Name too long"));
    await user.type(name, "!");
    await user.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(toastSpy.error).toHaveBeenCalledWith("Name too long"));
    admin.saveClinic.mockRejectedValueOnce("x");
    await user.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(toastSpy.error).toHaveBeenCalledWith("Could not save the clinic profile"));
  });

  test("REG-FE-SETTINGS-021 without clinic.manage the name is read-only; usage says loading until it arrives", async () => {
    setAuth({ perms: ["user.read"] });
    admin.planUsage.mockReturnValue(new Promise(() => {}));
    admin.planUsage.mockReturnValueOnce(Promise.resolve({ plan_name: "S", features: [], patients: { used: 500, limit: 1000 }, storage: { used: 100, limit: -1 }, users: { used: 1, limit: 1 }, branches: { used: 0, limit: 1 } }));
    open("profile");
    expect(await screen.findByDisplayValue("Cure Dental")).toBeDisabled();
    expect(screen.queryByRole("button", { name: "Save" })).not.toBeInTheDocument();
    expect(await screen.findByText("100 B")).toBeInTheDocument();
  });

  test("REG-FE-SETTINGS-022 plan usage shows loading before the numbers", () => {
    admin.planUsage.mockReturnValue(new Promise(() => {}));
    open("profile");
    expect(screen.getByText("Loading…")).toBeInTheDocument();
  });
});

describe("REG-FE-SETTINGS visit flow", () => {
  test("REG-FE-SETTINGS-030 dental: no triage switch; free window and assignment save", async () => {
    const { user } = open("flow");
    const days = await screen.findByDisplayValue("14");
    expect(screen.queryByText("Triage step")).not.toBeInTheDocument();
    await user.clear(days);
    await user.type(days, "30");
    await user.click(screen.getAllByRole("combobox")[0]);
    await user.click(await screen.findByRole("option", { name: "Auto (next available)" }));
    await user.click(screen.getByRole("button", { name: "Save flow settings" }));
    await waitFor(() => expect(admin.saveSettings).toHaveBeenCalledWith({
      card_fee_enabled: true, card_fee_amount: 100, card_currency: "ETB", free_window_days: 30, triage_required: true, doctor_assignment: "auto",
    }));
    expect(toastSpy.success).toHaveBeenCalledWith("Flow settings saved");
    admin.saveSettings.mockRejectedValueOnce(new Error("x"));
    await user.click(screen.getByRole("button", { name: "Save flow settings" }));
    await waitFor(() => expect(toastSpy.error).toHaveBeenCalledWith("Could not save settings"));
  });

  test("REG-FE-SETTINGS-031 general clinic: triage can be made optional", async () => {
    setAuth({ flags: [] });
    admin.getSettings.mockResolvedValue({ card_fee_enabled: false, card_fee_amount: "x", card_currency: "USD", free_window_days: 7, triage_required: false, doctor_assignment: "manual" });
    const { user } = open("flow");
    await screen.findByText("Triage step");
    await user.click(screen.getAllByRole("combobox")[0]);
    await user.click(await screen.findByRole("option", { name: "Required (default)" }));
    await user.click(screen.getByRole("button", { name: "Save flow settings" }));
    await waitFor(() => expect(admin.saveSettings).toHaveBeenCalledWith(expect.objectContaining({ triage_required: true, card_fee_amount: 0, card_currency: "USD" })));
  });

  test("REG-FE-SETTINGS-032 loading, and the settings not existing yet", async () => {
    admin.getSettings.mockReturnValueOnce(new Promise(() => {}));
    const r = open("flow");
    // The flow pane now holds two cards (patient flow, registration fee); the
    // patient-flow card is the one whose settings are still loading.
    const cardOf = (el: HTMLElement) => {
      let n: HTMLElement | null = el;
      while (n && !n.textContent?.includes("Patient flow")) n = n.parentElement;
      return n;
    };
    expect(screen.getAllByText("Loading…").some((el) => cardOf(el)?.textContent?.includes("Card fee, triage, and doctor assignment."))).toBe(true);
    r.unmount();
    admin.getSettings.mockRejectedValueOnce(new Error("404"));
    open("flow");
    expect(await screen.findByText("Save the clinic profile first to configure the flow.")).toBeInTheDocument();
  });

  test("REG-FE-SETTINGS-033 without clinic.manage nothing is editable and there is no save", async () => {
    setAuth({ perms: [] });
    open("flow");
    expect(await screen.findByDisplayValue("14")).toBeDisabled();
    expect(screen.queryByRole("button", { name: "Save flow settings" })).not.toBeInTheDocument();
  });
});

describe("REG-FE-SETTINGS payment methods", () => {
  test("REG-FE-SETTINGS-040 the list: kind, account, reference, off; generic wallets are flagged", async () => {
    open("payments");
    expect(await screen.findByText("Mobile money")).toBeInTheDocument();
    expect(screen.getByText("Mobile wallet")).toBeInTheDocument();
    expect(screen.getByText("Bank transfer")).toBeInTheDocument();
    expect(screen.getByText("1000123")).toBeInTheDocument();
    expect(screen.getByText("no account named")).toBeInTheDocument();
    expect(screen.getByText("reference required")).toBeInTheDocument();
    expect(screen.getByText("off")).toBeInTheDocument();
    expect(screen.getByText("Name your accounts.")).toBeInTheDocument();
  });

  test("REG-FE-SETTINGS-041 switch a method on/off; a refusal is said", async () => {
    const { user } = open("payments");
    await screen.findByText("CBE");
    await user.click(screen.getByRole("button", { name: "Switch on" }));
    await waitFor(() => expect(admin.updatePaymentRail).toHaveBeenCalledWith("r3", expect.objectContaining({ active: true, label: "CBE" })));
    admin.updatePaymentRail.mockRejectedValueOnce(new AppError(409, "IN_USE", "Cash cannot be switched off"));
    await user.click(screen.getAllByRole("button", { name: "Switch off" })[0]);
    await waitFor(() => expect(toastSpy.error).toHaveBeenCalledWith("Cash cannot be switched off"));
    admin.updatePaymentRail.mockRejectedValueOnce("x");
    await user.click(screen.getAllByRole("button", { name: "Switch off" })[0]);
    await waitFor(() => expect(toastSpy.error).toHaveBeenCalledWith("Could not change it"));
  });

  test("REG-FE-SETTINGS-042 remove asks first, then removes", async () => {
    const { user } = open("payments");
    await screen.findByText("CBE");
    await user.click(screen.getAllByRole("button", { name: "Remove" })[2]);
    const dlg = screen.getByRole("dialog", { name: /Remove CBE\?/ });
    await user.click(within(dlg).getByRole("button", { name: "Remove" }));
    await waitFor(() => expect(admin.deletePaymentRail).toHaveBeenCalledWith("r3"));
    expect(toastSpy.success).toHaveBeenCalledWith("Removed");
    // The refusal path ("it has taken payments") is not exercised here: the confirm
    // dialog re-throws the failed action into nowhere (NEW-CONFIRM-1), which Vitest
    // rightly reports as an unhandled rejection.
  });

  test("REG-FE-SETTINGS-043 add a Telebirr wallet: provider required, number, reference switch", async () => {
    const { user } = open("payments");
    await screen.findByText("CBE");
    await user.click(screen.getByRole("button", { name: /Add/ }));
    const dlg = screen.getByRole("dialog", { name: "Add a payment method" });
    expect(within(dlg).getByText(/paid to a phone number/)).toBeInTheDocument();
    await user.type(within(dlg).getByLabelText("Name it"), "Telebirr");
    const save = within(dlg).getByRole("button", { name: "Save" });
    expect(save).toBeDisabled(); // no provider yet
    await user.click(within(dlg).getByLabelText("Provider"));
    await user.click(await screen.findByRole("option", { name: "Telebirr" }));
    await user.type(within(dlg).getByLabelText("Phone number"), "0911223344");
    await user.type(within(dlg).getByLabelText(/Account name/), "Cure Dental");
    await user.click(within(dlg).getByRole("checkbox"));
    await user.click(save);
    await waitFor(() => expect(admin.createPaymentRail).toHaveBeenCalledWith({
      label: "Telebirr", kind: "wallet", bank_key: "telebirr", account_name: "Cure Dental", account_number: "0911223344",
      needs_reference: false, active: true, sort_order: 10,
    }));
    expect(toastSpy.success).toHaveBeenCalledWith("Payment method added");
  });

  test("REG-FE-SETTINGS-044 edit: switching to cash drops the account; bank asks for an account number; errors said", async () => {
    const { user } = open("payments");
    await screen.findByText("CBE");
    await user.click(screen.getAllByRole("button", { name: "Edit" })[2]);
    const dlg = screen.getByRole("dialog", { name: "Edit payment method" });
    expect(within(dlg).getByLabelText("Account number")).toHaveValue("1000123");
    admin.updatePaymentRail.mockRejectedValueOnce(new AppError(422, "V", "Bad account"));
    await user.click(within(dlg).getByRole("button", { name: "Save" }));
    await waitFor(() => expect(toastSpy.error).toHaveBeenCalledWith("Bad account"));
    await user.click(within(dlg).getByLabelText("Kind"));
    await user.click(await screen.findByRole("option", { name: "Cash" }));
    expect(within(dlg).queryByLabelText("Provider")).not.toBeInTheDocument();
    admin.updatePaymentRail.mockRejectedValueOnce("x");
    await user.click(within(dlg).getByRole("button", { name: "Save" }));
    await waitFor(() => expect(toastSpy.error).toHaveBeenCalledWith("Could not save it"));
    await user.click(within(dlg).getByRole("button", { name: "Save" }));
    await waitFor(() => expect(admin.updatePaymentRail).toHaveBeenLastCalledWith("r3", expect.objectContaining({
      kind: "cash", bank_key: "", account_number: "", account_name: "", needs_reference: false, active: false, sort_order: 3,
    })));
    expect(toastSpy.success).toHaveBeenCalledWith("Saved");
  });

  test("REG-FE-SETTINGS-045 empty list, loading, and read-only staff", async () => {
    admin.listPaymentRails.mockReturnValueOnce(new Promise(() => {}));
    const a = open("payments");
    expect(screen.getByText("Loading…")).toBeInTheDocument();
    a.unmount();
    admin.listPaymentRails.mockResolvedValueOnce([]);
    const b = open("payments");
    expect(await screen.findByText("No payment methods yet.")).toBeInTheDocument();
    b.unmount();
    setAuth({ perms: [] });
    open("payments");
    await screen.findByText("CBE");
    expect(screen.queryByRole("button", { name: "Edit" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Add/ })).not.toBeInTheDocument();
  });

  test("REG-FE-SETTINGS-046 cancel closes the method dialog without saving", async () => {
    const { user } = open("payments");
    await screen.findByText("CBE");
    await user.click(screen.getByRole("button", { name: /Add/ }));
    await user.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(admin.createPaymentRail).not.toHaveBeenCalled();
  });
});

describe("REG-FE-SETTINGS dental procedures", () => {
  test("REG-FE-SETTINGS-050 add by button or Enter, rename, retire, bring back, remove", async () => {
    const { user, qc } = open("procedures");
    const inv = vi.spyOn(qc, "invalidateQueries");
    expect(await screen.findByText("Scaling")).toBeInTheDocument();
    expect(screen.getByText("retired")).toBeInTheDocument();
    const box = screen.getByPlaceholderText(/Add a procedure/);
    await user.type(box, "Implant placement");
    await user.click(screen.getByRole("button", { name: "Add" }));
    await waitFor(() => expect(dental.createProcedure).toHaveBeenCalledWith("Implant placement"));
    expect(box).toHaveValue("");
    await user.type(box, "Veneer{Enter}");
    await waitFor(() => expect(dental.createProcedure).toHaveBeenCalledWith("Veneer"));
    await waitFor(() => expect(inv).toHaveBeenCalledWith({ queryKey: ["dental-procedures"] }));

    const scaling = screen.getByText("Scaling").closest("li")!;
    await user.click(within(scaling).getByRole("button", { name: "Rename" }));
    const edit = screen.getByDisplayValue("Scaling");
    await user.clear(edit);
    await user.type(edit, "Scaling & polish");
    await user.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(dental.updateProcedure).toHaveBeenCalledWith("p1", { name: "Scaling & polish" }));

    await user.click(within(screen.getByText("Root canal").closest("li")!).getByRole("button", { name: "Retire" }));
    await waitFor(() => expect(dental.updateProcedure).toHaveBeenCalledWith("p2", { name: "Root canal", is_active: false }));
    await user.click(within(screen.getByText("Dentures").closest("li")!).getByRole("button", { name: "Bring back" }));
    await waitFor(() => expect(dental.updateProcedure).toHaveBeenCalledWith("p3", { name: "Dentures", is_active: true }));
    await user.click(within(screen.getByText("Dentures").closest("li")!).getByRole("button", { name: "Remove" }));
    await waitFor(() => expect(dental.deleteProcedure).toHaveBeenCalledWith("p3"));
  });

  test("REG-FE-SETTINGS-051 reorder: up and down swap neighbours; the ends do nothing", async () => {
    const { user } = open("procedures");
    await screen.findByText("Scaling");
    await user.click(within(screen.getByText("Root canal").closest("li")!).getByTitle("Move up"));
    await waitFor(() => expect(dental.reorderProcedures).toHaveBeenCalledWith(["p2", "p1", "p3"]));
    await user.click(within(screen.getByText("Scaling").closest("li")!).getByTitle("Move up"));
    await user.click(within(screen.getByText("Dentures").closest("li")!).getByTitle("Move down"));
    expect(dental.reorderProcedures).toHaveBeenCalledTimes(1);
    await user.click(within(screen.getByText("Scaling").closest("li")!).getByTitle("Move down"));
    await waitFor(() => expect(dental.reorderProcedures).toHaveBeenLastCalledWith(["p2", "p1", "p3"]));
  });

  test("REG-FE-SETTINGS-052 a refused change shows the server's reason; cancel leaves the name", async () => {
    dental.deleteProcedure.mockRejectedValueOnce(new Error("Used by 3 open plans"));
    const { user } = open("procedures");
    await screen.findByText("Scaling");
    await user.click(within(screen.getByText("Scaling").closest("li")!).getByRole("button", { name: "Remove" }));
    expect(await screen.findByText("Used by 3 open plans")).toBeInTheDocument();
    await user.click(within(screen.getByText("Scaling").closest("li")!).getByRole("button", { name: "Rename" }));
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(dental.updateProcedure).not.toHaveBeenCalled();
    // A later success clears the error.
    await user.click(within(screen.getByText("Scaling").closest("li")!).getByRole("button", { name: "Retire" }));
    await waitFor(() => expect(screen.queryByText("Used by 3 open plans")).not.toBeInTheDocument());
  });

  test("REG-FE-SETTINGS-053 loading, empty, and read-only", async () => {
    dental.listProcedures.mockReturnValueOnce(new Promise(() => {}));
    const a = open("procedures");
    expect(screen.getByText("Loading…")).toBeInTheDocument();
    a.unmount();
    dental.listProcedures.mockResolvedValueOnce([]);
    const b = open("procedures");
    expect(await screen.findByText("No procedures yet.")).toBeInTheDocument();
    b.unmount();
    setAuth({ perms: [] });
    open("procedures");
    await screen.findByText("Scaling");
    expect(screen.queryByPlaceholderText(/Add a procedure/)).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Rename" })).not.toBeInTheDocument();
  });
});

describe("REG-FE-SETTINGS tooth conditions", () => {
  test("REG-FE-SETTINGS-060 add with a colour, edit label and colour, retire, bring back, remove, reorder", async () => {
    const { user } = open("toothconditions");
    expect(await screen.findByText("Healthy")).toBeInTheDocument();
    const box = screen.getByPlaceholderText(/Add a condition/);
    const [colour] = screen.getAllByLabelText("Colour");
    // input[type=color] — set directly.
    fireEvent.change(colour, { target: { value: "#123456" } });
    await user.type(box, "Root treated");
    await user.click(screen.getByRole("button", { name: "Add" }));
    await waitFor(() => expect(dental.createToothStatus).toHaveBeenCalledWith("Root treated", "#123456"));
    await user.type(box, "Bridge{Enter}");
    await waitFor(() => expect(dental.createToothStatus).toHaveBeenCalledWith("Bridge", "#123456"));

    const decayed = () => screen.getByText("Decayed").closest("li")!;
    await user.click(within(decayed()).getByRole("button", { name: "Edit" }));
    const label = screen.getByDisplayValue("Decayed");
    await user.clear(label);
    await user.type(label, "Caries");
    fireEvent.change(screen.getAllByLabelText("Colour")[1], { target: { value: "#ff0000" } });
    await user.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(dental.updateToothStatus).toHaveBeenCalledWith("t2", { label: "Caries", color: "#ff0000" }));

    await user.click(within(screen.getByText("Healthy").closest("li")!).getByRole("button", { name: "Retire" }));
    await waitFor(() => expect(dental.updateToothStatus).toHaveBeenCalledWith("t1", { label: "Healthy", color: "#0a7c59", is_active: false }));
    await user.click(within(screen.getByText("Implant").closest("li")!).getByRole("button", { name: "Bring back" }));
    await user.click(within(screen.getByText("Implant").closest("li")!).getByRole("button", { name: "Remove" }));
    await waitFor(() => expect(dental.deleteToothStatus).toHaveBeenCalledWith("t3"));
    await user.click(within(screen.getByText("Healthy").closest("li")!).getByTitle("Move down"));
    await waitFor(() => expect(dental.reorderToothStatuses).toHaveBeenCalledWith(["t2", "t1", "t3"]));
    await user.click(within(screen.getByText("Healthy").closest("li")!).getByTitle("Move up"));
    await user.click(within(screen.getByText("Implant").closest("li")!).getByTitle("Move up"));
    await waitFor(() => expect(dental.reorderToothStatuses).toHaveBeenLastCalledWith(["t1", "t3", "t2"]));
    await user.click(within(screen.getByText("Implant").closest("li")!).getByTitle("Move down"));
    expect(dental.reorderToothStatuses).toHaveBeenCalledTimes(2);
  });

  test("REG-FE-SETTINGS-061 a refused change is shown; cancel leaves it; loading and read-only", async () => {
    dental.updateToothStatus.mockRejectedValueOnce(new Error("Label already used"));
    const { user, unmount } = open("toothconditions");
    await screen.findByText("Healthy");
    await user.click(within(screen.getByText("Healthy").closest("li")!).getByRole("button", { name: "Retire" }));
    expect(await screen.findByText("Label already used")).toBeInTheDocument();
    await user.click(within(screen.getByText("Healthy").closest("li")!).getByRole("button", { name: "Edit" }));
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.getByText("Healthy")).toBeInTheDocument();
    unmount();
    dental.listToothStatuses.mockReturnValueOnce(new Promise(() => {}));
    const b = open("toothconditions");
    expect(screen.getByText("Loading…")).toBeInTheDocument();
    b.unmount();
    setAuth({ perms: [] });
    open("toothconditions");
    await screen.findByText("Healthy");
    expect(screen.queryByPlaceholderText(/Add a condition/)).not.toBeInTheDocument();
  });
});

describe("REG-FE-SETTINGS drugs & allergens", () => {
  test("REG-FE-SETTINGS-070 allergens with their usual reaction; drugs with defaults and allergy tags", async () => {
    open("drugs");
    expect(await screen.findByText("Penicillin")).toBeInTheDocument();
    expect(screen.getByText("Rash · severe")).toBeInTheDocument();
    expect(screen.getByText("Latex").parentElement).toHaveClass("opacity-50");
    expect(await screen.findByText("Amoxicillin 500mg")).toBeInTheDocument();
    expect(screen.getByText("· 1 cap · tds · 5 days")).toBeInTheDocument();
    expect(screen.getByText("⚠ Penicillin")).toBeInTheDocument();
    expect(screen.getByText("· no defaults")).toBeInTheDocument();
  });

  test("REG-FE-SETTINGS-071 search, remove an allergen, add a drug with an allergen tag, edit one", async () => {
    const { user } = open("drugs");
    await screen.findByText("Amoxicillin 500mg");
    await user.type(screen.getByPlaceholderText("Search drugs…"), "amo");
    await waitFor(() => expect(clin.searchDrugs).toHaveBeenLastCalledWith("amo", true));
    await user.click(screen.getByRole("button", { name: "Remove allergen Latex" }));
    await waitFor(() => expect(clin.deleteAllergen).toHaveBeenCalledWith("a2"));

    await user.click(screen.getByRole("button", { name: /Add drug/ }));
    let dlg = screen.getByRole("dialog", { name: "New drug" });
    await user.type(within(dlg).getByPlaceholderText("e.g. Amoxicillin 500mg"), "Augmentin");
    await user.type(within(dlg).getByPlaceholderText("1 cap"), "1 tab");
    await user.type(within(dlg).getByPlaceholderText("three times a day"), "bd");
    await user.type(within(dlg).getByPlaceholderText("5 days"), "7 days");
    await user.type(within(dlg).getByPlaceholderText("Complete the full course"), "After food");
    await user.click(within(dlg).getByRole("button", { name: "Penicillin" }));
    await user.click(within(dlg).getByRole("button", { name: "Add" }));
    await waitFor(() => expect(clin.createDrug).toHaveBeenCalledWith({
      name: "Augmentin", default_dose: "1 tab", default_frequency: "bd", default_duration: "7 days", default_instructions: "After food", allergen_ids: ["a1"],
    }));
    expect(toastSpy.success).toHaveBeenCalledWith("Drug added");

    await user.click(within(screen.getByText("Amoxicillin 500mg").closest("li")!).getByRole("button", { name: "Edit" }));
    dlg = screen.getByRole("dialog", { name: "Edit drug" });
    await user.click(within(dlg).getByRole("button", { name: "Penicillin" })); // untag
    await user.click(within(dlg).getByRole("button", { name: "Save" }));
    await waitFor(() => expect(clin.updateDrug).toHaveBeenCalledWith("d1", expect.objectContaining({ is_active: true, allergen_ids: [] })));

    clin.createDrug.mockRejectedValueOnce(new Error("dup"));
    await user.click(screen.getByRole("button", { name: /Add drug/ }));
    dlg = screen.getByRole("dialog");
    await user.type(within(dlg).getByPlaceholderText("e.g. Amoxicillin 500mg"), "Augmentin");
    await user.click(within(dlg).getByRole("button", { name: "Add" }));
    await waitFor(() => expect(toastSpy.error).toHaveBeenCalledWith("Could not save the drug (name may already exist)"));
    await user.click(within(dlg).getByRole("button", { name: "Cancel" }));

    await user.click(within(screen.getByText("Ibuprofen").closest("li")!).getByRole("button", { name: "Remove" }));
    await waitFor(() => expect(clin.deleteDrug).toHaveBeenCalledWith("d2"));
  });

  test("REG-FE-SETTINGS-072 add an allergen from the library card", async () => {
    clin.createAllergen.mockResolvedValue({ id: "a3", name: "Lidocaine", is_active: true });
    const { user } = open("drugs");
    await screen.findByText("Penicillin");
    await user.type(screen.getByPlaceholderText(/New allergen/), "Lidocaine");
    await user.click(screen.getByRole("button", { name: "Add allergen" }));
    await waitFor(() => expect(clin.createAllergen).toHaveBeenCalledWith("Lidocaine", expect.anything()));
  });

  test("REG-FE-SETTINGS-073 empty library, and a drug dialog with no allergens to tag; read-only staff", async () => {
    clin.listAllergens.mockResolvedValue([]);
    clin.searchDrugs.mockResolvedValue([]);
    const { user, unmount } = open("drugs");
    expect(await screen.findByText("No allergens yet.")).toBeInTheDocument();
    expect(await screen.findByText("No drugs yet.")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /Add drug/ }));
    expect(screen.getByText("Add allergens above first.")).toBeInTheDocument();
    unmount();
    setAuth({ perms: [] });
    clin.listAllergens.mockResolvedValue([{ id: "a1", name: "Penicillin", is_active: true }]);
    open("drugs");
    await screen.findByText("Penicillin");
    expect(screen.queryByRole("button", { name: /Remove allergen/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Add drug/ })).not.toBeInTheDocument();
  });

  // FE-7. Removing a drug or an allergen has no onError: a refusal (in use on a
  // prescription, server down) leaves it on the list and says nothing at all.
  test.fails("REG-FE-SETTINGS-074 KNOWN BUG FE-7 a refused drug removal is reported", async () => {
    clin.deleteDrug.mockRejectedValue(new AppError(409, "IN_USE", "On an open prescription"));
    const { user } = open("drugs");
    await screen.findByText("Amoxicillin 500mg");
    await user.click(within(screen.getByText("Amoxicillin 500mg").closest("li")!).getByRole("button", { name: "Remove" }));
    await waitFor(() => expect(clin.deleteDrug).toHaveBeenCalled());
    await waitFor(() => expect(toastSpy.error).toHaveBeenCalled(), { timeout: 500 });
  });
});

describe("REG-FE-SETTINGS general-clinic panes (reachable by URL)", () => {
  test("REG-FE-SETTINGS-080 vitals form: toggle, edit bounds, required only when on, save", async () => {
    setAuth({ flags: [] });
    const { user } = open("vitals");
    const label = await screen.findByDisplayValue("Systolic");
    const boxes = screen.getAllByRole("checkbox");
    expect(boxes[3]).toBeDisabled(); // Temp is off, so it cannot be required
    await user.click(boxes[2]);
    await user.click(boxes[3]);
    await user.type(label, " BP");
    await user.clear(screen.getByDisplayValue("mmHg"));
    await user.type(screen.getAllByRole("textbox")[1], "mm");
    const min = screen.getByDisplayValue("50");
    await user.clear(min);
    await user.type(screen.getByDisplayValue("140"), "5");
    await user.click(screen.getByRole("button", { name: "Save vitals form" }));
    await waitFor(() => expect(clin.saveVitalFields).toHaveBeenCalled());
    const saved = clin.saveVitalFields.mock.calls[0][0];
    expect(saved[0]).toMatchObject({ label: "Systolic BP", unit: "mm", min: undefined, high: 1405 });
    expect(saved[1]).toMatchObject({ enabled: true, required: true });
    expect(toastSpy.success).toHaveBeenCalledWith("Vitals form saved");
    clin.saveVitalFields.mockRejectedValueOnce(new Error("Low must be under High"));
    await user.click(screen.getByRole("button", { name: "Save vitals form" }));
    await waitFor(() => expect(toastSpy.error).toHaveBeenCalledWith("Low must be under High"));
    clin.saveVitalFields.mockRejectedValueOnce("x");
    await user.click(screen.getByRole("button", { name: "Save vitals form" }));
    await waitFor(() => expect(toastSpy.error).toHaveBeenCalledWith("Could not save the vitals form"));
  });

  test("REG-FE-SETTINGS-081 diagnosis catalog: add a category and a diagnosis", async () => {
    setAuth({ flags: [] });
    const { user } = open("diagnoses");
    expect(await screen.findByText("Pharyngitis")).toBeInTheDocument();
    expect(screen.getByText("J02.9")).toBeInTheDocument();
    await user.type(screen.getByPlaceholderText("e.g. Dermatology"), "Dental");
    await user.click(screen.getByRole("button", { name: /^Add$/ }));
    await waitFor(() => expect(clin.createCategory).toHaveBeenCalledWith({ name: "Dental" }));
    expect(toastSpy.success).toHaveBeenCalledWith("Category added");
    clin.createCategory.mockRejectedValueOnce(new Error("x"));
    await user.type(screen.getByPlaceholderText("e.g. Dermatology"), "Dental");
    await user.click(screen.getByRole("button", { name: /^Add$/ }));
    await waitFor(() => expect(toastSpy.error).toHaveBeenCalledWith("Could not add category (name may exist)"));

    await user.click(screen.getByRole("combobox"));
    await user.click(await screen.findByRole("option", { name: "Respiratory" }));
    await user.type(screen.getByPlaceholderText("J02.9"), "J00");
    await user.type(screen.getByPlaceholderText("Acute pharyngitis"), "Common cold");
    await user.click(screen.getByRole("button", { name: /Add diagnosis/ }));
    await waitFor(() => expect(clin.createCatalogEntry).toHaveBeenCalledWith({ category_id: "c1", code: "J00", name: "Common cold" }));
    expect(toastSpy.success).toHaveBeenCalledWith("Diagnosis added");
    clin.createCatalogEntry.mockRejectedValueOnce(new Error("x"));
    await user.type(screen.getByPlaceholderText("Acute pharyngitis"), "Flu");
    await user.click(screen.getByRole("button", { name: /Add diagnosis/ }));
    await waitFor(() => expect(clin.createCatalogEntry).toHaveBeenLastCalledWith({ category_id: "c1", code: undefined, name: "Flu" }));
    await waitFor(() => expect(toastSpy.error).toHaveBeenCalledWith("Could not add diagnosis (code may exist)"));
  });

  test("REG-FE-SETTINGS-082 a category still in use cannot be deleted; an empty one can, after asking", async () => {
    setAuth({ flags: [] });
    const { user } = open("diagnoses");
    await screen.findByText("Pharyngitis");
    await user.click(screen.getByRole("button", { name: "Delete category Respiratory" }));
    expect(toastSpy.error).toHaveBeenCalledWith("“Respiratory” still has 2 diagnosises — remove or move them first.");
    await user.click(screen.getByRole("button", { name: "Delete category Skin" }));
    const dlg = screen.getByRole("dialog", { name: "Delete category" });
    await user.click(within(dlg).getByRole("button", { name: "Delete" }));
    await waitFor(() => expect(clin.deleteCategory).toHaveBeenCalledWith("c2"));
    expect(toastSpy.success).toHaveBeenCalledWith("Category deleted");
    clin.deleteCategory.mockRejectedValueOnce(new Error("Nope"));
    await user.click(screen.getByRole("button", { name: "Delete category Skin" }));
    await user.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Delete" }));
    await waitFor(() => expect(toastSpy.error).toHaveBeenCalledWith("Nope"));
    clin.deleteCategory.mockRejectedValueOnce("x");
    await user.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Delete" }));
    await waitFor(() => expect(toastSpy.error).toHaveBeenCalledWith("Could not delete the category"));
    await user.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Cancel" }));
  });

  test("REG-FE-SETTINGS-083 one diagnosis left in a category is worded singular", async () => {
    setAuth({ flags: [] });
    clin.searchCatalog.mockResolvedValue([{ id: "e1", category_id: "c1", category_name: "Respiratory", name: "Cough", is_active: true }]);
    const { user } = open("diagnoses");
    await screen.findByText("Cough");
    await user.click(screen.getByRole("button", { name: "Delete category Respiratory" }));
    expect(toastSpy.error).toHaveBeenCalledWith("“Respiratory” still has 1 diagnosis — remove or move them first.");
  });

  test("REG-FE-SETTINGS-084 edit and delete a category and a diagnosis", async () => {
    setAuth({ flags: [] });
    const { user } = open("diagnoses");
    await screen.findByText("Pharyngitis");
    await user.click(screen.getByRole("button", { name: "Edit category Skin" }));
    let dlg = screen.getByRole("dialog", { name: "Edit category" });
    await user.type(within(dlg).getByDisplayValue("Skin"), " care");
    await user.click(within(dlg).getByRole("combobox"));
    await user.click(await screen.findByRole("option", { name: "Active" }));
    await user.click(within(dlg).getByRole("button", { name: "Save" }));
    await waitFor(() => expect(clin.updateCategory).toHaveBeenCalledWith("c2", { name: "Skin care", sort_order: 2, is_active: true }));
    expect(toastSpy.success).toHaveBeenCalledWith("Category updated");

    clin.updateCategory.mockRejectedValueOnce("x");
    await user.click(screen.getByRole("button", { name: "Edit category Skin" }));
    dlg = screen.getByRole("dialog");
    await user.click(within(dlg).getByRole("button", { name: "Save" }));
    await waitFor(() => expect(toastSpy.error).toHaveBeenCalledWith("Could not save the category (name may exist)"));
    await user.click(within(dlg).getByRole("button", { name: "Cancel" }));

    const entry = () => screen.getByText("Pharyngitis").closest("li")!;
    await user.click(within(entry()).getByRole("button", { name: "Edit" }));
    dlg = screen.getByRole("dialog", { name: "Edit diagnosis" });
    await user.clear(within(dlg).getByDisplayValue("J02.9"));
    await user.click(within(dlg).getByRole("combobox"));
    await user.click(await screen.findByRole("option", { name: "Skin" }));
    await user.click(within(dlg).getByRole("button", { name: "Save" }));
    await waitFor(() => expect(clin.updateCatalogEntry).toHaveBeenCalledWith("e1", { category_id: "c2", code: undefined, name: "Pharyngitis" }));
    expect(toastSpy.success).toHaveBeenCalledWith("Diagnosis updated");

    clin.updateCatalogEntry.mockRejectedValueOnce(new Error("Code taken"));
    await user.click(within(entry()).getByRole("button", { name: "Edit" }));
    dlg = screen.getByRole("dialog");
    await user.click(within(dlg).getByRole("button", { name: "Save" }));
    await waitFor(() => expect(toastSpy.error).toHaveBeenCalledWith("Code taken"));
    await user.click(within(dlg).getByRole("button", { name: "Cancel" }));

    await user.click(within(entry()).getByRole("button", { name: "Remove" }));
    await user.click(within(screen.getByRole("dialog", { name: "Delete diagnosis" })).getByRole("button", { name: "Delete" }));
    await waitFor(() => expect(clin.deleteCatalogEntry).toHaveBeenCalledWith("e1"));
    expect(toastSpy.success).toHaveBeenCalledWith("Diagnosis deleted");
    clin.deleteCatalogEntry.mockRejectedValueOnce("x");
    await user.click(within(entry()).getByRole("button", { name: "Remove" }));
    await user.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Delete" }));
    await waitFor(() => expect(toastSpy.error).toHaveBeenCalledWith("Could not delete the diagnosis"));
  });

  test("REG-FE-SETTINGS-085 empty catalog, read-only catalog and vitals", async () => {
    setAuth({ flags: [] });
    clin.listDiagnosisCategories.mockResolvedValueOnce([]);
    clin.searchCatalog.mockResolvedValueOnce([]);
    const a = open("diagnoses");
    expect(await screen.findByText("No categories yet.")).toBeInTheDocument();
    expect(await screen.findByText("No diagnoses yet.")).toBeInTheDocument();
    a.unmount();
    setAuth({ flags: [], perms: [] });
    const b = open("diagnoses");
    await screen.findByText("Pharyngitis");
    expect(screen.queryByPlaceholderText("e.g. Dermatology")).not.toBeInTheDocument();
    b.unmount();
    open("vitals");
    expect(await screen.findByDisplayValue("Systolic")).toBeDisabled();
    expect(screen.queryByRole("button", { name: "Save vitals form" })).not.toBeInTheDocument();
  });

  test("REG-FE-SETTINGS-090 branches & departments (hidden from the rail, reachable by URL)", async () => {
    admin.listBranches.mockResolvedValue([
      { id: "br_1", name: "Bole", code: "BOLE", is_active: true },
      { id: "br_2", name: "Piassa", code: "PIA", is_active: false },
    ]);
    admin.listDepartments.mockResolvedValue([{ id: "dp1", branch_id: "br_1", name: "General", specialty: "dentistry" }]);
    admin.branchUsage.mockResolvedValue({ used: 2, limit: 3 });
    admin.getBranchModules.mockResolvedValue([
      { flag: "laboratory", enabled: true, overridden: true },
      { flag: "pharmacy", enabled: false, overridden: false },
      { flag: "xray", enabled: false, overridden: false },
    ]);
    admin.createBranch.mockResolvedValue({ id: "br_3", name: "CMC", code: "CMC", is_active: true });
    const { user } = open("locations");
    expect(await screen.findByText("Departments in")).toBeInTheDocument();
    expect(screen.getByText("2 of 3 branches used")).toBeInTheDocument();
    expect(screen.getByText("inactive")).toBeInTheDocument();
    expect(screen.getByText("· dentistry")).toBeInTheDocument();
    expect(await screen.findByText("Laboratory")).toBeInTheDocument();
    expect(screen.getByText("xray")).toBeInTheDocument();

    // Modules: toggle and reset.
    await user.click(screen.getByRole("button", { name: "On" }));
    await waitFor(() => expect(admin.setBranchModules).toHaveBeenCalledWith("br_1", { laboratory: false }));
    expect(toastSpy.success).toHaveBeenCalledWith("Module updated for this branch");
    await user.click(screen.getByRole("button", { name: "Reset" }));
    await waitFor(() => expect(admin.setBranchModules).toHaveBeenCalledWith("br_1", { laboratory: null }));
    admin.setBranchModules.mockRejectedValueOnce("x");
    await user.click(screen.getAllByRole("button", { name: "Off" })[0]);
    await waitFor(() => expect(toastSpy.error).toHaveBeenCalledWith("Could not update the module"));

    // Departments: add, edit, remove.
    await user.click(screen.getByRole("button", { name: /Add department/ }));
    let dlg = screen.getByRole("dialog", { name: "New department in Bole" });
    await user.type(within(dlg).getByPlaceholderText("Pediatrics"), "Ortho");
    await user.type(within(dlg).getByPlaceholderText("pediatrics"), "orthodontics");
    await user.click(within(dlg).getByRole("button", { name: "Add" }));
    await waitFor(() => expect(admin.createDepartment).toHaveBeenCalledWith({ branch_id: "br_1", name: "Ortho", specialty: "orthodontics" }));
    expect(toastSpy.success).toHaveBeenCalledWith("Department added");
    await user.click(screen.getByRole("button", { name: "Edit" }));
    dlg = screen.getByRole("dialog", { name: "Edit department" });
    admin.updateDepartment.mockRejectedValueOnce("x");
    await user.click(within(dlg).getByRole("button", { name: "Save" }));
    await waitFor(() => expect(toastSpy.error).toHaveBeenCalledWith("Could not save the department"));
    await user.click(within(dlg).getByRole("button", { name: "Save" }));
    await waitFor(() => expect(admin.updateDepartment).toHaveBeenLastCalledWith("dp1", { branch_id: "br_1", name: "General", specialty: "dentistry" }));
    await user.click(screen.getByRole("button", { name: "Remove" }));
    dlg = screen.getByRole("dialog", { name: "Delete department" });
    admin.deleteDepartment.mockRejectedValueOnce("x");
    await user.click(within(dlg).getByRole("button", { name: "Delete" }));
    await waitFor(() => expect(toastSpy.error).toHaveBeenCalledWith("Could not delete the department"));
    await user.click(within(dlg).getByRole("button", { name: "Delete" }));
    await waitFor(() => expect(toastSpy.success).toHaveBeenCalledWith("Department deleted"));

    // Branches: edit status, add, delete.
    await user.click(screen.getByRole("button", { name: /Edit branch/ }));
    dlg = screen.getByRole("dialog", { name: "Edit branch" });
    await user.click(within(dlg).getByRole("combobox"));
    await user.click(await screen.findByRole("option", { name: "Inactive" }));
    await user.click(within(dlg).getByRole("button", { name: "Save" }));
    await waitFor(() => expect(admin.updateBranch).toHaveBeenCalledWith("br_1", { name: "Bole", code: "BOLE", is_active: false }));
    expect(toastSpy.success).toHaveBeenCalledWith("Branch updated");

    await user.click(screen.getByRole("button", { name: /Add branch/ }));
    dlg = screen.getByRole("dialog", { name: "New branch" });
    await user.type(within(dlg).getByPlaceholderText("Bole Branch"), "CMC");
    admin.createBranch.mockRejectedValueOnce("x");
    await user.type(within(dlg).getByPlaceholderText("BOLE"), "CMC");
    await user.click(within(dlg).getByRole("button", { name: "Add" }));
    await waitFor(() => expect(toastSpy.error).toHaveBeenCalledWith("Could not save the branch (code may be taken)"));
    await user.click(within(dlg).getByRole("button", { name: "Add" }));
    await waitFor(() => expect(admin.createBranch).toHaveBeenLastCalledWith({ name: "CMC", code: "CMC" }));
    expect(toastSpy.success).toHaveBeenCalledWith("Branch added");

    await user.click(screen.getByRole("button", { name: "Piassa PIA inactive" }));
    await user.click(screen.getByRole("button", { name: /^Delete$/ }));
    dlg = screen.getByRole("dialog", { name: "Delete branch" });
    expect(dlg).toHaveTextContent("Delete “Piassa”?");
    admin.deleteBranch.mockRejectedValueOnce("x");
    await user.click(within(dlg).getByRole("button", { name: "Delete" }));
    await waitFor(() => expect(toastSpy.error).toHaveBeenCalledWith("Could not delete the branch"));
    await user.click(within(dlg).getByRole("button", { name: "Delete" }));
    await waitFor(() => expect(admin.deleteBranch).toHaveBeenCalledWith("br_2"));
    expect(toastSpy.success).toHaveBeenCalledWith("Branch deleted");
  });

  test("REG-FE-SETTINGS-091 no branches yet; at the plan's limit Add branch is off; read-only staff", async () => {
    admin.branchUsage.mockResolvedValue({ used: 1, limit: 1 });
    const a = open("locations");
    expect(await screen.findByText("No branches yet. Add your first branch to start.")).toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole("button", { name: /Add branch/ })).toBeDisabled());
    expect(screen.getByText("1 of 1 branch used")).toBeInTheDocument();
    a.unmount();
    setAuth({ perms: [] });
    admin.listBranches.mockResolvedValue([{ id: "br_1", name: "Bole", code: "BOLE", is_active: true }]);
    admin.branchUsage.mockResolvedValue({ used: 1 });
    admin.getBranchModules.mockResolvedValue([{ flag: "laboratory", enabled: true, overridden: false }]);
    open("locations");
    expect(await screen.findByText("No departments in this branch yet.")).toBeInTheDocument();
    expect(await screen.findByText("Laboratory")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "On" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Add branch/ })).not.toBeInTheDocument();
  });
});

void OWNER_PERMS;
