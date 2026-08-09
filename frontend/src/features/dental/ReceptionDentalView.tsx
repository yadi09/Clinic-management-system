// The front desk's view of a dental patient.
//
// Deliberately NOT the dentist's workspace with pieces hidden. Reception answers a
// different set of questions — "what do I owe?", "when do I come back?", "can I pay
// it all now?" — so the page leads with money and the next visit, and treats the
// treatment plan as a payment schedule rather than a clinical timeline. Nothing
// clinical (tooth chart, procedures, notes, Rx, images) is rendered or fetched here.
import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "react-router-dom";
import { AlertTriangle, ArrowLeft, CalendarClock, CalendarDays, CheckCircle2, ChevronDown, HandCoins, Pencil, Undo2, Wallet } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { toast } from "@/components/ui/sonner";
import { cn, ageLabel } from "@/lib/utils";
import { useAuth } from "@/app/auth-context";
import { AppError } from "@/lib/api-client";
import { EthiopianDateInput } from "@/components/EthiopianDateInput";
import { formatEthiopian } from "@/lib/ethiopian";
import { getPatient } from "@/features/patients/api";
import { PatientEditDialog } from "@/features/patients/components/PatientEditDialog";
import { collectSessions, dentalSummary, rescheduleSession, uncollectSession, type Plan, type Session } from "@/features/dental/api";
import { PaymentHistoryCard } from "@/features/billing/PaymentHistoryCard";

const num = (s?: string) => Number(s || 0);
const birr = (s?: string | number) => `${Number(s || 0).toLocaleString(undefined, { maximumFractionDigits: 2 })} ETB`;
const todayISO = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};
const prettyDate = (iso: string) => new Date(`${iso}T00:00:00`).toLocaleDateString(undefined, { weekday: "short", day: "numeric", month: "short", year: "numeric" });
const daysFromToday = (iso: string) => Math.round((new Date(`${iso}T00:00:00`).getTime() - new Date(todayISO() + "T00:00:00").getTime()) / 86400000);

/** A session plus the plan it belongs to — reception always needs both together. */
interface Row { plan: Plan; s: Session }

/** Money state of one session, from the front desk's point of view. */
type Money = "due" | "billed" | "paid" | "scheduled";
function moneyState(s: Session): Money {
  if (s.payment === "paid") return "paid";
  if (s.payment === "billed") return "billed";
  // Service already given but unpaid — this is the money to actually chase.
  if (s.status === "done" || s.pay_later) return "due";
  return "scheduled";
}
const MONEY_BADGE: Record<Money, { variant: "destructive" | "warning" | "success" | "outline"; label: string }> = {
  due: { variant: "destructive", label: "Due" },
  billed: { variant: "warning", label: "At cashier" },
  paid: { variant: "success", label: "Paid" },
  scheduled: { variant: "outline", label: "Not due yet" },
};

type Lens = "all" | "unpaid" | "upcoming" | "done";

