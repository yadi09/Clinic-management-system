// The dental medical history questionnaire, and the safety alerts derived from it.
//
// This is the pre-treatment health check every dental patient should have on file:
// it is what tells the clinician whether it is safe to inject local anaesthetic,
// extract a tooth, or take a radiograph. The catalogue lives here (the server
// stores answers verbatim as JSON) so it can be extended without a migration.
//
// ALERTS are the point of the whole exercise. A questionnaire nobody reads is
// paperwork; a questionnaire that shouts "on warfarin — bleeding risk" before an
// extraction is a safety control. Each rule below states the clinical consequence,
// not just the condition.

export type AnswerMap = Record<string, string>;

export interface Question {
  key: string;
  label: string;
  /** "yesno" renders Yes / No / Not sure; "text" is free text. */
  type: "yesno" | "text";
  /** Ask only when this predicate passes (e.g. pregnancy for female patients). */
  onlyIf?: (ctx: { gender: string }) => boolean;
  hint?: string;
}

export interface Section {
  title: string;
  blurb?: string;
  questions: Question[];
}

export const HISTORY_SECTIONS: Section[] = [
  {
    title: "General health",
    blurb: "Conditions that change how dental treatment is planned or delivered.",
    questions: [
      { key: "heart_disease", label: "Heart disease, murmur or valve problem", type: "yesno" },
      { key: "pacemaker", label: "Pacemaker or implanted heart device", type: "yesno" },
      { key: "hypertension", label: "High blood pressure", type: "yesno" },
      { key: "diabetes", label: "Diabetes", type: "yesno" },
      { key: "asthma", label: "Asthma or breathing problems", type: "yesno" },
      { key: "epilepsy", label: "Epilepsy or seizures", type: "yesno" },
      { key: "bleeding_disorder", label: "Bleeding disorder, or bruises easily", type: "yesno" },
      { key: "kidney_disease", label: "Kidney disease", type: "yesno" },
      { key: "liver_disease", label: "Liver disease", type: "yesno" },
      { key: "thyroid", label: "Thyroid disorder", type: "yesno" },
      { key: "cancer_treatment", label: "Currently having cancer treatment (chemo / radiotherapy)", type: "yesno" },
    ],
  },
  {
    title: "Infection control",
    blurb: "Recorded so the right precautions are taken — never a reason to refuse care.",
    questions: [
      { key: "hepatitis", label: "Hepatitis B or C", type: "yesno" },
      { key: "hiv", label: "HIV", type: "yesno" },
      { key: "tuberculosis", label: "Tuberculosis", type: "yesno" },
    ],
  },
  {
    title: "Medication",
    questions: [
      { key: "blood_thinners", label: "Blood thinners (warfarin, aspirin, clopidogrel)", type: "yesno" },
      { key: "bisphosphonates", label: "Bone medication (bisphosphonates, denosumab)", type: "yesno", hint: "Raises the risk of jaw osteonecrosis after extraction." },
      { key: "steroids", label: "Steroids (prednisolone)", type: "yesno" },
      { key: "current_meds", label: "Other medication currently being taken", type: "text" },
    ],
  },
  {
    title: "Previous dental experience",
    questions: [
      { key: "anaesthetic_reaction", label: "Bad reaction to local anaesthetic", type: "yesno" },
      { key: "prolonged_bleeding", label: "Prolonged bleeding after a tooth extraction", type: "yesno" },
      { key: "fainting", label: "Fainted or felt faint during dental treatment", type: "yesno" },
      { key: "tmj", label: "Jaw joint pain or clicking", type: "yesno" },
      { key: "bruxism", label: "Grinds or clenches teeth", type: "yesno" },
    ],
  },
  {
    title: "Women",
    questions: [
      { key: "pregnant", label: "Pregnant", type: "yesno", onlyIf: (c) => c.gender === "female" },
      { key: "breastfeeding", label: "Breastfeeding", type: "yesno", onlyIf: (c) => c.gender === "female" },
    ],
  },
  {
    title: "Lifestyle",
    questions: [
      { key: "smoking", label: "Smokes", type: "yesno" },
      { key: "alcohol", label: "Drinks alcohol regularly", type: "yesno" },
      { key: "khat", label: "Chews khat", type: "yesno" },
    ],
  },
];

export interface Alert {
  key: string;
  /** danger = change the plan before treating; warn = proceed with care. */
  level: "danger" | "warn";
  text: string;
}

/** What we know about the record itself, as opposed to the answers in it. */
export interface HistoryMeta {
  /** false = the questionnaire has never been taken for this patient. */
  recorded?: boolean;
  /** ISO timestamp of the last time it was confirmed. */
  reviewedAt?: string;
}

/**
 * Turn answers into the handful of statements that should reach a clinician about
 * to treat this patient. Only "yes" triggers — "no" and "not sure" are silent,
 * except where not knowing is itself the risk.
 *
 * Pass `meta` wherever the record's own state is known. Without it, an empty answer
 * map produces an empty alert list, which reads as "this patient is cleared" — and a
 * patient nobody has ever questioned looks identical to one with a clean bill of
 * health. That is the single most dangerous silence this module can produce, so the
 * two states of the RECORD are raised as alerts in their own right.
 */
