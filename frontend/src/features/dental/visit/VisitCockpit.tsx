// The visit card, at the top of a dental patient's page.
//
// It answers, in this order and in plain words: which treatment, what is happening
// with it, what was done last time, and what to do now. Every visit carries a word
// (done, missed, today, next, later) and its money (paid, paid ahead, owed...), so a
// colour never has to be decoded. Treatment progress and money are two separate
// lines, because "1 of 5 visits done" and "89% paid" are different fractions and
// showing them as one bar is how they get mistaken for each other.
//
// Which visit the card is about is decided by resolveFocus (useFocusVisit.ts) and
// always stated; every treatment in progress is a tab, so the choice is visible.
import { useEffect, useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { AlertTriangle, CalendarClock, Check, FileText, Image as ImageIcon, MoreHorizontal, Pill, Plus } from "lucide-react";

import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Segmented } from "@/components/ui/segmented";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { toast } from "@/components/ui/sonner";
import { AppError } from "@/lib/api-client";
import { EthiopianDateInput } from "@/components/EthiopianDateInput";
import { cn } from "@/lib/utils";
import { DualDate } from "@/components/DualDate";
import { MoveSessionDialog } from "@/features/dental/shared/MoveSessionDialog";
import { ExtrasSection } from "@/features/dental/shared/Extras";
import { birr, num } from "@/features/dental/money";
import { addSession, cancelCourse, finishCourse, type Plan, type Session } from "@/features/dental/api";
import type { Allergy } from "@/features/patients/api";
import { visitTiming, type FocusResult, type Treatment } from "@/features/dental/visit/useFocusVisit";
import {
  joinNumbers, liveVisits, missedVisits, nextStep, paidAhead, payWord, planMoney, visitPosition, visitWord,
  type PayTone, type VisitWord,
} from "@/features/dental/visit/treatment";
import { RecordVisitForm } from "@/features/dental/visit/RecordVisitForm";
import { feeResolved, feeStage, FeeStrip, VisitPaymentStep } from "@/features/dental/visit/VisitPaymentStep";
import { DepositCallout } from "@/features/dental/shared/Deposit";
import { UnbilledCallout, coveredByCockpit, owedForPatient } from "@/features/dental/shared/UnbilledWork";
import { VisitActions } from "@/features/dental/visit/VisitActions";

const todayISO = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};

/** "7 Sep": the short form used under each visit. The sentence above gives the
 *  full date in both calendars once; repeating it under every visit was noise. */
const shortDate = (iso: string) =>
  new Date(`${iso}T00:00:00`).toLocaleDateString(undefined, { day: "numeric", month: "short" });

const WORD_TONE: Record<VisitWord, { circle: string; word: string }> = {
  Done: { circle: "border-primary bg-primary text-primary-foreground", word: "text-primary" },
  Missed: { circle: "border-destructive bg-destructive/10 text-destructive", word: "text-destructive" },
  Today: { circle: "border-primary bg-card text-primary", word: "text-primary" },
  Next: { circle: "border-brand bg-card text-brand", word: "text-brand" },
  Later: { circle: "border-border bg-card text-muted-foreground", word: "text-muted-foreground" },
};
const PAY_TONE: Record<PayTone, string> = {
  good: "text-primary",
  wait: "text-amber-700",
  owed: "font-semibold text-destructive",
  plain: "text-muted-foreground",
};

