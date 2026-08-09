// The clinical examination record.
//
// The workspace already tracks what was DONE — a treatment plan's dated sessions,
// each with its procedure, notes, Rx and images. What it never had was the
// assessment behind it. Without that, the chart shows six fillings and no recorded
// reason for any of them: no chief complaint, no findings, no diagnosis. That is
// the difference between a billing history and a medical record.
//
// One examination per attendance, newest first. Deliberately not a per-session
// form: you take a full history and examination at a first visit, a new complaint
// or a recall, not every time you seat the patient to continue a root canal.
//
// Two things it does not duplicate, and instead sits directly beneath: the medical
// history (one living row per patient) and the odontogram (likewise). Copying
// either into every examination would create two places for the same truth.
import { useState, type ReactNode } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ChevronDown, ChevronRight, ClipboardList, Pencil, Plus, Printer, Stethoscope, Trash2, X } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Skeleton } from "@/components/ui/skeleton";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { toast } from "@/components/ui/sonner";
import { cn } from "@/lib/utils";
import { AppError } from "@/lib/api-client";
import { useAuth } from "@/app/auth-context";
import { EthiopianDateInput } from "@/components/EthiopianDateInput";
import { formatEthiopian } from "@/lib/ethiopian";
import { getPatient } from "@/features/patients/api";
import { getClinic, listBranches } from "@/features/admin/api";
import { TOOTH_QUADRANTS } from "@/features/dental/ToothChart";
import { printExamination } from "@/features/dental/printExam";
import { ANAESTHESIA, EXAM_GROUPS, examHeadline, isBlankExam, toggleOption, type ExamGroup } from "@/features/dental/examination";
import {
  createExam, deleteExam, listExams, updateExam,
  type Exam, type ExamBody, type ExamProcedure,
} from "@/features/dental/api";

const todayISO = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};

function blankExam(): ExamBody {
  return {
    visit_date: todayISO(), chief_complaint: "", hpi: "", past_dental_history: "",
    extraoral: [], extraoral_notes: "", intraoral: [], intraoral_notes: "",
    investigations: [], investigation_results: "", diagnosis: "", treatment_plan: "",
    treatment_given: [], anaesthesia: "None", complications: "", procedures: [], postop: "",
  };
}

function toBody(e: Exam): ExamBody {
  const { id: _id, recorded_by: _rb, created_at: _c, updated_at: _u, ...body } = e;
  return { ...body, anaesthesia: e.anaesthesia || "None" };
}

/** Both calendars, because the clinic works in one and the records read in the other. */
function dualDate(iso: string) {
  try {
    return `${iso} · ${formatEthiopian(iso)}`;
  } catch {
    return iso;
  }
}

export function ExaminationCard({ patientId, editable }: { patientId: string; editable: boolean }) {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ["dental-exams", patientId], queryFn: () => listExams(patientId) });
  const [composing, setComposing] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);

  const exams = q.data?.items ?? [];
  const refresh = () => qc.invalidateQueries({ queryKey: ["dental-exams", patientId] });

  if (q.isLoading) {
    return <Card><CardContent className="p-4"><Skeleton className="h-24 w-full" /></CardContent></Card>;
  }

  return (
    <Card>
      <CardHeader className="flex-row flex-wrap items-center justify-between gap-2 space-y-0">
        <CardTitle className="flex items-center gap-2">
          <Stethoscope className="h-4 w-4 text-muted-foreground" />
          Clinical examinations
          {exams.length > 0 && <Badge variant="outline">{exams.length}</Badge>}
        </CardTitle>
        {editable && !composing && (
          <Button size="sm" onClick={() => { setEditingId(null); setComposing(true); }}>
            <Plus className="h-3.5 w-3.5" /> New examination
          </Button>
        )}
      </CardHeader>
      <CardContent className="space-y-3">
        {composing && (
          <ExamForm
            patientId={patientId}
            initial={blankExam()}
            onCancel={() => setComposing(false)}
            onSaved={() => { setComposing(false); refresh(); }}
          />
        )}

        {exams.length === 0 && !composing && (
          <div className="rounded-lg border border-dashed p-6 text-center">
            <ClipboardList className="mx-auto h-6 w-6 text-muted-foreground" />
            <p className="mt-2 text-sm font-medium">No examination on record</p>
            <p className="mx-auto mt-1 max-w-md text-sm text-muted-foreground">
              Treatment sessions record what was done. An examination records why — the complaint,
              what you found, and the diagnosis. It's what a referral, a second opinion or a
              medico-legal request will ask for.
            </p>
          </div>
        )}

        {exams.map((e) =>
          editingId === e.id ? (
            <ExamForm
              key={e.id}
              patientId={patientId}
              examId={e.id}
              initial={toBody(e)}
              onCancel={() => setEditingId(null)}
              onSaved={() => { setEditingId(null); refresh(); }}
            />
          ) : (
            <ExamRow
              key={e.id}
              patientId={patientId}
              exam={e}
              editable={editable}
              onEdit={() => { setComposing(false); setEditingId(e.id); }}
              onChanged={refresh}
            />
          ),
        )}
      </CardContent>
    </Card>
  );
}

