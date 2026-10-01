import { apiFetch, apiList, AppError, type Meta } from "@/lib/api-client";

export interface PatientSummary {
  id: string;
  mrn: string;
  first_name: string;
  middle_name?: string;
  last_name: string;
  gender: string;
  dob: string;
  phone?: string;
  email?: string;
}

export interface Duplicate {
  id: string;
  mrn: string;
  full_name: string;
  dob: string;
  phone?: string;
  national_id?: string;
}

export interface Allergy {
  id: string;
  substance: string;
  reaction?: string;
  severity: string;
  created_at: string;
}
export interface Condition {
  id: string;
  icd_code?: string;
  description: string;
  status: string;
  onset_date?: string;
  created_at: string;
}
export interface Attachment {
  id: string;
  type: string;
  url: string;
  filename: string;
  mime_type: string;
  size_bytes: number;
  created_at: string;
}
export interface Guardian {
  id: string;
  relationship: string;
  created_at: string;
}

export interface Patient {
  id: string;
  mrn: string;
  first_name: string;
  middle_name?: string;
  last_name: string;
  gender: string;
  dob: string;
  national_id?: string;
  passport_no?: string;
  phone?: string;
  email?: string;
  blood_group?: string;
  created_at: string;
}

export interface Profile extends Patient {
  allergies: Allergy[];
  conditions: Condition[];
  attachments: Attachment[];
  guardians: Guardian[];
}

export interface PatientFormValues {
  mrn?: string; // existing card ID on import; blank = auto-generate
  first_name: string;
  middle_name?: string;
  last_name?: string; // optional: only the first name is required
  gender: string;
  dob: string; // "" when the age is not known
  national_id?: string;
  passport_no?: string;
  phone?: string;
  email?: string;
  blood_group?: string;
  /** The clinic recorded an age; dob was derived from it. */
  dob_estimated?: boolean;
}

/** Optional narrowing for the patient list. Omitted fields mean "no filter". */
export interface PatientFilters {
  gender?: string; // male | female | other | unknown
}
export async function searchPatients(
  q: string,
  page: number,
  pageSize: number,
  f: PatientFilters = {},
): Promise<{ items: PatientSummary[]; meta: Meta }> {
  const params = new URLSearchParams({ q, page: String(page), page_size: String(pageSize) });
  if (f.gender) params.set("gender", f.gender);
  return apiList<PatientSummary>(`/patients?${params.toString()}`);
}

export function getPatient(id: string): Promise<Profile> {
  return apiFetch<Profile>(`/patients/${id}`);
}

/** Create a patient. Returns the created patient, or duplicate matches when the
 * server flags possible duplicates (resubmit with force=true to proceed). */
export async function createPatient(values: PatientFormValues, force = false): Promise<{ patient?: Patient; duplicates?: Duplicate[] }> {
  try {
    const patient = await apiFetch<Patient>("/patients", { method: "POST", body: { ...values, force } });
    return { patient };
  } catch (e) {
    if (e instanceof AppError && e.code === "PATIENT_DUPLICATE") {
      const dups = (e.body as { duplicates?: Duplicate[] })?.duplicates ?? [];
      return { duplicates: dups };
    }
    throw e;
  }
}

export function updatePatient(id: string, values: PatientFormValues): Promise<Patient> {
  return apiFetch<Patient>(`/patients/${id}`, { method: "PUT", body: values });
}

/** Import a migrated (paper / old-system) record as a back-dated historical visit.
 *  History is split into SOAP sections; at least one must be non-empty. */
export interface HistoryImport {
  date?: string;
  subjective?: string; // History (HPI, past/family/personal)
  objective?: string; // Examination findings
  assessment?: string; // Diagnosis / assessment
  plan?: string; // Treatment / plan
}
export function importHistory(patientId: string, body: HistoryImport) {
  return apiFetch<{ encounter_id: string }>("/history-import", { method: "POST", body: { patient_id: patientId, ...body } });
}

