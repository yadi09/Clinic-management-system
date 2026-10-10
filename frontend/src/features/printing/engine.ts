// From a document to paper.
//
// The engine owns three things the individual print buttons used to do for
// themselves, six different ways: building the page (the shared rules plus the
// template's own), getting it to a printer, and knowing whether this paper has been
// printed before so a reprint says DUPLICATE.
//
// Printing goes through a hidden frame inside the page rather than a new window, so
// a pop-up blocker cannot silently swallow it, and through a preview dialog so the
// person sees the paper before it prints.
import QRCode from "qrcode";

import { baseCss, type DuplicateInfo, type PrintCtx } from "@/features/printing/blocks";
import { PAPERS, type DocId, type PaperId } from "@/features/printing/settings";
import { renderCertificate, type CertificateDoc } from "@/features/printing/templates/certificate";
import { renderDispense, type DispenseDoc } from "@/features/printing/templates/dispense";
import { renderExam, type ExamDoc } from "@/features/printing/templates/exam";
import { renderLabReport, type LabReportDoc } from "@/features/printing/templates/labreport";
import { renderReceipt, type ReceiptDoc } from "@/features/printing/templates/receipt";
import { renderStatement, type StatementDoc } from "@/features/printing/templates/statement";
import { renderZReport, type ZReportDoc } from "@/features/printing/templates/zreport";
import { renderLabRequest, renderPrescription, type LabRequestDoc, type PrescriptionDoc } from "@/features/printing/templates/sheet";
import type { Built, RenderOpts } from "@/features/printing/templates/types";

export type { ReceiptDoc, PrescriptionDoc, LabRequestDoc, StatementDoc, ZReportDoc, LabReportDoc, CertificateDoc, ExamDoc, DispenseDoc };
export type DocData =
  | { doc: "receipt"; data: ReceiptDoc }
  | { doc: "prescription"; data: PrescriptionDoc }
  | { doc: "labrequest"; data: LabRequestDoc }
  | { doc: "statement"; data: StatementDoc }
  | { doc: "zreport"; data: ZReportDoc }
  | { doc: "labreport"; data: LabReportDoc }
  | { doc: "certificate"; data: CertificateDoc }
  | { doc: "exam"; data: ExamDoc }
  | { doc: "dispense"; data: DispenseDoc };

/** A whole HTML page for one built document. */
export function pageHtml(b: Built, c: PrintCtx, o: { preview?: boolean } = {}): string {
  return `<!doctype html><html><head><meta charset="utf-8"><title>${b.title.replace(/[<>&]/g, "")}</title>
<style>${baseCss(c, b.paper)}${b.css}${o.preview ? "body{padding:0}" : ""}</style></head><body>${b.html}</body></html>`;
}

/** Draw a QR as inline SVG so the print frame needs no network. */
export async function qrSvg(data: string): Promise<string> {
  try {
    return await QRCode.toString(data, { type: "svg", margin: 0, errorCorrectionLevel: "M" });
  } catch {
    return ""; // a paper without a QR is still a valid paper
  }
}

/** The reference a paper is counted under, for the reprint mark. */
export function refOf(d: DocData): string {
  switch (d.doc) {
    case "receipt": return d.data.number;
    case "prescription": return d.data.rxRef;
    case "labrequest": return d.data.ref;
    // A statement is regenerated with new figures each time; it is not counted.
    case "statement": return "";
    // One close-out per cashier per business day.
    case "zreport": return `Z-${d.data.businessDate}-${d.data.cashier}`;
    case "labreport": return `S-${d.data.sampleNo}`;
    case "certificate": return d.data.ref;
    case "exam": return "";
    // A slip printed before the hand-over is a different paper from the final one.
    case "dispense": return `${d.data.rxRef}${d.data.pending ? "-pending" : ""}`;
  }
}

/** Build one document with the clinic's settings. Synchronous: QR is prepared by the caller. */
export function build(d: DocData, c: PrintCtx, o: RenderOpts = {}): Built {
  switch (d.doc) {
    case "receipt": return renderReceipt(d.data, c, o);
    case "prescription": return renderPrescription(d.data, c, o);
    case "labrequest": return renderLabRequest(d.data, c, o);
    case "statement": return renderStatement(d.data, c, o);
    case "zreport": return renderZReport(d.data, c, o);
    case "labreport": return renderLabReport(d.data, c, o);
    case "certificate": return renderCertificate(d.data, c, o);
    case "exam": return renderExam(d.data, c, o);
    case "dispense": return renderDispense(d.data, c, o);
  }
}

export interface PrintJob {
  doc: DocId;
  /** Counted in the print log under (doc, ref); empty means "do not count". */
  ref: string;
  title: string;
  /** Draw the document with a template/paper/duplicate override. */
  render: (o: RenderOpts) => { html: string; paper: PaperId; template: string };
  /** Templates and papers this document offers, for the preview's pickers. */
  duplicate?: DuplicateInfo | null;
}

// --- delivery ---------------------------------------------------------------------------

/**
 * Where finished pages go. A hidden frame by default; tests replace `send` to read
 * what would have printed without a printer.
 */
export const transport = {
  send(html: string): void {
    const frame = document.createElement("iframe");
    frame.setAttribute("aria-hidden", "true");
    Object.assign(frame.style, { position: "fixed", right: "0", bottom: "0", width: "0", height: "0", border: "0" });
    document.body.appendChild(frame);
    const w = frame.contentWindow;
    if (!w) { frame.remove(); return; }
    w.document.open();
    w.document.write(html);
    w.document.close();
    // The page has no network to wait for (the logo and QR are inline), so a short
    // tick is enough for layout; then the frame removes itself after printing.
    setTimeout(() => {
      try { w.focus(); w.print(); } finally { setTimeout(() => frame.remove(), 1500); }
    }, 50);
  },
};

/** The size of a paper in CSS pixels at 96 dpi — what a preview frame is drawn at. */
export function paperPx(p: PaperId): { w: number; h: number | null } {
  const mm = 96 / 25.4;
  const d = PAPERS[p];
  return { w: Math.round(d.widthMm * mm), h: d.heightMm === null ? null : Math.round(d.heightMm * mm) };
}

