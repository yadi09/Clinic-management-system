// The visit that is happening, at the top of the page.
//
// A dentist opening a patient mid-course needs three answers before they can do
// anything: where are we, what did I do last time, and what do I do now. The old
// page made all three a hunt — the running treatment was behind a date filter and
// two tabs, "session 4 of 6" appeared nowhere on the clinician's page at all, and
// the previous visit's notes were only reachable by expanding a row inside the plan
// that was itself filtered out.
//
// This answers all three above the fold, and — importantly — NAMES the rung it
// resolved to. A page that silently filters is unrecoverable when it guesses wrong;
// one that says "OVERDUE · was Thu 7 Aug · 5 days ago" can be argued with.
import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { CalendarClock, CheckCheck, ChevronRight, FileText, Plus } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { toast } from "@/components/ui/sonner";
import { AppError } from "@/lib/api-client";
import { EthiopianDateInput } from "@/components/EthiopianDateInput";
import { cn } from "@/lib/utils";
import { DualDate } from "@/components/DualDate";
import { MoveSessionDialog } from "@/features/dental/shared/MoveSessionDialog";
import { MONEY, birr, sessionMoneyState } from "@/features/dental/money";
import { addSession, finishCourse, type Plan } from "@/features/dental/api";
import { visitTiming, type FocusResult, type FocusVisit, type Rung } from "@/features/dental/visit/useFocusVisit";
import { RecordVisitForm, SettleFee } from "@/features/dental/visit/RecordVisitForm";
import { VisitActions } from "@/features/dental/visit/VisitActions";

/** How the resolution reads at the top of the cockpit. */
const RUNG_META: Record<Rung, { label: string; tone: string }> = {
  today: { label: "Today", tone: "bg-brand text-brand-foreground" },
  overdue: { label: "Overdue", tone: "bg-destructive text-destructive-foreground" },
  next: { label: "Next visit", tone: "bg-muted text-foreground" },
  chosen: { label: "Selected", tone: "bg-brand text-brand-foreground" },
  lastDone: { label: "Last visit", tone: "bg-muted text-foreground" },
  none: { label: "No treatment", tone: "bg-muted text-muted-foreground" },
};

