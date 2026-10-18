// The platform super-admin console: the clinic roster and what can be done to a
// clinic from it (provision, suspend, sign in as owner, modules, plan, per-clinic
// features), the plan list and editor, partner leads, and the Verify.ET key. The
// API module is mocked (its wire contract is api.test.ts); the CRM and campaign tabs
// are stubbed, since this file is about the console that hosts them.
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, test, vi } from "vitest";

const m = vi.hoisted(() => ({
  listClinics: vi.fn(), provisionClinic: vi.fn(), suspendClinic: vi.fn(), reactivateClinic: vi.fn(),
  impersonateOwner: vi.fn(), getClinicModules: vi.fn(), setClinicModules: vi.fn(), getClinicPolicies: vi.fn(),
  setClinicPolicies: vi.fn(), listPlans: vi.fn(), createPlan: vi.fn(), updatePlan: vi.fn(), clinicUsage: vi.fn(),
  setClinicPlan: vi.fn(), listPartnerLeads: vi.fn(), setLeadStatus: vi.fn(), getVerifyETKey: vi.fn(),
  setVerifyETKey: vi.fn(), clearVerifyETKey: vi.fn(), listFeatures: vi.fn(), planFeatures: vi.fn(),
  setPlanFeatures: vi.fn(), clinicEntitlements: vi.fn(), setClinicEntitlement: vi.fn(),
  listClinicBranches: vi.fn(), createClinicBranch: vi.fn(),
}));
vi.mock("@/features/platform/api", async (orig) => ({ ...(await orig<object>()), ...m }));
vi.mock("@/app/auth-context", async () => (await import("@/test/admin")).authModule);
vi.mock("@/components/ui/sonner", async (orig) => ({ ...(await orig<object>()), toast: (await import("@/test/admin")).toastSpy }));
vi.mock("@/features/platform/crm/CrmViews", () => ({
  TodayView: ({ canAdmin }: { canAdmin: boolean }) => <div>today-view admin={String(canAdmin)}</div>,
  PipelineView: ({ canAdmin }: { canAdmin: boolean }) => <div>pipeline-view admin={String(canAdmin)}</div>,
  ProspectsView: ({ canAdmin }: { canAdmin: boolean }) => <div>prospects-view admin={String(canAdmin)}</div>,
  TeamView: () => <div>team-view</div>,
}));
vi.mock("@/features/platform/campaign/CampaignAdmin", () => ({ CampaignAdmin: () => <div>campaign-admin</div> }));

import { PlatformConsolePage } from "@/features/platform/pages/PlatformConsolePage";
import type { Clinic, Plan } from "@/features/platform/api";
import { authFns, deferred, resetToasts, setAuth, toastSpy } from "@/test/admin";
import { currentLocation, renderUI } from "@/test/render";

const TOKEN_KEY = "clinicos_platform_token";
const tokenFor = (roles: string[]) => `h.${btoa(JSON.stringify({ roles }))}.s`;

const CLINICS: Clinic[] = [
  { id: "ten_1", name: "Bole Dental", slug: "bole-dental", status: "active", owner_email: "owner@bole.et", owner_phone: "0911223344",
    users: 3, patients: 40, clinic_type: "dental", plan_code: "chair", plan_name: "Chair", created_at: "2026-09-01T00:00:00Z" },
  { id: "ten_2", name: "Piassa General", slug: "piassa", status: "suspended", users: 1, patients: 0,
    clinic_type: "general", plan_code: "starter", created_at: "2026-09-02T00:00:00Z" },
];
const PLANS: Plan[] = [
  { id: "pln_chair", code: "chair", name: "Chair", clinic_type: "dental", branch_limit: 1, user_limit: 4, storage_gb: 20,
    patient_limit: 1500, images_per_patient: 8, price_monthly: "1500", in_use: 1, sms_monthly: 0, status: "active" },
  { id: "pln_starter", code: "starter", name: "Starter", clinic_type: "general", branch_limit: null, user_limit: null,
    storage_gb: null, patient_limit: null, images_per_patient: null, price_monthly: "0", in_use: 1, sms_monthly: null, status: "active" },
  { id: "pln_old", code: "legacy", name: "Legacy", clinic_type: "all", branch_limit: 2, user_limit: 10, storage_gb: 50,
    patient_limit: 5000, images_per_patient: 12, price_monthly: "900", in_use: 0, sms_monthly: 300, status: "retired" },
];
const FEATURES = [
  { code: "ai_assist", name: "AI assist", detail: "Clinical co-pilot", category: "Clinical", clinic_type: "all" },
  { code: "sms", name: "Patient SMS", category: "Messaging", clinic_type: "all" },
];

function signIn(roles = ["platform_admin"]) {
  localStorage.setItem(TOKEN_KEY, tokenFor(roles));
}

function renderConsole() {
  return renderUI(<PlatformConsolePage />, { route: "/platform" });
}

const tab = (name: RegExp | string) => screen.getByRole("button", { name });
const row = (text: string) => screen.getByText(text).closest("tr") as HTMLElement;

/** Open a Radix select (role=combobox) and pick an option by its text. */
async function choose(user: ReturnType<typeof renderUI>["user"], trigger: HTMLElement, option: RegExp | string) {
  await user.click(trigger);
  await user.click(await screen.findByRole("option", { name: option }));
}

beforeEach(() => {
  localStorage.clear();
  setAuth();
  resetToasts();
  Object.values(m).forEach((f) => f.mockReset());
  m.listClinics.mockResolvedValue(CLINICS);
  m.listPlans.mockResolvedValue(PLANS);
  m.listPartnerLeads.mockResolvedValue([]);
  m.getVerifyETKey.mockResolvedValue({ key: "verifyet_api_key", configured: false });
  m.listFeatures.mockResolvedValue(FEATURES);
  m.planFeatures.mockResolvedValue({ configured: false, features: {} });
  m.clinicEntitlements.mockResolvedValue({ plan_name: "Chair", plan_configured: true, from_plan: { ai_assist: true, sms: false }, override: {}, note: {} });
  m.clinicUsage.mockResolvedValue({
    plan_name: "Chair", patients: { used: 40, limit: 1500 }, storage: { used: 5 * 1024 * 1024 * 1024, limit: -1 },
    users: { used: 5, limit: 4 }, branches: { used: 1, limit: 1 },
    storage_gb_override: -1, patient_limit_override: null, user_limit_override: 6, branch_limit_override: null,
  });
  for (const f of [m.suspendClinic, m.reactivateClinic, m.setClinicModules, m.setClinicPolicies, m.setClinicPlan, m.updatePlan,
    m.setLeadStatus, m.clearVerifyETKey, m.setPlanFeatures, m.setClinicEntitlement]) f.mockResolvedValue(undefined);
});

