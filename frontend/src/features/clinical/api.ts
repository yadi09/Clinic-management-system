import { apiFetch } from "@/lib/api-client";

export interface Vitals {
  systolic?: number;
  diastolic?: number;
  pulse?: number;
  resp_rate?: number;
  spo2?: number;
  temp_c?: string;
  weight_kg?: string;
  height_cm?: string;
  notes?: string;
  recorded_at: string;
}

export interface Visit {
  encounter: { id: string; status: string; started_at: string } | null;
  vitals: Vitals[];
}

export interface VitalsBody {
  branch_id: string;
  department_id?: string;
  provider_id?: string;
  systolic?: number;
  diastolic?: number;
  pulse?: number;
  resp_rate?: number;
  spo2?: number;
  temp_c?: number;
  weight_kg?: number;
  height_cm?: number;
  notes?: string;
}

/** Record triage vitals for a visit (queue entry). patientId is required to open the encounter. */
export function recordVitals(queueEntryId: string, patientId: string, body: VitalsBody) {
  return apiFetch<Visit>(`/visits/${queueEntryId}/vitals?patient=${patientId}`, { method: "POST", body });
}

export function getVisit(queueEntryId: string) {
  return apiFetch<Visit>(`/visits/${queueEntryId}`);
}

// ---- Phase 3b: consultation / EMR ----

export interface Allergy {
  substance: string;
  severity: string;
  reaction?: string;
}
export interface Note {
  subjective: string;
  objective: string;
  assessment: string;
  plan: string;
  status: string; // draft | signed
  signed_at?: string;
}
export interface Diagnosis {
  id: string;
  code?: string;
  description: string;
  is_primary: boolean;
  category_name?: string;
}
export interface Medication {
  id: string;
  drug_name: string;
  dose?: string;
  frequency?: string;
  duration?: string;
  instructions?: string;
}
export interface Workspace {
  encounter_id: string;
  status: string; // open | closed
  started_at: string;
  branch_id: string;
  department_id?: string | null;
  provider_id?: string | null;
  patient: { patient_id: string; name: string; mrn: string; age: number; gender: string; blood_group?: string };
  allergies: Allergy[];
  vitals: Vitals[];
  note: Note;
  diagnoses: Diagnosis[];
  prescription: Medication[];
}

export interface HistoryItem {
  id: string;
  started_at: string;
  status: string;
  type: string;
  provider_name?: string;
  primary_dx?: string;
}
/** Past encounters for the patient (timeline). */
export function listHistory(patientId: string) {
  return apiFetch<HistoryItem[]>(`/encounters?patient=${patientId}`);
}

export interface CatalogEntry {
  id: string;
  category_id: string;
  category_name: string;
  code?: string;
  name: string;
  is_active: boolean;
}
export interface DiagnosisCategory {
  id: string;
  name: string;
  sort_order: number;
  is_active: boolean;
}

/** Open (or get) the encounter for a worklist queue entry. */
export function openEncounter(queueEntryId: string) {
  return apiFetch<Workspace>("/encounters", { method: "POST", body: { queue_entry_id: queueEntryId } });
}
export function getWorkspace(encounterId: string) {
  return apiFetch<Workspace>(`/encounters/${encounterId}`);
}
export function saveNote(encounterId: string, body: Partial<Pick<Note, "subjective" | "objective" | "assessment" | "plan">>) {
  return apiFetch<void>(`/encounters/${encounterId}/note`, { method: "PUT", body });
}
export function addDiagnosis(encounterId: string, body: { catalog_id?: string; code?: string; description?: string; is_primary?: boolean }) {
  return apiFetch<Diagnosis>(`/encounters/${encounterId}/diagnoses`, { method: "POST", body });
}
export function removeDiagnosis(encounterId: string, dxId: string) {
  return apiFetch<void>(`/encounters/${encounterId}/diagnoses/${dxId}`, { method: "DELETE" });
}
export function addMedication(encounterId: string, body: Omit<Medication, "id">) {
  return apiFetch<Medication>(`/encounters/${encounterId}/prescriptions`, { method: "POST", body });
}
export function removeMedication(encounterId: string, itemId: string) {
  return apiFetch<void>(`/encounters/${encounterId}/prescriptions/${itemId}`, { method: "DELETE" });
}
export function signEncounter(encounterId: string) {
  return apiFetch<void>(`/encounters/${encounterId}/sign`, { method: "POST" });
}

// Diagnosis catalog
export function searchCatalog(params: { search?: string; category?: string; all?: boolean } = {}) {
  const q = new URLSearchParams();
  if (params.search) q.set("search", params.search);
  if (params.category) q.set("category", params.category);
  if (params.all) q.set("all", "1");
  const qs = q.toString();
  return apiFetch<CatalogEntry[]>(`/diagnosis-catalog${qs ? `?${qs}` : ""}`);
}
export function listDiagnosisCategories() {
  return apiFetch<DiagnosisCategory[]>("/diagnosis-categories");
}
export function createCategory(body: { name: string; sort_order?: number }) {
  return apiFetch<DiagnosisCategory>("/diagnosis-categories", { method: "POST", body });
}
export function updateCategory(id: string, body: { name: string; sort_order?: number; is_active?: boolean }) {
  return apiFetch<void>(`/diagnosis-categories/${id}`, { method: "PUT", body });
}
export function deleteCategory(id: string) {
  return apiFetch<void>(`/diagnosis-categories/${id}`, { method: "DELETE" });
}
export function createCatalogEntry(body: { category_id: string; code?: string; name: string }) {
  return apiFetch<CatalogEntry>("/diagnosis-catalog", { method: "POST", body });
}
export function updateCatalogEntry(id: string, body: { category_id: string; code?: string; name: string; is_active?: boolean }) {
  return apiFetch<void>(`/diagnosis-catalog/${id}`, { method: "PUT", body });
}
export function deleteCatalogEntry(id: string) {
  return apiFetch<void>(`/diagnosis-catalog/${id}`, { method: "DELETE" });
}
