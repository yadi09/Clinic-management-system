// A dental examination, printed for a referral, a second opinion or an insurer: the
// assessment on one page in the order a clinician reads it. A section with nothing in
// it is left out entirely — a blank heading reads as missing data.
import {
  duplicateHtml, esc, footerHtml, label, multiline, showFlag, signatureBox, signer, stampBox, textSlot, topHtml,
  type PrintCtx,
} from "@/features/printing/blocks";
import { fmtDate } from "@/features/printing/format";
import { pick } from "@/features/printing/templates/resolve";
import type { Built, RenderOpts } from "@/features/printing/templates/types";

export interface ExamDoc {
  patient: string;
  mrn?: string;
  age?: number;
  gender?: string;
  visitDate: string;
  recordedBy?: string;
  chiefComplaint?: string;
  hpi?: string;
  pastDentalHistory?: string;
  extraoral: string[];
  extraoralNotes?: string;
  intraoral: string[];
  intraoralNotes?: string;
  investigations: string[];
  investigationResults?: string;
  diagnosis?: string;
  treatmentPlan?: string;
  treatmentGiven: string[];
  anaesthesia?: string;
  procedures: { tooth?: string; procedure?: string; notes?: string }[];
  complications?: string;
  postop?: string;
}

const block = (title: string, inner: string) => (inner.trim() ? `<section><h3>${esc(title)}</h3>${inner}</section>` : "");
const para = (t?: string) => ((t || "").trim() ? `<p>${multiline(t!)}</p>` : "");
const chips = (items: string[], notes?: string) =>
  (items.length ? `<ul class="chips">${items.map((i) => `<li>${esc(i)}</li>`).join("")}</ul>` : "") + para(notes);

export function renderExam(d: ExamDoc, c: PrintCtx, o: RenderOpts = {}): Built {
  const { template, paper } = pick("exam", c.settings, o);
  const loc = c.settings.locale;
  const flag = (id: string) => showFlag(c, "exam", id);
  const procs = d.procedures.filter((p) => (p.tooth || p.procedure || p.notes || "").trim());
  const treatment = [
    d.treatmentGiven.length ? `<ul class="chips">${d.treatmentGiven.map((t) => `<li>${esc(t)}</li>`).join("")}</ul>` : "",
    d.anaesthesia && d.anaesthesia !== "None" ? `<p><span class="k2">${esc(label(c, "exam.anaesthesia"))}</span>${esc(d.anaesthesia)}</p>` : "",
    procs.length
      ? `<table class="proc"><thead><tr><th>${esc(label(c, "exam.tooth"))}</th><th>${esc(label(c, "exam.procedure"))}</th><th>${esc(label(c, "exam.notes"))}</th></tr></thead><tbody>${procs
        .map((p) => `<tr><td class="nw">${esc(p.tooth)}</td><td>${esc(p.procedure)}</td><td>${esc(p.notes)}</td></tr>`).join("")}</tbody></table>`
      : "",
    d.complications?.trim() ? `<p class="warn"><span class="k2">${esc(label(c, "exam.complications"))}</span>${esc(d.complications)}</p>` : "",
  ].join("");
  const meta = [d.mrn, d.age != null ? `${d.age} yrs` : "", d.gender].filter(Boolean).map(esc).join(" · ");
  const disclaimer = textSlot(c, "exam", "footer").trim();
  const html = `
    ${topHtml(c, template)}
    <div class="ex-top">
      <div><div class="ex-title">${esc(label(c, "exam.title"))}</div>
        <div class="pname">${esc(d.patient)}</div><div class="muted">${meta}</div></div>
      <div class="r"><div class="k2">${esc(label(c, "exam.visitDate"))}</div><b>${esc(fmtDate(d.visitDate, loc))}</b>
        ${d.recordedBy && flag("signerName") ? `<div><span class="k2">${esc(label(c, "exam.examinedBy"))}</span>${esc(d.recordedBy)}</div>` : ""}</div>
    </div>
    ${flag("complaint") ? block(label(c, "exam.complaint"), para(d.chiefComplaint) + para(d.hpi)) : ""}
    ${flag("history") ? block(label(c, "exam.history"), para(d.pastDentalHistory)) : ""}
    ${flag("findings") ? block(label(c, "exam.extraoral"), chips(d.extraoral, d.extraoralNotes)) : ""}
    ${flag("findings") ? block(label(c, "exam.intraoral"), chips(d.intraoral, d.intraoralNotes)) : ""}
    ${flag("investigations") ? block(label(c, "exam.investigations"), chips(d.investigations, d.investigationResults)) : ""}
    ${block(label(c, "exam.diagnosis"), d.diagnosis?.trim() ? `<p class="dxl">${esc(d.diagnosis)}</p>` : "")}
    ${flag("plan") ? block(label(c, "exam.plan"), para(d.treatmentPlan)) : ""}
    ${flag("given") ? block(label(c, "exam.given"), treatment) : ""}
    ${flag("postop") ? block(label(c, "exam.postop"), para(d.postop)) : ""}
    <div class="ex-foot">
      <div class="muted ex-disc">${disclaimer ? multiline(disclaimer) : ""}</div>
      <div style="display:flex;gap:14px;align-items:flex-end">
        ${flag("stamp") ? stampBox(label(c, "common.stamp")) : ""}
        ${flag("signature") ? signatureBox(label(c, "common.signatureStamp"), signer(c, "exam", d.recordedBy)) : ""}
      </div>
    </div>
    ${duplicateHtml(c, o.duplicate, (iso) => fmtDate(iso, loc, true))}
    ${footerHtml(c)}`;
  return {
    html, paper, template, title: `${label(c, "exam.title")} — ${d.patient} — ${d.visitDate}`,
    css: `.ex-top{display:flex;justify-content:space-between;gap:16px;align-items:flex-start;margin-bottom:6px}
          .ex-title{font-size:.78em;letter-spacing:.14em;text-transform:uppercase;color:var(--muted)}
          .pname{font-size:1.3em;font-weight:700} .r{text-align:right}
          .k2{color:var(--muted);font-size:.78em;text-transform:uppercase;letter-spacing:.07em;margin-right:6px}
          section{margin-top:12px;break-inside:avoid}
          h3{font-size:.8em;text-transform:uppercase;letter-spacing:.08em;color:var(--accent);margin:0 0 4px;padding-bottom:3px;border-bottom:1px solid var(--line)}
          p{margin:0 0 5px} .dxl{font-size:1.1em;font-weight:600} .warn{color:#9a3412}
          ul.chips{list-style:none;display:flex;flex-wrap:wrap;gap:5px;margin:0 0 6px;padding:0}
          ul.chips li{border:1px solid var(--line);border-radius:999px;padding:2px 9px;font-size:.88em;background:#f9fafb}
          table.proc{width:100%;border-collapse:collapse;margin-top:6px}
          table.proc th{text-align:left;font-size:.78em;text-transform:uppercase;color:var(--muted);border-bottom:1px solid var(--line);padding:4px 8px 4px 0}
          table.proc td{padding:5px 8px 5px 0;border-bottom:1px solid #f3f4f6;vertical-align:top} .nw{white-space:nowrap}
          .ex-foot{display:flex;justify-content:space-between;gap:24px;margin-top:26px;align-items:flex-end}
          .ex-disc{max-width:58%;font-size:.88em}`,
  };
}