describe("REG-FE-PLAT the console shell", () => {
  test("REG-FE-PLAT-020 without a platform token the console renders nothing and goes to the sign-in page", async () => {
    renderConsole();
    await waitFor(() => expect(currentLocation()).toBe("/platform/login"));
    expect(screen.queryByText("Platform Console")).not.toBeInTheDocument();
    expect(m.listClinics).not.toHaveBeenCalled();
  });

  test("REG-FE-PLAT-021 a super-admin lands on the clinic roster with every console tab", async () => {
    signIn();
    renderConsole();
    expect(await screen.findByText("Bole Dental")).toBeInTheDocument();
    expect(screen.getByText("super-admin")).toBeInTheDocument();
    expect(screen.getByText("2 clinics on the platform.")).toBeInTheDocument();
    for (const t of ["Today", "Pipeline", "Prospects", "Team", "Clinics", "Plans", "Partner leads", "Campaign", "Integrations"]) {
      expect(tab(new RegExp(t))).toBeInTheDocument();
    }
    const bole = row("Bole Dental");
    expect(bole).toHaveTextContent("owner@bole.et");
    expect(bole).toHaveTextContent("0911223344");
    expect(bole).toHaveTextContent("bole-dental");
    expect(bole).toHaveTextContent("Chair");
    expect(within(bole).getByText("active")).toBeInTheDocument();
    expect(within(bole).getByRole("button", { name: "Suspend" })).toBeInTheDocument();
    const piassa = row("Piassa General");
    expect(piassa).toHaveTextContent("—"); // no owner email, no plan name
    expect(within(piassa).getByText("suspended")).toBeInTheDocument();
    expect(within(piassa).getByRole("button", { name: "Reactivate" })).toBeInTheDocument();
  });

  test("REG-FE-PLAT-022 one clinic, no clinics, and still loading each read right", async () => {
    signIn();
    m.listClinics.mockResolvedValueOnce([CLINICS[0]]);
    const a = renderConsole();
    expect(await screen.findByText("1 clinic on the platform.")).toBeInTheDocument();
    a.unmount();

    m.listClinics.mockResolvedValueOnce([]);
    const b = renderConsole();
    expect(await screen.findByText("No clinics yet. Provision the first one.")).toBeInTheDocument();
    expect(screen.getByText("0 clinics on the platform.")).toBeInTheDocument();
    b.unmount();

    m.listClinics.mockReturnValueOnce(new Promise(() => {}));
    renderConsole();
    expect(await screen.findByText("Loading…")).toBeInTheDocument();
    expect(screen.queryByText(/No clinics yet/)).not.toBeInTheDocument();
  });

  test("REG-FE-PLAT-023 an expired platform session (401 clears the token) bounces to the sign-in page", async () => {
    signIn();
    m.listClinics.mockImplementation(async () => {
      localStorage.removeItem(TOKEN_KEY);
      throw new Error("invalid or expired token");
    });
    renderConsole();
    await waitFor(() => expect(currentLocation()).toBe("/platform/login"));
  });

  test.fails("REG-FE-PLAT-024 [UX-1] a roster that fails to load says so instead of claiming there are no clinics", async () => {
    signIn();
    m.listClinics.mockRejectedValue(new Error("Request failed (500)"));
    renderConsole();
    await waitFor(() => expect(m.listClinics).toHaveBeenCalled());
    expect(await screen.findByText(/could not|failed|try again/i, {}, { timeout: 1000 })).toBeInTheDocument();
    expect(screen.queryByText(/No clinics yet/)).not.toBeInTheDocument();
  });

  test("REG-FE-PLAT-025 signing out forgets the platform token and returns to the sign-in page", async () => {
    signIn();
    const { user } = renderConsole();
    await screen.findByText("Bole Dental");
    await user.click(screen.getByRole("button", { name: /Sign out/ }));
    expect(localStorage.getItem(TOKEN_KEY)).toBeNull();
    expect(currentLocation()).toBe("/platform/login");
  });

  test("REG-FE-PLAT-026 a marketing account lands on Today and is shown no tenant controls", async () => {
    signIn(["marketer"]);
    renderConsole();
    expect(await screen.findByText("today-view admin=false")).toBeInTheDocument();
    expect(screen.getByText("marketing")).toBeInTheDocument();
    for (const t of [/New clinic/, /Clinics/, /Plans/, /Partner leads/, /Campaign/, /Integrations/, /Team/]) {
      expect(screen.queryByRole("button", { name: t })).not.toBeInTheDocument();
    }
  });

  test("REG-FE-PLAT-027 the CRM and campaign tabs open their views, with admin rights for a super-admin", async () => {
    signIn();
    const { user } = renderConsole();
    await screen.findByText("Bole Dental");
    await user.click(tab(/Today/));
    expect(screen.getByText("today-view admin=true")).toBeInTheDocument();
    await user.click(tab(/Pipeline/));
    expect(screen.getByText("pipeline-view admin=true")).toBeInTheDocument();
    await user.click(tab(/Prospects/));
    expect(screen.getByText("prospects-view admin=true")).toBeInTheDocument();
    await user.click(tab(/Team/));
    expect(screen.getByText("team-view")).toBeInTheDocument();
    await user.click(tab(/Campaign/));
    expect(screen.getByText("campaign-admin")).toBeInTheDocument();
    await user.click(tab(/Clinics/));
    expect(screen.getByText("Bole Dental")).toBeInTheDocument();
  });
});

