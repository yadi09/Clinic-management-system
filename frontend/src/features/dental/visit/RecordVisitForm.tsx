// Recording what was done at this visit.
//
// THE ORDER MATTERS, and it is the opposite of what this page used to enforce.
//
// Previously a session was locked until money moved: "Collect payment or mark
// pay-later to record this visit". A dentist could not write down what they had just
// done to a patient until a billing state changed. That is backwards in the chair,
// it fired on every one of the six sessions of a root canal, and it was satisfied by
// typing a single character into a pay-later note — so it never worked as a control
// either. Two more gates sat on top of it: an "Access now" lock on any future-dated
// session, and a second date confirmation inside the form.
//
// All three are gone. The clinic's rule is that a patient may be treated on a promise
// to pay, so treatment can always be recorded.
//
// The fee is now asked FIRST, on the payment step in VisitPaymentStep, because that
// is the order the chair works in — the patient is sent to the desk and comes back.
// It is still not a lock: "Treat now, pay later" on that step opens this form at
// once, and the promise is recorded rather than implied by an unpaid row.
import { useEffect, useRef, useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { CalendarClock, LayoutGrid, NotebookPen, Save, Stethoscope, X } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { toast } from "@/components/ui/sonner";
import { AppError } from "@/lib/api-client";
import { DualDate } from "@/components/DualDate";
import { useConfirmDialog } from "@/components/ConfirmDialog";
import { updateSession, type Session } from "@/features/dental/api";
import { birr } from "@/features/dental/money";
import { feeStage } from "@/features/dental/visit/VisitPaymentStep";
import { FLAT_TEETH, parseCsv, ProcedureMultiSelect, ToothMultiSelect, ToothPalmerPicker } from "@/features/dental/shared/pickers";
import { ExtrasSection, extrasTotal, UnpaidExtrasStop, unsettledExtras } from "@/features/dental/shared/Extras";
import { RecordSection } from "@/features/dental/shared/RecordSection";
import { PrescriptionSection, SessionImages } from "@/features/dental/shared/visitRecord";

const todayISO = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};

interface Draft { procedure: string[]; tooth: string[]; notes: string }

