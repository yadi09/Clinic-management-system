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
  awaiting_payment: boolean;
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
  prepared: boolean;
  prepared_total?: string;
  charge_settled: boolean;
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
export function prepareDispense(rxId: string, body: { counselling_notes?: string; lines: { drug_id: string; batch_id: string; qty: number }[] }) {
  return apiFetch<{ sale_id: string; charge_id: string; total: string }>(`/pharmacy/dispense/${rxId}/prepare`, { method: "POST", body });
}
export function completeDispense(rxId: string) {
  return apiFetch<{ id: string; total: string; status: string }>(`/pharmacy/dispense/${rxId}/complete`, { method: "POST" });
}
export function adjustStock(body: { drug_id: string; batch_id?: string; batch_no?: string; expiry?: string; delta: number; reason?: string; note?: string }) {
  return apiFetch<void>("/pharmacy/stock/adjust", { method: "POST", body });
}
export function quarantineBatch(batchId: string, quarantined: boolean) {
  return apiFetch<void>(`/pharmacy/batches/${batchId}/quarantine`, { method: "POST", body: { quarantined } });
}

// ---- Phase 4b-1: OTC sale, catalog admin, dashboard ----

export interface Dashboard {
  dispensed_today: number;
  value_on_hand: string;
  low_stock: number;
  near_expiry: number;
  expired: number;
  open_pos: number;
  volume: { day: string; count: number }[];
  alerts: string[];
}

export function searchDrugs(q: string) {
  return apiFetch<Drug[]>(`/pharmacy/drugs/search?q=${encodeURIComponent(q)}`);
}
export function createDrug(body: { name: string; form?: string; drug_class?: string; is_controlled?: boolean; unit_price: number; reorder_level: number }) {
  return apiFetch<Drug>("/pharmacy/drugs", { method: "POST", body });
}
export function updateDrug(id: string, body: { name: string; form?: string; drug_class?: string; is_controlled?: boolean; unit_price: number; reorder_level: number; is_active?: boolean }) {
  return apiFetch<void>(`/pharmacy/drugs/${id}`, { method: "PUT", body });
}
export function sellOtc(body: { patient_id?: string; discount?: number; tax?: number; payment_method?: string; rail_id?: string; reference?: string; lines: { drug_id: string; qty: number }[] }) {
  return apiFetch<{ id: string; total: string; status: string }>("/pharmacy/otc", { method: "POST", body });
}
export function pharmacyDashboard() {
  return apiFetch<Dashboard>("/pharmacy/dashboard");
}

// ---- Phase 4b-2: purchasing, stock control, reports ----

export interface Supplier {
  id: string;
  name: string;
  contact?: string;
  lead_time_days: number;
  is_active: boolean;
}
export interface PO {
  id: string;
  po_no: number;
  supplier: string;
  status: string;
  expected_date?: string;
  total: string;
  item_count: number;
}
export interface POItem {
  id: string;
  drug_name: string;
  qty: number;
  unit_cost: string;
  line_total: string;
  received: boolean;
}
export interface PODetail extends PO {
  items: POItem[];
}
export interface StockCount {
  id: string;
  status: string;
  created_at: string;
  approved_at?: string;
}
export interface StockCountItem {
  id: string;
  drug_name: string;
  on_hand: number;
  counted: number;
  variance: number;
  adjusted: boolean;
}
export interface StockCountDetail extends StockCount {
  items: StockCountItem[];
}
export interface Report {
  columns: string[];
  rows: string[][];
}

export function listSuppliers() {
  return apiFetch<Supplier[]>("/pharmacy/suppliers");
}
export function createSupplier(body: { name: string; contact?: string; lead_time_days?: number }) {
  return apiFetch<Supplier>("/pharmacy/suppliers", { method: "POST", body });
}
export function listPOs() {
  return apiFetch<PO[]>("/pharmacy/pos");
}
export function getPO(id: string) {
  return apiFetch<PODetail>(`/pharmacy/pos/${id}`);
}
export function createPO(body: { supplier_id: string; expected_date?: string; notes?: string; lines: { drug_id: string; qty: number; unit_cost: number }[] }) {
  return apiFetch<PO>("/pharmacy/pos", { method: "POST", body });
}
export function setPOStatus(id: string, status: string) {
  return apiFetch<void>(`/pharmacy/pos/${id}/status`, { method: "POST", body: { status } });
}
export function receivePO(id: string, items: { po_item_id: string; batch_no?: string; expiry?: string }[]) {
  return apiFetch<void>(`/pharmacy/pos/${id}/receive`, { method: "POST", body: { items } });
}
export function listStockCounts() {
  return apiFetch<StockCount[]>("/pharmacy/stock-counts");
}
export function createStockCount(note?: string) {
  return apiFetch<{ id: string }>("/pharmacy/stock-counts", { method: "POST", body: { note } });
}
export function getStockCount(id: string) {
  return apiFetch<StockCountDetail>(`/pharmacy/stock-counts/${id}`);
}
export function setCounted(itemId: string, counted: number) {
  return apiFetch<void>(`/pharmacy/stock-count-items/${itemId}/counted`, { method: "PUT", body: { counted } });
}
export function adjustCountItem(itemId: string) {
  return apiFetch<void>(`/pharmacy/stock-count-items/${itemId}/adjust`, { method: "POST" });
}
export function approveStockCount(id: string) {
  return apiFetch<void>(`/pharmacy/stock-counts/${id}/approve`, { method: "POST" });
}
export function pharmacyReport(kind: string) {
  return apiFetch<Report>(`/pharmacy/reports/${kind}`);
}
