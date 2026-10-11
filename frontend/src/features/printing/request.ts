// Asking for a paper: the one function every print button calls.
import { getPrintContext } from "@/features/printing/context";
import { build, pageHtml, qrSvg, refOf, transport, type DocData, type PrintJob } from "@/features/printing/engine";
import { docInfo } from "@/features/printing/catalog";
import type { DuplicateInfo, PrintCtx } from "@/features/printing/blocks";
import { logPrint, peekPrint, type PrintMark } from "@/features/printing/api";
import { issueCheck } from "@/features/printing/verify";
import type { RenderOpts } from "@/features/printing/templates/types";

/** Whatever shows the preview. Absent in tests and before sign-in: then it prints at once. */
type Opener = (job: PrintJob & { ctx: PrintCtx }) => void;
let opener: Opener | null = null;
export function registerPreview(fn: Opener | null) { opener = fn; }

const toDuplicate = (m: PrintMark | null | undefined): DuplicateInfo | null =>
  m && m.count >= 1 ? { count: m.count, firstBy: m.first_by, firstAt: m.first_at, lastBy: m.last_by, lastAt: m.last_at } : null;

export interface Legacy {
  /** The clinic name an older call site already has (used if nothing is set in Printing). */
  clinic?: string;
  /** A contact line an older call site already has. */
  contact?: string;
}

/**
 * A prescription that names itself (`verify`) gets its check from the server: the QR
 * becomes a link to the clinic's own record, with a short code under it. When the
 * server cannot be reached the paper is printed without a QR — a QR that checks
 * nothing would give a false sense of safety, and the paper is still a valid paper.
 */
async function withCheck(d: DocData): Promise<DocData> {
  if (d.doc !== "prescription" || !d.data.verify) return d;
  const { kind, id } = d.data.verify;
  try {
    const v = await issueCheck(kind, id);
    return {
      doc: "prescription",
      data: {
        ...d.data, rxRef: v.ref, qrData: `${window.location.origin}${v.path}`,
        verifyCode: v.code, verifyHost: window.location.host,
      },
    };
  } catch {
    return { doc: "prescription", data: { ...d.data, qrData: "", verifyCode: undefined } };
  }
}

/** Print a document with this clinic's look; shows the preview first when it can. */
export async function requestPrint(doc: DocData, legacy: Legacy = {}): Promise<void> {
  const d = await withCheck(doc);
  const base = getPrintContext();
  const ctx: PrintCtx = {
    ...base,
    clinicName: base.clinicName || legacy.clinic || "",
    fallbackContact: legacy.contact,
  };
  const info = docInfo(d.doc);
  const ref = (refOf(d) || "").trim();
  const counted = !!info?.logKind && ref !== "" && ref !== "—";
  const qr = "qrData" in d.data && d.data.qrData ? await qrSvg(d.data.qrData) : "";

  // Has this one been printed before? Looked at, not counted: only a print counts.
  let before: PrintMark | null = null;
  if (counted && ctx.settings.integrity.duplicateMark) {
    try { before = await peekPrint(info!.logKind!, ref); } catch { before = null; }
  }

  const job: PrintJob & { ctx: PrintCtx } = {
    ctx,
    doc: d.doc,
    ref: counted ? ref : "",
    title: refOf(d) || d.doc,
    duplicate: toDuplicate(before),
    render: (o: RenderOpts) => {
      const b = build(d, ctx, { qrSvg: qr, ...o });
      return { html: pageHtml(b, ctx), paper: b.paper, template: b.template };
    },
  };

  if (opener) { opener(job); return; }
  await printNow(job);
}

/** Count the print, then send the page — with the reprint mark if it is not the first. */
export async function printNow(job: PrintJob & { ctx: PrintCtx }, o: RenderOpts = {}): Promise<void> {
  let dup = job.duplicate ?? null;
  const info = docInfo(job.doc);
  if (job.ref && info?.logKind && job.ctx.settings.integrity.duplicateMark) {
    try {
      // The count includes this print, so the earlier ones are one fewer.
      const m = await logPrint(info.logKind, job.ref);
      dup = toDuplicate({ ...m, count: m.count - 1 });
    } catch { /* offline: print with what the preview knew */ }
  }
  transport.send(job.render({ ...o, duplicate: dup }).html);
}
