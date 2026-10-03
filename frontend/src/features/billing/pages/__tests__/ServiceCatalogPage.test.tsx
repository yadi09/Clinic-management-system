// The service catalog at /billing/services: the one price for each thing the clinic
// sells. A dental clinic sees two lists — general services (owned by whoever manages
// billing) and dental procedures (which the dentist may maintain too). The screen
// must split them correctly, open the dentist on their own list, let only editors
// edit, send the full row on every update (the endpoint replaces it), keep the
// staff-who-provide list for general services and never wipe it for a dental one,
// and confirm before removing a service.
import { screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, test, vi } from "vitest";

const auth = vi.hoisted(() => ({ perms: new Set<string>(), flags: new Set<string>() }));
vi.mock("@/app/auth-context", () => ({
  useAuth: () => ({ can: (p: string) => auth.perms.has(p), flagOn: (f: string) => auth.flags.has(f), user: { id: "u1", full_name: "Hanna" } }),
}));
const api = vi.hoisted(() => ({
  listServices: vi.fn(), createService: vi.fn(), updateService: vi.fn(), setServiceActive: vi.fn(),
  setServiceDefault: vi.fn(), deleteService: vi.fn(), getServiceProviders: vi.fn(), setServiceProviders: vi.fn(),
}));
vi.mock("@/features/billing/api", async (orig) => ({ ...(await orig<object>()), ...api }));
const admin = vi.hoisted(() => ({ listUsers: vi.fn() }));
vi.mock("@/features/admin/api", async (orig) => ({ ...(await orig<object>()), ...admin }));
const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }));
vi.mock("@/components/ui/sonner", async (orig) => ({ ...(await orig<object>()), toast }));

import { ServiceCatalogPage } from "@/features/billing/pages/ServiceCatalogPage";
import type { ServiceItem } from "@/features/billing/api";
import type { UserListItem } from "@/features/admin/api";
import { AppError } from "@/lib/api-client";
import { renderUI } from "@/test/render";

const svc = (id: string, over: Partial<ServiceItem> = {}): ServiceItem => ({
  id, code: id.toUpperCase(), name: `Service ${id}`, category: "consultation", price: "100.00", currency: "ETB",
  is_active: true, is_default: false, assignable_by: "either", ...over,
});
const CONSULT = svc("consult", { name: "Consultation", is_default: true });
const XRAY = svc("xray", { name: "X-ray", category: "imaging", assignable_by: "reception", is_active: false });
const NURSE = svc("nurse", { name: "Dressing", category: "nursing", assignable_by: "bogus" });
const RCT = svc("rct", { name: "Root canal", category: "Dental ", price: "4500.00", assignable_by: "clinician" });
const ALL = [CONSULT, XRAY, NURSE, RCT];
const user = (id: string, name: string, status = "active", roles = ["front_desk"]): UserListItem =>
  ({ id, email: "", full_name: name, phone: "", status, roles, created_at: "" });
const USERS = [user("u1", "Dr Abel", "active", ["doctor"]), user("u2", "Hanna"), user("u3", "Gone Person", "disabled")];

const table = () => screen.getByRole("table");
const tableRow = (name: string) => within(table()).getByText(name).closest("tr")!;
const page = () => renderUI(<ServiceCatalogPage />, { route: "/billing/services" });

