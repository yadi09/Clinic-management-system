import { useEffect, useRef, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, CalendarCheck, CalendarPlus, Check, ClipboardList, Clock, FlaskConical, History as HistoryIcon, PauseCircle, Pencil, Pill, Plus, Printer, Search, Sparkles, X } from "lucide-react";

import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { toast } from "@/components/ui/sonner";
import { AppError } from "@/lib/api-client";
import { useAuth } from "@/app/auth-context";
import { getClinic, getSettings, listBranches, listProviders } from "@/features/admin/api";
import { printPrescription, printLabRequest } from "@/features/clinical/print";
import { DictateButton } from "@/features/clinical/components/DictateButton";
import { FLAG_CLS, VitalsGrid } from "@/features/clinical/components/VitalsStrip";
import { PatientStoryPanel } from "@/features/clinical/components/PatientStory";
import { SECTION_TONES, WorkSection } from "@/features/clinical/components/WorkSection";
import { bookAppointment, listAppointments, markFollowup, rescheduleAppointment, setAppointmentStatus, transitionQueue } from "@/features/scheduling/api";
import { createOrder, encounterLabs, listTests } from "@/features/lab/api";
import { PregnancyDatingCard } from "@/features/maternity/PregnancyCalculator";
import {
  addDiagnosis,
  addMedication,
  cancelLabReferral,
  createLabReferral,
  getVitalFields,
  openEncounter,
  removeDiagnosis,
  removeMedication,
  recordLabReferralResult,
  runAssist,
  saveNote,
  patientStory,
  searchCatalog,
  searchDrugs,
  setAside,
  signEncounter,
  signReferralUpload,
  uploadToTarget,
  type AssistResult,
  type CatalogEntry,
  type Drug,
  type LabReferral,
  type ReferralFile,
  type ReferralValue,
  type Workspace,
} from "@/features/clinical/api";
import { CreateDrugDialog } from "@/features/clinical/DrugLibrary";

const DEFERRED = ["Attachments"];

function hhmm(iso?: string) {
  if (!iso) return "";
  return new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}
function initials(name: string) {
  return name.split(" ").map((s) => s[0]).slice(0, 2).join("").toUpperCase();
}

export function EncounterWorkspacePage() {
  const { queueEntryId = "" } = useParams();
  const navigate = useNavigate();
  const qc = useQueryClient();

  const ws = useQuery({
    queryKey: ["encounter", queueEntryId],
    queryFn: () => openEncounter(queueEntryId),
    enabled: !!queueEntryId,
  });

  if (ws.isLoading) return <div className="p-8 text-sm text-muted-foreground">Opening encounter…</div>;
  if (ws.isError || !ws.data) return <div className="p-8 text-sm text-destructive">Could not open this encounter.</div>;

  return <Workspace3b ws={ws.data} queueEntryId={queueEntryId} onChanged={() => qc.invalidateQueries({ queryKey: ["encounter", queueEntryId] })} onClosed={() => navigate("/worklist")} />;
}

