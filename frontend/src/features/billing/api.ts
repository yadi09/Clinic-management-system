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

// ---- Billing-1: service catalog + charges + cashier + cash summary ----

export interface ServiceItem {
  id: string;
  code: string;
  name: string;
  category: string;
  price: string;
  currency: string;
  is_active: boolean;
  is_default: boolean;
  /** Who may put this on a patient: "reception" | "clinician" | "either". */
  assignable_by: string;
}
export interface PendingCharge {
  id: string;
  patient_id: string;
  source: string;
  description: string;
  amount: string;
  currency: string;
  created_at: string;
  patient_name: string;
  mrn: string;
  /** The receptionist ticked this bill: the patient agreed to pay it now. */
  desk_selected?: boolean;
  desk_selected_by?: string;
  /** Who the patient goes to once the ticked bills are paid. */
  goes_to?: string;
}
export interface ChargeRow {
  id: string;
  source: string;
  description: string;
  amount: string;
  currency: string;
  status: string;
  payment_method?: string;
  waive_reason?: string;
  settled_at?: string;
  created_at: string;
  receipt_no?: number;
  /** The cashier who actually settled it — not whoever is reprinting the receipt. */
  settled_by?: string;
}
export interface CashGroup {
  label: string;
  total: string;
  count: number;
  /** In the cash drawer. Only these lines make up a day close's expected total. */
  cash?: boolean;
}
export interface CashSummary {
  collected: string;
  collected_count: number;
  waived: string;
  waived_count: number;
  outstanding: string;
  outstanding_count: number;
  refunded: string;
  refunded_count: number;
  by_source: { source: string; total: string; count: number }[];
  by_method: CashGroup[];
  by_cashier: CashGroup[];
  by_branch: CashGroup[];
}
export interface Reconciliation {
  cashier?: string;
  business_date: string;
  expected_total: string;
  counted_total: string;
  variance: string;
  note?: string;
  closed_at: string;
}
export interface ExpectedDay {
  business_date: string;
  by_method: CashGroup[];
  /** The CASH that should be in the drawer: cash taken minus cash refunded. */
  expected_total: string;
  /** Telebirr, bank, card — taken today but never in the drawer. */
  non_cash_total?: string;
  closed: boolean;
  reconciliation?: Reconciliation;
}
// One business day on the close-out overview: takings + whether it's closed.
export interface DaySummary {
  business_date: string;
  expected_total: string;
  count: number;
  closed: boolean;
  counted_total?: string;
  variance?: string;
  note?: string;
  closed_at?: string;
}

export function listServices(activeOnly = false) {
  return apiFetch<ServiceItem[]>(`/billing/services${activeOnly ? "?active=1" : ""}`);
}
export interface ServiceBody {
  code: string; name: string; category?: string; price: number; assignable_by?: string;
}
export function createService(body: ServiceBody) {
  return apiFetch<ServiceItem>("/billing/services", { method: "POST", body });
}
export function updateService(id: string, body: ServiceBody) {
  return apiFetch<void>(`/billing/services/${id}`, { method: "PUT", body });
}
export function setServiceActive(id: string, is_active: boolean) {
  return apiFetch<void>(`/billing/services/${id}/active`, { method: "PUT", body: { is_active } });
}
export function setServiceDefault(id: string, is_default: boolean) {
  return apiFetch<void>(`/billing/services/${id}/default`, { method: "PUT", body: { is_default } });
}
export function deleteService(id: string) {
  return apiFetch<void>(`/billing/services/${id}`, { method: "DELETE" });
}

export interface Provider {
  id: string;
  full_name: string;
}
export async function getServiceProviders(id: string): Promise<string[]> {
  const r = await apiFetch<{ user_ids: string[] }>(`/billing/services/${id}/providers`);
  return r.user_ids ?? [];
}
export function setServiceProviders(id: string, user_ids: string[]) {
  return apiFetch<void>(`/billing/services/${id}/providers`, { method: "PUT", body: { user_ids } });
}
/** Staff who provide ANY of the given services — reception's filtered assign list. */
export function providersForServices(serviceIds: string[]) {
  return apiFetch<Provider[]>(`/billing/providers?services=${serviceIds.join(",")}`);
}

export function raiseCharge(body: {
  patient_id: string;
  encounter_id?: string;
  service_item_id?: string;
  source?: string;
  description: string;
  amount: number;
  branch_id?: string;
  department_id?: string;
  to_triage?: boolean;
  provider_id?: string;
}) {
  return apiFetch<{ id: string }>("/billing/charges", { method: "POST", body });
}
/** Register a whole visit's charges in one shot. Rejects (409) if the patient already
 *  has unpaid charges at the cashier or an active visit — the duplicate-registration guard. */
