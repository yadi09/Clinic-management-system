import { apiFetch } from "@/lib/api-client";

export interface Clinic {
  name: string;
  timezone: string;
  locale: string;
}
export interface Branch {
  id: string;
  name: string;
  code: string;
  address?: string;
  phone?: string;
  is_active: boolean;
}
export interface Department {
  id: string;
  branch_id: string;
  name: string;
  specialty?: string;
}

export function getClinic() {
  return apiFetch<Clinic>("/org/clinic");
}
export function saveClinic(body: { name: string; timezone?: string; locale?: string }) {
  return apiFetch<Clinic>("/org/clinic", { method: "PUT", body });
}

export interface Workspace {
  name: string;
  slug: string;
}
export function getWorkspace() {
  return apiFetch<Workspace>("/org/workspace");
}
export function updateWorkspace(body: { slug: string }) {
  return apiFetch<Workspace>("/org/workspace", { method: "PUT", body });
}

export function listBranches() {
  return apiFetch<Branch[]>("/org/branches");
}
export function createBranch(body: { name: string; code: string; address?: string; phone?: string }) {
  return apiFetch<Branch>("/org/branches", { method: "POST", body });
}
export function updateBranch(id: string, body: { name: string; code: string; address?: string; phone?: string; is_active?: boolean }) {
  return apiFetch<Branch>(`/org/branches/${id}`, { method: "PUT", body });
}
export function deleteBranch(id: string) {
  return apiFetch<void>(`/org/branches/${id}`, { method: "DELETE" });
}

export interface UsageLine {
  used: number;
  limit: number; // -1 = unlimited; storage in bytes, others are counts
}
export interface PlanUsage {
  plan_name: string;
  storage: UsageLine;
  patients: UsageLine;
  users: UsageLine;
  branches: UsageLine;
}
export function planUsage() {
  return apiFetch<PlanUsage>("/org/plan-usage");
}

export interface BranchUsage {
  used: number;
  limit?: number | null; // null/undefined = unlimited
}
export function branchUsage() {
  return apiFetch<BranchUsage>("/org/branch-usage");
}

export interface BranchModule {
  flag: string;
  enabled: boolean;
  overridden: boolean;
}
export function getBranchModules(id: string) {
  return apiFetch<BranchModule[]>(`/org/branches/${id}/modules`);
}
/** Set per-branch module overrides. Value null clears the override (follow default). */
export function setBranchModules(id: string, modules: Record<string, boolean | null>) {
  return apiFetch<BranchModule[]>(`/org/branches/${id}/modules`, { method: "PUT", body: modules });
}
export function listDepartments() {
  return apiFetch<Department[]>("/org/departments");
}
export function updateDepartment(id: string, body: { branch_id: string; name: string; specialty?: string }) {
  return apiFetch<Department>(`/org/departments/${id}`, { method: "PUT", body });
}
export function deleteDepartment(id: string) {
  return apiFetch<void>(`/org/departments/${id}`, { method: "DELETE" });
}

// ---- clinic flow settings (Phase 3a) ----

export interface ClinicSettings {
  card_fee_enabled: boolean;
  card_fee_amount: string;
  card_currency: string;
  free_window_days: number;
  triage_required: boolean;
  doctor_assignment: string; // "manual" | "auto"
}
export function getSettings() {
  return apiFetch<ClinicSettings>("/org/settings");
}
export function saveSettings(body: {
  card_fee_enabled: boolean;
  card_fee_amount: number;
  card_currency: string;
  free_window_days: number;
  triage_required: boolean;
  doctor_assignment: string;
}) {
  return apiFetch<ClinicSettings>("/org/settings", { method: "PUT", body });
}
export function createDepartment(body: { branch_id: string; name: string; specialty?: string }) {
  return apiFetch<Department>("/org/departments", { method: "POST", body });
}

// ---- users & roles ----

export interface UserListItem {
  id: string;
  email: string;
  full_name: string;
  phone: string;
  status: string;
  roles: string[];
  last_login_at?: string;
  created_at: string;
}
export interface Role {
  id: string;
  code: string;
  name: string;
  is_system: boolean;
}
export interface InviteResult {
  id: string;
  email: string;
  invite_link: string;
}

export function listUsers() {
  return apiFetch<UserListItem[]>("/users");
}
export interface Provider {
  id: string;
  full_name: string;
}
/** Assignable consulting clinicians — for triage/reception "assign doctor" pickers (no user.read needed). */
export function listProviders() {
  return apiFetch<Provider[]>("/providers");
}
export function listRoles() {
  return apiFetch<Role[]>("/roles");
}
/** A fresh single-use link for somebody who has forgotten their password. There is
 *  no email or SMS sender here — the admin hands the link over. */
export function issueResetLink(userId: string) {
  return apiFetch<InviteResult>(`/users/${userId}/reset-link`, { method: "POST" });
}

export function inviteUser(body: { email: string; full_name: string; phone?: string; roles: string[]; branch_ids?: string[] }) {
  return apiFetch<InviteResult>("/users", { method: "POST", body });
}
export function updateUserStatus(id: string, status: string) {
  return apiFetch<void>(`/users/${id}/status`, { method: "POST", body: { status } });
}
/** Edits the details an admin maintains. Omitting phone leaves the stored number
 *  alone; passing "" clears it. */
export function updateUserProfile(id: string, full_name: string, phone?: string) {
  return apiFetch<void>(`/users/${id}/profile`, { method: "POST", body: { full_name, phone } });
}
export function deleteUser(id: string) {
  return apiFetch<void>(`/users/${id}`, { method: "DELETE" });
}
export function assignRoles(id: string, roles: string[], branch_ids?: string[]) {
  return apiFetch<void>(`/users/${id}/roles`, { method: "PUT", body: { roles, branch_ids } });
}


// --- payment methods (rails) ---

/** One real way this clinic is paid. `key` is what gets stored on the charge. */
export interface PaymentRail {
  id: string;
  key: string;
  label: string;
  kind: "cash" | "card" | "wallet" | "bank";
  bank_key?: string;
  account_name?: string;
  account_number?: string;
  needs_reference: boolean;
  active: boolean;
  sort_order: number;
}

export interface PaymentRailBody {
  key?: string;
  label: string;
  kind: string;
  bank_key?: string;
  account_name?: string;
  account_number?: string;
  needs_reference: boolean;
  active?: boolean;
  sort_order?: number;
}

/** The desk gets active rails only; settings asks for all so one can be switched back on. */
export function listPaymentRails(all?: boolean) {
  return apiFetch<PaymentRail[]>(`/org/payment-rails${all ? "?all=1" : ""}`);
}
export function createPaymentRail(body: PaymentRailBody) {
  return apiFetch<PaymentRail>("/org/payment-rails", { method: "POST", body });
}
export function updatePaymentRail(id: string, body: PaymentRailBody) {
  return apiFetch<PaymentRail>(`/org/payment-rails/${id}`, { method: "PUT", body });
}
export function deletePaymentRail(id: string) {
  return apiFetch<void>(`/org/payment-rails/${id}`, { method: "DELETE" });
}
