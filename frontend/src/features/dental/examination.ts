// The dental examination form: its option catalogues and the small helpers the
// card needs. Kept out of the component for the same reason as the medical-history
// catalogue — the server stores selections verbatim as JSON, so a clinic's form can
// grow here without a migration.
//
// The option wording follows Cure Dental's own paper form, so a clinician moving
// from paper finds the same words in the same order.

export interface ExamGroup {
  key: "extraoral" | "intraoral" | "investigations" | "treatment_given";
  title: string;
  blurb?: string;
  options: string[];
  /** Selecting this clears every other option in the group (and vice versa). */
  exclusive?: string;
}

export const EXAM_GROUPS: ExamGroup[] = [
  {
    key: "extraoral",
    title: "Extraoral examination",
    blurb: "Face, jaw joint and neck — what you see before the mouth opens.",
    options: [
      "Facial asymmetry",
      "Swelling / Lymphadenopathy",
      "TMJ tenderness / clicking",
      "Mouth opening restricted",
      "Lip competence normal",
      "Within normal limits",
    ],
    exclusive: "Within normal limits",
  },
  {
    key: "intraoral",
    title: "Intraoral examination",
    blurb: "Soft tissue, gingiva and dentition. Chart individual teeth on the odontogram above.",
    options: [
      "Soft tissue lesion",
      "Gingival inflammation",
      "Periodontal pockets",
      "Calculus / plaque",
      "Caries present",
      "Missing teeth",
      "Fractured tooth/teeth",
      "Malocclusion",
      "Halitosis",
    ],
  },
  {
    key: "investigations",
    title: "Investigations",
    options: [
      "Periapical X-ray",
      "Panoramic (OPG)",
      "Bitewing X-ray",
      "Vitality test",
      "Percussion test",
      "Lab investigation",
    ],
  },
  {
    key: "treatment_given",
    title: "Treatment given this visit",
    options: [
      "Scaling / Polishing",
      "Restoration (Filling)",
      "Root Canal Treatment",
      "Extraction",
      "Pulpotomy / Pulpectomy",
      "Incision & Drainage",
      "Prosthesis (denture/bridge)",
      "Orthodontic adjustment",
      "Fluoride / Sealant",
      "Suturing",
      "Impression taken",
      "Other",
    ],
  },
];

export const ANAESTHESIA = ["None", "Topical", "Local Infiltration", "Nerve Block"];

/**
 * Toggle one option within a group, honouring the group's exclusive option:
 * "within normal limits" and a list of abnormal findings cannot both be true.
 */
export function toggleOption(group: ExamGroup, selected: string[], option: string): string[] {
  const on = selected.includes(option);
  if (on) return selected.filter((v) => v !== option);
  if (group.exclusive) {
    if (option === group.exclusive) return [option];
    return [...selected.filter((v) => v !== group.exclusive), option];
  }
  return [...selected, option];
}

/**
 * The one-line summary shown on a collapsed examination row. Diagnosis is what a
 * clinician scans a history for, so it leads; the complaint is the fallback.
 */
export function examHeadline(e: { diagnosis?: string; chief_complaint?: string; treatment_given: string[] }): string {
  const first = (e.diagnosis || "").trim() || (e.chief_complaint || "").trim();
  if (first) return first;
  if (e.treatment_given.length > 0) return e.treatment_given.join(", ");
  return "Examination";
}

/** True when the form has nothing worth saving — guards against blank records. */
export function isBlankExam(e: {
  chief_complaint?: string; hpi?: string; past_dental_history?: string;
  extraoral: string[]; extraoral_notes?: string; intraoral: string[]; intraoral_notes?: string;
  investigations: string[]; investigation_results?: string; diagnosis?: string;
  treatment_plan?: string; treatment_given: string[]; anaesthesia?: string;
  complications?: string; procedures: { tooth?: string; procedure?: string; notes?: string }[]; postop?: string;
}): boolean {
  const text = [
    e.chief_complaint, e.hpi, e.past_dental_history, e.extraoral_notes, e.intraoral_notes,
    e.investigation_results, e.diagnosis, e.treatment_plan, e.complications, e.postop,
  ].some((v) => (v || "").trim() !== "");
  const picked = e.extraoral.length + e.intraoral.length + e.investigations.length + e.treatment_given.length > 0;
  const anaes = !!e.anaesthesia && e.anaesthesia !== "None";
  const rows = e.procedures.some((p) => (p.tooth || p.procedure || p.notes || "").trim() !== "");
  return !text && !picked && !anaes && !rows;
}
