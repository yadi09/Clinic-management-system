// Every URL a signed-in clinic can open lands on its page — and the pages a plan
// does not include are fenced at the route. Pages are stubbed: this is the map,
// not the territory.
import { screen } from "@testing-library/react";
import { Outlet } from "react-router-dom";
import { beforeEach, describe, expect, test, vi } from "vitest";

// Whole-page flows with many clicks; the shared 5s budget is too tight when the full
// suite runs in parallel (and under scripts/test/time-sweep.sh).
vi.setConfig({ testTimeout: 60_000 });

vi.mock("@/app/auth-context", async () => (await import("@/test/admin")).authModule);
vi.mock("@/app/layouts/AppShell", () => ({ AppShell: () => <div data-testid="shell"><Outlet /></div> }));
const admin = vi.hoisted(() => ({ planUsage: vi.fn() }));
vi.mock("@/features/admin/api", () => admin);
vi.mock("@/features/auth/pages/LoginPage", () => ({ LoginPage: () => <h1>LoginPage</h1> }));
vi.mock("@/features/auth/pages/MfaPage", () => ({ MfaPage: () => <h1>MfaPage</h1> }));
vi.mock("@/features/auth/pages/AcceptInvitePage", () => ({ AcceptInvitePage: () => <h1>AcceptInvitePage</h1> }));
vi.mock("@/features/admin/pages/UsersPage", () => ({ UsersPage: () => <h1>UsersPage</h1> }));
vi.mock("@/features/dashboard/pages/DashboardPage", () => ({ DashboardPage: () => <h1>DashboardPage</h1> }));
vi.mock("@/features/patients/pages/PatientsListPage", () => ({ PatientsListPage: () => <h1>PatientsListPage</h1> }));
vi.mock("@/features/patients/pages/PatientRegisterPage", () => ({ PatientRegisterPage: () => <h1>PatientRegisterPage</h1> }));
vi.mock("@/features/patients/pages/PatientImportPage", () => ({ PatientImportPage: () => <h1>PatientImportPage</h1> }));
vi.mock("@/features/patients/pages/PatientProfilePage", () => ({ PatientProfilePage: () => <h1>PatientProfilePage</h1> }));
vi.mock("@/features/patients/pages/PatientSchedulePage", () => ({ PatientSchedulePage: () => <h1>PatientSchedulePage</h1> }));
vi.mock("@/features/admin/pages/SettingsPage", () => ({ SettingsPage: () => <h1>SettingsPage</h1> }));
vi.mock("@/features/scheduling/pages/AppointmentsPage", () => ({ AppointmentsPage: () => <h1>AppointmentsPage</h1> }));
vi.mock("@/features/scheduling/pages/QueuePage", () => ({ QueuePage: () => <h1>QueuePage</h1> }));
vi.mock("@/features/scheduling/pages/ReceptionPage", () => ({ ReceptionPage: () => <h1>ReceptionPage</h1> }));
vi.mock("@/features/scheduling/pages/TriagePage", () => ({ TriagePage: () => <h1>TriagePage</h1> }));
vi.mock("@/features/scheduling/pages/WorklistPage", () => ({ WorklistPage: () => <h1>WorklistPage</h1> }));
vi.mock("@/features/notifications/pages/NotificationsPage", () => ({ NotificationsPage: () => <h1>NotificationsPage</h1> }));
vi.mock("@/features/dental/ChairsidePage", () => ({ ChairsidePage: () => <h1>ChairsidePage</h1> }));
vi.mock("@/features/dental/pages/UnbilledPage", () => ({ UnbilledPage: () => <h1>UnbilledPage</h1> }));
vi.mock("@/features/clinical/pages/EncounterWorkspacePage", () => ({ EncounterWorkspacePage: () => <h1>EncounterWorkspacePage</h1> }));
vi.mock("@/features/pharmacy/pages/DispenseQueuePage", () => ({ DispenseQueuePage: () => <h1>DispenseQueuePage</h1> }));
vi.mock("@/features/pharmacy/pages/DispensePage", () => ({ DispensePage: () => <h1>DispensePage</h1> }));
vi.mock("@/features/pharmacy/pages/BatchesPage", () => ({ BatchesPage: () => <h1>BatchesPage</h1> }));
vi.mock("@/features/pharmacy/pages/DrugCatalogPage", () => ({ DrugCatalogPage: () => <h1>DrugCatalogPage</h1> }));
vi.mock("@/features/pharmacy/pages/OtcSalePage", () => ({ OtcSalePage: () => <h1>OtcSalePage</h1> }));
vi.mock("@/features/pharmacy/pages/PharmacyDashboardPage", () => ({ PharmacyDashboardPage: () => <h1>PharmacyDashboardPage</h1> }));
vi.mock("@/features/pharmacy/pages/CatalogAdminPage", () => ({ CatalogAdminPage: () => <h1>CatalogAdminPage</h1> }));
vi.mock("@/features/pharmacy/pages/PurchasingPage", () => ({ PurchasingPage: () => <h1>PurchasingPage</h1> }));
vi.mock("@/features/pharmacy/pages/StockControlPage", () => ({ StockControlPage: () => <h1>StockControlPage</h1> }));
vi.mock("@/features/pharmacy/pages/ReportsPage", () => ({ ReportsPage: () => <h1>ReportsPage</h1> }));
vi.mock("@/features/lab/pages/LabWorklistPage", () => ({ LabWorklistPage: () => <h1>LabWorklistPage</h1> }));
vi.mock("@/features/lab/pages/LabOrderItemPage", () => ({ LabOrderItemPage: () => <h1>LabOrderItemPage</h1> }));
vi.mock("@/features/lab/pages/LabCatalogPage", () => ({ LabCatalogPage: () => <h1>LabCatalogPage</h1> }));
vi.mock("@/features/lab/pages/LabInboxPage", () => ({ LabInboxPage: () => <h1>LabInboxPage</h1> }));
vi.mock("@/features/help/HelpCenterPage", () => ({ HelpCenterPage: () => <h1>HelpCenterPage</h1> }));
vi.mock("@/features/billing/pages/CashierPage", () => ({ CashierPage: () => <h1>CashierPage</h1> }));
vi.mock("@/features/billing/pages/ServiceCatalogPage", () => ({ ServiceCatalogPage: () => <h1>ServiceCatalogPage</h1> }));
vi.mock("@/features/messaging/pages/MessagesPage", () => ({ MessagesPage: () => <h1>MessagesPage</h1> }));
vi.mock("@/features/reporting/pages/Dhis2ReportPage", () => ({ Dhis2ReportPage: () => <h1>Dhis2ReportPage</h1> }));
vi.mock("@/features/inpatient/pages/BedsBoardPage", () => ({ BedsBoardPage: () => <h1>BedsBoardPage</h1> }));
vi.mock("@/features/inpatient/pages/BedConfigPage", () => ({ BedConfigPage: () => <h1>BedConfigPage</h1> }));
vi.mock("@/features/inpatient/pages/BedReportsPage", () => ({ BedReportsPage: () => <h1>BedReportsPage</h1> }));
vi.mock("@/features/billing/pages/FinancePage", () => ({ FinancePage: () => <h1>FinancePage</h1> }));
vi.mock("@/features/misc/NotFoundPage", () => ({ NotFoundPage: () => <h1>NotFoundPage</h1> }));
vi.mock("@/features/platform/pages/PlatformLoginPage", () => ({ PlatformLoginPage: () => <h1>PlatformLoginPage</h1> }));
vi.mock("@/features/platform/pages/PlatformConsolePage", () => ({ PlatformConsolePage: () => <h1>PlatformConsolePage</h1> }));
vi.mock("@/features/campaign/CampaignPage", () => ({ CampaignPage: () => <h1>CampaignPage</h1> }));
vi.mock("@/features/campaign/RegisterPage", () => ({ CampaignRegisterPage: () => <h1>CampaignRegisterPage</h1> }));