export function RecordVisitForm({
  patientId, session, planTitle, visitLabel, recordDate, teeth, imageLimit, canCollect, onSaved, onChanged, onCancel,
}: {
  patientId: string;
  session: Session;
  planTitle: string;
  /** How the card names this visit ("visit 2"), so the form says the same. */
  visitLabel?: string;
  /**
   * The day this visit is saved as, when it is being recorded for the first time.
   * The card defaults it to today: a missed visit done today happened today. Omitted,
   * the visit keeps its booked date, as before. Only sent on the save that marks the
   * visit done, so editing the note later never moves the visit.
   */
  recordDate?: string;
  teeth: Record<string, string>;
  /** Per-patient image cap from the plan; -1 = unlimited. */
  imageLimit: number;
  /** May this person raise a bill (send an extra to the cashier)? */
  canCollect?: boolean;
  /** The visit was recorded and marked done. The parent closes the form. */
  onSaved: () => void;
  /**
   * Something attached to the visit changed — a prescription, an image.
   *
   * Separate from onSaved on purpose. Both used to call the one callback, and the
   * parent's version of it closed the form: adding a prescription or a photo threw
   * the dentist out of the record they were half way through writing, with the note
   * still unsaved, and they had to press "Start this visit now" again to get back.
   */
  onChanged: () => void;
  onCancel: () => void;
}) {
  const draftKey = `dental-draft:${session.id}`;
  const [procedure, setProcedure] = useState<string[]>(() => parseCsv(session.procedure));
  const [tooth, setTooth] = useState<string[]>(() => parseCsv(session.tooth));
  const [notes, setNotes] = useState(session.notes ?? "");
  const [restored, setRestored] = useState(false);
  // Dirty tracking exists so the autosave cannot fire on mount and then present the
  // component's own initial values back to the clinician as a "restored draft".
  const [dirty, setDirty] = useState(false);
  // Open by default once teeth are chosen: the codes alone are the thing that is
  // hard to hold in your head, so the picture should be there without being asked for.
  const [showChart, setShowChart] = useState(() => parseCsv(session.tooth).length > 0);
  const { ask, dialog } = useConfirmDialog();

  // A visit note is dictated while the patient is in the chair; losing it to a
  // refetch, a reschedule by the front desk, or a mis-click is not acceptable.
  useEffect(() => {
    const raw = sessionStorage.getItem(draftKey);
    if (!raw) return;
    try {
      const d = JSON.parse(raw) as Draft;
      if (d.notes || d.procedure?.length || d.tooth?.length) {
        setProcedure(d.procedure ?? []); setTooth(d.tooth ?? []); setNotes(d.notes ?? "");
        setRestored(true); setDirty(true);
      }
    } catch { /* a corrupt draft is not worth failing the form for */ }
  }, [draftKey]);

  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (!dirty) return;
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      sessionStorage.setItem(draftKey, JSON.stringify({ procedure, tooth, notes } satisfies Draft));
    }, 800);
    return () => { if (timer.current) clearTimeout(timer.current); };
  }, [dirty, draftKey, procedure, tooth, notes]);

  // A visit note is typed with the patient in the chair. Closing the tab on one is
  // the kind of loss that gets discovered days later, so the browser asks first.
  // (The draft is also in sessionStorage, but that dies with the tab.)
  useEffect(() => {
    if (!dirty) return;
    const warn = (e: BeforeUnloadEvent) => { e.preventDefault(); e.returnValue = ""; };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty]);

  // The day the record will carry. A visit already done keeps its date.
  const savedAs = session.status === "planned" && recordDate ? recordDate : session.scheduled_date;
  const save = useMutation({
    mutationFn: () => updateSession(patientId, session.id, {
      procedure: procedure.join(", "),
      tooth: FLAT_TEETH.filter((c) => tooth.includes(c)).join(", "),
      notes,
      status: "done",
      // One request, so the visit is never left moved but not recorded.
      ...(savedAs !== session.scheduled_date ? { scheduled_date: savedAs } : {}),
    }),
    onSuccess: () => {
      // The visit is recorded, so its draft is finished: stop a pending draft save
      // first, or it fires after the removal and brings the draft back (NEW-DRAFT-1).
      if (timer.current) clearTimeout(timer.current);
      setDirty(false);
      sessionStorage.removeItem(draftKey);
      toast.success("Visit recorded");
      // Refresh only. Dismissing here is what made the fee question unreachable:
      // the parent unmounted this component in the same commit that would have
      // shown it, so treatment could be recorded with no fee prompt at all.
      onSaved();
    },
    onError: (e) => toast.error(e instanceof AppError ? e.message : "Could not save the visit"),
  });

  const empty = procedure.length === 0 && tooth.length === 0 && !notes.trim();
  const unpaid = unsettledExtras(session);
  const [stopping, setStopping] = useState(false);
  const notToday = savedAs !== todayISO();
  // "5 days ago" is the part that makes the warning land; a date alone has to be
  // subtracted from today in the reader's head while a patient waits.
  const backdated = (() => {
    const days = Math.round(
      (Date.parse(`${todayISO()}T00:00:00`) - Date.parse(`${savedAs}T00:00:00`)) / 86_400_000,
    );
    if (days <= 0) return "";
    if (days === 1) return "yesterday";
    return `${days} days ago`;
  })();

  return (
    // Raised off the page and tinted, so the eye lands here first. While this is
    // open it is the only thing the dentist is doing; it should not look like one
    // more card in a column of cards.
    <div className="overflow-hidden rounded-xl border-2 border-brand/30 bg-muted/40 shadow-modal">
      {dialog}
      <UnpaidExtrasStop open={stopping} patientId={patientId} extras={unpaid} canCollect={canCollect}
        onClose={() => setStopping(false)}
        onProceed={() => { setStopping(false); save.mutate(); }} />
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-brand/20 bg-brand/[0.07] px-4 py-2.5">
        <p className="flex items-center gap-2 text-[11px] font-semibold uppercase tracking-wide text-brand">
          <span className="flex h-1.5 w-1.5 animate-pulse rounded-full bg-brand" />
          Recording {visitLabel ?? `visit ${session.seq}`} · {planTitle}
        </p>
        <Button size="sm" variant="ghost" onClick={() => {
          if (!dirty) { onCancel(); return; }
          // Write the draft NOW rather than promising one the 800ms debounce may not
          // have flushed yet — the promise has to be true when it is made.
          sessionStorage.setItem(draftKey, JSON.stringify({ procedure, tooth, notes } satisfies Draft));
          ask({
            title: "Close without recording?",
            description: "What you typed is kept as a draft and will be here when you reopen this visit.",
            confirmLabel: "Close",
          }, onCancel);
        }}><X className="h-3.5 w-3.5" /> Cancel</Button>
      </div>

      <div className="space-y-3 p-3">
        {restored && (
          <p className="rounded-md border border-amber-300 bg-amber-50 px-2.5 py-1.5 text-xs text-amber-800">
            Draft restored — this was typed earlier and never saved.
          </p>
        )}

        {/* Stated loudly, never blocking. This was a grey 12px line with a small
            triangle, saying "this session is dated Aug 11, not today" — the one fact
            that changes what the record MEANS, whispered. A visit recorded five days
            late is normal and allowed; being unaware of it is not. */}
        {notToday && (
          <div className="flex items-start gap-2.5 rounded-md border-l-4 border-amber-500 bg-amber-50 px-3 py-2.5">
            <CalendarClock className="mt-0.5 h-4 w-4 shrink-0 text-amber-600" />
            <div className="text-sm">
              <p className="font-semibold text-amber-900">
                You are recording {backdated ? `a visit from ${backdated}` : "a visit booked for a later date"} — not today.
              </p>
              <p className="text-xs text-amber-800">
                It is saved as <b><DualDate iso={savedAs} /></b>
                {savedAs === session.scheduled_date ? ", the date it was booked for." : "."}
              </p>
            </div>
          </div>
        )}

        <RecordSection
          icon={Stethoscope} tone="clinical" title="What was treated"
          hint="The teeth you worked on and what you did to them."
          action={
            <Button variant="ghost" size="sm" className="h-7 px-2 text-xs"
              onClick={() => setShowChart((v) => !v)}>
              <LayoutGrid className="h-3.5 w-3.5" /> {showChart ? "Hide chart" : "Show chart"}
            </Button>
          }
        >
          <div className="space-y-3">
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="space-y-1.5">
                <Label>Tooth</Label>
                <ToothMultiSelect teeth={teeth} value={tooth} onChange={(v) => { setTooth(v); setDirty(true); }} />
              </div>
              <div className="space-y-1.5">
                <Label>Procedure</Label>
                <ProcedureMultiSelect value={procedure} onChange={(v) => { setProcedure(v); setDirty(true); }} />
              </div>
            </div>
            {showChart && (
              <ToothPalmerPicker teeth={teeth} value={tooth} onChange={(v) => { setTooth(v); setDirty(true); }} />
            )}
          </div>
        </RecordSection>

        <RecordSection
          icon={NotebookPen} title="Clinical note"
          hint="What you found, what you did, what happens next visit."
        >
          <Textarea id="visit-notes" rows={4} value={notes}
            onChange={(e) => { setNotes(e.target.value); setDirty(true); }}
            className="bg-background"
            placeholder="e.g. Crown cemented on UR4. Occlusion checked. Review in two weeks." />
        </RecordSection>

        {/* Attach while the patient is still in the chair. These lived only inside the
            old plan list's expandable row, so a dentist recording here could write the
            note but not print the script or keep the X-ray. */}
        {/* Placed before the prescription, because it is still about what was done
            rather than what the patient takes home. */}
        <ExtrasSection patientId={patientId} session={session} editable canCollect={canCollect} />
        <PrescriptionSection patientId={patientId} session={session} editable onChanged={onChanged} />
        <SessionImages patientId={patientId} session={session} editable imageLimit={imageLimit} onChanged={onChanged} />

        {/* The finish line, held apart from the sections above it so it reads as the
            end of the task rather than another field. */}
        <div className="flex flex-wrap items-center gap-3 rounded-lg border bg-card px-4 py-3 shadow-sm">
          <Button size="lg" disabled={empty} loading={save.isPending}
            // Finishing with something added at the chair still unpaid is asked about,
            // once, rather than discovered later on the debt report.
            onClick={() => (unpaid.length > 0 ? setStopping(true) : save.mutate())}>
            <Save className="h-4 w-4" /> Save &amp; mark done
          </Button>
          <span className="text-xs text-muted-foreground">
            {/* "Settled" is true of a paid fee and a lie about a promised one — this
                line sits under the button that finishes the visit, so it has to say
                which of the two happened. */}
            Fee {birr(session.amount_due)} — {feeStage(session) === "paid"
              ? "paid."
              : "owed; the patient pays later."}
            {extrasTotal(session) > 0 && <> Plus {birr(String(extrasTotal(session)))} of extras, billed separately.</>}
            {empty && <><br />Add a tooth, a procedure or a note before finishing.</>}
          </span>
        </div>
      </div>
    </div>
  );
}
