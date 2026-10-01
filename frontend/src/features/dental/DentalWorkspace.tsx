import { useEffect, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate, useSearchParams } from "react-router-dom";
import {
  AlertTriangle, ArrowLeft, CalendarClock, CalendarDays, ImagePlus, Pencil, Phone, Plus,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import { CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Skeleton } from "@/components/ui/skeleton";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { toast } from "@/components/ui/sonner";
import { cn } from "@/lib/utils";
import { useAuth } from "@/app/auth-context";
import { useConfirmDialog } from "@/components/ConfirmDialog";
import { AppError } from "@/lib/api-client";
import { compressImage } from "@/lib/image";
import { EthiopianDateInput } from "@/components/EthiopianDateInput";
import { ETH_MONTHS, ethiopianDaysInMonth, ethiopianToGregorianISO, formatEthiopian, toEthiopian } from "@/lib/ethiopian";
import { getPatient } from "@/features/patients/api";
import { PatientEditDialog } from "@/features/patients/components/PatientEditDialog";
import { PaymentHistoryCard } from "@/features/billing/PaymentHistoryCard";
import { PanelBody, PanelCard, PanelHeader, RecordShelf, SHELF_ICONS } from "@/features/dental/shelf/RecordShelf";
import { DeskActions } from "@/features/dental/desk/DeskActions";
import { CertificateCard } from "@/features/clinical/CertificateCard";
import { TimelinePanel, timelineCount } from "@/features/dental/shelf/TimelinePanel";
import { TreatmentsPanel } from "@/features/dental/shelf/TreatmentsPanel";
import { useScrolledPast } from "@/features/patients/components/StickyAlertBar";
import { SafetyStrip, PatientAllergyLine } from "@/features/dental/SafetyStrip";
import { VisitCockpit } from "@/features/dental/visit/VisitCockpit";
import { useFocusVisit } from "@/features/dental/visit/useFocusVisit";
import { AllergyDialog } from "@/features/dental/AllergyDialog";
import { ExaminationCard } from "@/features/dental/ExaminationCard";
import { invalidateDental } from "@/features/dental/invalidate";
import { ToothChart } from "@/features/dental/ToothChart";
import { useToothStatuses } from "@/features/dental/toothStatus";
import { FLAT_TEETH, ToothMultiSelect } from "@/features/dental/shared/pickers";
import { PriceAgainstList, ServicePicker } from "@/features/dental/shared/ServicePicker";
import { PatientMessages } from "@/features/messaging/PatientMessages";
import { messageLog } from "@/features/messaging/api";
import { splitRounded } from "@/features/dental/money";
import { DepositCallout, depositOutstanding } from "@/features/dental/shared/Deposit";
import { UnbilledRows, owedOnPlan } from "@/features/dental/shared/UnbilledWork";
import { ImageGallery } from "@/features/dental/shared/visitRecord";

import {
  createPlan, deleteDentalImage, dentalSummary,
  listDentalImages, saveChart, uploadDentalImage,
  type Balance, type Plan,
} from "@/features/dental/api";

const num = (s?: string) => Number(s || 0);
const birr = (s?: string) => `${num(s).toLocaleString(undefined, { maximumFractionDigits: 2 })} ETB`;



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
function isoLocal(d: Date) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
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
  // The conditions, their order and their colours are the clinic's, not this file's.
  const toothSts = useToothStatuses();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const { can } = useAuth();
  // Reception is the one asked "did she get it?", so reading is enough — this is
  // a record of what happened, not a place to send anything.
  const canMessage = can("message.send") || can("message.manage");
  // Only the count of messages that never arrived, and only when this user could
  // do something about it. Cheap enough to run beside the summary; the panel
  // itself does the real fetching.
  const msgTrouble = useQuery({
    queryKey: ["message-log", "patient", patientId],
    queryFn: () => messageLog({ patient: patientId }),
    enabled: canMessage,
  });
  const unreadMessageTrouble =
    (msgTrouble.data ?? []).filter((m) => m.status === "failed" || m.status === "skipped").length;
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
  const [editingAllergies, setEditingAllergies] = useState(false);
  // ?visit= makes the cockpit's choice addressable: it survives a refresh, a refetch
  // and the back button, and it is what a chairside hand-off can point at.
  const [params, setParams] = useSearchParams();
  const todayISO = isoLocal(new Date());
  // A note open in the cockpit means switching the focused visit would retarget where
  // it saves — the same fault the course rail had. The rail hides itself; the timeline
  // is on another surface entirely, so this guard has to live here.
  const [recording, setRecording] = useState(false);
  const { ask, dialog } = useConfirmDialog();
  const pickVisit = (sessionId: string | null) => {
    if (recording) {
      ask({
        title: "A visit note is open",
        description: "Switching visits closes it. What you typed is kept as a draft and will be there when you reopen this visit.",
        confirmLabel: "Switch visit",
      }, () => setVisitParam(sessionId));
      return;
    }
    setVisitParam(sessionId);
  };
  const setVisitParam = (sessionId: string | null) => {
    const next = new URLSearchParams(params);
    if (sessionId) next.set("visit", sessionId); else next.delete("visit");
    setParams(next, { replace: true });
  };
  const bannerRef = useRef<HTMLDivElement>(null);
  const scrolledPast = useScrolledPast(bannerRef);

  const patient = useQuery({ queryKey: ["patient", patientId], queryFn: () => getPatient(patientId) });
  // The cashier settles on another computer, so this page cannot be told when money
  // arrives. It re-reads when the tab regains focus and, while anything is waiting at
  // the cashier, every 15 s — otherwise the desk asks for money already paid (W10).
  const summary = useQuery({
    queryKey: ["dental-summary", patientId], queryFn: () => dentalSummary(patientId),
    refetchOnWindowFocus: true,
    refetchInterval: (q) => (Number(q.state.data?.balance?.at_cashier ?? 0) > 0 ? 15_000 : false),
  });
  const invalidate = () => invalidateDental(qc, patientId);

  // Resolution replaces filtering. The old code filtered plans by date scope FIRST
  // and then auto-picked a tab from what survived, so a patient with no session today
  // showed "In progress 0" and landed on History — the running treatment hidden with
  // no indication that a filter was responsible.
  //
  // Called HERE, with every other hook and above the loading/error returns. React
  // counts hooks per render: one useMemo below an early return means the loading
  // render and the loaded render disagree, and the whole page unmounts to white.
  const resolved = useFocusVisit(summary.data?.plans ?? [], todayISO, params.get("visit"));

  // Local, debounced odontogram. The local map is the edit source while the clinician
  // is clicking teeth, but the SERVER is the source of truth the moment it answers.
  // --- the odontogram -------------------------------------------------------
  //
  // A debounced, optimistic clinical record, which is a shape that gets subtly wrong
  // very easily. Three refs, each with one job, because a single "dirty" boolean
  // cannot express "a save succeeded but newer edits are still queued" — and that
  // gap let a completed save re-seed the chart over a tooth the clinician had just
  // clicked, then let the next click destroy the pending timer holding it.
  //
  //   draft       — the map on screen, updated synchronously so two fast clicks in
  //                 one tick both build on each other rather than on stale state.
  //   confirmed   — the last map the SERVER acknowledged. This, and only this, is
  //                 what a failed save reverts to; a mid-burst snapshot is a state
  //                 the server never held and must never be presented as the record.
  //   queued      — the map waiting on the debounce. While it is non-null the chart
  //                 belongs to the clinician, and no refetch may overwrite it.
  const [teeth, setTeeth] = useState<Record<string, string>>({});
  const draft = useRef<Record<string, string>>({});
  const confirmed = useRef<Record<string, string>>({});
  const queued = useRef<Record<string, string> | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Two saves can be in flight if a click lands while one is running. Sequence stamps
  // mean a slow earlier reply cannot overwrite a newer confirmed chart.
  const sentSeq = useRef(0);
  const ackSeq = useRef(0);

  const showChart = (map: Record<string, string>) => { draft.current = map; setTeeth(map); };

  const chartSave = useMutation({
    mutationFn: (v: { map: Record<string, string>; seq: number }) => saveChart(patientId, v.map),
    onSuccess: (_res, v) => {
      if (v.seq < ackSeq.current) return; // a straggler; a newer save already landed
      ackSeq.current = v.seq;
      confirmed.current = v.map;
      // Only release the chart if nothing newer is waiting; otherwise the refetch
      // below would land on top of an edit that has not been sent yet.
      if (timer.current === null) queued.current = null;
      qc.invalidateQueries({ queryKey: ["dental-summary", patientId] });
    },
    onError: (e) => {
      // Back to the last thing the server actually confirmed, and say so. A toast
      // over a chart still showing the failed edit is the one state a clinical
      // record must never be in: it reads as saved.
      if (timer.current) { clearTimeout(timer.current); timer.current = null; }
      queued.current = null;
      showChart(confirmed.current);
      toast.error(e instanceof AppError ? e.message : "Could not save the tooth chart — your last changes were undone");
      qc.invalidateQueries({ queryKey: ["dental-summary", patientId] });
    },
  });

  useEffect(() => {
    if (!summary.data) return;
    const server = summary.data.chart.teeth ?? {};
    confirmed.current = server;
    // Adopt the server's chart only when nothing of ours is outstanding. This is what
    // finally delivers a second clinician's edits — the old one-shot seed meant they
    // never arrived, and the next click here saved a stale map back over their work.
    if (queued.current === null && !chartSave.isPending) showChart(server);
  }, [summary.data]); // eslint-disable-line react-hooks/exhaustive-deps

  // A pending click must not die with the page. Saved directly rather than through the
  // mutation, which is gone by the time this runs.
  useEffect(() => () => {
    if (timer.current) clearTimeout(timer.current);
    const last = queued.current;
    if (last) saveChart(patientId, last).catch(() => {});
  }, [patientId]);

  // One status onto one tooth, through the debounced save. Both a tap and its Undo
  // come through here, so an undo is saved exactly like the edit it reverts.
  const applyTooth = (code: string, status: string) => {
    const map = { ...draft.current };
    if (status) map[code] = status; else delete map[code];
    showChart(map);
    queued.current = map;
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      timer.current = null;
      const send = queued.current;
      if (send) chartSave.mutate({ map: send, seq: ++sentSeq.current });
    }, 700);
  };

  const toggleTooth = (code: string) => {
    // Computed outside the state updater: React may run an updater more than once,
    // and starting a save from inside one is a side effect in a place that promises
    // to be pure.
    const prev = draft.current[code] ?? "";
    // The chart is read-only until the conditions load; this is the second lock.
    if (!toothSts.ready) return;
    const next = toothSts.next(prev);
    applyTooth(code, next);
    // Tap-to-cycle with autosave means a stray thumb-tap silently rewrites the
    // record. Name what just changed and offer the way back; one toast id per
    // tooth, so re-taps update the toast instead of stacking five of them.
    toast(`${code} → ${next ? toothSts.labelOf(next) : "Cleared"}`, {
      id: `tooth-${code}`,
      action: { label: "Undo", onClick: () => applyTooth(code, prev) },
    });
  };

  const [newPlan, setNewPlan] = useState(false);

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

  const bal = summary.data.balance;
  const plans = summary.data.plans;


  return (
    <div className="space-y-6">
      {/* ~24px of text is a cursor target, not a thumb one — touch-hit adds the
          invisible halo on coarse pointers only, so desktop pixels do not move. */}
      <button onClick={() => navigate("/patients")} className="touch-hit flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground">
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
            {/* px-2.5 py-1 makes a ~26px pill — fine under a cursor, unhittable under
                a thumb. Below md they grow to a 36px target; desktop keeps its size. */}
            {canEditPatient && (
              <button onClick={() => setEditingPatient(true)}
                className="flex items-center gap-1 rounded-full bg-white/15 px-2.5 py-1 text-xs font-medium hover:bg-white/25 max-md:min-h-9 max-md:px-3">
                <Pencil className="h-3 w-3" /> Edit details
              </button>
            )}
            <button onClick={() => navigate(`/patients/${patientId}/schedule`)}
                className="flex items-center gap-1 rounded-full bg-white/15 px-2.5 py-1 text-xs font-medium hover:bg-white/25 max-md:min-h-9 max-md:px-3">
                <CalendarClock className="h-3 w-3" /> Schedule
              </button>
            {/* "When is this patient next in?" is a calendar question, and the answer
                was to open the calendar and read every other patient's week looking
                for this one. The filter travels in the URL. */}
            <button onClick={() => navigate(`/appointments?patient=${patientId}`)}
                className="flex items-center gap-1 rounded-full bg-white/15 px-2.5 py-1 text-xs font-medium hover:bg-white/25 max-md:min-h-9 max-md:px-3">
                <CalendarDays className="h-3 w-3" /> On the calendar
              </button>
          </div>
          <p className="text-sm text-brand-foreground/80 tabular-nums">
            MRN {p.mrn} · {age(p.dob)} · <span className="capitalize">{p.gender}</span>
            {/* The full number, never shortened — and a tel: link at the desk too,
                for softphones. Hidden below md, where the dedicated tap line below
                takes over, so the number is never shown twice. */}
            {p.phone ? (
              <span className="max-md:hidden"> · <a href={`tel:${p.phone}`} className="hover:underline">{p.phone}</a></span>
            ) : null}
            {p.blood_group ? ` · ${p.blood_group}` : ""}
          </p>
          {/* On the device that can place the call, the number is a tel: link on its
              own line — whole, never truncated, and one tap from ringing. */}
          {p.phone && (
            <a href={`tel:${p.phone}`}
              className="inline-flex min-h-9 items-center gap-1.5 text-sm font-medium text-brand-foreground underline underline-offset-2 md:hidden">
              <Phone className="h-3.5 w-3.5" />
              <span className="whitespace-nowrap tabular-nums">{p.phone}</span>
            </a>
          )}
        </div>
        <div className="ml-auto flex flex-wrap items-center gap-2">
          {/* Money is deliberately NOT a red pill here any more: it used to be
              indistinguishable from an allergy in this very row, which is how staff
              learn to filter red out. The allergy flag keeps the red. */}
          {bal.overdue && (
            <span className="rounded-full bg-white/15 px-3 py-1 text-xs font-medium">
              Owes {birr(bal.due)}
            </span>
          )}
          {/* Allergies live on the banner, not only in the strip: they come from the
              patient record, so they render even when the health-history query fails. */}
          {p.allergies.map((a) => (
            <span key={a.id} className="flex items-center gap-1 rounded-full bg-destructive px-3 py-1 text-xs font-semibold text-destructive-foreground">
              <AlertTriangle className="h-3.5 w-3.5" /> Allergy: {a.substance}
            </span>
          ))}
          {/* Always a button, never a dead label: until now a dental clinic had no
              way to record an allergy at all, so every patient read "no known
              allergies" whether or not anyone had asked. */}
          {editable ? (
            <button onClick={() => setEditingAllergies(true)}
              className={cn("flex items-center gap-1 rounded-full px-3 py-1 text-xs font-medium hover:bg-white/25 max-md:min-h-9",
                p.allergies.length === 0 ? "bg-white/15" : "bg-white/20")}>
              {p.allergies.length === 0 ? <><Plus className="h-3 w-3" /> Record allergies</> : <><Pencil className="h-3 w-3" /> Allergies</>}
            </button>
          ) : p.allergies.length === 0 ? (
            <span className="rounded-full bg-white/15 px-3 py-1 text-xs">No known allergies</span>
          ) : null}
        </div>
      </div>

      <SafetyStrip allergies={scrolledPast ? p.allergies : []} />

      {/* The visit this page is about — resolved, never filtered. */}
      <VisitCockpit
        patientId={patientId} resolved={resolved} plans={summary.data.plans} teeth={teeth} editable={editable}
        canCollect={canCollect} canReschedule={canReschedule} imageLimit={summary.data.image_limit}
        onNewPlan={editable ? () => setNewPlan(true) : undefined}
        onRecordingChange={setRecording}
        onPick={pickVisit} onChanged={invalidate}
      />

      {dialog}

      {/* The front desk's two jobs — take payment, rebook a missed visit. The
          clinician has the cockpit and the unbilled report for both, so this only
          appears for the desk rather than re-crowding the page just decluttered. */}
      {!editable && (
        <DeskActions patientId={patientId} plans={plans} todayISO={todayISO}
          canCollect={canCollect} canReschedule={canReschedule} onChanged={invalidate} />
      )}

      {/* The record: one panel at a time, instead of six stacked cards. */}
      <RecordShelf
        patientId={patientId}
        panels={[
          {
            key: "timeline", label: "Timeline", icon: SHELF_ICONS.CalendarRange,
            badge: timelineCount(plans) || undefined,
            render: () => <TimelinePanel patientId={patientId} plans={plans} todayISO={todayISO} onOpenVisit={pickVisit} />,
          },
          {
            // Course-first, next to the Timeline's time-first. The Timeline dissolves
            // courses on purpose and therefore cannot answer "how is this one going" —
            // its terms, its own visit order, its money, all in one place.
            key: "treatments", label: "Treatments", icon: SHELF_ICONS.Stethoscope,
            badge: plans.filter((pl) => pl.status === "active").length || undefined,
            render: () => (
              <TreatmentsPanel patientId={patientId} plans={plans} todayISO={todayISO}
                canCollect={canCollect} onOpenVisit={pickVisit}
                onNewPlan={editable ? () => setNewPlan(true) : undefined} />
            ),
          },
          ...(editable ? [{
            key: "chart", label: "Tooth chart", icon: SHELF_ICONS.Grid3x3,
            badge: Object.keys(teeth).length || undefined,
            render: () => (
              <div className="space-y-2">
                <p className="text-xs text-muted-foreground">Tap a tooth to cycle its condition. Saved automatically.</p>
                <div className="overflow-x-auto"><ToothChart teeth={teeth} editable={editable} onToggle={toggleTooth} /></div>
              </div>
            ),
          }] : []),
          ...(editable ? [{
            key: "exams", label: "Examinations", icon: SHELF_ICONS.ClipboardList,
            render: () => <ExaminationCard patientId={patientId} editable={editable} bare />,
          }] : []),
          ...(editable ? [{
            // No badge: the summary carries only session images, so counting here
            // reported 0 for a patient whose X-rays are all filed at patient level.
            key: "images", label: "Images", icon: SHELF_ICONS.Images,
            render: () => <PatientImagesCard patientId={patientId} plans={plans} editable={editable} imageLimit={summary.data!.image_limit} bare />,
          }] : []),
          {
            // Also on the desk's shelf, read-only: a patient who lost their
            // certificate asks the front desk for another copy, not the dentist.
            key: "certificates", label: "Certificates", icon: SHELF_ICONS.FileCheck2,
            render: () => <CertificateCard patientId={patientId} canIssue={editable} bare />,
          },
          ...(canMessage ? [{
            // "Did she get the reminder?" is asked at the desk about one patient,
            // not about the clinic, so the answer belongs on the patient.
            key: "messages", label: "Messages", icon: SHELF_ICONS.MessageSquare,
            // A message that never arrived is worth noticing without opening the
            // tab — that is the whole failure mode this panel exists for.
            badge: unreadMessageTrouble || undefined,
            render: () => <PatientMessages patientId={patientId} />,
          }] : []),
          {
            key: "money", label: "Money", icon: SHELF_ICONS.Receipt,
            badge: bal.overdue ? "!" : undefined,
            render: () => (
              // Two questions, two blocks, and a rule between them. Stacked flush
              // they read as one long list, which is why "by course" and the
              // payment rows below it were hard to tell apart.
              <div className="space-y-5">
                <BalanceSummary patientId={patientId} bal={bal} plans={plans} canCollect={canCollect} />
                <div className="border-t pt-5">
                  <PaymentHistoryCard patientId={patientId} bare />
                </div>
              </div>
            ),
          },
        ]}
      />

      {newPlan && <NewPlanDialog patientId={patientId} teeth={teeth} onClose={() => setNewPlan(false)} onSaved={() => { setNewPlan(false); invalidate(); }} />}
      {editingPatient && (
        <PatientEditDialog patient={p} onClose={() => setEditingPatient(false)}
          onSaved={() => qc.invalidateQueries({ queryKey: ["patient", patientId] })} />
      )}
      {editingAllergies && (
        <AllergyDialog patientId={patientId} allergies={p.allergies}
          onClose={() => setEditingAllergies(false)}
          onSaved={() => qc.invalidateQueries({ queryKey: ["patient", patientId] })} />
      )}
    </div>
  );
}