export function ReceptionDentalView({ patientId }: { patientId: string }) {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const { can } = useAuth();
  const canCollect = can("payment.charge");
  const canReschedule = can("appointment.manage");
  const canEditPatient = can("patient.update");

  const patient = useQuery({ queryKey: ["patient", patientId], queryFn: () => getPatient(patientId) });
  const summary = useQuery({ queryKey: ["dental-summary", patientId], queryFn: () => dentalSummary(patientId) });
  const refresh = () => {
    qc.invalidateQueries({ queryKey: ["dental-summary", patientId] });
    qc.invalidateQueries({ queryKey: ["patient-charges", patientId] });
  };

  const [editingPatient, setEditingPatient] = useState(false);
  const [collecting, setCollecting] = useState(false);
  const [rescheduling, setRescheduling] = useState<Row | null>(null);
  const [lens, setLens] = useState<Lens>("all");

  const plans = summary.data?.plans ?? [];
  const bal = summary.data?.balance;

  // Flatten to session rows once; every panel below is a view over these.
  const rows: Row[] = useMemo(
    () => plans.flatMap((plan) => plan.sessions.filter((s) => s.status !== "cancelled").map((s) => ({ plan, s }))),
    [plans],
  );
  const today = todayISO();
  const atCashier = rows.filter((r) => moneyState(r.s) === "billed").reduce((a, r) => a + num(r.s.amount_due), 0);
  const billable = rows.filter((r) => r.s.payment === "unpaid" && num(r.s.amount_due) > 0);
  // Missed: should have happened, never marked done — reception chases these.
  const missed = rows.filter((r) => r.s.status === "planned" && r.s.scheduled_date < today);
  const nextVisit = rows
    .filter((r) => r.s.status === "planned" && r.s.scheduled_date >= today)
    .sort((a, b) => a.s.scheduled_date.localeCompare(b.s.scheduled_date))[0];

  if (patient.isLoading || summary.isLoading) {
    return (
      <div className="space-y-6">
        <Skeleton className="h-24 w-full rounded-lg" />
        <div className="grid gap-4 sm:grid-cols-3">{Array.from({ length: 3 }).map((_, i) => <Skeleton key={i} className="h-24" />)}</div>
        <Skeleton className="h-64" />
      </div>
    );
  }
  if (patient.isError || !patient.data || !summary.data || !bal) {
    return (
      <div className="space-y-4">
        <p className="text-sm text-destructive">Could not load this patient.</p>
        <Button variant="outline" onClick={() => navigate("/patients")}><ArrowLeft /> Back to patients</Button>
      </div>
    );
  }

  const p = patient.data;
  const fullName = [p.first_name, p.middle_name, p.last_name].filter(Boolean).join(" ");

  return (
    <div className="space-y-6">
      <button onClick={() => navigate("/patients")} className="flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground">
        <ArrowLeft className="h-4 w-4" /> Patients
      </button>

      {/* Who's at the desk. */}
      <div className="flex flex-wrap items-center gap-4 rounded-lg bg-brand p-5 text-brand-foreground shadow-card">
        <Avatar className="h-12 w-12 bg-white/15">
          <AvatarFallback className="bg-transparent text-base text-brand-foreground">{(p.first_name[0] ?? "") + (p.last_name[0] ?? "")}</AvatarFallback>
        </Avatar>
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="text-h2 leading-tight">{fullName}</h2>
            {canEditPatient && (
              <button onClick={() => setEditingPatient(true)} className="flex items-center gap-1 rounded-full bg-white/15 px-2.5 py-1 text-xs font-medium hover:bg-white/25">
                <Pencil className="h-3 w-3" /> Edit details
              </button>
            )}
            <button onClick={() => navigate(`/patients/${patientId}/schedule`)}
                className="flex items-center gap-1 rounded-full bg-white/15 px-2.5 py-1 text-xs font-medium hover:bg-white/25">
                <CalendarClock className="h-3 w-3" /> Schedule
              </button>
          </div>
          <p className="text-sm text-brand-foreground/80 tabular-nums">
            MRN {p.mrn} · {ageLabel(p.dob)} · <span className="capitalize">{p.gender}</span>{p.phone ? ` · ${p.phone}` : ""}
          </p>
        </div>
        <div className="ml-auto flex flex-wrap items-center gap-2">
          {p.allergies.length > 0 && (
            <span className="flex items-center gap-1 rounded-full bg-destructive px-3 py-1 text-xs font-semibold text-destructive-foreground">
              <AlertTriangle className="h-3.5 w-3.5" /> {p.allergies.length} allerg{p.allergies.length === 1 ? "y" : "ies"}
            </span>
          )}
        </div>
      </div>

      {/* The three numbers the desk is asked for, and the one action that follows. */}
      <div className="grid gap-4 sm:grid-cols-3">
        <MoneyTile
          label="Due now" value={bal.due} tone={num(bal.due) > 0.005 ? "danger" : "ok"}
          hint={num(bal.due) > 0.005 ? "Treatment already given — collect this" : "Nothing outstanding"}
        />
        <MoneyTile label="At cashier" value={String(atCashier)} tone={atCashier > 0.005 ? "warn" : "muted"}
          hint={atCashier > 0.005 ? "Already sent — patient pays the cashier" : "Nothing waiting"} />
        <MoneyTile label="Remaining on plans" value={bal.balance} tone="muted"
          hint={`Total ${birr(bal.owed)} · paid ${birr(bal.paid)}`} />
      </div>

      {canCollect && billable.length > 0 && (
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border bg-card p-4">
          <div className="text-sm">
            <span className="font-medium">{billable.length} session{billable.length === 1 ? "" : "s"} not yet billed</span>
            <span className="text-muted-foreground"> · {birr(billable.reduce((a, r) => a + num(r.s.amount_due), 0))} in total</span>
          </div>
          <Button onClick={() => setCollecting(true)}><HandCoins className="h-4 w-4" /> Take payment</Button>
        </div>
      )}

      {/* Next visit + anything missed — the scheduling half of the desk's job. */}
      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader className="pb-2"><CardTitle className="flex items-center gap-2 text-base"><CalendarDays className="h-4 w-4 text-primary" /> Next visit</CardTitle></CardHeader>
          <CardContent>
            {!nextVisit ? (
              <p className="text-sm text-muted-foreground">No upcoming session booked. {missed.length > 0 ? "See the missed visits opposite." : "The dentist adds sessions to a treatment plan."}</p>
            ) : (
              <div className="space-y-2">
                <div className="flex flex-wrap items-baseline gap-2">
                  <span className="text-lg font-semibold tabular-nums text-brand">{prettyDate(nextVisit.s.scheduled_date)}</span>
                  <span className="text-xs text-muted-foreground">{formatEthiopian(nextVisit.s.scheduled_date)} EC</span>
                  <RelativeDay iso={nextVisit.s.scheduled_date} />
                </div>
                <p className="text-sm text-muted-foreground">
                  {nextVisit.plan.title} · session {nextVisit.s.seq} of {nextVisit.plan.session_count} · {birr(nextVisit.s.amount_due)}
                </p>
                {canReschedule && (
                  <Button size="sm" variant="outline" onClick={() => setRescheduling(nextVisit)}>
                    <CalendarClock className="h-3.5 w-3.5" /> Reschedule
                  </Button>
                )}
              </div>
            )}
          </CardContent>
        </Card>

        <Card className={cn(missed.length > 0 && "border-amber-300")}>
          <CardHeader className="pb-2"><CardTitle className="flex items-center gap-2 text-base"><AlertTriangle className={cn("h-4 w-4", missed.length > 0 ? "text-amber-500" : "text-muted-foreground")} /> Missed visits</CardTitle></CardHeader>
          <CardContent>
            {missed.length === 0 ? (
              <p className="text-sm text-muted-foreground">Nothing overdue — every past session is accounted for.</p>
            ) : (
              <div className="space-y-2">
                {missed.slice(0, 3).map((r) => (
                  <div key={r.s.id} className="flex flex-wrap items-center justify-between gap-2 text-sm">
                    <div>
                      <span className="font-medium tabular-nums">{prettyDate(r.s.scheduled_date)}</span>
                      <span className="text-muted-foreground"> · {r.plan.title} · session {r.s.seq}</span>
                    </div>
                    {canReschedule && (
                      <Button size="sm" variant="ghost" onClick={() => setRescheduling(r)}>
                        <CalendarClock className="h-3.5 w-3.5" /> Rebook
                      </Button>
                    )}
                  </div>
                ))}
                {missed.length > 3 && <p className="text-xs text-muted-foreground">+{missed.length - 3} more</p>}
              </div>
            )}
          </CardContent>
        </Card>
      </div>

      {/* Treatments as payment schedules, grouped by what reception must act on. */}
      <Card>
        <CardHeader className="flex-row flex-wrap items-center justify-between gap-2 space-y-0">
          <CardTitle>Treatments</CardTitle>
          <div className="flex flex-wrap gap-1 rounded-lg bg-muted p-1 text-sm">
            {([
              ["all", "All", rows.length],
              ["unpaid", "Needs payment", rows.filter((r) => moneyState(r.s) === "due").length],
              ["upcoming", "Upcoming", rows.filter((r) => moneyState(r.s) === "scheduled").length],
              ["done", "Paid", rows.filter((r) => moneyState(r.s) === "paid").length],
            ] as [Lens, string, number][]).map(([k, label, n]) => (
              <button key={k} type="button" onClick={() => setLens(k)}
                className={cn("flex items-center gap-1.5 rounded-md px-3 py-1.5 font-medium transition-colors",
                  lens === k ? "bg-card text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground")}>
                {label}<span className="rounded-full bg-foreground/10 px-1.5 text-xs tabular-nums">{n}</span>
              </button>
            ))}
          </div>
        </CardHeader>
        <CardContent className="space-y-3">
          {plans.length === 0 ? (
            <p className="py-8 text-center text-sm text-muted-foreground">No treatment plans yet — the dentist creates these.</p>
          ) : (
            plans.map((plan) => (
              <PlanMoneyCard key={plan.id} patientId={patientId} plan={plan} lens={lens}
                canCollect={canCollect} canReschedule={canReschedule}
                onReschedule={(s) => setRescheduling({ plan, s })} onChanged={refresh} />
            ))
          )}
        </CardContent>
      </Card>

      <PaymentHistoryCard patientId={patientId} />

      {editingPatient && <PatientEditDialog patient={p} onClose={() => setEditingPatient(false)} onSaved={() => qc.invalidateQueries({ queryKey: ["patient", patientId] })} />}
      {collecting && <CollectDialog patientId={patientId} rows={billable} onClose={() => setCollecting(false)} onDone={refresh} />}
      {rescheduling && <RescheduleDialog patientId={patientId} row={rescheduling} onClose={() => setRescheduling(null)} onDone={refresh} />}
    </div>
  );
}