describe("REG-FE-SVCCAT the service catalog", () => {
  beforeEach(() => {
    auth.perms = new Set(["billing.manage"]);
    auth.flags = new Set(["dental"]);
    Object.values(api).forEach((f) => { f.mockReset(); f.mockResolvedValue(undefined); });
    api.listServices.mockResolvedValue(ALL);
    api.getServiceProviders.mockImplementation(async (id: string) => (id === "consult" ? ["u1", "u2"] : []));
    api.createService.mockResolvedValue({ id: "new_1" });
    admin.listUsers.mockResolvedValue(USERS);
    toast.success.mockReset(); toast.error.mockReset();
  });

  test("REG-FE-SVCCAT-001 a dental clinic's billing manager opens on general services; dental procedures are not mixed in", async () => {
    page();
    expect(await within(table()).findByText("Consultation")).toBeInTheDocument();
    expect(api.listServices).toHaveBeenCalledWith(false);
    expect(screen.getByRole("tab", { name: /General services\s*3/ })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByRole("tab", { name: /Dental procedures\s*1/ })).toBeInTheDocument();
    expect(within(table()).queryByText("Root canal")).not.toBeInTheDocument();
    expect(within(table()).getByRole("columnheader", { name: "Providers" })).toBeInTheDocument();
    // Staff counts per service: staffed, nobody.
    expect(await within(tableRow("Consultation")).findByRole("button", { name: /2 staff/ })).toBeInTheDocument();
    expect(within(tableRow("X-ray")).getByRole("button", { name: /None — assign/ })).toBeInTheDocument();
    expect(within(tableRow("X-ray")).getByRole("button", { name: "Off" })).toBeInTheDocument();
    expect(within(tableRow("Consultation")).getByRole("button", { name: "Default" })).toBeInTheDocument();
    // An unknown rule reads as Anyone.
    expect(within(tableRow("Dressing")).getByRole("button", { name: "Anyone" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /New service/ })).toBeInTheDocument();
  });

  test("REG-FE-SVCCAT-002 a dentist without billing rights opens on dental procedures and may edit them", async () => {
    auth.perms = new Set(["dental.manage"]);
    page();
    expect(await within(table()).findByText("Root canal")).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: /Dental procedures/ })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByText(/one true price/)).toBeInTheDocument();
    expect(within(table()).queryByRole("columnheader", { name: "Providers" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /New procedure/ })).toBeInTheDocument();
    expect(within(tableRow("Root canal")).getByTitle("Edit")).toBeInTheDocument();
    expect(within(tableRow("Root canal")).queryByTitle("Assign staff")).not.toBeInTheDocument();
    // Provider counts are not asked for dental procedures.
    expect(api.getServiceProviders).not.toHaveBeenCalled();
  });

  test("REG-FE-SVCCAT-003 the same dentist on general services is view only", async () => {
    auth.perms = new Set(["dental.manage"]);
    const { user: u } = page();
    await within(table()).findByText("Root canal");
    await u.click(screen.getByRole("tab", { name: /General services/ }));
    expect(within(tableRow("Consultation")).getByText("View only")).toBeInTheDocument();
    expect(within(tableRow("Consultation")).getByRole("button", { name: "Anyone" })).toBeDisabled();
    expect(screen.queryByRole("button", { name: /New service/ })).not.toBeInTheDocument();
  });

  test("REG-FE-SVCCAT-004 a general clinic has one list and no tabs", async () => {
    auth.flags = new Set();
    page();
    await within(table()).findByText("Consultation");
    expect(screen.queryByRole("tablist")).not.toBeInTheDocument();
    // Without the dental flag a 'Dental' category is still just filtered out of general.
    expect(within(table()).queryByText("Root canal")).not.toBeInTheDocument();
  });

  test("REG-FE-SVCCAT-005 empty lists say what to do, per list", async () => {
    api.listServices.mockResolvedValue([]);
    const { user: u } = page();
    expect(await screen.findByText(/No services yet/)).toBeInTheDocument();
    await u.click(screen.getByRole("tab", { name: /Dental procedures/ }));
    expect(screen.getByText(/No dental procedures priced yet/)).toBeInTheDocument();
  });

  test("REG-FE-SVCCAT-006 the 'assigned by' pill cycles Anyone → Clinician → Front desk → Anyone, sending the whole row", async () => {
    const { user: u } = page();
    await within(table()).findByText("Consultation");
    await u.click(within(tableRow("Consultation")).getByRole("button", { name: "Anyone" }));
    await waitFor(() => expect(api.updateService).toHaveBeenCalledWith("consult",
      { code: "CONSULT", name: "Consultation", category: "consultation", price: 100, assignable_by: "clinician" }));
    await u.click(within(tableRow("X-ray")).getByRole("button", { name: "Front desk" }));
    await waitFor(() => expect(api.updateService).toHaveBeenLastCalledWith("xray", expect.objectContaining({ assignable_by: "either" })));
    expect(api.listServices.mock.calls.length).toBeGreaterThan(1);
  });

  test("REG-FE-SVCCAT-007 availability and the reception default toggle", async () => {
    const { user: u } = page();
    await within(table()).findByText("Consultation");
    await u.click(within(tableRow("Consultation")).getByRole("button", { name: "Available" }));
    await waitFor(() => expect(api.setServiceActive).toHaveBeenCalledWith("consult", false));
    await u.click(within(tableRow("X-ray")).getByRole("button", { name: "Off" }));
    await waitFor(() => expect(api.setServiceActive).toHaveBeenCalledWith("xray", true));
    await u.click(within(tableRow("Consultation")).getByRole("button", { name: "Default" }));
    await waitFor(() => expect(api.setServiceDefault).toHaveBeenCalledWith("consult", false));
    await u.click(within(tableRow("X-ray")).getByRole("button", { name: "—" }));
    await waitFor(() => expect(api.setServiceDefault).toHaveBeenCalledWith("xray", true));
  });

  test("REG-FE-SVCCAT-008 an update the server refuses is shown; any other failure gets a generic message", async () => {
    api.setServiceActive.mockRejectedValueOnce(new AppError(403, "forbidden", "Not allowed here"));
    api.setServiceDefault.mockRejectedValueOnce(new Error("boom"));
    api.updateService.mockRejectedValueOnce(new AppError(409, "conflict", "Code taken"));
    const { user: u } = page();
    await within(table()).findByText("Consultation");
    await u.click(within(tableRow("Consultation")).getByRole("button", { name: "Available" }));
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith("Not allowed here"));
    await u.click(within(tableRow("Consultation")).getByRole("button", { name: "Default" }));
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith("Could not update"));
    await u.click(within(tableRow("Consultation")).getByRole("button", { name: "Anyone" }));
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith("Code taken"));
  });

  test("REG-FE-SVCCAT-009 removing a service is confirmed first, then deleted", async () => {
    const { user: u } = page();
    await within(table()).findByText("Consultation");
    await u.click(within(tableRow("Consultation")).getByTitle("Delete"));
    const dlg = await screen.findByRole("dialog");
    expect(within(dlg).getByText('Remove "Consultation"?')).toBeInTheDocument();
    expect(api.deleteService).not.toHaveBeenCalled();
    await u.click(within(dlg).getByRole("button", { name: "Remove service" }));
    await waitFor(() => expect(api.deleteService).toHaveBeenCalledWith("consult"));
    expect(toast.success).toHaveBeenCalledWith("Service removed");
  });

  test("REG-FE-SVCCAT-010 a new general service: code, name, category, price, rule and its providers are saved", async () => {
    const { user: u } = page();
    await within(table()).findByText("Consultation");
    await u.click(screen.getByRole("button", { name: /New service/ }));
    const dlg = await screen.findByRole("dialog");
    const create = within(dlg).getByRole("button", { name: "Create" });
    expect(create).toBeDisabled();
    await u.type(within(dlg).getByPlaceholderText("CONSULT"), "ECG");
    await u.type(within(dlg).getByPlaceholderText("Consultation"), "Electrocardiogram");
    const cat = within(dlg).getByPlaceholderText("consultation");
    await u.clear(cat);
    await u.type(cat, "diagnostics");
    await u.type(within(dlg).getByPlaceholderText("100"), "350");
    await u.click(within(dlg).getByRole("button", { name: /Clinician/ }));
    // Only active staff are offered.
    expect(within(dlg).queryByText("Gone Person")).not.toBeInTheDocument();
    await u.click(await within(dlg).findByRole("checkbox", { name: /Dr Abel/ }));
    await u.click(create);
    await waitFor(() => expect(api.createService).toHaveBeenCalledWith(
      { code: "ECG", name: "Electrocardiogram", category: "diagnostics", price: 350, assignable_by: "clinician" }));
    await waitFor(() => expect(api.setServiceProviders).toHaveBeenCalledWith("new_1", ["u1"]));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
  });

  test("REG-FE-SVCCAT-011 a new dental procedure defaults to the dental category and the clinician, and never touches providers", async () => {
    const { user: u } = page();
    await within(table()).findByText("Consultation");
    await u.click(screen.getByRole("tab", { name: /Dental procedures/ }));
    await u.click(screen.getByRole("button", { name: /New procedure/ }));
    const dlg = await screen.findByRole("dialog");
    expect(within(dlg).getByText("New procedure")).toBeInTheDocument();
    expect(within(dlg).queryByText("Staff who provide this")).not.toBeInTheDocument();
    await u.type(within(dlg).getByPlaceholderText("RCT-MOLAR"), "CRN");
    await u.type(within(dlg).getByPlaceholderText("Root canal — molar"), "Crown");
    await u.type(within(dlg).getByPlaceholderText("4500"), "6000");
    await u.click(within(dlg).getByRole("button", { name: "Create" }));
    await waitFor(() => expect(api.createService).toHaveBeenCalledWith(
      { code: "CRN", name: "Crown", category: "dental", price: 6000, assignable_by: "clinician" }));
    expect(api.setServiceProviders).not.toHaveBeenCalled();
  });

  test("REG-FE-SVCCAT-012 editing loads the row and its providers, and saves both; a refusal is shown", async () => {
    api.updateService.mockRejectedValueOnce(new AppError(409, "dup", "That code is already used")).mockResolvedValue(undefined);
    const { user: u } = page();
    await within(table()).findByText("Consultation");
    await u.click(within(tableRow("Consultation")).getByTitle("Edit"));
    const dlg = await screen.findByRole("dialog");
    expect(within(dlg).getByText("Edit service")).toBeInTheDocument();
    expect(within(dlg).getByPlaceholderText("CONSULT")).toHaveValue("CONSULT");
    expect(await within(dlg).findByRole("checkbox", { name: /Hanna/ })).toBeChecked();
    const price = within(dlg).getByPlaceholderText("100");
    await u.clear(price);
    await u.type(price, "abc");
    await u.click(within(dlg).getByRole("checkbox", { name: /Hanna/ }));
    await u.click(within(dlg).getByRole("button", { name: "Save" }));
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith("That code is already used"));
    await u.click(within(dlg).getByRole("button", { name: "Save" }));
    await waitFor(() => expect(api.updateService).toHaveBeenLastCalledWith("consult",
      { code: "CONSULT", name: "Consultation", category: "consultation", price: 0, assignable_by: "either" }));
    await waitFor(() => expect(api.setServiceProviders).toHaveBeenCalledWith("consult", ["u1"]));
  });

  test("REG-FE-SVCCAT-013 a failed provider lookup in the edit dialog leaves nobody ticked; a save failure is generic", async () => {
    api.getServiceProviders.mockRejectedValue(new Error("x"));
    api.updateService.mockRejectedValue(new Error("x"));
    const { user: u } = page();
    await within(table()).findByText("Consultation");
    await u.click(within(tableRow("Consultation")).getByTitle("Edit"));
    const dlg = await screen.findByRole("dialog");
    expect(await within(dlg).findByRole("checkbox", { name: /Dr Abel/ })).not.toBeChecked();
    await u.click(within(dlg).getByRole("button", { name: "Save" }));
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith("Could not save the service"));
    await u.click(within(dlg).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
  });

  test("REG-FE-SVCCAT-014 assign staff: ticks load, changes are saved, the dialog closes", async () => {
    const { user: u } = page();
    await within(table()).findByText("Consultation");
    await u.click(await within(tableRow("Consultation")).findByRole("button", { name: /2 staff/ }));
    const dlg = await screen.findByRole("dialog");
    expect(within(dlg).getByText("Assign staff — Consultation")).toBeInTheDocument();
    expect(within(dlg).getByText("doctor")).toBeInTheDocument();
    await waitFor(() => expect(within(dlg).getByRole("checkbox", { name: /Dr Abel/ })).toBeChecked());
    await u.click(within(dlg).getByRole("checkbox", { name: /Dr Abel/ }));
    await u.click(within(dlg).getByRole("button", { name: "Save" }));
    await waitFor(() => expect(api.setServiceProviders).toHaveBeenCalledWith("consult", ["u2"]));
    expect(toast.success).toHaveBeenCalledWith("Providers updated");
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
  });

  test("REG-FE-SVCCAT-015 assign staff with nobody active: says to invite staff; a save refusal is shown; Cancel closes", async () => {
    admin.listUsers.mockResolvedValue([user("u3", "Gone", "disabled")]);
    api.getServiceProviders.mockRejectedValue(new Error("x"));
    api.setServiceProviders.mockRejectedValueOnce(new AppError(400, "bad", "No such staff")).mockRejectedValueOnce(new Error("x"));
    const { user: u } = page();
    await within(table()).findByText("Consultation");
    await u.click(within(tableRow("X-ray")).getByTitle("Assign staff"));
    const dlg = await screen.findByRole("dialog");
    expect(await within(dlg).findByText(/No active staff yet/)).toBeInTheDocument();
    await u.click(within(dlg).getByRole("button", { name: "Save" }));
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith("No such staff"));
    await u.click(within(dlg).getByRole("button", { name: "Save" }));
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith("Could not save"));
    await u.click(within(dlg).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
  });

  test("REG-FE-SVCCAT-016 the edit dialog with no staff at all says so", async () => {
    admin.listUsers.mockResolvedValue([]);
    const { user: u } = page();
    await within(table()).findByText("Consultation");
    await u.click(screen.getByRole("button", { name: /New service/ }));
    expect(await within(await screen.findByRole("dialog")).findByText("No staff yet.")).toBeInTheDocument();
  });

  test("REG-FE-SVCCAT-017 phone cards: one kebab holds assign, edit, default and delete", async () => {
    const { user: u } = page();
    await within(table()).findByText("Consultation");
    await u.click(screen.getByRole("button", { name: "Actions for Consultation" }));
    await u.click(await screen.findByRole("menuitem", { name: "Unset reception default" }));
    await waitFor(() => expect(api.setServiceDefault).toHaveBeenCalledWith("consult", false));

    await u.click(screen.getByRole("button", { name: "Actions for X-ray" }));
    await u.click(await screen.findByRole("menuitem", { name: "Make reception default" }));
    await waitFor(() => expect(api.setServiceDefault).toHaveBeenCalledWith("xray", true));

    await u.click(screen.getByRole("button", { name: "Actions for X-ray" }));
    await u.click(await screen.findByRole("menuitem", { name: /Assign staff/ }));
    expect(await screen.findByText("Assign staff — X-ray")).toBeInTheDocument();
    await u.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());

    await u.click(screen.getByRole("button", { name: "Actions for X-ray" }));
    await u.click(await screen.findByRole("menuitem", { name: /Edit/ }));
    expect(await screen.findByText("Edit service")).toBeInTheDocument();
    await u.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());

    await u.click(screen.getByRole("button", { name: "Actions for X-ray" }));
    await u.click(await screen.findByRole("menuitem", { name: /Delete/ }));
    expect(await screen.findByText('Remove "X-ray"?')).toBeInTheDocument();
  });

  test("REG-FE-SVCCAT-018 phone cards: the rule picker names its target; picking the current rule sends nothing", async () => {
    const { user: u } = page();
    await within(table()).findByText("Consultation");
    // The card's pill opens a menu (the table's pill has no popup).
    const pill = () => screen.getAllByRole("button", { name: /Front desk/ }).find((b) => b.getAttribute("aria-haspopup") === "menu")!;
    await u.click(pill());
    await u.click(await screen.findByRole("menuitem", { name: /Front desk/ }));
    expect(api.updateService).not.toHaveBeenCalled();
    await u.click(pill());
    await u.click(await screen.findByRole("menuitem", { name: /Clinician/ }));
    await waitFor(() => expect(api.updateService).toHaveBeenCalledWith("xray", expect.objectContaining({ assignable_by: "clinician", category: "imaging" })));
  });

  test("REG-FE-SVCCAT-019 phone cards: staff pill, availability pill, Default tag; view-only users get a plain pill", async () => {
    const { user: u, unmount } = page();
    await within(table()).findByText("Consultation");
    const cardOf = (name: string) => screen.getAllByText(name).find((n) => !n.closest("table"))!.closest("div.p-3") as HTMLElement;
    const card = cardOf("Consultation");
    expect(within(card).getByText("Default")).toBeInTheDocument();
    await u.click(within(card).getByRole("button", { name: "Available" }));
    await waitFor(() => expect(api.setServiceActive).toHaveBeenCalledWith("consult", false));
    await u.click(await within(cardOf("X-ray")).findByRole("button", { name: /None — assign/ }));
    expect(await screen.findByText("Assign staff — X-ray")).toBeInTheDocument();
    unmount();

    // Nobody with edit rights: a dental clinic opens on its procedures, view only.
    auth.perms = new Set();
    page();
    await within(table()).findByText("Root canal");
    expect(screen.queryByRole("button", { name: "Actions for Root canal" })).not.toBeInTheDocument();
    expect(within(cardOf("Root canal")).getByTitle(/Only clinical staff/)).toHaveTextContent("Clinician");
    await u.click(screen.getByRole("tab", { name: /General services/ }));
    expect(within(cardOf("Dressing")).getByTitle(/front desk or the clinician/)).toHaveTextContent("Anyone");
    expect(within(cardOf("X-ray")).getByTitle(/Added at reception/)).toHaveTextContent("Front desk");
  });

  // NEW-SVCCAT-1: ServiceCatalogPage.tsx:53/326 never reads services.isError, so a
  // failed load falls through to "No services yet — add the ones your clinic bills
  // for." — inviting an admin to re-create a price list that exists (same class as UX-1).
  test.fails("REG-FE-SVCCAT-020 KNOWN BUG NEW-SVCCAT-1 a failed catalog load is an error, not 'No services yet'", async () => {
    api.listServices.mockRejectedValue(new Error("down"));
    page();
    expect(await screen.findByRole("alert")).toBeInTheDocument();
  });
});
