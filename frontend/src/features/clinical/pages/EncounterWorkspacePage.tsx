import { useEffect, useRef, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, CalendarCheck, CalendarPlus, Check, FlaskConical, PauseCircle, Pencil, Pill, Plus, Printer, Search, X } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Textarea } from "@/components/ui/textarea";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { toast } from "@/components/ui/sonner";
import { AppError } from "@/lib/api-client";
import { useAuth } from "@/app/auth-context";
import { getClinic, getSettings, listBranches } from "@/features/admin/api";
import { printPrescription } from "@/features/clinical/print";
import { DictateButton } from "@/features/clinical/components/DictateButton";
import { bookAppointment, listAppointments, markFollowup, rescheduleAppointment, setAppointmentStatus, transitionQueue } from "@/features/scheduling/api";
import { createOrder, encounterLabs, listTests } from "@/features/lab/api";
import {
  addDiagnosis,
  addMedication,
  createAllergen,
  createDrug,
  getVitalFields,
  getWorkspace,
  listHistory,
  openEncounter,
  removeDiagnosis,
  removeMedication,
  listAllergens,
  saveNote,
  searchCatalog,
  searchDrugs,
  setAside,
  signEncounter,
  vitalFlag,
  type CatalogEntry,
  type Drug,
  type HistoryItem,
  type VitalField,
  type Vitals,
  type Workspace,
} from "@/features/clinical/api";

const SECTIONS = [
  { id: "subjective", label: "Subjective" },
  { id: "objective", label: "Objective / Vitals" },
  { id: "assessment", label: "Assessment / Dx" },
  { id: "plan", label: "Plan" },
  { id: "lab", label: "Orders / Lab" },
  { id: "prescription", label: "Prescription" },
];
const DEFERRED = ["Attachments"];

