import { apiFetch } from "@/lib/api-client";

// ---- catalog ----

export interface LabTest {
  id: string;
  code: string;
  name: string;
  specimen?: string;
  is_active: boolean;
  analyte_count: number;
}
export interface Analyte {
  id: string;
  name: string;
  unit?: string;
  ref_low?: string;
  ref_high?: string;
  critical_low?: string;
  critical_high?: string;
}

export function listTests(activeOnly = false) {
  return apiFetch<LabTest[]>(`/lab/tests${activeOnly ? "?active=1" : ""}`);
}
export function listAnalytes(testId: string) {
  return apiFetch<Analyte[]>(`/lab/tests/${testId}/analytes`);
}
export function createTest(body: { code: string; name: string; specimen?: string }) {
  return apiFetch<LabTest>("/lab/tests", { method: "POST", body });
}
export function addAnalyte(testId: string, body: Omit<Analyte, "id">) {
  return apiFetch<void>(`/lab/tests/${testId}/analytes`, { method: "POST", body });
}

// ---- orders + doctor views ----

export interface OrderItemBrief {
  sample_no: number;
  status: string;
  test_name: string;
}
export interface AnalyteResult {
  analyte_id: string;
  name: string;
  unit?: string;
  ref_low?: string;
  ref_high?: string;
  value?: string;
  flag: string; // normal | low | high | critical
}
export interface EncounterOrderItem {
  sample_no: number;
  test_name: string;
  status: string;
  results: AnalyteResult[];
}
export interface EncounterOrder {
  order_no: number;
  priority: string;
  created_at: string;
  items: EncounterOrderItem[];
}
export interface PendingSummary {
  count: number;
  tests: string[];
}

export function createOrder(body: {
  encounter_id?: string;
  patient_id: string;
  priority?: string;
  clinical_note?: string;
  test_ids: string[];
}) {
  return apiFetch<{ id: string; order_no: number; items: OrderItemBrief[] }>("/lab/orders", { method: "POST", body });
}
export function encounterLabs(encounterId: string) {
  return apiFetch<EncounterOrder[]>(`/lab/encounters/${encounterId}/labs`);
}
export function pendingLabs(encounterId: string) {
  return apiFetch<PendingSummary>(`/lab/encounters/${encounterId}/pending`);
}

// ---- technician worklist + processing ----

export interface WorklistItem {
  id: string;
  sample_no: number;
  status: string;
  ordered_at: string;
  priority: string;
  patient_name: string;
  mrn: string;
  test_name: string;
}
export interface OrderItemDetail {
  id: string;
  sample_no: number;
  status: string;
  specimen?: string;
  test_name: string;
  patient_name: string;
  mrn: string;
  priority: string;
  clinical_note?: string;
  ordered_by?: string;
  critical: boolean;
  notified_at?: string;
  notified_by?: string;
  analytes: AnalyteResult[];
}

export interface InboxItem {
  id: string;
  encounter_id?: string | null;
  sample_no: number;
  test_name: string;
  patient_name: string;
  mrn: string;
  priority: string;
  validated_at?: string;
  critical: boolean;
  notified_at?: string;
  critical_count: number;
  abnormal_count: number;
}

export function worklist(status?: string) {
  return apiFetch<WorklistItem[]>(`/lab/worklist${status ? `?status=${status}` : ""}`);
}
export function getItem(itemId: string) {
  return apiFetch<OrderItemDetail>(`/lab/items/${itemId}`);
}
export function accession(itemId: string, collectedBy?: string) {
  return apiFetch<void>(`/lab/items/${itemId}/accession`, { method: "POST", body: { collected_by: collectedBy } });
}
export function saveResults(itemId: string, results: { analyte_id: string; value: string }[]) {
  return apiFetch<void>(`/lab/items/${itemId}/results`, { method: "PUT", body: { results } });
}
export function submitResults(itemId: string) {
  return apiFetch<void>(`/lab/items/${itemId}/submit`, { method: "POST" });
}
export function validateItem(itemId: string) {
  return apiFetch<void>(`/lab/items/${itemId}/validate`, { method: "POST" });
}

// ---- Phase 5b-1: critical acknowledgement + doctor inbox ----

export function markNotified(itemId: string) {
  return apiFetch<void>(`/lab/items/${itemId}/notify`, { method: "POST" });
}
export function resultsInbox(providerId?: string) {
  return apiFetch<InboxItem[]>(`/lab/inbox${providerId ? `?provider=${providerId}` : ""}`);
}
export function inboxCount() {
  return apiFetch<{ count: number }>("/lab/inbox/count");
}