export function VisitCockpit({
  patientId, resolved, plans, teeth, editable, canCollect, canReschedule, imageLimit, allergies = [],
  onNewPlan, onRecordingChange, onPick, onChanged,
}: {
  patientId: string;
  resolved: FocusResult;
  /** Every treatment, so debt on one the card is not showing is still visible. */
  plans: Plan[];
  teeth: Record<string, string>;
  editable: boolean;
  canCollect: boolean;
  canReschedule: boolean;
  imageLimit: number;
  /** The patient's allergies, shown inside the card, above the button you treat with. */
  allergies?: Allergy[];
  /** Opens the create-treatment dialog. Omit for read-only viewers. */
  onNewPlan?: () => void;
  /** Reports whether a visit note is open, so other surfaces can guard switching. */
  onRecordingChange?: (recording: boolean) => void;
  /** Switch the card to another visit; writes ?visit= so it survives a refresh. */
  onPick: (sessionId: string | null) => void;
  onChanged: () => void;
}) {
  const [recording, setRecording] = useState(false);
  // Reopened payment panel for a fee that is already answered. Keyed off the stage so
  // that undoing a promise, or promising again, lands on the default view for it.
  const [showFee, setShowFee] = useState(false);
  useEffect(() => { onRecordingChange?.(recording); }, [recording, onRecordingChange]);
  const [moving, setMoving] = useState(false);
  const [adding, setAdding] = useState(false);
  const [finishing, setFinishing] = useState(false);
  const [cancellingCourse, setCancellingCourse] = useState(false);
  const [correcting, setCorrecting] = useState(false);
  // The day the visit is recorded as. Today unless changed: a missed visit done today
  // happened today, and the record should say so.
  const [recordDate, setRecordDate] = useState(todayISO);
  const [changingDate, setChangingDate] = useState(false);
  const { focus, rung, treatments } = resolved;

  // ABOVE the early return on purpose. A hook below it runs on some renders and not
  // others, which is what blanked this page once already.
  const focusStage = focus ? feeStage(focus.session) : null;
  useEffect(() => { setShowFee(false); }, [focusStage, focus?.session.id]);
  useEffect(() => { setRecordDate(todayISO()); setChangingDate(false); }, [focus?.session.id]);

  if (!focus) {
    return (
      <section className="rounded-xl border bg-card px-6 py-10 text-center shadow-card">
        <p className="text-lg font-semibold">No treatment in progress</p>
        <p className="mx-auto mt-1 max-w-md text-sm text-muted-foreground">
          Examine the patient, then start a treatment. Its visits become the schedule shown here.
        </p>
        {editable && onNewPlan && (
          <Button className="mt-4" onClick={onNewPlan}><Plus className="h-4 w-4" /> Start a treatment</Button>
        )}
      </section>
    );
  }

  const { session, plan, position, count } = focus;
  const today = todayISO();
  const word = visitWord(plan, session, today);
  const missed = missedVisits(plan, today);
  const otherMissed = missed.filter((s) => s.id !== session.id).map((s) => ({ s, n: visitPosition(plan, s.id).position }));
  const timing = visitTiming(session.scheduled_date, today);
  const stage = feeStage(session);
  const feeSettled = (stage === "paid" || stage === "promised") && !showFee;
  const state: "upcoming" | "recording" | "recorded" =
    recording ? "recording" : session.status === "done" ? "recorded" : "upcoming";
  const label = `visit ${position}`;
  const upcomingNext = state === "recorded" ? nextStep(plan) : undefined;
  // Where this treatment stands now: its next step, or for a finished one its last visit.
  const treatmentNow = nextStep(plan) ?? liveVisits(plan).filter((s) => s.status === "done").pop();
  const futureDate = recordDate > today;

  // The tabs: every treatment in progress, plus the one on screen if it is finished
  // (a chosen old visit), so the card always names what it is showing.
  const tabs: Treatment[] = treatments.some((t) => t.plan.id === plan.id)
    ? treatments
    : [...treatments, { plan, next: nextStep(plan), missed, bookedToday: false }];
  const openTreatment = (planId: string) => {
    const t = tabs.find((x) => x.plan.id === planId);
    if (!t || t.plan.id === plan.id) return;
    const live = liveVisits(t.plan);
    const target = t.next ?? [...live].reverse().find((s) => s.status === "done") ?? live[0];
    if (target) onPick(target.id);
  };

  return (
    <section className="overflow-hidden rounded-xl border bg-card shadow-card">
      <TreatmentBar tabs={tabs} current={plan} today={today} onOpen={openTreatment}
        onNewPlan={editable ? onNewPlan : undefined} />

      <div className="space-y-4 p-4 sm:p-5">
        {allergies.length > 0 && <AllergyLine allergies={allergies} />}

        {/* WHAT IS HAPPENING, in one sentence. */}
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0 flex-1">
            <StateChip state={state} word={word} missedCount={missed.length} position={position} />
            <h3 className="mt-2 text-xl font-bold leading-tight tracking-tight sm:text-[22px]">
              {state === "recorded" ? `Visit ${position} of ${count} is done`
                : word === "Missed" ? `Next: visit ${position} of ${count}`
                  : word === "Today" ? `Visit ${position} of ${count}`
                    : `Visit ${position} of ${count} · ${timing.text}`}
            </h3>
            <p className="mt-1 text-sm text-muted-foreground sm:text-[15px]">
              {state === "recording" ? (
                <>Being recorded now. It will be saved as <b className="text-foreground"><DualDate iso={recordDate} long /></b>.</>
              ) : state === "recorded" ? (
                <>
                  Done on <b className="text-foreground"><DualDate iso={session.scheduled_date} long /></b>.
                  {upcomingNext && <> Next: visit {visitPosition(plan, upcomingNext.id).position} on {shortDate(upcomingNext.scheduled_date)}.</>}
                </>
              ) : word === "Missed" ? (
                <>
                  It was booked for <b className="text-foreground"><DualDate iso={session.scheduled_date} long /></b> and
                  didn't happen, <span className="font-semibold text-destructive">{timing.text}</span>.
                  {otherMissed.length > 0 && (
                    <> {otherMissed.length === 1
                      ? `Visit ${otherMissed[0].n} on ${shortDate(otherMissed[0].s.scheduled_date)} was missed too.`
                      : `Visits ${joinNumbers(otherMissed.map((o) => o.n))} were missed too.`}</>
                  )}
                </>
              ) : word === "Today" ? (
                <>Booked for <b className="text-foreground">today, <DualDate iso={session.scheduled_date} long /></b>.</>
              ) : (
                <>Booked for <b className="text-foreground"><DualDate iso={session.scheduled_date} long /></b>.</>
              )}
            </p>
            {rung === "chosen" && session.id !== treatmentNow?.id && (
              // "Current" within the treatment on screen: picking a tab is a choice of
              // treatment, and going back must not jump to a different one.
              <button type="button" onClick={() => onPick(treatmentNow?.id ?? null)}
                className="mt-1 text-sm font-medium text-primary hover:underline">
                Back to the current visit
              </button>
            )}
          </div>

          {state !== "recording" && (
            <div className="flex shrink-0 items-center gap-2 max-sm:w-full">
              {canReschedule && session.status === "planned" && (
                <Button variant="outline" className="max-sm:flex-1" onClick={() => setMoving(true)}>
                  <CalendarClock className="h-4 w-4" /> {word === "Missed" ? `Rebook ${label}` : "Reschedule"}
                </Button>
              )}
              {editable && (
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button variant="ghost" size="icon" aria-label="More actions"><MoreHorizontal className="h-4 w-4" /></Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end">
                    <DropdownMenuItem onClick={() => setCorrecting((v) => !v)}>Correct this visit</DropdownMenuItem>
                    <DropdownMenuItem onClick={() => setAdding(true)}>Add a visit to this treatment</DropdownMenuItem>
                    {plan.status === "active" && (
                      <DropdownMenuItem onClick={() => setFinishing(true)}>Finish this treatment</DropdownMenuItem>
                    )}
                    {plan.status !== "cancelled" && (
                      <DropdownMenuItem className="text-destructive" onClick={() => setCancellingCourse(true)}>
                        Cancel this treatment…
                      </DropdownMenuItem>
                    )}
                  </DropdownMenuContent>
                </DropdownMenu>
              )}
            </div>
          )}
        </div>

        {/* EVERY VISIT, with a word, a date and its money. Hidden while recording:
            switching visits under an open form would retarget the save. */}
        {state !== "recording" && <VisitSteps plan={plan} currentId={session.id} today={today} onPick={onPick} />}
        {state !== "recording" && <Facts plan={plan} />}

        {/* Money owed right now, outside this visit: the treatment's own unpaid down
            payment, and anything else given and never charged for. Unchanged. */}
        {editable && (
          <DepositCallout patientId={patientId} plan={plan} canCollect={canCollect}
            compact={state === "recording"} />
        )}
        {editable && (
          <UnbilledCallout patientId={patientId} canCollect={canCollect} focusedPlanId={plan.id} onOpen={onPick}
            items={owedForPatient(plans, { exclude: coveredByCockpit(session, plan), withDeposit: true })}
            compact={state === "recording"} />
        )}

        {state === "recording" && (
          <>
            {/* STEP 1, the fee, then STEP 2, the treatment. Unchanged. */}
            {feeSettled
              ? <FeeStrip session={session} planTitle={plan.title}
                  onReopen={feeStage(session) === "promised" ? () => setShowFee(true) : undefined} />
              : (
                <VisitPaymentStep patientId={patientId} plan={plan} session={session}
                  canCollect={canCollect} editable={editable} onChanged={onChanged} />
              )}
            {feeResolved(session) ? (
              <RecordVisitForm
                key={session.id}
                patientId={patientId}
                session={session}
                planTitle={plan.title}
                visitLabel={label}
                recordDate={recordDate}
                teeth={teeth}
                imageLimit={imageLimit}
                canCollect={canCollect}
                onSaved={() => { setRecording(false); onChanged(); }}
                onChanged={onChanged}
                onCancel={() => setRecording(false)}
              />
            ) : (
              <div className="rounded-md border border-dashed p-4 text-sm text-muted-foreground">
                <p className="text-sm font-semibold text-foreground">Then the treatment notes</p>
                <p className="mt-1">
                  Tooth, procedure, notes, images and prescriptions open once the fee is settled,
                  or once you choose to treat now and collect later.
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
            {/* Something done at a visit not yet written up, an X-ray taken in the
                chair, is money that can be collected right here. */}
            {(session.extras?.length ?? 0) > 0 && (
              <ExtrasSection patientId={patientId} session={session} editable={editable}
                canCollect={canCollect} />
            )}
            <LastTime plan={plan} before={session} onPick={onPick} />
            {editable && (
              <div className="space-y-3 border-t pt-4">
                <div className="flex flex-wrap items-center gap-3 max-sm:flex-col max-sm:items-stretch">
                  <Button size="lg" variant={word === "Next" || word === "Later" ? "outline" : "default"}
                    disabled={futureDate} onClick={() => setRecording(true)}>
                    <FileText className="h-4 w-4" />
                    {word === "Today" ? `Start ${label}` : word === "Missed" ? `Record ${label}` : `Record ${label} early`}
                  </Button>
                  <p className="text-sm text-muted-foreground max-sm:text-center">
                    {word === "Next" || word === "Later" ? "Only if the patient came in before their booked day. " : ""}
                    {word === "Today" ? (
                      stage === "unpaid" ? `Takes the ${birr(session.amount_due)} fee first, then the treatment notes.`
                        : "Opens the treatment notes."
                    ) : (
                      <>
                        Saved as <b className="text-foreground">{recordDate === today ? "today" : shortDate(recordDate)}</b>
                        {recordDate === today ? `, ${shortDate(today)}` : ""}.{" "}
                        <button type="button" onClick={() => setChangingDate((v) => !v)}
                          className="font-medium text-primary hover:underline">
                          {changingDate ? "Done" : "Change date"}
                        </button>
                      </>
                    )}
                  </p>
                </div>
                {changingDate && word !== "Today" && (
                  <div className="rounded-lg border bg-muted/40 p-3">
                    <p className="text-sm font-medium">Which day did this visit happen?</p>
                    <div className="mt-2 flex flex-wrap gap-2">
                      <Button size="sm" variant={recordDate === today ? "secondary" : "outline"}
                        onClick={() => setRecordDate(today)}>Today</Button>
                      {session.scheduled_date <= today && (
                        <Button size="sm" variant={recordDate === session.scheduled_date ? "secondary" : "outline"}
                          onClick={() => setRecordDate(session.scheduled_date)}>
                          Its booked day, {shortDate(session.scheduled_date)}
                        </Button>
                      )}
                    </div>
                    <div className="mt-3 max-w-sm space-y-1.5">
                      <Label htmlFor="record-date" className="text-xs">Or another day</Label>
                      <EthiopianDateInput key={recordDate} id="record-date" value={recordDate}
                        onChange={(v) => v && setRecordDate(v)} showAge={false} />
                    </div>
                    {futureDate && (
                      <p className="mt-2 text-sm font-medium text-destructive">A visit can't be recorded on a day that hasn't come yet.</p>
                    )}
                  </div>
                )}
              </div>
            )}
          </>
        )}

        {state === "recorded" && (
          <>
            <RecordedSummary session={session} />
            {/* Anything added at the chair stays visible: it is money the patient still owes. */}
            <ExtrasSection patientId={patientId} session={session} editable={editable}
              canCollect={canCollect} />
            {/* WHAT IT COSTS, through the same pipeline as the recording step. */}
            {editable && (feeSettled
              ? <FeeStrip session={session} planTitle={plan.title}
                  onReopen={feeStage(session) === "promised" ? () => setShowFee(true) : undefined} />
              : (
                <VisitPaymentStep patientId={patientId} plan={plan} session={session}
                  canCollect={canCollect} editable={editable} onChanged={onChanged} />
              ))}
            {editable && (
              <Button variant="outline" size="sm" onClick={() => setRecording(true)}>
                <FileText className="h-4 w-4" /> Edit {label}
              </Button>
            )}
          </>
        )}

        {/* Repairs, opened from the More menu rather than sitting in the reading path. */}
        {correcting && state !== "recording" && (
          <VisitActions patientId={patientId} session={session} canCollect={canCollect}
            editable={editable} onChanged={onChanged} />
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
      {cancellingCourse && (
        <CancelCourseDialog
          patientId={patientId} plan={plan}
          onClose={() => setCancellingCourse(false)} onDone={onChanged}
        />
      )}
      {moving && (
        <MoveSessionDialog
          patientId={patientId} sessionId={session.id} planTitle={plan.title}
          currentDate={session.scheduled_date} detail={`Visit ${position} of ${count}`}
          missed={word === "Missed"}
          onClose={() => setMoving(false)} onMoved={onChanged}
        />
      )}
    </section>
  );
}

/** "Root canal UR5, UR2 · since 24 Aug". The teeth and start date are what tell two
 *  treatments with the same name apart. */
function TreatmentName({ plan, compact }: { plan: Plan; compact?: boolean }) {
  return (
    <span className="inline-flex items-center gap-1.5">
      <b className="font-semibold text-foreground">{plan.title}</b>
      {plan.tooth && <span>{plan.tooth}</span>}
      <span className={cn("text-muted-foreground", compact && "max-sm:hidden")}>· since {shortDate(plan.start_date)}</span>
      {plan.status !== "active" && <span className="text-muted-foreground">({plan.status === "completed" ? "finished" : "cancelled"})</span>}
    </span>
  );
}

function TreatmentBar({ tabs, current, today, onOpen, onNewPlan }: {
  tabs: Treatment[]; current: Plan; today: string; onOpen: (planId: string) => void; onNewPlan?: () => void;
}) {
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-2 border-b bg-muted/30 px-4 py-2.5 sm:px-5">
      {tabs.length > 1 ? (
        // On a phone the tabs get the whole width and the button moves up beside the
        // count; sharing a row, only one tab's name fitted.
        <div className="min-w-0 max-w-full flex-1 space-y-1 max-sm:order-last max-sm:basis-full">
          <p className="text-xs text-muted-foreground max-sm:hidden">{tabs.length} treatments in progress</p>
          <Segmented
            ariaLabel="Treatments in progress"
            value={current.id}
            onChange={onOpen}
            className="sm:max-w-full sm:overflow-x-auto"
            options={tabs.map((t) => {
              const late = missedVisits(t.plan, today).length > 0;
              return {
                value: t.plan.id,
                label: (
                  <span className="inline-flex items-center gap-1.5">
                    {(late || t.bookedToday) && (
                      <span aria-hidden className={cn("h-2 w-2 rounded-full", late ? "bg-destructive" : "bg-primary")} />
                    )}
                    <TreatmentName plan={t.plan} compact />
                    {late && <span className="sr-only">(has a missed visit)</span>}
                  </span>
                ),
              };
            })}
          />
        </div>
      ) : (
        <p className="min-w-0 flex-1 text-sm"><TreatmentName plan={current} /></p>
      )}
      {tabs.length > 1 && (
        <p className="flex-1 text-xs text-muted-foreground sm:hidden">{tabs.length} treatments in progress</p>
      )}
      {onNewPlan && (
        <Button variant="outline" size="sm" className="shrink-0" onClick={onNewPlan}>
          <Plus className="h-3.5 w-3.5" /> New treatment
        </Button>
      )}
    </div>
  );
}

function AllergyLine({ allergies }: { allergies: Allergy[] }) {
  const names = allergies.map((a) => a.substance);
  const list = names.length <= 1 ? names.join("") : `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
  return (
    <div role="note" className="flex items-center gap-2.5 rounded-lg bg-destructive/10 px-3 py-2 text-sm font-medium text-destructive">
      <AlertTriangle className="h-4 w-4 shrink-0" />
      <span>Allergic to {list}. Check before you treat.</span>
    </div>
  );
}

function StateChip({ state, word, missedCount, position }: {
  state: "upcoming" | "recording" | "recorded"; word: VisitWord; missedCount: number; position: number;
}) {
  const [text, cls] =
    state === "recording" ? [`Recording visit ${position}`, "bg-brand/10 text-brand"]
      : state === "recorded" ? ["Done", "bg-primary/10 text-primary"]
        : word === "Missed" ? [missedCount === 1 ? "1 visit missed" : `${missedCount} visits missed`, "bg-destructive/10 text-destructive"]
          : word === "Today" ? ["Today", "bg-primary/10 text-primary"]
            : word === "Next" ? ["Next visit", "bg-muted text-brand"]
              : ["Later visit", "bg-muted text-muted-foreground"];
  return (
    <span className={cn("inline-flex items-center gap-1 rounded-full px-2.5 py-0.5 text-[13px] font-semibold", cls)}>
      {state === "recorded" && <Check className="h-3.5 w-3.5" />}{text}
    </span>
  );
}

/** Every visit of the treatment. A row of steps from sm up; a list on a phone,
 *  where five steps side by side would squeeze their words to nothing. */
function VisitSteps({ plan, currentId, today, onPick }: {
  plan: Plan; currentId: string; today: string; onPick: (id: string) => void;
}) {
  const live = liveVisits(plan);
  const steps = live.map((s, i) => ({ s, n: i + 1, word: visitWord(plan, s, today), pay: payWord(s), current: s.id === currentId }));
  const describe = (x: (typeof steps)[number]) =>
    `Visit ${x.n}, ${x.word.toLowerCase()}, ${shortDate(x.s.scheduled_date)}, ${x.pay.label.toLowerCase()}`;
  return (
    <>
      <ol aria-label="Visits in this treatment" className="hidden sm:flex">
        {steps.map((x, i) => {
          const tone = WORD_TONE[x.word];
          return (
            <li key={x.s.id} className="relative min-w-0 flex-1">
              {i > 0 && (
                <span aria-hidden className={cn("absolute right-1/2 top-4 h-0.5 w-full -translate-y-1/2",
                  x.word === "Done" ? "bg-primary" : "bg-border")} />
              )}
              <button type="button" onClick={() => onPick(x.s.id)} aria-current={x.current ? "step" : undefined}
                aria-label={describe(x)} title={`${birr(x.s.amount_due)}`}
                className="group relative flex w-full flex-col items-center rounded-lg px-1 py-1 text-center focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
                <span className={cn("relative z-10 flex h-8 w-8 items-center justify-center rounded-full border-2 text-sm font-bold transition-shadow",
                  tone.circle, x.current && "ring-4 ring-brand/15", "group-hover:ring-4 group-hover:ring-muted")}>
                  {x.word === "Done" ? <Check className="h-4 w-4" /> : x.n}
                </span>
                <span className={cn("mt-1.5 text-[13px] font-semibold", tone.word, x.current && "underline decoration-2 underline-offset-4")}>{x.word}</span>
                <span className="text-xs text-muted-foreground">{shortDate(x.s.scheduled_date)}</span>
                <span className={cn("text-[11.5px]", PAY_TONE[x.pay.tone])}>{x.pay.label}</span>
              </button>
            </li>
          );
        })}
      </ol>
      <ol aria-label="Visits in this treatment" className="divide-y overflow-hidden rounded-xl border sm:hidden">
        {steps.map((x) => {
          const tone = WORD_TONE[x.word];
          return (
            <li key={x.s.id}>
              <button type="button" onClick={() => onPick(x.s.id)} aria-current={x.current ? "step" : undefined}
                aria-label={describe(x)}
                className={cn("flex w-full items-center gap-3 px-3 py-2.5 text-left", x.current && "bg-muted/60")}>
                <span className={cn("flex h-7 w-7 shrink-0 items-center justify-center rounded-full border-2 text-xs font-bold", tone.circle)}>
                  {x.word === "Done" ? <Check className="h-3.5 w-3.5" /> : x.n}
                </span>
                <span className="min-w-0 flex-1 text-sm">
                  <span className={cn("font-semibold", tone.word)}>{x.word}</span>{" "}
                  <span className="text-muted-foreground">{shortDate(x.s.scheduled_date)}</span>
                </span>
                <span className={cn("shrink-0 text-xs", PAY_TONE[x.pay.tone])}>{x.pay.label}</span>
              </button>
            </li>
          );
        })}
      </ol>
    </>
  );
}

/** Treatment and money, as two separate lines. */
function Facts({ plan }: { plan: Plan }) {
  const live = liveVisits(plan);
  const done = live.filter((s) => s.status === "done").length;
  const m = planMoney(plan);
  const ahead = paidAhead(plan);
  return (
    <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 rounded-xl bg-muted/60 px-4 py-3 text-sm">
      <dt className="text-muted-foreground">Treatment</dt>
      <dd className="flex flex-wrap items-center gap-x-2">
        <b className="font-semibold">{done} of {live.length} {live.length === 1 ? "visit" : "visits"} done</b>
        <span aria-hidden className="flex gap-0.5">
          {live.map((s) => (
            <span key={s.id} className={cn("h-1.5 w-4 rounded-full", s.status === "done" ? "bg-primary" : "bg-border")} />
          ))}
        </span>
      </dd>
      <dt className="text-muted-foreground">Money</dt>
      <dd>
        {m.total <= 0 ? (
          <span>No charge for this treatment</span>
        ) : (
          <>
            <b className="font-semibold">{birr(m.paid)} paid</b>
            <span className="text-muted-foreground"> of {birr(m.total)}</span>
            {" · "}
            {m.left > 0 ? <b className="font-semibold">{birr(m.left)} left to pay</b> : <span className="font-medium text-primary">fully paid</span>}
            {m.atCashier > 0 && <span className="text-amber-700"> · {birr(m.atCashier)} at the cashier</span>}
          </>
        )}
        {ahead.length > 0 && (
          <span className="mt-0.5 block font-medium text-amber-700">
            {ahead.length === 1 ? `Visit ${ahead[0]} is` : `Visits ${joinNumbers(ahead)} are`} paid but not done yet.
          </span>
        )}
      </dd>
    </dl>
  );
}

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

/** What happened last time in this treatment: the question a dentist sits down with. */
function LastTime({ plan, before, onPick }: { plan: Plan; before: Session; onPick: (id: string) => void }) {
  // The latest visit done, in the card's own order (done visits by date), so "last
  // time" is the visit that actually happened last, whatever its number.
  const previous = liveVisits(plan).filter((s) => s.id !== before.id && s.status === "done").pop();
  if (!previous) {
    return <p className="rounded-lg border border-dashed px-3 py-2.5 text-sm text-muted-foreground">First visit of this treatment. Nothing recorded yet.</p>;
  }
  const said = [previous.procedure, previous.tooth].filter(Boolean).join(" on ");
  const n = visitPosition(plan, previous.id).position;
  return (
    <div className="flex flex-wrap items-start justify-between gap-3 rounded-xl border px-4 py-3">
      <div className="min-w-0 flex-1">
        <p className="text-sm text-muted-foreground">Last time: visit {n} on {shortDate(previous.scheduled_date)}</p>
        <p className="mt-0.5 font-semibold">{said || "No clinical note was written"}</p>
        {previous.notes && <p className="mt-0.5 line-clamp-2 whitespace-pre-wrap text-sm text-muted-foreground">{previous.notes}</p>}
        {(previous.prescriptions.length > 0 || previous.images.length > 0) && (
          <div className="mt-1.5 flex flex-wrap gap-1.5">
            {previous.prescriptions.length > 0 && (
              <span className="inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs text-muted-foreground">
                <Pill className="h-3 w-3" /> {previous.prescriptions.length} prescription{previous.prescriptions.length > 1 ? "s" : ""}
              </span>
            )}
            {previous.images.length > 0 && (
              <span className="inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs text-muted-foreground">
                <ImageIcon className="h-3 w-3" /> {previous.images.length} image{previous.images.length > 1 ? "s" : ""}
              </span>
            )}
          </div>
        )}
      </div>
      <Button variant="ghost" size="sm" className="shrink-0 text-primary" onClick={() => onPick(previous.id)}>
        See visit {n}
      </Button>
    </div>
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
    onSuccess: () => { toast.success("Visit added to the treatment"); onAdded(); onClose(); },
    onError: (e) => toast.error(e instanceof AppError ? e.message : "Could not add the visit"),
  });
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader><DialogTitle>Add a visit to {planTitle}</DialogTitle></DialogHeader>
        <p className="text-sm text-muted-foreground">
          Treatment does not always go to plan. The treatment's total and its number of visits
          move with this, so "visit 4 of 6" keeps describing something real.
        </p>
        <div className="space-y-1.5">
          <Label htmlFor="add-date">Date</Label>
          <EthiopianDateInput id="add-date" value={date} onChange={setDate} showAge={false} />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="add-amount">Fee (ETB)</Label>
          <Input id="add-amount" type="number" min={0} value={amount} onChange={(e) => setAmount(e.target.value)} />
          <p className="text-xs text-muted-foreground">Pre-filled with what this treatment usually charges per visit.</p>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>Cancel</Button>
          <Button loading={add.isPending} disabled={!date} onClick={() => add.mutate()}>Add visit</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// For a course that will not go ahead — entered by mistake, or the patient withdrew.
// The server refuses while money is live or given treatment is owed, and says what
// to do first; this dialog only has to say what will happen (audit D11).
function CancelCourseDialog({ patientId, plan, onClose, onDone }: {
  patientId: string; plan: Plan; onClose: () => void; onDone: () => void;
}) {
  const [reason, setReason] = useState("");
  const upcoming = plan.sessions.filter((s) => s.status === "planned");
  const dep = plan.deposit;
  const depositGoes = !!dep && dep.payment === "unpaid" && num(dep.amount_due) > 0;
  const cancel = useMutation({
    mutationFn: () => cancelCourse(patientId, plan.id, reason.trim()),
    onSuccess: () => { toast.success("Treatment cancelled"); onDone(); onClose(); },
    onError: (e) => toast.error(e instanceof AppError ? e.message : "Could not cancel the treatment"),
  });
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader><DialogTitle className="text-destructive">Cancel {plan.title}?</DialogTitle></DialogHeader>
        <p className="text-sm">
          Use this for a treatment that will not go ahead. {upcoming.length > 0
            ? <>Its {upcoming.length} booked visit{upcoming.length === 1 ? "" : "s"} will be cancelled</>
            : <>Nothing is booked on it</>}
          {depositGoes && dep ? <>, and the unpaid down payment of <b>{birr(dep.amount_due)}</b> will no longer be owed</> : null}.
        </p>
        <p className="text-xs text-muted-foreground">
          A treatment with a bill at the cashier, a payment, or treatment already given and not paid for cannot be
          cancelled — those have to be pulled back, refunded or written off first, so no money disappears.
        </p>
        <div className="space-y-1.5">
          <Label htmlFor="cancel-why" className="text-xs">Why? (kept on the record)</Label>
          <Input id="cancel-why" value={reason} onChange={(e) => setReason(e.target.value)}
            placeholder="Created on the wrong patient · patient decided not to go ahead" />
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>Keep the treatment</Button>
          <Button variant="destructive" disabled={!reason.trim()} loading={cancel.isPending} onClick={() => cancel.mutate()}>
            Cancel the treatment
          </Button>
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
  // The server's rule exactly: every planned visit without a live bill — promised
  // pay-later visits included (they were missing here, audit D3).
  const willCancel = plan.sessions.filter(
    (s) => s.status === "planned" && s.payment !== "billed" && s.payment !== "paid" && s.payment !== "waived",
  );
  // The down payment is never cancelled by finishing; say so, so nobody assumes it was.
  const dep = plan.deposit;
  const depositOwed = !!dep && dep.payment !== "paid" && dep.payment !== "waived" && num(dep.amount_due) > 0;
  const finish = useMutation({
    mutationFn: () => finishCourse(patientId, plan.id),
    onSuccess: (r) => {
      toast.success(r.sessions_cancelled > 0
        ? `Treatment finished. ${r.sessions_cancelled} unused visit${r.sessions_cancelled === 1 ? "" : "s"} cancelled`
        : "Treatment finished");
      onDone(); onClose();
    },
    onError: (e) => toast.error(e instanceof AppError ? e.message : "Could not finish the treatment"),
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
                  <span>Visit {visitPosition(plan, s.id).position} · <DualDate iso={s.scheduled_date} />{s.pay_later && " · promised pay-later"}</span>
                  <span className="tabular-nums text-muted-foreground">{birr(s.amount_due)}</span>
                </li>
              ))}
            </ul>
          </div>
        ) : (
          <p className="text-sm text-muted-foreground">Every visit in this treatment is already done.</p>
        )}
        {depositOwed && dep && (
          <p className="rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-900">
            The down payment of <b>{birr(dep.amount_due)}</b> is {dep.payment === "billed" ? "at the cashier" : "not paid yet"} and
            stays owed. Finishing the treatment does not cancel it.
          </p>
        )}
        <p className="text-xs text-muted-foreground">
          Nothing already collected changes, and any visit that was delivered or billed is left
          exactly as it is. Finishing a treatment cannot hide money that is owed.
        </p>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>Cancel</Button>
          <Button loading={finish.isPending} onClick={() => finish.mutate()}>Finish treatment</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
