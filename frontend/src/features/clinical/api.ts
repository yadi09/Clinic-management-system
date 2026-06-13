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
