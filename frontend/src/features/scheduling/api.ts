import { apiFetch } from "@/lib/api-client";
import { tokenStore } from "@/lib/token";

const BASE = import.meta.env.VITE_API_BASE_URL ?? "/api/v1";

export interface Appointment {
  id: string;
  patient_id: string;
  provider_id: string;
  department_id?: string | null;
  resource_id?: string | null;
  starts_at: string;
  ends_at: string;
  status: string;
  reason?: string;
  patient_name: string;
  mrn: string;
  provider_name: string;
  department_name?: string;
}

export interface QueueEntry {
  id: string;
  patient_id: string;
  state: string;
  priority: number;
  enqueued_at: string;
  called_at?: string;
  started_at?: string;
  ended_at?: string;
  patient_name: string;
  mrn: string;
}

export interface BookBody {
  branch_id: string;
  patient_id: string;
  provider_id: string;
  department_id?: string;
  resource_id?: string;
  starts_at: string; // RFC3339
  duration_min: number;
  reason?: string;
}

export function listAppointments(branchId: string, fromISO: string, toISO: string, providerId?: string) {
  const p = new URLSearchParams({ branch: branchId, from: fromISO, to: toISO });
  if (providerId) p.set("provider", providerId);
  return apiFetch<Appointment[]>(`/appointments?${p.toString()}`);
}
export function bookAppointment(body: BookBody) {
  return apiFetch<Appointment>("/appointments", { method: "POST", body });
}
export function rescheduleAppointment(id: string, body: Omit<BookBody, "branch_id" | "patient_id">) {
  return apiFetch<Appointment>(`/appointments/${id}`, { method: "PUT", body });
}
export function setAppointmentStatus(id: string, status: string, cancelReason?: string) {
  return apiFetch<void>(`/appointments/${id}/status`, { method: "POST", body: { status, cancel_reason: cancelReason } });
}
export function checkInAppointment(id: string, priority = 0) {
  return apiFetch<void>(`/appointments/${id}/check-in`, { method: "POST", body: { priority } });
}

export function listQueue(departmentId: string) {
  return apiFetch<QueueEntry[]>(`/queue?department=${departmentId}`);
}
export function transitionQueue(id: string, state: string) {
  return apiFetch<void>(`/queue/${id}/transition`, { method: "POST", body: { state } });
}
export function walkIn(body: { branch_id: string; department_id: string; patient_id: string; priority?: number }) {
  return apiFetch<{ status: string }>("/queue/walk-in", { method: "POST", body });
}

/** SSE URL for the live queue stream (token in query — EventSource can't set headers). */
export function queueStreamUrl(departmentId: string) {
  const token = tokenStore.get() ?? "";
  return `${BASE}/queue/stream?department=${encodeURIComponent(departmentId)}&token=${encodeURIComponent(token)}`;
}
