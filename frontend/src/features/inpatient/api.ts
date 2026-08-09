import { apiFetch } from "@/lib/api-client";

export interface Ward {
  id: string;
  name: string;
  is_active: boolean;
  bed_count: number;
}
export interface Bed {
  id: string;
  ward_id: string;
  ward_name: string;
  label: string;
  bed_type: string;
  daily_rate: string;
  out_of_service: boolean;
  is_active: boolean;
  note?: string;
}
export interface BoardBed {
  id: string;
  ward_id: string;
  ward_name: string;
  label: string;
  bed_type: string;
  daily_rate: string;
  out_of_service: boolean;
  occupied: boolean;
  days: number;
  overdue: boolean;
  admission_id?: string;
  patient_id?: string;
  patient_name?: string;
  mrn?: string;
  admitted_at?: string;
  est_cost?: string;
  payment_due_at?: string;
}
export interface Admission {
  id?: string;
  patient_name: string;
  mrn: string;
  ward_name: string;
  bed_label: string;
  admitted_at: string;
  discharged_at?: string;
  status: string;
  daily_rate: string;
  days: number;
  est_cost: string;
  overdue: boolean;
  payment_due_at?: string;
}
export interface BedReport {
  total_beds: number;
  occupied: number;
  available: number;
  by_ward: { ward: string; total: number; occupied: number }[];
  current_patients: number;
  avg_los_days: number;
  bed_revenue: string;
  overdue: Admission[];
}

export const listWards = () => apiFetch<Ward[]>("/inpatient/wards");
export const createWard = (name: string) => apiFetch<Ward>("/inpatient/wards", { method: "POST", body: { name } });
export const updateWard = (id: string, body: { name?: string; is_active?: boolean }) =>
  apiFetch<void>(`/inpatient/wards/${id}`, { method: "PUT", body });

export const listBeds = () => apiFetch<Bed[]>("/inpatient/beds");
export const createBed = (body: { ward_id: string; label: string; bed_type?: string; daily_rate: string; note?: string }) =>
  apiFetch<Bed>("/inpatient/beds", { method: "POST", body });
export const updateBed = (
  id: string,
  body: { ward_id?: string; label?: string; bed_type?: string; daily_rate?: string; out_of_service?: boolean; is_active?: boolean; note?: string },
) => apiFetch<void>(`/inpatient/beds/${id}`, { method: "PUT", body });

export const bedBoard = () => apiFetch<BoardBed[]>("/inpatient/board");
export const admit = (body: { patient_id: string; bed_id: string; deposit_amount?: string; payment_due_at?: string; expected_discharge?: string; note?: string }) =>
  apiFetch<Admission>("/inpatient/admissions", { method: "POST", body });
export const discharge = (admissionId: string) => apiFetch<Admission>(`/inpatient/admissions/${admissionId}/discharge`, { method: "POST" });
export const transfer = (admissionId: string, bedId: string) =>
  apiFetch<void>(`/inpatient/admissions/${admissionId}/transfer`, { method: "POST", body: { bed_id: bedId } });
export const bedReport = () => apiFetch<BedReport>("/inpatient/report");
