// The medical certificate, as it leaves the building.
//
// Read by someone who does not trust it by default — an employer deciding whether to
// pay for three days of absence, a school registrar — so it is built to be checked:
// a reference number, the clinic's own details, the clinician who signed it, a QR
// carrying the reference, and the Ethiopian date beside the Gregorian one.
//
// Two deliberate choices a generic "print view" would miss:
//   The diagnosis is omitted unless the clinician ticked otherwise. "Unfit for work"
//   is the part an employer is entitled to; what the patient suffers from is not.
//   A voided certificate still prints, watermarked VOID: refusing would leave the
//   copy already in someone's file as the only version in existence.
import {
  duplicateHtml, esc, footerHtml, label, showFlag, signatureBox, signer, stampBox, textSlot, topHtml, type PrintCtx,
} from "@/features/printing/blocks";
import { fmtDate } from "@/features/printing/format";
import { pick } from "@/features/printing/templates/resolve";
import type { Built, RenderOpts } from "@/features/printing/templates/types";

export interface CertificateDoc {
  /** Fallback clinic details from an older call site. */
  clinic: string;
  clinicContact?: string;
  ref: string;
  kind: "sick_leave" | "fitness" | "attendance";
  patient: string;
  mrn?: string;
  age?: string;
  gender?: string;
  diagnosis?: string;
  showDiagnosis: boolean;
  restDays?: number;
  restFrom?: string;
  restFromEc?: string;
  restTo?: string;
  restToEc?: string;
  notes?: string;
  issuedOn: string;
  issuedOnEc?: string;
  issuedBy?: string;
  branch?: string;
  status: "active" | "void";
  voidReason?: string;
  /** What the QR carries: enough for a verifier to ring the clinic and quote it back. */
  qrData?: string;
}

const TITLE_KEY: Record<CertificateDoc["kind"], string> = {
  sick_leave: "certificate.sickLeave", fitness: "certificate.fitness", attendance: "certificate.attendance",
};
const TEXT_KEY: Record<CertificateDoc["kind"], string> = { sick_leave: "sickLeave", fitness: "fitness", attendance: "attendance" };

/** The sentence the document exists to say. `**x**` is bold; {patient}, {date} and
 *  {days} are filled in. Everything is escaped before the markers are read. */
export function sentence(template: string, v: { patient: string; date: string; days: string }): string {
  return esc(template)
    .replace(/\{patient\}/g, `**${esc(v.patient)}**`)
    .replace(/\{date\}/g, esc(v.date))
    .replace(/\{days\}/g, `**${esc(v.days)}**`)
    .replace(/\*\*(.+?)\*\*/g, "<b>$1</b>");
}