describe("REG-FE-PLAT suspend, reactivate, sign in as owner", () => {
  test("REG-FE-PLAT-030 Suspend and Reactivate call the server, confirm, and refresh the roster", async () => {
    signIn();
    const { user } = renderConsole();
    await screen.findByText("Bole Dental");
    await user.click(within(row("Bole Dental")).getByRole("button", { name: "Suspend" }));
    await waitFor(() => expect(m.suspendClinic).toHaveBeenCalledWith("ten_1"));
    await waitFor(() => expect(toastSpy.success).toHaveBeenCalledWith("Clinic updated"));
    await waitFor(() => expect(m.listClinics).toHaveBeenCalledTimes(2));
    await user.click(within(row("Piassa General")).getByRole("button", { name: "Reactivate" }));
    await waitFor(() => expect(m.reactivateClinic).toHaveBeenCalledWith("ten_2"));
  });

  test("REG-FE-PLAT-031 a refused suspension is shown to the operator", async () => {
    signIn();
    m.suspendClinic.mockRejectedValue(new Error("clinic not found"));
    const { user } = renderConsole();
    await screen.findByText("Bole Dental");
    await user.click(within(row("Bole Dental")).getByRole("button", { name: "Suspend" }));
    await waitFor(() => expect(toastSpy.error).toHaveBeenCalledWith("clinic not found"));
    m.reactivateClinic.mockRejectedValue("boom");
    await user.click(within(row("Piassa General")).getByRole("button", { name: "Reactivate" }));
    await waitFor(() => expect(toastSpy.error).toHaveBeenCalledWith("Failed"));
  });

  test.fails("REG-FE-PLAT-032 [NEW-FE-PLAT-1] Suspend asks before locking a whole clinic out", async () => {
    signIn();
    const { user } = renderConsole();
    await screen.findByText("Bole Dental");
    await user.click(within(row("Bole Dental")).getByRole("button", { name: "Suspend" }));
    expect(screen.getByRole("dialog")).toHaveTextContent(/suspend/i);
    expect(m.suspendClinic).not.toHaveBeenCalled();
  });

  test("REG-FE-PLAT-033 Sign in as owner asks first, then hands the owner's token to the app and opens it", async () => {
    signIn();
    const user0 = { id: "usr_o", tenant_id: "ten_1", email: "owner@bole.et", full_name: "Hanna Desta", roles: ["tenant_owner"] };
    m.impersonateOwner.mockResolvedValue({ access_token: "tenant-tok", expires_in: 900, workspace_slug: "bole-dental", user: user0 });
    const { user } = renderConsole();
    await screen.findByText("Bole Dental");
    await user.click(within(row("Bole Dental")).getByRole("button", { name: "Sign in as owner" }));
    const dlg = screen.getByRole("dialog");
    expect(dlg).toHaveTextContent('Sign in as the owner of "Bole Dental"?');
    expect(m.impersonateOwner).not.toHaveBeenCalled();
    await user.click(within(dlg).getByRole("button", { name: "Sign in as owner" }));
    await waitFor(() => expect(authFns.signIn).toHaveBeenCalledWith("tenant-tok", user0));
    expect(m.impersonateOwner).toHaveBeenCalledWith("ten_1");
    expect(toastSpy.success).toHaveBeenCalledWith("Signed in as Hanna Desta");
    await waitFor(() => expect(currentLocation()).toBe("/"));
  });

  test("REG-FE-PLAT-034 owner sign-in: Cancel does nothing; a refusal is shown; the greeting falls back to the email", async () => {
    signIn();
    const { user } = renderConsole();
    await screen.findByText("Bole Dental");
    const start = async () => {
      await user.click(within(row("Piassa General")).getByRole("button", { name: "Sign in as owner" }));
      return screen.getByRole("dialog");
    };
    await user.click(within(await start()).getByRole("button", { name: "Cancel" }));
    expect(m.impersonateOwner).not.toHaveBeenCalled();

    m.impersonateOwner.mockRejectedValueOnce(new Error("this clinic has no active owner to sign in as"));
    await user.click(within(await start()).getByRole("button", { name: "Sign in as owner" }));
    await waitFor(() => expect(toastSpy.error).toHaveBeenCalledWith("this clinic has no active owner to sign in as"));
    expect(authFns.signIn).not.toHaveBeenCalled();

    m.impersonateOwner.mockRejectedValueOnce(42);
    await user.click(within(await start()).getByRole("button", { name: "Sign in as owner" }));
    await waitFor(() => expect(toastSpy.error).toHaveBeenCalledWith("Could not sign in as owner"));

    m.impersonateOwner.mockResolvedValueOnce({ access_token: "t", expires_in: 1, workspace_slug: "s", user: { id: "u", tenant_id: "t", email: "e@x", full_name: "", roles: [] } });
    await user.click(within(await start()).getByRole("button", { name: "Sign in as owner" }));
    await waitFor(() => expect(toastSpy.success).toHaveBeenCalledWith("Signed in as e@x"));
  });
});

