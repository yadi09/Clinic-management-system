import { apiFetch } from "@/lib/api-client";

/** How this clinic sends, plus whether the platform can actually deliver. */
export interface MessagingSettings {
  enabled: boolean;
  lang: "en" | "am";
  quiet_from: string;
  quiet_to: string;
  sender_name: string;
  /** The Ethio-Telecom-approved name a patient's handset shows, once cleared. */
  sender_id?: string;
  sender_status: "none" | "pending" | "approved" | "rejected";
  /** A key is stored. Never the key itself. */
  has_own_key: boolean;
  /** What will actually lead each message — empty once the handset shows the name. */
  body_prefix: string;
  /** This clinic can reach the network. False = nothing will actually be sent. */
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
  sender_id?: string; sender_status?: string;
  /** Omit to keep the stored key; "" is not "delete" — use clear_api_key. */
  api_key?: string; clear_api_key?: boolean;
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

// --- automations: what the clinic says, and when -------------------------------

export type MessageKind = "welcome" | "appointment_reminder" | "bill_reminder" | "custom";

export interface MessageTemplate {
  kind: MessageKind;
  lang: "en" | "am";
  body: string;
  /** The body with sample values filled in — the only form that can be priced. */
  preview: string;
  segments: number;
  unicode: boolean;
  cost: string;
}

export interface MessageRule {
  kind: MessageKind;
  enabled: boolean;
  /** Negative = before the appointment; positive = after the bill appeared. */
  offset_hours: number;
  send_at?: string;
  repeat_days: number;
  max_repeats: number;
  /** How many of this kind actually went out this month. */
  sent: number;
}

export interface MessageVariable { name: string; describes: string }

export interface AudienceRow {
  id: string;
  name: string;
  mrn: string;
  phone?: string;
  reachable: boolean;
  /** missing | invalid | unsupported */
  phone_issue?: string;
  opted_out: boolean;
  last_visit?: string;
  owes?: string;
}

export interface CampaignResult {
  id: string; queued: number; skipped: number; segments: number; cost: string;
}

export function listTemplates() {
  return apiFetch<MessageTemplate[]>("/messaging/templates");
}
export function saveTemplate(body: { kind: string; lang: string; body: string }) {
  return apiFetch<void>("/messaging/templates", { method: "PUT", body });
}
export function listRules() {
  return apiFetch<MessageRule[]>("/messaging/rules");
}
export function saveRule(body: {
  kind: string; enabled: boolean; offset_hours: number; send_at?: string;
  repeat_days: number; max_repeats: number;
}) {
  return apiFetch<void>("/messaging/rules", { method: "PUT", body });
}
export function messageVariables() {
  return apiFetch<MessageVariable[]>("/messaging/variables");
}
export function messageAudience(p: { q?: string; seen_days?: number; owing?: boolean } = {}) {
  const s = new URLSearchParams();
  if (p.q) s.set("q", p.q);
  if (p.seen_days) s.set("seen_days", String(p.seen_days));
  if (p.owing) s.set("owing", "1");
  const q = s.toString();
  return apiFetch<AudienceRow[]>(`/messaging/audience${q ? `?${q}` : ""}`);
}
export function sendCampaign(body: {
  title: string; body: string; patient_ids: string[]; scheduled_for?: string;
}) {
  return apiFetch<CampaignResult>("/messaging/campaigns", { method: "POST", body });
}
