// Allergies, and nothing else.
//
// This used to also carry a thirty-question health questionnaire and the alerts
// derived from it. That is gone at the clinic's request: it was paperwork nobody
// filled in, and a form that is never completed is not a safety control — it is a
// screen people learn to click past. What remains is the one fact a dentist must
// have before injecting an anaesthetic or writing a prescription, and which the
// front desk can capture in five seconds at registration.
//
// Two properties are deliberate:
//
//  1. THE ABSENCE OF A FLAG IS STATED, NOT IMPLIED. "No known allergies" is written
//     out on the banner. A blank space would mean nobody asked; those are different
//     facts and only one of them is safe to act on.
//
//  2. DANGER NEVER HIDES. Allergy rows cannot be dismissed. The banner carries them
//     while it is on screen and this strip takes over once it scrolls away, sticking
//     at top-16 below AppShell's 64px header — at top-0 it slides underneath it and
//     is invisible for the whole scrolled page.
import { useQuery } from "@tanstack/react-query";
import { AlertTriangle } from "lucide-react";

import { getPatient } from "@/features/patients/api";

import { cn } from "@/lib/utils";

export interface AllergyLite {
  id: string;
  substance: string;
  reaction?: string;
  severity?: string;
}

/** Severe first; the rest keep their recorded order. */
function ranked(allergies: AllergyLite[]): AllergyLite[] {
  const weight = (s?: string) => (s === "severe" ? 0 : s === "moderate" ? 1 : 2);
  return [...allergies].sort((a, b) => weight(a.severity) - weight(b.severity));
}

/** Substance, plus the reaction when one was recorded. */
export function allergyText(a: AllergyLite): string {
  return a.reaction?.trim() ? `${a.substance} — ${a.reaction.trim()}` : a.substance;
}

export function SafetyStrip({ allergies, compact, className }: {
  allergies: AllergyLite[];
  /** One line, no chrome — for dialogs that cover the page. */
  compact?: boolean;
  className?: string;
}) {
  if (allergies.length === 0) return null;
  const list = ranked(allergies);

  if (compact) {
    return (
      <div
        role="alert"
        className={cn(
          "flex flex-wrap items-center gap-x-2 gap-y-1 rounded-md border border-destructive/40 bg-destructive/10 px-2.5 py-1.5 text-xs text-destructive",
          className,
        )}
      >
        <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
        <span className="font-semibold uppercase tracking-wide">Allergy</span>
        {list.map((a, i) => (
          <span key={a.id} className="font-medium">
            {i > 0 && <span className="mr-2 opacity-40">·</span>}
            {allergyText(a)}
          </span>
        ))}
      </div>
    );
  }

  return (
    <div
      role="alert"
      className={cn(
        "sticky top-16 z-30 rounded-md border-l-4 border-l-destructive bg-destructive/10 px-3 py-2 text-destructive shadow-sm backdrop-blur",
        className,
      )}
    >
      <div className="flex flex-wrap items-start gap-x-3 gap-y-1">
        <span className="flex shrink-0 items-center gap-1.5 pt-0.5 text-[10px] font-bold uppercase tracking-widest">
          <AlertTriangle className="h-3.5 w-3.5" /> Allergy
        </span>
        <div className="min-w-0 flex-1 space-y-0.5 text-sm">
          {list.map((a) => (
            <div key={a.id} className="font-semibold">
              {allergyText(a)}
              {a.severity === "severe" && <span className="ml-2 text-xs font-bold uppercase">severe</span>}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

/**
 * The compact strip, fetching for itself — for dialogs that cover the page.
 *
 * Radix dialogs sit over the record, so the allergy the clinician needs is hidden at
 * exactly the moment they are choosing a drug. The patient query is already in the
 * cache, so mounting this costs nothing.
 */
export function PatientAllergyLine({ patientId, className }: { patientId: string; className?: string }) {
  const patient = useQuery({ queryKey: ["patient", patientId], queryFn: () => getPatient(patientId) });
  return <SafetyStrip compact allergies={patient.data?.allergies ?? []} className={className} />;
}