import { AppRoutes } from "@/app/router";
import { setAuth } from "@/test/admin";
import { currentLocation, renderUI } from "@/test/render";

/** [path, page, plan feature that gates it] — the route table as the app declares it. */
const ROUTES: [string, string, string | null][] = [
  ["/c/:code", "CampaignPage", null],
  ["/c/:code/register", "CampaignRegisterPage", null],
  ["/platform/login", "PlatformLoginPage", null],
  ["/platform", "PlatformConsolePage", null],
  ["/login", "LoginPage", null],
  ["/login/:clinic", "LoginPage", null],
  ["/mfa", "MfaPage", null],
  ["/accept-invite", "AcceptInvitePage", null],
  ["/", "DashboardPage", null],
  ["/patients", "PatientsListPage", null],
  ["/patients/new", "PatientRegisterPage", null],
  ["/patients/import", "PatientImportPage", null],
  ["/patients/:id", "PatientProfilePage", null],
  ["/patients/:id/schedule", "PatientSchedulePage", null],
  ["/appointments", "AppointmentsPage", null],
  ["/reception", "ReceptionPage", null],
  ["/cashier", "CashierPage", null],
  ["/finance", "FinancePage", "finance_advanced"],
  ["/billing/services", "ServiceCatalogPage", null],
  ["/messages", "MessagesPage", "messaging"],
  ["/triage", "TriagePage", null],
  ["/queue", "QueuePage", null],
  ["/worklist", "WorklistPage", null],
  ["/notifications", "NotificationsPage", null],
  ["/chairside", "ChairsidePage", null],
  ["/dental/unbilled", "UnbilledPage", null],
  ["/encounter/:queueEntryId", "EncounterWorkspacePage", null],
  ["/pharmacy/queue", "DispenseQueuePage", null],
  ["/pharmacy/dispense/:rxId", "DispensePage", null],
  ["/pharmacy/batches", "BatchesPage", null],
  ["/pharmacy/catalog", "DrugCatalogPage", null],
  ["/pharmacy/otc", "OtcSalePage", null],
  ["/pharmacy/dashboard", "PharmacyDashboardPage", null],
  ["/pharmacy/admin/catalog", "CatalogAdminPage", null],
  ["/pharmacy/purchasing", "PurchasingPage", null],
  ["/pharmacy/stock-control", "StockControlPage", null],
  ["/pharmacy/reports", "ReportsPage", null],
  ["/lab", "LabWorklistPage", null],
  ["/lab/inbox", "LabInboxPage", null],
  ["/lab/items/:itemId", "LabOrderItemPage", null],
  ["/lab/catalog", "LabCatalogPage", null],
  ["/help", "HelpCenterPage", null],
  ["/reporting/dhis2", "Dhis2ReportPage", "dhis2"],
  ["/inpatient/beds", "BedsBoardPage", null],
  ["/inpatient/config", "BedConfigPage", null],
  ["/inpatient/reports", "BedReportsPage", null],
  ["/users", "UsersPage", null],
  ["/settings", "SettingsPage", null],
];

