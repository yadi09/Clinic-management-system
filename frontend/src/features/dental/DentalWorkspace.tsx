import { useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "react-router-dom";
import { AlertTriangle, ArrowLeft, CalendarClock, Check, ChevronDown, ChevronLeft, ChevronRight, ExternalLink, HandCoins, ImagePlus, Lock, Pencil, Plus, Printer, Trash2, Undo2, X } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from "@/components/ui/command";
import { Textarea } from "@/components/ui/textarea";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Skeleton } from "@/components/ui/skeleton";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { toast } from "@/components/ui/sonner";
import { cn } from "@/lib/utils";
import { useAuth } from "@/app/auth-context";
import { AppError } from "@/lib/api-client";
import { compressImage } from "@/lib/image";
import { EthiopianDateInput } from "@/components/EthiopianDateInput";
import { ETH_MONTHS, ethiopianDaysInMonth, ethiopianToGregorianISO, formatEthiopian, toEthiopian } from "@/lib/ethiopian";
import { getPatient } from "@/features/patients/api";
import { PatientEditDialog } from "@/features/patients/components/PatientEditDialog";
import { StickyAlertBar, useScrolledPast, type ClinicalAlert } from "@/features/patients/components/StickyAlertBar";
import { historyAlerts } from "@/features/dental/medicalHistory";
import { PaymentHistoryCard } from "@/features/billing/PaymentHistoryCard";
import { MedicalHistoryCard, HistoryAlertChips } from "@/features/dental/MedicalHistoryCard";
import { ExaminationCard } from "@/features/dental/ExaminationCard";
import { getMedicalHistory } from "@/features/dental/api";
import { STATUS_LABEL, statusStyle, ToothChart, TOOTH_QUADRANTS } from "@/features/dental/ToothChart";
import {
  addPrescription, collectSession, collectSessions, createPlan, deleteDentalImage, deletePlan, deletePrescription, dentalSummary,
  listDentalImages, rescheduleSession, saveChart, setPayLater, uncollectSession, updateSession, uploadDentalImage,
  type DentalImage, type ImageCategory, type PaymentState, type Plan, type Prescription, type RxItem, type Session, type SessionStatus,
} from "@/features/dental/api";
import { searchDrugs, type Drug } from "@/features/clinical/api";
import { printPrescription } from "@/features/clinical/print";
import { getClinic, listBranches } from "@/features/admin/api";

const num = (s?: string) => Number(s || 0);
const birr = (s?: string) => `${num(s).toLocaleString(undefined, { maximumFractionDigits: 2 })} ETB`;
const MAX_SESSION_IMAGES = 12;

const PAY_META: Record<PaymentState, { label: string; variant: "outline" | "warning" | "success" }> = {
  unpaid: { label: "Unpaid", variant: "outline" },
  billed: { label: "At cashier", variant: "warning" },
  paid: { label: "Paid", variant: "success" },
};
const SESSION_STATUSES: SessionStatus[] = ["planned", "done", "cancelled"];
const SESSION_STATUS_LABEL: Record<SessionStatus, string> = { planned: "Planned", done: "Done", cancelled: "Cancelled" };

// Where a plan sits in its lifecycle, derived from its sessions:
//   not_started — created, nothing done or paid yet
//   in_progress — treatment underway (a session done or money moved), not finished
//   done        — every session done + paid, or the plan was completed/cancelled
type PlanPhase = "not_started" | "in_progress" | "done";
type PlanTab = "not_started" | "in_progress" | "history";
// Which sessions the Not-started / In-progress tabs show. "today" is the clinic-day
// view; "upcoming" is what the front desk needs to answer "when do I come back?"
// across every future date, not just the next one.
type DateScope = "today" | "upcoming" | "all";
function planPhase(plan: Plan): PlanPhase {
  if (plan.status === "cancelled") return "done";
  const active = plan.sessions.filter((s) => s.status !== "cancelled");
  const started = active.some((s) => s.status === "done" || s.payment !== "unpaid");
  const allDone = active.length > 0 && active.every((s) => s.status === "done" && s.payment === "paid");
  if (plan.status === "completed" || allDone) return "done";
  return started ? "in_progress" : "not_started";
}
const PHASE_META: Record<PlanPhase, { label: string; variant: "outline" | "warning" | "success" }> = {
  not_started: { label: "Not started", variant: "outline" },
  in_progress: { label: "In progress", variant: "warning" },
  done: { label: "Completed", variant: "success" },
};

const FREQS = [
  { key: "weekly", unit: "week", count: 1, label: "Weekly" },
  { key: "twice-weekly", unit: "day", count: 3, label: "Twice a week" },
  { key: "biweekly", unit: "week", count: 2, label: "Every 2 weeks" },
  { key: "monthly", unit: "month", count: 1, label: "Monthly" },
  { key: "bimonthly", unit: "month", count: 2, label: "Every 2 months" },
  { key: "custom", unit: "day", count: 0, label: "Every N days" },
];
// One-tap schedules — set the frequency and restart the plan from today.
const PRESETS = [
  { freq: "weekly", label: "Weekly" },
  { freq: "twice-weekly", label: "Twice a week" },
  { freq: "monthly", label: "Once a month" },
  { freq: "bimonthly", label: "Every 2 months" },
];

function age(dob: string) {
  const d = new Date(dob);
  if (isNaN(d.getTime())) return "";
  return `${Math.abs(new Date(Date.now() - d.getTime()).getUTCFullYear() - 1970)}y`;
}
function ageYears(dob: string): number | undefined {
  const d = new Date(dob);
  if (isNaN(d.getTime())) return undefined;
  const now = new Date();
  let a = now.getFullYear() - d.getFullYear();
  if (now.getMonth() < d.getMonth() || (now.getMonth() === d.getMonth() && now.getDate() < d.getDate())) a--;
  return a >= 0 && a < 200 ? a : undefined;
}
function isoLocal(d: Date) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
/** Does this session belong in the given date scope? scheduled_date is YYYY-MM-DD,
 *  so plain string comparison orders dates correctly. */
function inScope(s: Session, scope: DateScope, todayISO: string): boolean {
  if (s.status === "cancelled") return scope === "all";
  if (scope === "today") return s.scheduled_date === todayISO;
  // "Upcoming" means every future date, not merely the next one — a patient can
  // have several sessions spread over weeks and the desk needs to see all of them.
  if (scope === "upcoming") return s.scheduled_date > todayISO && s.status === "planned";
  return true;
}
/** "Today" / "Tomorrow" / the date, flagging anything already past as overdue. */
function dateLabel(date: string, todayISO: string): string {
  if (date === todayISO) return "Today";
  const t = new Date(`${todayISO}T00:00:00`);
  t.setDate(t.getDate() + 1);
  if (date === isoLocal(t)) return "Tomorrow";
  return date < todayISO ? `${date} · overdue` : date;
}
function addInterval(base: Date, unit: string, count: number): Date {
  const d = new Date(base);
  if (unit === "day") d.setDate(d.getDate() + count);
  else if (unit === "week") d.setDate(d.getDate() + 7 * count);
  else {
    const day = d.getDate();
    d.setDate(1);
    d.setMonth(d.getMonth() + count);
    const dim = new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate();
    d.setDate(Math.min(day, dim));
  }
  return d;
}
// Split a total into "payable" whole-birr amounts: each session rounds down to a
// comfortable unit (100 birr when the share is ≥100, else 10, else 1) and the last
// session carries the remainder — so patients pay round numbers, not 5833.33.
function splitRounded(total: number, n: number): number[] {
  if (n <= 0) return [];
  if (!(total > 0)) return Array(n).fill(0);
  const share = total / n;
  const unit = share >= 100 ? 100 : share >= 10 ? 10 : 1;
  const per = Math.floor(share / unit) * unit;
  const out: number[] = [];
  for (let i = 0; i < n - 1; i++) out.push(per);
  out.push(Math.round(total - per * (n - 1)));
  return out;
}

function genPreview(start: string, count: number, unit: string, ivl: number, total: number) {
  const rows: { date: string; amount: string }[] = [];
  const base = start ? new Date(`${start}T00:00:00`) : new Date();
  const amts = splitRounded(total, count);
  for (let i = 0; i < count; i++) {
    rows.push({ date: isoLocal(addInterval(base, unit, ivl * i)), amount: String(amts[i] ?? 0) });
  }
  return rows;
}

