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
import { useEffect, useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { CalendarClock, ChevronRight, FileText, Image as ImageIcon, MoreHorizontal, Pill, Plus } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { toast } from "@/components/ui/sonner";
import { AppError } from "@/lib/api-client";
import { EthiopianDateInput } from "@/components/EthiopianDateInput";
import { cn } from "@/lib/utils";
import { DualDate } from "@/components/DualDate";
import { MoveSessionDialog } from "@/features/dental/shared/MoveSessionDialog";
import { ExtrasSection } from "@/features/dental/shared/Extras";
import { MONEY, birr, num, sessionMoneyState } from "@/features/dental/money";
import { addSession, finishCourse, type Plan } from "@/features/dental/api";
import { visitTiming, type FocusResult, type FocusVisit, type Rung } from "@/features/dental/visit/useFocusVisit";
import { RecordVisitForm } from "@/features/dental/visit/RecordVisitForm";
import { feeResolved, feeStage, FeeStrip, VisitPaymentStep } from "@/features/dental/visit/VisitPaymentStep";
import { DepositCallout } from "@/features/dental/shared/Deposit";
import { UnbilledCallout, coveredByCockpit, owedForPatient } from "@/features/dental/shared/UnbilledWork";
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
  patientId, resolved, plans, teeth, editable, canCollect, canReschedule, imageLimit, onNewPlan, onRecordingChange, onPick, onChanged,
}: {
  patientId: string;
  resolved: FocusResult;
  /** Every course, so debt on a course this cockpit is not showing is still visible. */
  plans: Plan[];
  teeth: Record<string, string>;
  editable: boolean;
  canCollect: boolean;
  canReschedule: boolean;
  imageLimit: number;
  /** Opens the create-plan dialog. Omit for read-only viewers. */
  onNewPlan?: () => void;
  /** Reports whether a visit note is open, so other surfaces can guard switching. */
  onRecordingChange?: (recording: boolean) => void;
  /** Switch the cockpit to another visit; writes ?visit= so it survives a refresh. */
  onPick: (sessionId: string | null) => void;
  onChanged: () => void;
}) {
  const [recording, setRecording] = useState(false);
  // Reopened payment panel for a fee that is already answered. Keyed off the stage
  // rather than a click count so that undoing a promise, or promising again, always
  // lands back on the default view for that stage.
  const [showFee, setShowFee] = useState(false);
  // The timeline lives outside this component and can also switch the focused visit,
  // so the guard cannot be local: the page needs to know a note is open.
  useEffect(() => { onRecordingChange?.(recording); }, [recording, onRecordingChange]);
  const [moving, setMoving] = useState(false);
  const [adding, setAdding] = useState(false);
  const [finishing, setFinishing] = useState(false);
  const [correcting, setCorrecting] = useState(false);
  const { focus, rung, others } = resolved;

  // An answered fee gets out of the way; the panel returns on request. Reset on any
  // change of stage so Undo (promised -> unpaid) reopens it and a fresh promise
  // (unpaid -> promised) collapses it again, without the reopen fighting either.
  //
  // ABOVE the early return on purpose. A hook below it runs on some renders and not
  // others, which is what blanked this page once already.
  const focusStage = focus ? feeStage(focus.session) : null;
  useEffect(() => { setShowFee(false); }, [focusStage, focus?.session.id]);

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
  // Cancelled sessions are not part of the course the patient is being told about.
  const liveCount = plan.sessions.filter((s) => s.status !== "cancelled").length || count;
  // Another course is worth naming only when it needs something now: overdue, or
  // delivered and unpaid. "Open" was true of every future visit the patient had.
  const needsAttention = others.filter((o) =>
    (o.session.status === "planned" && o.session.scheduled_date < todayISO()) ||
    MONEY[sessionMoneyState(o.session)].countsAsOwed);

  // ONE PANEL, THREE STATES.
  //
  // It used to render every part in every situation, which is why it read as a pile:
  // the money consequence of recording a visit sat ABOVE the button that records it,
  // "Record today's work" appeared on a visit eleven days away, and the fee was
  // printed three times in three vocabularies. Worst of all the settle band — the
  // largest, loudest element — rendered for visits that had not happened, telling the
  // clinician "Visit recorded" about a booking and offering to bill for it.
  //
  // A visit is only ever in one of three states, and each has exactly one thing you
  // would want to do:
  //
  //   upcoming   not happened yet   -> start it, or move it. No money question exists.
  //   recording  being written now  -> the form.
  //   recorded   it happened        -> read it back; settle the fee if it is unsettled.
  const stage = feeStage(session);
  const feeSettled = (stage === "paid" || stage === "promised") && !showFee;

  const state: "upcoming" | "recording" | "recorded" =
    recording ? "recording" : session.status === "done" ? "recorded" : "upcoming";
  const isToday = session.scheduled_date === todayISO();

  return (
    <section className="rounded-lg border bg-card shadow-card">
      {/* WHEN — the resolution verdict, never a silent filter. */}
      <header className="flex flex-wrap items-center gap-x-3 gap-y-2 border-b px-4 py-2.5">
        <span className={cn("rounded-md px-2 py-1 text-[11px] font-bold uppercase tracking-widest",
          state === "recorded" ? "bg-emerald-600 text-white" : meta.tone)}>
          {state === "recording" ? "Recording" : state === "recorded" ? "✓ Recorded" : meta.label}
        </span>
        <DualDate iso={session.scheduled_date} long className="text-sm font-medium" />
        <span className={cn("text-xs", timing.days < 0 ? "font-medium text-destructive" : "text-muted-foreground")}>
          {timing.text}
        </span>
        <div className="ml-auto flex items-center gap-2">
          {rung === "chosen" && (
            <Button size="sm" variant="ghost" onClick={() => onPick(null)}
              title="Go back to the visit this page would pick on its own">Clear selection</Button>
          )}
          {canReschedule && session.status === "planned" && state !== "recording" && (
            <Button size="sm" variant="outline" onClick={() => setMoving(true)}>
              <CalendarClock className="h-3.5 w-3.5" /> Move
            </Button>
          )}
          {/* Four rare actions in one menu. They used to take three separate rows of
              prime vertical space in the middle of the everyday path. */}
          {editable && state !== "recording" && (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button size="icon" variant="ghost" aria-label="More actions"><MoreHorizontal className="h-4 w-4" /></Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuItem onClick={() => setCorrecting((v) => !v)}>Correct this visit</DropdownMenuItem>
                <DropdownMenuItem onClick={() => setAdding(true)}>Add a visit to this course</DropdownMenuItem>
                {plan.status === "active" && (
                  <DropdownMenuItem onClick={() => setFinishing(true)}>Finish this course</DropdownMenuItem>
                )}
                {onNewPlan && <DropdownMenuItem onClick={onNewPlan}>New treatment plan</DropdownMenuItem>}
              </DropdownMenuContent>
            </DropdownMenu>
          )}
        </div>
      </header>

      <div className="space-y-4 p-4">
        {/* WHICH COURSE — title, tooth, position and this visit's fee, stated once. */}
        <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
          <h3 className="text-lg font-semibold leading-tight">{plan.title}</h3>
          {plan.tooth && <Badge variant="outline">{plan.tooth}</Badge>}
          {/* On a phone the right-pushed meta zig-zagged against the rail below;
              under sm it takes its own line, left-aligned beneath the title. */}
          <span className="ml-auto text-sm text-muted-foreground max-sm:ml-0 max-sm:w-full">
            visit <b className="text-foreground">{seq}</b> of {liveCount} · <b className="text-foreground tabular-nums">{birr(session.amount_due)}</b>
          </span>
        </div>

        {/* THE DOWN PAYMENT, if one is still owed. Shown in every state, including
            while a visit is being recorded: it is money due now, and a course that
            starts without it is a course given away. */}
        {editable && (
          <DepositCallout patientId={patientId} plan={plan} canCollect={canCollect}
            compact={state === "recording"} />
        )}

        {/* EVERYTHING ELSE THIS PATIENT OWES. The callout above is this course's own
            down payment; this is every other debt — treatment already given and never
            charged for, an extra that lives inside a visit and is invisible until that
            visit is opened, a second course's untaken deposit. Whatever the cockpit
            already shows (this visit's fee, its extras, its course's deposit) is
            excluded, so nothing is asked for twice. */}
        {editable && (
          <UnbilledCallout patientId={patientId} canCollect={canCollect} focusedPlanId={plan.id} onOpen={onPick}
            items={owedForPatient(plans, { exclude: coveredByCockpit(session, plan), withDeposit: true })}
            compact={state === "recording"} />
        )}

        {/* WHERE IN THE COURSE. Hidden while recording: switching the focused visit
            under an open form would retarget the save to another session. */}
        {state !== "recording" && (
          <CourseRail plan={plan} currentId={session.id} onPick={onPick} canEdit={editable}
            onAdd={() => setAdding(true)} onNewPlan={onNewPlan} />
        )}

        {state === "recording" && (
          <>
            {/* STEP 1 — the fee. Once it is answered (paid, or promised) it collapses
                to a strip and the chair gets the screen. A promise is still actionable,
                so the strip reopens the panel rather than hiding it for good. */}
            {feeSettled
              ? <FeeStrip session={session} planTitle={plan.title}
                  onReopen={feeStage(session) === "promised" ? () => setShowFee(true) : undefined} />
              : (
                <VisitPaymentStep patientId={patientId} plan={plan} session={session}
                  canCollect={canCollect} editable={editable} onChanged={onChanged} />
              )}

            {/* STEP 2 — the treatment. Not a lock: "Treat now, pay later" on the step
                above resolves the fee and opens this immediately. */}
            {feeResolved(session) ? (
              <RecordVisitForm
                key={session.id}
                patientId={patientId}
                session={session}
                planTitle={plan.title}
                teeth={teeth}
                imageLimit={imageLimit}
                onSaved={() => { setRecording(false); onChanged(); }}
                onChanged={onChanged}
                onCancel={() => setRecording(false)}
              />
            ) : (
              <div className="rounded-md border border-dashed p-4 text-sm text-muted-foreground">
                <p className="text-xs font-semibold uppercase tracking-wide">2 · Treatment</p>
                <p className="mt-1">
                  Tooth, procedure, notes, images and prescriptions open once the fee is settled —
                  or you choose to treat now and collect later.
                </p>
                <Button variant="outline" size="sm" className="mt-3" onClick={() => setRecording(false)}>
                  Cancel
                </Button>
              </div>
            )}
          </>
        )}

        {state === "upcoming" && (
          <>
            {/* Something can already have been done at a visit that has not been
                written up — an X-ray taken while the patient was in the chair. It was
                only rendered once the visit was recorded, so the fee for it was
                invisible on exactly the screen where it could be collected. */}
            {(session.extras?.length ?? 0) > 0 && (
              <ExtrasSection patientId={patientId} session={session} editable={editable}
                canCollect={canCollect} />
            )}
            {/* WHAT HAPPENED LAST — the question this panel exists to answer. */}
            <VisitReader plan={plan} before={session} onPick={onPick} />
            {editable && (
              <div className="flex flex-wrap items-center gap-3">
                <Button onClick={() => setRecording(true)}>
                  <FileText className="h-4 w-4" /> {isToday ? "Record today's work" : "Start this visit now"}
                </Button>
                {!isToday && (
                  <span className="text-xs text-muted-foreground">
                    Booked for <DualDate iso={session.scheduled_date} />. Recording it keeps that date.
                  </span>
                )}
              </div>
            )}
          </>
        )}

        {state === "recorded" && (
          <>
            {/* WHAT WAS DONE, read back. */}
            <RecordedSummary session={session} />
            {/* Anything added at the chair stays visible after the visit is written
                up — it is money the patient still owes, not a detail of the note. */}
            <ExtrasSection patientId={patientId} session={session} editable={editable}
              canCollect={canCollect} />
            {/* WHAT IT COSTS. The same pipeline as the recording step rather than a
                second, differently-worded amber panel — a fee looks the same here as
                it did five seconds ago. */}
            {editable && (feeSettled
              ? <FeeStrip session={session} planTitle={plan.title}
                  onReopen={feeStage(session) === "promised" ? () => setShowFee(true) : undefined} />
              : (
                <VisitPaymentStep patientId={patientId} plan={plan} session={session}
                  canCollect={canCollect} editable={editable} onChanged={onChanged} />
              ))}
            {editable && (
              <Button variant="outline" size="sm" onClick={() => setRecording(true)}>
                <FileText className="h-4 w-4" /> Edit this visit
              </Button>
            )}
          </>
        )}

        {/* Repairs, opened from the ⋯ menu rather than sitting in the reading path. */}
        {correcting && state !== "recording" && (
          <VisitActions patientId={patientId} session={session} canCollect={canCollect}
            editable={editable} onChanged={onChanged} />
        )}

        {/* Another course only earns a mention when it needs something TODAY. Listing
            every open visit made a table of contents out of a to-do list — and the
            timeline panel below already lists them all, in order. */}
        {state !== "recording" && needsAttention.length > 0 && (
          <div className="space-y-1 border-t pt-3">
            <p className="text-[11px] font-semibold uppercase tracking-wide text-amber-700">Also needs attention</p>
            {needsAttention.slice(0, 3).map((o) => (
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
function CourseRail({ plan, currentId, onPick, onAdd, onNewPlan, canEdit }: {
  plan: Plan; currentId: string; onPick: (id: string) => void;
  onAdd?: () => void; onNewPlan?: () => void; canEdit: boolean;
}) {
  // Calendar order, so the rail and the plan list below tell the same story about
  // a course whose sessions have been rescheduled out of their original sequence.
  const live = [...plan.sessions]
    .filter((s) => s.status !== "cancelled")
    .sort((a, b) => a.scheduled_date.localeCompare(b.scheduled_date) || a.seq - b.seq);
  // From the server's ledger figures, not by summing amount_due — that sums the
  // plan's INTENT and calls it money, misses the deposit and the extras entirely, and
  // does not move when a payment is refunded. It is also why this bar and the money
  // panel quoted two different course totals on the same patient.
  const paid = num(plan.money.collected);
  const billable = num(plan.money.planned);
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
                "touch-hit flex h-7 min-w-7 items-center justify-center rounded-full border px-2 text-xs font-semibold tabular-nums transition-colors",
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
            className="touch-hit flex h-7 items-center gap-1 rounded-full border border-dashed px-2 text-xs font-medium text-muted-foreground hover:bg-muted">
            <Plus className="h-3 w-3" /> visit
          </button>
        )}
        {/* Starting a different course of treatment was buried in the ⋯ menu, which
            is where you put things people already know exist. A patient arriving
            with a new problem is routine, so it sits on the rail — next to the
            course it is NOT part of, and worded so the difference is plain. */}
        {canEdit && onNewPlan && (
          <button type="button" onClick={onNewPlan}
            className="touch-hit ml-auto flex h-7 items-center gap-1 rounded-full border border-brand/40 bg-brand/5 px-2.5 text-xs font-semibold text-brand hover:bg-brand/10 max-sm:ml-0">
            <Plus className="h-3 w-3" /> New treatment
          </button>
        )}
      </div>
      {/* The course's money, as a bar. "paid 14,000 ETB of 18,000 ETB" in grey 12px
          was the only place this appeared above the fold, and it read as a caption
          rather than as the answer to "how far through is this patient". */}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <div className="h-1.5 w-full max-w-[14rem] overflow-hidden rounded-full bg-muted">
          <div className="h-full rounded-full bg-emerald-500 transition-all"
            style={{ width: `${Math.min(100, Math.round((paid / (billable || 1)) * 100))}%` }} />
        </div>
        <span className="text-xs tabular-nums">
          <b className="text-emerald-700">{birr(paid)}</b>
          {/* Counted against everything billable on this course, not the price agreed
              at the start: an X-ray taken at visit 3 is money this patient owes, and
              against total_amount alone a course could read "18,000 of 18,000, 100%"
              with 2,000 of extras still unpaid. Matches the money panel exactly. */}
          <span className="text-muted-foreground"> paid of {birr(billable)}</span>
        </span>
        {unbilled > 0 && (
          <span className="rounded-full bg-amber-100 px-2 py-0.5 text-[11px] font-semibold text-amber-800">
            {unbilled} unsettled
          </span>
        )}
      </div>
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
/** What was recorded, read back. Short on purpose: the timeline holds the history. */
function RecordedSummary({ session }: { session: { procedure?: string; tooth?: string; notes?: string } }) {
  const said = [session.procedure, session.tooth].filter(Boolean).join(" · ");
  if (!said && !session.notes) {
    return <p className="text-sm text-muted-foreground">Marked done with no clinical note.</p>;
  }
  return (
    <div className="space-y-0.5">
      {said && <p className="text-sm font-medium">{said}</p>}
      {session.notes && <p className="whitespace-pre-wrap text-sm text-muted-foreground">{session.notes}</p>}
    </div>
  );
}

function VisitReader({ plan, before, onPick }: {
  plan: Plan; before: { id: string; scheduled_date: string }; onPick: (id: string) => void;
}) {
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
  const stage = feeStage(previous);
  const money = {
    paid: { label: "Paid", cls: "bg-emerald-100 text-emerald-800" },
    atCashier: { label: "At cashier", cls: "bg-amber-100 text-amber-800" },
    promised: { label: "Owed", cls: "bg-amber-100 text-amber-900" },
    unpaid: { label: "Owed", cls: "bg-destructive/10 text-destructive" },
  }[stage];

  // A button, not a panel. It is the record of a visit that happened, and the thing
  // a dentist wants after reading two lines of it is the rest of it — which used to
  // mean hunting the same visit down in the timeline below.
  return (
    <button
      type="button"
      onClick={() => onPick(previous.id)}
      className="group w-full rounded-lg border bg-card p-3 text-left shadow-sm transition-colors hover:border-brand/50 hover:bg-accent/40"
    >
      <div className="flex flex-wrap items-center gap-2">
        <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-emerald-600/15 text-[11px] font-bold text-emerald-700">
          {previous.seq}
        </span>
        <span className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
          Last visit
        </span>
        <span className="text-xs font-medium"><DualDate iso={previous.scheduled_date} /></span>
        <span className={cn("rounded-full px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide", money.cls)}>
          {money.label} {birr(previous.amount_due)}
        </span>
        <span className="ml-auto flex items-center gap-1 text-xs font-medium text-muted-foreground group-hover:text-brand">
          Open <ChevronRight className="h-3.5 w-3.5" />
        </span>
      </div>

      {said && <p className="mt-2 text-sm font-semibold">{said}</p>}
      {previous.notes && <p className="mt-1 line-clamp-3 whitespace-pre-wrap text-sm text-muted-foreground">{previous.notes}</p>}
      {!said && !previous.notes && <p className="mt-2 text-sm italic text-muted-foreground">No clinical note was written for that visit.</p>}

      {(previous.prescriptions.length > 0 || previous.images.length > 0) && (
        <div className="mt-2 flex flex-wrap gap-1.5">
          {previous.prescriptions.length > 0 && (
            <span className="inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] text-muted-foreground">
              <Pill className="h-3 w-3" /> {previous.prescriptions.length} prescription{previous.prescriptions.length > 1 ? "s" : ""}
            </span>
          )}
          {previous.images.length > 0 && (
            <span className="inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] text-muted-foreground">
              <ImageIcon className="h-3 w-3" /> {previous.images.length} image{previous.images.length > 1 ? "s" : ""}
            </span>
          )}
        </div>
      )}
    </button>
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
