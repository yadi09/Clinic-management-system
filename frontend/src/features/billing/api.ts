import { apiFetch } from "@/lib/api-client";

export interface CardAssessment {
  requires_payment: boolean;
  card_enabled: boolean;
  amount: string;
  currency: string;
  reason: string;
}

export interface CardPayment {
  id: string;
  amount: string;
  currency: string;
  waived: boolean;
  waive_reason?: string;
  paid_at: string;
}

/** Card-fee decision for a patient (optionally attending an appointment). */
export function assessCard(patientId: string, appointmentId?: string) {
  const p = new URLSearchParams({ patient: patientId });
  if (appointmentId) p.set("appointment", appointmentId);
  return apiFetch<CardAssessment>(`/billing/card/assess?${p.toString()}`);
}

export function collectCard(body: {
  patient_id: string;
  branch_id: string;
  appointment_id?: string;
  waived?: boolean;
  waive_reason?: string;
}) {
  return apiFetch<CardPayment>("/billing/card/collect", { method: "POST", body });
}

export function cardHistory(patientId: string) {
  return apiFetch<CardPayment[]>(`/billing/card/history?patient=${patientId}`);
}

// ---- Billing-1: service catalog + charges + cashier + cash summary ----

export interface ServiceItem {
  id: string;
  code: string;
  name: string;
  category: string;
  price: string;
  currency: string;
  is_active: boolean;
  is_default: boolean;
}
export interface PendingCharge {
  id: string;
  source: string;
  description: string;
  amount: string;
  currency: string;
  created_at: string;
  patient_name: string;
  mrn: string;
}
export interface ChargeRow {
  id: string;
  source: string;
  description: string;
  amount: string;
  currency: string;
  status: string;
  payment_method?: string;
  waive_reason?: string;
  settled_at?: string;
  created_at: string;
}
export interface CashSummary {
  collected: string;
  collected_count: number;
  waived: string;
  waived_count: number;
  outstanding: string;
  outstanding_count: number;
  refunded: string;
  refunded_count: number;
  by_source: { source: string; total: string; count: number }[];
}

export function listServices(activeOnly = false) {
  return apiFetch<ServiceItem[]>(`/billing/services${activeOnly ? "?active=1" : ""}`);
}
export function createService(body: { code: string; name: string; category?: string; price: number }) {
  return apiFetch<ServiceItem>("/billing/services", { method: "POST", body });
}
export function updateService(id: string, body: { code: string; name: string; category?: string; price: number }) {
  return apiFetch<void>(`/billing/services/${id}`, { method: "PUT", body });
}
export function setServiceActive(id: string, is_active: boolean) {
  return apiFetch<void>(`/billing/services/${id}/active`, { method: "PUT", body: { is_active } });
}
export function setServiceDefault(id: string, is_default: boolean) {
  return apiFetch<void>(`/billing/services/${id}/default`, { method: "PUT", body: { is_default } });
}
export function deleteService(id: string) {
  return apiFetch<void>(`/billing/services/${id}`, { method: "DELETE" });
}

export interface Provider {
  id: string;
  full_name: string;
}
export async function getServiceProviders(id: string): Promise<string[]> {
  const r = await apiFetch<{ user_ids: string[] }>(`/billing/services/${id}/providers`);
  return r.user_ids ?? [];
}
export function setServiceProviders(id: string, user_ids: string[]) {
  return apiFetch<void>(`/billing/services/${id}/providers`, { method: "PUT", body: { user_ids } });
}
/** Staff who provide ANY of the given services — reception's filtered assign list. */
export function providersForServices(serviceIds: string[]) {
  return apiFetch<Provider[]>(`/billing/providers?services=${serviceIds.join(",")}`);
}

export function raiseCharge(body: {
  patient_id: string;
  encounter_id?: string;
  service_item_id?: string;
  source?: string;
  description: string;
  amount: number;
  branch_id?: string;
  department_id?: string;
  to_triage?: boolean;
  provider_id?: string;
}) {
  return apiFetch<{ id: string }>("/billing/charges", { method: "POST", body });
}
export function pendingCharges() {
  return apiFetch<PendingCharge[]>("/billing/charges/pending");
}
export function patientCharges(patientId: string) {
  return apiFetch<ChargeRow[]>(`/billing/charges?patient=${patientId}`);
}
export function settleCharge(id: string, method: string) {
  return apiFetch<void>(`/billing/charges/${id}/settle`, { method: "POST", body: { method } });
}
export function waiveCharge(id: string, reason: string) {
  return apiFetch<void>(`/billing/charges/${id}/waive`, { method: "POST", body: { reason } });
}
export function voidCharge(id: string, reason: string) {
  return apiFetch<void>(`/billing/charges/${id}/void`, { method: "POST", body: { reason } });
}
export function refundCharge(id: string, reason: string) {
  return apiFetch<void>(`/billing/charges/${id}/refund`, { method: "POST", body: { reason } });
}
export function waiverReasons() {
  return apiFetch<string[]>("/billing/waiver-reasons");
}
export function cashSummary(sinceISO?: string) {
  return apiFetch<CashSummary>(`/billing/cash${sinceISO ? `?since=${encodeURIComponent(sinceISO)}` : ""}`);
}
