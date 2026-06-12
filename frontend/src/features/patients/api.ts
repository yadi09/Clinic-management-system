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
}

export async function searchPatients(q: string, page: number, pageSize: number): Promise<{ items: PatientSummary[]; meta: Meta }> {
  const params = new URLSearchParams({ q, page: String(page), page_size: String(pageSize) });
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
