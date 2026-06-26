import { apiFetch } from "@/lib/api-client";
import { tokenStore } from "@/lib/token";

const API_BASE = import.meta.env.VITE_API_BASE_URL ?? "/api/v1";

/** Send a recorded audio clip for speech-to-text (voice dictation). Returns the transcript. */
export async function transcribe(blob: Blob): Promise<string> {
  const res = await fetch(`${API_BASE}/transcribe`, {
    method: "POST",
    headers: { "Content-Type": blob.type || "audio/webm", Authorization: `Bearer ${tokenStore.get() ?? ""}` },
    credentials: "include",
    body: blob,
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    const code = json?.error?.code;
    if (code === "TRANSCRIPTION_DISABLED") throw new Error("Voice dictation isn't enabled for this clinic.");
    throw new Error(json?.error?.message || "Could not transcribe the audio.");
  }
  return (json?.data?.text ?? "") as string;
}

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

// ---- Vitals form configuration (VITALS-A) ----

export interface VitalField {
  key: string;
  label: string;
  unit: string;
  decimals: number;
  enabled: boolean;
  required: boolean;
  order: number;
  min?: number;
  low?: number;
  high?: number;
  max?: number;
}
/** The clinic's configurable vitals form (defaults merged with admin overrides). */
export function getVitalFields() {
  return apiFetch<VitalField[]>("/vital-fields");
}
export function saveVitalFields(fields: VitalField[]) {
  return apiFetch<void>("/vital-fields", { method: "PUT", body: { fields } });
}

/** Classify a numeric value against a field's reference range (low/normal/high). */
export function vitalFlag(field: VitalField, value: number): "low" | "normal" | "high" | null {
  if (field.low != null && value < field.low) return "low";
  if (field.high != null && value > field.high) return "high";
  if (field.low != null || field.high != null) return "normal";
  return null;
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
  allergens?: string[]; // the drug's allergen tags
  allergy_override?: string; // reason, if prescribed despite an allergy warning
}
export interface ReferralValue {
  name: string;
  value: string;
  unit?: string;
  ref?: string;
  flag?: string;
}
export interface ReferralFile {
  key: string;
  url: string;
  name: string;
  mime?: string;
}
export interface LabReferral {
  id: string;
  tests: string;
  indication?: string;
  status: string; // requested | resulted | cancelled
  result_summary?: string;
  result_values?: ReferralValue[];
  result_files?: ReferralFile[];
  external_lab?: string;
  resulted_at?: string;
  created_at: string;
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
  lab_referrals: LabReferral[];
}
export function createLabReferral(encounterId: string, body: { tests: string; indication?: string }) {
  return apiFetch<LabReferral>(`/encounters/${encounterId}/lab-referrals`, { method: "POST", body });
}
export function recordLabReferralResult(referralId: string, body: { summary?: string; external_lab?: string; values?: ReferralValue[]; files?: ReferralFile[] }) {
  return apiFetch<void>(`/lab-referrals/${referralId}/result`, { method: "POST", body });
}
export function cancelLabReferral(referralId: string) {
  return apiFetch<void>(`/lab-referrals/${referralId}/cancel`, { method: "POST" });
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
export interface AddMedicationBody {
  drug_name: string;
  dose?: string;
  frequency?: string;
  duration?: string;
  instructions?: string;
  drug_id?: string; // link to the drug library
  override_reason?: string; // set to prescribe despite an allergy warning
}
export function addMedication(encounterId: string, body: AddMedicationBody) {
  return apiFetch<Medication>(`/encounters/${encounterId}/prescriptions`, { method: "POST", body });
}

// ---- Drug & allergen libraries (RX-LIB) ----

export interface Allergen {
  id: string;
  name: string;
  is_active: boolean;
}
export interface Drug {
  id: string;
  name: string;
  default_dose?: string;
  default_frequency?: string;
  default_duration?: string;
  default_instructions?: string;
  is_active: boolean;
  allergens: string[];
}
export function searchDrugs(search?: string, all = false) {
  const p = new URLSearchParams();
  if (search) p.set("search", search);
  if (all) p.set("all", "1");
  const qs = p.toString();
  return apiFetch<Drug[]>(`/drugs${qs ? `?${qs}` : ""}`);
}
export function createDrug(body: { name: string; default_dose?: string; default_frequency?: string; default_duration?: string; default_instructions?: string; allergen_ids?: string[] }) {
  return apiFetch<Drug>("/drugs", { method: "POST", body });
}
export function updateDrug(id: string, body: { name: string; default_dose?: string; default_frequency?: string; default_duration?: string; default_instructions?: string; is_active?: boolean; allergen_ids?: string[] }) {
  return apiFetch<void>(`/drugs/${id}`, { method: "PUT", body });
}
export function deleteDrug(id: string) {
  return apiFetch<void>(`/drugs/${id}`, { method: "DELETE" });
}
export function listAllergens(search?: string, all = false) {
  const p = new URLSearchParams();
  if (search) p.set("search", search);
  if (all) p.set("all", "1");
  const qs = p.toString();
  return apiFetch<Allergen[]>(`/allergens${qs ? `?${qs}` : ""}`);
}
export function createAllergen(name: string) {
  return apiFetch<Allergen>("/allergens", { method: "POST", body: { name } });
}
export function updateAllergen(id: string, body: { name: string; is_active?: boolean }) {
  return apiFetch<void>(`/allergens/${id}`, { method: "PUT", body });
}
export function deleteAllergen(id: string) {
  return apiFetch<void>(`/allergens/${id}`, { method: "DELETE" });
}
export function removeMedication(encounterId: string, itemId: string) {
  return apiFetch<void>(`/encounters/${encounterId}/prescriptions/${itemId}`, { method: "DELETE" });
}
export function signEncounter(encounterId: string) {
  return apiFetch<void>(`/encounters/${encounterId}/sign`, { method: "POST" });
}
/** Park an open encounter as awaiting_results (e.g. labs pending) without locking it. */
export function setAside(encounterId: string) {
  return apiFetch<void>(`/encounters/${encounterId}/set-aside`, { method: "POST" });
}

// ---- Phase 5a: doctor "My day" board ----

export interface BoardActive {
  encounter_id: string;
  queue_entry_id?: string | null;
  status: string; // open | awaiting_results
  started_at: string;
  patient_name: string;
  mrn: string;
  pending_labs: number;
}
export interface BoardDone {
  encounter_id: string;
  closed_at?: string;
  started_at: string;
  patient_name: string;
  mrn: string;
}
export interface Board {
  active: BoardActive[];
  done: BoardDone[];
}
/** The calling doctor's in-progress (always) and recently-done encounters.
 *  fromISO windows the "done" list (e.g. start of today, or 3 days back). */
export function myBoard(providerId?: string, fromISO?: string, toISO?: string) {
  const p = new URLSearchParams();
  if (providerId) p.set("provider", providerId);
  if (fromISO) p.set("from", fromISO);
  if (toISO) p.set("to", toISO);
  const qs = p.toString();
  return apiFetch<Board>(`/encounters/board${qs ? `?${qs}` : ""}`);
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