export function VisitCockpit({
  patientId, resolved, teeth, editable, canCollect, canReschedule, imageLimit, onNewPlan, onPick, onChanged,
}: {
  patientId: string;
  resolved: FocusResult;
  teeth: Record<string, string>;
  editable: boolean;
  canCollect: boolean;
  canReschedule: boolean;
  imageLimit: number;
  /** Opens the create-plan dialog. Omit for read-only viewers. */
  onNewPlan?: () => void;
  /** Switch the cockpit to another visit; writes ?visit= so it survives a refresh. */
  onPick: (sessionId: string | null) => void;
  onChanged: () => void;
}) {
  const [recording, setRecording] = useState(false);
  const [moving, setMoving] = useState(false);
  const [adding, setAdding] = useState(false);
  const [finishing, setFinishing] = useState(false);
  const { focus, rung, others } = resolved;

  if (!focus) {
    return (
      <div className="rounded-lg border border-dashed p-6 text-center">
        <p className="text-sm font-medium">No treatment planned yet</p>
        <p className="mx-auto mt-1 max-w-md text-sm text-muted-foreground">
          Examine the patient, then create a treatment plan — its visits become the schedule shown here.
        </p>
        {editable && onNewPlan && (
          <Button className="mt-3" onClick={onNewPlan}><Plus className="h-4 w-4" /> New treatment plan</Button>
        )}
      </div>
    );
  }

  const { session, plan, seq, count } = focus;
  const meta = RUNG_META[rung];
  const timing = visitTiming(session.scheduled_date, todayISO());
  const money = MONEY[sessionMoneyState(session)];
  // Cancelled sessions are not part of the course the patient is being told about.
  const liveCount = plan.sessions.filter((s) => s.status !== "cancelled").length || count;

  return (
    <section className="rounded-lg border bg-card shadow-card">
      {/* band 1 — the resolution verdict. Never a silent filter. */}
      <header className="flex flex-wrap items-center gap-x-3 gap-y-2 border-b px-4 py-2.5">
        <span className={cn("rounded-md px-2 py-1 text-[11px] font-bold uppercase tracking-widest", meta.tone)}>
          {meta.label}
        </span>
        <DualDate iso={session.scheduled_date} long className="text-sm font-medium" />
        <span className={cn("text-xs", timing.days < 0 ? "font-medium text-destructive" : "text-muted-foreground")}>
          {timing.text}
        </span>
        <div className="ml-auto flex items-center gap-2">
          {editable && onNewPlan && (
            <Button size="sm" variant="outline" onClick={onNewPlan} title="Start another course of treatment">
              <Plus className="h-3.5 w-3.5" /> New plan
            </Button>
          )}
          {rung === "chosen" && (
            <Button size="sm" variant="ghost" onClick={() => onPick(null)} title="Go back to the visit this page would pick on its own">
              Clear selection
            </Button>
          )}
          {canReschedule && session.status === "planned" && (
            <Button size="sm" variant="outline" onClick={() => setMoving(true)}>
              <CalendarClock className="h-3.5 w-3.5" /> Move
            </Button>
          )}
        </div>
      </header>

      <div className="space-y-4 p-4">
        {/* band 2 — the work line */}
        <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
          <h3 className="text-lg font-semibold leading-tight">{plan.title}</h3>
          {plan.tooth && <Badge variant="outline">{plan.tooth}</Badge>}
          <span className="ml-auto text-sm text-muted-foreground">
            session <b className="text-foreground">{seq}</b> of {liveCount} · {birr(session.amount_due)}
          </span>
        </div>

        {/* band 3 — the course, at a glance. Hidden while recording: switching the
            focused visit under an open form would retarget the save to another
            session, filing the note and the fee against a visit that never happened. */}
        {!recording && (
          <CourseRail plan={plan} currentId={session.id} onPick={onPick} canEdit={editable}
            onAdd={() => setAdding(true)} />
        )}

        {editable && plan.status === "active" && !recording && (
          <div className="flex justify-end">
            <Button size="sm" variant="ghost" className="text-muted-foreground" onClick={() => setFinishing(true)}>
              <CheckCheck className="h-3.5 w-3.5" /> Finish course
            </Button>
          </div>
        )}

        {/* band 4/5 — read what happened last time, then record today */}
        {recording ? (
          <RecordVisitForm
            key={session.id}
            patientId={patientId}
            session={session}
            planTitle={plan.title}
            teeth={teeth}
            imageLimit={imageLimit}
            onSaved={() => { setRecording(false); onChanged(); }}
            onCancel={() => setRecording(false)}
          />
        ) : (
          <>
            {editable && (
              <SettleFee patientId={patientId} session={session} canCollect={canCollect} onSettled={onChanged} />
            )}
            {/* Repairs the deleted plan list used to offer: status, fee, date, undo a
                mistaken collect, record or clear a pay-later promise. */}
            <VisitActions patientId={patientId} session={session} canCollect={canCollect}
              editable={editable} onChanged={onChanged} />
            <VisitReader plan={plan} before={session} />
            <div className="flex flex-wrap items-center gap-3">
              {editable && session.status === "planned" && (
                <Button onClick={() => setRecording(true)}>
                  <FileText className="h-4 w-4" /> Record today's work
                </Button>
              )}
              {editable && session.status === "done" && (
                <Button variant="outline" onClick={() => setRecording(true)}>
                  <FileText className="h-4 w-4" /> Edit this visit
                </Button>
              )}
              <span className="text-sm">
                <span className="text-muted-foreground">Fee </span>
                <b className="tabular-nums">{birr(session.amount_due)}</b>
                <span className={cn("ml-2 rounded px-1.5 py-0.5 text-xs font-medium",
                  money.countsAsOwed ? "bg-destructive/10 text-destructive" : "bg-muted text-muted-foreground")}>
                  {money.label}
                </span>
              </span>
            </div>
          </>
        )}

        {/* Demoted candidates are named, never hidden — the resolver can be wrong.
            Hidden while recording for the same reason as the rail: switching the
            focused visit under an open note retargets where it is saved. */}
        {!recording && others.length > 0 && (
          <div className="space-y-1 border-t pt-3">
            <p className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">Also open</p>
            {others.slice(0, 4).map((o) => (
              <OtherVisit key={o.session.id} visit={o} onPick={onPick} />
            ))}
          </div>
        )}
      </div>

      {adding && (
        <AddSessionDialog
          patientId={patientId} planId={plan.id} planTitle={plan.title}
          suggestDate={nextFreeDate(plan)} suggestAmount={typicalFee(plan)}
          onClose={() => setAdding(false)} onAdded={onChanged}
        />
      )}
      {finishing && (
        <FinishCourseDialog
          patientId={patientId} plan={plan}
          onClose={() => setFinishing(false)} onDone={onChanged}
        />
      )}
      {moving && (
        <MoveSessionDialog
          patientId={patientId} sessionId={session.id} planTitle={plan.title}
          currentDate={session.scheduled_date} seq={seq} sessionCount={count}
          onClose={() => setMoving(false)} onMoved={onChanged}
        />
      )}
    </section>
  );
}