export function DentalWorkspace({ patientId }: { patientId: string }) {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const { can } = useAuth();
  // The dentist owns the clinical record; the front desk can still see it and take
  // payment for sessions, and correct the patient's personal details.
  const editable = can("dental.manage");
  const canCollect = editable || can("payment.charge");
  const canEditPatient = can("patient.update");
  // Moving a session is a scheduling act, not clinical work, so the front desk can
  // do it without gaining any write access to the record. Mirrors the backend route
  // (dental.manage OR appointment.manage) — see dental/http/routes.go.
  const canReschedule = editable || can("appointment.manage");
  const [editingPatient, setEditingPatient] = useState(false);
  const bannerRef = useRef<HTMLDivElement>(null);
  const scrolledPast = useScrolledPast(bannerRef);

  const patient = useQuery({ queryKey: ["patient", patientId], queryFn: () => getPatient(patientId) });
  const summary = useQuery({ queryKey: ["dental-summary", patientId], queryFn: () => dentalSummary(patientId) });
  // Safety flags belong next to the allergy chips, not buried in a card below.
  const history = useQuery({ queryKey: ["medical-history", patientId], queryFn: () => getMedicalHistory(patientId), enabled: editable });
  const invalidate = () => qc.invalidateQueries({ queryKey: ["dental-summary", patientId] });

  // Local, debounced-persisted odontogram (seeded once; local map is the edit source).
  const [teeth, setTeeth] = useState<Record<string, string>>({});
  const seeded = useRef(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (summary.data && !seeded.current) {
      setTeeth(summary.data.chart.teeth ?? {});
      seeded.current = true;
    }
  }, [summary.data]);
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);

  const chartSave = useMutation({
    mutationFn: (map: Record<string, string>) => saveChart(patientId, map),
    onError: (e) => toast.error(e instanceof AppError ? e.message : "Could not save the tooth chart"),
  });
  const toggleTooth = (code: string) => {
    setTeeth((prev) => {
      const cur = prev[code] ?? "";
      const cycle = ["", "healthy", "decayed", "filled", "extracted", "crown"];
      const next = cycle[(cycle.indexOf(cur) + 1) % cycle.length];
      const map = { ...prev };
      if (next) map[code] = next; else delete map[code];
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => chartSave.mutate(map), 700);
      return map;
    });
  };

  const [newPlan, setNewPlan] = useState(false);
  const [planTabRaw, setPlanTab] = useState<PlanTab | null>(null); // null = auto-pick a non-empty tab
  const [dateScope, setDateScope] = useState<DateScope>("today"); // Not-started/In-progress: which sessions to list

  if (patient.isLoading || summary.isLoading) {
    return (
      <div className="space-y-6">
        <Skeleton className="h-24 w-full rounded-lg" />
        <div className="grid gap-6 lg:grid-cols-3"><Skeleton className="h-64 lg:col-span-2" /><Skeleton className="h-64" /></div>
      </div>
    );
  }
  if (patient.isError || !patient.data || !summary.data) {
    return (
      <div className="space-y-4">
        <p className="text-sm text-destructive">Could not load this patient.</p>
        <Button variant="outline" onClick={() => navigate("/patients")}><ArrowLeft /> Back to patients</Button>
      </div>
    );
  }

  const p = patient.data;
  const fullName = [p.first_name, p.middle_name, p.last_name].filter(Boolean).join(" ");

  // What must stay in front of the dentist all the way down the page: recorded
  // allergies, plus whatever the medical history flags as affecting treatment.
  const clinicalAlerts: ClinicalAlert[] = [
    ...p.allergies.map((a) => ({ key: "alg" + a.id, level: "danger" as const, text: `Allergy: ${a.substance}` })),
    ...historyAlerts(history.data?.answers ?? {}),
  ];
  const bal = summary.data.balance;
  const plans = summary.data.plans;
  const owed = num(bal.owed);
  const pct = owed > 0 ? Math.min(100, Math.round((num(bal.paid) / owed) * 100)) : 0;

  // Phase-based navigation: a patient can carry many plans, so group them.
  const todayISO = isoLocal(new Date());
  const hasToday = (pl: Plan) => pl.sessions.some((s) => inScope(s, "today", todayISO));
  const hasUpcoming = (pl: Plan) => pl.sessions.some((s) => inScope(s, "upcoming", todayISO));
  // Not-started/In-progress honour the date scope; History is always the full list.
  const byScope = (list: Plan[]) =>
    dateScope === "today" ? list.filter(hasToday)
      : dateScope === "upcoming" ? list.filter(hasUpcoming)
        : list;
  const notStarted = byScope(plans.filter((pl) => planPhase(pl) === "not_started"));
  const inProgress = byScope(plans.filter((pl) => planPhase(pl) === "in_progress"));
  const completed = plans.filter((pl) => planPhase(pl) === "done");
  const scopeEmpty = dateScope === "today"
    ? "Nothing scheduled for today — switch to Upcoming or All dates to see the full list."
    : "Nothing scheduled after today — switch to All dates to see the full list.";
  const planTabs: { key: PlanTab; label: string; list: Plan[]; empty: string }[] = [
    { key: "not_started", label: "Not started", list: notStarted, empty: dateScope === "all" ? "No plans waiting to start." : scopeEmpty },
    { key: "in_progress", label: "In progress", list: inProgress, empty: dateScope === "all" ? "No treatments in progress right now." : scopeEmpty },
    { key: "history", label: "History", list: completed, empty: "No completed treatments yet." },
  ];
  // Default to the most useful non-empty tab, but honour an explicit click.
  const autoTab: PlanTab = inProgress.length ? "in_progress" : notStarted.length ? "not_started" : completed.length ? "history" : "in_progress";
  const planTab = planTabRaw ?? autoTab;
  const activeTab = planTabs.find((t) => t.key === planTab)!;
  // Completed plans are a record — always show every session regardless of the toggle.
  const sessionScope: DateScope = planTab === "history" ? "all" : dateScope;

  return (
    <div className="space-y-6">
      <StickyAlertBar alerts={clinicalAlerts} show={scrolledPast} patientName={fullName} />

      <button onClick={() => navigate("/patients")} className="flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground">
        <ArrowLeft className="h-4 w-4" /> Patients
      </button>

      {/* Patient banner: name, allergies (safety), and the unpaid flag when they owe. */}
      <div ref={bannerRef} className="flex flex-wrap items-center gap-4 rounded-lg bg-brand p-5 text-brand-foreground shadow-card">
        <Avatar className="h-12 w-12 bg-white/15">
          <AvatarFallback className="bg-transparent text-base text-brand-foreground">{(p.first_name[0] ?? "") + (p.last_name[0] ?? "")}</AvatarFallback>
        </Avatar>
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="text-h2 leading-tight">{fullName}</h2>
            {canEditPatient && (
              <button onClick={() => setEditingPatient(true)}
                className="flex items-center gap-1 rounded-full bg-white/15 px-2.5 py-1 text-xs font-medium hover:bg-white/25">
                <Pencil className="h-3 w-3" /> Edit details
              </button>
            )}
            <button onClick={() => navigate(`/patients/${patientId}/schedule`)}
                className="flex items-center gap-1 rounded-full bg-white/15 px-2.5 py-1 text-xs font-medium hover:bg-white/25">
                <CalendarClock className="h-3 w-3" /> Schedule
              </button>
          </div>
          <p className="text-sm text-brand-foreground/80 tabular-nums">
            MRN {p.mrn} · {age(p.dob)} · <span className="capitalize">{p.gender}</span>
            {p.phone ? ` · ${p.phone}` : ""}{p.blood_group ? ` · ${p.blood_group}` : ""}
          </p>
        </div>
        <div className="ml-auto flex flex-wrap items-center gap-2">
          <HistoryAlertChips answers={history.data?.answers ?? {}} />
          {bal.overdue && (
            <span className="flex items-center gap-1 rounded-full bg-destructive px-3 py-1 text-xs font-semibold text-destructive-foreground">
              <AlertTriangle className="h-3.5 w-3.5" /> Owes {birr(bal.due)}
            </span>
          )}
          {p.allergies.length === 0 ? (
            <span className="rounded-full bg-white/15 px-3 py-1 text-xs">No known allergies</span>
          ) : (
            p.allergies.map((a) => (
              <span key={a.id} className="flex items-center gap-1 rounded-full bg-destructive px-3 py-1 text-xs font-semibold text-destructive-foreground">
                <AlertTriangle className="h-3.5 w-3.5" /> Allergy: {a.substance}
              </span>
            ))
          )}
        </div>
      </div>

      {/* Odontogram + balance — side by side, equal height */}
      <div className="grid items-stretch gap-6 lg:grid-cols-3">
        {editable && (
          <Card className="lg:col-span-2">
            <CardHeader className="flex-row items-center justify-between space-y-0">
              <CardTitle>Tooth chart · Palmer</CardTitle>
              <span className="text-xs text-muted-foreground">Click a tooth to update</span>
            </CardHeader>
            <CardContent>
              <ToothChart teeth={teeth} editable={editable} onToggle={toggleTooth} />
            </CardContent>
          </Card>
        )}

        <Card className={cn("flex flex-col", editable ? "lg:col-span-1" : "lg:col-span-3")}>
          <CardHeader><CardTitle>Balance</CardTitle></CardHeader>
          <CardContent className="flex flex-1 flex-col justify-center space-y-4">
            <div className="text-center">
              <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Due now</p>
              <p className={`mt-1 text-3xl font-bold tabular-nums ${bal.overdue ? "text-rose-600" : "text-emerald-600"}`}>{birr(bal.due)}</p>
              <p className="mt-1 text-xs text-muted-foreground">Planned {birr(bal.owed)} · Paid {birr(bal.paid)} · Remaining {birr(bal.balance)}</p>
            </div>
            {owed > 0 && (
              <div className="flex items-center gap-2">
                <div className="h-2 flex-1 overflow-hidden rounded-full bg-muted">
                  <div className="h-full rounded-full bg-emerald-500 transition-all" style={{ width: `${pct}%` }} />
                </div>
                <span className="text-xs font-semibold text-emerald-600">{pct}%</span>
              </div>
            )}
            {bal.overdue ? (
              <div className="rounded-md bg-rose-50 px-3 py-2 text-center text-xs font-medium text-rose-700">
                Owes {birr(bal.due)} for treatment already given. Collect per session below.
              </div>
            ) : num(bal.balance) > 0.005 ? (
              <div className="text-center text-xs text-muted-foreground">Nothing due yet — {birr(bal.balance)} remaining across the plan.</div>
            ) : owed > 0 ? (
              <div className="text-center text-xs font-semibold text-emerald-600">✓ Fully paid</div>
            ) : null}
            <p className="text-center text-[11px] text-muted-foreground">Each session's payment is collected by the cashier.</p>
          </CardContent>
        </Card>
      </div>

      <MedicalHistoryCard patientId={patientId} gender={p.gender} editable={editable} />

      {/* The clinical assessment sits between the history and the plans, because
          that is the order the work happens in: history -> examination -> diagnosis
          -> the treatment plan the diagnosis justifies. Clinician only. */}
      {editable && <ExaminationCard patientId={patientId} editable={editable} />}

      {/* Treatment plans — full width */}
      <Card>
        <CardHeader className="flex-row items-center justify-between space-y-0">
          <CardTitle>Treatment plans</CardTitle>
          {editable && <Button size="sm" onClick={() => setNewPlan(true)}><Plus className="h-4 w-4" /> New plan</Button>}
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="flex flex-wrap gap-1 rounded-lg bg-muted p-1">
              {planTabs.map((t) => (
                <button key={t.key} type="button" onClick={() => setPlanTab(t.key)}
                  className={cn("flex items-center gap-1.5 rounded-md px-3 py-1.5 text-sm font-medium transition-colors",
                    planTab === t.key ? "bg-card text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground")}>
                  {t.label}
                  <span className={cn("rounded-full px-1.5 text-xs tabular-nums", planTab === t.key ? "bg-brand/10 text-brand" : "bg-foreground/10 text-muted-foreground")}>{t.list.length}</span>
                </button>
              ))}
            </div>
            {planTab !== "history" && (
              <div className="flex rounded-md border bg-card p-0.5 text-xs">
                {(["today", "upcoming", "all"] as const).map((s) => (
                  <button key={s} type="button" onClick={() => setDateScope(s)}
                    title={s === "upcoming" ? "Every session scheduled after today, grouped by date" : undefined}
                    className={cn("rounded px-2.5 py-1 font-medium", dateScope === s ? "bg-brand text-brand-foreground" : "text-muted-foreground hover:text-foreground")}>
                    {s === "today" ? "Today" : s === "upcoming" ? "Upcoming" : "All dates"}
                  </button>
                ))}
              </div>
            )}
          </div>
          {activeTab.list.length === 0 ? (
            <p className="py-8 text-center text-sm text-muted-foreground">{activeTab.empty}</p>
          ) : (
            activeTab.list.map((plan) => (
              <PlanCard key={plan.id} patientId={patientId} plan={plan} teeth={teeth} editable={editable} canCollect={canCollect} canReschedule={canReschedule} imageLimit={summary.data!.image_limit} scope={sessionScope} todayISO={todayISO} onChanged={invalidate} />
            ))
          )}
        </CardContent>
      </Card>

      {/* Payment history — what they've been billed and what they've paid. */}
      <PaymentHistoryCard patientId={patientId} />

      {/* Patient images — clinical records, so the dentist only. */}
      {editable && <PatientImagesCard patientId={patientId} plans={plans} editable={editable} imageLimit={summary.data.image_limit} />}

      {newPlan && <NewPlanDialog patientId={patientId} teeth={teeth} onClose={() => setNewPlan(false)} onSaved={() => { setNewPlan(false); invalidate(); }} />}
      {editingPatient && (
        <PatientEditDialog patient={p} onClose={() => setEditingPatient(false)}
          onSaved={() => qc.invalidateQueries({ queryKey: ["patient", patientId] })} />
      )}
    </div>
  );
}