describe("REG-FE-PLAT provisioning a clinic", () => {
  async function openCreate() {
    signIn();
    const r = renderConsole();
    await screen.findByText("Bole Dental");
    await r.user.click(screen.getByRole("button", { name: /New clinic/ }));
    const dlg = await screen.findByRole("dialog");
    return { ...r, dlg };
  }
  const provisionBtn = (dlg: HTMLElement) => within(dlg).getByRole("button", { name: "Provision clinic" });

  test("REG-FE-PLAT-040 Provision stays disabled until clinic name, owner name and owner email are given; the workspace is derived from the name", async () => {
    const { dlg, user } = await openCreate();
    expect(provisionBtn(dlg)).toBeDisabled();
    await user.type(within(dlg).getByPlaceholderText("Bole Family Clinic"), "Kazanchis Family Clinic!");
    expect(within(dlg).getByPlaceholderText("kazanchis-family-clinic")).toBeInTheDocument();
    expect(provisionBtn(dlg)).toBeDisabled();
    await user.type(within(dlg).getByPlaceholderText("Dr. Sara Ahmed"), "Dr. Abebe");
    expect(provisionBtn(dlg)).toBeDisabled();
    await user.type(within(dlg).getByPlaceholderText("owner@bolefamily.clinic"), "abebe@kfc.et");
    expect(provisionBtn(dlg)).toBeEnabled();
  });

  test("REG-FE-PLAT-041 a general clinic sends its modules as toggled, the derived workspace and the first general plan, then shows the owner's credentials", async () => {
    m.provisionClinic.mockResolvedValue({ clinic: CLINICS[1], owner_email: "abebe@kfc.et", temp_password: "Cl1-temp", workspace_slug: "kazanchis" });
    const { dlg, user } = await openCreate();
    expect(within(dlg).getByText(/standard reception → triage/)).toBeInTheDocument();
    await waitFor(() => expect(within(dlg).getAllByRole("combobox")[1]).toHaveTextContent("Starter"));
    await user.type(within(dlg).getByPlaceholderText("Bole Family Clinic"), "Kazanchis");
    await user.type(within(dlg).getByPlaceholderText("Dr. Sara Ahmed"), "Dr. Abebe");
    await user.type(within(dlg).getByPlaceholderText("owner@bolefamily.clinic"), "abebe@kfc.et");
    await user.type(within(dlg).getByPlaceholderText("09…"), "0911000000");
    await user.click(within(dlg).getByRole("button", { name: "Pharmacy" }));
    await user.click(provisionBtn(dlg));
    await waitFor(() => expect(m.provisionClinic).toHaveBeenCalledWith({
      clinic_name: "Kazanchis", slug: "kazanchis", owner_name: "Dr. Abebe", owner_email: "abebe@kfc.et", owner_phone: "0911000000",
      clinic_type: "general", plan_code: "starter", modules: { laboratory: true, pharmacy: false },
    }));
    const creds = await screen.findByRole("dialog", { name: /Clinic ready/ });
    expect(creds).toHaveTextContent("kazanchis");
    expect(creds).toHaveTextContent("abebe@kfc.et");
    expect(creds).toHaveTextContent("Cl1-temp");
    await waitFor(() => expect(m.listClinics).toHaveBeenCalledTimes(2));
  });

  test("REG-FE-PLAT-042 choosing Dental fixes the dental preset and offers only dental or universal plans", async () => {
    m.provisionClinic.mockResolvedValue({ clinic: CLINICS[0], owner_email: "o@d.et", workspace_slug: "smile" });
    const { dlg, user } = await openCreate();
    await choose(user, within(dlg).getAllByRole("combobox")[0], "Dental clinic");
    expect(within(dlg).getByText(/Dental module on · Lab, pharmacy and inventory off/)).toBeInTheDocument();
    expect(within(dlg).queryByRole("button", { name: "Pharmacy" })).not.toBeInTheDocument();
    await waitFor(() => expect(within(dlg).getAllByRole("combobox")[1]).toHaveTextContent("Chair · 1,500 ETB/mo"));
    await user.click(within(dlg).getAllByRole("combobox")[1]);
    const offered = (await screen.findAllByRole("option")).map((o) => o.textContent);
    expect(offered.some((o) => o?.startsWith("Starter"))).toBe(false);
    await user.keyboard("{Escape}");
    await user.type(within(dlg).getByPlaceholderText("Bole Family Clinic"), "Smile");
    await user.type(within(dlg).getByPlaceholderText("smile"), "smile-dental");
    await user.type(within(dlg).getByPlaceholderText("Dr. Sara Ahmed"), "Dr. Sara");
    await user.type(within(dlg).getByPlaceholderText("owner@bolefamily.clinic"), "o@d.et");
    await user.click(provisionBtn(dlg));
    await waitFor(() => expect(m.provisionClinic).toHaveBeenCalledWith(expect.objectContaining({
      slug: "smile-dental", clinic_type: "dental", plan_code: "chair",
      modules: { dental: true, laboratory: false, pharmacy: false, inventory: false },
    })));
    // No temporary password when the operator set it themselves.
    expect(await screen.findByText("(set by you)")).toBeInTheDocument();
  });

  test.fails("REG-FE-PLAT-043 [NEW-PLAT-1] a retired plan is never offered to a new clinic", async () => {
    const { dlg, user } = await openCreate();
    await waitFor(() => expect(within(dlg).getAllByRole("combobox")[1]).toHaveTextContent("Starter"));
    await user.click(within(dlg).getAllByRole("combobox")[1]);
    const offered = (await screen.findAllByRole("option")).map((o) => o.textContent ?? "");
    expect(offered.some((o) => o.startsWith("Legacy"))).toBe(false);
  });

  test("REG-FE-PLAT-044 a refused provisioning is shown and the form stays open; Cancel closes it", async () => {
    m.provisionClinic.mockRejectedValueOnce(new Error("that workspace already exists — choose another"));
    const { dlg, user } = await openCreate();
    await user.type(within(dlg).getByPlaceholderText("Bole Family Clinic"), "Bole");
    await user.type(within(dlg).getByPlaceholderText("Dr. Sara Ahmed"), "O");
    await user.type(within(dlg).getByPlaceholderText("owner@bolefamily.clinic"), "o@b.et");
    await user.click(provisionBtn(dlg));
    await waitFor(() => expect(toastSpy.error).toHaveBeenCalledWith("that workspace already exists — choose another"));
    expect(screen.getByRole("dialog", { name: "Provision a clinic" })).toBeInTheDocument();
    m.provisionClinic.mockRejectedValueOnce("x");
    await user.click(provisionBtn(dlg));
    await waitFor(() => expect(toastSpy.error).toHaveBeenCalledWith("Could not provision"));
    await user.click(within(dlg).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
  });

  test("REG-FE-PLAT-045 the credentials can be copied one by one and the dialog closes on Done", async () => {
    m.provisionClinic.mockResolvedValue({ clinic: CLINICS[1], owner_email: "o@k.et", temp_password: "Cl1-xyz", workspace_slug: "kz" });
    const { dlg, user } = await openCreate();
    // After user-event's setup, which installs its own clipboard stub.
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    await user.type(within(dlg).getByPlaceholderText("Bole Family Clinic"), "Kz");
    await user.type(within(dlg).getByPlaceholderText("Dr. Sara Ahmed"), "O");
    await user.type(within(dlg).getByPlaceholderText("owner@bolefamily.clinic"), "o@k.et");
    await user.click(provisionBtn(dlg));
    const creds = await screen.findByRole("dialog", { name: /Clinic ready/ });
    const copyButtons = within(creds).getAllByRole("button").filter((b) => b.textContent === "");
    for (const b of copyButtons) fireEvent.click(b);
    expect(writeText.mock.calls.map((c) => c[0])).toEqual(expect.arrayContaining(["kz", "o@k.et", "Cl1-xyz"]));
    expect(toastSpy.success).toHaveBeenCalledWith("Copied");
    await user.click(within(creds).getByRole("button", { name: "Done" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
  });
});

describe("REG-FE-PLAT a clinic's modules and plan", () => {
  test("REG-FE-PLAT-050 Modules shows the clinic's modules and policies and saves both together", async () => {
    signIn();
    m.getClinicModules.mockResolvedValue([{ key: "laboratory", label: "Laboratory", enabled: true }, { key: "dental", label: "Dental", enabled: false }]);
    m.getClinicPolicies.mockResolvedValue([{ key: "doctor_registers_patients", label: "Doctors can register patients", help: "For a clinic with no front desk.", enabled: false }]);
    const { user } = renderConsole();
    await screen.findByText("Bole Dental");
    await user.click(within(row("Bole Dental")).getByRole("button", { name: "Modules" }));
    const dlg = await screen.findByRole("dialog", { name: /Setup — Bole Dental/ });
    expect(await within(dlg).findByText("For a clinic with no front desk.")).toBeInTheDocument();
    await user.click(within(dlg).getByRole("button", { name: "Laboratory" }));
    await user.click(within(dlg).getByRole("button", { name: "Dental" }));
    await user.click(within(dlg).getByRole("button", { name: "Doctors can register patients" }));
    await user.click(within(dlg).getByRole("button", { name: "Save" }));
    await waitFor(() => expect(m.setClinicPolicies).toHaveBeenCalledWith("ten_1", { doctor_registers_patients: true }));
    expect(m.setClinicModules).toHaveBeenCalledWith("ten_1", { laboratory: false, dental: true });
    expect(toastSpy.success).toHaveBeenCalledWith("Saved — takes effect on the clinic's next login");
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
  });

  test("REG-FE-PLAT-051 Modules: a failed save is shown; Cancel closes without saving", async () => {
    signIn();
    m.getClinicModules.mockResolvedValue([{ key: "laboratory", label: "Laboratory", enabled: true }]);
    m.getClinicPolicies.mockResolvedValue([]);
    m.setClinicModules.mockRejectedValueOnce(new Error("nope")).mockRejectedValueOnce("x");
    const { user } = renderConsole();
    await screen.findByText("Bole Dental");
    await user.click(within(row("Bole Dental")).getByRole("button", { name: "Modules" }));
    const dlg = await screen.findByRole("dialog");
    await user.click(within(dlg).getByRole("button", { name: "Save" }));
    await waitFor(() => expect(toastSpy.error).toHaveBeenCalledWith("nope"));
    await user.click(within(dlg).getByRole("button", { name: "Save" }));
    await waitFor(() => expect(toastSpy.error).toHaveBeenCalledWith("Could not update"));
    await user.click(within(dlg).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(m.setClinicPolicies).not.toHaveBeenCalled();
  });

  test("REG-FE-PLAT-052 Plan shows usage against caps, offers only plans for the clinic's type, and prefills its overrides", async () => {
    signIn();
    const { user } = renderConsole();
    await screen.findByText("Bole Dental");
    await user.click(within(row("Bole Dental")).getByRole("button", { name: "Plan" }));
    const dlg = await screen.findByRole("dialog", { name: /Plan — Bole Dental/ });
    expect(await within(dlg).findByText("40 / 1,500")).toBeInTheDocument();
    expect(within(dlg).getByText("5.0 GB / ∞")).toBeInTheDocument();
    expect(within(dlg).getByText("5 / 4")).toHaveClass("text-rose-600"); // over its user cap
    expect(within(dlg).getByText("1 / 1")).not.toHaveClass("text-rose-600");
    const plan = within(dlg).getAllByRole("combobox")[0];
    await waitFor(() => expect(plan).toHaveTextContent("Chair"));
    await user.click(plan);
    const offered = (await screen.findAllByRole("option")).map((o) => o.textContent);
    expect(offered).toEqual(["Chair", "Legacy · universal"]);
    await user.keyboard("{Escape}");
    const ov = within(dlg).getAllByPlaceholderText("Use plan");
    expect(ov.map((i) => (i as HTMLInputElement).value)).toEqual(["", "unlimited", "6", ""]);
  });

  test("REG-FE-PLAT-053 saving a plan sends the chosen plan with each override parsed (blank inherits, unlimited is -1)", async () => {
    signIn();
    const { user } = renderConsole();
    await screen.findByText("Bole Dental");
    await user.click(within(row("Bole Dental")).getByRole("button", { name: "Plan" }));
    const dlg = await screen.findByRole("dialog", { name: /Plan — Bole Dental/ });
    await within(dlg).findByText("40 / 1,500");
    const ov = within(dlg).getAllByPlaceholderText("Use plan");
    await user.type(ov[0], "250");
    await user.clear(ov[1]);
    await user.type(ov[1], "∞");
    await user.clear(ov[2]);
    await user.type(ov[3], "lots");
    await user.click(within(dlg).getByRole("button", { name: "Save" }));
    await waitFor(() => expect(m.setClinicPlan).toHaveBeenCalledWith("ten_1", {
      plan_id: "pln_chair", patient_limit_override: 250, storage_gb_override: -1, user_limit_override: null, branch_limit_override: null,
    }));
    expect(toastSpy.success).toHaveBeenCalledWith("Plan updated for this clinic");
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
  });

  test("REG-FE-PLAT-054 a refused plan change is shown; Cancel closes", async () => {
    signIn();
    m.setClinicPlan.mockRejectedValueOnce(new Error("that plan has been retired — pick a current one")).mockRejectedValueOnce(0);
    m.clinicUsage.mockResolvedValue({
      plan_name: "Starter", patients: { used: 0, limit: -1 }, storage: { used: 512, limit: 2048 }, users: { used: 1, limit: -1 },
      branches: { used: 1, limit: -1 }, storage_gb_override: null, patient_limit_override: null, user_limit_override: null, branch_limit_override: null,
    });
    const { user } = renderConsole();
    await screen.findByText("Piassa General");
    await user.click(within(row("Piassa General")).getByRole("button", { name: "Plan" }));
    const dlg = await screen.findByRole("dialog", { name: /Plan — Piassa General/ });
    expect(await within(dlg).findByText("512 B / 2 KB")).toBeInTheDocument();
    await choose(user, within(dlg).getAllByRole("combobox")[0], "Legacy · universal");
    await user.click(within(dlg).getByRole("button", { name: "Save" }));
    await waitFor(() => expect(toastSpy.error).toHaveBeenCalledWith("that plan has been retired — pick a current one"));
    expect(m.setClinicPlan).toHaveBeenCalledWith("ten_2", expect.objectContaining({ plan_id: "pln_old" }));
    await user.click(within(dlg).getByRole("button", { name: "Save" }));
    await waitFor(() => expect(toastSpy.error).toHaveBeenCalledWith("Could not update the plan"));
    await user.click(within(dlg).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
  });

  test("REG-FE-PLAT-055 per-clinic features show the plan's answer and any exception, and each change saves on its own", async () => {
    signIn();
    m.clinicEntitlements.mockResolvedValue({
      plan_name: "Chair", plan_configured: true, from_plan: { ai_assist: true, sms: false },
      override: { sms: true }, note: { sms: "sold as add-on" },
    });
    const { user } = renderConsole();
    await screen.findByText("Bole Dental");
    await user.click(within(row("Bole Dental")).getByRole("button", { name: "Plan" }));
    const dlg = await screen.findByRole("dialog", { name: /Plan — Bole Dental/ });
    expect(await within(dlg).findByText("on Chair")).toBeInTheDocument();
    expect(within(dlg).getByText("included in the plan")).toBeInTheDocument();
    expect(within(dlg).getByText("not in the plan · added for this clinic · sold as add-on")).toBeInTheDocument();
    const aiRow = within(dlg).getByText("AI assist").closest("div.flex") as HTMLElement;
    const smsRow = within(dlg).getByText("Patient SMS").closest("div.flex") as HTMLElement;
    expect(within(aiRow).getByRole("combobox")).toHaveTextContent("Follow plan");
    expect(within(smsRow).getByRole("combobox")).toHaveTextContent("Add on");
    await choose(user, within(aiRow).getByRole("combobox"), "Withdraw");
    await waitFor(() => expect(m.setClinicEntitlement).toHaveBeenCalledWith("ten_1", "ai_assist", false, "set from the console"));
    expect(toastSpy.success).toHaveBeenCalledWith("Saved");
    await choose(user, within(smsRow).getByRole("combobox"), "Follow plan");
    await waitFor(() => expect(m.setClinicEntitlement).toHaveBeenCalledWith("ten_1", "sms", null, ""));
    m.setClinicEntitlement.mockRejectedValueOnce(new Error("unknown feature")).mockRejectedValueOnce(null);
    await choose(user, within(aiRow).getByRole("combobox"), "Add on");
    await waitFor(() => expect(toastSpy.error).toHaveBeenCalledWith("unknown feature"));
    await choose(user, within(aiRow).getByRole("combobox"), "Add on");
    await waitFor(() => expect(toastSpy.error).toHaveBeenCalledWith("Could not save it"));
  });

  test("REG-FE-PLAT-056 a clinic whose plan has no feature list is told an exception has nothing to be an exception to", async () => {
    signIn();
    m.clinicEntitlements.mockResolvedValue({ plan_name: "Chair", plan_configured: false, from_plan: {}, override: { ai_assist: false }, note: {} });
    const { user } = renderConsole();
    await screen.findByText("Bole Dental");
    await user.click(within(row("Bole Dental")).getByRole("button", { name: "Plan" }));
    const dlg = await screen.findByRole("dialog");
    expect(await within(dlg).findByText(/This plan has no feature list/)).toBeInTheDocument();
    expect(within(dlg).getByText("not in the plan · withdrawn from this clinic")).toBeInTheDocument();
    expect(within(dlg).getByText("AI assist")).toHaveClass("text-muted-foreground");
  });

  test("REG-FE-PLAT-057 per-clinic features: nothing is drawn when the entitlements cannot be read", async () => {
    signIn();
    m.clinicEntitlements.mockRejectedValue(new Error("clinic not found"));
    const { user } = renderConsole();
    await screen.findByText("Bole Dental");
    await user.click(within(row("Bole Dental")).getByRole("button", { name: "Plan" }));
    const dlg = await screen.findByRole("dialog");
    await within(dlg).findByText("40 / 1,500");
    await waitFor(() => expect(m.clinicEntitlements).toHaveBeenCalled());
    await waitFor(() => expect(within(dlg).queryByText(/Features/)).not.toBeInTheDocument());
  });
});

describe("REG-FE-PLAT plans", () => {
  async function openPlans() {
    signIn();
    const r = renderConsole();
    await screen.findByText("Bole Dental");
    await r.user.click(tab(/Plans/));
    await screen.findByText("3 plans. Limits apply to every clinic on the plan.");
    return r;
  }

  test("REG-FE-PLAT-060 the plan list shows each plan's type, limits (blank = unlimited), SMS, price and clinics on it", async () => {
    await openPlans();
    const chair = row("Chair");
    expect(chair).toHaveTextContent("Dental");
    expect(chair).toHaveTextContent("1,500");
    expect(chair).toHaveTextContent("20 GB");
    expect(chair).toHaveTextContent("—"); // SMS 0 = none included
    expect(chair).toHaveTextContent("1,500 ETB");
    const starter = row("Starter");
    expect(within(starter).getAllByText("Unlimited")).toHaveLength(5);
    expect(starter).toHaveTextContent("General");
    expect(starter).toHaveTextContent("0 ETB");
    const legacy = row("Legacy");
    expect(within(legacy).getByText("retired")).toBeInTheDocument();
    expect(legacy).toHaveTextContent("All clinic types");
    expect(legacy).toHaveTextContent("300");
  });

  test("REG-FE-PLAT-061 one plan, and no plans, read right", async () => {
    signIn();
    m.listPlans.mockResolvedValueOnce([]);
    const { user } = renderConsole();
    await screen.findByText("Bole Dental");
    await user.click(tab(/Plans/));
    expect(await screen.findByText("No plans yet.")).toBeInTheDocument();
    expect(screen.getByText(/0 plans\./)).toBeInTheDocument();
  });

  test("REG-FE-PLAT-062 New plan needs a code and a name, and sends blank limits as unlimited and a blank price as 0", async () => {
    m.createPlan.mockResolvedValue(PLANS[0]);
    const { user } = await openPlans();
    await user.click(screen.getByRole("button", { name: /New plan/ }));
    const dlg = await screen.findByRole("dialog", { name: "New plan" });
    const create = within(dlg).getByRole("button", { name: "Create" });
    expect(create).toBeDisabled();
    await user.type(within(dlg).getByPlaceholderText("starter"), "clinic-plus");
    expect(create).toBeDisabled();
    await user.type(within(dlg).getByPlaceholderText("Starter"), "  Clinic Plus ");
    expect(create).toBeEnabled();
    const nums = within(dlg).getAllByPlaceholderText("Unlimited");
    await user.type(nums[0], "2000");
    await user.type(nums[2], "6");
    await choose(user, within(dlg).getByRole("combobox"), "General");
    await user.click(create);
    await waitFor(() => expect(m.createPlan).toHaveBeenCalledWith({
      code: "clinic-plus", name: "Clinic Plus", clinic_type: "general", patient_limit: 2000, storage_gb: null, user_limit: 6,
      branch_limit: null, images_per_patient: null, sms_monthly: null, price_monthly: "0",
    }));
    expect(toastSpy.success).toHaveBeenCalledWith("Plan created");
    await waitFor(() => expect(m.listPlans).toHaveBeenCalledTimes(2));
  });

  test("REG-FE-PLAT-063 Edit prefills the plan, hides the code, and saves without it; a refusal is shown", async () => {
    const { user } = await openPlans();
    await user.click(within(row("Chair")).getByRole("button", { name: /Edit/ }));
    const dlg = await screen.findByRole("dialog", { name: "Edit Chair" });
    expect(within(dlg).queryByPlaceholderText("starter")).not.toBeInTheDocument();
    expect(within(dlg).getByPlaceholderText("Starter")).toHaveValue("Chair");
    const nums = within(dlg).getAllByPlaceholderText("Unlimited");
    expect(nums.map((i) => (i as HTMLInputElement).value)).toEqual(["1500", "20", "4", "1", "8", "0"]);
    expect(within(dlg).getByPlaceholderText("0")).toHaveValue(1500);
    await user.clear(nums[1]);
    await user.type(within(dlg).getByPlaceholderText("0"), "0");
    await user.click(within(dlg).getByRole("button", { name: "Save" }));
    await waitFor(() => expect(m.updatePlan).toHaveBeenCalledWith("pln_chair", {
      name: "Chair", clinic_type: "dental", patient_limit: 1500, storage_gb: null, user_limit: 4, branch_limit: 1,
      images_per_patient: 8, sms_monthly: 0, price_monthly: "15000",
    }));
    expect(toastSpy.success).toHaveBeenCalledWith("Plan updated");

    m.updatePlan.mockRejectedValueOnce(new Error("plan name is required")).mockRejectedValueOnce(undefined);
    await user.click(within(row("Starter")).getByRole("button", { name: /Edit/ }));
    const d2 = await screen.findByRole("dialog", { name: "Edit Starter" });
    expect(within(d2).getAllByPlaceholderText("Unlimited").map((i) => (i as HTMLInputElement).value)).toEqual(["", "", "", "", "", ""]);
    await user.click(within(d2).getByRole("button", { name: "Save" }));
    await waitFor(() => expect(toastSpy.error).toHaveBeenCalledWith("plan name is required"));
    await user.click(within(d2).getByRole("button", { name: "Save" }));
    await waitFor(() => expect(toastSpy.error).toHaveBeenCalledWith("Could not save the plan"));
    await user.click(within(d2).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
  });

  test("REG-FE-PLAT-064 an undescribed plan arrives with every feature ticked and a warning; saving keeps it that way", async () => {
    const { user } = await openPlans();
    await user.click(within(row("Chair")).getByRole("button", { name: /Edit/ }));
    const dlg = await screen.findByRole("dialog", { name: "Edit Chair" });
    expect(await within(dlg).findByText(/never been described, so it currently gates nothing/)).toBeInTheDocument();
    expect(within(dlg).getByText("Clinical co-pilot")).toBeInTheDocument();
    const boxes = within(dlg).getAllByRole("checkbox");
    expect(boxes.every((b) => (b as HTMLInputElement).checked)).toBe(true);
    await user.click(within(dlg).getByRole("button", { name: "Save features" }));
    await waitFor(() => expect(m.setPlanFeatures).toHaveBeenCalledWith("pln_chair", { ai_assist: true, sms: true }));
    expect(toastSpy.success).toHaveBeenCalledWith("Plan features saved");
  });

  test("REG-FE-PLAT-065 a described plan shows what it includes; Save features is enabled only after a change; a refusal is shown", async () => {
    m.planFeatures.mockResolvedValue({ configured: true, features: { ai_assist: true } });
    m.setPlanFeatures.mockRejectedValueOnce(new Error("plan not found")).mockRejectedValueOnce(1);
    const { user } = await openPlans();
    await user.click(within(row("Chair")).getByRole("button", { name: /Edit/ }));
    const dlg = await screen.findByRole("dialog", { name: "Edit Chair" });
    const save = await within(dlg).findByRole("button", { name: "Save features" });
    expect(within(dlg).queryByText(/never been described/)).not.toBeInTheDocument();
    const [ai, sms] = within(dlg).getAllByRole("checkbox") as HTMLInputElement[];
    expect(ai.checked).toBe(true);
    expect(sms.checked).toBe(false);
    expect(save).toBeDisabled();
    await user.click(sms);
    expect(save).toBeEnabled();
    await user.click(save);
    await waitFor(() => expect(toastSpy.error).toHaveBeenCalledWith("plan not found"));
    expect(m.setPlanFeatures).toHaveBeenCalledWith("pln_chair", { ai_assist: true, sms: true });
    await user.click(save);
    await waitFor(() => expect(toastSpy.error).toHaveBeenCalledWith("Could not save the features"));
  });

  test("REG-FE-PLAT-066 the feature grid shows a placeholder while it loads", async () => {
    m.listFeatures.mockReturnValue(new Promise(() => {}));
    const { user } = await openPlans();
    await user.click(within(row("Chair")).getByRole("button", { name: /Edit/ }));
    const dlg = await screen.findByRole("dialog", { name: "Edit Chair" });
    expect(within(dlg).queryByRole("button", { name: "Save features" })).not.toBeInTheDocument();
    expect(within(dlg).queryAllByRole("checkbox")).toHaveLength(0);
  });
});

describe("REG-FE-PLAT partner leads", () => {
  const LEADS = [
    { id: "prl_1", name: "Abebe Kebede", phone: "0911", email: "a@k.et", region: "Addis", audience: "influencer",
      clinics_estimate: "5-10", goal: "Earn on referrals", source: "partners/abebe", status: "new", created_at: "2026-09-30T08:00:00Z" },
    { id: "prl_2", name: "Sara T", audience: "mystery", status: "contacted", created_at: "2026-09-29T08:00:00Z" },
  ];

  test("REG-FE-PLAT-070 lists each registration with contact, audience, estimate and source, and counts the new ones", async () => {
    signIn();
    m.listPartnerLeads.mockResolvedValue(LEADS);
    const { user } = renderConsole();
    await screen.findByText("Bole Dental");
    await user.click(tab(/Partner leads/));
    expect(await screen.findByText("Abebe Kebede")).toBeInTheDocument();
    expect(screen.getByText(/2 registrations/)).toHaveTextContent("2 registrations · 1 new.");
    const a = row("Abebe Kebede");
    expect(a).toHaveTextContent("0911 · a@k.et");
    expect(a).toHaveTextContent("Addis");
    expect(a).toHaveTextContent("“Earn on referrals”");
    expect(a).toHaveTextContent("Influencer");
    expect(a).toHaveTextContent("5-10");
    expect(a).toHaveTextContent("partners/abebe");
    const s = row("Sara T");
    expect(s).toHaveTextContent("mystery"); // an audience the console has no label for is shown as sent
    expect(within(s).getByRole("combobox")).toHaveValue("contacted");
  });

  test("REG-FE-PLAT-071 changing a lead's status saves it; a refusal is shown", async () => {
    signIn();
    m.listPartnerLeads.mockResolvedValue(LEADS);
    m.setLeadStatus.mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error("lead not found")).mockRejectedValueOnce(null);
    const { user } = renderConsole();
    await screen.findByText("Bole Dental");
    await user.click(tab(/Partner leads/));
    const sel = within(await screen.findByText("Abebe Kebede").then((e) => e.closest("tr") as HTMLElement)).getByRole("combobox");
    await user.selectOptions(sel, "signed");
    await waitFor(() => expect(m.setLeadStatus).toHaveBeenCalledWith("prl_1", "signed"));
    await waitFor(() => expect(m.listPartnerLeads).toHaveBeenCalledTimes(2));
    await user.selectOptions(sel, "archived");
    await waitFor(() => expect(toastSpy.error).toHaveBeenCalledWith("lead not found"));
    await user.selectOptions(sel, "contacted");
    await waitFor(() => expect(toastSpy.error).toHaveBeenCalledWith("Could not update lead"));
  });

  test("REG-FE-PLAT-072 one lead, no leads, and loading each read right", async () => {
    signIn();
    m.listPartnerLeads.mockResolvedValueOnce([{ ...LEADS[1], status: "signed" }]);
    const a = renderConsole();
    await screen.findByText("Bole Dental");
    await a.user.click(tab(/Partner leads/));
    expect(await screen.findByText(/1 registration\./)).toBeInTheDocument();
    expect(row("Sara T")).toHaveTextContent("—");
    a.unmount();

    m.listPartnerLeads.mockResolvedValueOnce([]);
    const b = renderConsole();
    await screen.findByText("Bole Dental");
    await b.user.click(tab(/Partner leads/));
    expect(await screen.findByText(/No leads yet/)).toBeInTheDocument();
    b.unmount();

    m.listPartnerLeads.mockReturnValueOnce(new Promise(() => {}));
    const c = renderConsole();
    await screen.findByText("Bole Dental");
    await c.user.click(tab(/Partner leads/));
    expect(await screen.findByText("Loading…")).toBeInTheDocument();
  });
});

describe("REG-FE-PLAT the Verify.ET key", () => {
  async function openIntegrations() {
    signIn();
    const r = renderConsole();
    await screen.findByText("Bole Dental");
    await r.user.click(tab(/Integrations/));
    await screen.findByText("Verify.ET — receipt verification");
    return r;
  }

  test("REG-FE-PLAT-080 no key: Not configured; the key field is masked; Save is disabled until something is typed and sends it trimmed", async () => {
    const d = deferred<{ key: string; configured: boolean; hint: string }>();
    m.setVerifyETKey.mockReturnValue(d.promise);
    const { user } = await openIntegrations();
    expect(await screen.findByText("Not configured")).toBeInTheDocument();
    expect(screen.getByText("Paste the key")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Remove" })).not.toBeInTheDocument();
    const input = screen.getByLabelText("Paste the key");
    expect(input).toHaveAttribute("type", "password");
    expect(input).toHaveAttribute("autocomplete", "off");
    const save = screen.getByRole("button", { name: "Save key" });
    expect(save).toBeDisabled();
    await user.type(input, "   ");
    expect(save).toBeDisabled();
    await user.type(input, "VERIFY_BANK_ET_secret_a3f9  ");
    await user.click(save);
    expect(m.setVerifyETKey).toHaveBeenCalledWith("VERIFY_BANK_ET_secret_a3f9");
    expect(await screen.findByRole("button", { name: "Saving…" })).toBeDisabled();
    m.getVerifyETKey.mockResolvedValue({ key: "verifyet_api_key", configured: true, hint: "…a3f9" });
    d.resolve({ key: "verifyet_api_key", configured: true, hint: "…a3f9" });
    await waitFor(() => expect(input).toHaveValue(""));
    expect(await screen.findByText("Live")).toBeInTheDocument();
  });

  test("REG-FE-PLAT-081 a loaded key shows only its last four characters and when it was saved; Remove clears it", async () => {
    m.getVerifyETKey.mockResolvedValue({ key: "verifyet_api_key", configured: true, hint: "…a3f9", updated_at: "2026-10-01T09:00:00Z", source: "saved" });
    const { user, container } = await openIntegrations();
    expect(await screen.findByText("Live")).toBeInTheDocument();
    expect(screen.getByText("…a3f9")).toBeInTheDocument();
    expect(screen.getByText(/saved/)).toBeInTheDocument();
    expect(screen.getByLabelText("Replace the key")).toHaveValue("");
    expect(container.textContent).not.toMatch(/VERIFY_BANK_ET_\w/);
    await user.click(screen.getByRole("button", { name: "Remove" }));
    await waitFor(() => expect(m.clearVerifyETKey).toHaveBeenCalled());
    await waitFor(() => expect(m.getVerifyETKey).toHaveBeenCalledTimes(2));
  });

  test("REG-FE-PLAT-082 a key the server refuses says so", async () => {
    m.setVerifyETKey.mockRejectedValue(new Error("paste the key first"));
    const { user } = await openIntegrations();
    await user.type(screen.getByLabelText("Paste the key"), "bad");
    await user.click(screen.getByRole("button", { name: "Save key" }));
    expect(await screen.findByText("Could not save that key.")).toBeInTheDocument();
  });

  test("REG-FE-PLAT-083 while the key status loads the badge says so", async () => {
    m.getVerifyETKey.mockReturnValue(new Promise(() => {}));
    await openIntegrations();
    expect(screen.getByText("…")).toBeInTheDocument();
  });

  test.fails("REG-FE-PLAT-084 [FE-7] a Remove the server refuses is reported, not silently ignored", async () => {
    m.getVerifyETKey.mockResolvedValue({ key: "verifyet_api_key", configured: true, hint: "…a3f9" });
    m.clearVerifyETKey.mockRejectedValue(new Error("Request failed (500)"));
    const { user } = await openIntegrations();
    await user.click(await screen.findByRole("button", { name: "Remove" }));
    await waitFor(() => expect(m.clearVerifyETKey).toHaveBeenCalled());
    await waitFor(() => expect(toastSpy.error.mock.calls.length + screen.queryAllByText(/could not remove|failed/i).length).toBeGreaterThan(0), { timeout: 1000 });
  });
});

describe("REG-FE-PLAT-BR a clinic's branches", () => {
  test("REG-FE-PLAT-BR-001 Branches lists the clinic's workspaces, main first; adding one sends its name and workspace name and says where to sign in", async () => {
    m.listClinicBranches.mockResolvedValue([{ id: "ten_1", name: "Bole Dental", slug: "bole-dental", status: "active", main: true, created_at: "2026-10-01" }]);
    m.createClinicBranch.mockResolvedValue({ branch: { id: "ten_9", name: "Bole Dental — Piassa", slug: "bole-dental-piassa" }, admins: ["owner@bole.et"], copied: ["payment_rails", "dental_procedures"] });
    signIn();
    const { user } = renderConsole();
    await screen.findByText("Bole Dental");
    await user.click(within(row("Bole Dental")).getByRole("button", { name: "Branches" }));
    const dlg = await screen.findByRole("dialog");
    expect(await within(dlg).findByText("bole-dental")).toBeInTheDocument();
    expect(within(dlg).getByText("main")).toBeInTheDocument();
    expect(within(dlg).getByRole("button", { name: "Add branch" })).toBeDisabled();
    await user.type(within(dlg).getByLabelText("Branch name"), "Bole Dental — Piassa");
    await user.type(within(dlg).getByLabelText("Workspace name"), "Bole-Dental-Piassa");
    await user.click(within(dlg).getByRole("button", { name: "Add branch" }));
    await waitFor(() => expect(m.createClinicBranch).toHaveBeenCalledWith("ten_1", { name: "Bole Dental — Piassa", slug: "bole-dental-piassa" }));
    expect(await within(dlg).findByRole("status")).toHaveTextContent("owner@bole.et");
  });

  test("REG-FE-PLAT-BR-002 a refused branch (over the plan's limit) says why", async () => {
    m.listClinicBranches.mockResolvedValue([]);
    m.createClinicBranch.mockRejectedValue(new Error("this clinic's plan allows 1 branch(es)"));
    signIn();
    const { user } = renderConsole();
    await screen.findByText("Bole Dental");
    await user.click(within(row("Bole Dental")).getByRole("button", { name: "Branches" }));
    const dlg = await screen.findByRole("dialog");
    await user.type(within(dlg).getByLabelText("Branch name"), "Second");
    await user.type(within(dlg).getByLabelText("Workspace name"), "second");
    await user.click(within(dlg).getByRole("button", { name: "Add branch" }));
    await waitFor(() => expect(toastSpy.error).toHaveBeenCalledWith("this clinic's plan allows 1 branch(es)"));
  });

  test("REG-FE-PLAT-BR-003 Done closes the branches window and clears what was typed", async () => {
    m.listClinicBranches.mockResolvedValue([]);
    signIn();
    const { user } = renderConsole();
    await screen.findByText("Bole Dental");
    await user.click(within(row("Bole Dental")).getByRole("button", { name: "Branches" }));
    const dlg = await screen.findByRole("dialog");
    await user.type(within(dlg).getByLabelText("Branch name"), "Half typed");
    await user.click(within(dlg).getByRole("button", { name: "Done" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    await user.click(within(row("Bole Dental")).getByRole("button", { name: "Branches" }));
    expect(within(await screen.findByRole("dialog")).getByLabelText("Branch name")).toHaveValue("");
  });
});