const todayISO = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};

/**
 * The course as a row of dots: what is done, what is being worked on, what is left.
 *
 * "Session 4 of 6" is the single most-asked question about a running treatment and
 * the clinician's page never showed it. Each dot is clickable, so switching to
 * another visit in the same course costs one click instead of a scroll and a hunt.
 */
function CourseRail({ plan, currentId, onPick, onAdd, canEdit }: {
  plan: Plan; currentId: string; onPick: (id: string) => void; onAdd?: () => void; canEdit: boolean;
}) {
  // Calendar order, so the rail and the plan list below tell the same story about
  // a course whose sessions have been rescheduled out of their original sequence.
  const live = [...plan.sessions]
    .filter((s) => s.status !== "cancelled")
    .sort((a, b) => a.scheduled_date.localeCompare(b.scheduled_date) || a.seq - b.seq);
  const paid = live.filter((s) => s.payment === "paid").reduce((n, s) => n + Number(s.amount_due || 0), 0);
  const unbilled = live.filter((s) => (s.status === "done" || s.pay_later) && s.payment !== "paid").length;

  return (
    <div className="space-y-1.5">
      <div className="flex flex-wrap items-center gap-1">
        {live.map((s) => {
          const current = s.id === currentId;
          const done = s.status === "done";
          return (
            <button
              key={s.id}
              type="button"
              onClick={() => onPick(s.id)}
              title={`Session ${s.seq} · ${s.scheduled_date} · ${birr(s.amount_due)}`}
              aria-current={current ? "step" : undefined}
              className={cn(
                "flex h-7 min-w-7 items-center justify-center rounded-full border px-2 text-xs font-semibold tabular-nums transition-colors",
                current ? "border-brand bg-brand text-brand-foreground"
                  : done ? "border-emerald-600/40 bg-emerald-600/15 text-emerald-700"
                    : "border-border bg-background text-muted-foreground hover:bg-muted",
              )}
            >
              {s.seq}
            </button>
          );
        })}
        {canEdit && onAdd && (
          <button type="button" onClick={onAdd} title="Add a visit to this course"
            className="flex h-7 items-center gap-1 rounded-full border border-dashed px-2 text-xs font-medium text-muted-foreground hover:bg-muted">
            <Plus className="h-3 w-3" /> visit
          </button>
        )}
      </div>
      <p className="text-xs text-muted-foreground tabular-nums">
        paid {birr(paid)} of {birr(plan.total_amount)}
        {unbilled > 0 && <span className="ml-2 font-medium text-amber-700">· {unbilled} unsettled</span>}
      </p>
    </div>
  );
}

