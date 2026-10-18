// The patient portal's calls. The patient has no account: they sign in with the card
// number and carry a short-lived token in a header of their own, never the staff token.
import { apiFetch } from "@/lib/api-client";
import type { Chart } from "@/features/dental/api";

export interface PortalSettings {
  enabled: boolean;
  show_money: boolean;
  show_unbilled: boolean;
  show_teeth: boolean;
  show_3d: boolean;
  /** Patients may pay what they owe (or the next visit) from their phone. */
  allow_pay: boolean;
  welcome_note: string;
  /** Read-only: the clinic's address, for the link. */
  slug?: string;
}

export interface PortalVisit { seq: number; date: string; status: "planned" | "done"; what: string; paid?: "paid" | "billed" | "unpaid" | "waived" | "refunded" }
export interface PortalTreatment {
  title: string; tooth?: string; status: string; done: number; of: number; visits: PortalVisit[];
  planned?: string; collected?: string;
}
export interface PortalMe {
  clinic: { name: string; slug: string; phone?: string; has_logo: boolean };
  first_name: string;
  settings: PortalSettings;
  next?: { date: string; title: string; seq: number; of: number };
  treatments: PortalTreatment[];
  money?: { paid: string; to_pay: string; unbilled?: string };
  receipts?: { no: number; date: string; what: string; method?: string; amount: string }[];
  chart?: Pick<Chart, "items" | "positions">;
  today: string;
}

const slugPath = (slug: string) => `/portal/${encodeURIComponent(slug)}`;

export const portalLogin = (slug: string, card: string) =>
  apiFetch<{ token: string; expires_in: number }>(`${slugPath(slug)}/login`, { method: "POST", body: { card }, auth: false });

export const portalMe = (slug: string, token: string) =>
  apiFetch<PortalMe>(`${slugPath(slug)}/me`, { auth: false, headers: { "X-Portal-Token": token } });

export const portalLogo = (slug: string) => `/api/v1/verify/logo/${encodeURIComponent(slug)}`;

export const getPortalSettings = () => apiFetch<PortalSettings>("/portal-settings");
export const savePortalSettings = (body: PortalSettings) => apiFetch<PortalSettings>("/portal-settings", { method: "PUT", body });

// ---- Pay from home ----------------------------------------------------------------

export interface PayItem { key: string; label: string; amount: string; hint?: string; payable: boolean; upcoming?: boolean }
export interface PayRail { id: string; label: string; kind: string; account_name?: string; account_number: string }
export interface PayStatus {
  id: string; state: "checking" | "waiting" | "paid" | "rejected"; amount: string; rail: string; reference: string;
  reason?: string; receipt_no?: number; date: string;
}
export interface PayOptions { items: PayItem[]; rails: PayRail[]; open: PayStatus[] }

const hdr = (token: string) => ({ "X-Portal-Token": token });

export const portalPayOptions = (slug: string, token: string) =>
  apiFetch<PayOptions>(`${slugPath(slug)}/pay/options`, { auth: false, headers: hdr(token) });
export const portalPay = (slug: string, token: string, body: { items: string[]; rail_id: string; reference: string }) =>
  apiFetch<PayStatus>(`${slugPath(slug)}/pay`, { method: "POST", body, auth: false, headers: hdr(token) });
export const portalPayStatus = (slug: string, token: string, id: string) =>
  apiFetch<PayStatus>(`${slugPath(slug)}/pay/${encodeURIComponent(id)}`, { auth: false, headers: hdr(token) });

// The cashier's side.
export interface HomePayment extends PayStatus { patient: string; mrn: string; patient_id: string; items: string; verify_state?: string; verify_reason?: string }
export const listHomePayments = () => apiFetch<HomePayment[]>("/portal-payments");
export const confirmHomePayment = (id: string) => apiFetch<PayStatus>(`/portal-payments/${encodeURIComponent(id)}/confirm`, { method: "POST" });
export const rejectHomePayment = (id: string, reason: string) => apiFetch<{ ok: boolean }>(`/portal-payments/${encodeURIComponent(id)}/reject`, { method: "POST", body: { reason } });
