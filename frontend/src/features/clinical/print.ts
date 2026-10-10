// Prescription and laboratory request. The paper is drawn by the shared print engine
// (features/printing) so it carries the clinic's own identity, template and paper, and
// says DUPLICATE when it is a reprint.
import { requestPrint } from "@/features/printing/request";
import type { LabRequestDoc, PrescriptionDoc } from "@/features/printing/engine";

export type { LabRequestDoc, PrescriptionDoc };

export async function printPrescription(o: PrescriptionDoc) {
  await requestPrint({ doc: "prescription", data: o }, { clinic: o.clinic, contact: o.clinicContact });
}

export async function printLabRequest(o: LabRequestDoc) {
  await requestPrint({ doc: "labrequest", data: o }, { clinic: o.clinic, contact: o.clinicContact });
}