/**
 * What happened last time, read-only.
 *
 * Deliberately not an editable field with a Save button next to it: the reading
 * surface and the writing surface were the same control on the old page, which is
 * how a clinician reviewing history ends up overwriting it.
 */
function VisitReader({ plan, before }: { plan: Plan; before: { id: string; scheduled_date: string } }) {
  // By DATE, not by seq. Rescheduling moves dates without renumbering, so seq 3 can
  // sit before seq 2 on the calendar — and "last time" must mean the visit that
  // actually happened last.
  const previous = plan.sessions
    .filter((s) => s.id !== before.id && s.status === "done" && s.scheduled_date <= before.scheduled_date)
    .sort((a, b) => b.scheduled_date.localeCompare(a.scheduled_date) || b.seq - a.seq)[0];

  if (!previous) {
    return (
      <p className="rounded-md border border-dashed px-3 py-2 text-sm text-muted-foreground">
        First visit of this course — nothing recorded yet.
      </p>
    );
  }
  const said = [previous.procedure, previous.tooth].filter(Boolean).join(" · ");
  return (
    <div className="rounded-md border bg-muted/40 px-3 py-2">
      <p className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
        Last time · session {previous.seq} · <DualDate iso={previous.scheduled_date} />
      </p>
      {said && <p className="mt-0.5 text-sm font-medium">{said}</p>}
      {previous.notes && <p className="mt-0.5 line-clamp-3 whitespace-pre-wrap text-sm">{previous.notes}</p>}
      {!said && !previous.notes && <p className="mt-0.5 text-sm text-muted-foreground">No note was recorded for that visit.</p>}
      {(previous.prescriptions.length > 0 || previous.images.length > 0) && (
        <p className="mt-1 text-xs text-muted-foreground">
          {previous.prescriptions.length > 0 && `${previous.prescriptions.length} prescription${previous.prescriptions.length > 1 ? "s" : ""}`}
          {previous.prescriptions.length > 0 && previous.images.length > 0 && " · "}
          {previous.images.length > 0 && `${previous.images.length} image${previous.images.length > 1 ? "s" : ""}`}
        </p>
      )}
    </div>
  );
}

function OtherVisit({ visit, onPick }: { visit: FocusVisit; onPick: (id: string) => void }) {
  const t = visitTiming(visit.session.scheduled_date, todayISO());
  return (
    <button
      type="button"
      onClick={() => onPick(visit.session.id)}
      className="flex w-full flex-wrap items-center gap-x-2 gap-y-0.5 rounded-md px-2 py-1.5 text-left text-sm hover:bg-muted"
    >
      <span className="font-medium">{visit.plan.title}</span>
      <span className="text-xs text-muted-foreground">
        session {visit.seq} of {visit.count} · <DualDate iso={visit.session.scheduled_date} />
      </span>
      <span className={cn("text-xs", t.days < 0 ? "font-medium text-destructive" : "text-muted-foreground")}>{t.text}</span>
      <ChevronRight className="ml-auto h-4 w-4 shrink-0 text-muted-foreground" />
    </button>
  );
}

/** The next sensible date for an extra visit: one interval after the last one. */
function nextFreeDate(plan: Plan): string {
  const live = plan.sessions.filter((s) => s.status !== "cancelled");
  const last = live.map((s) => s.scheduled_date).sort().pop() ?? todayISO();
  const d = new Date(`${last}T00:00:00`);
  const n = Math.max(1, plan.interval_count || 1);
  if (plan.interval_unit === "month") d.setMonth(d.getMonth() + n);
  else if (plan.interval_unit === "week") d.setDate(d.getDate() + 7 * n);
  else d.setDate(d.getDate() + n);
  const iso = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  return iso > todayISO() ? iso : todayISO();
}

