// The medical-history questionnaire, as a dialog.
//
// This is the ONLY surface in the product for taking a history or re-confirming an
// existing one. Nothing else writes to /dental/patients/:id/medical-history, so if
// this dialog is unreachable a clinic simply cannot record the facts that decide
// whether anaesthetic, extraction or radiographs are safe. It lives in its own file
// for exactly that reason: it must outlive whichever card happens to mount it today.
//
// Saving is the whole point of re-confirming. The server stamps today's date and the
// signed-in clinician on every PUT, so saving an unchanged questionnaire is not a
// no-op — it is the record that somebody asked the patient again this year.
//
// The form is deliberately keyboard-first. A dentist gloved up at the chair is not
// reaching for a mouse, and the person typing is often reading the questions aloud
// from a screen reader, so every control here is labelled and every yes/no/not-sure
// group announces itself as a radio group with a checked option.
import { useState } from "react";
import { useMutation } from "@tanstack/react-query";

import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { toast } from "@/components/ui/sonner";
import { cn } from "@/lib/utils";
import { AppError } from "@/lib/api-client";
import { saveMedicalHistory, type MedicalHistory } from "@/features/dental/api";
import { SafetyStrip } from "@/features/dental/SafetyStrip";
import { HISTORY_SECTIONS, type AnswerMap } from "@/features/dental/medicalHistory";

export function HistoryDialog({ patientId, gender, current, allergies = [], onClose, onSaved }: {
  patientId: string; gender: string; current: MedicalHistory;
  /** Passed in so the strip inside this dialog shows allergies too, not just answers. */
  allergies?: { id: string; substance: string }[];
  onClose: () => void; onSaved: () => void;
}) {
  const [answers, setAnswers] = useState<AnswerMap>(current.answers ?? {});
  const [notes, setNotes] = useState(current.notes ?? "");
  // Deliberately seeded once, not synced to `current`. The dialog is mounted fresh
  // each time it opens, and invalidateDental() now refetches the history — re-syncing
  // would wipe half-typed answers out from under the clinician mid-questionnaire.
  const set = (k: string, v: string) => setAnswers((a) => ({ ...a, [k]: v }));

  const mut = useMutation({
    mutationFn: () => saveMedicalHistory(patientId, { answers, notes: notes.trim() }),
    onSuccess: () => { toast.success("Medical history saved"); onSaved(); onClose(); },
    onError: (e) => toast.error(e instanceof AppError ? e.message : "Could not save the history"),
  });

  // Alerts recomputed on every keystroke: answering "yes" to blood thinners should
  // warn the clinician while the patient is still in front of them, not after saving.

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-2xl">
        <DialogHeader><DialogTitle>Medical history</DialogTitle></DialogHeader>
        <p className="text-sm text-muted-foreground">
          Ask the patient each question. Saving stamps today's date and your name — re-confirming an
          unchanged history is exactly how you record that you asked again.
        </p>

        {/* Recomputed from the answers as they are given, not from what is saved —
            ticking "on warfarin" must warn before the form is submitted. Same
            component, and therefore the same shape, as the strip on the page. */}
        <SafetyStrip
          compact
          allergies={allergies}
          history={{ answers, recorded: true, reviewedAt: new Date().toISOString() }}
          isLoading={false}
          isError={false}
        />

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
                  {qs.map((qq) => {
                    // Question keys are stable catalogue identifiers, so they make safe
                    // DOM ids to wire the visible question text to its control.
                    const fieldId = `mh-${qq.key}`;
                    const labelId = `${fieldId}-label`;
                    const hintId = qq.hint ? `${fieldId}-hint` : undefined;
                    return (
                      <div key={qq.key} className="flex flex-wrap items-center gap-3 p-2.5">
                        <div className="min-w-0 flex-1">
                          {/* A text question owns a real input, so the question text is its
                              <label> and clicking it focuses the box. A yes/no group has no
                              single control to point at, so the text is named by reference. */}
                          {qq.type === "text" ? (
                            <label id={labelId} htmlFor={fieldId} className="text-sm">{qq.label}</label>
                          ) : (
                            <span id={labelId} className="text-sm">{qq.label}</span>
                          )}
                          {qq.hint && <p id={hintId} className="text-xs text-muted-foreground">{qq.hint}</p>}
                        </div>
                        {qq.type === "text" ? (
                          <Input id={fieldId} aria-describedby={hintId} className="w-full sm:w-72" value={answers[qq.key] ?? ""} onChange={(e) => set(qq.key, e.target.value)} placeholder="Name and dose, if known" />
                        ) : (
                          // Radio-group semantics, not three unrelated buttons: a screen
                          // reader then announces the question, "3 options", and which one
                          // is chosen. Every option stays in the tab order (no roving
                          // tabindex), so Tab-then-Enter answers the form without a mouse.
                          <div role="radiogroup" aria-labelledby={labelId} aria-describedby={hintId} className="flex gap-1">
                            {(["yes", "no", "unsure"] as const).map((v) => (
                              <button key={v} type="button" role="radio" aria-checked={answers[qq.key] === v} onClick={() => set(qq.key, v)}
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
                    );
                  })}
                </div>
              </div>
            );
          })}

          <div className="space-y-1.5">
            <Label htmlFor="mh-notes">Anything else the patient mentioned</Label>
            <Textarea id="mh-notes" rows={3} value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Previous surgery, hospital admissions, anything relevant…" />
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