/** The down payment on a course: money, but not a visit, so it has nowhere else to
 *  live. It cannot appear in Unbilled treatment (that is treatment already given)
 *  and it is deliberately not in the visit timeline, so this is the one place the
 *  desk can see it is outstanding and send it to the cashier. */
/** The money headline, lifted out of its old card so it can live on the shelf. */
function BalanceSummary({ patientId, bal, plans, canCollect }: { patientId: string; bal: Balance; plans: Plan[]; canCollect: boolean }) {
  const owed = num(bal.owed);
  const pct = owed > 0 ? Math.min(100, Math.round((num(bal.paid) / owed) * 100)) : 0;
  const live = plans.filter((pl) => pl.status !== "cancelled");
  const due = num(bal.due);

  return (
    <div className="space-y-4">
      {/* THE HEADLINE. One number, and it is the only one that means "ask the
          patient for money today" — planned and collected are context under it. */}
      <div className="rounded-lg border bg-card p-4 shadow-sm">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <p className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
              Owed now for treatment
            </p>
            <p className={cn("mt-0.5 text-3xl font-bold", due > 0.005 ? "text-destructive" : "text-emerald-600")}>
              {birr(bal.due)}
            </p>
            <p className="mt-0.5 text-xs text-muted-foreground">
              {due > 0.005 ? "Treatment already given and not paid for." : "Nothing is outstanding for treatment given."}
            </p>
          </div>
          <div className="grid grid-cols-3 gap-x-5 text-right">
            {[
              { k: "Planned", v: bal.owed, tone: "" },
              { k: "Paid", v: bal.paid, tone: "text-emerald-700" },
              { k: "Still to pay", v: bal.balance, tone: "" },
            ].map((c) => (
              <div key={c.k}>
                <div className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">{c.k}</div>
                <div className={cn("text-sm font-bold tabular-nums", c.tone)}>{birr(c.v)}</div>
              </div>
            ))}
          </div>
        </div>

        {owed > 0 && (
          <div className="mt-3 flex items-center gap-2">
            <div className="h-2 flex-1 overflow-hidden rounded-full bg-muted">
              <div className="h-full rounded-full bg-emerald-500 transition-all" style={{ width: `${pct}%` }} />
            </div>
            <span className="shrink-0 text-xs font-semibold text-emerald-600">{pct}% paid</span>
          </div>
        )}

        {(num(bal.at_cashier) > 0.005 || num(bal.waived) > 0.005) && (
          <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 border-t pt-2 text-xs">
            {num(bal.at_cashier) > 0.005 && (
              <span className="font-medium text-amber-700">
                {birr(bal.at_cashier)} with the cashier — deliberately not counted above
              </span>
            )}
            {num(bal.waived) > 0.005 && <span className="text-muted-foreground">{birr(bal.waived)} written off</span>}
          </div>
        )}
      </div>

      {/* THE COURSES. One card each, because a course is the thing a dentist thinks
          in — and because the old flat list put a course, its deposit and the
          payment ledger below it at the same visual weight, so none of the three
          read as a separate thing. */}
      {live.length > 0 && (
        <section className="space-y-2">
          <div className="flex items-baseline justify-between gap-2">
            <h3 className="text-xs font-bold uppercase tracking-wide text-foreground">Treatment courses</h3>
            <span className="text-[11px] text-muted-foreground">
              {live.length} course{live.length === 1 ? "" : "s"} · dental work only
            </span>
          </div>
          <div className="space-y-2">
            {live.map((pl) => {
              const planned = num(pl.money.planned);
              const paid = num(pl.money.collected);
              const owedNow = num(pl.money.due);
              const p = planned > 0 ? Math.min(100, Math.round((paid / planned) * 100)) : 0;
              const left = Math.max(0, planned - paid - num(pl.money.at_cashier));
              return (
                <div key={pl.id} className="rounded-lg border bg-card p-3 shadow-sm">
                  <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
                    <span className="min-w-0 truncate font-semibold">{pl.title}</span>
                    <span className="shrink-0 text-sm tabular-nums">
                      <b className="text-emerald-700">{birr(pl.money.collected)}</b>
                      <span className="text-muted-foreground"> of {birr(pl.money.planned)}</span>
                    </span>
                  </div>
                  <div className="mt-2 flex items-center gap-2">
                    <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-muted">
                      <div className="h-full rounded-full bg-emerald-500" style={{ width: `${p}%` }} />
                    </div>
                    <span className="w-9 shrink-0 text-right text-[11px] tabular-nums text-muted-foreground">{p}%</span>
                  </div>
                  <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs">
                    {left > 0.005 && <span className="text-muted-foreground">{birr(String(left))} still to pay</span>}
                    {owedNow > 0.005 && (
                      <span className="font-semibold text-destructive">{birr(pl.money.due)} owed now</span>
                    )}
                    {num(pl.money.at_cashier) > 0.005 && (
                      <span className="font-medium text-amber-700">{birr(pl.money.at_cashier)} with the cashier</span>
                    )}
                  </div>
                  {/* The deposit belongs INSIDE its course. On the flat list it was an
                      indented line that could have belonged to any of them. */}
                  {depositOutstanding(pl) && (
                    <div className="mt-2">
                      <DepositCallout patientId={patientId} plan={pl} canCollect={canCollect} compact />
                    </div>
                  )}
                  {/* "2,000 owed now" is a number nobody can act on. These are the rows
                      behind it — a delivered visit, or an extra taken during one — so
                      the reader can see what it is and send it to the desk. */}
                  <UnbilledRows patientId={patientId} canCollect={canCollect} items={owedOnPlan(pl)} />
                </div>
              );
            })}
          </div>
        </section>
      )}
    </div>
  );
}







