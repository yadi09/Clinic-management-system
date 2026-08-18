import { apiFetch } from "@/lib/api-client";

/** How this clinic sends, plus whether the platform can actually deliver. */
export interface MessagingSettings {
  enabled: boolean;
  lang: "en" | "am";
  quiet_from: string;
  quiet_to: string;
  sender_name: string;
  /** The platform has SMS credentials. False = nothing will actually be sent. */
  gateway_live: boolean;
  gateway_name: string;
  cost_per_segment: number;
}

/** This month's spend. Counted in segments, which is what the gateway bills. */
export interface MessagingUsage {
  used_segments: number;
  /** Absent = the plan has no cap. */
  limit?: number;
  sent: number;
  failed: number;
  skipped: number;
  cost: string;
}

export interface MessagePreview {
  body: string;
  segments: number;
  unicode: boolean;
  chars: number;
  per_segment: number;
  cost: string;
}

/**
 * "sent" means the network accepted it; "delivered" means a handset confirmed it.
 * Two different facts, and the gap between them is exactly what a patient means by
 * "I never got it", so they are never merged.
 */
export type MessageStatus =
  | "scheduled" | "sending" | "sent" | "delivered" | "failed" | "skipped" | "cancelled";

export interface MessageRow {
  id: string;
  kind: string;
  lang: string;
  msisdn: string;
  body: string;
  segments: number;
  cost: string;
  status: MessageStatus;
  skip_reason?: string;
  last_error?: string;
  scheduled_for: string;
  sent_at?: string;
  delivered_at?: string;
  created_at: string;
  patient_id?: string;
  patient_name?: string;
  mrn?: string;
}

export function getMessagingSettings() {
  return apiFetch<MessagingSettings>("/messaging/settings");
}
export function saveMessagingSettings(body: {
  enabled: boolean; lang: string; quiet_from: string; quiet_to: string; sender_name: string;
}) {
  return apiFetch<MessagingSettings>("/messaging/settings", { method: "PUT", body });
}
export function messagingUsage() {
  return apiFetch<MessagingUsage>("/messaging/usage");
}
/** Prices a draft server-side, so the number shown is the number charged. */
export function previewMessage(body: string) {
  return apiFetch<MessagePreview>("/messaging/preview", { method: "POST", body: { body } });
}
export function messageLog(p: { kind?: string; status?: string; patient?: string } = {}) {
  const q = new URLSearchParams();
  if (p.kind) q.set("kind", p.kind);
  if (p.status) q.set("status", p.status);
  if (p.patient) q.set("patient", p.patient);
  const s = q.toString();
  return apiFetch<MessageRow[]>(`/messaging/log${s ? `?${s}` : ""}`);
}
export function sendTestMessage(phone: string, body: string) {
  return apiFetch<void>("/messaging/test", { method: "POST", body: { phone, body } });
}