const concrete = (p: string) => p.replace(":id", "pat_1").replace(":code", "abc").replace(":queueEntryId", "q1")
  .replace(":clinic", "cure-dental").replace(":rxId", "rx1").replace(":itemId", "it1");

beforeEach(() => {
  setAuth({ flags: ["dental", "finance_advanced", "messaging", "dhis2"] });
  admin.planUsage.mockResolvedValue({ plan_name: "Chair", features: [] });
});

describe("REG-FE-ROUTER route table", () => {
  test.each(ROUTES)("REG-FE-ROUTER-001 %s renders %s", async (path, page) => {
    renderUI(<AppRoutes />, { route: concrete(path) });
    expect(await screen.findByRole("heading", { name: page })).toBeInTheDocument();
  });

  test("REG-FE-ROUTER-002 an unknown URL is the not-found page, outside the shell", () => {
    renderUI(<AppRoutes />, { route: "/no/such/page" });
    expect(screen.getByRole("heading", { name: "NotFoundPage" })).toBeInTheDocument();
    expect(screen.queryByTestId("shell")).not.toBeInTheDocument();
  });

  test("REG-FE-ROUTER-003 signed out: clinic pages go to sign-in; public pages do not", () => {
    setAuth({ status: "unauthenticated" });
    const r = renderUI(<AppRoutes />, { route: "/settings" });
    expect(screen.getByRole("heading", { name: "LoginPage" })).toBeInTheDocument();
    expect(currentLocation()).toBe("/login");
    r.unmount();
    renderUI(<AppRoutes />, { route: "/c/abc" });
    expect(screen.getByRole("heading", { name: "CampaignPage" })).toBeInTheDocument();
  });

  test("REG-FE-ROUTER-004 while the session is being restored, a clinic page waits", () => {
    setAuth({ status: "loading" });
    renderUI(<AppRoutes />, { route: "/chairside" });
    expect(screen.getByText("Loading…")).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "ChairsidePage" })).not.toBeInTheDocument();
  });

  test.each(["/login", "/login/cure-dental"])("REG-FE-ROUTER-005 %s shares the ClinicOS frame", (route) => {
    const { unmount } = renderUI(<AppRoutes />, { route });
    // The desktop panel and the phone header each carry the wordmark (one is hidden by CSS).
    expect(screen.getAllByText("ClinicOS")).toHaveLength(2);
    expect(screen.getByText("Your clinic's records, private to your clinic.")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "LoginPage" })).toBeInTheDocument();
    unmount();
  });

  test.each(ROUTES.filter((r) => r[2]))("REG-FE-ROUTER-006 %s off the plan: the owner sees the case for it", async (path, page, feature) => {
    setAuth({ flags: ["dental"] });
    admin.planUsage.mockResolvedValue({ plan_name: "Chair", features: [{ code: feature, name: `Feature ${feature}`, category: "x", included: false, on_plans: ["Practice"] }] });
    renderUI(<AppRoutes />, { route: path });
    expect(await screen.findByText(`Feature ${feature}`)).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: page })).not.toBeInTheDocument();
  });

  test("REG-FE-ROUTER-007 off the plan and not the owner: back to the dashboard", async () => {
    setAuth({ flags: ["dental"], perms: ["billing.manage"] });
    renderUI(<AppRoutes />, { route: "/finance" });
    expect(await screen.findByRole("heading", { name: "DashboardPage" })).toBeInTheDocument();
    expect(currentLocation()).toBe("/");
  });
});
