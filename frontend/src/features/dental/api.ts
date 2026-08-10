// Dental module API — tooth chart (odontogram), scheduled treatment PLANS made of
// dated SESSIONS (each with its own payment, notes/Rx and images), and the
// installment balance. Session payments flow through the shared billing spine:
// "collect" puts a pending charge on the cashier's queue (source='dental').
import { apiFetch } from "@/lib/api-client";

export type ToothStatus = "healthy" | "decayed" | "filled" | "extracted" | "crown";

export interface Chart {
  teeth: Record<string, string>;
  updated_at?: string;
}

export interface Balance {
  owed: string;
  paid: string; // settled MINUS refunded — money actually retained
  balance: string;
  /** Raised and with the cashier. Deliberately NOT part of `due`. */
  at_cashier: string;
  /** Formally forgiven — neither owed nor collected. */
  waived: string;
  due: string; // treatment DELIVERED but not paid (includes refunded, excludes waived)
  overdue: boolean;
}

// --- images (X-rays, before/after) ---

export type ImageCategory = "before" | "after" | "xray";

export interface DentalImage {
  id: string;
  url: string;
  filename: string;
  mime_type: string;
  size_bytes: number;
  created_at: string;
  category?: string; // before | after | xray | "" (uncategorised)
}

export interface RxItem {
  drug_name: string;
  dose?: string;
  frequency?: string;
  duration?: string;
  instructions?: string;
}

export interface Prescription {
  id: string;
  note?: string;
  created_at: string;
  items: RxItem[];
}

interface UploadTarget {
  method: string;
  url: string;
  fields: Record<string, string>;
  key: string;
}

// --- treatment plans + sessions ---

export type SessionStatus = "planned" | "done" | "cancelled";
// "refunded" and "waived" are sent once the server-side money projection ships;
// the client understands them first so the two can be deployed independently.
export type PaymentState = "unpaid" | "billed" | "paid" | "refunded" | "waived";

export interface Session {
  id: string;
  seq: number;
  scheduled_date: string; // YYYY-MM-DD
  amount_due: string;
  status: SessionStatus;
  payment: PaymentState;
  procedure?: string;
  tooth?: string;
  notes?: string;
  rx?: string;
  pay_later?: boolean;
  pay_later_note?: string;
  images: DentalImage[];
  prescriptions: Prescription[];
}

export interface Plan {
  id: string;
  title: string;
  tooth?: string;
  total_amount: string;
  start_date: string;
  interval_unit: string; // day | week | month
  interval_count: number;
  session_count: number;
  deadline?: string;
  status: "active" | "completed" | "cancelled";
  note?: string;
  created_at: string;
  sessions: Session[];
}

export interface Summary {
  chart: Chart;
  plans: Plan[];
  balance: Balance;
  image_limit: number; // plan's images-per-patient cap; -1 = unlimited
}

export interface Outstanding {
  patient_id: string;
  patient_name: string;
  mrn: string;
  balance: string;
}

export function dentalSummary(patientId: string) {
  return apiFetch<Summary>(`/dental/patients/${patientId}/summary`);
}

export function saveChart(patientId: string, teeth: Record<string, string>) {
  return apiFetch<Chart>(`/dental/patients/${patientId}/chart`, { method: "PUT", body: { teeth } });
}

export interface CreatePlanBody {
  title: string;
  tooth?: string;
  total_amount: string;
  start_date: string;
  interval_unit: string;
  interval_count: number;
  session_count: number;
  note?: string;
  // The create preview sends the final per-session rows (dates + amounts).
  sessions?: { scheduled_date: string; amount_due: string }[];
}

export function listPlans(patientId: string) {
  return apiFetch<Plan[]>(`/dental/patients/${patientId}/plans`);
}
export function createPlan(patientId: string, body: CreatePlanBody) {
  return apiFetch<Plan>(`/dental/patients/${patientId}/plans`, { method: "POST", body });
}
export function updatePlan(patientId: string, planId: string, body: { title?: string; tooth?: string; note?: string; status?: string }) {
  return apiFetch<void>(`/dental/patients/${patientId}/plans/${planId}`, { method: "PUT", body });
}
export function deletePlan(patientId: string, planId: string) {
  return apiFetch<void>(`/dental/patients/${patientId}/plans/${planId}`, { method: "DELETE" });
}
export function updateSession(patientId: string, sessionId: string, body: { scheduled_date?: string; amount_due?: string; status?: string; procedure?: string; tooth?: string; notes?: string; rx?: string }) {
  return apiFetch<void>(`/dental/patients/${patientId}/sessions/${sessionId}`, { method: "PUT", body });
}
/** Move a planned session to another date — and nothing else. Reachable with
 *  appointment.manage (the front desk) as well as dental.manage, unlike
 *  updateSession above which is dentist-only. */
