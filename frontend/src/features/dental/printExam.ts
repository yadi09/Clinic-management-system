// Printing a dental examination.
//
// The clinical record leaves the building for three reasons: a referral to a
// specialist, a second opinion, and an insurance or legal request. All three want
// the same thing — the assessment on one page, in the order a clinician reads it:
// what the patient complained of, what was found, what was concluded, what was done.
//
// Self-contained: the print window gets its own inline CSS and no network calls.
import type { Exam } from "@/features/dental/api";

function esc(s: unknown) {
  return String(s ?? "").replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c] as string));
}

/** A section is omitted entirely when empty — blank headings read as missing data. */
function block(title: string, inner: string): string {
  return inner.trim() ? `<section><h2>${esc(title)}</h2>${inner}</section>` : "";
}
function para(text?: string): string {
  return (text || "").trim() ? `<p>${esc(text).replace(/\n/g, "<br>")}</p>` : "";
}
function findings(items: string[], notes?: string): string {
  const chips = items.length ? `<ul class="chips">${items.map((i) => `<li>${esc(i)}</li>`).join("")}</ul>` : "";
  return chips + para(notes);
}

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
  const procedures = e.procedures.filter((p) => (p.tooth || p.procedure || p.notes || "").trim());
  const treatment = [
    e.treatment_given.length ? `<ul class="chips">${e.treatment_given.map((t) => `<li>${esc(t)}</li>`).join("")}</ul>` : "",
    e.anaesthesia && e.anaesthesia !== "None" ? `<p><span class="k">Anaesthesia</span>${esc(e.anaesthesia)}</p>` : "",
    procedures.length
      ? `<table class="proc"><thead><tr><th>Tooth</th><th>Procedure / material</th><th>Notes</th></tr></thead><tbody>${procedures
          .map((p) => `<tr><td class="nw">${esc(p.tooth)}</td><td>${esc(p.procedure)}</td><td>${esc(p.notes)}</td></tr>`)
          .join("")}</tbody></table>`
      : "",
    e.complications?.trim() ? `<p class="warn"><span class="k">Complications</span>${esc(e.complications)}</p>` : "",
  ].join("");

  const body = `
    <header>
      <div>
        <h1>${esc(o.clinic)}</h1>
        ${o.clinicContact ? `<div class="contact">${esc(o.clinicContact)}</div>` : ""}
        <div class="tag">Clinical examination</div>
      </div>
      <div class="when"><div class="k">Visit date</div><b>${esc(e.visit_date)}</b></div>
    </header>
    <div class="rule"></div>
    <div class="meta">
      <div>
        <div class="pname">${esc(o.patient)}</div>
        <div class="pmeta">${[o.mrn, o.age != null ? `${o.age} yrs` : "", o.gender].filter(Boolean).map(esc).join(" · ")}</div>
      </div>
      ${e.recorded_by ? `<div class="right"><span class="k">Examined by</span>${esc(e.recorded_by)}</div>` : ""}
    </div>
    ${block("Presenting complaint", para(e.chief_complaint) + para(e.hpi))}
    ${block("Past dental history", para(e.past_dental_history))}
    ${block("Extraoral examination", findings(e.extraoral, e.extraoral_notes))}
    ${block("Intraoral examination", findings(e.intraoral, e.intraoral_notes))}
    ${block("Investigations", findings(e.investigations, e.investigation_results))}
    ${block("Diagnosis", `<p class="dx">${esc(e.diagnosis || "")}</p>`.replace("<p class=\"dx\"></p>", ""))}
    ${block("Treatment plan", para(e.treatment_plan))}
    ${block("Treatment given this visit", treatment)}
    ${block("Post-operative instructions", para(e.postop))}
    <div class="foot">
      <div class="muted">Clinical record issued by ${esc(o.clinic)}. Confidential — for the named patient and their treating clinicians.</div>
      <div class="sign"><div class="line"></div>Signature &amp; stamp</div>
    </div>`;

  const w = window.open("", "_blank", "width=820,height=1000");
  if (!w) return;
  w.document.write(`<!doctype html><html><head><title>Examination — ${esc(o.patient)} — ${esc(e.visit_date)}</title><style>
    :root{--brand:#14532d;--ink:#111827;--muted:#6b7280;--line:#e5e7eb}
    @page{margin:15mm}
    *{box-sizing:border-box}
    body{font-family:ui-sans-serif,system-ui,-apple-system,Segoe UI,Roboto,sans-serif;color:var(--ink);margin:0;padding:26px;font-size:12.5px;line-height:1.45}
    header{display:flex;justify-content:space-between;align-items:flex-start;gap:20px}
    h1{font-size:20px;margin:0;color:var(--brand);line-height:1.1}
    .contact{font-size:11px;color:var(--muted);margin-top:2px}
    .tag{font-size:10px;letter-spacing:.16em;text-transform:uppercase;color:var(--muted);margin-top:4px}
    .when{text-align:right}
    .rule{height:3px;background:var(--brand);border-radius:2px;margin:12px 0 14px}
    .meta{display:flex;justify-content:space-between;gap:16px;align-items:flex-start;margin-bottom:4px}
    .pname{font-size:16px;font-weight:700}
    .pmeta{font-size:12px;color:var(--muted);margin-top:1px}
    .meta .right{font-size:12px;text-align:right}
    .k{display:block;color:var(--muted);font-size:9.5px;text-transform:uppercase;letter-spacing:.07em}
    p .k{display:inline;margin-right:6px}
    section{margin-top:14px;break-inside:avoid}
    h2{font-size:10.5px;text-transform:uppercase;letter-spacing:.08em;color:var(--brand);margin:0 0 5px;padding-bottom:3px;border-bottom:1px solid var(--line)}
    p{margin:0 0 5px}
    .dx{font-size:14px;font-weight:600}
    .warn{color:#9a3412}
    ul.chips{list-style:none;display:flex;flex-wrap:wrap;gap:5px;margin:0 0 6px;padding:0}
    ul.chips li{border:1px solid var(--line);border-radius:999px;padding:2px 9px;font-size:11px;background:#f9fafb}
    table.proc{width:100%;border-collapse:collapse;margin-top:6px}
    table.proc th{text-align:left;font-size:9.5px;text-transform:uppercase;letter-spacing:.05em;color:var(--muted);border-bottom:1px solid var(--line);padding:4px 8px 4px 0}
    table.proc td{padding:5px 8px 5px 0;border-bottom:1px solid #f3f4f6;vertical-align:top}
    .nw{white-space:nowrap}
    .foot{display:flex;justify-content:space-between;gap:32px;margin-top:34px;align-items:flex-end}
    .muted{color:var(--muted);font-size:10px;max-width:60%}
    .sign{text-align:center;font-size:10px;color:var(--muted)}
    .sign .line{border-top:1px solid #333;width:190px;margin-bottom:4px}
  </style></head><body>${body}
  <script>window.onload=function(){window.print();}<\/script></body></html>`);
  w.document.close();
}
