import { useRef, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, Check, Plus, X } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { toast } from "@/components/ui/sonner";
import { AppError } from "@/lib/api-client";
import { transitionQueue } from "@/features/scheduling/api";
import {
  addDiagnosis,
  addMedication,
  openEncounter,
  removeDiagnosis,
  removeMedication,
  saveNote,
  searchCatalog,
  signEncounter,
  type CatalogEntry,
  type Workspace,
} from "@/features/clinical/api";

const SECTIONS = [
  { id: "subjective", label: "Subjective" },
  { id: "objective", label: "Objective / Vitals" },
  { id: "assessment", label: "Assessment / Dx" },
  { id: "plan", label: "Plan" },
  { id: "prescription", label: "Prescription" },
];
const DEFERRED = ["Orders (Lab)", "Attachments"];

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
  const latest = ws.vitals[0];
  const [confirmSign, setConfirmSign] = useState(false);

  // SOAP local state + debounced auto-save.
  const [soap, setSoap] = useState({ subjective: ws.note.subjective, objective: ws.note.objective, assessment: ws.note.assessment, plan: ws.note.plan });
  const [savedAt, setSavedAt] = useState<string | null>(ws.note.status === "signed" ? ws.note.signed_at ?? null : null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const setField = (k: keyof typeof soap, v: string) => {
    if (locked) return;
    const next = { ...soap, [k]: v };
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

  const sign = useMutation({
    mutationFn: async () => {
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
            <h2 className="mb-2 text-h3">Subjective</h2>
            <Textarea rows={4} placeholder="Chief complaint, history…" value={soap.subjective} disabled={locked} onChange={(e) => setField("subjective", e.target.value)} />
          </section>

          <section id="objective">
            <h2 className="mb-2 text-h3">Objective / Vitals</h2>
            {latest ? (
              <div className="mb-3 grid grid-cols-2 gap-2 sm:grid-cols-5">
                <VitalCard label="Temp" value={latest.temp_c ? `${latest.temp_c} °C` : "—"} />
                <VitalCard label="BP" value={latest.systolic && latest.diastolic ? `${latest.systolic}/${latest.diastolic}` : "—"} />
                <VitalCard label="HR" value={latest.pulse ? String(latest.pulse) : "—"} />
                <VitalCard label="SpO₂" value={latest.spo2 ? `${latest.spo2}%` : "—"} />
                <VitalCard label="Weight" value={latest.weight_kg ? `${latest.weight_kg} kg` : "—"} />
              </div>
            ) : (
              <p className="mb-3 text-xs text-muted-foreground">No vitals recorded at triage.</p>
            )}
            <Textarea rows={3} placeholder="Examination findings…" value={soap.objective} disabled={locked} onChange={(e) => setField("objective", e.target.value)} />
          </section>

          <section id="assessment">
            <h2 className="mb-2 text-h3">Assessment / Diagnosis</h2>
            <Textarea rows={3} className="mb-3" placeholder="Clinical assessment…" value={soap.assessment} disabled={locked} onChange={(e) => setField("assessment", e.target.value)} />
            <DiagnosisPicker ws={ws} locked={locked} onChanged={onChanged} />
          </section>

          <section id="plan">
            <h2 className="mb-2 text-h3">Plan</h2>
            <Textarea rows={3} placeholder="Plan, advice, follow-up…" value={soap.plan} disabled={locked} onChange={(e) => setField("plan", e.target.value)} />
          </section>

          <section id="prescription">
            <PrescriptionPanel ws={ws} locked={locked} onChanged={onChanged} />
          </section>

          {!locked && (
            <div className="flex justify-end">
              <Button className="bg-primary" loading={sign.isPending} onClick={() => setConfirmSign(true)}>
                <Check /> Sign &amp; close
              </Button>
            </div>
          )}
        </div>

        {/* Right rail — patient history (full timeline arrives in 3b-2) */}
        <Card className="hidden h-fit p-4 lg:block">
          <h3 className="mb-2 text-h3">History</h3>
          <p className="text-xs text-muted-foreground">The patient history timeline lands in 3b-2.</p>
        </Card>
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

function VitalCard({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border bg-background p-3">
      <p className="text-xs text-muted-foreground">{label}</p>
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

function PrescriptionPanel({ ws, locked, onChanged }: { ws: Workspace; locked: boolean; onChanged: () => void }) {
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState({ drug_name: "", dose: "", frequency: "", duration: "", instructions: "" });
  const [blocked, setBlocked] = useState("");

  const add = useMutation({
    mutationFn: () => addMedication(ws.encounter_id, form),
    onSuccess: () => {
      setForm({ drug_name: "", dose: "", frequency: "", duration: "", instructions: "" });
      setBlocked("");
      setOpen(false);
      onChanged();
    },
    onError: (e) => {
      if (e instanceof AppError && e.code === "ALLERGY_CONFLICT") setBlocked(e.message);
      else toast.error("Could not add medication");
    },
  });
  const remove = useMutation({ mutationFn: (id: string) => removeMedication(ws.encounter_id, id), onSuccess: onChanged });

  return (
    <div>
      <div className="mb-2 flex items-center justify-between">
        <h2 className="text-h3">Prescription</h2>
        {!locked && (
          <Button size="sm" variant="outline" onClick={() => { setBlocked(""); setOpen(true); }}>
            <Plus /> Add medication
          </Button>
        )}
      </div>
      {ws.prescription.length === 0 ? (
        <p className="text-xs text-muted-foreground">No medication prescribed.</p>
      ) : (
        <div className="divide-y rounded-md border">
          {ws.prescription.map((m) => (
            <div key={m.id} className="flex items-center justify-between gap-3 px-3 py-2 text-sm">
              <div>
                <span className="font-medium">{m.drug_name}</span>
                <span className="text-muted-foreground"> · {[m.dose, m.frequency, m.duration].filter(Boolean).join(" · ")}</span>
                {m.instructions ? <p className="text-xs text-muted-foreground">{m.instructions}</p> : null}
              </div>
              {!locked && <button onClick={() => remove.mutate(m.id)} className="text-muted-foreground hover:text-destructive">Remove</button>}
            </div>
          ))}
        </div>
      )}

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Add medication</DialogTitle>
          </DialogHeader>
          <div className="grid grid-cols-2 gap-3">
            <div className="col-span-2 space-y-1.5">
              <Label>Drug</Label>
              <Input value={form.drug_name} onChange={(e) => setForm({ ...form, drug_name: e.target.value })} placeholder="e.g. Azithromycin 500mg" />
            </div>
            <div className="space-y-1.5"><Label>Dose</Label><Input value={form.dose} onChange={(e) => setForm({ ...form, dose: e.target.value })} placeholder="1 tab" /></div>
            <div className="space-y-1.5"><Label>Frequency</Label><Input value={form.frequency} onChange={(e) => setForm({ ...form, frequency: e.target.value })} placeholder="once daily" /></div>
            <div className="space-y-1.5"><Label>Duration</Label><Input value={form.duration} onChange={(e) => setForm({ ...form, duration: e.target.value })} placeholder="3 days" /></div>
            <div className="col-span-2 space-y-1.5"><Label>Instructions</Label><Input value={form.instructions} onChange={(e) => setForm({ ...form, instructions: e.target.value })} placeholder="Take after food" /></div>
          </div>
          {blocked && (
            <div className="flex items-center gap-2 rounded-md border border-rose-300 bg-rose-50 px-3 py-2 text-sm font-medium text-rose-700">
              <AlertTriangle className="h-4 w-4" /> {blocked}
            </div>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={() => setOpen(false)}>Cancel</Button>
            <Button disabled={!form.drug_name.trim()} loading={add.isPending} onClick={() => add.mutate()}>Add</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