export function rescheduleSession(patientId: string, sessionId: string, scheduledDate: string) {
  return apiFetch<void>(`/dental/patients/${patientId}/sessions/${sessionId}/reschedule`, {
    method: "POST",
    body: { scheduled_date: scheduledDate },
  });
}
export function collectSession(patientId: string, sessionId: string) {
  return apiFetch<void>(`/dental/patients/${patientId}/sessions/${sessionId}/collect`, { method: "POST" });
}
export function uncollectSession(patientId: string, sessionId: string) {
  return apiFetch<void>(`/dental/patients/${patientId}/sessions/${sessionId}/uncollect`, { method: "POST" });
}
/** Bill several sessions at once (front desk settling a whole plan). Empty list = everything outstanding. */
export function collectSessions(patientId: string, sessionIds: string[] = []) {
  return apiFetch<{ billed: number; total: string }>(`/dental/patients/${patientId}/collect-sessions`, {
    method: "POST",
    body: { session_ids: sessionIds },
  });
}
export function setPayLater(patientId: string, sessionId: string, body: { on?: boolean; note?: string }) {
  return apiFetch<void>(`/dental/patients/${patientId}/sessions/${sessionId}/pay-later`, { method: "POST", body });
}

export function addPrescription(patientId: string, sessionId: string, body: { note?: string; items: RxItem[] }) {
  return apiFetch<Prescription>(`/dental/patients/${patientId}/sessions/${sessionId}/prescriptions`, { method: "POST", body });
}
export function deletePrescription(patientId: string, prescriptionId: string) {
  return apiFetch<void>(`/dental/patients/${patientId}/prescriptions/${prescriptionId}`, { method: "DELETE" });
}

export function dentalOutstanding() {
  return apiFetch<Outstanding[]>("/dental/outstanding");
}

// One treatment session placed on the clinic calendar (all patients, a date range).
export interface DentalSessionCal {
  session_id: string;
  plan_id: string;
  patient_id: string;
  patient_name: string;
  mrn: string;
  scheduled_date: string; // YYYY-MM-DD
  seq: number;
  session_count: number;
  title: string;
  procedure?: string;
  tooth?: string;
  amount_due: string;
  status: string; // planned | done
  payment: PaymentState;
  pay_later: boolean;
}
export function listDentalSessions(from: string, to: string) {
  return apiFetch<DentalSessionCal[]>(`/dental/sessions?from=${from}&to=${to}`);
}

export function listDentalImages(patientId: string, sessionId?: string) {
  const q = sessionId ? `?session=${encodeURIComponent(sessionId)}` : "";
  return apiFetch<DentalImage[]>(`/dental/patients/${patientId}/images${q}`);
}
export function deleteDentalImage(patientId: string, imageId: string) {
  return apiFetch<void>(`/dental/patients/${patientId}/images/${imageId}`, { method: "DELETE" });
}

// uploadDentalImage runs the full flow: (compressed) file → signed target → direct
// upload → record metadata (optionally filed under a treatment session). Quota is
// enforced at the sign step (throws AppError STORAGE_LIMIT_REACHED / IMAGE_LIMIT_REACHED).
export async function uploadDentalImage(patientId: string, file: File, sessionId?: string, category?: string): Promise<DentalImage> {
  const target = await apiFetch<UploadTarget>(`/dental/patients/${patientId}/images/sign`, {
    method: "POST",
    body: { filename: file.name, mime_type: file.type },
  });
  if ((target.method || "POST").toUpperCase() === "PUT") {
    const res = await fetch(target.url, { method: "PUT", body: file, headers: { "Content-Type": file.type } });
    if (!res.ok) throw new Error("Upload failed");
  } else {
    const fd = new FormData();
    Object.entries(target.fields ?? {}).forEach(([k, v]) => fd.append(k, v));
    fd.append("file", file);
    const res = await fetch(target.url, { method: "POST", body: fd });
    if (!res.ok) throw new Error("Upload failed");
  }
  return apiFetch<DentalImage>(`/dental/patients/${patientId}/images`, {
    method: "POST",
    body: { storage_key: target.key, filename: file.name, mime_type: file.type, size_bytes: file.size, session_id: sessionId, category },
  });
}