// --- per-session prescriptions (printable, multiple) ---

function PatientImagesCard({ patientId, plans, editable, imageLimit, bare }: { patientId: string; plans: Plan[]; editable: boolean; imageLimit: number; bare?: boolean }) {
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
    <PanelCard bare={bare}>
      <PanelHeader bare={bare} className="flex-row flex-wrap items-center justify-between gap-2 space-y-0">
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
      </PanelHeader>
      <PanelBody bare={bare} className="space-y-5">
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
      </PanelBody>
    </PanelCard>
  );
}

// Compact Ethiopian date entry for a schedule row: month + day + year, converting
// to/from the stored Gregorian ISO. Local parts are the edit source (so clearing a
// field mid-type doesn't snap back); remount (via key) re-seeds when the parent
// regenerates the schedule. Mirrors EthiopianDateInput's Ethiopian mode, sized for a row.
/** Split an ISO date into Ethiopian y/m/d parts for the three-field row input. */
const ecParts = (v: string) => {
  if (!v) return { y: "", m: "", d: "" };
  const e = toEthiopian(v);
  return { y: String(e.year), m: String(e.month), d: String(e.day) };
};

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
  // The catalogue entry this course is, and what the list said it cost when it was
  // chosen. Keeping the two apart is what lets the dentist charge something else
  // and still have the difference show up as a discount rather than vanish.
  const [service, setService] = useState<{ id: string; price: string } | null>(null);
  const [sel, setSel] = useState<string[]>([]); // selected tooth codes
  const toothStr = FLAT_TEETH.filter((c) => sel.includes(c)).join(", ");
  const [total, setTotal] = useState("");
  const [deposit, setDeposit] = useState("");
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

  // What the sessions divide is the total less the down payment — the deposit is
  // paid to start the work, not spread across the visits.
  const down = Math.max(0, Math.min(num(deposit), num(total) || num(deposit)));
  const financed = Math.max(0, num(total) - down);

  // Regenerate the preview whenever the schedule inputs change.
  useEffect(() => {
    setRows(genPreview(start, n, unit, ivl, financed));
    setScheduleGen((g) => g + 1);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [start, n, unit, ivl, financed]);

  const rowsTotal = rows.reduce((a, r) => a + num(r.amount), 0);
  const fmtDate = (iso: string) => (iso && scheduleMode === "ethiopian" ? `${formatEthiopian(iso)} EC` : iso);

  // Reconcile the per-session amounts against the entered total cost. When no total
  // is entered the sessions define it (no warning); otherwise they must match.
  const target = financed;
  const diff = rowsTotal - target; // + = sessions exceed the financed part, − = fall short
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
      deposit: String(down),
      service_id: service?.id,
      sessions: rows.map((r) => ({ scheduled_date: r.date, amount_due: r.amount || "0" })),
    }),
    onSuccess: () => { toast.success("Treatment plan created"); onSaved(); },
    onError: (e) => toast.error(e instanceof AppError ? e.message : "Could not create the plan"),
  });

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      {/* Full-screen on a phone: this is a multi-section task with a schedule
          preview, and a bottom sheet leaves it editing through a letterbox. */}
      <DialogContent className="max-w-2xl" fullOnMobile>
        <DialogHeader><DialogTitle>New treatment plan</DialogTitle></DialogHeader>
        <PatientAllergyLine patientId={patientId} />
        <div className="space-y-3">
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label>Treatment</Label>
              <ServicePicker
                value={title}
                selectedId={service?.id}
                onPick={(s) => {
                  setService(s ? { id: s.id, price: s.price } : null);
                  if (s) {
                    setTitle(s.name);
                    // The list price fills the total; it is the answer in almost every
                    // case, and it stays editable for the one where it is not.
                    if (num(s.price) > 0) setTotal(s.price);
                  }
                }}
                onFreeText={(name) => { setTitle(name); setService(null); }}
                placeholder="e.g. Root canal"
              />
            </div>
            <div className="space-y-1.5">
              <Label>Teeth (optional)</Label>
              <ToothMultiSelect teeth={teeth} value={sel} onChange={setSel} />
            </div>
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-3">
              <div className="space-y-1.5">
                <Label>Total cost (ETB)</Label>
                <Input type="number" min={0} value={total} onChange={(e) => setTotal(e.target.value)} placeholder="0" />
                <PriceAgainstList list={service?.price} charging={total || "0"} />
              </div>
              <div className="space-y-1.5">
                <Label>Down payment (ETB)</Label>
                <Input type="number" min={0} value={deposit} onChange={(e) => setDeposit(e.target.value)} placeholder="0" />
                <p className="text-xs text-muted-foreground">
                  {down > 0
                    ? <>Paid up front. The remaining <b className="text-foreground">{birr(String(financed))}</b> is divided across the sessions.</>
                    : <>Optional. Leave empty to divide the whole cost across the sessions.</>}
                </p>
              </div>
            </div>
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
                <span className={cn("tabular-nums font-semibold", mismatch ? "text-amber-600" : target > 0 ? "text-emerald-600" : "")}>
                  Σ {birr(String(down + rowsTotal))}{down > 0 ? ` (${birr(String(down))} down)` : ""}
                </span>
              </div>
            </div>
            <div className="max-h-56 overflow-auto">
              {down > 0 && (
                <div className="flex items-center gap-2 border-b bg-muted/20 px-3 py-1.5">
                  <span className="w-5 shrink-0 text-xs text-muted-foreground">↓</span>
                  <span className="text-sm font-medium">Down payment</span>
                  <span className="text-xs text-muted-foreground">due on the start date</span>
                  <span className="ml-auto pr-9 text-sm font-semibold tabular-nums">{birr(String(down))}</span>
                </div>
              )}
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
