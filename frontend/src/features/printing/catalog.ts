// What can be chosen for each kind of document.
//
// The Settings screen is drawn from this list, not hand-built per document: adding a
// template, a switch or a wording slot here adds it to the screen, to the preview and
// to the stored settings without touching the screen's code.
import type { DocId, PaperId, PrintSettings } from "@/features/printing/settings";

export interface TemplateInfo {
  id: string;
  label: string;
  description: string;
  /** The paper a clinic gets when it picks this template and has not chosen one. */
  paper: PaperId;
  /** Papers this template draws well on. */
  papers: PaperId[];
}
export interface ToggleInfo {
  id: string;
  label: string;
  default: boolean;
  help?: string;
  /** Read from another setting while this paper has no choice of its own. */
  fallback?: (s: PrintSettings) => boolean;
}
export interface TextInfo { id: string; label: string; default: string; help?: string; multiline?: boolean }

export interface DocInfo {
  id: DocId;
  label: string;
  /** What this paper is for, in one line, shown above its options. */
  purpose: string;
  templates: TemplateInfo[];
  toggles: ToggleInfo[];
  texts: TextInfo[];
  /** Label keys the clinic may reword for this document (see labels.ts). */
  labels: string[];
  /** Print log kind: set when a reprint should be told apart from the original. */
  logKind?: string;
  /**
   * Whether this clinic can ever print this paper, from the same module flags the
   * sidebar uses (which already carry the plan's entitlements). Omitted: every clinic.
   * A paper the clinic has no use for is not offered, not merely left at its defaults.
   */
  available?: (on: (flag: string) => boolean) => boolean;
}

const ALL: PaperId[] = ["slip58", "slip80", "a5", "a4"];

// A name under a signature line is the signer's, and several people may work from one
// account: the clinic can leave the line for whoever signs. One switch for every paper
// (Footer & reprints) that each paper can override.
const SIGNER: ToggleInfo = {
  id: "signerName", label: "Name under the signature line", default: true,
  help: "Turn off when several people sign from one account: the line is left blank for whoever signs.",
  fallback: (s) => s.signature.showName,
};
const DOCTOR: ToggleInfo = {
  id: "doctorName", label: "Doctor's name in the details at the top", default: true,
  help: "Turn off together with the signature name when several doctors share one account.",
  fallback: (s) => s.signature.showName,
};