// --- one examination, collapsed to a scannable line -------------------------

function ExamRow({ patientId, exam, editable, onEdit, onChanged }: {
  patientId: string; exam: Exam; editable: boolean; onEdit: () => void; onChanged: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const { activeBranchId } = useAuth();
  const clinic = useQuery({ queryKey: ["clinic"], queryFn: getClinic, retry: false });
  const branches = useQuery({ queryKey: ["branches"], queryFn: listBranches });
  const patient = useQuery({ queryKey: ["patient", patientId], queryFn: () => getPatient(patientId) });

  const del = useMutation({
    mutationFn: () => deleteExam(patientId, exam.id),
    onSuccess: () => { toast.success("Examination removed"); onChanged(); },
    onError: (e) => toast.error(e instanceof AppError ? e.message : "Could not remove"),
  });

  const print = () => {
    const p = patient.data;
    const branch = (branches.data ?? []).find((b) => b.id === activeBranchId);
    printExamination({
      clinic: clinic.data?.name || "Clinic",
      clinicContact: branch ? [branch.address, branch.phone].filter(Boolean).join(" · ") || undefined : undefined,
      patient: p ? [p.first_name, p.middle_name, p.last_name].filter(Boolean).join(" ") : "Patient",
      mrn: p?.mrn,
      age: p?.dob ? Math.floor((Date.now() - new Date(p.dob).getTime()) / 31557600000) : undefined,
      gender: p?.gender,
      exam,
    });
  };

  return (
    <div className={cn("rounded-lg border", open && "bg-muted/30")}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-start gap-3 p-3 text-left hover:bg-muted/40"
        aria-expanded={open}
      >
        {open ? <ChevronDown className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
              : <ChevronRight className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />}
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
            <span className="font-medium">{examHeadline(exam)}</span>
            <span className="text-xs text-muted-foreground">{dualDate(exam.visit_date)}</span>
          </div>
          {exam.treatment_given.length > 0 && (
            <div className="mt-1 flex flex-wrap gap-1">
              {exam.treatment_given.map((t) => (
                <span key={t} className="rounded-full bg-secondary px-2 py-0.5 text-[11px] text-secondary-foreground">{t}</span>
              ))}
            </div>
          )}
          {exam.recorded_by && <p className="mt-1 text-xs text-muted-foreground">Examined by {exam.recorded_by}</p>}
        </div>
      </button>

      {open && (
        <div className="space-y-4 border-t px-4 py-3">
          <ReadBlock title="Presenting complaint" text={[exam.chief_complaint, exam.hpi].filter(Boolean).join("\n")} />
          <ReadBlock title="Past dental history" text={exam.past_dental_history} />
          <ReadFindings title="Extraoral examination" items={exam.extraoral} notes={exam.extraoral_notes} />
          <ReadFindings title="Intraoral examination" items={exam.intraoral} notes={exam.intraoral_notes} />
          <ReadFindings title="Investigations" items={exam.investigations} notes={exam.investigation_results} />
          <ReadBlock title="Diagnosis" text={exam.diagnosis} emphasis />
          <ReadBlock title="Treatment plan" text={exam.treatment_plan} />
          <ReadFindings
            title="Treatment given this visit"
            items={exam.treatment_given}
            notes={[exam.anaesthesia && exam.anaesthesia !== "None" ? `Anaesthesia: ${exam.anaesthesia}` : "",
                    exam.complications ? `Complications: ${exam.complications}` : ""].filter(Boolean).join("\n")}
          />
          {exam.procedures.length > 0 && (
            <div>
              <p className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">Per-tooth work</p>
              <div className="mt-1 overflow-x-auto">
                <table className="w-full min-w-[420px] text-sm">
                  <thead>
                    <tr className="text-left text-[11px] uppercase tracking-wide text-muted-foreground">
                      <th className="pb-1 pr-3 font-medium">Tooth</th>
                      <th className="pb-1 pr-3 font-medium">Procedure / material</th>
                      <th className="pb-1 font-medium">Notes</th>
                    </tr>
                  </thead>
                  <tbody>
                    {exam.procedures.map((p, i) => (
                      <tr key={i} className="border-t">
                        <td className="whitespace-nowrap py-1.5 pr-3 font-medium">{p.tooth}</td>
                        <td className="py-1.5 pr-3">{p.procedure}</td>
                        <td className="py-1.5 text-muted-foreground">{p.notes}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}
          <ReadBlock title="Post-operative instructions" text={exam.postop} />

          <div className="flex flex-wrap items-center gap-2 border-t pt-3">
            <Button size="sm" variant="outline" onClick={print}><Printer className="h-3.5 w-3.5" /> Print</Button>
            {editable && <Button size="sm" variant="outline" onClick={onEdit}><Pencil className="h-3.5 w-3.5" /> Edit</Button>}
            {editable && (confirming ? (
              <span className="flex items-center gap-2 text-sm">
                <span className="text-muted-foreground">Remove this examination?</span>
                <Button size="sm" variant="destructive" disabled={del.isPending} onClick={() => del.mutate()}>Remove</Button>
                <Button size="sm" variant="ghost" onClick={() => setConfirming(false)}>Keep</Button>
              </span>
            ) : (
              <Button size="sm" variant="ghost" className="text-destructive" onClick={() => setConfirming(true)}>
                <Trash2 className="h-3.5 w-3.5" /> Remove
              </Button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function ReadBlock({ title, text, emphasis }: { title: string; text?: string; emphasis?: boolean }) {
  if (!(text || "").trim()) return null;
  return (
    <div>
      <p className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">{title}</p>
      <p className={cn("mt-0.5 whitespace-pre-wrap text-sm", emphasis && "font-medium")}>{text}</p>
    </div>
  );
}

function ReadFindings({ title, items, notes }: { title: string; items: string[]; notes?: string }) {
  if (items.length === 0 && !(notes || "").trim()) return null;
  return (
    <div>
      <p className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">{title}</p>
      {items.length > 0 && (
        <div className="mt-1 flex flex-wrap gap-1">
          {items.map((i) => <span key={i} className="rounded-full border px-2 py-0.5 text-xs">{i}</span>)}
        </div>
      )}
      {(notes || "").trim() && <p className="mt-1 whitespace-pre-wrap text-sm">{notes}</p>}
    </div>
  );
}

// --- the form ----------------------------------------------------------------

function ExamForm({ patientId, examId, initial, onCancel, onSaved }: {
  patientId: string; examId?: string; initial: ExamBody; onCancel: () => void; onSaved: () => void;
}) {
  const [f, setF] = useState<ExamBody>(initial);
  const set = (patch: Partial<ExamBody>) => setF((p) => ({ ...p, ...patch }));

  const save = useMutation({
    mutationFn: (body: ExamBody) => (examId ? updateExam(patientId, examId, body) : createExam(patientId, body)),
    onSuccess: () => { toast.success(examId ? "Examination updated" : "Examination recorded"); onSaved(); },
    onError: (e) => toast.error(e instanceof AppError ? e.message : "Could not save"),
  });

  const submit = () => {
    if (isBlankExam(f)) { toast.error("Nothing to record yet — add at least a complaint or a finding."); return; }
    // Drop the untouched blank row the table always keeps at the end.
    save.mutate({ ...f, procedures: f.procedures.filter((p) => (p.tooth || p.procedure || p.notes || "").trim()) });
  };

  return (
    <div className="space-y-5 rounded-lg border border-primary/40 bg-primary/[0.03] p-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="w-full max-w-xs">
          <Label className="text-xs">Visit date</Label>
          <EthiopianDateInput value={f.visit_date} onChange={(v) => set({ visit_date: v })} showAge={false} />
        </div>
        <Button variant="ghost" size="sm" onClick={onCancel}><X className="h-3.5 w-3.5" /> Cancel</Button>
      </div>

      <FormSection title="Presenting complaint">
        <Field label="Chief complaint" hint="In the patient's own words.">
          <Input value={f.chief_complaint ?? ""} onChange={(e) => set({ chief_complaint: e.target.value })}
                 placeholder="e.g. Pain in lower right back tooth for 3 days" />
        </Field>
        <Field label="History of present illness">
          <Textarea rows={3} value={f.hpi ?? ""} onChange={(e) => set({ hpi: e.target.value })}
                    placeholder="Onset, duration, character, aggravating and relieving factors" />
        </Field>
        <Field label="Past dental history" hint="Last visit, previous dentist, previous treatment.">
          <Textarea rows={2} value={f.past_dental_history ?? ""} onChange={(e) => set({ past_dental_history: e.target.value })} />
        </Field>
      </FormSection>

      {EXAM_GROUPS.filter((g) => g.key === "extraoral" || g.key === "intraoral").map((g) => (
        <FormSection key={g.key} title={g.title} blurb={g.blurb}>
          <ChipGroup
            group={g}
            selected={g.key === "extraoral" ? f.extraoral : f.intraoral}
            onChange={(v) => set(g.key === "extraoral" ? { extraoral: v } : { intraoral: v })}
          />
          <Textarea
            rows={2}
            className="mt-2"
            placeholder="Findings"
            value={(g.key === "extraoral" ? f.extraoral_notes : f.intraoral_notes) ?? ""}
            onChange={(e) => set(g.key === "extraoral" ? { extraoral_notes: e.target.value } : { intraoral_notes: e.target.value })}
          />
        </FormSection>
      ))}

      <FormSection title="Investigations">
        <ChipGroup group={EXAM_GROUPS[2]} selected={f.investigations} onChange={(v) => set({ investigations: v })} />
        <Textarea rows={2} className="mt-2" placeholder="Results"
                  value={f.investigation_results ?? ""} onChange={(e) => set({ investigation_results: e.target.value })} />
      </FormSection>

      <FormSection title="Assessment" blurb="The conclusion the rest of the record hangs on.">
        <Field label="Provisional diagnosis">
          <Input value={f.diagnosis ?? ""} onChange={(e) => set({ diagnosis: e.target.value })}
                 placeholder="e.g. Irreversible pulpitis — 46" />
        </Field>
        <Field label="Treatment plan" hint="The intended course. Schedule and price it under Treatment plans below.">
          <Textarea rows={3} value={f.treatment_plan ?? ""} onChange={(e) => set({ treatment_plan: e.target.value })} />
        </Field>
      </FormSection>

      <FormSection title="Treatment given this visit" blurb="Leave empty if this was examination only.">
        <ChipGroup group={EXAM_GROUPS[3]} selected={f.treatment_given} onChange={(v) => set({ treatment_given: v })} />
        <div className="mt-3 grid gap-3 sm:grid-cols-2">
          <Field label="Anaesthesia">
            <Select value={f.anaesthesia || "None"} onValueChange={(v) => set({ anaesthesia: v })}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>{ANAESTHESIA.map((a) => <SelectItem key={a} value={a}>{a}</SelectItem>)}</SelectContent>
            </Select>
          </Field>
          <Field label="Complications">
            <Input value={f.complications ?? ""} onChange={(e) => set({ complications: e.target.value })}
                   placeholder="None" />
          </Field>
        </div>
        <ProcedureTable rows={f.procedures} onChange={(procedures) => set({ procedures })} />
      </FormSection>

      <FormSection title="Post-operative instructions">
        <Textarea rows={2} value={f.postop ?? ""} onChange={(e) => set({ postop: e.target.value })}
                  placeholder="Given to the patient — e.g. avoid chewing on that side for 24 h, warm saline rinses from tomorrow" />
      </FormSection>

      <div className="flex items-center gap-2 border-t pt-3">
        <Button onClick={submit} disabled={save.isPending}>
          {save.isPending ? "Saving…" : examId ? "Save changes" : "Record examination"}
        </Button>
        <Button variant="ghost" onClick={onCancel}>Cancel</Button>
      </div>
    </div>
  );
}

function FormSection({ title, blurb, children }: { title: string; blurb?: string; children: ReactNode }) {
  return (
    <section>
      <h4 className="text-xs font-semibold uppercase tracking-wide text-primary">{title}</h4>
      {blurb && <p className="mb-2 mt-0.5 text-xs text-muted-foreground">{blurb}</p>}
      <div className={cn("space-y-3", !blurb && "mt-2")}>{children}</div>
    </section>
  );
}

function Field({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <div>
      <Label className="text-xs">{label}</Label>
      {children}
      {hint && <p className="mt-1 text-xs text-muted-foreground">{hint}</p>}
    </div>
  );
}

/** Findings as toggle chips — faster to tick than a column of checkboxes, and the
 *  selected set stays readable at a glance. */
function ChipGroup({ group, selected, onChange }: { group: ExamGroup; selected: string[]; onChange: (v: string[]) => void }) {
  return (
    <div className="flex flex-wrap gap-1.5">
      {group.options.map((o) => {
        const on = selected.includes(o);
        return (
          <button
            key={o}
            type="button"
            aria-pressed={on}
            onClick={() => onChange(toggleOption(group, selected, o))}
            className={cn(
              "rounded-full border px-3 py-1 text-xs transition-colors",
              on ? "border-primary bg-primary text-primary-foreground" : "bg-background hover:bg-muted",
            )}
          >
            {o}
          </button>
        );
      })}
    </div>
  );
}

/** Per-tooth work done at this visit. Always keeps one empty row at the end so
 *  adding a line never needs a button press. */
function ProcedureTable({ rows, onChange }: { rows: ExamProcedure[]; onChange: (r: ExamProcedure[]) => void }) {
  const filled = rows.filter((r) => (r.tooth || r.procedure || r.notes || "").trim());
  const display = [...filled, { tooth: "", procedure: "", notes: "" }];

  const edit = (i: number, patch: Partial<ExamProcedure>) => {
    const next = display.map((r, idx) => (idx === i ? { ...r, ...patch } : r));
    onChange(next);
  };

  return (
    <div className="mt-3">
      <Label className="text-xs">Per-tooth work</Label>
      <div className="mt-1 space-y-2">
        {display.map((r, i) => (
          <div key={i} className="grid gap-2 sm:grid-cols-[130px_1fr_1fr_auto]">
            <Select value={r.tooth || ""} onValueChange={(v) => edit(i, { tooth: v })}>
              <SelectTrigger><SelectValue placeholder="Tooth" /></SelectTrigger>
              <SelectContent className="max-h-64">
                {TOOTH_QUADRANTS.map((quad) => (
                  <SelectGroupBlock key={quad.label} label={quad.label} codes={quad.codes} />
                ))}
              </SelectContent>
            </Select>
            <Input placeholder="Procedure / material used" value={r.procedure || ""} onChange={(e) => edit(i, { procedure: e.target.value })} />
            <Input placeholder="Notes" value={r.notes || ""} onChange={(e) => edit(i, { notes: e.target.value })} />
            {i < filled.length ? (
              <Button variant="ghost" size="icon" aria-label="Remove row"
                      onClick={() => onChange(filled.filter((_, idx) => idx !== i))}>
                <Trash2 className="h-4 w-4 text-muted-foreground" />
              </Button>
            ) : <div />}
          </div>
        ))}
      </div>
    </div>
  );
}

function SelectGroupBlock({ label, codes }: { label: string; codes: string[] }) {
  return (
    <>
      <div className="px-2 py-1 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">{label}</div>
      {codes.map((c) => <SelectItem key={c} value={c}>{c}</SelectItem>)}
    </>
  );
}
