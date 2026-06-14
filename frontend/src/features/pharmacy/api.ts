import { apiFetch } from "@/lib/api-client";

export interface Drug {
  id: string;
  name: string;
  form?: string;
  drug_class?: string;
  is_controlled: boolean;
  unit_price: string;
  reorder_level: number;
  is_active: boolean;
  on_hand: number;
}
export interface Batch {
  id: string;
  drug_id: string;
  drug_name?: string;
  batch_no: string;
  expiry_date?: string;
  qty_on_hand: number;
  quarantined: boolean;
  status: string; // ok | near_expiry | expired | quarantine
}
export interface KPIs {
  to_dispense: number;
  dispensed_today: number;
  low_stock: number;
  near_expiry: number;
}
export interface DispenseQueueItem {
  id: string;
  rx_no: number;
  patient_name: string;
  mrn: string;
  prescriber?: string;
  item_count: number;
  dispensed: boolean;
  flags: string[];
}
export interface DispenseQueue {
  kpis: KPIs;
  items: DispenseQueueItem[];
}
export interface DispenseItem {
  id: string;
  drug_name: string;
  sig: string;
  matched_drug_id?: string | null;
  allergy_conflict?: string;
  batches: Batch[];
}
export interface DispenseDetail {
  id: string;
  rx_no: number;
  patient_name: string;
  mrn: string;
  prescriber?: string;
  dispensed: boolean;
  allergies: string[];
  items: DispenseItem[];
}

export function listDrugs(params: { class?: string; controlled?: string } = {}) {
  const q = new URLSearchParams();
  if (params.class) q.set("class", params.class);
  if (params.controlled) q.set("controlled", params.controlled);
  const qs = q.toString();
  return apiFetch<Drug[]>(`/pharmacy/drugs${qs ? `?${qs}` : ""}`);
}
export function listBatches() {
  return apiFetch<Batch[]>("/pharmacy/batches");
}
export function dispenseQueue() {
  return apiFetch<DispenseQueue>("/pharmacy/dispense-queue");
}
export function dispenseDetail(rxId: string) {
  return apiFetch<DispenseDetail>(`/pharmacy/dispense/${rxId}`);
}
export function dispense(rxId: string, body: { counselling_notes?: string; lines: { drug_id: string; batch_id: string; qty: number }[] }) {
  return apiFetch<{ id: string; total: string; status: string }>(`/pharmacy/dispense/${rxId}`, { method: "POST", body });
}
export function adjustStock(body: { drug_id: string; batch_id?: string; batch_no?: string; expiry?: string; delta: number; reason?: string; note?: string }) {
  return apiFetch<void>("/pharmacy/stock/adjust", { method: "POST", body });
}
export function quarantineBatch(batchId: string, quarantined: boolean) {
  return apiFetch<void>(`/pharmacy/batches/${batchId}/quarantine`, { method: "POST", body: { quarantined } });
}
