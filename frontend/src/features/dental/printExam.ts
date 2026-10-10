// Printing a dental examination.
//
// The clinical record leaves the building for three reasons: a referral to a
// specialist, a second opinion, and an insurance or legal request. All three want
// the assessment on one page. The paper is drawn by the shared print engine
// (features/printing/templates/exam.ts) in the clinic's own identity.
import type { Exam } from "@/features/dental/api";
import { requestPrint } from "@/features/printing/request";

export function printExamination(o: {
  clinic: string;
  clinicContact?: string;
  patient: string;
  mrn?: string;
  age?: number;
  gender?: string;
  exam: Exam;
}) {
  const e = o.exam;
  void requestPrint({
    doc: "exam",
    data: {
      patient: o.patient, mrn: o.mrn, age: o.age, gender: o.gender,
      visitDate: e.visit_date, recordedBy: e.recorded_by,
      chiefComplaint: e.chief_complaint, hpi: e.hpi, pastDentalHistory: e.past_dental_history,
      extraoral: e.extraoral, extraoralNotes: e.extraoral_notes,
      intraoral: e.intraoral, intraoralNotes: e.intraoral_notes,
      investigations: e.investigations, investigationResults: e.investigation_results,
      diagnosis: e.diagnosis, treatmentPlan: e.treatment_plan,
      treatmentGiven: e.treatment_given, anaesthesia: e.anaesthesia,
      procedures: e.procedures, complications: e.complications, postop: e.postop,
    },
  }, { clinic: o.clinic, contact: o.clinicContact });
}