export const CATALOG: DocInfo[] = [
  {
    id: "receipt",
    label: "Receipts",
    purpose: "Proof of payment for the patient, and the clinic's record of what it took, from whom, how and who received it.",
    logKind: "receipt",
    templates: [
      { id: "slip", label: "Till slip", description: "Narrow roll for a thermal receipt printer.", paper: "slip80", papers: ["slip58", "slip80"] },
      { id: "sheet", label: "Receipt sheet", description: "A5 or A4 page with the clinic's header, a lines table and signature boxes.", paper: "a5", papers: ["a5", "a4"] },
    ],
    toggles: [
      { id: "mrn", label: "Patient card number", default: true },
      { id: "phone", label: "Patient phone", default: false },
      { id: "time", label: "Time of payment", default: true },
      { id: "cashier", label: "Who received it", default: true },
      { id: "method", label: "How it was paid", default: true },
      { id: "reference", label: "Transfer reference", default: true },
      { id: "inWords", label: "Amount in words", default: false, help: "\"One thousand five hundred birr only\"." },
      { id: "balance", label: "Balance remaining (when known)", default: true },
      { id: "customerSign", label: "Customer signature line", default: false },
      { id: "stamp", label: "Stamp box", default: false },
    ],
    texts: [
      { id: "thanks", label: "Thank-you line", default: "Thank you. Keep this receipt for your records." },
      { id: "terms", label: "Terms", default: "", help: "For example: \"Payments are not refundable after 7 days.\"", multiline: true },
    ],
    labels: ["receipt.title", "receipt.refundTitle", "receipt.refundedTitle", "receipt.number", "common.patient", "common.cardNo", "common.date",
      "receipt.method", "receipt.reference", "receipt.cashier", "common.total", "receipt.inWords", "receipt.balance", "receipt.customerSign", "common.stamp"],
  },
  {
    id: "prescription",
    label: "Prescriptions",
    purpose: "The authority for a pharmacy to dispense, and the patient's instructions. Read by strangers, so it has to be unambiguous.",
    logKind: "prescription",
    templates: [
      { id: "classic", label: "Classic", description: "Full header with the clinic's identity, QR and signature.", paper: "a4", papers: ["a4", "a5"] },
      { id: "compact", label: "Compact", description: "Smaller type for an A5 sheet.", paper: "a5", papers: ["a5", "a4"] },
      { id: "pad", label: "Pre-printed pad", description: "No header: leaves the top blank for your own letterhead.", paper: "a5", papers: ["a5", "a4"] },
    ],
    toggles: [
      { id: "diagnosis", label: "Diagnosis", default: true, help: "Some patients prefer it is not on a paper they hand to a pharmacy." },
      { id: "weight", label: "Patient weight", default: true },
      { id: "allergies", label: "Allergies", default: true },
      { id: "note", label: "Prescriber's note", default: true },
      { id: "qr", label: "QR and reference", default: true },
      { id: "license", label: "Prescriber's licence number", default: true },
      { id: "signature", label: "Signature line", default: true },
      { id: "stamp", label: "Stamp box", default: true },
      { id: "validity", label: "Validity line", default: true },
      SIGNER,
      DOCTOR,
    ],
    texts: [
      { id: "validity", label: "Validity line", default: "Valid only with the prescriber's signature & clinic stamp. Present this prescription at any licensed pharmacy.", multiline: true },
    ],
    labels: ["prescription.title", "common.patient", "common.cardNo", "common.date", "common.age", "common.weight", "prescription.diagnosis",
      "prescription.context", "prescription.allergies", "prescription.prescriber", "common.note", "common.signatureStamp", "common.stamp"],
  },
  {
    id: "labrequest",
    label: "Lab requests",
    purpose: "The patient carries it to an outside laboratory: which tests, why, and from whom.",
    available: (on) => !on("dental") && !on("laboratory"),
    logKind: "labrequest",
    templates: [
      { id: "classic", label: "Classic", description: "Full header with the clinic's identity, QR and signature.", paper: "a4", papers: ["a4", "a5"] },
      { id: "compact", label: "Compact", description: "Smaller type for an A5 sheet.", paper: "a5", papers: ["a5", "a4"] },
      { id: "pad", label: "Pre-printed pad", description: "No header: leaves the top blank for your own letterhead.", paper: "a5", papers: ["a5", "a4"] },
    ],
    toggles: [
      { id: "indication", label: "Clinical indication", default: true },
      { id: "qr", label: "QR and reference", default: true },
      { id: "signature", label: "Signature line", default: true },
      { id: "license", label: "Requester's licence number", default: true },
      SIGNER,
      DOCTOR,
    ],
    texts: [
      { id: "instruction", label: "Instruction to the lab", default: "Please perform the tests above and return the report to the patient / referring clinic.", multiline: true },
    ],
    labels: ["labrequest.title", "common.patient", "common.date", "labrequest.tests", "labrequest.indication", "labrequest.requestedBy", "common.signatureStamp"],
  },
  {
    id: "statement",
    label: "Statements of account",
    purpose: "What a patient has been charged, paid and still owes — handed to the patient, an employer or an insurer.",
    templates: [
      { id: "standard", label: "Statement", description: "Header, the patient's lines, totals and where to pay.", paper: "a4", papers: ["a4", "a5"] },
    ],
    toggles: [
      { id: "status", label: "Status column (paid / unpaid)", default: true },
      { id: "phone", label: "Patient phone", default: false },
      { id: "issuedBy", label: "Who issued it", default: true },
      { id: "payTo", label: "How to pay (the clinic's accounts)", default: true, help: "Lists the accounts the clinic has set up to be paid into." },
      { id: "signature", label: "Signature line", default: false },
      { id: "stamp", label: "Stamp box", default: false },
    ],
    texts: [
      { id: "terms", label: "Terms or note", default: "", help: "For example: \"Please settle within 14 days.\"", multiline: true },
    ],
    labels: ["statement.title", "statement.charged", "statement.paid", "statement.refunded", "statement.outstanding", "statement.balanceNow",
      "statement.payTo", "common.patient", "common.cardNo", "common.phone", "common.stamp", "common.signatureStamp"],
  },
  {
    id: "zreport",
    label: "End-of-day Z-report",
    purpose: "The cashier's close-out: what was collected, how the drawer reconciled, signed by the cashier and the manager.",
    logKind: "zreport",
    templates: [
      { id: "slip", label: "Till slip", description: "Narrow roll, printed beside the till.", paper: "slip80", papers: ["slip58", "slip80"] },
      { id: "sheet", label: "A5 / A4 sheet", description: "For filing in the clinic's cash book.", paper: "a5", papers: ["a5", "a4"] },
    ],
    toggles: [
      { id: "printedAt", label: "Time it was printed", default: true },
      { id: "signature", label: "Cashier signature line", default: true },
      { id: "managerSign", label: "Manager signature line", default: true },
      SIGNER,
    ],
    texts: [{ id: "footer", label: "Closing line", default: "", multiline: true }],
    labels: ["zreport.title", "zreport.cashier", "zreport.businessDate", "zreport.collected", "zreport.expected", "zreport.counted",
      "zreport.variance", "zreport.balanced", "zreport.over", "zreport.short", "zreport.cashierSign", "zreport.managerSign"],
  },
  {
    id: "labreport",
    label: "Lab reports",
    purpose: "The laboratory's result for one sample: what was found, what is normal, who collected and who validated it.",
    available: (on) => on("laboratory"),
    logKind: "labreport",
    templates: [
      { id: "standard", label: "Report", description: "Header, patient, a results table with reference ranges and flags.", paper: "a4", papers: ["a4", "a5"] },
    ],
    toggles: [
      { id: "orderedBy", label: "Ordered by", default: true },
      { id: "specimen", label: "Specimen type", default: true },
      { id: "collection", label: "Collected / reported times", default: true },
      { id: "flags", label: "High / low flags", default: true },
      { id: "critical", label: "Critical value warning", default: true },
      { id: "clinicalNote", label: "Clinical note", default: true },
      { id: "validatedBy", label: "Validated by", default: true },
      { id: "signature", label: "Signature line", default: true },
      { id: "stamp", label: "Stamp box", default: false },
      SIGNER,
    ],
    texts: [{ id: "footer", label: "Closing line", default: "Results relate only to the sample received. Interpret with the clinical picture.", multiline: true }],
    labels: ["labreport.title", "labreport.sample", "labreport.analyte", "labreport.result", "labreport.reference", "labreport.flag",
      "labreport.validatedBy", "labreport.critical", "common.patient", "common.cardNo", "common.signatureStamp", "common.stamp"],
  },
  {
    id: "certificate",
    label: "Medical certificates",
    purpose: "Read by an employer or a school that does not trust it by default, so it carries a reference, a QR, a signature and — when voided — a clear mark.",
    logKind: "certificate",
    templates: [
      { id: "standard", label: "Standard", description: "Full header with the clinic's identity, the statement, the period and a signature.", paper: "a4", papers: ["a4", "a5"] },
      { id: "pad", label: "Pre-printed pad", description: "No header: leaves the top blank for your own letterhead.", paper: "a5", papers: ["a5", "a4"] },
    ],
    toggles: [
      { id: "ethiopian", label: "Ethiopian dates beside the Gregorian", default: true },
      { id: "qr", label: "QR and reference", default: true },
      { id: "signature", label: "Signature line", default: true },
      { id: "stamp", label: "Stamp box", default: true },
      SIGNER,
    ],
    texts: [
      { id: "sickLeave", label: "Sick leave wording", default: "This is to certify that {patient} attended this clinic and was examined on {date}. In my professional opinion the patient is **unfit for work or study** and requires rest for {days}.", help: "{patient}, {date} and {days} are filled in. **text** is bold.", multiline: true },
      { id: "fitness", label: "Fitness wording", default: "This is to certify that {patient} was examined at this clinic on {date} and is, in my professional opinion, **fit to resume normal duties**.", multiline: true },
      { id: "attendance", label: "Attendance wording", default: "This is to certify that {patient} **attended this clinic** on {date} and received medical attention.", multiline: true },
    ],
    labels: ["certificate.sickLeave", "certificate.fitness", "certificate.attendance", "certificate.from", "certificate.to", "certificate.days",
      "certificate.role", "certificate.void", "common.patient", "common.age", "common.sex", "common.stamp"],
  },
  {
    id: "exam",
    label: "Dental examinations",
    purpose: "The assessment on one page, in the order a clinician reads it — for a referral, a second opinion or an insurer.",
    available: (on) => on("dental"),
    templates: [
      { id: "standard", label: "Standard", description: "Header, then each section that has something in it.", paper: "a4", papers: ["a4", "a5"] },
      { id: "pad", label: "Pre-printed pad", description: "No header: leaves the top blank for your own letterhead.", paper: "a4", papers: ["a4", "a5"] },
    ],
    toggles: [
      { id: "complaint", label: "Presenting complaint", default: true },
      { id: "history", label: "Past dental history", default: true },
      { id: "findings", label: "Extraoral and intraoral findings", default: true },
      { id: "investigations", label: "Investigations", default: true },
      { id: "plan", label: "Treatment plan", default: true },
      { id: "given", label: "Treatment given", default: true },
      { id: "postop", label: "Post-operative instructions", default: true },
      { id: "signature", label: "Signature line", default: true },
      { id: "stamp", label: "Stamp box", default: false },
      SIGNER,
      DOCTOR,
    ],
    texts: [{ id: "footer", label: "Note under the sections", default: "Confidential — for the named patient and their treating clinicians.", multiline: true }],
    labels: ["exam.title", "exam.visitDate", "exam.examinedBy", "exam.complaint", "exam.history", "exam.extraoral", "exam.intraoral",
      "exam.investigations", "exam.diagnosis", "exam.plan", "exam.given", "exam.postop", "common.signatureStamp", "common.stamp"],
  },
  {
    id: "dispense",
    label: "Dispensing slips",
    purpose: "What the pharmacy handed over, how to take it, and from which batch — the patient's copy and the pharmacy's record.",
    available: (on) => on("pharmacy"),
    logKind: "dispense",
    templates: [
      { id: "slip", label: "Till slip", description: "Narrow roll for a thermal printer at the dispensing hatch.", paper: "slip80", papers: ["slip58", "slip80"] },
      { id: "sheet", label: "A5 / A4 sheet", description: "A page with a table of medicines.", paper: "a5", papers: ["a5", "a4"] },
    ],
    toggles: [
      { id: "batch", label: "Batch and expiry", default: true },
      { id: "allergies", label: "Allergies", default: true },
      { id: "counselling", label: "Counselling note", default: true },
      { id: "signature", label: "Dispenser's signature line", default: true },
      SIGNER,
    ],
    texts: [{ id: "footer", label: "Closing line", default: "Keep medicines out of reach of children. Finish the course unless told otherwise.", multiline: true }],
    labels: ["dispense.title", "dispense.prescription", "dispense.drug", "dispense.qty", "dispense.batch", "dispense.counselling",
      "common.patient", "common.date", "common.signature"],
  },
];

export const docInfo = (id: DocId): DocInfo | undefined => CATALOG.find((d) => d.id === id);

/** The papers this clinic can print, given its module flags. */
export const docsFor = (on: (flag: string) => boolean): DocInfo[] => CATALOG.filter((d) => !d.available || d.available(on));
export { ALL as ALL_PAPERS };
