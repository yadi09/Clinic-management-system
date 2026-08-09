// The one place the clinic is told something could hurt this patient.
//
// This replaces four separate renderings of the same facts: a filled red pill in the
// patient banner, a tinted bordered chip inside the medical-history card, a rose
// sticky bar on scroll, and a hand-rolled warning line inside the history dialog.
// Four idioms for one message is three too many — people learn a warning by its
// shape, and a shape that changes stops being a warning.
//
// Four properties are deliberate and should survive future edits:
//
//  1. ALLERGIES RENDER UNCONDITIONALLY. They come from the patient record, which is a
//     different query from the health history. An early return on the history's
//     loading or error state takes a successfully-loaded "Allergy: Penicillin" off
//     the screen with it — the bug the first version of this file shipped with. The
//     two halves fail independently, so they report independently: the allergies
//     render, and the history says it is unavailable.
//
//  2. SILENCE IS NEVER ASSUMED TO MEAN SAFE. `historyAlerts({})` returns an empty
//     list, so a patient nobody ever questioned used to render exactly like one with
//     a clean bill of health — and a failed fetch rendered that way too. This strip
//     separates "asked, nothing found" from "never asked" from "could not check" from
//     "not yours to see", and says which in words. `?? {}` is banned in this path;
//     that operator is what turned a network timeout into a green light.
//
//  3. DANGER NEVER HIDES. Danger rows cannot be dismissed and do not collapse. The
//     strip sticks at top-16, below AppShell's 64px header — at top-0 it slides under
//     an opaque bar and is invisible for the entire scrolled page.
//
//  4. MONEY IS NOT A SAFETY SIGNAL. "Owes 2,000 ETB" used to wear the identical red
//     pill as "Allergy: Penicillin", in the same row — which is how staff learn to
//     filter red out. Nothing financial renders here, ever.
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { AlertTriangle, Loader2, RefreshCw, ShieldCheck, ShieldQuestion } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { cn } from "@/lib/utils";
import { useAuth } from "@/app/auth-context";
import { getPatient } from "@/features/patients/api";
import { getMedicalHistory } from "@/features/dental/api";
import { historyAlerts, positives, unresolved, type Alert, type AnswerMap, type HistoryMeta } from "@/features/dental/medicalHistory";

export interface HistoryRecord {
  answers?: AnswerMap;
  recorded?: boolean;
  reviewedAt?: string;
  reviewedBy?: string;
  notes?: string;
}

export interface SafetyStripProps {
  /** From the patient record. Always rendered, whatever the history is doing. */
  allergies: { id: string; substance: string }[];
  /**
   * The health history, when it is in hand.
   *
   * OMIT IT for the front desk, and while it is still being fetched. Passing an empty
   * object instead reads as "we asked and there is nothing on file", and the strip
   * would announce "No health check on file" to a receptionist whose query never ran.
   * Absent means unknown, not empty.
   */
  history?: HistoryRecord;
  /** True while the history is being fetched — including paused offline. */
  isLoading?: boolean;
  /** True when the history fetch failed. Never suppresses the allergy half. */
  isError?: boolean;
  onRetry?: () => void;
  /** Opens the questionnaire. Omit for read-only contexts (the front desk). */
  onTakeHistory?: () => void;
  /** One line, no actions — for use inside dialogs that cover the page. */
  compact?: boolean;
  className?: string;
}

const allergyAlerts = (allergies: { id: string; substance: string }[]): Alert[] =>
  allergies.map((a) => ({ key: `alg-${a.id}`, level: "danger" as const, text: `Allergy: ${a.substance}` }));

/** Every alert for this patient. History alerts are added only when it is in hand. */
export function safetyAlerts(allergies: { id: string; substance: string }[], history?: HistoryRecord): Alert[] {
  const out = allergyAlerts(allergies);
  if (!history) return out; // not fetched, not permitted, or failed — not "empty"
  const meta: HistoryMeta = { recorded: history.recorded, reviewedAt: history.reviewedAt };
  return [...out, ...historyAlerts(history.answers ?? {}, meta)];
}

