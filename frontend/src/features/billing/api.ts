import { apiFetch } from "@/lib/api-client";

export interface CardAssessment {
  requires_payment: boolean;
  card_enabled: boolean;
  amount: string;
  currency: string;
  reason: string;
}

export interface CardPayment {
  id: string;
  amount: string;
  currency: string;
  waived: boolean;
  waive_reason?: string;
  paid_at: string;
}

/** Card-fee decision for a patient (optionally attending an appointment). */
export function assessCard(patientId: string, appointmentId?: string) {
  const p = new URLSearchParams({ patient: patientId });
  if (appointmentId) p.set("appointment", appointmentId);
  return apiFetch<CardAssessment>(`/billing/card/assess?${p.toString()}`);
}

export function collectCard(body: {
  patient_id: string;
  branch_id: string;
  appointment_id?: string;
  waived?: boolean;
  waive_reason?: string;
}) {
  return apiFetch<CardPayment>("/billing/card/collect", { method: "POST", body });
}

export function cardHistory(patientId: string) {
  return apiFetch<CardPayment[]>(`/billing/card/history?patient=${patientId}`);
}