const FLAG_CLS: Record<string, string> = {
  normal: "border-emerald-200 bg-emerald-50 text-emerald-700",
  low: "border-sky-300 bg-sky-50 text-sky-700",
  high: "border-amber-300 bg-amber-50 text-amber-700",
  critical: "border-rose-300 bg-rose-50 text-rose-700",
};

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
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Cancel any pending auto-save on unmount (e.g. after sign navigates away).
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);

  const setField = (k: keyof typeof soap, v: string) => {
    if (locked) return;
    const next = { ...soapRef.current, [k]: v };
    setSoap(next);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(async () => {
      try {
        await saveNote(ws.encounter_id, next);
        setSavedAt(new Date().toISOString());
      } catch {
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

  return (
    <div className="space-y-4">
      {/* Banner */}
      <div className="flex flex-wrap items-center gap-4 rounded-xl bg-brand px-5 py-4 text-white">
        <div className="flex h-11 w-11 items-center justify-center rounded-full bg-white/15 text-sm font-semibold">{initials(ws.patient.name)}</div>
        <div className="min-w-0">
          <p className="text-lg font-semibold leading-tight">{ws.patient.name}</p>
          <p className="text-xs text-white/70">
            MRN {ws.patient.mrn} · {ws.patient.age}{ws.patient.gender ? ws.patient.gender[0].toUpperCase() : ""}
            {ws.patient.blood_group ? ` · ${ws.patient.blood_group}` : ""}
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          {ws.allergies.map((a) => (
            <span key={a.substance} className="flex items-center gap-1 rounded-full bg-rose-600 px-3 py-1 text-xs font-semibold">
              <AlertTriangle className="h-3.5 w-3.5" /> Allergy: {a.substance}
            </span>
          ))}
        </div>
        <div className="ml-auto text-right text-xs text-white/70">
          <p>Encounter {ws.encounter_id.slice(-6)}</p>
          <p>Started {hhmm(ws.started_at)}</p>
        </div>
      </div>

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

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-[180px_1fr_240px]">
        {/* Left rail */}
        <Card className="hidden h-fit p-3 lg:block">
          <nav className="space-y-1 text-sm">
            {SECTIONS.map((s) => (
              <a key={s.id} href={`#${s.id}`} className="block rounded-md px-3 py-1.5 text-muted-foreground hover:bg-muted hover:text-foreground">
                {s.label}
              </a>
            ))}
            {DEFERRED.map((d) => (
              <span key={d} className="block cursor-not-allowed rounded-md px-3 py-1.5 text-muted-foreground/40">{d}</span>
            ))}
          </nav>
          <p className="mt-4 px-3 text-xs text-emerald-600">{savedAt ? `Auto-saved ${hhmm(savedAt)}` : "Not saved yet"}</p>
        </Card>

        {/* Center */}
        <div className="space-y-5">
          <section id="subjective">
            <SectionHead title="Subjective">{!locked && <DictateButton onText={(t) => appendField("subjective", t)} />}</SectionHead>
            <Textarea rows={4} placeholder="Chief complaint, history…" value={soap.subjective} disabled={locked} onChange={(e) => setField("subjective", e.target.value)} />
          </section>

          <section id="objective">
            <SectionHead title="Objective / Vitals">{!locked && <DictateButton onText={(t) => appendField("objective", t)} />}</SectionHead>
            {latest ? (
              <div className="mb-3">
                <VitalsGrid vitals={latest} fields={vfields.data ?? []} />
              </div>
            ) : (
              <p className="mb-3 text-xs text-muted-foreground">No vitals recorded at triage.</p>
            )}
            <Textarea rows={3} placeholder="Examination findings…" value={soap.objective} disabled={locked} onChange={(e) => setField("objective", e.target.value)} />
          </section>

          <section id="assessment">
            <SectionHead title="Assessment / Diagnosis">{!locked && <DictateButton onText={(t) => appendField("assessment", t)} />}</SectionHead>
            <Textarea rows={3} className="mb-3" placeholder="Clinical assessment…" value={soap.assessment} disabled={locked} onChange={(e) => setField("assessment", e.target.value)} />
            <DiagnosisPicker ws={ws} locked={locked} onChanged={onChanged} />
          </section>

          <section id="plan">
            <SectionHead title="Plan">{!locked && <DictateButton onText={(t) => appendField("plan", t)} />}</SectionHead>
            <Textarea rows={3} placeholder="Plan, advice, follow-up…" value={soap.plan} disabled={locked} onChange={(e) => setField("plan", e.target.value)} />
          </section>

          <section id="lab">
            <LabOrders ws={ws} locked={locked} />
          </section>

          <section id="prescription">
            <PrescriptionPanel ws={ws} locked={locked} onChanged={onChanged} />
          </section>

          {!locked && <FollowUp ws={ws} />}

          {!locked && (
            <div className="flex justify-end gap-2">
              {ws.status === "open" && (
                <Button variant="outline" loading={park.isPending} onClick={() => park.mutate()}>
                  <PauseCircle className="h-4 w-4" /> Set aside (awaiting results)
                </Button>
              )}
              <Button className="bg-primary" loading={sign.isPending} onClick={() => setConfirmSign(true)}>
                <Check /> Sign &amp; close
              </Button>
            </div>
          )}
        </div>

        {/* Right rail — patient history timeline */}
        <HistoryPanel patientId={ws.patient.patient_id} />
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
  const provider = ws.provider_id || user?.id;
  const [date, setDate] = useState("");
  const [editing, setEditing] = useState(false);
  const [confirmCancel, setConfirmCancel] = useState(false);

  // Look for an existing upcoming follow-up for this patient + provider, so the
  // doctor can't silently double-book and can fix a wrong date.
  const fromISO = new Date().toISOString();
  const toISO = new Date(Date.now() + 365 * 86_400_000).toISOString();
  const existingQ = useQuery({
    queryKey: ["followup", ws.patient.patient_id, provider],
    queryFn: () => listAppointments(ws.branch_id, fromISO, toISO, provider),
    enabled: !!provider,
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
  const invalidate = () => qc.invalidateQueries({ queryKey: ["followup", ws.patient.patient_id, provider] });

  const book = useMutation({
    mutationFn: async () => {
      if (!provider) throw new Error("no provider on this encounter");
      const startsAt = new Date(`${date}T09:00:00`).toISOString();
      const appt = await bookAppointment({
        branch_id: ws.branch_id, patient_id: ws.patient.patient_id, provider_id: provider,
        department_id: ws.department_id || undefined, starts_at: startsAt, duration_min: 30, reason: "Follow-up",
      });
      await markFollowup(appt.id, freeUntilFor(startsAt));
    },
    onSuccess: () => { toast.success("Follow-up booked"); setDate(""); invalidate(); },
    onError: () => toast.error("Could not book the follow-up"),
  });

  const reschedule = useMutation({
    mutationFn: async () => {
      if (!existing || !provider) throw new Error("nothing to reschedule");
      const startsAt = new Date(`${date}T09:00:00`).toISOString();
      await rescheduleAppointment(existing.id, {
        provider_id: provider, department_id: ws.department_id || undefined, starts_at: startsAt, duration_min: 30, reason: "Follow-up",
      });
      await markFollowup(existing.id, freeUntilFor(startsAt)); // re-anchor the free window
    },
    onSuccess: () => { toast.success("Follow-up moved"); setEditing(false); setDate(""); invalidate(); },
    onError: () => toast.error("Could not move the follow-up"),
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
        <h2 className="mb-3 text-h3">Follow-up</h2>
        <div className="rounded-lg border border-primary/30 bg-primary/5 p-4">
          <div className="flex items-start gap-3">
            <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-primary/15 text-primary">
              <CalendarCheck className="h-5 w-5" />
            </div>
            <div className="min-w-0 flex-1">
              <p className="text-xs font-medium uppercase tracking-wide text-primary">Follow-up booked</p>
              <p className="font-semibold text-brand">{fmtDate(existing.starts_at)}</p>
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
      <h2 className="mb-2 text-h3">Follow-up</h2>
      {existingQ.isLoading ? (
        <p className="text-xs text-muted-foreground">Checking for an existing follow-up…</p>
      ) : (
        <>
          {editing && <p className="mb-2 text-xs text-muted-foreground">Pick a new date for this follow-up.</p>}
          <div className="flex flex-wrap items-end gap-3">
            <div className="space-y-1.5">
              <Label>Date</Label>
              <Input type="date" min={new Date().toISOString().slice(0, 10)} value={date} onChange={(e) => setDate(e.target.value)} />
            </div>
            <Button variant="outline" disabled={!date} loading={book.isPending || reschedule.isPending} onClick={onSubmit}>
              {existing ? <><CalendarCheck className="h-4 w-4" /> Save new date</> : <><CalendarPlus className="h-4 w-4" /> Book follow-up</>}
            </Button>
            {editing && (
              <Button variant="ghost" onClick={() => { setEditing(false); setDate(""); }}>Keep current</Button>
            )}
          </div>
          <p className="mt-2 text-xs text-muted-foreground">
            A doctor-booked follow-up is free of the card fee when the patient attends within the clinic's window.
          </p>
        </>
      )}
    </Card>
  );
}

function HistoryPanel({ patientId }: { patientId: string }) {
  const history = useQuery({ queryKey: ["history", patientId], queryFn: () => listHistory(patientId) });
  const [open, setOpen] = useState<HistoryItem | null>(null);
  return (
    <Card className="hidden h-fit p-4 lg:block">
      <h3 className="mb-3 text-h3">History</h3>
      {(history.data?.length ?? 0) === 0 ? (
        <p className="text-xs text-muted-foreground">No past visits.</p>
      ) : (
        <ol className="space-y-2">
          {(history.data ?? []).map((h) => (
            <li key={h.id}>
              <button
                onClick={() => setOpen(h)}
                className="w-full rounded-md border-l-2 border-primary/30 py-1 pl-3 pr-2 text-left transition-colors hover:bg-muted"
              >
                <p className="text-xs font-semibold text-brand">
                  {new Date(h.started_at).toLocaleDateString(undefined, { day: "2-digit", month: "short", year: "numeric" })}
                </p>
                <p className="text-xs text-muted-foreground">
                  {h.type}
                  {h.provider_name ? ` · ${h.provider_name}` : ""}
                </p>
                {h.primary_dx ? <p className="truncate text-xs">{h.primary_dx}</p> : null}
              </button>
            </li>
          ))}
        </ol>
      )}
      <p className="mt-3 text-[11px] text-muted-foreground">Click a visit to see the full record.</p>
      {open && <HistoryDetailDialog item={open} onClose={() => setOpen(null)} />}
    </Card>
  );
}

const STATUS_LABEL: Record<string, string> = { closed: "Signed", open: "In progress", awaiting_results: "Awaiting results" };

// HistoryDetailDialog opens a past visit in full: vitals (flagged), the SOAP note,
// diagnoses, prescription and lab results — everything that happened that day.
function HistoryDetailDialog({ item, onClose }: { item: HistoryItem; onClose: () => void }) {
  const { flagOn } = useAuth();
  const ws = useQuery({ queryKey: ["history-ws", item.id], queryFn: () => getWorkspace(item.id) });
  const vfields = useQuery({ queryKey: ["vital-fields"], queryFn: getVitalFields });
  const labs = useQuery({ queryKey: ["history-labs", item.id], queryFn: () => encounterLabs(item.id), enabled: flagOn("laboratory") });

  const d = ws.data;
  const note = d?.note;
  const soap: { label: string; text: string }[] = note
    ? [
        { label: "Subjective", text: note.subjective },
        { label: "Objective", text: note.objective },
        { label: "Assessment", text: note.assessment },
        { label: "Plan", text: note.plan },
      ].filter((s) => s.text?.trim())
    : [];

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-h-[85vh] max-w-2xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle>
            {new Date(item.started_at).toLocaleDateString(undefined, { weekday: "short", day: "2-digit", month: "long", year: "numeric" })}
          </DialogTitle>
        </DialogHeader>

        <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
          <span>{item.type}</span>
          {item.provider_name && <span>· {item.provider_name}</span>}
          {d && <Badge variant={d.status === "closed" ? "success" : "outline"}>{STATUS_LABEL[d.status] ?? d.status}</Badge>}
        </div>

        {ws.isLoading && <p className="py-6 text-center text-sm text-muted-foreground">Loading the visit…</p>}
        {ws.isError && <p className="py-6 text-center text-sm text-destructive">Could not load this visit.</p>}

        {d && (
          <div className="space-y-5">
            {d.vitals[0] && (
              <Section title="Vitals">
                <VitalsGrid vitals={d.vitals[0]} fields={vfields.data ?? []} />
              </Section>
            )}

            {soap.length > 0 && (
              <Section title="Note">
                <div className="space-y-2">
                  {soap.map((s) => (
                    <div key={s.label}>
                      <p className="text-xs font-semibold text-muted-foreground">{s.label}</p>
                      <p className="whitespace-pre-wrap text-sm">{s.text}</p>
                    </div>
                  ))}
                </div>
              </Section>
            )}

            <Section title="Diagnoses">
              {d.diagnoses.length === 0 ? (
                <p className="text-xs text-muted-foreground">None recorded.</p>
              ) : (
                <div className="flex flex-wrap gap-2">
                  {d.diagnoses.map((dx) => (
                    <span key={dx.id} className="rounded-full bg-primary/10 px-3 py-1 text-xs font-medium text-primary">
                      {dx.code ? `${dx.code} ` : ""}{dx.description}{dx.is_primary ? " · primary" : ""}
                    </span>
                  ))}
                </div>
              )}
            </Section>

            <Section title="Prescription">
              {d.prescription.length === 0 ? (
                <p className="text-xs text-muted-foreground">None prescribed.</p>
              ) : (
                <div className="divide-y rounded-md border">
                  {d.prescription.map((m) => (
                    <div key={m.id} className="px-3 py-2 text-sm">
                      <span className="font-medium">{m.drug_name}</span>
                      <span className="text-muted-foreground"> · {[m.dose, m.frequency, m.duration].filter(Boolean).join(" · ")}</span>
                      {m.instructions ? <p className="text-xs text-muted-foreground">{m.instructions}</p> : null}
                    </div>
                  ))}
                </div>
              )}
            </Section>

            {flagOn("laboratory") && (labs.data?.length ?? 0) > 0 && (
              <Section title="Labs">
                <div className="space-y-3">
                  {(labs.data ?? []).map((o) => (
                    <div key={o.order_no} className="rounded-md border">
                      <div className="flex items-center justify-between border-b bg-muted/30 px-3 py-1.5 text-xs">
                        <span className="font-mono">Order L-{o.order_no}</span>
                        <Badge variant="outline">{o.priority}</Badge>
                      </div>
                      <div className="divide-y">
                        {o.items.map((it) => (
                          <div key={it.sample_no} className="px-3 py-2">
                            <div className="flex items-center justify-between">
                              <span className="text-sm font-medium">{it.test_name}</span>
                              <Badge variant={it.status === "validated" ? "success" : "outline"}>{it.status.replace("_", " ")}</Badge>
                            </div>
                            {it.results.length > 0 && (
                              <table className="mt-1.5 w-full text-xs">
                                <tbody>
                                  {it.results.map((r) => (
                                    <tr key={r.analyte_id}>
                                      <td className="py-0.5 text-muted-foreground">{r.name}</td>
                                      <td className="py-0.5 font-medium">{r.value || "—"}{r.value && r.unit ? ` ${r.unit}` : ""}</td>
                                      <td className="py-0.5 text-right">
                                        {r.value ? <Badge variant="outline" className={FLAG_CLS[r.flag] ?? FLAG_CLS.normal}>{r.flag}</Badge> : null}
                                      </td>
                                    </tr>
                                  ))}
                                </tbody>
                              </table>
                            )}
                          </div>
                        ))}
                      </div>
                    </div>
                  ))}
                </div>
              </Section>
            )}
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div>
      <h4 className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground">{title}</h4>
      {children}
    </div>
  );
}

function SectionHead({ title, children }: { title: string; children?: React.ReactNode }) {
  return (
    <div className="mb-2 flex items-center justify-between gap-2">
      <h2 className="text-h3">{title}</h2>
      {children}
    </div>
  );
}

type Flag = "low" | "normal" | "high" | null;

function numOr(v: unknown): number | undefined {
  if (v == null || v === "") return undefined;
  const n = Number(v);
  return Number.isNaN(n) ? undefined : n;
}
// Combine two flags into the "most notable" one (abnormal wins over normal).
function worstFlag(a: Flag, b: Flag): Flag {
  for (const want of ["high", "low", "normal"] as const) {
    if (a === want || b === want) return want;
  }
  return null;
}

// VitalsGrid renders the five headline tiles with Low/Normal/High flags computed
// from the clinic's configured reference ranges (shared by the workspace + history).
function VitalsGrid({ vitals, fields }: { vitals: Vitals; fields: VitalField[] }) {
  const flagOf = (key: string, v: number | undefined): Flag => {
    const f = fields.find((x) => x.key === key);
    if (!f || v === undefined) return null;
    return vitalFlag(f, v);
  };
  const bp = worstFlag(flagOf("systolic", numOr(vitals.systolic)), flagOf("diastolic", numOr(vitals.diastolic)));
  return (
    <div className="grid grid-cols-2 gap-2 sm:grid-cols-5">
      <VitalCard label="Temp" value={vitals.temp_c ? `${vitals.temp_c} °C` : "—"} flag={flagOf("temp_c", numOr(vitals.temp_c))} />
      <VitalCard label="BP" value={vitals.systolic && vitals.diastolic ? `${vitals.systolic}/${vitals.diastolic}` : "—"} flag={bp} />
      <VitalCard label="HR" value={vitals.pulse ? String(vitals.pulse) : "—"} flag={flagOf("pulse", numOr(vitals.pulse))} />
      <VitalCard label="SpO₂" value={vitals.spo2 ? `${vitals.spo2}%` : "—"} flag={flagOf("spo2", numOr(vitals.spo2))} />
      <VitalCard label="Weight" value={vitals.weight_kg ? `${vitals.weight_kg} kg` : "—"} flag={flagOf("weight_kg", numOr(vitals.weight_kg))} />
    </div>
  );
}

function VitalCard({ label, value, flag }: { label: string; value: string; flag?: Flag }) {
  return (
    <div className="rounded-lg border bg-background p-3">
      <div className="flex items-center justify-between gap-1">
        <p className="text-xs text-muted-foreground">{label}</p>
        {flag && <span className={`rounded-full border px-1.5 text-[10px] font-medium capitalize ${FLAG_CLS[flag]}`}>{flag}</span>}
      </div>
      <p className="font-semibold text-brand">{value}</p>
    </div>
  );
}

function DiagnosisPicker({ ws, locked, onChanged }: { ws: Workspace; locked: boolean; onChanged: () => void }) {
  const [term, setTerm] = useState("");
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
      {!locked && (
        <div className="relative">
          <Input placeholder="Search diagnoses…" value={term} onChange={(e) => setTerm(e.target.value)} />
          {term.trim() && (results.data?.length ?? 0) > 0 && (
            <div className="absolute z-10 mt-1 max-h-64 w-full overflow-auto rounded-md border bg-background shadow-md">
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
  const hasCritical = (orders.data ?? []).some((o) => o.items.some((it) => it.results.some((r) => r.flag === "critical")));

  return (
    <div>
      <div className="mb-2 flex items-center justify-between">
        <h2 className="text-h3">Orders / Lab</h2>
        {!locked && canOrder && (
          <Button size="sm" variant="outline" onClick={() => setOpen(true)}>
            <FlaskConical className="h-3.5 w-3.5" /> Order labs
          </Button>
        )}
      </div>

      {hasCritical && (
        <div className="mb-2 flex items-center gap-2 rounded-md border border-rose-300 bg-rose-50 px-3 py-2 text-sm font-medium text-rose-800">
          <AlertTriangle className="h-4 w-4" /> Critical lab value returned — review below.
        </div>
      )}

      {(orders.data?.length ?? 0) === 0 ? (
        <p className="text-xs text-muted-foreground">No labs ordered.</p>
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
                  <div key={it.sample_no} className="px-3 py-2">
                    <div className="flex items-center justify-between">
                      <span className="text-sm font-medium">{it.test_name}</span>
                      <Badge variant={it.status === "validated" ? "success" : "outline"}>{it.status.replace("_", " ")}</Badge>
                    </div>
                    {it.results.length > 0 && (
                      <table className="mt-1.5 w-full text-xs">
                        <tbody>
                          {it.results.map((r) => (
                            <tr key={r.analyte_id}>
                              <td className="py-0.5 text-muted-foreground">{r.name}</td>
                              <td className="py-0.5 font-medium">{r.value || "—"}{r.value && r.unit ? ` ${r.unit}` : ""}</td>
                              <td className="py-0.5 text-right">
                                {r.value ? <Badge variant="outline" className={FLAG_CLS[r.flag] ?? FLAG_CLS.normal}>{r.flag}</Badge> : null}
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    )}
                    {it.results.length === 0 && it.status !== "validated" && (
                      <p className="mt-1 text-xs text-muted-foreground">Awaiting lab…</p>
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
    </div>
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
    <div>
      <div className="mb-2 flex items-center justify-between">
        <h2 className="text-h3">Prescription</h2>
        <div className="flex items-center gap-2">
          {ws.prescription.length > 0 && (
            <Button size="sm" variant="outline" onClick={printScript}>
              <Printer className="h-3.5 w-3.5" /> Print
            </Button>
          )}
          {!locked && (
            <Button size="sm" variant="outline" onClick={() => setOpen(true)}>
              <Plus /> Add medication
            </Button>
          )}
        </div>
      </div>
      {ws.prescription.length === 0 ? (
        <p className="text-xs text-muted-foreground">No medication prescribed.</p>
      ) : (
        <div className="divide-y rounded-md border">
          {ws.prescription.map((m) => (
            <div key={m.id} className="flex items-start justify-between gap-3 px-3 py-2 text-sm">
              <div className="min-w-0">
                <span className="font-medium">{m.drug_name}</span>
                <span className="text-muted-foreground"> · {[m.dose, m.frequency, m.duration].filter(Boolean).join(" · ")}</span>
                {m.instructions ? <p className="text-xs text-muted-foreground">{m.instructions}</p> : null}
                {((m.allergens?.length ?? 0) > 0 || m.allergy_override) && (
                  <div className="mt-1 flex flex-wrap items-center gap-1.5">
                    {(m.allergens ?? []).map((a) => (
                      <Badge key={a} variant="warning" className="gap-1"><AlertTriangle className="h-3 w-3" />{a}</Badge>
                    ))}
                    {m.allergy_override && (
                      <Badge variant="destructive" className="gap-1" title={m.allergy_override}>
                        Prescribed despite allergy
                      </Badge>
                    )}
                  </div>
                )}
              </div>
              {!locked && <button onClick={() => remove.mutate(m.id)} className="shrink-0 text-muted-foreground hover:text-destructive">Remove</button>}
            </div>
          ))}
        </div>
      )}

      {open && <AddMedicationDialog encounterId={ws.encounter_id} onClose={() => setOpen(false)} onAdded={onChanged} />}
    </div>
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
function CreateDrugDialog({ initialName, onClose, onCreated }: { initialName: string; onClose: () => void; onCreated: (d: Drug) => void }) {
  const qc = useQueryClient();
  const [form, setForm] = useState({ name: initialName, default_dose: "", default_frequency: "", default_duration: "", default_instructions: "" });
  const [allergenIds, setAllergenIds] = useState<string[]>([]);
  const [newAllergen, setNewAllergen] = useState("");
  const allergens = useQuery({ queryKey: ["allergens"], queryFn: () => listAllergens() });

  const set = (k: keyof typeof form, v: string) => setForm((f) => ({ ...f, [k]: v }));
  const toggle = (id: string) => setAllergenIds((ids) => (ids.includes(id) ? ids.filter((x) => x !== id) : [...ids, id]));

  const addAllergen = useMutation({
    mutationFn: () => createAllergen(newAllergen.trim()),
    onSuccess: (a) => { setNewAllergen(""); setAllergenIds((ids) => [...ids, a.id]); qc.invalidateQueries({ queryKey: ["allergens"] }); },
    onError: (e) => toast.error(e instanceof AppError ? e.message : "Could not add allergen"),
  });
  const create = useMutation({
    mutationFn: () => createDrug({ ...form, allergen_ids: allergenIds }),
    onSuccess: (d) => { qc.invalidateQueries({ queryKey: ["drug-search"] }); toast.success("Saved to the drug library"); onCreated(d); },
    onError: (e) => toast.error(e instanceof AppError ? e.message : "Could not create the drug"),
  });

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader><DialogTitle>New drug in library</DialogTitle></DialogHeader>
        <div className="grid grid-cols-2 gap-3">
          <div className="col-span-2 space-y-1.5"><Label>Name</Label><Input value={form.name} onChange={(e) => set("name", e.target.value)} placeholder="e.g. Amoxicillin 500mg" autoFocus /></div>
          <div className="space-y-1.5"><Label>Default dose</Label><Input value={form.default_dose} onChange={(e) => set("default_dose", e.target.value)} placeholder="1 cap" /></div>
          <div className="space-y-1.5"><Label>Default frequency</Label><Input value={form.default_frequency} onChange={(e) => set("default_frequency", e.target.value)} placeholder="three times a day" /></div>
          <div className="space-y-1.5"><Label>Default duration</Label><Input value={form.default_duration} onChange={(e) => set("default_duration", e.target.value)} placeholder="5 days" /></div>
          <div className="col-span-2 space-y-1.5"><Label>Default instructions</Label><Input value={form.default_instructions} onChange={(e) => set("default_instructions", e.target.value)} placeholder="Complete the full course" /></div>
        </div>
        <div className="space-y-2">
          <Label className="text-xs text-muted-foreground">Allergen tags (warns if the patient is allergic)</Label>
          <div className="flex flex-wrap gap-1.5">
            {(allergens.data ?? []).map((a) => (
              <button key={a.id} type="button" onClick={() => toggle(a.id)} className={`rounded-full border px-2.5 py-1 text-xs ${allergenIds.includes(a.id) ? "border-primary bg-primary/10 text-primary" : "text-muted-foreground hover:text-foreground"}`}>
                {a.name}
              </button>
            ))}
            {(allergens.data?.length ?? 0) === 0 && <span className="text-xs text-muted-foreground">No allergens yet — add one below.</span>}
          </div>
          <div className="flex items-end gap-2">
            <Input value={newAllergen} onChange={(e) => setNewAllergen(e.target.value)} placeholder="New allergen (e.g. Penicillin)" className="h-8" />
            <Button size="sm" variant="outline" disabled={!newAllergen.trim()} loading={addAllergen.isPending} onClick={() => addAllergen.mutate()}>Add</Button>
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>Back</Button>
          <Button disabled={!form.name.trim()} loading={create.isPending} onClick={() => create.mutate()}>Save &amp; use</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