// --- legacy register bulk import ---

/** One raw spreadsheet row. Values are sent unparsed — the server cleans, converts
 *  dates and matches duplicates, so every clinic's formatting is handled in one place. */
export interface ImportRowInput {
  row_number: number;
  mrn?: string;
  name: string;
  phone?: string;
  gender?: string;
  age?: string;
  visit_date?: string;
}
export type ImportOutcome = "imported" | "updated" | "duplicate" | "failed";
export interface ImportRowResult {
  row_number: number;
  name: string;
  phone: string;
  gender: string;
  age: string;
  visit_date: string;
  outcome: ImportOutcome;
  reason?: string;
  mrn?: string;
  warning?: string;
}
export interface ImportReport {
  total: number;
  imported: number;
  updated: number;
  duplicates: number;
  failed: number;
  missing_phone: number;
  missing_gender: number;
  estimated_dob: number;
  dry_run: boolean;
  rows: ImportRowResult[];
}
export function importPatients(body: {
  rows: ImportRowInput[];
  dry_run?: boolean;
  on_duplicate?: "skip" | "update";
  /** Calendar the sheet's dates are written in. Dates are always stored Gregorian. */
  calendar?: "ethiopian" | "gregorian";
}) {
  return apiFetch<ImportReport>("/patients/import", { method: "POST", body });
}

export function addAllergy(patientId: string, body: { substance: string; reaction?: string; severity: string }) {
  return apiFetch<{ id: string }>(`/patients/${patientId}/allergies`, { method: "POST", body });
}
export function removeAllergy(patientId: string, id: string) {
  return apiFetch<void>(`/patients/${patientId}/allergies/${id}`, { method: "DELETE" });
}
export function addCondition(patientId: string, body: { icd_code?: string; description: string; status: string; onset_date?: string }) {
  return apiFetch<{ id: string }>(`/patients/${patientId}/conditions`, { method: "POST", body });
}
export function removeCondition(patientId: string, id: string) {
  return apiFetch<void>(`/patients/${patientId}/conditions/${id}`, { method: "DELETE" });
}

// --- what is true about this patient right now -----------------------------
//
// The record (allergies, conditions, past visits) says who someone is over time.
// This says where they are standing, what they owe, what is on the bench and when
// they are next expected — the questions the four people who open this page arrive
// with. Blocks are filled by the server according to the caller's permissions, so
// an absent block means "not yours to see", not "nothing to report".
export interface Presence {
  kind: "queue" | "bed";
  state?: string;
  stage?: string;
  where?: string;
  provider?: string;
  since: string;
  nights?: number;
}
export interface PatientOverview {
  here_now?: Presence;
  money?: { owed: string; oldest_days: number; all_agreed: boolean; last_paid_at?: string };
  next_appointment?: { starts_at: string; provider?: string; department?: string; is_followup: boolean };
  last_visit?: { at: string; diagnosis?: string; provider?: string; open: boolean };
  labs?: { on_the_bench: number; to_validate: number; critical: number; last_at?: string };
  vitals?: {
    recorded_at: string;
    systolic?: number; diastolic?: number; pulse?: number; temp_c?: string;
    resp_rate?: number; spo2?: number; weight_kg?: string; height_cm?: string;
  };
}
export function patientOverview(id: string): Promise<PatientOverview> {
  return apiFetch<PatientOverview>(`/patients/${id}/overview`);
}

/** Every test this patient has ever had, newest order first. */
export interface PatientLabOrder {
  order_no: number;
  priority: string;
  created_at: string;
  items: {
    sample_no: number;
    test_name: string;
    status: string;
    results: { name: string; unit?: string; value?: string; flag: string; ref_low?: string; ref_high?: string }[];
  }[];
}
export function patientLabs(id: string): Promise<PatientLabOrder[]> {
  return apiFetch<PatientLabOrder[]>(`/lab/patients/${id}/labs`);
}
