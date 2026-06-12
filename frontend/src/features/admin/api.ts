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
export function listBranches() {
  return apiFetch<Branch[]>("/org/branches");
}
export function createBranch(body: { name: string; code: string; address?: string; phone?: string }) {
  return apiFetch<Branch>("/org/branches", { method: "POST", body });
}
export function listDepartments() {
  return apiFetch<Department[]>("/org/departments");
}
export function createDepartment(body: { branch_id: string; name: string; specialty?: string }) {
  return apiFetch<Department>("/org/departments", { method: "POST", body });
}

// ---- users & roles ----

export interface UserListItem {
  id: string;
  email: string;
  full_name: string;
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
export function listRoles() {
  return apiFetch<Role[]>("/roles");
}
export function inviteUser(body: { email: string; full_name: string; roles: string[] }) {
  return apiFetch<InviteResult>("/users", { method: "POST", body });
}
export function updateUserStatus(id: string, status: string) {
  return apiFetch<void>(`/users/${id}/status`, { method: "POST", body: { status } });
}
export function assignRoles(id: string, roles: string[]) {
  return apiFetch<void>(`/users/${id}/roles`, { method: "PUT", body: { roles } });
}