export function historyAlerts(a: AnswerMap, meta?: HistoryMeta): Alert[] {
  const yes = (k: string) => a[k] === "yes";
  // "Not sure" is not "no". For a handful of questions, not knowing is itself the
  // risk: you cannot decide on antibiotic prophylaxis, plan an extraction, or take
  // a radiograph safely on an open question. Those surface as amber "confirm
  // before treating" alerts rather than being silently treated as cleared.
  const unsure = (k: string) => a[k] === "unsure";
  const out: Alert[] = [];

  if (yes("blood_thinners") || yes("bleeding_disorder") || yes("prolonged_bleeding"))
    out.push({ key: "bleeding", level: "danger", text: "Bleeding risk — confirm before any extraction" });
  if (yes("bisphosphonates"))
    out.push({ key: "bisphos", level: "danger", text: "Bone medication — risk of jaw osteonecrosis; avoid extraction without advice" });
  if (yes("heart_disease") || yes("pacemaker"))
    out.push({ key: "cardiac", level: "danger", text: "Cardiac history — antibiotic prophylaxis may be required" });
  if (yes("anaesthetic_reaction"))
    out.push({ key: "anaesthetic", level: "danger", text: "Previous reaction to local anaesthetic" });
  if (yes("pregnant"))
    out.push({ key: "pregnant", level: "danger", text: "Pregnant — avoid radiographs; check drug safety" });

  if (yes("hepatitis") || yes("hiv") || yes("tuberculosis"))
    out.push({ key: "infection", level: "warn", text: "Enhanced infection-control precautions" });
  if (yes("diabetes"))
    out.push({ key: "diabetes", level: "warn", text: "Diabetes — slower healing, higher infection risk" });
  if (yes("hypertension"))
    out.push({ key: "bp", level: "warn", text: "High blood pressure — caution with adrenaline in anaesthetic" });
  if (yes("epilepsy"))
    out.push({ key: "epilepsy", level: "warn", text: "Seizure risk during treatment" });
  if (yes("asthma"))
    out.push({ key: "asthma", level: "warn", text: "Asthma — keep an inhaler within reach" });
  if (yes("fainting"))
    out.push({ key: "fainting", level: "warn", text: "Has fainted in the chair — treat semi-supine" });
  if (yes("liver_disease"))
    out.push({ key: "liver", level: "warn", text: "Liver disease — check drug doses and clotting" });
  if (yes("kidney_disease"))
    out.push({ key: "kidney", level: "warn", text: "Kidney disease — check drug doses (NSAIDs, some antibiotics)" });
  if (yes("steroids"))
    out.push({ key: "steroids", level: "warn", text: "On steroids — adrenal suppression; discuss before surgery" });
  if (yes("cancer_treatment"))
    out.push({ key: "onco", level: "warn", text: "On cancer treatment — liaise with the treating team" });
  if (yes("breastfeeding"))
    out.push({ key: "breastfeeding", level: "warn", text: "Breastfeeding — check drug safety" });

  // Unresolved answers on the questions that change what you may safely do.
  // Deliberately NOT infection status: standard precautions apply to every patient
  // regardless, so "HIV unknown" changes nothing and would only add noise.
  if (!yes("heart_disease") && !yes("pacemaker") && (unsure("heart_disease") || unsure("pacemaker")))
    out.push({ key: "cardiac?", level: "warn", text: "Cardiac history not established — confirm before treating" });
  if (!yes("blood_thinners") && !yes("bleeding_disorder") && !yes("prolonged_bleeding") &&
      (unsure("blood_thinners") || unsure("bleeding_disorder") || unsure("prolonged_bleeding")))
    out.push({ key: "bleeding?", level: "warn", text: "Bleeding risk not established — confirm before extraction" });
  if (!yes("anaesthetic_reaction") && unsure("anaesthetic_reaction"))
    out.push({ key: "anaesthetic?", level: "warn", text: "Past anaesthetic reaction unknown — confirm before injecting" });
  if (!yes("pregnant") && unsure("pregnant"))
    out.push({ key: "pregnant?", level: "warn", text: "Pregnancy status unknown — confirm before any radiograph" });

  // The state of the record itself. These lead, because "we never asked" outranks
  // anything the answers do or do not say.
  if (meta) {
    const state = reviewState(meta.reviewedAt, meta.recorded);
    if (state === "missing") {
      out.unshift({ key: "hx-missing", level: "danger", text: "No health check on file — take it before treating" });
    } else if (state === "due") {
      out.unshift({ key: "hx-stale", level: "warn", text: `Health check last confirmed ${staleFor(meta.reviewedAt)} — re-confirm` });
    }
  }

  return out;
}

/** "12 Jun 2025 (14 months ago)" — state the date, so the clinician can judge it. */
function staleFor(reviewedAt?: string): string {
  if (!reviewedAt) return "a long time ago";
  const d = new Date(reviewedAt);
  if (Number.isNaN(d.getTime())) return "a long time ago";
  const months = Math.floor((Date.now() - d.getTime()) / (1000 * 60 * 60 * 24 * 30.44));
  const when = d.toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });
  return `${when} (${months} months ago)`;
}

/** Questions answered "not sure" — an incomplete history is not a clear one. */
export function unresolved(a: AnswerMap): string[] {
  const out: string[] = [];
  for (const s of HISTORY_SECTIONS) {
    for (const q of s.questions) {
      if (q.type === "yesno" && a[q.key] === "unsure") out.push(q.label);
    }
  }
  return out;
}

/** A history older than this is stale enough that it must be re-confirmed. */
export const REVIEW_MONTHS = 12;

export function reviewState(reviewedAt?: string, recorded?: boolean): "missing" | "due" | "current" {
  if (!recorded || !reviewedAt) return "missing";
  const months = (Date.now() - new Date(reviewedAt).getTime()) / (1000 * 60 * 60 * 24 * 30.44);
  return months >= REVIEW_MONTHS ? "due" : "current";
}

/** Every question the patient answered "yes" to, for the summary view. */
export function positives(a: AnswerMap): string[] {
  const labels: string[] = [];
  for (const s of HISTORY_SECTIONS) {
    for (const q of s.questions) {
      if (q.type === "yesno" && a[q.key] === "yes") labels.push(q.label);
    }
  }
  return labels;
}