export function SafetyStrip({
  allergies, history, isLoading = false, isError = false, onRetry, onTakeHistory, compact, className,
}: SafetyStripProps) {
  const [showWarnings, setShowWarnings] = useState(false);

  const known = !!history && !isError && !isLoading;
  const alerts = safetyAlerts(allergies, known ? history : undefined);
  const dangers = alerts.filter((a) => a.level === "danger");
  const warns = alerts.filter((a) => a.level === "warn");
  const open = known ? unresolved(history!.answers ?? {}) : [];

  // What the history half has to say for itself, independent of any alert.
  const historyNote = isError
    ? "Health history could not be loaded — do not read the absence of alerts as a clear history."
    : isLoading
      ? "Checking health history…"
      : !history
        ? "Health history is with the dentist."
        : null;

  // --- compact: one line inside a dialog that covers the page. ---
  // A dentist writing a prescription must see the penicillin allergy without
  // dismissing the dialog to go and look for it.
  if (compact) {
    if (alerts.length === 0 && !isError) return null;
    const bad = dangers.length > 0 || isError;
    return (
      <div
        role="alert"
        className={cn(
          "flex flex-wrap items-center gap-x-2 gap-y-1 rounded-md border px-2.5 py-1.5 text-xs",
          bad ? "border-destructive/40 bg-destructive/10 text-destructive" : "border-amber-300 bg-amber-50 text-amber-800",
          className,
        )}
      >
        <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
        {(dangers.length > 0 ? dangers : warns).map((a, i) => (
          <span key={a.key} className="font-medium">
            {i > 0 && <span className="mr-2 opacity-40">·</span>}
            {a.text}
          </span>
        ))}
        {dangers.length > 0 && warns.length > 0 && <span className="opacity-70">+{warns.length} more</span>}
        {isError && <span className="font-medium">Health history unavailable — check it before prescribing.</span>}
      </div>
    );
  }

  const danger = dangers.length > 0;

  // --- nothing to shout about: one muted line, not a 150px green card. ---
  if (alerts.length === 0 && !isError) {
    return (
      <div className={cn("flex flex-wrap items-center gap-x-2 gap-y-1 py-1.5 text-xs text-muted-foreground", className)}>
        {isLoading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <ShieldCheck className="h-3.5 w-3.5 text-emerald-600" />}
        <span>{historyNote ?? "No allergies and nothing in the health history that affects treatment."}</span>
        {open.length > 0 && <OpenQuestions items={open} />}
        <HistoryDetail history={known ? history : undefined} />
        {onTakeHistory && !isLoading && (
          <button type="button" onClick={onTakeHistory} className="ml-1 font-medium text-brand underline-offset-2 hover:underline">
            {history?.recorded ? "Review" : "Take health check"}
          </button>
        )}
      </div>
    );
  }

  // --- something to say. Sticky below the app header; danger never collapses. ---
  return (
    <div
      role="alert"
      className={cn(
        "sticky top-16 z-30 rounded-md border-l-4 px-3 py-2 shadow-sm backdrop-blur",
        danger ? "border-l-destructive bg-destructive/10 text-destructive" : "border-l-amber-500 bg-amber-50/95 text-amber-900",
        className,
      )}
    >
      <div className="flex flex-wrap items-start gap-x-3 gap-y-1">
        <span className="flex shrink-0 items-center gap-1.5 pt-0.5 text-[10px] font-bold uppercase tracking-widest">
          <AlertTriangle className="h-3.5 w-3.5" /> Safety
        </span>
        <div className="min-w-0 flex-1 space-y-0.5 text-sm">
          {dangers.map((a) => <div key={a.key} className="font-semibold">{a.text}</div>)}
          {/* When danger is present the warnings fold, so the fatal line stays first. */}
          {warns.length > 0 && (!danger || showWarnings) &&
            warns.map((a) => <div key={a.key} className={cn(danger && "font-normal opacity-90")}>{a.text}</div>)}
          {danger && warns.length > 0 && !showWarnings && (
            <button type="button" onClick={() => setShowWarnings(true)} className="text-xs font-medium underline underline-offset-2">
              +{warns.length} more to confirm
            </button>
          )}
          {historyNote && (
            <div className="flex items-center gap-1.5 text-xs font-medium opacity-90">
              <ShieldQuestion className="h-3.5 w-3.5 shrink-0" /> {historyNote}
            </div>
          )}
          {(open.length > 0 || known) && (
            <div className="flex flex-wrap items-center gap-x-2 gap-y-1 pt-0.5">
              {open.length > 0 && <OpenQuestions items={open} />}
              <HistoryDetail history={known ? history : undefined} />
            </div>
          )}
        </div>
        <div className="flex shrink-0 gap-2">
          {isError && onRetry && (
            <Button size="sm" variant="outline" className="bg-background/70" onClick={onRetry}>
              <RefreshCw className="h-3.5 w-3.5" /> Retry
            </Button>
          )}
          {/* Offered even when the fetch failed: the PUT is a separate request and may
              well succeed, and a brand-new patient must not become untakeable because
              a GET returned 500. */}
          {onTakeHistory && (
            <Button size="sm" variant="outline" className="bg-background/70" onClick={onTakeHistory}>
              {history?.recorded ? "Review" : "Take health check"}
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}

/**
 * The reported facts that do not rise to an alert but still change a decision:
 * conditions ticked yes, the medication list, who last confirmed it and when.
 *
 * The deleted card showed all of these. Nine "yes" answers — smoking, khat, bruxism
 * and the rest — raise no alert by design, and dropping them entirely would mean a
 * dentist choosing a drug could see neither the current medication nor whether anyone
 * had ever asked. Phase 5 gives this a proper panel; until then it is one chip.
 */
function HistoryDetail({ history }: { history?: HistoryRecord }) {
  if (!history?.recorded) return null;
  const reported = positives(history.answers ?? {});
  const meds = (history.answers?.current_meds ?? "").trim();
  const notes = (history.notes ?? "").trim();
  if (reported.length === 0 && !meds && !notes && !history.reviewedAt) return null;
  const when = history.reviewedAt
    ? new Date(history.reviewedAt).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" })
    : null;
  return (
    <Popover>
      <PopoverTrigger asChild>
        <button type="button" className="rounded-full border border-current/30 px-2 py-0.5 text-[11px] font-medium">
          {reported.length > 0 ? `${reported.length} reported` : "History"}{meds && " · on medication"}
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-80 space-y-2 text-xs">
        {reported.length > 0 && (
          <div>
            <p className="font-semibold">Reported</p>
            <p className="text-muted-foreground">{reported.join(" · ")}</p>
          </div>
        )}
        {meds && (
          <div>
            <p className="font-semibold">Current medication</p>
            <p className="text-muted-foreground">{meds}</p>
          </div>
        )}
        {notes && (
          <div>
            <p className="font-semibold">Notes</p>
            <p className="whitespace-pre-wrap text-muted-foreground">{notes}</p>
          </div>
        )}
        {when && (
          <p className="border-t pt-1.5 text-muted-foreground">
            Last confirmed {when}{history.reviewedBy ? ` by ${history.reviewedBy}` : ""}
          </p>
        )}
      </PopoverContent>
    </Popover>
  );
}

/** The "not sure" tail: visible without giving it a card of its own. */
function OpenQuestions({ items }: { items: string[] }) {
  return (
    <Popover>
      <PopoverTrigger asChild>
        <button type="button" className="rounded-full border border-current/30 px-2 py-0.5 text-[11px] font-medium">
          {items.length} not established
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-72">
        <p className="mb-1.5 text-xs font-semibold">Answered “not sure”</p>
        <ul className="space-y-1 text-xs text-muted-foreground">
          {items.map((i) => <li key={i}>· {i}</li>)}
        </ul>
      </PopoverContent>
    </Popover>
  );
}

/**
 * The compact strip, fetching for itself — for mounting inside dialogs.
 *
 * Radix dialogs cover the page, so the allergy the clinician needs sits behind the
 * overlay at exactly the moment they are choosing a drug. Both queries are already in
 * the cache keyed by this patient, so mounting this costs nothing.
 */
export function PatientSafetyLine({ patientId, className }: { patientId: string; className?: string }) {
  const { can } = useAuth();
  const clinician = can("dental.manage");
  const patient = useQuery({ queryKey: ["patient", patientId], queryFn: () => getPatient(patientId) });
  // Gated on the ROLE, not on whether data happens to be present: the endpoint is
  // dental.manage-only, so an unconditional fetch would 403 for anyone else.
  const history = useQuery({
    queryKey: ["medical-history", patientId],
    queryFn: () => getMedicalHistory(patientId),
    enabled: clinician,
  });
  return (
    <SafetyStrip
      compact
      className={className}
      allergies={patient.data?.allergies ?? []}
      history={clinician && history.data
        ? {
            answers: history.data.answers, recorded: history.data.recorded,
            reviewedAt: history.data.reviewed_at, reviewedBy: history.data.reviewed_by, notes: history.data.notes,
          }
        : undefined}
      isLoading={clinician && history.isPending && !history.isError}
      isError={clinician && history.isError}
    />
  );
}
