// The settings / staff API wrappers. Each is thin, but each is the only place a
// path, a method and a body shape are spelled out — a typo here is a branch that
// never saves or a staff member whose role change goes nowhere. These pin exactly
// what reaches apiFetch.
import { beforeEach, describe, expect, test, vi } from "vitest";

const apiFetch = vi.hoisted(() => vi.fn());
vi.mock("@/lib/api-client", async (orig) => ({ ...(await orig<object>()), apiFetch }));

import * as a from "@/features/admin/api";

beforeEach(() => {
  apiFetch.mockReset();
  apiFetch.mockResolvedValue(undefined);
});

const branch = { name: "Bole", code: "BOL", address: "Bole Rd", phone: "0911" };
const dept = { branch_id: "br_1", name: "OPD", specialty: "General" };
const settings = { card_fee_enabled: true, card_fee_amount: 100, card_currency: "ETB", free_window_days: 7, triage_required: false, doctor_assignment: "pool" };
const invite = { email: "a@b.et", full_name: "Abebe", phone: "0911", roles: ["doctor"], branch_ids: ["br_1"] };
const rail = { kind: "bank", provider: "CBE", account: "1000" } as unknown as a.PaymentRailBody;

const CASES: [string, () => Promise<unknown>, unknown[]][] = [
  ["getClinic", () => a.getClinic(), ["/org/clinic"]],
  ["saveClinic", () => a.saveClinic({ name: "Cure" }), ["/org/clinic", { method: "PUT", body: { name: "Cure" } }]],
  ["getWorkspace", () => a.getWorkspace(), ["/org/workspace"]],
  ["updateWorkspace", () => a.updateWorkspace({ slug: "cure" }), ["/org/workspace", { method: "PUT", body: { slug: "cure" } }]],
  ["listBranches", () => a.listBranches(), ["/org/branches"]],
  ["createBranch", () => a.createBranch(branch), ["/org/branches", { method: "POST", body: branch }]],
  ["updateBranch", () => a.updateBranch("br_1", { ...branch, is_active: false }), ["/org/branches/br_1", { method: "PUT", body: { ...branch, is_active: false } }]],
  ["deleteBranch", () => a.deleteBranch("br_1"), ["/org/branches/br_1", { method: "DELETE" }]],
  ["planUsage", () => a.planUsage(), ["/org/plan-usage"]],
  ["branchUsage", () => a.branchUsage(), ["/org/branch-usage"]],
  ["getBranchModules", () => a.getBranchModules("br_1"), ["/org/branches/br_1/modules"]],
  ["setBranchModules", () => a.setBranchModules("br_1", { lab: false, pharmacy: null }), ["/org/branches/br_1/modules", { method: "PUT", body: { lab: false, pharmacy: null } }]],
  ["listDepartments", () => a.listDepartments(), ["/org/departments"]],
  ["createDepartment", () => a.createDepartment(dept), ["/org/departments", { method: "POST", body: dept }]],
  ["updateDepartment", () => a.updateDepartment("dep_1", dept), ["/org/departments/dep_1", { method: "PUT", body: dept }]],
  ["deleteDepartment", () => a.deleteDepartment("dep_1"), ["/org/departments/dep_1", { method: "DELETE" }]],
  ["getSettings", () => a.getSettings(), ["/org/settings"]],
  ["saveSettings", () => a.saveSettings(settings), ["/org/settings", { method: "PUT", body: settings }]],
  ["listUsers", () => a.listUsers(), ["/users"]],
  ["listProviders", () => a.listProviders(), ["/providers"]],
  ["listRoles", () => a.listRoles(), ["/roles"]],
  ["issueResetLink", () => a.issueResetLink("usr_1"), ["/users/usr_1/reset-link", { method: "POST" }]],
  ["inviteUser", () => a.inviteUser(invite), ["/users", { method: "POST", body: invite }]],
  ["updateUserStatus", () => a.updateUserStatus("usr_1", "disabled"), ["/users/usr_1/status", { method: "POST", body: { status: "disabled" } }]],
  ["updateUserProfile", () => a.updateUserProfile("usr_1", "Abebe K", "0922"), ["/users/usr_1/profile", { method: "POST", body: { full_name: "Abebe K", phone: "0922" } }]],
  ["updateUserProfile keeps the phone when omitted", () => a.updateUserProfile("usr_1", "Abebe K"), ["/users/usr_1/profile", { method: "POST", body: { full_name: "Abebe K", phone: undefined } }]],
  ["deleteUser", () => a.deleteUser("usr_1"), ["/users/usr_1", { method: "DELETE" }]],
  ["assignRoles", () => a.assignRoles("usr_1", ["doctor"], ["br_1"]), ["/users/usr_1/roles", { method: "PUT", body: { roles: ["doctor"], branch_ids: ["br_1"] } }]],
  ["listPaymentRails", () => a.listPaymentRails(), ["/org/payment-rails"]],
  ["listPaymentRails(all)", () => a.listPaymentRails(true), ["/org/payment-rails?all=1"]],
  ["createPaymentRail", () => a.createPaymentRail(rail), ["/org/payment-rails", { method: "POST", body: rail }]],
  ["updatePaymentRail", () => a.updatePaymentRail("rail_1", rail), ["/org/payment-rails/rail_1", { method: "PUT", body: rail }]],
  ["deletePaymentRail", () => a.deletePaymentRail("rail_1"), ["/org/payment-rails/rail_1", { method: "DELETE" }]],
];

describe("REG-FE-ADMINAPI settings and staff API wrappers", () => {
  test.each(CASES.map((c, i) => [String(i + 1).padStart(3, "0"), ...c] as const))(
    "REG-FE-ADMINAPI-%s %s sends the right path, method and body",
    async (_id, _name, call, expected) => {
      await call();
      expect(apiFetch).toHaveBeenCalledTimes(1);
      expect(apiFetch.mock.calls[0]).toEqual(expected);
    },
  );

  test("REG-FE-ADMINAPI-100 a wrapper hands back what the server answered", async () => {
    apiFetch.mockResolvedValue([{ id: "br_1", name: "Bole" }]);
    await expect(a.listBranches()).resolves.toEqual([{ id: "br_1", name: "Bole" }]);
  });
});