export function raiseChargeBatch(body: {
  patient_id: string;
  branch_id: string;
  department_id: string;
  to_triage?: boolean;
  provider_id?: string;
  items: { service_item_id?: string; source?: string; description: string; amount: number }[];
}) {
  return apiFetch<{ ids: string[] }>("/billing/charges/batch", { method: "POST", body });
}
export function pendingCharges() {
  return apiFetch<PendingCharge[]>("/billing/charges/pending");
}
/**
 * A patient's charges, plus totals over the WHOLE account.
 *
 * `rows` is a page (newest 50). The totals are not, and the printed statement uses
 * them — a signature-and-stamp document that silently totalled only the newest fifty
 * charges understated every long-standing patient.
 */
export interface PatientLedger {
  rows: ChargeRow[];
  charged: string;
  paid: string; // settled minus refunded
  refunded: string;
  awaiting: string;
  waived: string;
  total_count: number;
  truncated: boolean;
}
export function patientCharges(patientId: string) {
  return apiFetch<PatientLedger>(`/billing/charges?patient=${patientId}`);
}
/** How the desk says the money arrived. `method` stays for callers that have no rail. */
export interface SettlePayment {
  rail_id?: string;
  method: string;
  reference?: string;
  /** Take a payment the bank contradicted. Requires payment.waive; recorded. */
  force?: boolean;
  /** Settle only these charges. Omit to settle everything the patient owes. */
  charge_ids?: string[];
}

export function settleCharge(id: string, pay: SettlePayment) {
  return apiFetch<void>(`/billing/charges/${id}/settle`, { method: "POST", body: pay });
}
export function settleVisit(patientId: string, pay: SettlePayment) {
  return apiFetch<{ receipt_no: number; total: string; count: number }>("/billing/checkout", { method: "POST", body: { patient_id: patientId, ...pay } });
}
export interface PaidVisit {
  receipt_no: number;
  patient_name: string;
  mrn: string;
  total: string;
  currency: string;
  method?: string;
  /** What the desk chose ("Telebirr"); `method` is the stored key older rows have. */
  method_label?: string;
  /** The transaction reference recorded for a transfer or wallet payment. */
  reference?: string;
  settled_at?: string;
  refunded: boolean;
  /** The cashier who took it. Empty on charges settled before this was recorded. */
  settled_by?: string;
  lines: { description: string; amount: string }[];
}
export function paymentsToday(sinceISO?: string, untilISO?: string) {
  const p = new URLSearchParams();
  if (sinceISO) p.set("since", sinceISO);
  if (untilISO) p.set("until", untilISO);
  const qs = p.toString();
  return apiFetch<PaidVisit[]>(`/billing/payments${qs ? `?${qs}` : ""}`);
}
export function refundVisit(receiptNo: number, reason: string) {
  return apiFetch<void>("/billing/refund-visit", { method: "POST", body: { receipt_no: receiptNo, reason } });
}
export function waiveCharge(id: string, reason: string) {
  return apiFetch<void>(`/billing/charges/${id}/waive`, { method: "POST", body: { reason } });
}
export function voidCharge(id: string, reason: string) {
  return apiFetch<void>(`/billing/charges/${id}/void`, { method: "POST", body: { reason } });
}
export function refundCharge(id: string, reason: string) {
  return apiFetch<void>(`/billing/charges/${id}/refund`, { method: "POST", body: { reason } });
}
/** Treat now, bill later: the charges stay owed and stay at the cashier, but stop
 *  holding the patient at the door. Manager-gated, and the reason is kept. */
export function deferVisit(patientId: string, body: { reason: string; charge_ids?: string[] }) {
  return apiFetch<{ deferred: number }>(`/billing/patients/${patientId}/defer`, { method: "POST", body });
}
export function waiverReasons() {
  return apiFetch<string[]>("/billing/waiver-reasons");
}
export function cashSummary(sinceISO?: string, untilISO?: string) {
  const p = new URLSearchParams();
  if (sinceISO) p.set("since", sinceISO);
  if (untilISO) p.set("until", untilISO);
  const qs = p.toString();
  return apiFetch<CashSummary>(`/billing/cash${qs ? `?${qs}` : ""}`);
}
export function dayCloses(from?: string, to?: string) {
  const q = new URLSearchParams();
  if (from) q.set("from", from);
  if (to) q.set("to", to);
  const s = q.toString();
  return apiFetch<DaySummary[]>(`/billing/day-closes${s ? `?${s}` : ""}`);
}
export function dayClose(date?: string) {
  return apiFetch<ExpectedDay>(`/billing/day-close${date ? `?date=${date}` : ""}`);
}
export function closeDay(body: { business_date?: string; counted: number; note?: string }) {
  return apiFetch<Reconciliation>("/billing/day-close", { method: "POST", body });
}
export function reconciliations(all = false) {
  return apiFetch<Reconciliation[]>(`/billing/reconciliations${all ? "?all=1" : ""}`);
}

// ---- Finance: the owner's view of the money ----