/** What this course charges per visit, so the extra one is not typed from scratch. */
function typicalFee(plan: Plan): string {
  const live = plan.sessions.filter((s) => s.status !== "cancelled");
  if (live.length === 0) return "0";
  const counts = new Map<string, number>();
  for (const s of live) counts.set(s.amount_due, (counts.get(s.amount_due) ?? 0) + 1);
  return [...counts.entries()].sort((a, b) => b[1] - a[1])[0][0];
}

function AddSessionDialog({ patientId, planId, planTitle, suggestDate, suggestAmount, onClose, onAdded }: {
  patientId: string; planId: string; planTitle: string; suggestDate: string; suggestAmount: string;
  onClose: () => void; onAdded: () => void;
}) {
  const [date, setDate] = useState(suggestDate);
  const [amount, setAmount] = useState(suggestAmount);
  const add = useMutation({
    mutationFn: () => addSession(patientId, planId, { scheduled_date: date, amount_due: amount }),
    onSuccess: () => { toast.success("Visit added to the course"); onAdded(); onClose(); },
    onError: (e) => toast.error(e instanceof AppError ? e.message : "Could not add the visit"),
  });
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader><DialogTitle>Add a visit to {planTitle}</DialogTitle></DialogHeader>
        <p className="text-sm text-muted-foreground">
          Treatment does not always fit the plan. The course total and its visit count move with
          this, so “session 4 of 6” keeps describing something real.
        </p>
        <div className="space-y-1.5">
          <Label htmlFor="add-date">Date</Label>
          <EthiopianDateInput id="add-date" value={date} onChange={setDate} showAge={false} />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="add-amount">Fee (ETB)</Label>
          <Input id="add-amount" type="number" min={0} value={amount} onChange={(e) => setAmount(e.target.value)} />
          <p className="text-xs text-muted-foreground">Pre-filled with what this course usually charges per visit.</p>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>Cancel</Button>
          <Button loading={add.isPending} disabled={!date} onClick={() => add.mutate()}>Add visit</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function FinishCourseDialog({ patientId, plan, onClose, onDone }: {
  patientId: string; plan: Plan; onClose: () => void; onDone: () => void;
}) {
  // Enumerate the effect rather than describing it. "Some sessions will be
  // cancelled" is not something anyone can check before agreeing to it.
  const willCancel = plan.sessions.filter(
    (s) => s.status === "planned" && !s.pay_later && s.payment !== "billed" && s.payment !== "paid" && s.payment !== "waived",
  );
  const finish = useMutation({
    mutationFn: () => finishCourse(patientId, plan.id),
    onSuccess: (r) => {
      toast.success(r.sessions_cancelled > 0
        ? `Course finished — ${r.sessions_cancelled} unused visit${r.sessions_cancelled === 1 ? "" : "s"} cancelled`
        : "Course finished");
      onDone(); onClose();
    },
    onError: (e) => toast.error(e instanceof AppError ? e.message : "Could not finish the course"),
  });
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader><DialogTitle>Finish {plan.title}?</DialogTitle></DialogHeader>
        {willCancel.length > 0 ? (
          <div className="space-y-2">
            <p className="text-sm">These booked visits will be cancelled:</p>
            <ul className="space-y-1 rounded-md border bg-muted/40 p-2 text-sm">
              {willCancel.map((s) => (
                <li key={s.id} className="flex items-center justify-between gap-2">
                  <span>Session {s.seq} · <DualDate iso={s.scheduled_date} /></span>
                  <span className="tabular-nums text-muted-foreground">{birr(s.amount_due)}</span>
                </li>
              ))}
            </ul>
          </div>
        ) : (
          <p className="text-sm text-muted-foreground">Every visit in this course is already done.</p>
        )}
        <p className="text-xs text-muted-foreground">
          Nothing already collected changes, and any visit that was delivered or billed is left
          exactly as it is — finishing a course cannot hide money that is owed.
        </p>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>Cancel</Button>
          <Button loading={finish.isPending} onClick={() => finish.mutate()}>Finish course</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