function Workspace3b({ ws, queueEntryId, onChanged, onClosed }: { ws: Workspace; queueEntryId: string; onChanged: () => void; onClosed: () => void }) {
  const { flagOn } = useAuth();
  const locked = ws.status === "closed" || ws.note.status === "signed";
  const awaiting = ws.status === "awaiting_results";
  const latest = ws.vitals[0];
  const vfields = useQuery({ queryKey: ["vital-fields"], queryFn: getVitalFields });
  const [confirmSign, setConfirmSign] = useState(false);

  const park = useMutation({
    mutationFn: () => setAside(ws.encounter_id),
    onSuccess: () => {
      toast.success("Set aside — patient stays on your board under “In progress”");
      onClosed();
    },
    onError: () => toast.error("Could not set this encounter aside"),
  });

  // SOAP local state + debounced auto-save.
  const [soap, setSoap] = useState({ subjective: ws.note.subjective, objective: ws.note.objective, assessment: ws.note.assessment, plan: ws.note.plan });
  const soapRef = useRef(soap);
  soapRef.current = soap; // always the latest, so a delayed dictation appends to current text
  const [savedAt, setSavedAt] = useState<string | null>(ws.note.status === "signed" ? ws.note.signed_at ?? null : null);
  const [save, setSave] = useState<SaveState>(ws.note.status === "signed" ? "saved" : "unsaved");
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Cancel any pending auto-save on unmount (e.g. after sign navigates away).
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);

  const setField = (k: keyof typeof soap, v: string) => {
    if (locked) return;
    const next = { ...soapRef.current, [k]: v };
    setSoap(next);
    setSave("saving");
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(async () => {
      try {
        await saveNote(ws.encounter_id, next);
        setSavedAt(new Date().toISOString());
        setSave("saved");
      } catch {
        setSave("unsaved");
        toast.error("Could not auto-save the note");
      }
    }, 800);
  };
  // Append dictated text to a field (uses the latest value, not a stale closure).
  const appendField = (k: keyof typeof soap, add: string) => {
    const cur = soapRef.current[k];
    setField(k, cur.trim() ? `${cur.replace(/\s*$/, "")} ${add}` : add);
  };

  const sign = useMutation({
    mutationFn: async () => {
      if (timer.current) clearTimeout(timer.current); // don't let a pending autosave hit the now-signed note
      await signEncounter(ws.encounter_id);
      // Close the loop: move the queue entry to done (consistent with reception orchestration).
      try {
        await transitionQueue(queueEntryId, "done");
      } catch {
        /* worklist will reconcile */
      }
    },
    onSuccess: () => {
      toast.success("Encounter signed & closed");
      onClosed();
    },
    onError: () => toast.error("Could not sign the encounter"),
  });

  // What is written and what is not — drives the rail, the step ticks, and the
  // "before signing" list, so the doctor never has to hunt for what is missing.
  const done: Record<string, boolean> = {
    subjective: soap.subjective.trim().length > 0,
    // Vitals are the nurse's work, not the doctor's, so they do not tick this off —
    // otherwise the section reads "done" the moment the patient walks in, and a set of
    // observations nobody has examined against looks like a completed step.
    objective: soap.objective.trim().length > 0,
    assessment: soap.assessment.trim().length > 0 || ws.diagnoses.length > 0,
    plan: soap.plan.trim().length > 0,
    lab: ws.lab_referrals.length > 0,
    prescription: ws.prescription.length > 0,
  };
  const missing: string[] = [];
  if (ws.diagnoses.length === 0) missing.push("No diagnosis recorded");
  if (!done.subjective) missing.push("Subjective is empty");
  if (!done.plan) missing.push("Plan is empty");

  const elapsed = useElapsed(ws.started_at);
  const active = useActiveSection(SECTION_TONES.map((t) => t.id));
  const [pane, setPane] = useState<"note" | "history" | "assist">("note");
  // Assist is a plan feature. A doctor cannot buy it, so a clinic without it gets
  // no tab at all rather than a button that always fails.
  const assistOn = flagOn("ai_assist");
  const panes: { k: typeof pane; label: string; Icon: typeof ClipboardList }[] = [
    { k: "note", label: "Note", Icon: ClipboardList },
    { k: "history", label: "History", Icon: HistoryIcon },
    ...(assistOn ? [{ k: "assist" as const, label: "Assist", Icon: Sparkles }] : []),
  ];
  const paneCls = (p: typeof pane) => cn(pane === p ? "" : "hidden", "lg:block");

  return (
    <div className="space-y-4">
      <ConsultHeader ws={ws} elapsed={elapsed} save={save} savedAt={savedAt} locked={locked}>
        {!locked && (
          <>
            {ws.status === "open" && (
              <Button variant="ghost" size="sm" className="touch-hit hidden text-white hover:bg-white/15 hover:text-white sm:inline-flex"
                loading={park.isPending} onClick={() => park.mutate()}>
                <PauseCircle className="h-4 w-4" /> Set aside
              </Button>
            )}
            <Button size="sm" className="touch-hit bg-white text-brand hover:bg-white/90"
              loading={sign.isPending} onClick={() => setConfirmSign(true)}>
              <Check className="h-4 w-4" /> Sign &amp; close
            </Button>
          </>
        )}
      </ConsultHeader>

      {locked && (
        <div className="flex items-center gap-2 rounded-md border border-emerald-200 bg-emerald-50 px-4 py-2 text-sm text-emerald-800">
          <Check className="h-4 w-4" /> This encounter is signed and locked{ws.note.signed_at ? ` (${hhmm(ws.note.signed_at)})` : ""} — read only.
        </div>
      )}
      {awaiting && (
        <div className="flex items-center gap-2 rounded-md border border-amber-200 bg-amber-50 px-4 py-2 text-sm text-amber-800">
          <PauseCircle className="h-4 w-4" /> Set aside — awaiting results. Still editable; review the labs below, then sign &amp; close.
        </div>
      )}

      {/* On a phone the note, the history and the assistant were three screens
          stacked — the doctor scrolled past the whole consultation to reach the last
          visit. They become three panes of the same screen instead. */}
      <div className="flex gap-1 rounded-lg border bg-card p-1 lg:hidden">
        {panes.map(({ k, label, Icon }) => (
          <button key={k} type="button" onClick={() => setPane(k)}
            className={cn("touch-hit flex flex-1 items-center justify-center gap-1.5 rounded-md py-2 text-sm font-medium transition-colors",
              pane === k ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:bg-muted")}>
            <Icon className="h-4 w-4" /> {label}
          </button>
        ))}
      </div>

      <div className="grid grid-cols-1 gap-5 lg:grid-cols-[200px_minmax(0,1fr)_320px]">
        <ProgressRail done={done} missing={missing} active={active} />

        {/* Center */}
        <div className={cn("min-w-0 space-y-5", paneCls("note"))}>
          <WorkSection id="subjective" done={done.subjective}
            action={!locked && <DictateButton onText={(t) => appendField("subjective", t)} />}>
            <Textarea rows={4} placeholder="What brought them in? How long, what makes it worse, what have they already tried?"
              value={soap.subjective} disabled={locked} onChange={(e) => setField("subjective", e.target.value)} />
          </WorkSection>

          <WorkSection id="objective" done={done.objective}
            action={!locked && <DictateButton onText={(t) => appendField("objective", t)} />}>
            {latest ? (
              <div className="mb-3">
                <VitalsGrid vitals={latest} fields={vfields.data ?? []} />
              </div>
            ) : (
              <p className="mb-3 rounded-md border border-dashed px-3 py-2 text-xs text-muted-foreground">
                No vitals were recorded at triage.
              </p>
            )}
            <Textarea rows={3} placeholder="Examination findings — what you saw, heard and felt."
              value={soap.objective} disabled={locked} onChange={(e) => setField("objective", e.target.value)} />
          </WorkSection>

          <WorkSection id="assessment" done={done.assessment}
            count={ws.diagnoses.length > 0 ? `${ws.diagnoses.length} recorded` : undefined}
            action={!locked && <DictateButton onText={(t) => appendField("assessment", t)} />}>
            <Textarea rows={3} className="mb-3" placeholder="What do you think this is, and what else could it be?"
              value={soap.assessment} disabled={locked} onChange={(e) => setField("assessment", e.target.value)} />
            <DiagnosisPicker ws={ws} locked={locked} onChanged={onChanged} />
          </WorkSection>

          <WorkSection id="plan" done={done.plan}
            action={!locked && <DictateButton onText={(t) => appendField("plan", t)} />}>
            <Textarea rows={3} placeholder="Treatment, advice, and when to come back — or what should bring them back sooner."
              value={soap.plan} disabled={locked} onChange={(e) => setField("plan", e.target.value)} />
          </WorkSection>

          <LabOrders ws={ws} locked={locked} />
          <LabReferralPanel ws={ws} locked={locked} onChanged={onChanged} />
          <PrescriptionPanel ws={ws} locked={locked} onChanged={onChanged} />

          {flagOn("maternity") && <PregnancyDatingCard patientId={ws.patient.patient_id} />}
          {!locked && <FollowUp ws={ws} />}

          {!locked && missing.length > 0 && (
            <div className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2.5">
              <p className="text-xs font-semibold uppercase tracking-wide text-amber-900">Before signing</p>
              <ul className="mt-1 space-y-0.5">
                {missing.map((m) => (
                  <li key={m} className="flex items-start gap-1.5 text-sm text-amber-800">
                    <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />{m}
                  </li>
                ))}
              </ul>
            </div>
          )}
          {!locked && ws.status === "open" && (
            <Button variant="outline" className="w-full sm:hidden" loading={park.isPending} onClick={() => park.mutate()}>
              <PauseCircle className="h-4 w-4" /> Set aside (awaiting results)
            </Button>
          )}
        </div>

        {/* Right rail — AI co-pilot + patient history timeline */}
        <div className={cn("space-y-4", pane === "note" && "hidden", "lg:block")}>
          {assistOn && <div className={paneCls("assist")}><AssistPanel encounterId={ws.encounter_id} /></div>}
          <div className={paneCls("history")}><PatientStoryPanel patientId={ws.patient.patient_id} /></div>
        </div>
      </div>

      <Dialog open={confirmSign} onOpenChange={setConfirmSign}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Sign &amp; close this encounter?</DialogTitle>
          </DialogHeader>
          <p className="text-sm text-muted-foreground">Once signed, the note, diagnoses and prescription are locked and the patient leaves your worklist.</p>
          <DialogFooter>
            <Button variant="outline" onClick={() => setConfirmSign(false)}>Cancel</Button>
            <Button className="bg-primary" loading={sign.isPending} onClick={() => sign.mutate()}>Sign &amp; close</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function FollowUp({ ws }: { ws: Workspace }) {
  const { user } = useAuth();
  const qc = useQueryClient();
  const settings = useQuery({ queryKey: ["settings"], queryFn: getSettings, retry: false });
  const providersQ = useQuery({ queryKey: ["providers"], queryFn: listProviders });
  const provider = ws.provider_id || user?.id || "";
  const [date, setDate] = useState("");
  const [time, setTime] = useState("09:00");
  const [instructions, setInstructions] = useState("");
  const [handler, setHandler] = useState(provider); // who attends; defaults to me
  const [editing, setEditing] = useState(false);
  const [confirmCancel, setConfirmCancel] = useState(false);

  // Look for an existing upcoming follow-up for this patient (any provider, so a
  // handed-off one still shows), so the doctor can't silently double-book.
  const fromISO = new Date().toISOString();
  const toISO = new Date(Date.now() + 365 * 86_400_000).toISOString();
  const existingQ = useQuery({
    queryKey: ["followup", ws.patient.patient_id],
    queryFn: () => listAppointments(ws.branch_id, fromISO, toISO),
    select: (appts) =>
      appts
        .filter((a) => a.patient_id === ws.patient.patient_id && a.is_followup && !["cancelled", "no_show", "completed"].includes(a.status))
        .sort((a, b) => a.starts_at.localeCompare(b.starts_at))[0] ?? null,
  });
  const existing = existingQ.data ?? null;

  const freeUntilFor = (startsAtISO: string) => {
    const days = settings.data?.free_window_days ?? 30;
    // Anchor the free window to the follow-up date (not booking time).
    const base = Math.max(Date.now(), new Date(startsAtISO).getTime());
    return new Date(base + days * 86_400_000).toISOString();
  };
  const invalidate = () => qc.invalidateQueries({ queryKey: ["followup", ws.patient.patient_id] });

  const book = useMutation({
    mutationFn: async () => {
      const attendedBy = handler || provider;
      if (!attendedBy) throw new Error("no provider on this encounter");
      const startsAt = new Date(`${date}T${time || "09:00"}:00`).toISOString();
      // One atomic call: marks the follow-up, anchors the free window, records the
      // ordering doctor (server defaults ordered_by to me) and links the origin visit.
      await bookAppointment({
        branch_id: ws.branch_id, patient_id: ws.patient.patient_id, provider_id: attendedBy,
        department_id: ws.department_id || undefined, starts_at: startsAt, duration_min: 30,
        reason: instructions.trim() || "Follow-up",
        is_followup: true, free_until: freeUntilFor(startsAt), origin_encounter_id: ws.encounter_id,
      });
    },
    onSuccess: () => { toast.success("Follow-up booked"); setDate(""); setInstructions(""); invalidate(); },
    onError: (e) => toast.error(e instanceof AppError ? e.message : "Could not book the follow-up"),
  });

  const reschedule = useMutation({
    mutationFn: async () => {
      if (!existing) throw new Error("nothing to reschedule");
      const startsAt = new Date(`${date}T${time || "09:00"}:00`).toISOString();
      await rescheduleAppointment(existing.id, {
        provider_id: existing.provider_id, department_id: ws.department_id || undefined, starts_at: startsAt, duration_min: 30,
        reason: existing.reason || "Follow-up",
      });
      await markFollowup(existing.id, freeUntilFor(startsAt)); // re-anchor the free window
    },
    onSuccess: () => { toast.success("Follow-up moved"); setEditing(false); setDate(""); invalidate(); },
    onError: (e) => toast.error(e instanceof AppError ? e.message : "Could not move the follow-up"),
  });

  const cancel = useMutation({
    mutationFn: () => setAppointmentStatus(existing!.id, "cancelled", "Cancelled by doctor"),
    onSuccess: () => { toast.success("Follow-up cancelled"); setConfirmCancel(false); invalidate(); },
    onError: () => toast.error("Could not cancel the follow-up"),
  });

  const fmtDate = (iso: string) => new Date(iso).toLocaleDateString(undefined, { weekday: "long", day: "numeric", month: "long", year: "numeric" });
  const fmtShort = (iso: string) => new Date(iso).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });

  // ---- Booked state ----
  if (existing && !editing) {
    return (
      <Card className="p-4">
        <h2 className="mb-3 flex items-center gap-2 text-h3">
          <span className="grid h-7 w-7 shrink-0 place-items-center rounded-lg bg-emerald-100 text-emerald-700">
            <CalendarCheck className="h-4 w-4" />
          </span>
          Follow-up
        </h2>
        <div className="rounded-lg border border-primary/30 bg-primary/5 p-4">
          <div className="flex items-start gap-3">
            <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-primary/15 text-primary">
              <CalendarCheck className="h-5 w-5" />
            </div>
            <div className="min-w-0 flex-1">
              <p className="text-xs font-medium uppercase tracking-wide text-primary">Follow-up booked</p>
              <p className="font-semibold text-brand">
                {fmtDate(existing.starts_at)} · {new Date(existing.starts_at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
              </p>
              <p className="text-xs text-muted-foreground">
                {existing.ordered_by && existing.ordered_by !== existing.provider_id && existing.ordered_by_name
                  ? `Ordered by ${existing.ordered_by_name} · handled by ${existing.provider_name}`
                  : `With ${existing.provider_name}`}
              </p>
              <p className="text-xs text-muted-foreground">
                {existing.free_until
                  ? `Free of the card fee if attended on or before ${fmtShort(existing.free_until)}.`
                  : "Free of the card fee within the clinic's window."}
              </p>
            </div>
          </div>
          {confirmCancel ? (
            <div className="mt-3 flex items-center justify-between gap-2 rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2">
              <span className="text-xs text-destructive">Cancel this follow-up?</span>
              <div className="flex gap-2">
                <Button size="sm" variant="outline" onClick={() => setConfirmCancel(false)}>Keep</Button>
                <Button size="sm" className="bg-destructive hover:bg-destructive/90" loading={cancel.isPending} onClick={() => cancel.mutate()}>
                  Cancel it
                </Button>
              </div>
            </div>
          ) : (
            <div className="mt-3 flex gap-2">
              <Button size="sm" variant="outline" onClick={() => { setDate(existing.starts_at.slice(0, 10)); setEditing(true); }}>
                <Pencil className="h-3.5 w-3.5" /> Reschedule
              </Button>
              <Button size="sm" variant="ghost" className="text-destructive hover:text-destructive" onClick={() => setConfirmCancel(true)}>
                <X className="h-3.5 w-3.5" /> Cancel
              </Button>
            </div>
          )}
        </div>
      </Card>
    );
  }

  // ---- Booking / rescheduling form ----
  const onSubmit = () => (existing ? reschedule.mutate() : book.mutate());
  return (
    <Card className="p-4">
      <div className="mb-2">
        <h2 className="flex items-center gap-2 text-h3">
          <span className="grid h-7 w-7 shrink-0 place-items-center rounded-lg bg-emerald-100 text-emerald-700">
            <CalendarPlus className="h-4 w-4" />
          </span>
          Follow-up
        </h2>
        {!editing && <p className="mt-0.5 text-xs text-muted-foreground">When should they come back?</p>}
      </div>
      {existingQ.isLoading ? (
        <p className="text-xs text-muted-foreground">Checking for an existing follow-up…</p>
      ) : (
        <>
          {editing && <p className="mb-2 text-xs text-muted-foreground">Pick a new date for this follow-up.</p>}

          {/* A doctor says "come back in two weeks", not "come back on 12/09/2026".
              The intervals are the common answers; the date field is still there for
              the uncommon one, and it fills in so the choice stays visible. */}
          <div className="mb-3 flex flex-wrap gap-1.5">
            {[
              { label: "In 3 days", days: 3 },
              { label: "1 week", days: 7 },
              { label: "2 weeks", days: 14 },
              { label: "1 month", days: 30 },
              { label: "3 months", days: 90 },
            ].map((q) => {
              const iso = new Date(Date.now() + q.days * 86_400_000).toISOString().slice(0, 10);
              const on = date === iso;
              return (
                <button key={q.label} type="button" onClick={() => setDate(iso)}
                  className={cn("touch-hit rounded-full border px-3 py-1.5 text-sm transition-colors",
                    on ? "border-primary bg-primary/10 font-medium text-primary" : "hover:border-primary hover:text-primary")}>
                  {q.label}
                  <span className="ml-1.5 text-xs text-muted-foreground">
                    {new Date(iso + "T00:00:00").toLocaleDateString(undefined, { day: "numeric", month: "short" })}
                  </span>
                </button>
              );
            })}
          </div>

          <div className="flex flex-wrap items-end gap-3">
            <div className="space-y-1.5">
              <Label>Date</Label>
              <Input type="date" min={new Date().toISOString().slice(0, 10)} value={date} onChange={(e) => setDate(e.target.value)} />
            </div>
            <div className="space-y-1.5">
              <Label>Time</Label>
              <Input type="time" value={time} onChange={(e) => setTime(e.target.value)} />
            </div>
            {!editing && (providersQ.data?.length ?? 0) > 1 && (
              <div className="space-y-1.5">
                <Label>Handled by</Label>
                <Select value={handler} onValueChange={setHandler}>
                  <SelectTrigger className="w-[190px]"><SelectValue placeholder="Choose a doctor…" /></SelectTrigger>
                  <SelectContent>
                    {(providersQ.data ?? []).map((p) => (
                      <SelectItem key={p.id} value={p.id}>{p.id === provider ? `${p.full_name} (me)` : p.full_name}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            )}
            <Button variant="outline" disabled={!date} loading={book.isPending || reschedule.isPending} onClick={onSubmit}>
              {existing ? <><CalendarCheck className="h-4 w-4" /> Save new date</> : <><CalendarPlus className="h-4 w-4" /> Book follow-up</>}
            </Button>
            {editing && (
              <Button variant="ghost" onClick={() => { setEditing(false); setDate(""); }}>Keep current</Button>
            )}
          </div>
          {!editing && (
            <div className="mt-3 space-y-1.5">
              <Label>Instructions for the return visit <span className="text-muted-foreground">(optional)</span></Label>
              <Textarea rows={2} placeholder="e.g. Recheck BP; review CBC results; titrate medication" value={instructions} onChange={(e) => setInstructions(e.target.value)} />
            </div>
          )}
          <p className="mt-2 text-xs text-muted-foreground">
            A doctor-booked follow-up is free of the card fee when the patient attends within the clinic's window.
            {handler && handler !== provider ? " You're handing this to a colleague; it stays credited to you." : ""}
          </p>
        </>
      )}
    </Card>
  );
}

function likelihoodChip(l: string) {
  const k = (l || "").toLowerCase();
  const cls =
    k === "high" ? "bg-rose-100 text-rose-700 border-rose-200" : k === "moderate" ? "bg-amber-100 text-amber-700 border-amber-200" : "bg-slate-100 text-slate-600 border-slate-200";
  return <span className={`rounded-full border px-1.5 py-0.5 text-[10px] font-semibold capitalize ${cls}`}>{l}</span>;
}

// AI clinical decision-support co-pilot. Doctor-triggered; provisional; never
// writes to the record. Reads the encounter's current context + relevant past
// history server-side (the patient's data never leaves the server for the browser).
function AssistPanel({ encounterId }: { encounterId: string }) {
  const [result, setResult] = useState<AssistResult | null>(null);
  const [disabled, setDisabled] = useState(false);
  const run = useMutation({
    mutationFn: () => runAssist(encounterId),
    onSuccess: (r) => {
      setResult(r);
      setDisabled(false);
    },
    onError: (e) => {
      if (e instanceof AppError && e.code === "ASSIST_DISABLED") {
        setDisabled(true);
        return;
      }
      toast.error(e instanceof Error ? e.message : "Assist couldn't analyze this encounter");
    },
  });

  return (
    <Card className="p-4">
      <div className="flex items-center gap-1.5">
        <Sparkles className="h-4 w-4 text-primary" />
        <span className="text-sm font-semibold">Assist</span>
        <Badge variant="outline" className="text-[10px]">AI · provisional</Badge>
      </div>

      {disabled ? (
        <p className="mt-3 text-xs text-muted-foreground">AI Assist isn't enabled for this clinic yet.</p>
      ) : !result ? (
        <>
          <p className="mt-2 text-xs text-muted-foreground">A second opinion drawn from this patient's vitals, allergies, your note, and past history. You decide.</p>
          <Button size="sm" className="mt-3 w-full bg-primary" loading={run.isPending} onClick={() => run.mutate()}>
            <Sparkles className="h-3.5 w-3.5" /> Analyze
          </Button>
        </>
      ) : (
        <div className="mt-3 space-y-3 text-xs">
          {result.summary && <p className="italic text-muted-foreground">{result.summary}</p>}

          {result.red_flags?.length > 0 && (
            <div className="rounded-md border border-rose-200 bg-rose-50 p-2.5">
              <div className="flex items-center gap-1 font-semibold text-rose-700">
                <AlertTriangle className="h-3.5 w-3.5" /> Red flags
              </div>
              <ul className="mt-1 list-disc space-y-0.5 pl-4 text-rose-800">
                {result.red_flags.map((f, i) => (
                  <li key={i}>{f}</li>
                ))}
              </ul>
            </div>
          )}

          {result.differentials?.length > 0 && (
            <div>
              <div className="mb-1 font-semibold text-foreground">Likely conditions</div>
              <ul className="space-y-1.5">
                {result.differentials.map((d, i) => (
                  <li key={i}>
                    <div className="flex items-center gap-1.5">
                      <span className="font-medium text-foreground">{d.condition}</span>
                      {likelihoodChip(d.likelihood)}
                    </div>
                    {d.why && <p className="text-muted-foreground">{d.why}</p>}
                  </li>
                ))}
              </ul>
            </div>
          )}

          {result.workup?.length > 0 && (
            <div>
              <div className="mb-1 font-semibold text-foreground">Check next</div>
              <ul className="list-disc space-y-0.5 pl-4 text-muted-foreground">
                {result.workup.map((w, i) => (
                  <li key={i}>{w}</li>
                ))}
              </ul>
            </div>
          )}

          {result.management?.length > 0 && (
            <div>
              <div className="mb-1 font-semibold text-foreground">Consider</div>
              <ul className="space-y-1">
                {result.management.map((m, i) => (
                  <li key={i}>
                    <span className="text-foreground">{m.suggestion}</span>
                    {m.caution && <span className="ml-1 font-medium text-amber-700">⚠ {m.caution}</span>}
                  </li>
                ))}
              </ul>
            </div>
          )}

          {result.questions?.length > 0 && (
            <div>
              <div className="mb-1 font-semibold text-foreground">Ask</div>
              <ul className="list-disc space-y-0.5 pl-4 text-muted-foreground">
                {result.questions.map((q, i) => (
                  <li key={i}>{q}</li>
                ))}
              </ul>
            </div>
          )}

          <div className="flex items-center justify-between border-t pt-2">
            <span className="text-[10px] text-muted-foreground">Suggestions only — the doctor decides.</span>
            <Button size="sm" variant="ghost" className="touch-hit h-6 px-2 text-[11px]" loading={run.isPending} onClick={() => run.mutate()}>
              Re-analyze
            </Button>
          </div>
        </div>
      )}
    </Card>
  );
}

/** How long this consultation has been running. A doctor cares about the clock;
 *  the encounter's opaque id, which used to sit here, is for support tickets. */
function useElapsed(startedAt: string) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(t);
  }, []);
  const mins = Math.max(0, Math.round((now - new Date(startedAt).getTime()) / 60000));
  return mins < 60 ? `${mins} min` : `${Math.floor(mins / 60)}h ${mins % 60}m`;
}

type SaveState = "saved" | "saving" | "unsaved";

/** Everything the doctor must be able to see and reach at any scroll depth:
 *  who this is, what they are allergic to, whether the note is safe, and the way out. */
function ConsultHeader({ ws, elapsed, save, savedAt, locked, children }: {
  ws: Workspace; elapsed: string; save: SaveState; savedAt: string | null; locked: boolean;
  children?: React.ReactNode;
}) {
  return (
    <div className="sticky top-16 z-30 -mx-4 mb-4 border-b bg-brand px-4 py-3 text-white shadow-sm sm:-mx-6 sm:px-6 lg:-mx-8 lg:px-8">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <div className="flex min-w-0 items-center gap-3">
          <div className="grid h-10 w-10 shrink-0 place-items-center rounded-full bg-white/15 text-sm font-semibold">
            {initials(ws.patient.name)}
          </div>
          <div className="min-w-0">
            <p className="truncate text-base font-semibold leading-tight">{ws.patient.name}</p>
            <p className="truncate text-xs text-white/70">
              {ws.patient.mrn} · {ws.patient.age}{ws.patient.gender ? ws.patient.gender[0].toUpperCase() : ""}
              {ws.patient.blood_group ? ` · ${ws.patient.blood_group}` : ""}
              <span className="ml-2 inline-flex items-center gap-1"><Clock className="h-3 w-3" />{elapsed}</span>
            </p>
          </div>
        </div>

        {/* Allergies ride in the header, at every scroll position, because the
            prescription is written further down the page than they used to be shown. */}
        {ws.allergies.length > 0 && (
          <div className="flex min-w-0 flex-wrap gap-1.5">
            {ws.allergies.map((a) => (
              <span key={a.substance}
                className="flex items-center gap-1 rounded-full bg-rose-600 px-2.5 py-1 text-xs font-semibold">
                <AlertTriangle className="h-3.5 w-3.5 shrink-0" /> {a.substance}
              </span>
            ))}
          </div>
        )}

        <div className="ml-auto flex items-center gap-3">
          {!locked && (
            <span className="hidden items-center gap-1.5 text-xs text-white/75 sm:flex">
              <span className={cn("h-1.5 w-1.5 rounded-full",
                save === "saving" ? "animate-pulse bg-amber-300" : save === "saved" ? "bg-emerald-400" : "bg-white/40")} />
              {save === "saving" ? "Saving…" : savedAt ? `Saved ${hhmm(savedAt)}` : "Not saved yet"}
            </span>
          )}
          {children}
        </div>
      </div>
    </div>
  );
}

/** Where am I? — the question the old rail could not answer.
 *
 *  Clicking a link scrolled somewhere and then the rail forgot about it, so halfway
 *  down a long consultation the doctor had no idea which part they were in. It now
 *  follows the scroll: the section on screen is lit, in that section's own colour, and
 *  the tick says whether it has anything in it. */
function useActiveSection(ids: string[]): string {
  const [active, setActive] = useState(ids[0] ?? "");
  useEffect(() => {
    const seen = new Map<string, number>();
    const io = new IntersectionObserver(
      (entries) => {
        for (const e of entries) seen.set(e.target.id, e.intersectionRatio);
        // The most-visible section wins, so a short one sandwiched between two long
        // ones does not flicker the rail as it scrolls past.
        let best = "", ratio = 0;
        for (const [id, r] of seen) if (r > ratio) { best = id; ratio = r; }
        if (best) setActive(best);
      },
      // The band excludes the sticky header, or the section hidden behind it wins.
      { rootMargin: "-140px 0px -55% 0px", threshold: [0, 0.25, 0.5, 1] },
    );
    ids.forEach((id) => { const el = document.getElementById(id); if (el) io.observe(el); });
    return () => io.disconnect();
  }, [ids.join(",")]); // eslint-disable-line react-hooks/exhaustive-deps
  return active;
}

function ProgressRail({ done, missing, active }: {
  done: Record<string, boolean>; missing: string[]; active: string;
}) {
  return (
    <Card className="sticky top-36 hidden h-fit p-3 lg:block">
      <nav className="space-y-0.5 text-sm">
        {SECTION_TONES.map((t) => {
          const on = active === t.id;
          return (
            <a key={t.id} href={`#${t.id}`}
              className={cn("flex items-center gap-2 rounded-md px-2.5 py-1.5 transition-colors",
                on ? cn("font-medium", t.active) : "text-muted-foreground hover:bg-muted hover:text-foreground")}>
              <span className={cn("h-6 w-1 shrink-0 rounded-full", on ? t.bar : "bg-transparent")} />
              <span className={cn("grid h-5 w-5 shrink-0 place-items-center rounded-md", on ? t.chip : "text-muted-foreground")}>
                <t.Icon className="h-3.5 w-3.5" />
              </span>
              <span className="min-w-0 flex-1 truncate">{t.short}</span>
              {done[t.id] && <Check className="h-3.5 w-3.5 shrink-0 text-emerald-600" />}
            </a>
          );
        })}
        {DEFERRED.map((d) => (
          <span key={d} className="flex items-center gap-2 px-2.5 py-1.5 pl-[1.4rem] text-muted-foreground/40">{d}</span>
        ))}
      </nav>
      <div className="mt-3 border-t pt-3">
        {missing.length === 0 ? (
          <p className="flex items-start gap-1.5 text-xs font-medium text-emerald-700">
            <Check className="mt-px h-3.5 w-3.5 shrink-0" /> Ready to sign
          </p>
        ) : (
          <>
            <p className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">Before signing</p>
            <ul className="mt-1 space-y-0.5">
              {missing.map((m) => (
                <li key={m} className="flex items-start gap-1.5 text-xs text-amber-700">
                  <AlertTriangle className="mt-px h-3 w-3 shrink-0" />{m}
                </li>
              ))}
            </ul>
          </>
        )}
      </div>
    </Card>
  );
}

function DiagnosisPicker({ ws, locked, onChanged }: { ws: Workspace; locked: boolean; onChanged: () => void }) {
  const [term, setTerm] = useState("");
  // What this patient keeps coming back with. A follow-up for a known condition is the
  // commonest consultation there is, and typing "Type 2 diabetes mellitus" into a
  // search box for the fifth time is work the record could have saved.
  const story = useQuery({
    queryKey: ["story", ws.patient.patient_id],
    queryFn: () => patientStory(ws.patient.patient_id),
    enabled: !locked,
  });
  const results = useQuery({
    queryKey: ["catalog", term],
    queryFn: () => searchCatalog({ search: term }),
    enabled: term.trim().length > 0 && !locked,
  });
  const add = useMutation({
    mutationFn: (e: CatalogEntry) => addDiagnosis(ws.encounter_id, { catalog_id: e.id, is_primary: ws.diagnoses.length === 0 }),
    onSuccess: () => { setTerm(""); onChanged(); },
    onError: () => toast.error("Could not add diagnosis"),
  });
  const remove = useMutation({
    mutationFn: (id: string) => removeDiagnosis(ws.encounter_id, id),
    onSuccess: onChanged,
  });
  // Adding a past problem goes through the catalogue rather than free text, so the
  // repeat diagnosis is the same coded entry as the original — otherwise the problem
  // list quietly splits into two spellings of the same condition.
  const addByName = useMutation({
    mutationFn: async (description: string) => {
      const found = await searchCatalog({ search: description });
      const exact = found.find((c) => c.name.toLowerCase() === description.toLowerCase()) ?? found[0];
      if (!exact) throw new Error("not in the catalogue");
      return addDiagnosis(ws.encounter_id, { catalog_id: exact.id, is_primary: ws.diagnoses.length === 0 });
    },
    onSuccess: onChanged,
    onError: () => toast.error("That diagnosis is no longer in the catalogue — search for it instead"),
  });

  return (
    <div className="space-y-2">
      <Label className="text-xs text-muted-foreground">Diagnosis (ICD-10)</Label>
      <div className="flex flex-wrap gap-2">
        {ws.diagnoses.map((d) => (
          <span key={d.id} className="flex items-center gap-1.5 rounded-full bg-primary/10 px-3 py-1 text-xs font-medium text-primary">
            {d.code ? `${d.code} ` : ""}{d.description}{d.is_primary ? " ·primary" : ""}
            {!locked && <button onClick={() => remove.mutate(d.id)} className="text-primary/60 hover:text-primary"><X className="h-3 w-3" /></button>}
          </span>
        ))}
        {ws.diagnoses.length === 0 && <span className="text-xs text-muted-foreground">No diagnosis yet.</span>}
      </div>

      {!locked && (() => {
        const already = new Set(ws.diagnoses.map((d) => d.description.toLowerCase()));
        const seen = (story.data?.problems ?? [])
          .filter((p) => p.recurring && !already.has(p.description.toLowerCase()))
          .slice(0, 4);
        if (seen.length === 0) return null;
        return (
          <div className="rounded-md border border-dashed bg-muted/30 px-2.5 py-2">
            <p className="text-[11px] text-muted-foreground">Seen before for — tap to add</p>
            <div className="mt-1.5 flex flex-wrap gap-1.5">
              {seen.map((p) => (
                <button key={p.description} type="button" disabled={addByName.isPending}
                  onClick={() => addByName.mutate(p.description)}
                  className="touch-hit rounded-full border bg-card px-2.5 py-1 text-xs font-medium transition-colors hover:border-primary hover:text-primary disabled:opacity-50">
                  {p.description} <span className="text-muted-foreground">×{p.times}</span>
                </button>
              ))}
            </div>
          </div>
        );
      })()}
      {!locked && (
        <div className="relative">
          <Input placeholder="Search diagnoses…" value={term} onChange={(e) => setTerm(e.target.value)} />
          {term.trim() && (results.data?.length ?? 0) > 0 && (
            <div className="absolute z-20 mt-1 max-h-64 w-full overflow-auto rounded-md border bg-background shadow-md">
              {(results.data ?? []).map((e) => (
                <button key={e.id} onClick={() => add.mutate(e)} className="flex w-full items-center justify-between px-3 py-2 text-left text-sm hover:bg-muted">
                  <span>{e.code ? <span className="font-mono text-xs text-muted-foreground">{e.code} </span> : null}{e.name}</span>
                  <span className="text-xs text-muted-foreground">{e.category_name}</span>
                </button>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function LabOrders({ ws, locked }: { ws: Workspace; locked: boolean }) {
  const { can, flagOn } = useAuth();
  const qc = useQueryClient();
  const enabled = flagOn("laboratory");
  const canOrder = can("lab.order");
  const [open, setOpen] = useState(false);
  const [priority, setPriority] = useState("routine");
  const [note, setNote] = useState("");
  const [picked, setPicked] = useState<Record<string, boolean>>({});

  const orders = useQuery({
    queryKey: ["enc-labs", ws.encounter_id],
    queryFn: () => encounterLabs(ws.encounter_id),
    enabled,
  });
  const tests = useQuery({ queryKey: ["lab-tests-active"], queryFn: () => listTests(true), enabled: enabled && open });

  const place = useMutation({
    mutationFn: () =>
      createOrder({
        encounter_id: ws.encounter_id,
        patient_id: ws.patient.patient_id,
        priority,
        clinical_note: note,
        test_ids: Object.keys(picked).filter((k) => picked[k]),
      }),
    onSuccess: () => {
      toast.success("Lab order placed");
      setOpen(false);
      setPicked({});
      setNote("");
      setPriority("routine");
      qc.invalidateQueries({ queryKey: ["enc-labs", ws.encounter_id] });
    },
    onError: (e) => toast.error(e instanceof AppError ? e.message : "Could not place order"),
  });

  if (!enabled) return null;
  const pickedCount = Object.values(picked).filter(Boolean).length;
  // Name what is critical. "Critical lab value returned — review below" made the
  // doctor go and find it; the analyte and its value are what they were going to look
  // for anyway, so say them.
  const criticals = (orders.data ?? []).flatMap((o) =>
    o.items.flatMap((it) => it.results.filter((r) => r.flag === "critical").map((r) => ({ test: it.test_name, r }))));
  const pending = (orders.data ?? []).flatMap((o) => o.items).filter((it) => it.status !== "validated").length;

  return (
    <WorkSection id="lab"
      done={(orders.data?.length ?? 0) > 0}
      count={(orders.data?.length ?? 0) > 0
        ? `${(orders.data ?? []).flatMap((o) => o.items).length} test${(orders.data ?? []).flatMap((o) => o.items).length === 1 ? "" : "s"}${pending ? ` · ${pending} awaiting` : ""}`
        : undefined}
      action={!locked && canOrder && (
        <Button size="sm" variant="outline" onClick={() => setOpen(true)}>
          <FlaskConical className="h-3.5 w-3.5" /> Order labs
        </Button>
      )}>

      {criticals.length > 0 && (
        <div className="mb-3 rounded-lg border border-l-4 border-rose-300 border-l-rose-600 bg-rose-50 px-3 py-2.5">
          <p className="flex items-center gap-2 text-sm font-bold text-rose-900">
            <AlertTriangle className="h-4 w-4 shrink-0" />
            {criticals.length === 1 ? "A critical result has come back" : `${criticals.length} critical results have come back`}
          </p>
          <ul className="mt-1 space-y-0.5">
            {criticals.map(({ test, r }) => (
              <li key={`${test}-${r.analyte_id}`} className="text-sm text-rose-800">
                <span className="font-semibold tabular-nums">{r.name} {r.value}{r.unit ? ` ${r.unit}` : ""}</span>
                <span className="text-rose-700"> · {test}</span>
                {(r.ref_low || r.ref_high) && (
                  <span className="text-xs text-rose-600"> (normal {r.ref_low ?? "?"}–{r.ref_high ?? "?"})</span>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}

      {(orders.data?.length ?? 0) === 0 ? (
        <p className="rounded-md border border-dashed px-3 py-3 text-center text-sm text-muted-foreground">
          Nothing ordered for this visit.
        </p>
      ) : (
        <div className="space-y-3">
          {(orders.data ?? []).map((o) => (
            <div key={o.order_no} className="rounded-md border">
              <div className="flex items-center justify-between border-b bg-muted/30 px-3 py-1.5 text-xs">
                <span className="font-mono">Order L-{o.order_no}</span>
                <Badge variant="outline">{o.priority}</Badge>
              </div>
              <div className="divide-y">
                {o.items.map((it) => (
                  <div key={it.sample_no} className="px-3 py-2.5">
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-sm font-medium">{it.test_name}</span>
                      <Badge variant={it.status === "validated" ? "success" : "outline"} className="capitalize">
                        {it.status.replace("_", " ")}
                      </Badge>
                    </div>
                    {it.results.length > 0 && (
                      <ul className="mt-1.5 space-y-1">
                        {it.results.map((r) => {
                          const off = r.flag && r.flag !== "normal";
                          const crit = r.flag === "critical";
                          return (
                            <li key={r.analyte_id}
                              className={cn("flex flex-wrap items-baseline gap-x-2 rounded px-2 py-1 text-sm",
                                crit ? "bg-rose-50" : off ? "bg-amber-50/60" : "")}>
                              <span className="min-w-0 flex-1 truncate text-muted-foreground">{r.name}</span>
                              <span className={cn("shrink-0 tabular-nums",
                                crit ? "text-base font-bold text-rose-700" : off ? "font-semibold text-amber-800" : "font-medium")}>
                                {r.value || "—"}{r.value && r.unit ? ` ${r.unit}` : ""}
                              </span>
                              {(r.ref_low || r.ref_high) && (
                                <span className="shrink-0 text-[11px] text-muted-foreground">
                                  {r.ref_low ?? "?"}–{r.ref_high ?? "?"}
                                </span>
                              )}
                              {r.value && off && (
                                <Badge variant="outline" className={cn("shrink-0 text-[10px] uppercase", FLAG_CLS[r.flag])}>{r.flag}</Badge>
                              )}
                            </li>
                          );
                        })}
                      </ul>
                    )}
                    {it.results.length === 0 && it.status !== "validated" && (
                      <p className="mt-1 flex items-center gap-1.5 text-xs text-muted-foreground">
                        <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-cyan-500" /> With the lab…
                      </p>
                    )}
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      )}

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogHeader><DialogTitle>Order laboratory tests</DialogTitle></DialogHeader>
          <div className="space-y-3">
            <div className="flex items-center gap-2">
              <Label className="text-xs">Priority</Label>
              {["routine", "urgent", "stat"].map((p) => (
                <button
                  key={p}
                  onClick={() => setPriority(p)}
                  className={`rounded-full border px-3 py-1 text-xs capitalize ${priority === p ? "border-primary bg-primary/10 text-primary" : "text-muted-foreground"}`}
                >
                  {p}
                </button>
              ))}
            </div>
            <div className="max-h-60 space-y-1 overflow-auto rounded-md border p-1">
              {(tests.data ?? []).map((t) => (
                <label key={t.id} className="flex cursor-pointer items-center gap-2 rounded px-2 py-1.5 text-sm hover:bg-muted">
                  <input type="checkbox" checked={!!picked[t.id]} onChange={(e) => setPicked({ ...picked, [t.id]: e.target.checked })} />
                  <span className="font-mono text-xs text-muted-foreground">{t.code}</span>
                  <span>{t.name}</span>
                </label>
              ))}
              {(tests.data?.length ?? 0) === 0 && <p className="px-2 py-3 text-xs text-muted-foreground">No active tests in the catalog.</p>}
            </div>
            <Textarea rows={2} placeholder="Clinical note for the lab…" value={note} onChange={(e) => setNote(e.target.value)} />
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setOpen(false)}>Cancel</Button>
            <Button disabled={pickedCount === 0} loading={place.isPending} onClick={() => place.mutate()}>
              Order {pickedCount > 0 ? `(${pickedCount})` : ""}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </WorkSection>
  );
}

// External lab referrals — shown only when the clinic has no in-house lab module.
// Request tests → print for the patient → record the result they bring back.
function LabReferralPanel({ ws, locked, onChanged }: { ws: Workspace; locked: boolean; onChanged: () => void }) {
  const { flagOn, user } = useAuth();
  const clinic = useQuery({ queryKey: ["clinic"], queryFn: getClinic, retry: false });
  const branches = useQuery({ queryKey: ["branches"], queryFn: listBranches });
  const [requesting, setRequesting] = useState(false);
  const [resultFor, setResultFor] = useState<LabReferral | null>(null);
  const cancel = useMutation({ mutationFn: (id: string) => cancelLabReferral(id), onSuccess: onChanged });

  if (flagOn("laboratory")) return null; // the in-house lab module handles ordering

  const refs = ws.lab_referrals ?? [];
  const printReq = (r: LabReferral) => {
    const clinicName = clinic.data?.name || "Clinic";
    const branch = (branches.data ?? []).find((b) => b.id === ws.branch_id);
    printLabRequest({
      clinic: clinicName,
      clinicContact: [branch?.address, branch?.phone].filter(Boolean).join(" · ") || undefined,
      ref: `Lab ${r.id.slice(-6)}`,
      qrData: `LABREQ:${r.id}\n${clinicName}\n${ws.patient.name} ${ws.patient.mrn}`,
      patient: ws.patient.name, mrn: ws.patient.mrn, age: ws.patient.age, gender: ws.patient.gender,
      prescriber: user?.full_name, when: r.created_at,
      tests: r.tests.split("\n"), indication: r.indication,
    });
  };

  return (
    <div className="mt-4">
      <div className="mb-2 flex items-center justify-between">
        <h2 className="text-h3">Lab requests <span className="text-xs font-normal text-muted-foreground">· external lab</span></h2>
        {!locked && <Button size="sm" variant="outline" onClick={() => setRequesting(true)}><FlaskConical className="h-3.5 w-3.5" /> Request lab</Button>}
      </div>
      {refs.length === 0 ? (
        <p className="text-xs text-muted-foreground">No lab requested. Use “Request lab” to order tests the patient takes to an outside lab; record the result here when they return.</p>
      ) : (
        <div className="space-y-3">
          {refs.map((r) => (
            <div key={r.id} className="rounded-md border">
              <div className="flex items-center justify-between gap-2 border-b bg-muted/30 px-3 py-1.5 text-sm">
                <span className="font-medium">{r.tests.split("\n").filter(Boolean).join(", ")}</span>
                <Badge variant={r.status === "resulted" ? "success" : r.status === "cancelled" ? "outline" : "warning"}>{r.status}</Badge>
              </div>
              <div className="space-y-2 px-3 py-2 text-sm">
                {r.indication && <p className="text-xs text-muted-foreground">Indication: {r.indication}</p>}
                {r.status === "resulted" && (
                  <div className="rounded bg-muted/40 p-2 text-xs">
                    {(r.external_lab || r.resulted_at) && (
                      <p className="font-medium">{r.external_lab || "External lab"}{r.resulted_at ? ` · ${new Date(r.resulted_at).toLocaleDateString()}` : ""}</p>
                    )}
                    {r.result_summary && <p className="mt-0.5 whitespace-pre-wrap">{r.result_summary}</p>}
                    {(r.result_values?.length ?? 0) > 0 && (
                      <div className="overflow-x-auto">
                        {/* Phones: a long result value scrolls instead of overflowing the card (no width floor — this column is narrow on desktop too). */}
                        <table className="mt-1.5 w-full">
                          <tbody>
                            {r.result_values!.map((v, i) => (
                              <tr key={i}>
                                <td className="py-0.5 text-muted-foreground">{v.name}</td>
                                <td className="py-0.5 font-medium">{v.value}{v.unit ? ` ${v.unit}` : ""}</td>
                                <td className="py-0.5 text-muted-foreground">{v.ref || ""}</td>
                                <td className="py-0.5 text-right">{v.flag ? <Badge variant="outline">{v.flag}</Badge> : null}</td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    )}
                    {(r.result_files?.length ?? 0) > 0 && (
                      <div className="mt-1.5 flex flex-wrap gap-2">
                        {r.result_files!.map((f, i) => (
                          <a key={i} href={f.url} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 rounded border bg-background px-2 py-0.5 text-primary hover:underline">
                            <Printer className="h-3 w-3" /> {f.name}
                          </a>
                        ))}
                      </div>
                    )}
                  </div>
                )}
                {r.status !== "cancelled" && (
                  <div className="flex flex-wrap gap-2">
                    <Button size="sm" variant="outline" onClick={() => printReq(r)}><Printer className="h-3.5 w-3.5" /> Print request</Button>
                    {!locked && r.status === "requested" && (
                      <>
                        <Button size="sm" onClick={() => setResultFor(r)}>Record result</Button>
                        <Button size="sm" variant="ghost" className="text-destructive" onClick={() => cancel.mutate(r.id)}>Cancel</Button>
                      </>
                    )}
                    {!locked && r.status === "resulted" && <Button size="sm" variant="ghost" onClick={() => setResultFor(r)}>Edit result</Button>}
                  </div>
                )}
              </div>
            </div>
          ))}
        </div>
      )}
      {requesting && <RequestLabDialog encounterId={ws.encounter_id} onClose={() => setRequesting(false)} onDone={() => { setRequesting(false); onChanged(); }} />}
      {resultFor && <RecordResultDialog referral={resultFor} onClose={() => setResultFor(null)} onDone={() => { setResultFor(null); onChanged(); }} />}
    </div>
  );
}

function RequestLabDialog({ encounterId, onClose, onDone }: { encounterId: string; onClose: () => void; onDone: () => void }) {
  const [tests, setTests] = useState("");
  const [indication, setIndication] = useState("");
  const mut = useMutation({
    mutationFn: () => createLabReferral(encounterId, { tests, indication }),
    onSuccess: () => { toast.success("Lab request created — print it for the patient"); onDone(); },
    onError: (e) => toast.error(e instanceof AppError ? e.message : "Could not create the request"),
  });
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader><DialogTitle>Request external lab</DialogTitle></DialogHeader>
        <div className="space-y-3">
          <div className="space-y-1.5">
            <Label>Tests (one per line)</Label>
            <Textarea rows={4} value={tests} onChange={(e) => setTests(e.target.value)} placeholder={"CBC\nFasting blood sugar\nLipid panel"} />
          </div>
          <div className="space-y-1.5">
            <Label>Clinical indication</Label>
            <Input value={indication} onChange={(e) => setIndication(e.target.value)} placeholder="r/o anemia, ? diabetes" />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>Cancel</Button>
          <Button disabled={!tests.trim()} loading={mut.isPending} onClick={() => mut.mutate()}>Create request</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function RecordResultDialog({ referral, onClose, onDone }: { referral: LabReferral; onClose: () => void; onDone: () => void }) {
  const [externalLab, setExternalLab] = useState(referral.external_lab ?? "");
  const [summary, setSummary] = useState(referral.result_summary ?? "");
  const [rows, setRows] = useState<ReferralValue[]>(referral.result_values ?? []);
  const [files, setFiles] = useState<ReferralFile[]>(referral.result_files ?? []);
  const [uploading, setUploading] = useState(false);
  const setRow = (i: number, p: Partial<ReferralValue>) => setRows((rs) => rs.map((r, j) => (j === i ? { ...r, ...p } : r)));
  const filled = rows.filter((r) => r.name.trim() || r.value.trim());
  const empty = !summary.trim() && filled.length === 0 && files.length === 0;

  const onPickFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = ""; // allow re-selecting the same file
    if (!file) return;
    setUploading(true);
    try {
      const target = await signReferralUpload(referral.id, { filename: file.name, type: file.type.startsWith("image/") ? "image" : "raw" });
      const f = await uploadToTarget(target, file);
      setFiles((fs) => [...fs, f]);
    } catch (err) {
      toast.error(err instanceof AppError ? err.message : "Could not attach the file");
    } finally {
      setUploading(false);
    }
  };

  const mut = useMutation({
    mutationFn: () => recordLabReferralResult(referral.id, { summary, external_lab: externalLab, values: filled, files }),
    onSuccess: () => { toast.success("Result saved"); onDone(); },
    onError: (e) => toast.error(e instanceof AppError ? e.message : "Could not save the result"),
  });
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-xl">
        <DialogHeader><DialogTitle>Record lab result</DialogTitle></DialogHeader>
        <p className="text-xs text-muted-foreground">For: {referral.tests.split("\n").filter(Boolean).join(", ")}</p>
        <div className="grid grid-cols-2 gap-3">
          <div className="space-y-1.5"><Label>External lab</Label><Input value={externalLab} onChange={(e) => setExternalLab(e.target.value)} placeholder="St. Gabriel Lab" /></div>
        </div>
        <div className="space-y-1.5"><Label>Summary / interpretation</Label><Textarea rows={3} value={summary} onChange={(e) => setSummary(e.target.value)} placeholder="Key findings…" /></div>
        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <Label className="text-xs text-muted-foreground">Values (optional)</Label>
            <Button size="sm" variant="ghost" onClick={() => setRows((rs) => [...rs, { name: "", value: "" }])}><Plus className="h-3.5 w-3.5" /> Add row</Button>
          </div>
          {rows.map((r, i) => (
            <div key={i} className="flex items-center gap-1.5">
              <Input className="h-8 flex-1" placeholder="Test" value={r.name} onChange={(e) => setRow(i, { name: e.target.value })} />
              <Input className="h-8 w-20" placeholder="Value" value={r.value} onChange={(e) => setRow(i, { value: e.target.value })} />
              <Input className="h-8 w-16" placeholder="Unit" value={r.unit ?? ""} onChange={(e) => setRow(i, { unit: e.target.value })} />
              <Input className="h-8 w-24" placeholder="Ref" value={r.ref ?? ""} onChange={(e) => setRow(i, { ref: e.target.value })} />
              <Input className="h-8 w-16" placeholder="Flag" value={r.flag ?? ""} onChange={(e) => setRow(i, { flag: e.target.value })} />
              <button onClick={() => setRows((rs) => rs.filter((_, j) => j !== i))} className="text-muted-foreground hover:text-destructive"><X className="h-4 w-4" /></button>
            </div>
          ))}
        </div>
        <div className="space-y-1.5">
          <Label className="text-xs text-muted-foreground">Attachments (scanned report)</Label>
          {files.length > 0 && (
            <ul className="space-y-1">
              {files.map((f, i) => (
                <li key={i} className="flex items-center justify-between gap-2 rounded-md border bg-background px-2 py-1 text-sm">
                  <a href={f.url} target="_blank" rel="noreferrer" className="truncate text-primary hover:underline">{f.name}</a>
                  <button onClick={() => setFiles((fs) => fs.filter((_, j) => j !== i))} className="text-muted-foreground hover:text-destructive"><X className="h-4 w-4" /></button>
                </li>
              ))}
            </ul>
          )}
          <label className="inline-flex cursor-pointer items-center gap-2 rounded-md border px-3 py-1.5 text-sm text-muted-foreground hover:text-foreground">
            <Plus className="h-3.5 w-3.5" /> {uploading ? "Uploading…" : "Attach scan (image/PDF)"}
            <input type="file" accept="image/*,application/pdf" className="hidden" disabled={uploading} onChange={onPickFile} />
          </label>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>Cancel</Button>
          <Button disabled={empty} loading={mut.isPending} onClick={() => mut.mutate()}>Save result</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function PrescriptionPanel({ ws, locked, onChanged }: { ws: Workspace; locked: boolean; onChanged: () => void }) {
  const { user } = useAuth();
  const clinic = useQuery({ queryKey: ["clinic"], queryFn: getClinic, retry: false });
  const branches = useQuery({ queryKey: ["branches"], queryFn: listBranches });
  const [open, setOpen] = useState(false);

  const printScript = () => {
    const clinicName = clinic.data?.name || "Clinic";
    const branch = (branches.data ?? []).find((b) => b.id === ws.branch_id);
    const rxRef = `Rx ${ws.encounter_id.slice(-6)}`;
    return printPrescription({
      clinic: clinicName,
      clinicContact: [branch?.address, branch?.phone].filter(Boolean).join(" · ") || undefined,
      rxRef,
      // Verification payload — ties the paper script back to this exact encounter.
      qrData: `RX:${ws.encounter_id}\n${clinicName}\n${ws.patient.name} ${ws.patient.mrn}\n${new Date().toISOString().slice(0, 10)}`,
      patient: ws.patient.name,
      mrn: ws.patient.mrn,
      age: ws.patient.age,
      gender: ws.patient.gender,
      weightKg: ws.vitals[0]?.weight_kg,
      prescriber: user?.full_name,
      when: new Date().toISOString(),
      diagnoses: ws.diagnoses.map((d) => ({ code: d.code, description: d.description })),
      meds: ws.prescription,
    });
  };

  const remove = useMutation({ mutationFn: (id: string) => removeMedication(ws.encounter_id, id), onSuccess: onChanged });

  return (
    <WorkSection id="prescription"
      done={ws.prescription.length > 0}
      count={ws.prescription.length > 0
        ? `${ws.prescription.length} medicine${ws.prescription.length === 1 ? "" : "s"}`
        : undefined}
      action={
        <div className="flex items-center gap-2">
          {ws.prescription.length > 0 && (
            <Button size="sm" variant="outline" onClick={printScript}>
              <Printer className="h-3.5 w-3.5" /> Print
            </Button>
          )}
          {!locked && (
            <Button size="sm" variant="outline" onClick={() => setOpen(true)}>
              <Plus className="h-3.5 w-3.5" /> Add medication
            </Button>
          )}
        </div>
      }>
      {ws.prescription.length === 0 ? (
        <p className="rounded-md border border-dashed px-3 py-3 text-center text-sm text-muted-foreground">
          Nothing prescribed at this visit.
        </p>
      ) : (
        <ul className="space-y-2">
          {ws.prescription.map((m) => {
            const clash = (m.allergens?.length ?? 0) > 0 || !!m.allergy_override;
            return (
              <li key={m.id}
                className={cn("relative overflow-hidden rounded-lg border px-3 py-2.5",
                  clash ? "border-l-4 border-l-rose-500 bg-rose-50/50" : "bg-card")}>
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    {/* The drug is what a pharmacist and a patient both look for first,
                        so it is not buried mid-sentence between dots any more. */}
                    <p className="font-semibold leading-tight">{m.drug_name}</p>
                    <div className="mt-1 flex flex-wrap gap-1">
                      {[m.dose, m.frequency, m.duration].filter(Boolean).map((bit) => (
                        <span key={bit} className="rounded bg-muted px-1.5 py-0.5 text-xs text-foreground/80">{bit}</span>
                      ))}
                    </div>
                    {m.instructions ? <p className="mt-1 text-xs text-muted-foreground">{m.instructions}</p> : null}
                    {clash && (
                      <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
                        {(m.allergens ?? []).map((a) => (
                          <Badge key={a} variant="destructive" className="gap-1 text-[10px]">
                            <AlertTriangle className="h-3 w-3" />Allergic to {a}
                          </Badge>
                        ))}
                        {m.allergy_override && (
                          <span className="text-xs font-medium text-rose-700">Given anyway — {m.allergy_override}</span>
                        )}
                      </div>
                    )}
                  </div>
                  {!locked && (
                    <button onClick={() => remove.mutate(m.id)} aria-label={`Remove ${m.drug_name}`}
                      className="touch-hit shrink-0 rounded-md p-1 text-muted-foreground transition-colors hover:bg-destructive/10 hover:text-destructive">
                      <X className="h-4 w-4" />
                    </button>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      )}

      {open && <AddMedicationDialog encounterId={ws.encounter_id} onClose={() => setOpen(false)} onAdded={onChanged} />}
    </WorkSection>
  );
}

const BLANK_MED = { drug_name: "", dose: "", frequency: "", duration: "", instructions: "" };

// Library-aware Add medication: search the drug library (auto-fills the sig),
// edit anything before adding, create a drug inline if it's not there, and get an
// overridable allergy warning when the drug clashes with the patient's allergies.
function AddMedicationDialog({ encounterId, onClose, onAdded }: { encounterId: string; onClose: () => void; onAdded: () => void }) {
  const [form, setForm] = useState({ ...BLANK_MED });
  const [drugId, setDrugId] = useState<string | undefined>();
  const [showResults, setShowResults] = useState(false);
  const [warn, setWarn] = useState("");
  const [reason, setReason] = useState("");
  const [creating, setCreating] = useState<string | null>(null); // drug name being created inline

  const drugs = useQuery({
    queryKey: ["drug-search", form.drug_name],
    queryFn: () => searchDrugs(form.drug_name),
    enabled: showResults && form.drug_name.trim().length > 0,
  });

  const set = (k: keyof typeof form, v: string) => setForm((f) => ({ ...f, [k]: v }));
  const onNameChange = (v: string) => {
    setForm((f) => ({ ...f, drug_name: v }));
    setDrugId(undefined); // free text until a library drug is picked
    setWarn("");
    setShowResults(true);
  };
  const pick = (d: Drug) => {
    setForm({ drug_name: d.name, dose: d.default_dose ?? "", frequency: d.default_frequency ?? "", duration: d.default_duration ?? "", instructions: d.default_instructions ?? "" });
    setDrugId(d.id);
    setShowResults(false);
    setWarn("");
  };

  const add = useMutation({
    mutationFn: () => addMedication(encounterId, { ...form, drug_id: drugId, override_reason: warn ? reason : undefined }),
    onSuccess: () => { onAdded(); onClose(); },
    onError: (e) => {
      if (e instanceof AppError && e.code === "ALLERGY_CONFLICT") setWarn(e.message);
      else toast.error(e instanceof AppError ? e.message : "Could not add medication");
    },
  });

  const results = (drugs.data ?? []).slice(0, 8);
  const exactMatch = results.some((d) => d.name.toLowerCase() === form.drug_name.trim().toLowerCase());

  if (creating !== null) {
    return <CreateDrugDialog initialName={creating} onClose={() => setCreating(null)} onCreated={(d) => { setCreating(null); pick(d); }} />;
  }

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader><DialogTitle>Add medication</DialogTitle></DialogHeader>
        <div className="grid grid-cols-2 gap-3">
          <div className="relative col-span-2 space-y-1.5">
            <Label>Drug</Label>
            <div className="relative">
              <Search className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                className="pl-8"
                value={form.drug_name}
                onChange={(e) => onNameChange(e.target.value)}
                onFocus={() => form.drug_name && setShowResults(true)}
                placeholder="Search the drug library…"
                autoFocus
              />
            </div>
            {showResults && form.drug_name.trim() && (
              <div className="absolute z-20 mt-1 max-h-64 w-full overflow-auto rounded-md border bg-background shadow-md">
                {results.map((d) => (
                  <button key={d.id} type="button" onClick={() => pick(d)} className="flex w-full items-start justify-between gap-2 px-3 py-2 text-left text-sm hover:bg-muted">
                    <span className="min-w-0">
                      <span className="inline-flex items-center gap-1.5 font-medium"><Pill className="h-3.5 w-3.5 text-brand" />{d.name}</span>
                      <span className="block truncate text-xs text-muted-foreground">{[d.default_dose, d.default_frequency, d.default_duration].filter(Boolean).join(" · ") || "no defaults"}</span>
                    </span>
                    {d.allergens.length > 0 && <Badge variant="warning" className="shrink-0 gap-1"><AlertTriangle className="h-3 w-3" />{d.allergens.join(", ")}</Badge>}
                  </button>
                ))}
                {!exactMatch && (
                  <button type="button" onClick={() => setCreating(form.drug_name.trim())} className="flex w-full items-center gap-2 border-t px-3 py-2 text-left text-sm text-primary hover:bg-muted">
                    <Plus className="h-4 w-4" /> Create “{form.drug_name.trim()}” in the library
                  </button>
                )}
                {results.length === 0 && exactMatch && <p className="px-3 py-2 text-xs text-muted-foreground">No matches.</p>}
              </div>
            )}
            {drugId && <p className="text-xs text-primary">From library — edit any field below before adding.</p>}
          </div>
          <div className="space-y-1.5"><Label>Dose</Label><Input value={form.dose} onChange={(e) => set("dose", e.target.value)} placeholder="1 tab" /></div>
          <div className="space-y-1.5"><Label>Frequency</Label><Input value={form.frequency} onChange={(e) => set("frequency", e.target.value)} placeholder="once daily" /></div>
          <div className="space-y-1.5"><Label>Duration</Label><Input value={form.duration} onChange={(e) => set("duration", e.target.value)} placeholder="3 days" /></div>
          <div className="col-span-2 space-y-1.5"><Label>Instructions</Label><Input value={form.instructions} onChange={(e) => set("instructions", e.target.value)} placeholder="Take after food" /></div>
        </div>

        {warn && (
          <div className="space-y-2 rounded-md border border-amber-300 bg-amber-50 px-3 py-2.5">
            <p className="flex items-center gap-2 text-sm font-medium text-amber-800"><AlertTriangle className="h-4 w-4" /> {warn}</p>
            <Input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Reason to prescribe anyway (recorded)" className="bg-background" />
          </div>
        )}

        <DialogFooter>
          <Button variant="outline" onClick={onClose}>Cancel</Button>
          {warn ? (
            <Button className="bg-amber-600 hover:bg-amber-600/90" disabled={!reason.trim()} loading={add.isPending} onClick={() => add.mutate()}>
              Prescribe anyway
            </Button>
          ) : (
            <Button disabled={!form.drug_name.trim()} loading={add.isPending} onClick={() => add.mutate()}>Add</Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// Inline drug creation from the prescription flow — saves to the library (with
// allergen tags) and hands the created drug back so the doctor keeps prescribing.
