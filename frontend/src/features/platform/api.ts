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
  owner_phone?: string;
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
export function provisionClinic(body: { clinic_name: string; slug: string; owner_name: string; owner_email: string; owner_phone?: string; clinic_type: string; plan_code: string; modules: Record<string, boolean> }) {
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

/** Who may do what at this clinic — as opposed to which modules it has at all. */
export interface RolePolicy {
  key: string;
  label: string;
  help: string;
  enabled: boolean;
}
export function getClinicPolicies(id: string) {
  return pfetch<RolePolicy[]>(`/clinics/${id}/policies`);
}
export function setClinicPolicies(id: string, policies: Record<string, boolean>) {
  return pfetch<void>(`/clinics/${id}/policies`, { method: "PUT", body: { policies } });
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

// --- vendor integrations (the platform's own third-party keys) ---

/** Whether a credential is loaded. Never the credential itself. */
export interface Integration {
  key: string;
  configured: boolean;
  /** Last four characters, enough to tell two keys apart and useless to a thief. */
  hint?: string;
  updated_at?: string;
  /** saved (typed here) or env (set on the server). */
  source?: string;
}

export function getVerifyETKey() {
  return pfetch<Integration>("/integrations/verifyet");
}
export function setVerifyETKey(key: string) {
  return pfetch<Integration>("/integrations/verifyet", { method: "PUT", body: { key } });
}
export function clearVerifyETKey() {
  return pfetch<void>("/integrations/verifyet", { method: "DELETE" });
}

/* ------------------------------------------------------------------- CRM */

/** Which console this account gets. The server enforces it; this only decides
 *  which tabs are worth rendering, so a marketer is not shown tenant controls
 *  that would refuse them anyway. */
export function platformRole(): "admin" | "marketer" {
  const t = platformToken.get();
  if (!t) return "admin";
  try {
    const claims = JSON.parse(atob(t.split(".")[1] ?? ""));
    return (claims.roles ?? []).includes("marketer") ? "marketer" : "admin";
  } catch {
    return "admin";
  }
}

export interface CrmPhase { id: string; seq: number; name: string; intent?: string; waiting: number }
export interface Campaign {
  id: string; name: string; goal?: string; is_active: boolean;
  phases: CrmPhase[]; active: number; signed_up: number; created_at: string;
}
export interface Prospect {
  id: string; clinic_name: string;
  contact_name?: string; contact_role?: string;
  phone?: string; phone_alt?: string; email?: string;
  address?: string; map_url?: string; note?: string;
  source: string; status: "open" | "signed_up" | "not_yet" | "not_interested";
  priority: "hot" | "warm" | "cold";
  next_action?: string; next_action_at?: string;
  /** Why this clinic is on the worklist — only set by the worklist. */
  reason?: string;
  /** Days since anyone touched it; -1 when nobody ever has. */
  silent_days: number;
  ready_on?: string; outcome_note?: string;
  owner_id?: string; owner_name?: string;
  campaign_id?: string; campaign_name?: string;
  phase_id?: string; phase_name?: string; phase_seq?: number; phase_count?: number;
  last_touch_at?: string; last_touch_kind?: string; last_touch_by?: string;
  touches: number; created_at: string;
}
export interface Touch { id: string; kind: string; note?: string; happened_at: string; by_name?: string }
export interface Step { phase_name: string; seq: number; note?: string; done_by?: string; done_at: string }
export interface Rep { id: string; email: string; full_name: string; role: string; status: string; open: number; signed_up: number }
export interface Board { campaign: Campaign; columns: { phase: CrmPhase; prospects: Prospect[] }[] }
export interface Duplicate { id: string; clinic_name: string; phone?: string; owner_name?: string; status: string; why: string }

export interface PhaseDraft { id?: string; name: string; intent?: string }

export const listCampaigns = () => pfetch<Campaign[]>("/crm/campaigns");
export const createCampaign = (body: { name: string; goal?: string; phases: PhaseDraft[] }) =>
  pfetch<Campaign>("/crm/campaigns", { method: "POST", body });
export const updateCampaign = (id: string, body: { name: string; goal?: string; phases: PhaseDraft[] }) =>
  pfetch<void>(`/crm/campaigns/${id}`, { method: "PUT", body });
export const setCampaignActive = (id: string, active: boolean) =>
  pfetch<void>(`/crm/campaigns/${id}/active`, { method: "POST", body: { active } });
export const getBoard = (id: string) => pfetch<Board>(`/crm/campaigns/${id}/board`);

export interface ProspectFilter { q?: string; status?: string; owner?: string; priority?: string; flag?: string }
export const listProspects = (f: ProspectFilter = {}) =>
  pfetch<Prospect[]>(`/crm/prospects?${new URLSearchParams(
    Object.entries(f).filter(([, v]) => v) as [string, string][]).toString()}`);
/** One person's morning: what is promised, overdue, due, untouched or going quiet. */
export const worklist = (owner = "") => pfetch<Prospect[]>(`/crm/worklist?owner=${owner}`);
export const setPriority = (id: string, priority: string) =>
  pfetch<void>(`/crm/prospects/${id}/priority`, { method: "POST", body: { priority } });
export const setNextAction = (id: string, note: string, on: string) =>
  pfetch<void>(`/crm/prospects/${id}/next-action`, { method: "POST", body: { note, on } });
export const getProspect = (id: string) =>
  pfetch<{ prospect: Prospect; touches: Touch[]; steps: Step[] }>(`/crm/prospects/${id}`);
export const checkDuplicates = (name: string, phone: string) =>
  pfetch<Duplicate[]>(`/crm/prospects/duplicates?name=${encodeURIComponent(name)}&phone=${encodeURIComponent(phone)}`);
export const createProspect = (body: Record<string, string | undefined>) =>
  pfetch<Prospect>("/crm/prospects", { method: "POST", body });
export const updateProspect = (id: string, body: Record<string, string | undefined>) =>
  pfetch<void>(`/crm/prospects/${id}`, { method: "PUT", body });
export const assignProspect = (id: string, owner_id: string) =>
  pfetch<void>(`/crm/prospects/${id}/assign`, { method: "POST", body: { owner_id } });
export const enrolProspect = (id: string, campaign_id: string) =>
  pfetch<void>(`/crm/prospects/${id}/enrol`, { method: "POST", body: { campaign_id } });
export const completePhase = (id: string, note?: string) =>
  pfetch<Prospect>(`/crm/prospects/${id}/complete-phase`, { method: "POST", body: { note } });
export const setOutcome = (id: string, body: { status: string; ready_on?: string; note?: string }) =>
  pfetch<void>(`/crm/prospects/${id}/outcome`, { method: "POST", body });
export const reopenProspect = (id: string) => pfetch<void>(`/crm/prospects/${id}/reopen`, { method: "POST" });
export const logTouch = (id: string, body: { kind: string; note?: string; happened_at?: string }) =>
  pfetch<void>(`/crm/prospects/${id}/touches`, { method: "POST", body });

export const listReps = () => pfetch<Rep[]>("/crm/reps");
export const createRep = (body: { email: string; full_name: string; role: string; password: string }) =>
  pfetch<Rep>("/crm/reps", { method: "POST", body });
export const setRepStatus = (id: string, status: string) =>
  pfetch<void>(`/crm/reps/${id}/status`, { method: "POST", body: { status } });
export const importInbound = (campaign_id?: string) =>
  pfetch<{ imported: number }>("/crm/inbound/import", { method: "POST", body: { campaign_id } });
