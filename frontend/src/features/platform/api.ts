// Platform (super-admin) API — a self-contained surface with its OWN token,
// separate from the tenant app's auth. The platform operator provisions clinics.
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
export function provisionClinic(body: { clinic_name: string; slug: string; owner_name: string; owner_email: string; modules: Record<string, boolean> }) {
  return pfetch<ProvisionResult>("/clinics", { method: "POST", body });
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