function MoneyTile({ label, value, tone, hint }: { label: string; value: string; tone: "danger" | "warn" | "ok" | "muted"; hint: string }) {
  const colour = { danger: "text-rose-600", warn: "text-amber-600", ok: "text-emerald-600", muted: "text-brand" }[tone];
  return (
    <Card>
      <CardContent className="p-4">
        <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">{label}</p>
        <p className={cn("mt-1 text-2xl font-bold tabular-nums", colour)}>{birr(value)}</p>
        <p className="mt-1 text-xs text-muted-foreground">{hint}</p>
      </CardContent>
    </Card>
  );
}

function RelativeDay({ iso }: { iso: string }) {
  const d = daysFromToday(iso);
  const label = d === 0 ? "today" : d === 1 ? "tomorrow" : d > 0 ? `in ${d} days` : `${-d} days ago`;
  return <Badge variant={d === 0 ? "default" : d < 0 ? "destructive" : "outline"}>{label}</Badge>;
}

/** One treatment as a payment schedule: what it costs, what's paid, what's left. */
function PlanMoneyCard({ patientId, plan, lens, canCollect, canReschedule, onReschedule, onChanged }: {
  patientId: string; plan: Plan; lens: Lens; canCollect: boolean; canReschedule: boolean;
  onReschedule: (s: Session) => void; onChanged: () => void;
}) {
  const live = plan.sessions.filter((s) => s.status !== "cancelled");
  const match = (s: Session) =>
    lens === "all" ||
    (lens === "unpaid" && moneyState(s) === "due") ||
    (lens === "upcoming" && moneyState(s) === "scheduled") ||
    (lens === "done" && moneyState(s) === "paid");
  const shown = live.filter(match);
  const [open, setOpen] = useState(false);

  const total = num(plan.total_amount);
  const paid = live.filter((s) => s.payment === "paid").reduce((a, s) => a + num(s.amount_due), 0);
  const due = live.filter((s) => moneyState(s) === "due").reduce((a, s) => a + num(s.amount_due), 0);
  const pct = total > 0 ? Math.min(100, Math.round((paid / total) * 100)) : 0;
  const allPaid = live.length > 0 && live.every((s) => s.payment === "paid");

  const unbilled = live.filter((s) => s.payment === "unpaid" && num(s.amount_due) > 0);
  const collectAll = useMutation({
    mutationFn: () => collectSessions(patientId, unbilled.map((s) => s.id)),
    onSuccess: (r) => { toast.success(`${r.billed} session${r.billed === 1 ? "" : "s"} sent to the cashier · ${birr(r.total)}`); onChanged(); },
    onError: (e) => toast.error(e instanceof AppError ? e.message : "Could not send to the cashier"),
  });

  if (shown.length === 0) return null; // filtered out entirely

  return (
    <div className={cn("rounded-lg border", due > 0.005 && "border-rose-300")}>
      <button type="button" onClick={() => setOpen((o) => !o)} className="flex w-full flex-wrap items-center gap-3 p-3 text-left hover:bg-accent/40">
        <ChevronDown className={cn("h-4 w-4 shrink-0 text-muted-foreground transition-transform", !open && "-rotate-90")} />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-semibold">{plan.title}</span>
            {allPaid ? <Badge variant="success"><CheckCircle2 className="mr-1 h-3 w-3" /> Settled</Badge>
              : due > 0.005 ? <Badge variant="destructive">Owes {birr(due)}</Badge>
              : <Badge variant="outline">In progress</Badge>}
          </div>
          <div className="mt-0.5 text-xs text-muted-foreground tabular-nums">
            {birr(plan.total_amount)} total · {birr(paid)} paid · {birr(total - paid)} left · {live.length} sessions
            {plan.deadline ? ` · ends ${plan.deadline}` : ""}
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
          <div className="divide-y">
            {shown.map((s) => (
              <SessionMoneyRow key={s.id} patientId={patientId} plan={plan} s={s}
                canCollect={canCollect} canReschedule={canReschedule}
                onReschedule={() => onReschedule(s)} onChanged={onChanged} />
            ))}
          </div>
          {canCollect && unbilled.length > 1 && (
            <div className="flex justify-end p-2">
              <Button size="sm" variant="outline" loading={collectAll.isPending} onClick={() => collectAll.mutate()}>
                <HandCoins className="h-3.5 w-3.5" /> Bill all {unbilled.length} unpaid · {birr(unbilled.reduce((a, s) => a + num(s.amount_due), 0))}
              </Button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function SessionMoneyRow({ patientId, plan, s, canCollect, canReschedule, onReschedule, onChanged }: {
  patientId: string; plan: Plan; s: Session; canCollect: boolean; canReschedule: boolean;
  onReschedule: () => void; onChanged: () => void;
}) {
  const state = moneyState(s);
  const badge = MONEY_BADGE[state];
  const collect = useMutation({
    mutationFn: () => collectSessions(patientId, [s.id]),
    onSuccess: () => { toast.success("Sent to the cashier"); onChanged(); },
    onError: (e) => toast.error(e instanceof AppError ? e.message : "Could not send to the cashier"),
  });
  const undo = useMutation({
    mutationFn: () => uncollectSession(patientId, s.id),
    onSuccess: () => { toast.success("Pulled back from the cashier"); onChanged(); },
    onError: (e) => toast.error(e instanceof AppError ? e.message : "Could not reverse"),
  });

  return (
    <div className="flex flex-wrap items-center gap-3 p-3">
      <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-muted text-xs font-semibold tabular-nums">{s.seq}</span>
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2 text-sm">
          <span className="font-medium tabular-nums">{s.scheduled_date}</span>
          <span className="text-xs text-muted-foreground">{formatEthiopian(s.scheduled_date)} EC</span>
          <span className="font-semibold tabular-nums">{birr(s.amount_due)}</span>
        </div>
        <div className="mt-1 flex flex-wrap items-center gap-2">
          <Badge variant={badge.variant}>{badge.label}</Badge>
          {s.status === "done" && <span className="text-xs text-muted-foreground">visit completed</span>}
          {s.pay_later && s.payment !== "paid" && <span className="text-xs font-medium text-rose-600">promised to pay later</span>}
          {s.status === "planned" && s.scheduled_date < todayISO() && (
            <span className="flex items-center gap-1 text-xs font-medium text-amber-600"><AlertTriangle className="h-3 w-3" /> missed</span>
          )}
        </div>
      </div>
      <div className="flex items-center gap-2">
        {canReschedule && s.status === "planned" && (
          <Button size="sm" variant="ghost" onClick={onReschedule} title={`Move session ${s.seq} of ${plan.title}`}>
            <CalendarClock className="h-3.5 w-3.5" /> Move
          </Button>
        )}
        {canCollect && state === "billed" && (
          <Button size="sm" variant="ghost" loading={undo.isPending} onClick={() => undo.mutate()} title="Pull back from the cashier">
            <Undo2 className="h-3.5 w-3.5" /> Undo
          </Button>
        )}
        {canCollect && s.payment === "unpaid" && num(s.amount_due) > 0 && (
          <Button size="sm" variant="outline" loading={collect.isPending} onClick={() => collect.mutate()}>
            <HandCoins className="h-3.5 w-3.5" /> Bill
          </Button>
        )}
      </div>
    </div>
  );
}

/** Pick exactly which sessions to bill — the patient decides how much to settle today. */
function CollectDialog({ patientId, rows, onClose, onDone }: { patientId: string; rows: Row[]; onClose: () => void; onDone: () => void }) {
  // Default to what's actually owed; prepaying future sessions is opt-in.
  const [picked, setPicked] = useState<string[]>(() => rows.filter((r) => moneyState(r.s) === "due").map((r) => r.s.id));
  const toggle = (id: string) => setPicked((p) => (p.includes(id) ? p.filter((x) => x !== id) : [...p, id]));
  const total = rows.filter((r) => picked.includes(r.s.id)).reduce((a, r) => a + num(r.s.amount_due), 0);

  const mut = useMutation({
    mutationFn: () => collectSessions(patientId, picked),
    onSuccess: (r) => { toast.success(`${r.billed} session${r.billed === 1 ? "" : "s"} sent to the cashier · ${birr(r.total)}`); onDone(); onClose(); },
    onError: (e) => toast.error(e instanceof AppError ? e.message : "Could not send to the cashier"),
  });

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-lg">
        <DialogHeader><DialogTitle>Take payment</DialogTitle></DialogHeader>
        <p className="text-sm text-muted-foreground">
          Tick what the patient is paying for. It goes to the cashier's queue — they collect the money and issue the receipt.
        </p>
        <div className="max-h-[45vh] space-y-1 overflow-y-auto rounded-md border p-1">
          {rows.map((r) => {
            const on = picked.includes(r.s.id);
            const st = moneyState(r.s);
            return (
              <button key={r.s.id} type="button" onClick={() => toggle(r.s.id)}
                className="flex w-full items-center gap-3 rounded-md px-2 py-2 text-left text-sm hover:bg-accent">
                <span className={cn("flex h-4 w-4 shrink-0 items-center justify-center rounded border", on ? "border-brand bg-brand text-brand-foreground" : "border-input")}>
                  {on && <CheckCircle2 className="h-3 w-3" />}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate">{r.plan.title} · session {r.s.seq}</span>
                  <span className="text-xs text-muted-foreground tabular-nums">{r.s.scheduled_date}</span>
                </span>
                {st === "due" && <Badge variant="destructive">Due</Badge>}
                <span className="w-24 text-right font-mono tabular-nums">{birr(r.s.amount_due)}</span>
              </button>
            );
          })}
        </div>
        <div className="flex items-center justify-between rounded-md bg-muted px-3 py-2 text-sm">
          <span className="font-medium">{picked.length} selected</span>
          <span className="font-mono text-base font-semibold tabular-nums">{birr(total)}</span>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>Cancel</Button>
          <Button disabled={picked.length === 0} loading={mut.isPending} onClick={() => mut.mutate()}>
            <Wallet className="h-4 w-4" /> Send to cashier
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** Move a planned session. The desk may change WHEN, never what the session is. */
function RescheduleDialog({ patientId, row, onClose, onDone }: { patientId: string; row: Row; onClose: () => void; onDone: () => void }) {
  const [date, setDate] = useState(row.s.scheduled_date);
  const mut = useMutation({
    mutationFn: () => rescheduleSession(patientId, row.s.id, date),
    onSuccess: () => { toast.success(`Moved to ${prettyDate(date)}`); onDone(); onClose(); },
    onError: (e) => toast.error(e instanceof AppError ? e.message : "Could not move this session"),
  });
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader><DialogTitle>Reschedule session {row.s.seq}</DialogTitle></DialogHeader>
        <p className="text-sm text-muted-foreground">
          {row.plan.title} · session {row.s.seq} of {row.plan.session_count} · currently {prettyDate(row.s.scheduled_date)}.
          Only the date changes; the treatment and its fee stay as the dentist set them.
        </p>
        <div className="space-y-1.5">
          <Label>New date</Label>
          <EthiopianDateInput value={date} onChange={setDate} showAge={false} />
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>Cancel</Button>
          <Button disabled={!date || date === row.s.scheduled_date} loading={mut.isPending} onClick={() => mut.mutate()}>
            <CalendarClock className="h-4 w-4" /> Move session
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
