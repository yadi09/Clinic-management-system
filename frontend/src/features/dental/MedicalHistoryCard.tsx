// The patient's medical history, and the safety alerts it produces.
//
// Two jobs, in priority order: (1) put the handful of facts that change treatment
// in front of the clinician before they pick up a handpiece, and (2) make taking
// and re-confirming the questionnaire quick enough that it actually happens.
// Dentist-only — the endpoint sits behind dental.manage and is absent from the
// summary the front desk reads.
import { useEffect, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { AlertTriangle, ClipboardList, Pencil, ShieldCheck } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Skeleton } from "@/components/ui/skeleton";
import { toast } from "@/components/ui/sonner";
import { cn } from "@/lib/utils";
import { AppError } from "@/lib/api-client";
import { getMedicalHistory, saveMedicalHistory, type MedicalHistory } from "@/features/dental/api";
import { HISTORY_SECTIONS, historyAlerts, positives, unresolved, reviewState, REVIEW_MONTHS, type AnswerMap } from "@/features/dental/medicalHistory";

/** Alert chips — also used in the patient banner so they're unmissable. */
export function HistoryAlertChips({ answers, className }: { answers: AnswerMap; className?: string }) {
  const alerts = historyAlerts(answers);
  if (alerts.length === 0) return null;
  return (
    <>
      {alerts.map((a) => (
        <span key={a.key}
          className={cn("flex items-center gap-1 rounded-full px-3 py-1 text-xs font-semibold",
            a.level === "danger" ? "bg-destructive text-destructive-foreground" : "bg-amber-500 text-white", className)}>
          <AlertTriangle className="h-3.5 w-3.5" /> {a.text}
        </span>
      ))}
    </>
  );
}

export function MedicalHistoryCard({ patientId, gender, editable }: { patientId: string; gender: string; editable: boolean }) {
  const q = useQuery({ queryKey: ["medical-history", patientId], queryFn: () => getMedicalHistory(patientId) });
  const [editing, setEditing] = useState(false);
  const h = q.data;
  const answers = h?.answers ?? {};
  const state = reviewState(h?.reviewed_at, h?.recorded);
  const alerts = historyAlerts(answers);
  const yesList = positives(answers);
  const open_ = unresolved(answers);

  if (q.isLoading) return <Card><CardContent className="p-4"><Skeleton className="h-20 w-full" /></CardContent></Card>;

  return (
    <Card className={cn(state === "missing" && "border-amber-300", alerts.some((a) => a.level === "danger") && "border-destructive")}>
      <CardHeader className="flex-row flex-wrap items-center justify-between gap-2 space-y-0">
        <CardTitle className="flex items-center gap-2">
          <ClipboardList className="h-4 w-4 text-primary" /> Medical history
        </CardTitle>
        <div className="flex items-center gap-2">
          {state === "current" && <Badge variant="success"><ShieldCheck className="mr-1 h-3 w-3" /> Reviewed</Badge>}
          {state === "due" && <Badge variant="warning">Due for review</Badge>}
          {state === "missing" && <Badge variant="destructive">Not taken</Badge>}
          {editable && (
            <Button size="sm" variant={state === "missing" ? "default" : "outline"} onClick={() => setEditing(true)}>
              <Pencil className="h-3.5 w-3.5" /> {state === "missing" ? "Take history" : "Review"}
            </Button>
          )}
        </div>
      </CardHeader>
      <CardContent className="space-y-3">
        {state === "missing" ? (
          <p className="text-sm text-muted-foreground">
            No medical history on file. Take it before treating — it's what tells you whether anaesthetic,
            extraction or radiographs are safe for this patient.
          </p>
        ) : (
          <>
            {alerts.length > 0 ? (
              <div className="flex flex-wrap gap-2">
                {alerts.map((a) => (
                  <span key={a.key}
                    className={cn("flex items-center gap-1.5 rounded-md border px-2.5 py-1.5 text-xs font-medium",
                      a.level === "danger" ? "border-destructive/40 bg-destructive/10 text-destructive" : "border-amber-300 bg-amber-50 text-amber-800")}>
                    <AlertTriangle className="h-3.5 w-3.5 shrink-0" /> {a.text}
                  </span>
                ))}
              </div>
            ) : (
              <p className="text-sm text-emerald-600">✓ Nothing flagged that affects dental treatment.</p>
            )}

            {/* An incomplete history is not a clear one — say so plainly. */}
            {open_.length > 0 && (
              <p className="text-xs text-amber-700">
                <b>Not established:</b> {open_.join(" · ")} — ask at the next visit.
              </p>
            )}

            {yesList.length > 0 && (
              <p className="text-xs text-muted-foreground"><b>Reported:</b> {yesList.join(" · ")}</p>
            )}
            {answers.current_meds && (
              <p className="text-xs text-muted-foreground"><b>Medication:</b> {answers.current_meds}</p>
            )}
            {h?.notes && <p className="text-xs text-muted-foreground"><b>Notes:</b> {h.notes}</p>}
            <p className="text-xs text-muted-foreground">
              Last reviewed {h?.reviewed_at ? new Date(h.reviewed_at).toLocaleDateString() : "—"}
              {h?.reviewed_by ? ` by ${h.reviewed_by}` : ""}
              {state === "due" ? ` · over ${REVIEW_MONTHS} months ago, please re-confirm` : ""}
            </p>
          </>
        )}
      </CardContent>

      {editing && h !== undefined && (
        <HistoryDialog patientId={patientId} gender={gender} current={h}
          onClose={() => setEditing(false)} onSaved={() => q.refetch()} />
      )}
    </Card>
  );
}

