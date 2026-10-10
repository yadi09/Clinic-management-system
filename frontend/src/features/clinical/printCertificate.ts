// The medical certificate. The paper is drawn by the shared print engine
// (features/printing/templates/certificate.ts), so it carries the clinic's own
// identity, template and paper, wording and a DUPLICATE mark on a reprint.
import { requestPrint } from "@/features/printing/request";
import type { CertificateDoc } from "@/features/printing/engine";

export type CertificatePrint = CertificateDoc;

export async function printCertificate(o: CertificatePrint) {
  // The QR carries what a verifier needs to ring the clinic and quote it back.
  const qrData = `MC:${o.ref}\n${o.clinic}\n${o.patient}${o.mrn ? " " + o.mrn : ""}\n${o.issuedOn}`;
  await requestPrint({ doc: "certificate", data: { ...o, qrData } }, { clinic: o.clinic, contact: o.clinicContact });
}