// --- plan card ---

function PlanCard({ patientId, plan, teeth, editable, canCollect, canReschedule, imageLimit, scope, todayISO, onChanged }: { patientId: string; plan: Plan; teeth: Record<string, string>; editable: boolean; canCollect: boolean; canReschedule: boolean; imageLimit: number; scope: DateScope; todayISO: string; onChanged: () => void }) {
  const phase = planPhase(plan);
  const [open, setOpen] = useState(phase !== "done"); // finished plans start collapsed
  const total = num(plan.total_amount);
  const paid = plan.sessions.filter((s) => s.payment === "paid").reduce((a, s) => a + num(s.amount_due), 0);
  const pct = total > 0 ? Math.min(100, Math.round((paid / total) * 100)) : 0;
  const owes = plan.sessions.some((s) => s.status === "done" && s.payment !== "paid");

  // The header and the money strip always describe the WHOLE plan; only the session
  // list below follows the date scope.
  const money = useMemo(() => {
    const live = plan.sessions.filter((s) => s.status !== "cancelled");
    const sum = (pick: (s: Session) => boolean) => live.filter(pick).reduce((a, s) => a + num(s.amount_due), 0);
    return {
      collected: sum((s) => s.payment === "paid"),
      awaiting: sum((s) => s.payment === "billed"),
      outstanding: sum((s) => s.payment !== "paid"),
      // Money for treatment already given — the only figure that is genuinely owed now.
      overdue: sum((s) => s.status === "done" && s.payment !== "paid"),
      done: live.filter((s) => s.status === "done").length,
      count: live.length,
    };
  }, [plan.sessions]);

  const shownSessions = useMemo(
    () => plan.sessions.filter((s) => inScope(s, scope, todayISO))
      .sort((a, b) => a.scheduled_date.localeCompare(b.scheduled_date) || a.seq - b.seq),
    [plan.sessions, scope, todayISO],
  );
  // Group by date so several sessions on one day read as one visit, and a course
  // spread over weeks reads as a schedule rather than a flat list.
  const dateGroups = useMemo(() => {
    const byDate = new Map<string, Session[]>();
    for (const s of shownSessions) {
      const bucket = byDate.get(s.scheduled_date);
      if (bucket) bucket.push(s); else byDate.set(s.scheduled_date, [s]);
    }
    return Array.from(byDate, ([date, items]) => ({ date, items }));
  }, [shownSessions]);
  const showDateHeaders = dateGroups.length > 1; // a single date needs no header

  const del = useMutation({
    mutationFn: () => deletePlan(patientId, plan.id),
    onSuccess: () => { toast.success("Plan deleted"); onChanged(); },
    onError: (e) => toast.error(e instanceof AppError ? e.message : "Could not delete the plan"),
  });
  const [confirmDel, setConfirmDel] = useState(false);

  // The patient may want to settle the whole course at the desk in one go.
  const unbilled = plan.sessions.filter((s) => s.status !== "cancelled" && s.payment === "unpaid" && num(s.amount_due) > 0);
  const unbilledTotal = unbilled.reduce((a, s) => a + num(s.amount_due), 0);
  const collectAll = useMutation({
    mutationFn: () => collectSessions(patientId, unbilled.map((s) => s.id)),
    onSuccess: (r) => { toast.success(`${r.billed} session${r.billed === 1 ? "" : "s"} sent to the cashier · ${birr(r.total)}`); onChanged(); },
    onError: (e) => toast.error(e instanceof AppError ? e.message : "Could not collect"),
  });

  return (
    <div className="rounded-lg border">
      <button type="button" className="flex w-full items-center gap-3 p-3 text-left" onClick={() => setOpen((o) => !o)}>
        <ChevronDown className={cn("h-4 w-4 shrink-0 text-muted-foreground transition-transform", !open && "-rotate-90")} />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="font-semibold">{plan.title}</span>
            {/* Which teeth are being worked on is clinical detail — not for the desk. */}
            {editable && plan.tooth && <span className="text-xs text-muted-foreground">{plan.tooth}</span>}
            {plan.status === "cancelled"
              ? <Badge variant="outline">Cancelled</Badge>
              : <Badge variant={PHASE_META[phase].variant}>{PHASE_META[phase].label}</Badge>}
            {scope === "today" && <Badge variant="default">Today</Badge>}
            {scope === "upcoming" && <Badge variant="outline">Upcoming</Badge>}
            {owes && <Badge variant="destructive">Owes</Badge>}
          </div>
          <div className="mt-0.5 flex items-center gap-3 text-xs text-muted-foreground">
            <span className="tabular-nums">{birr(plan.total_amount)}</span>
            <span>· {scope === "all" ? `${plan.sessions.length} sessions` : `${shownSessions.length} of ${plan.sessions.length} sessions`}</span>
            {plan.deadline && <span className="flex items-center gap-1"><CalendarClock className="h-3 w-3" /> ends {plan.deadline}</span>}
          </div>
        </div>
        <div className="hidden w-40 items-center gap-2 sm:flex">
          <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-muted">
            <div className="h-full rounded-full bg-emerald-500" style={{ width: `${pct}%` }} />
          </div>
          <span className="text-xs font-semibold text-emerald-600">{pct}%</span>
        </div>
      </button>

      {open && (
        <div className="border-t">
          {/* Money at a glance: the desk must answer "what do I owe?" without opening
              every session. Whole-plan figures, independent of the date scope. */}
          <div className="grid grid-cols-2 gap-px bg-border sm:grid-cols-4">
            <PlanStat label="Plan total" value={birr(plan.total_amount)} />
            <PlanStat label="Collected" value={birr(String(money.collected))} tone={money.collected > 0.005 ? "ok" : undefined} />
            <PlanStat label="Outstanding" value={birr(String(money.outstanding))} tone={money.outstanding > 0.005 ? "warn" : undefined}
              hint={money.awaiting > 0.005 ? `${birr(String(money.awaiting))} with the cashier` : undefined} />
            {/* "Due now" not "Overdue": SessionRow already uses "overdue" for a session
                past its date. Same wording as the Balance card above, same meaning. */}
            <PlanStat label="Due now" value={birr(String(money.overdue))} tone={money.overdue > 0.005 ? "bad" : undefined}
              hint={money.overdue > 0.005 ? "treatment already given" : undefined} />
          </div>
          <div className="border-b bg-muted/30 px-3 py-1.5 text-xs text-muted-foreground">
            {money.done} of {money.count} sessions done
            {shownSessions.length !== plan.sessions.length && ` · showing ${shownSessions.length}`}
          </div>
          {shownSessions.length === 0 ? (
            <p className="px-3 py-6 text-center text-xs text-muted-foreground">
              {scope === "today" ? "No sessions for this plan today." : "No sessions scheduled after today."}
            </p>
          ) : (
            dateGroups.map(({ date, items }) => (
              <div key={date}>
                {showDateHeaders && (
                  <div className="flex items-center justify-between border-b bg-muted/50 px-3 py-1.5 text-xs font-medium">
                    <span className="flex items-center gap-1.5"><CalendarClock className="h-3 w-3" />{dateLabel(date, todayISO)}</span>
                    <span className="tabular-nums text-muted-foreground">{items.length} session{items.length === 1 ? "" : "s"}</span>
                  </div>
                )}
                <div className="divide-y">
                  {items.map((se) => (
                    <SessionRow key={se.id} patientId={patientId} session={se} teeth={teeth} editable={editable} canCollect={canCollect} canReschedule={canReschedule} imageLimit={imageLimit} onChanged={onChanged} />
                  ))}
                </div>
              </div>
            ))
          )}
          {(canCollect || editable) && (
            <div className="flex flex-wrap items-center justify-end gap-2 p-2">
              {canCollect && unbilled.length > 1 && (
                <Button size="sm" variant="outline" loading={collectAll.isPending} onClick={() => collectAll.mutate()}
                  title="Send every unpaid session of this plan to the cashier at once">
                  <HandCoins className="h-3.5 w-3.5" /> Collect all {unbilled.length} unpaid · {birr(String(unbilledTotal))}
                </Button>
              )}
              {editable && (
                <Button size="sm" variant="ghost" className="text-destructive" onClick={() => setConfirmDel(true)}>
                  <Trash2 className="h-3.5 w-3.5" /> Delete plan
                </Button>
              )}
            </div>
          )}
        </div>
      )}

      <Dialog open={confirmDel} onOpenChange={(o) => !o && setConfirmDel(false)}>
        <DialogContent>
          <DialogHeader><DialogTitle>Delete this treatment plan?</DialogTitle></DialogHeader>
          <p className="text-sm text-muted-foreground">Removes "{plan.title}" and all its sessions, notes and images. Collected payments stay recorded in Finance. This can't be undone.</p>
          <DialogFooter>
            <Button variant="outline" onClick={() => setConfirmDel(false)}>Cancel</Button>
            <Button variant="destructive" loading={del.isPending} onClick={() => del.mutate()}>Delete</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

/** One figure in the plan's money strip. Tone is presentational only — an amount of
 *  zero stays neutral so a fully-settled plan doesn't shout. */
function PlanStat({ label, value, tone, hint }: { label: string; value: string; tone?: "ok" | "warn" | "bad"; hint?: string }) {
  return (
    <div className="bg-card px-3 py-2">
      <p className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">{label}</p>
      <p className={cn("mt-0.5 text-sm font-semibold tabular-nums",
        tone === "ok" && "text-emerald-600", tone === "warn" && "text-amber-600", tone === "bad" && "text-rose-600")}>
        {value}
      </p>
      {hint && <p className="text-[10px] leading-tight text-muted-foreground">{hint}</p>}
    </div>
  );
}

// --- session row ---

function SessionRow({ patientId, session, teeth, editable, canCollect, canReschedule, imageLimit, onChanged }: { patientId: string; session: Session; teeth: Record<string, string>; editable: boolean; canCollect: boolean; canReschedule: boolean; imageLimit: number; onChanged: () => void }) {
  const [expanded, setExpanded] = useState(false);
  const [deferring, setDeferring] = useState(false);
  const [moving, setMoving] = useState(false);
  const [accessed, setAccessed] = useState(false); // doctor opened a future session on purpose
  const pay = PAY_META[session.payment];
  const today = isoLocal(new Date());
  // Payment must be handled first: either collected (billed/paid) or the doctor
  // flags pay-later. Until then, status changes and the visit record are locked.
  const unlocked = session.payment !== "unpaid" || !!session.pay_later;
  const owes = (session.status === "done" || !!session.pay_later) && session.payment !== "paid";
  const overdue = session.status === "planned" && !session.pay_later && session.scheduled_date < today;
  // A future, untouched session is gated behind an explicit "Access now" so the
  // doctor can't act on the wrong (not-yet-due) session by mistake.
  const untouched = session.status === "planned" && session.payment === "unpaid" && !session.pay_later;
  const future = session.scheduled_date > today;
  const gatedByDate = editable && future && untouched && !accessed;

  const setStatus = useMutation({
    mutationFn: (status: SessionStatus) => updateSession(patientId, session.id, { status }),
    onSuccess: onChanged,
    onError: (e) => toast.error(e instanceof AppError ? e.message : "Could not update"),
  });
  const collect = useMutation({
    mutationFn: () => collectSession(patientId, session.id),
    onSuccess: () => { toast.success("Sent to the cashier"); onChanged(); },
    onError: (e) => toast.error(e instanceof AppError ? e.message : "Could not collect"),
  });
  const uncollect = useMutation({
    mutationFn: () => uncollectSession(patientId, session.id),
    onSuccess: () => { toast.success("Reversed — the cashier can no longer collect it"); onChanged(); },
    onError: (e) => toast.error(e instanceof AppError ? e.message : "Could not reverse"),
  });
  const [moveTo, setMoveTo] = useState(session.scheduled_date);
  const reschedule = useMutation({
    mutationFn: () => rescheduleSession(patientId, session.id, moveTo),
    onSuccess: () => { toast.success(`Session ${session.seq} moved to ${moveTo}`); setMoving(false); onChanged(); },
    onError: (e) => toast.error(e instanceof AppError ? e.message : "Could not move the session"),
  });

  return (
    <div className={cn("p-3 transition-colors", session.status === "cancelled" && "opacity-60", expanded && "border-l-2 border-l-brand bg-muted/40")}>
      <div className="flex flex-wrap items-center gap-3">
        <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-muted text-xs font-semibold tabular-nums">{session.seq}</span>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2 text-sm">
            <span className="font-medium tabular-nums">{session.scheduled_date}</span>
            <span className="text-muted-foreground">·</span>
            <span className="tabular-nums font-semibold">{birr(session.amount_due)}</span>
            {editable && session.procedure && <><span className="text-muted-foreground">·</span><span className="truncate text-muted-foreground">{session.procedure}{session.tooth ? ` (${session.tooth})` : ""}</span></>}
          </div>
          <div className="mt-1 flex flex-wrap items-center gap-2">
            <Badge variant={pay.variant}>{pay.label}</Badge>
            {owes && <span className="flex items-center gap-1 text-xs font-medium text-rose-600"><AlertTriangle className="h-3 w-3" /> unpaid — service given</span>}
            {overdue && <span className="flex items-center gap-1 text-xs font-medium text-rose-600"><AlertTriangle className="h-3 w-3" /> overdue</span>}
            {editable && session.images.length > 0 && <span className="text-xs text-muted-foreground">{session.images.length} image{session.images.length > 1 ? "s" : ""}</span>}
          </div>
        </div>
        <div className="flex items-center gap-2">
          {/* Rescheduling is scheduling, not clinical work — the front desk gets this
              even without dental.manage. Only a session that hasn't happened yet can
              move; the backend enforces the same rule. */}
          {canReschedule && session.status === "planned" && (
            <Button size="sm" variant="ghost" title="Change this session's date"
              onClick={() => { setMoveTo(session.scheduled_date); setMoving(true); }}>
              <CalendarClock className="h-3.5 w-3.5" /> Move
            </Button>
          )}
          {/* Clinical controls belong to the dentist; billing is open to the front desk. */}
          {editable && gatedByDate ? (
            <Button size="sm" variant="outline" onClick={() => setAccessed(true)} title="This session isn't due yet — open it deliberately">
              <Lock className="h-3.5 w-3.5" /> Access now
            </Button>
          ) : (
            <>
              {editable && unlocked && (
                <Select value={session.status} onValueChange={(v) => setStatus.mutate(v as SessionStatus)}>
                  <SelectTrigger className="h-8 w-28"><SelectValue /></SelectTrigger>
                  <SelectContent>{SESSION_STATUSES.map((s) => <SelectItem key={s} value={s}>{SESSION_STATUS_LABEL[s]}</SelectItem>)}</SelectContent>
                </Select>
              )}
              {canCollect && session.payment === "billed" && (
                <Button size="sm" variant="ghost" loading={uncollect.isPending} onClick={() => uncollect.mutate()} title="Undo — pull this back from the cashier">
                  <Undo2 className="h-3.5 w-3.5" /> Undo
                </Button>
              )}
              {canCollect && session.payment === "unpaid" && num(session.amount_due) > 0 && (
                <Button size="sm" variant="outline" loading={collect.isPending} onClick={() => collect.mutate()}>
                  <HandCoins className="h-3.5 w-3.5" /> Collect
                </Button>
              )}
              {editable && !unlocked && (
                <Button size="sm" variant="outline" className="text-amber-700" onClick={() => setDeferring(true)}>Pay later</Button>
              )}
            </>
          )}
        </div>
        {editable && (
          <Button size="sm" variant="ghost" disabled={gatedByDate || !unlocked} onClick={() => setExpanded((e) => !e)}
            title={gatedByDate ? "Access this session first" : !unlocked ? "Collect payment or mark pay-later to record this visit" : undefined}>
            {expanded ? "Close" : "Record"}
            <ChevronDown className={cn("h-4 w-4 transition-transform", !expanded && "-rotate-90")} />
          </Button>
        )}
      </div>

      {deferring && <PayLaterDialog patientId={patientId} session={session} onClose={() => setDeferring(false)} onSaved={() => { setDeferring(false); onChanged(); }} />}

      <Dialog open={moving} onOpenChange={(o) => { if (!o) { setMoving(false); setMoveTo(session.scheduled_date); } }}>
        <DialogContent>
          <DialogHeader><DialogTitle>Move session {session.seq}</DialogTitle></DialogHeader>
          <p className="text-sm text-muted-foreground">
            Currently {session.scheduled_date}. This changes the date only — the procedure,
            notes, prescription and amount stay exactly as the dentist set them.
          </p>
          <div className="space-y-1.5">
            <Label>New date</Label>
            <EthiopianDateInput value={moveTo} onChange={setMoveTo} showAge={false} />
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setMoving(false)}>Cancel</Button>
            <Button loading={reschedule.isPending} disabled={!moveTo || moveTo === session.scheduled_date}
              onClick={() => reschedule.mutate()}>Move session</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {expanded && (
        <div className="mt-3 pl-9">
          <InlineSessionRecord patientId={patientId} session={session} teeth={teeth} editable={editable} imageLimit={imageLimit} onChanged={onChanged} />
        </div>
      )}
    </div>
  );
}

// Doctor's deliberate bypass: render the treatment now on a promise to pay later.
function PayLaterDialog({ patientId, session, onClose, onSaved }: { patientId: string; session: Session; onClose: () => void; onSaved: () => void }) {
  const [note, setNote] = useState(session.pay_later_note ?? "");
  const mut = useMutation({
    mutationFn: () => setPayLater(patientId, session.id, { on: true, note: note.trim() }),
    onSuccess: () => { toast.success("Recorded — treat now, pay later"); onSaved(); },
    onError: (e) => toast.error(e instanceof AppError ? e.message : "Could not save"),
  });
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader><DialogTitle>Treat now, pay later</DialogTitle></DialogHeader>
        <div className="space-y-3">
          <div className="flex items-start gap-2 rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-800">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
            <span>You're treating this session without collecting <b>{birr(session.amount_due)}</b> now, on the patient's promise to pay later. The patient will be flagged as <b>owing</b> until it's paid — here and on the patient list.</span>
          </div>
          <div className="space-y-1.5">
            <Label>Note / promise <span className="text-muted-foreground">(required)</span></Label>
            <Textarea rows={3} value={note} onChange={(e) => setNote(e.target.value)} placeholder="e.g. Patient will pay at the next visit / by end of month" />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>Cancel</Button>
          <Button disabled={!note.trim()} loading={mut.isPending} onClick={() => mut.mutate()}>Confirm pay later</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

const parseCsv = (s?: string) => (s ? s.split(",").map((t) => t.trim()).filter(Boolean) : []);

// The per-session clinical record, edited INLINE in the expanded row (no modal):
// procedure, tooth, notes, prescription, plus the visit date and fee. It warns when
// the session isn't dated today (upcoming or overdue) and offers to move it to today
// so the doctor can record the visit as it actually happens.
function InlineSessionRecord({ patientId, session, teeth, editable, imageLimit, onChanged }: { patientId: string; session: Session; teeth: Record<string, string>; editable: boolean; imageLimit: number; onChanged: () => void }) {
  const [date, setDate] = useState(session.scheduled_date);
  const [dateKey, setDateKey] = useState(0); // remounts the date picker when we move it to today
  const [amount, setAmount] = useState(session.amount_due);
  const [procedureSel, setProcedureSel] = useState<string[]>(parseCsv(session.procedure));
  const [toothSel, setToothSel] = useState<string[]>(parseCsv(session.tooth));
  const [notes, setNotes] = useState(session.notes ?? "");

  const [approved, setApproved] = useState(false); // doctor confirmed recording on a non-today date
  const today = isoLocal(new Date());
  const upcoming = date > today;
  const overdue = date < today && session.status === "planned";
  const notToday = upcoming || overdue;
  const gated = notToday && !approved; // lock the record until the doctor confirms the date
  const moveToday = () => { setDate(today); setDateKey((k) => k + 1); };

  const save = useMutation({
    mutationFn: () => updateSession(patientId, session.id, {
      scheduled_date: date, amount_due: amount, procedure: procedureSel.join(", "),
      tooth: FLAT_TEETH.filter((c) => toothSel.includes(c)).join(", "), notes,
    }),
    onSuccess: () => { toast.success("Session record saved"); onChanged(); },
    onError: (e) => toast.error(e instanceof AppError ? e.message : "Could not save"),
  });

  if (!editable) {
    return (
      <div className="space-y-3">
        {session.procedure || session.tooth || session.notes ? (
          <div className="space-y-1 text-sm">
            {session.procedure && <p><span className="text-muted-foreground">Procedure: </span>{session.procedure}</p>}
            {session.tooth && <p><span className="text-muted-foreground">Tooth: </span>{session.tooth}</p>}
            {session.notes && <p><span className="text-muted-foreground">Notes: </span>{session.notes}</p>}
          </div>
        ) : <p className="text-sm text-muted-foreground">No visit record.</p>}
        <PrescriptionSection patientId={patientId} session={session} editable={editable} onChanged={onChanged} />
        <SessionImages patientId={patientId} session={session} editable={editable} imageLimit={imageLimit} onChanged={onChanged} />
      </div>
    );
  }

  return (
    <div className="space-y-3">
      {session.pay_later && session.payment !== "paid" && (
        <div className="flex flex-wrap items-center gap-x-2 rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-800">
          <AlertTriangle className="h-4 w-4 shrink-0" />
          <span>Treat-now, pay-later — patient owes <b>{birr(session.amount_due)}</b>{session.pay_later_note ? `: ${session.pay_later_note}` : ""}.</span>
        </div>
      )}
      {notToday && (
        <div className={cn("flex flex-wrap items-center gap-x-2 gap-y-1 rounded-md border px-3 py-2 text-sm",
          overdue ? "border-rose-300 bg-rose-50 text-rose-800" : "border-amber-300 bg-amber-50 text-amber-800")}>
          <AlertTriangle className="h-4 w-4 shrink-0" />
          {gated ? (
            <>
              <span>
                {overdue ? `Overdue — this session was scheduled for ${date}, not today.` : `Upcoming — this session is scheduled for ${date}, not today.`}
                {" "}Recording is locked until you confirm the date.
              </span>
              <button type="button" onClick={moveToday} className="font-medium underline underline-offset-2">Move to today</button>
              <span className="text-muted-foreground">·</span>
              <button type="button" onClick={() => setApproved(true)} className="font-medium underline underline-offset-2">Record on {date} anyway</button>
            </>
          ) : (
            <>
              <span>Recording this visit on <b>{date}</b> (not today).</span>
              <button type="button" onClick={moveToday} className="font-medium underline underline-offset-2">Move to today</button>
            </>
          )}
        </div>
      )}
      <fieldset disabled={gated} className="space-y-3 disabled:opacity-50">
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="space-y-1.5"><Label>Visit date</Label><EthiopianDateInput key={dateKey} value={date} onChange={setDate} showAge={false} /></div>
          <div className="space-y-1.5"><Label>Amount (ETB)</Label><Input type="number" min={0} value={amount} onChange={(e) => setAmount(e.target.value)} /></div>
        </div>
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="space-y-1.5"><Label>Procedures</Label><ProcedureMultiSelect value={procedureSel} onChange={setProcedureSel} /></div>
          <div className="space-y-1.5"><Label>Tooth (Palmer)</Label><ToothMultiSelect teeth={teeth} value={toothSel} onChange={setToothSel} /></div>
        </div>
        <div className="space-y-1.5"><Label>Clinical notes</Label><Textarea rows={3} value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Findings, treatment done…" /></div>
        <div className="flex justify-end">
          <Button size="sm" loading={save.isPending} onClick={() => save.mutate()}>Save record</Button>
        </div>
      </fieldset>
      <div className="border-t pt-3"><PrescriptionSection patientId={patientId} session={session} editable={editable && !gated} onChanged={onChanged} /></div>
      <div className="border-t pt-3"><SessionImages patientId={patientId} session={session} editable={editable && !gated} imageLimit={imageLimit} onChanged={onChanged} /></div>
    </div>
  );
}

// --- per-session prescriptions (printable, multiple) ---

function PrescriptionSection({ patientId, session, editable, onChanged }: { patientId: string; session: Session; editable: boolean; onChanged: () => void }) {
  const { user, activeBranchId } = useAuth();
  const clinic = useQuery({ queryKey: ["clinic"], queryFn: getClinic, retry: false });
  const branches = useQuery({ queryKey: ["branches"], queryFn: listBranches });
  const patient = useQuery({ queryKey: ["patient", patientId], queryFn: () => getPatient(patientId) });
  const [adding, setAdding] = useState(false);

  const del = useMutation({
    mutationFn: (rxId: string) => deletePrescription(patientId, rxId),
    onSuccess: () => { toast.success("Prescription removed"); onChanged(); },
    onError: (e) => toast.error(e instanceof AppError ? e.message : "Could not remove"),
  });

  const print = (rx: Prescription) => {
    const clinicName = clinic.data?.name || "Clinic";
    const branch = (branches.data ?? []).find((b) => b.id === activeBranchId);
    const p = patient.data;
    const name = p ? [p.first_name, p.middle_name, p.last_name].filter(Boolean).join(" ") : "Patient";
    printPrescription({
      clinic: clinicName,
      clinicContact: branch ? [branch.address, branch.phone].filter(Boolean).join(" · ") || undefined : undefined,
      rxRef: `Rx ${rx.id.slice(-6)}`,
      qrData: `DRX:${rx.id}\n${clinicName}\n${name}${p ? " " + p.mrn : ""}\n${rx.created_at.slice(0, 10)}`,
      patient: name,
      mrn: p?.mrn,
      age: p ? ageYears(p.dob) : undefined,
      gender: p?.gender,
      prescriber: user?.full_name,
      when: rx.created_at,
      diagnoses: session.procedure ? [{ description: session.procedure + (session.tooth ? ` (${session.tooth})` : "") }] : [],
      meds: rx.items,
    });
  };

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <span className="text-sm font-medium">Prescriptions</span>
        {editable && <Button size="sm" variant="outline" onClick={() => setAdding(true)}><Plus className="h-3.5 w-3.5" /> Add prescription</Button>}
      </div>
      {session.prescriptions.length === 0 ? (
        <p className="text-xs text-muted-foreground">No prescriptions yet.</p>
      ) : (
        <div className="space-y-2">
          {session.prescriptions.map((rx) => (
            <div key={rx.id} className="rounded-md border p-2.5">
              <div className="flex items-start justify-between gap-2">
                <ol className="min-w-0 flex-1 space-y-1 text-sm">
                  {rx.items.map((it, i) => (
                    <li key={i} className="flex gap-2">
                      <span className="tabular-nums text-muted-foreground">{i + 1}.</span>
                      <span className="min-w-0">
                        <span className="font-medium">{it.drug_name}</span>
                        {(it.dose || it.frequency || it.duration) && <span className="text-muted-foreground"> — {[it.dose, it.frequency, it.duration].filter(Boolean).join(" · ")}</span>}
                        {it.instructions && <span className="block text-xs italic text-muted-foreground">{it.instructions}</span>}
                      </span>
                    </li>
                  ))}
                  {rx.note && <li className="pt-1 text-xs text-muted-foreground">Note: {rx.note}</li>}
                </ol>
                <div className="flex shrink-0 items-center gap-1">
                  <Button size="sm" variant="outline" onClick={() => print(rx)}><Printer className="h-3.5 w-3.5" /> Print</Button>
                  {editable && <Button size="sm" variant="ghost" className="text-destructive" title="Remove" onClick={() => del.mutate(rx.id)}><Trash2 className="h-3.5 w-3.5" /></Button>}
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
      {adding && <PrescriptionDialog patientId={patientId} sessionId={session.id} onClose={() => setAdding(false)} onSaved={() => { setAdding(false); onChanged(); }} />}
    </div>
  );
}

const BLANK_MED: RxItem = { drug_name: "", dose: "", frequency: "", duration: "", instructions: "" };

function PrescriptionDialog({ patientId, sessionId, onClose, onSaved }: { patientId: string; sessionId: string; onClose: () => void; onSaved: () => void }) {
  const [meds, setMeds] = useState<RxItem[]>([{ ...BLANK_MED }]);
  const [note, setNote] = useState("");
  const setMed = (i: number, patch: Partial<RxItem>) => setMeds((ms) => ms.map((m, j) => (j === i ? { ...m, ...patch } : m)));
  const valid = meds.some((m) => m.drug_name.trim());

  const mut = useMutation({
    mutationFn: () => addPrescription(patientId, sessionId, {
      note: note.trim() || undefined,
      items: meds.filter((m) => m.drug_name.trim()).map((m) => ({
        drug_name: m.drug_name.trim(), dose: m.dose, frequency: m.frequency, duration: m.duration, instructions: m.instructions,
      })),
    }),
    onSuccess: () => { toast.success("Prescription added"); onSaved(); },
    onError: (e) => toast.error(e instanceof AppError ? e.message : "Could not save the prescription"),
  });

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-2xl">
        <DialogHeader><DialogTitle>New prescription</DialogTitle></DialogHeader>
        <div className="max-h-[60vh] space-y-3 overflow-y-auto pr-1">
          {meds.map((m, i) => (
            <MedLine key={i} index={i} med={m} onChange={(patch) => setMed(i, patch)} onRemove={meds.length > 1 ? () => setMeds((ms) => ms.filter((_, j) => j !== i)) : undefined} />
          ))}
          <Button size="sm" variant="outline" onClick={() => setMeds((ms) => [...ms, { ...BLANK_MED }])}><Plus className="h-3.5 w-3.5" /> Add another medication</Button>
          <div className="space-y-1.5"><Label>Note (optional)</Label><Input value={note} onChange={(e) => setNote(e.target.value)} placeholder="e.g. Review in one week" /></div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>Cancel</Button>
          <Button disabled={!valid} loading={mut.isPending} onClick={() => mut.mutate()}>Save prescription</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// One medication line with a live drug-catalog autocomplete (reuses GET /drugs).
function MedLine({ index, med, onChange, onRemove }: { index: number; med: RxItem; onChange: (patch: Partial<RxItem>) => void; onRemove?: () => void }) {
  const [focus, setFocus] = useState(false);
  const search = useQuery({
    queryKey: ["drug-search", med.drug_name],
    queryFn: () => searchDrugs(med.drug_name),
    enabled: focus && (med.drug_name?.trim().length ?? 0) > 0,
  });
  const results = (search.data ?? []).slice(0, 6);
  const pick = (d: Drug) => {
    onChange({
      drug_name: d.name,
      dose: d.default_dose || med.dose,
      frequency: d.default_frequency || med.frequency,
      duration: d.default_duration || med.duration,
      instructions: d.default_instructions || med.instructions,
    });
    setFocus(false);
  };
  return (
    <div className="space-y-2 rounded-md border p-2.5">
      <div className="flex items-center gap-2">
        <span className="text-xs font-semibold text-muted-foreground">Medication {index + 1}</span>
        {onRemove && <button type="button" onClick={onRemove} className="ml-auto text-muted-foreground hover:text-destructive" title="Remove"><X className="h-3.5 w-3.5" /></button>}
      </div>
      <div className="relative">
        <Input value={med.drug_name} onChange={(e) => onChange({ drug_name: e.target.value })}
          onFocus={() => setFocus(true)} onBlur={() => setTimeout(() => setFocus(false), 150)} placeholder="Drug name" />
        {focus && results.length > 0 && (
          <div className="absolute z-20 mt-1 max-h-56 w-full overflow-auto rounded-md border bg-popover shadow-popover">
            {results.map((d) => (
              <button key={d.id} type="button" className="flex w-full items-center justify-between gap-2 px-3 py-1.5 text-left text-sm hover:bg-accent"
                onMouseDown={(e) => { e.preventDefault(); pick(d); }}>
                <span>{d.name}</span>
                {d.allergens?.length > 0 && <span className="flex items-center gap-1 text-xs text-amber-600"><AlertTriangle className="h-3 w-3" /> {d.allergens.join(", ")}</span>}
              </button>
            ))}
          </div>
        )}
      </div>
      <div className="grid gap-2 sm:grid-cols-3">
        <Input value={med.dose ?? ""} onChange={(e) => onChange({ dose: e.target.value })} placeholder="Dose (1 tab)" />
        <Input value={med.frequency ?? ""} onChange={(e) => onChange({ frequency: e.target.value })} placeholder="Frequency (twice daily)" />
        <Input value={med.duration ?? ""} onChange={(e) => onChange({ duration: e.target.value })} placeholder="Duration (5 days)" />
      </div>
      <Input value={med.instructions ?? ""} onChange={(e) => onChange({ instructions: e.target.value })} placeholder="Instructions (after food)" />
    </div>
  );
}

// --- per-session images (uses summary data; uploads/deletes refresh via onChanged) ---

const IMG_TABS: { key: "all" | ImageCategory; label: string }[] = [
  { key: "before", label: "Before" },
  { key: "after", label: "After" },
  { key: "xray", label: "X-ray" },
  { key: "all", label: "All" },
];

function SessionImages({ patientId, session, editable, imageLimit, onChanged }: { patientId: string; session: Session; editable: boolean; imageLimit: number; onChanged: () => void }) {
  const [busy, setBusy] = useState(false);
  const [tab, setTab] = useState<"all" | ImageCategory>("before");
  const all = session.images;
  const rows = tab === "all" ? all : all.filter((im) => im.category === tab);
  const tabLabel = IMG_TABS.find((t) => t.key === tab)!.label;
  const cap = imageLimit > 0 ? imageLimit : MAX_SESSION_IMAGES;
  const count = (k: "all" | ImageCategory) => (k === "all" ? all.length : all.filter((im) => im.category === k).length);
  const onPick = async (files: FileList | null) => {
    if (!files || files.length === 0 || tab === "all") return;
    setBusy(true);
    let ok = 0;
    for (const f of Array.from(files)) {
      try {
        const compressed = await compressImage(f, { maxEdge: 2000, quality: 0.8 });
        await uploadDentalImage(patientId, compressed, session.id, tab);
        ok++;
      } catch (e) {
        toast.error(e instanceof AppError ? e.message : `Could not upload ${f.name}`);
        break;
      }
    }
    setBusy(false);
    if (ok > 0) { toast.success(`${ok} ${tabLabel.toLowerCase()} image${ok > 1 ? "s" : ""} added`); onChanged(); }
  };
  const del = useMutation({
    mutationFn: (id: string) => deleteDentalImage(patientId, id),
    onSuccess: () => { toast.success("Image removed"); onChanged(); },
    onError: (e) => toast.error(e instanceof AppError ? e.message : "Could not remove the image"),
  });
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap gap-0.5 rounded-md bg-muted p-0.5 text-xs">
          {IMG_TABS.map((t) => (
            <button key={t.key} type="button" onClick={() => setTab(t.key)}
              className={cn("flex items-center gap-1 rounded px-2 py-1 font-medium", tab === t.key ? "bg-card text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground")}>
              {t.label}<span className="tabular-nums opacity-70">{count(t.key)}</span>
            </button>
          ))}
        </div>
        {editable && tab !== "all" && (
          <label className={cn("inline-flex items-center gap-1.5 rounded-md border px-2 py-1 text-xs font-medium", busy || all.length >= cap ? "cursor-not-allowed opacity-50" : "cursor-pointer hover:bg-accent")}>
            <ImagePlus className="h-3.5 w-3.5" /> {busy ? "Uploading…" : `Add ${tabLabel.toLowerCase()}`}
            <input type="file" accept="image/*" multiple className="hidden" disabled={busy || all.length >= cap} onChange={(e) => { void onPick(e.target.files); e.currentTarget.value = ""; }} />
          </label>
        )}
      </div>
      {rows.length === 0 ? (
        <p className="text-xs text-muted-foreground">{tab === "all" ? "No images for this session yet." : `No ${tabLabel.toLowerCase()} images yet.`}</p>
      ) : (
        <ImageGallery images={rows} editable={editable} onDelete={(id) => del.mutate(id)} thumb />
      )}
    </div>
  );
}

// --- patient images: every image grouped by treatment (+ a general bucket) ---

function PatientImagesCard({ patientId, plans, editable, imageLimit }: { patientId: string; plans: Plan[]; editable: boolean; imageLimit: number }) {
  const qc = useQueryClient();
  const generalQ = useQuery({ queryKey: ["dental-images", patientId], queryFn: () => listDentalImages(patientId) });
  const [busy, setBusy] = useState(false);
  const [filter, setFilter] = useState<string>("all"); // all | general | <plan id>

  const general = generalQ.data ?? [];
  // One group per treatment (its sessions' images pooled) plus the general bucket.
  const groups = [
    { key: "general", title: "General (no treatment)", images: general },
    ...plans.map((pl) => ({ key: pl.id, title: pl.title, images: pl.sessions.flatMap((s) => s.images) })),
  ];
  const total = groups.reduce((a, g) => a + g.images.length, 0);
  const unlimited = imageLimit <= 0;
  const cap = unlimited ? Infinity : imageLimit;
  const atCap = total >= cap;
  const visible = filter === "all" ? groups.filter((g) => g.images.length > 0) : groups.filter((g) => g.key === filter);

  const refresh = () => {
    qc.invalidateQueries({ queryKey: ["dental-images", patientId] });
    qc.invalidateQueries({ queryKey: ["dental-summary", patientId] });
  };
  const onPick = async (files: FileList | null) => {
    if (!files || files.length === 0) return;
    if (atCap) { toast.error(`This plan allows up to ${imageLimit} images per patient.`); return; }
    setBusy(true);
    let ok = 0;
    for (const f of Array.from(files).slice(0, cap - total)) {
      try {
        const compressed = await compressImage(f, { maxEdge: 2000, quality: 0.8 });
        await uploadDentalImage(patientId, compressed); // session-less = general
        ok++;
      } catch (e) {
        toast.error(e instanceof AppError ? e.message : `Could not upload ${f.name}`);
        break;
      }
    }
    setBusy(false);
    if (ok > 0) { toast.success(`${ok} general image${ok > 1 ? "s" : ""} added`); refresh(); }
  };
  const del = useMutation({
    mutationFn: (id: string) => deleteDentalImage(patientId, id),
    onSuccess: () => { toast.success("Image removed"); refresh(); },
    onError: (e) => toast.error(e instanceof AppError ? e.message : "Could not remove the image"),
  });

  return (
    <Card>
      <CardHeader className="flex-row flex-wrap items-center justify-between gap-2 space-y-0">
        <CardTitle>Patient images <span className="text-sm font-normal text-muted-foreground">({total}{unlimited ? "" : `/${imageLimit}`})</span></CardTitle>
        <div className="flex items-center gap-2">
          <Select value={filter} onValueChange={setFilter}>
            <SelectTrigger className="h-9 w-52"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All treatments</SelectItem>
              <SelectItem value="general">General (no treatment)</SelectItem>
              {plans.map((pl) => <SelectItem key={pl.id} value={pl.id}>{pl.title}</SelectItem>)}
            </SelectContent>
          </Select>
          {editable && (
            <label className={cn("inline-flex shrink-0 items-center gap-1.5 rounded-md border px-3 py-1.5 text-sm font-medium", busy || atCap ? "cursor-not-allowed opacity-50" : "cursor-pointer hover:bg-accent")}>
              <ImagePlus className="h-4 w-4" /> {busy ? "Uploading…" : "Add general image"}
              <input type="file" accept="image/*" multiple className="hidden" disabled={busy || atCap} onChange={(e) => { void onPick(e.target.files); e.currentTarget.value = ""; }} />
            </label>
          )}
        </div>
      </CardHeader>
      <CardContent className="space-y-5">
        {total === 0 && filter === "all" ? (
          <p className="text-sm text-muted-foreground">No images yet. Add a general X-ray or consult photo here; per-session images are filed under each session and appear grouped by treatment.</p>
        ) : visible.length === 0 ? (
          <p className="text-sm text-muted-foreground">No images in this selection.</p>
        ) : (
          visible.map((g) => (
            <div key={g.key} className="space-y-2">
              <div className="flex items-center gap-2">
                <span className="text-sm font-medium">{g.title}</span>
                <span className="rounded-full bg-muted px-1.5 text-xs tabular-nums text-muted-foreground">{g.images.length}</span>
              </div>
              {g.images.length === 0 ? (
                <p className="text-xs text-muted-foreground">No images.</p>
              ) : (
                <ImageGallery images={g.images} editable={editable} onDelete={(id) => del.mutate(id)} />
              )}
            </div>
          ))
        )}
      </CardContent>
    </Card>
  );
}

// --- reusable image gallery: grid + lightbox + delete-confirm ---

function ImageGallery({ images, editable, onDelete, thumb }: { images: DentalImage[]; editable: boolean; onDelete: (id: string) => void; thumb?: boolean }) {
  const [idx, setIdx] = useState<number | null>(null);
  const [confirmDel, setConfirmDel] = useState<DentalImage | null>(null);
  const preview = idx !== null && idx < images.length ? images[idx] : null;
  const step = (d: number) => setIdx((i) => (i === null ? i : (i + d + images.length) % images.length));
  return (
    <>
      <div className={cn("grid gap-2", thumb ? "grid-cols-4 sm:grid-cols-6" : "grid-cols-3 sm:grid-cols-4")}>
        {images.map((im, i) => (
          <div key={im.id} className="group relative aspect-square overflow-hidden rounded-md border bg-muted">
            <button type="button" className="block h-full w-full" title="Preview" onClick={() => setIdx(i)}>
              <img src={im.url} alt={im.filename} loading="lazy" className="h-full w-full object-cover transition-transform group-hover:scale-105" />
            </button>
            {editable && (
              <button className="absolute right-1 top-1 rounded-full bg-black/55 p-1 text-white opacity-0 transition-opacity hover:bg-destructive group-hover:opacity-100" title="Remove" onClick={() => setConfirmDel(im)}>
                <Trash2 className="h-3 w-3" />
              </button>
            )}
          </div>
        ))}
      </div>

      <Dialog open={preview !== null} onOpenChange={(o) => !o && setIdx(null)}>
        <DialogContent className="max-w-3xl" onKeyDown={(e) => { if (e.key === "ArrowLeft") step(-1); if (e.key === "ArrowRight") step(1); }}>
          <DialogHeader><DialogTitle className="truncate pr-8 text-base">{preview?.filename ?? "Image"}</DialogTitle></DialogHeader>
          <div className="relative flex items-center justify-center">
            {images.length > 1 && <button type="button" onClick={() => step(-1)} aria-label="Previous" className="absolute left-1 z-10 rounded-full bg-black/45 p-1.5 text-white hover:bg-black/70"><ChevronLeft className="h-5 w-5" /></button>}
            {preview && <img src={preview.url} alt={preview.filename} className="max-h-[70vh] w-auto rounded-md object-contain" />}
            {images.length > 1 && <button type="button" onClick={() => step(1)} aria-label="Next" className="absolute right-1 z-10 rounded-full bg-black/45 p-1.5 text-white hover:bg-black/70"><ChevronRight className="h-5 w-5" /></button>}
          </div>
          <DialogFooter className="flex-row items-center justify-between sm:justify-between">
            <a href={preview?.url} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground"><ExternalLink className="h-4 w-4" /> Open original</a>
            {editable && preview && <Button variant="ghost" className="text-destructive" onClick={() => setConfirmDel(preview)}><Trash2 className="h-4 w-4" /> Delete</Button>}
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={confirmDel !== null} onOpenChange={(o) => !o && setConfirmDel(null)}>
        <DialogContent>
          <DialogHeader><DialogTitle>Delete this image?</DialogTitle></DialogHeader>
          <p className="text-sm text-muted-foreground">This permanently removes the image and frees its storage. This can't be undone.</p>
          {confirmDel && <div className="overflow-hidden rounded-md border bg-muted"><img src={confirmDel.url} alt={confirmDel.filename} className="mx-auto max-h-48 object-contain" /></div>}
          <DialogFooter>
            <Button variant="outline" onClick={() => setConfirmDel(null)}>Cancel</Button>
            <Button variant="destructive" onClick={() => { if (confirmDel) { onDelete(confirmDel.id); setConfirmDel(null); setIdx(null); } }}>Delete</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

// --- new plan dialog with live schedule preview ---

// Every tooth in chart order — used to keep a multi-tooth selection sorted.
const FLAT_TEETH = TOOTH_QUADRANTS.flatMap((q) => q.codes);

const DENTAL_PROCEDURES = [
  "Consultation", "X-Ray", "Teeth Cleaning", "Scaling & Polishing", "Tooth Extraction",
  "Filling (Composite)", "Filling (Amalgam)", "Root Canal Treatment", "Crown Placement",
  "Bridge", "Partial Denture", "Full Denture", "Teeth Whitening", "Orthodontic Consultation",
  "Braces Fitting", "Emergency Treatment", "Other",
];

// Multi-select procedure picker — type to filter, tick several, or add a custom
// one. The popover stays open while you toggle; selections show comma-joined.
function ProcedureMultiSelect({ value, onChange }: { value: string[]; onChange: (v: string[]) => void }) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const q = query.trim();
  const toggle = (p: string) => onChange(value.includes(p) ? value.filter((x) => x !== p) : [...value, p]);
  // Built-in list plus any custom values already selected, so ticks always show.
  const options = [...DENTAL_PROCEDURES, ...value.filter((v) => !DENTAL_PROCEDURES.includes(v))];
  const exact = options.some((p) => p.toLowerCase() === q.toLowerCase());
  return (
    <Popover open={open} onOpenChange={(o) => { setOpen(o); if (!o) setQuery(""); }}>
      <PopoverTrigger asChild>
        <Button variant="outline" role="combobox" className="w-full justify-between font-normal">
          <span className={cn("truncate", value.length === 0 && "text-muted-foreground")}>
            {value.length === 0 ? "Select procedures" : `${value.length} selected · ${value.join(", ")}`}
          </span>
          <ChevronDown className="h-4 w-4 shrink-0 opacity-60" />
        </Button>
      </PopoverTrigger>
      <PopoverContent align="start" className="p-0" style={{ width: "var(--radix-popover-trigger-width)" }}>
        <Command>
          <CommandInput placeholder="Search procedures…" value={query} onValueChange={setQuery} />
          <CommandList>
            <CommandEmpty>No procedure found.</CommandEmpty>
            <CommandGroup>
              {options.map((p) => (
                <CommandItem key={p} value={p} onSelect={() => toggle(p)}>
                  <Check className={cn("mr-2 h-4 w-4", value.includes(p) ? "opacity-100" : "opacity-0")} />
                  {p}
                </CommandItem>
              ))}
              {q && !exact && (
                <CommandItem value={q} onSelect={() => { toggle(q); setQuery(""); }}>
                  <Plus className="mr-2 h-4 w-4" /> Add "{q}"
                </CommandItem>
              )}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}

// Multi-tooth picker (Palmer), grouped by quadrant, showing each tooth's charted
// condition. Value is the selected codes; stored joined as "UR6, UR7".
function ToothMultiSelect({ teeth, value, onChange, placeholder }: { teeth: Record<string, string>; value: string[]; onChange: (codes: string[]) => void; placeholder?: string }) {
  const ordered = FLAT_TEETH.filter((c) => value.includes(c));
  const toggle = (c: string) => onChange(value.includes(c) ? value.filter((x) => x !== c) : [...value, c]);
  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button variant="outline" role="combobox" className="w-full justify-between font-normal">
          <span className={cn("truncate", value.length === 0 && "text-muted-foreground")}>
            {value.length === 0 ? (placeholder ?? "No specific tooth") : `${value.length} selected · ${ordered.join(", ")}`}
          </span>
          <ChevronDown className="h-4 w-4 shrink-0 opacity-60" />
        </Button>
      </PopoverTrigger>
      <PopoverContent align="start" className="max-h-72 overflow-auto p-1" style={{ width: "var(--radix-popover-trigger-width)" }}>
        {TOOTH_QUADRANTS.map((quad) => (
          <div key={quad.label} className="py-0.5">
            <div className="px-2 py-1 text-xs font-semibold text-muted-foreground">{quad.label}</div>
            {quad.codes.map((code) => {
              const cond = teeth[code] ?? "";
              const st = statusStyle(cond);
              const checked = value.includes(code);
              return (
                <button key={code} type="button" onClick={() => toggle(code)}
                  className="flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left text-sm hover:bg-accent">
                  <span className={cn("flex h-4 w-4 shrink-0 items-center justify-center rounded border", checked ? "border-brand bg-brand text-brand-foreground" : "border-input")}>
                    {checked && <Check className="h-3 w-3" />}
                  </span>
                  <span className="h-2.5 w-2.5 shrink-0 rounded-sm border" style={{ background: st.background, borderColor: st.borderColor }} />
                  <span className="font-medium tabular-nums">{code}</span>
                  {cond && <span className="text-xs text-muted-foreground">· {STATUS_LABEL[cond] ?? cond}</span>}
                </button>
              );
            })}
          </div>
        ))}
      </PopoverContent>
    </Popover>
  );
}

const ecParts = (v: string) => {
  if (!v) return { y: "", m: "", d: "" };
  const e = toEthiopian(v);
  return { y: String(e.year), m: String(e.month), d: String(e.day) };
};

// Compact Ethiopian date entry for a schedule row: month + day + year, converting
// to/from the stored Gregorian ISO. Local parts are the edit source (so clearing a
// field mid-type doesn't snap back); remount (via key) re-seeds when the parent
// regenerates the schedule. Mirrors EthiopianDateInput's Ethiopian mode, sized for a row.
function EthiopianRowInput({ value, onChange }: { value: string; onChange: (iso: string) => void }) {
  const [parts, setParts] = useState(() => ecParts(value));
  const commit = (next: { y: string; m: string; d: string }) => {
    setParts(next);
    const yi = Number(next.y), mi = Number(next.m), di = Number(next.d);
    const valid = next.y !== "" && next.m !== "" && next.d !== "" && yi >= 1 && mi >= 1 && mi <= 13 && di >= 1 && di <= ethiopianDaysInMonth(yi, mi);
    if (valid) onChange(ethiopianToGregorianISO(yi, mi, di));
  };
  const onlyDigits = (v: string) => v.replace(/\D/g, "");
  return (
    <div className="flex items-center gap-1.5">
      <Select value={parts.m} onValueChange={(nm) => commit({ ...parts, m: nm })}>
        <SelectTrigger className="h-8 w-32"><SelectValue placeholder="Month" /></SelectTrigger>
        <SelectContent>{ETH_MONTHS.map((name, i) => <SelectItem key={name} value={String(i + 1)}>{name}</SelectItem>)}</SelectContent>
      </Select>
      <Input inputMode="numeric" maxLength={2} value={parts.d} onChange={(e) => commit({ ...parts, d: onlyDigits(e.target.value) })} className="h-8 w-12 px-2 text-center" placeholder="DD" aria-label="Day" />
      <Input inputMode="numeric" maxLength={4} value={parts.y} onChange={(e) => commit({ ...parts, y: onlyDigits(e.target.value) })} className="h-8 w-16 px-2 text-center" placeholder="YYYY" aria-label="Year" />
    </div>
  );
}

function NewPlanDialog({ patientId, teeth, onClose, onSaved }: { patientId: string; teeth: Record<string, string>; onClose: () => void; onSaved: () => void }) {
  const [title, setTitle] = useState("");
  const [sel, setSel] = useState<string[]>([]); // selected tooth codes
  const toothStr = FLAT_TEETH.filter((c) => sel.includes(c)).join(", ");
  const [total, setTotal] = useState("");
  const [start, setStart] = useState(() => isoLocal(new Date()));
  const [freqKey, setFreqKey] = useState("monthly");
  const [customDays, setCustomDays] = useState("30");
  const [count, setCount] = useState("6");
  const [note, setNote] = useState("");
  const [rows, setRows] = useState<{ date: string; amount: string }[]>([]);
  const [scheduleMode, setScheduleMode] = useState<"ethiopian" | "gregorian">("ethiopian");
  const [scheduleGen, setScheduleGen] = useState(0); // bumps on regeneration → remounts EC row inputs

  const freq = FREQS.find((f) => f.key === freqKey) ?? FREQS.find((f) => f.key === "monthly")!;
  const unit = freq.key === "custom" ? "day" : freq.unit;
  const ivl = freq.key === "custom" ? Math.max(1, Number(customDays) || 1) : freq.count;
  const n = Math.max(1, Math.min(60, Number(count) || 1));

  // Regenerate the preview whenever the schedule inputs change.
  useEffect(() => {
    setRows(genPreview(start, n, unit, ivl, num(total)));
    setScheduleGen((g) => g + 1);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [start, n, unit, ivl, total]);

  const rowsTotal = rows.reduce((a, r) => a + num(r.amount), 0);
  const fmtDate = (iso: string) => (iso && scheduleMode === "ethiopian" ? `${formatEthiopian(iso)} EC` : iso);

  // Reconcile the per-session amounts against the entered total cost. When no total
  // is entered the sessions define it (no warning); otherwise they must match.
  const target = num(total);
  const diff = rowsTotal - target; // + = sessions exceed total, − = fall short
  const mismatch = target > 0 && Math.abs(diff) > 0.5;
  const othersSum = rows.slice(0, -1).reduce((a, r) => a + num(r.amount), 0);
  const canBalance = rows.length > 0 && target - othersSum >= 0;
  const balanceLast = () => setRows((rs) => rs.map((r, i) => (i === rs.length - 1 ? { ...r, amount: String(Math.round(target - othersSum)) } : r)));
  const editRow = (i: number, patch: Partial<{ date: string; amount: string }>) => setRows((rs) => rs.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  // A preset restarts the plan from today at the chosen cadence — the fastest path.
  // startKey bumps so the Start-date picker remounts and reflects the new date.
  const [startKey, setStartKey] = useState(0);
  const applyPreset = (freqVal: string) => { setStart(isoLocal(new Date())); setFreqKey(freqVal); setStartKey((k) => k + 1); };

  const mut = useMutation({
    mutationFn: () => createPlan(patientId, {
      title: title.trim(), tooth: toothStr, total_amount: total || "0", start_date: start,
      interval_unit: unit, interval_count: ivl, session_count: rows.length, note: note.trim(),
      sessions: rows.map((r) => ({ scheduled_date: r.date, amount_due: r.amount || "0" })),
    }),
    onSuccess: () => { toast.success("Treatment plan created"); onSaved(); },
    onError: (e) => toast.error(e instanceof AppError ? e.message : "Could not create the plan"),
  });

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-2xl">
        <DialogHeader><DialogTitle>New treatment plan</DialogTitle></DialogHeader>
        <div className="space-y-3">
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-1.5"><Label>Treatment</Label><Input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="e.g. Root canal" /></div>
            <div className="space-y-1.5">
              <Label>Teeth (optional)</Label>
              <ToothMultiSelect teeth={teeth} value={sel} onChange={setSel} />
            </div>
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-1.5"><Label>Total cost (ETB)</Label><Input type="number" min={0} value={total} onChange={(e) => setTotal(e.target.value)} placeholder="0" /></div>
            <div className="space-y-1.5"><Label>Start date</Label><EthiopianDateInput key={startKey} value={start} onChange={setStart} showAge={false} /></div>
          </div>
          <div className="space-y-1.5">
            <Label>Quick schedule</Label>
            <div className="flex flex-wrap gap-2">
              {PRESETS.map((p) => (
                <button key={p.freq} type="button" onClick={() => applyPreset(p.freq)}
                  className={cn("rounded-full border px-3 py-1 text-xs font-medium transition-colors", freqKey === p.freq ? "border-brand bg-brand text-brand-foreground" : "hover:bg-accent")}>
                  {p.label}
                </button>
              ))}
            </div>
          </div>
          <div className="grid gap-3 sm:grid-cols-3">
            <div className="space-y-1.5"><Label>Sessions</Label><Input type="number" min={1} max={60} value={count} onChange={(e) => setCount(e.target.value)} /></div>
            <div className="space-y-1.5">
              <Label>Frequency</Label>
              <Select value={freqKey} onValueChange={setFreqKey}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>{FREQS.map((f) => <SelectItem key={f.key} value={f.key}>{f.label}</SelectItem>)}</SelectContent>
              </Select>
            </div>
            {freqKey === "custom" && (
              <div className="space-y-1.5"><Label>Every (days)</Label><Input type="number" min={1} value={customDays} onChange={(e) => setCustomDays(e.target.value)} /></div>
            )}
          </div>

          {/* Live schedule preview — dates + amounts, both editable */}
          <div className="rounded-md border">
            <div className="flex flex-wrap items-center gap-2 border-b bg-muted/40 px-3 py-1.5 text-xs font-medium text-muted-foreground">
              <span>Schedule — {rows.length} session{rows.length === 1 ? "" : "s"}{rows.length > 0 ? `, ends ${fmtDate(rows[rows.length - 1].date)}` : ""}</span>
              <div className="ml-auto flex items-center gap-2">
                <div className="flex rounded-md border bg-card p-0.5 text-[11px]">
                  {(["ethiopian", "gregorian"] as const).map((mo) => (
                    <button key={mo} type="button" onClick={() => setScheduleMode(mo)}
                      className={cn("rounded px-2 py-0.5 font-medium", scheduleMode === mo ? "bg-brand text-brand-foreground" : "text-muted-foreground hover:text-foreground")}>
                      {mo === "ethiopian" ? "Ethiopian" : "Gregorian"}
                    </button>
                  ))}
                </div>
                <span className={cn("tabular-nums font-semibold", mismatch ? "text-amber-600" : target > 0 ? "text-emerald-600" : "")}>Σ {birr(String(rowsTotal))}</span>
              </div>
            </div>
            <div className="max-h-56 overflow-auto">
              {rows.map((r, i) => (
                <div key={i} className="flex items-center gap-2 px-3 py-1.5">
                  <span className="w-5 shrink-0 text-xs tabular-nums text-muted-foreground">{i + 1}</span>
                  {scheduleMode === "ethiopian" ? (
                    <EthiopianRowInput key={`${scheduleGen}-${i}`} value={r.date} onChange={(iso) => editRow(i, { date: iso })} />
                  ) : (
                    <Input type="date" value={r.date} onChange={(e) => editRow(i, { date: e.target.value })} className="h-8 w-52" />
                  )}
                  <div className="ml-auto flex items-center gap-1.5">
                    <Input type="number" min={0} value={r.amount} onChange={(e) => editRow(i, { amount: e.target.value })} className="h-8 w-28 text-right" placeholder="0.00" />
                    <span className="w-7 text-xs text-muted-foreground">ETB</span>
                  </div>
                </div>
              ))}
            </div>
          </div>

          {mismatch && (
            <div className="flex items-start gap-2 rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-800">
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
              <div className="flex-1 space-y-1">
                <p>
                  The sessions add up to <b>{birr(String(rowsTotal))}</b> — that's <b>{birr(String(Math.abs(diff)))} {diff > 0 ? "over" : "under"}</b> the <b>{birr(String(target))}</b> total cost.
                </p>
                {canBalance ? (
                  <button type="button" onClick={balanceLast} className="font-medium text-amber-900 underline underline-offset-2 hover:text-amber-950">
                    Balance the last session to match
                  </button>
                ) : (
                  <p>The earlier sessions already exceed the total — lower them, or raise the total cost.</p>
                )}
              </div>
            </div>
          )}

          <div className="space-y-1.5"><Label>Note (optional)</Label><Input value={note} onChange={(e) => setNote(e.target.value)} /></div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>Cancel</Button>
          <Button disabled={!title.trim() || rows.length === 0} loading={mut.isPending}
            onClick={() => {
              if (mismatch) {
                toast.error(`Sessions add up to ${birr(String(rowsTotal))}, which doesn't match the ${birr(String(target))} total cost. Balance them first.`);
                return;
              }
              mut.mutate();
            }}>Create plan</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
