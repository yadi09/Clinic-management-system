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
  is_followup: boolean;
  free_until?: string;
  patient_name: string;
  mrn: string;
  provider_name: string;
  department_name?: string;
}

export interface QueueEntry {
  id: string;
  patient_id: string;
  assigned_provider_id?: string | null;
  state: string;
  stage: string;
  priority: number;
  enqueued_at: string;
  called_at?: string;
  started_at?: string;
  ended_at?: string;
  patient_name: string;
  mrn: string;
  provider_name?: string;
  has_vitals: boolean;
  in_lab: boolean;
}

export interface WorklistEntry {
  id: string;
  patient_id: string;
  department_id: string;
  state: string;
  stage: string;
  priority: number;
  enqueued_at: string;
  called_at?: string;
  started_at?: string;
  patient_name: string;
  mrn: string;
  department_name?: string;
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
export interface CheckInOpts {
  priority?: number;
  to_triage?: boolean;
  provider_id?: string;
}
export function checkInAppointment(id: string, opts: CheckInOpts = {}) {
  return apiFetch<{ gated: boolean }>(`/appointments/${id}/check-in`, { method: "POST", body: { priority: 0, ...opts } });
}
/** Mark an appointment as a covered (doctor-booked) follow-up, free of the card fee within its window. */
export function markFollowup(id: string, freeUntilISO?: string) {
  return apiFetch<void>(`/appointments/${id}/followup`, { method: "POST", body: { free_until: freeUntilISO } });
}

export function listQueue(departmentId: string, stage?: string, window?: { from?: string; to?: string }) {
  const p = new URLSearchParams({ department: departmentId });
  if (stage) p.set("stage", stage);
  if (window?.from) p.set("from", window.from);
  if (window?.to) p.set("to", window.to);
  return apiFetch<QueueEntry[]>(`/queue?${p.toString()}`);
}
export function transitionQueue(id: string, state: string) {
  return apiFetch<void>(`/queue/${id}/transition`, { method: "POST", body: { state } });
}
export function assignProvider(id: string, providerId: string) {
  return apiFetch<void>(`/queue/${id}/assign`, { method: "POST", body: { provider_id: providerId } });
}
export function listWorklist(providerId?: string, fromISO?: string) {
  const p = new URLSearchParams();
  if (providerId) p.set("provider", providerId);
  if (fromISO) p.set("from", fromISO);
  const qs = p.toString();
  return apiFetch<WorklistEntry[]>(`/worklist${qs ? `?${qs}` : ""}`);
}
/** Patients past triage but not yet claimed by any doctor — the My-day pick-up pool. */
export function listUnassigned(fromISO?: string) {
  return apiFetch<WorklistEntry[]>(`/worklist/unassigned${fromISO ? `?from=${encodeURIComponent(fromISO)}` : ""}`);
}
export function walkIn(body: {
  branch_id: string;
  department_id: string;
  patient_id: string;
  priority?: number;
  to_triage?: boolean;
  provider_id?: string;
}) {
  return apiFetch<{ status: string; gated: boolean }>("/queue/walk-in", { method: "POST", body });
}

/** SSE URL for the live queue stream (token in query — EventSource can't set headers). */
export function queueStreamUrl(departmentId: string) {
  const token = tokenStore.get() ?? "";
  return `${BASE}/queue/stream?department=${encodeURIComponent(departmentId)}&token=${encodeURIComponent(token)}`;
}
