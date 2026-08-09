// Platform (super-admin) API — a self-contained surface with its OWN token,
// separate from the tenant app's auth. The platform operator provisions clinics.
import type { UserDTO } from "@/features/auth/api";

const BASE = import.meta.env.VITE_API_BASE_URL ?? "/api/v1";
const KEY = "clinicos_platform_token";

export const platformToken = {
  get: () => localStorage.getItem(KEY),
  set: (t: string) => localStorage.setItem(KEY, t),
  clear: () => localStorage.removeItem(KEY),
};

async function pfetch<T>(path: string, opts: { method?: string; body?: unknown } = {}): Promise<T> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  const t = platformToken.get();
  if (t) headers.Authorization = `Bearer ${t}`;
  const res = await fetch(`${BASE}/platform${path}`, {
    method: opts.method ?? "GET",
    headers,
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    if (res.status === 401) platformToken.clear();
    throw new Error(json?.error?.message || `Request failed (${res.status})`);
  }
  return (json.data ?? json) as T;
}

export interface Clinic {
  id: string;
  name: string;
  slug: string;
  status: string;
  owner_email?: string;
  users: number;
  patients: number;
  clinic_type?: string;
  plan_code?: string;
  plan_name?: string;
  created_at: string;
}

export interface ProvisionResult {
  clinic: Clinic;
  owner_email: string;
  temp_password?: string;
  workspace_slug: string;
}

export async function platformLogin(email: string, password: string) {
  const r = await pfetch<{ access_token: string; email: string }>("/auth/login", { method: "POST", body: { email, password } });
  platformToken.set(r.access_token);
  return r;
}

export function listClinics() {
  return pfetch<Clinic[]>("/clinics");
}
export function provisionClinic(body: { clinic_name: string; slug: string; owner_name: string; owner_email: string; clinic_type: string; plan_code: string; modules: Record<string, boolean> }) {
  return pfetch<ProvisionResult>("/clinics", { method: "POST", body });
}

// --- subscription plans ---

export interface Plan {
  id: string;
  code: string;
  name: string;
  clinic_type: string; // "all" | "general" | "dental"
  branch_limit: number | null;
  user_limit: number | null;
  storage_gb: number | null;
  patient_limit: number | null;
  images_per_patient: number | null;
  price_monthly: string;
  in_use: number;
}
export type PlanBody = Omit<Plan, "id" | "in_use">;

export function listPlans() {
  return pfetch<Plan[]>("/plans");
}
export function createPlan(body: PlanBody) {
  return pfetch<Plan>("/plans", { method: "POST", body });
}
export function updatePlan(id: string, body: Omit<PlanBody, "code">) {
  return pfetch<void>(`/plans/${id}`, { method: "PUT", body });
}

export interface UsageLine { used: number; limit: number } // limit -1 = unlimited
export interface ClinicUsage {
  plan_name: string;
  storage: UsageLine;
  patients: UsageLine;
  users: UsageLine;
  branches: UsageLine;
  storage_gb_override: number | null;
  patient_limit_override: number | null;
  user_limit_override: number | null;
  branch_limit_override: number | null;
}
export function clinicUsage(id: string) {
  return pfetch<ClinicUsage>(`/clinics/${id}/usage`);
}
export function setClinicPlan(id: string, body: {
  plan_id: string;
  storage_gb_override: number | null;
  patient_limit_override: number | null;
  user_limit_override: number | null;
  branch_limit_override: number | null;
}) {
  return pfetch<void>(`/clinics/${id}/plan`, { method: "POST", body });
}
export function suspendClinic(id: string) {
  return pfetch<void>(`/clinics/${id}/suspend`, { method: "POST" });
}
export function reactivateClinic(id: string) {
  return pfetch<void>(`/clinics/${id}/reactivate`, { method: "POST" });
}

export interface ModuleFlag {
  key: string;
  label: string;
  enabled: boolean;
}
export function getClinicModules(id: string) {
  return pfetch<ModuleFlag[]>(`/clinics/${id}/modules`);
}
export function setClinicModules(id: string, modules: Record<string, boolean>) {
  return pfetch<void>(`/clinics/${id}/modules`, { method: "PUT", body: { modules } });
}

// Sign in as a clinic's owner — returns a ready-to-use tenant access token.
export interface Impersonation {
  access_token: string;
  expires_in: number;
  workspace_slug: string;
  user: UserDTO;
}
export function impersonateOwner(id: string) {
  return pfetch<Impersonation>(`/clinics/${id}/impersonate`, { method: "POST" });
}

// Partner / referral leads captured on the public partner pages.
export interface PartnerLead {
  id: string;
  name: string;
  phone?: string;
  email?: string;
  region?: string;
  audience?: string;
  clinics_estimate?: string;
  goal?: string;
  source?: string;
  status: string; // new | contacted | signed | archived
  created_at: string;
}
export function listPartnerLeads() {
  return pfetch<PartnerLead[]>("/partner-leads");
}
export function setLeadStatus(id: string, status: string) {
  return pfetch<void>(`/partner-leads/${id}/status`, { method: "POST", body: { status } });
}