export interface FinDayPoint { date: string; amount: string }
export interface FinLine { key: string; label: string; amount: string; count: number }
export interface FinAlert { kind: string; text: string; amount?: string; count: number; href: string }
export interface FinOverview {
  collected: string; collected_count: number; collected_prev: string;
  refunded: string; waived: string;
  outstanding: string; outstanding_patients: number; oldest_days: number;
  booked_ahead: string; booked_visits: number;
  series: FinDayPoint[]; series_prev: FinDayPoint[];
  by_source: FinLine[]; attention: FinAlert[];
}
export interface FinBucket { key: string; label: string; amount: string; count: number }
export interface FinReceivableRow {
  id: string; mrn: string; name: string; phone?: string;
  owed: string; oldest_days: number; bucket: string; last_paid?: string; why: string;
}
export interface FinReceivables { total: string; count: number; buckets: FinBucket[]; rows: FinReceivableRow[] }

/** from/to are inclusive YYYY-MM-DD days in clinic time; branch is a prefixed id. */
function finQuery(p: { from?: string; to?: string; branch?: string }) {
  const q = new URLSearchParams();
  if (p.from) q.set("from", p.from);
  if (p.to) q.set("to", p.to);
  if (p.branch) q.set("branch", p.branch);
  const s = q.toString();
  return s ? `?${s}` : "";
}
export function financeOverview(p: { from?: string; to?: string; branch?: string }) {
  return apiFetch<FinOverview>(`/finance/overview${finQuery(p)}`);
}
export function financeReceivables(p: { branch?: string }) {
  return apiFetch<FinReceivables>(`/finance/receivables${finQuery(p)}`);
}

export interface FinShift { date: string; cashier: string; expected: string; counted: string; variance: string; note?: string }
export interface FinCash {
  shifts: FinShift[]; by_method: FinLine[]; by_cashier: FinLine[]; by_branch: FinLine[];
  open_drawers: FinLine[]; variance: string;
}
export interface FinServiceLine {
  label: string; source: string; count: number; revenue: string; avg: string;
  /** Came from the clinic's priced list rather than free-typed text. */
  catalogued: boolean;
  /** What the list says it costs today. Absent for uncatalogued work. */
  list_price?: string;
}
export interface FinPlanAtRisk {
  id: string; patient: string; mrn: string; phone?: string;
  plan: string; at_risk: string; reason: string; days_idle: number;
}
export interface FinBook { total: string; visits: number; by_month: FinLine[]; at_risk: FinPlanAtRisk[] }

export function financeCash(p: { from?: string; to?: string; branch?: string }) {
  return apiFetch<FinCash>(`/finance/cash${finQuery(p)}`);
}
export function financeServices(p: { from?: string; to?: string; branch?: string }) {
  return apiFetch<FinServiceLine[]>(`/finance/services${finQuery(p)}`);
}
export function financeBook(p: { branch?: string }) {
  return apiFetch<FinBook>(`/finance/book${finQuery(p)}`);
}

// --- receipt verification ---

/** What the bank says about a claimed transfer. */
export interface PaymentCheck {
  /** verified | rejected | review | pending | unchecked */
  state: "verified" | "rejected" | "review" | "pending" | "unchecked";
  reason: string;
  amount?: string;
  sender?: string;
  account?: string;
  when?: string;
  already_used?: boolean;
}

export function verifyPayment(body: { rail_id: string; reference: string; expected?: string; patient_id?: string }) {
  return apiFetch<PaymentCheck>("/billing/verify-payment", { method: "POST", body });
}

/** Whether this deployment can check receipts at all. */
export function verificationAvailable() {
  return apiFetch<{ available: boolean }>("/billing/verify-payment/status");
}

// ---- registration fee rule (FEAT-REG-1) ----
//
// Each clinic says how often a patient pays its registration fee: every visit (the
// old behaviour), once in their life, or again after a number of days, weeks or
// months. The rule names which arrival fee is the registration fee; the others (a
// consultation) charge every visit.

export type RegistrationRule = "every_visit" | "once" | "every";
export type RegistrationUnit = "day" | "week" | "month";

export interface RegistrationPolicy {
  service_id: string | null;
  rule: RegistrationRule;
  every_count: number | null;
  every_unit: RegistrationUnit | "";
  paper_patients_registered: boolean;
}

export interface RegistrationStatus {
  service_id: string | null;
  rule: RegistrationRule;
  /** Does this arrival charge the registration fee? */
  due: boolean;
  reason: "no_policy" | "every_visit" | "never_registered" | "registered" | "paper" | "expired" | "owed";
  /** YYYY-MM-DD, the clinic's (Addis) day. */
  registered_on?: string;
  /** YYYY-MM-DD; only for "again after a period". */
  valid_until?: string;
}

export function getRegistrationPolicy() {
  return apiFetch<RegistrationPolicy>("/billing/registration-policy");
}

export function saveRegistrationPolicy(body: RegistrationPolicy) {
  return apiFetch<RegistrationPolicy>("/billing/registration-policy", { method: "PUT", body });
}

export function getRegistrationStatus(patientId: string) {
  return apiFetch<RegistrationStatus>(`/billing/registration-status?patient=${encodeURIComponent(patientId)}`);
}