export function renderCertificate(d: CertificateDoc, c: PrintCtx, o: RenderOpts = {}): Built {
  const { template, paper } = pick("certificate", c.settings, o);
  const loc = c.settings.locale;
  const flag = (id: string) => showFlag(c, "certificate", id);
  const isVoid = d.status === "void";
  const ec = flag("ethiopian");
  const date = `${d.issuedOn}${ec && d.issuedOnEc ? ` (${d.issuedOnEc})` : ""}`;
  const n = d.restDays ?? 0;
  const days = `${n} ${label(c, n === 1 ? "certificate.dayOne" : "certificate.dayMany")}`;
  const stmt = sentence(textSlot(c, "certificate", TEXT_KEY[d.kind]), { patient: d.patient, date, days });
  const period = d.restFrom && d.restTo
    ? `<table class="period">
         <tr><td class="k">${esc(label(c, "certificate.from"))}</td><td><b>${esc(d.restFrom)}</b>${ec && d.restFromEc ? ` · ${esc(d.restFromEc)}` : ""}</td></tr>
         <tr><td class="k">${esc(label(c, "certificate.to"))}</td><td><b>${esc(d.restTo)}</b>${ec && d.restToEc ? ` · ${esc(d.restToEc)}` : ""}</td></tr>
         <tr><td class="k">${esc(label(c, "certificate.days"))}</td><td><b>${d.restDays}</b> ${esc(label(c, "certificate.inclusive"))}</td></tr>
       </table>` : "";
  const qr = flag("qr") && o.qrSvg ? `<div class="qr">${o.qrSvg}<div class="ref">${esc(d.ref)}</div></div>` : `<div class="qr"><div class="ref">${esc(d.ref)}</div></div>`;
  const html = `
    ${isVoid ? `<div class="void-wm">${esc(label(c, "certificate.void"))}</div>` : ""}
    <div class="cert-top"><div style="flex:1">${topHtml(c, template)}</div>${qr}</div>
    <h2 class="cert-h">${esc(label(c, TITLE_KEY[d.kind]))}</h2>
    <table class="meta">
      <tr><td class="k">${esc(label(c, "common.patient"))}</td><td><b>${esc(d.patient)}</b></td>
          <td class="k">${esc(label(c, "certificate.mrn"))}</td><td>${esc(d.mrn ?? "—")}</td></tr>
      <tr><td class="k">${esc(label(c, "common.age"))}</td><td>${d.age ? `${esc(d.age)} years` : "—"}</td>
          <td class="k">${esc(label(c, "common.sex"))}</td><td class="cap">${esc(d.gender ?? "—")}</td></tr>
    </table>
    <p class="stmt">${stmt}</p>
    ${period}
    ${d.showDiagnosis && d.diagnosis ? `<p><span class="k">${esc(label(c, "prescription.diagnosis"))}</span> ${esc(d.diagnosis)}</p>` : ""}
    ${d.notes ? `<p class="notes">${esc(d.notes)}</p>` : ""}
    ${isVoid ? `<p class="voidnote">${esc(label(c, "certificate.voidNote"))}${d.voidReason ? ` (${esc(d.voidReason)})` : ""}</p>` : ""}
    <div class="cert-sign">
      ${flag("stamp") ? stampBox(label(c, "common.stamp")) : ""}
      ${flag("signature") ? `<div>${signatureBox(label(c, "certificate.role"), signer(c, "certificate", d.issuedBy))}<div class="muted">${esc(label(c, "certificate.issued"))} ${esc(fmtDate(d.issuedOn, loc))}${ec && d.issuedOnEc ? ` · ${esc(d.issuedOnEc)}` : ""}</div></div>` : ""}
    </div>
    ${duplicateHtml(c, o.duplicate, (iso) => fmtDate(iso, loc, true))}
    ${footerHtml(c, [`${esc(label(c, "certificate.verify"))}: ${esc(d.ref)}`])}`;
  return {
    html, paper, template, title: `${label(c, TITLE_KEY[d.kind])} — ${d.patient} — ${d.ref}`,
    css: `.cert-top{display:flex;justify-content:space-between;align-items:flex-start;gap:20px}
          .cert-h{font-size:1.2em;text-align:center;letter-spacing:.05em;text-transform:uppercase;margin:6px 0 16px}
          table.meta{width:100%;border-collapse:collapse;margin-bottom:14px}
          table.meta td{padding:4px 10px 4px 0;vertical-align:top}
          .k{color:var(--muted);font-size:.78em;text-transform:uppercase;letter-spacing:.07em;white-space:nowrap;width:1%}
          .cap{text-transform:capitalize}
          .stmt{font-size:1.07em;line-height:1.75;margin:0 0 14px;text-align:justify}
          table.period{border-collapse:collapse;margin:0 0 14px;border:1px solid var(--line)}
          table.period td{padding:6px 14px 6px 10px;border-bottom:1px solid var(--line)}
          table.period tr:last-child td{border-bottom:0}
          .notes{white-space:pre-wrap}
          .voidnote{color:#9f1239;font-weight:600}
          .cert-sign{display:flex;gap:24px;justify-content:space-between;align-items:flex-end;margin-top:34px}`,
  };
}