// --- examinations (clinical assessment; dentist only) ---
//
// The record that justifies the treatment: why the patient came, what was found on
// examining them, what was investigated, what was concluded. Dated per visit rather
// than per session — a full examination belongs to a first visit, a new complaint or
// a recall, not to every appointment in a running course of treatment.

export interface ExamProcedure {
  tooth?: string;
  procedure?: string;
  notes?: string;
}

export interface Exam {
  id: string;
  session_id?: string;
  visit_date: string; // YYYY-MM-DD
  chief_complaint?: string;
  hpi?: string;
  past_dental_history?: string;
  extraoral: string[];
  extraoral_notes?: string;
  intraoral: string[];
  intraoral_notes?: string;
  investigations: string[];
  investigation_results?: string;
  diagnosis?: string;
  treatment_plan?: string;
  treatment_given: string[];
  anaesthesia?: string;
  complications?: string;
  procedures: ExamProcedure[];
  postop?: string;
  recorded_by?: string;
  created_at: string;
  updated_at: string;
}

/** The whole form — an examination is saved as one document, not patched. */
export type ExamBody = Omit<Exam, "id" | "recorded_by" | "created_at" | "updated_at">;

export function listExams(patientId: string) {
  return apiFetch<{ items: Exam[] }>(`/dental/patients/${patientId}/exams`);
}
export function createExam(patientId: string, body: ExamBody) {
  return apiFetch<Exam>(`/dental/patients/${patientId}/exams`, { method: "POST", body });
}
export function updateExam(patientId: string, examId: string, body: ExamBody) {
  return apiFetch<Exam>(`/dental/patients/${patientId}/exams/${examId}`, { method: "PUT", body });
}
export function deleteExam(patientId: string, examId: string) {
  return apiFetch<void>(`/dental/patients/${patientId}/exams/${examId}`, { method: "DELETE" });
}

/** Append a visit to a running course — a root canal that needs a seventh. The plan's
 *  total, session count and deadline move with it. */
export function addSession(patientId: string, planId: string, body: { scheduled_date: string; amount_due: string }) {
  return apiFetch<Session>(`/dental/patients/${patientId}/plans/${planId}/sessions`, { method: "POST", body });
}
/** Close a course early. Cancels only visits never delivered and never billed. */
export function finishCourse(patientId: string, planId: string) {
  return apiFetch<{ sessions_cancelled: number }>(`/dental/patients/${patientId}/plans/${planId}/finish`, { method: "POST" });
}

/** Record treatment deliberately not charged for. Raises then waives a real charge,
 *  so the decision is auditable rather than being an absence of one. */
export function writeOffSession(patientId: string, sessionId: string, reason: string) {
  return apiFetch<void>(`/dental/patients/${patientId}/sessions/${sessionId}/write-off`, { method: "POST", body: { reason } });
}
/** Undo a mistaken write-off. The waived charge is kept as the record; the session is unlinked. */
export function undoWriteOff(patientId: string, sessionId: string) {
  return apiFetch<void>(`/dental/patients/${patientId}/sessions/${sessionId}/undo-write-off`, { method: "POST" });
}

// --- treatment given but never billed (clinic-wide) --------------------------
//
// The control that replaced the rule requiring payment before a visit could be
// recorded. Three lanes, three different actions — never one total.

export type UnbilledLane = "never_billed" | "bill_withdrawn" | "refunded";

export interface UnbilledRow {
  session_id: string;
  patient_id: string;
  mrn: string;
  patient_name: string;
  phone?: string;
  plan_title: string;
  procedure?: string;
  tooth?: string;
  seq: number;
  session_count: number;
  treatment_date: string;
  days_unbilled: number;
  amount: string;
  lane: UnbilledLane;
  pay_later: boolean;
  pay_later_note?: string;
  clinician?: string;
  branch?: string;
}

export interface UnbilledReport {
  rows: UnbilledRow[];
  /** Over the WHOLE result, not the page. */
  total: string;
  count: number;
  has_more: boolean;
  /** Promised but not yet delivered — shown apart; billing these would charge for a visit that has not happened. */
  promised_total: string;
  promised_count: number;
}

export function unbilledTreatment(params: { from?: string; to?: string; limit?: number; offset?: number } = {}) {
  const q = new URLSearchParams();
  if (params.from) q.set("from", params.from);
  if (params.to) q.set("to", params.to);
  if (params.limit) q.set("limit", String(params.limit));
  if (params.offset) q.set("offset", String(params.offset));
  const qs = q.toString();
  return apiFetch<UnbilledReport>(`/dental/unbilled${qs ? `?${qs}` : ""}`);
}