function HistoryDialog({ patientId, gender, current, onClose, onSaved }: {
  patientId: string; gender: string; current: MedicalHistory; onClose: () => void; onSaved: () => void;
}) {
  const [answers, setAnswers] = useState<AnswerMap>(current.answers ?? {});
  const [notes, setNotes] = useState(current.notes ?? "");
  useEffect(() => { setAnswers(current.answers ?? {}); setNotes(current.notes ?? ""); }, [current]);
  const set = (k: string, v: string) => setAnswers((a) => ({ ...a, [k]: v }));

  const mut = useMutation({
    mutationFn: () => saveMedicalHistory(patientId, { answers, notes: notes.trim() }),
    onSuccess: () => { toast.success("Medical history saved"); onSaved(); onClose(); },
    onError: (e) => toast.error(e instanceof AppError ? e.message : "Could not save the history"),
  });

  const live = historyAlerts(answers);

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-2xl">
        <DialogHeader><DialogTitle>Medical history</DialogTitle></DialogHeader>
        <p className="text-sm text-muted-foreground">
          Ask the patient each question. Saving stamps today's date and your name — re-confirming an
          unchanged history is exactly how you record that you asked again.
        </p>

        {live.length > 0 && (
          <div className="flex flex-wrap gap-2 rounded-md border border-destructive/40 bg-destructive/5 p-2">
            {live.map((a) => (
              <span key={a.key} className={cn("text-xs font-medium", a.level === "danger" ? "text-destructive" : "text-amber-700")}>
                ⚠ {a.text}
              </span>
            ))}
          </div>
        )}

        <div className="max-h-[55vh] space-y-5 overflow-y-auto pr-1">
          {HISTORY_SECTIONS.map((sec) => {
            const qs = sec.questions.filter((q) => !q.onlyIf || q.onlyIf({ gender }));
            if (qs.length === 0) return null;
            return (
              <div key={sec.title} className="space-y-2">
                <div>
                  <h4 className="text-sm font-semibold">{sec.title}</h4>
                  {sec.blurb && <p className="text-xs text-muted-foreground">{sec.blurb}</p>}
                </div>
                <div className="divide-y rounded-md border">
                  {qs.map((qq) => (
                    <div key={qq.key} className="flex flex-wrap items-center gap-3 p-2.5">
                      <div className="min-w-0 flex-1">
                        <span className="text-sm">{qq.label}</span>
                        {qq.hint && <p className="text-xs text-muted-foreground">{qq.hint}</p>}
                      </div>
                      {qq.type === "text" ? (
                        <Input className="w-full sm:w-72" value={answers[qq.key] ?? ""} onChange={(e) => set(qq.key, e.target.value)} placeholder="Name and dose, if known" />
                      ) : (
                        <div className="flex gap-1">
                          {(["yes", "no", "unsure"] as const).map((v) => (
                            <button key={v} type="button" onClick={() => set(qq.key, v)}
                              className={cn("rounded-md border px-2.5 py-1 text-xs font-medium capitalize",
                                answers[qq.key] === v
                                  ? v === "yes" ? "border-destructive bg-destructive text-destructive-foreground"
                                    : v === "no" ? "border-emerald-600 bg-emerald-600 text-white"
                                    : "border-amber-500 bg-amber-500 text-white"
                                  : "hover:bg-accent")}>
                              {v === "unsure" ? "Not sure" : v}
                            </button>
                          ))}
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              </div>
            );
          })}

          <div className="space-y-1.5">
            <Label>Anything else the patient mentioned</Label>
            <Textarea rows={3} value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Previous surgery, hospital admissions, anything relevant…" />
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={onClose}>Cancel</Button>
          <Button loading={mut.isPending} onClick={() => mut.mutate()}>Save history</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
