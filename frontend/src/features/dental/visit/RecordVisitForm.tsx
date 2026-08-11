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
// to pay, so treatment can always be recorded; the fee is then resolved explicitly —
// sent to the desk, promised for later, or already collected — and an unresolved fee
// stays visible until someone answers it. Nothing is silently written off.
import { useEffect, useRef, useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { AlertTriangle, HandCoins, Save, X } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { toast } from "@/components/ui/sonner";
import { AppError } from "@/lib/api-client";
import { DualDate } from "@/components/DualDate";
import { collectSession, setPayLater, updateSession, type Session } from "@/features/dental/api";
import { birr } from "@/features/dental/money";
import { FLAT_TEETH, parseCsv, ProcedureMultiSelect, ToothMultiSelect } from "@/features/dental/shared/pickers";
import { PrescriptionSection, SessionImages } from "@/features/dental/shared/visitRecord";

const todayISO = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};

interface Draft { procedure: string[]; tooth: string[]; notes: string }

export function RecordVisitForm({
  patientId, session, planTitle, teeth, imageLimit, onSaved, onCancel,
}: {
  patientId: string;
  session: Session;
  planTitle: string;
  teeth: Record<string, string>;
  /** Per-patient image cap from the plan; -1 = unlimited. */
  imageLimit: number;
  /** Refresh the data. Does NOT dismiss the form — the fee panel must follow. */
  onSaved: () => void;
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

  const save = useMutation({
    mutationFn: () => updateSession(patientId, session.id, {
      procedure: procedure.join(", "),
      tooth: FLAT_TEETH.filter((c) => tooth.includes(c)).join(", "),
      notes,
      status: "done",
    }),
    onSuccess: () => {
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
  const notToday = session.scheduled_date !== todayISO();

  return (
    <div className="space-y-4 rounded-md border border-brand/40 bg-brand/[0.03] p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-[11px] font-semibold uppercase tracking-wide text-brand">
          Recording · {planTitle} · session {session.seq}
        </p>
        <Button size="sm" variant="ghost" onClick={() => {
          if (dirty) {
            // Write the draft NOW rather than promising one the 800ms debounce may
            // not have flushed yet — the promise has to be true when it is made.
            sessionStorage.setItem(draftKey, JSON.stringify({ procedure, tooth, notes } satisfies Draft));
            if (!window.confirm("Close without recording? What you typed is kept as a draft and will be here when you reopen this visit.")) return;
          }
          onCancel();
        }}><X className="h-3.5 w-3.5" /> Cancel</Button>
      </div>

      {restored && (
        <p className="rounded-md border border-amber-300 bg-amber-50 px-2.5 py-1.5 text-xs text-amber-800">
          Draft restored — this was typed earlier and never saved.
        </p>
      )}

      {/* Stated, never blocking. The old form disabled every field behind a second
          date confirmation; a visit genuinely recorded late is a normal event. */}
      {notToday && (
        <p className="flex items-start gap-2 text-xs text-muted-foreground">
          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          This session is dated <DualDate iso={session.scheduled_date} />, not today. Recording it here keeps that date.
        </p>
      )}

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

      <div className="space-y-1.5">
        <Label htmlFor="visit-notes">Notes</Label>
        <Textarea id="visit-notes" rows={4} value={notes} onChange={(e) => { setNotes(e.target.value); setDirty(true); }}
          placeholder="What was done, what was found, what happens next visit" />
      </div>

      {/* Attach while the patient is still in the chair. These lived only inside the
          old plan list's expandable row, so a dentist recording here could write the
          note but not print the script or keep the X-ray. */}
      <div className="space-y-3 border-t pt-3">
        <PrescriptionSection patientId={patientId} session={session} editable onChanged={onSaved} />
        <SessionImages patientId={patientId} session={session} editable imageLimit={imageLimit} onChanged={onSaved} />
      </div>

      <div className="flex flex-wrap items-center gap-2 border-t pt-3">
        <Button disabled={empty} loading={save.isPending} onClick={() => save.mutate()}>
          <Save className="h-4 w-4" /> Save &amp; mark done
        </Button>
        <span className="text-xs text-muted-foreground">
          Fee {birr(session.amount_due)} — you'll choose how it's settled next.
        </span>
      </div>
    </div>
  );
}

/**
 * How this visit's fee is handled — asked once, after the work is recorded.
 *
 * The three answers are the clinic's actual options. "Patient pays later" is a real
 * outcome here, not a workaround for a lock: the doctor may treat on a promise, and
 * the promise is recorded rather than implied by an unpaid row.
 */
export function SettleFee({ patientId, session, canCollect, onSettled }: {
  patientId: string; session: Session; canCollect: boolean; onSettled: () => void;
}) {
  const [promise, setPromise] = useState(session.pay_later_note ?? "");
  const settled = session.payment === "paid";
  const queued = session.payment === "billed";

  const bill = useMutation({
    mutationFn: () => collectSession(patientId, session.id),
    onSuccess: () => { toast.success("Sent to the cashier"); onSettled(); },
    onError: (e) => toast.error(e instanceof AppError ? e.message : "Could not send to the cashier"),
  });
  const later = useMutation({
    mutationFn: () => setPayLater(patientId, session.id, { on: true, note: promise.trim() }),
    onSuccess: () => { toast.success("Recorded as pay later"); onSettled(); },
    onError: (e) => toast.error(e instanceof AppError ? e.message : "Could not record the promise"),
  });

  // Nothing to ask about a visit that has not happened.
  //
  // This checked only the MONEY state, never whether the treatment was delivered, so
  // a visit booked eleven days out rendered "Visit recorded. 4,000 ETB for it is not
  // settled" with two buttons offering to bill a patient for treatment they had not
  // received — while the fee line ten pixels below read "Not yet due". The panel is
  // now mounted only in the recorded state, and this is the second guard.
  if (session.status !== "done") return null;
  if (settled || queued || session.pay_later) return null;

  return (
    <div className="space-y-3 rounded-md border border-amber-300 bg-amber-50 p-3">
      <p className="flex items-start gap-2 text-sm font-medium text-amber-900">
        <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
{birr(session.amount_due)} for this visit is not settled — how is it handled?
      </p>
      <div className="flex flex-wrap gap-2">
        {canCollect && (
          <Button loading={bill.isPending} onClick={() => bill.mutate()}>
            <HandCoins className="h-4 w-4" /> Send to the front desk
          </Button>
        )}
        <Button variant="outline" loading={later.isPending} onClick={() => later.mutate()}>
          Patient pays later
        </Button>
        {/* No dismiss: an unresolved fee is the whole point of removing the gate.
            It stays on the cockpit until it is sent, promised, or collected. */}
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="promise" className="text-xs">When did they promise to pay? (optional)</Label>
        <Input id="promise" value={promise} onChange={(e) => setPromise(e.target.value)}
          placeholder="Next visit · end of the month · after salary" className="bg-background" />
        <p className="text-xs text-amber-800">
          Either way this stays flagged as owing until the money is collected — nothing is written off here.
        </p>
      </div>
    </div>
  );
}
