// The in-house laboratory report: the result as the laboratory states it, on the
// clinic's identity, with who drew the sample, who signed it off and when.
import {
  duplicateHtml, esc, footerHtml, headerHtml, label, multiline, showFlag, signatureBox, signer, stampBox, textSlot,
  type PrintCtx,
} from "@/features/printing/blocks";
import { fmtDate } from "@/features/printing/format";
import { pick } from "@/features/printing/templates/resolve";
import type { Built, RenderOpts } from "@/features/printing/templates/types";

export interface LabReportDoc {
  sampleNo: number;
  testName: string;
  patient: string;
  mrn?: string;
  priority?: string;
  status?: string;
  orderedBy?: string;
  specimen?: string;
  collectedBy?: string;
  collectedAt?: string;
  reportedAt?: string;
  validatedAt?: string;
  validatedBy?: string;
  clinicalNote?: string;
  analytes: { name: string; value?: string; unit?: string; refLow?: string; refHigh?: string; flag?: string }[];
  critical: boolean;
  notifiedAt?: string;
  notifiedBy?: string;
}

export function renderLabReport(d: LabReportDoc, c: PrintCtx, o: RenderOpts = {}): Built {
  const { template, paper } = pick("labreport", c.settings, o);
  const loc = c.settings.locale;
  const flag = (id: string) => showFlag(c, "labreport", id);
  const rows = d.analytes.map((a) => {
    const ref = [a.refLow, a.refHigh].some(Boolean) ? `${esc(a.refLow ?? "")}–${esc(a.refHigh ?? "")}${a.unit ? ` ${esc(a.unit)}` : ""}` : "—";
    const f = (a.flag || "normal").toLowerCase();
    const cls = f === "critical" ? "crit" : f === "high" || f === "low" ? "abn" : "";
    return `<tr class="${cls}"><td>${esc(a.name)}</td><td><b>${esc(a.value || "—")}</b>${a.value && a.unit ? ` ${esc(a.unit)}` : ""}</td>
      <td>${ref}</td>${flag("flags") ? `<td>${esc(f.toUpperCase())}</td>` : ""}</tr>`;
  }).join("");
  const sample = `S-${d.sampleNo}`;
  const trail = [
    flag("collection") && d.collectedAt ? `<div><span class="k2">${esc(label(c, "labreport.collected"))}</span> ${esc(fmtDate(d.collectedAt, loc, true))}${d.collectedBy ? ` · ${esc(d.collectedBy)}` : ""}</div>` : "",
    d.reportedAt ? `<div><span class="k2">${esc(label(c, "labreport.reported"))}</span> ${esc(fmtDate(d.reportedAt, loc, true))}</div>` : "",
    flag("validatedBy") && d.validatedBy ? `<div><span class="k2">${esc(label(c, "labreport.validatedBy"))}</span> ${esc(d.validatedBy)}${d.validatedAt ? ` · ${esc(fmtDate(d.validatedAt, loc, true))}` : ""}</div>` : "",
  ].join("");
  const critical = d.critical && flag("critical")
    ? `<p class="critnote">${esc(label(c, "labreport.critical"))}${d.notifiedAt
      ? ` — notified ${esc(fmtDate(d.notifiedAt, loc, true))}${d.notifiedBy ? ` by ${esc(d.notifiedBy)}` : ""}`
      : " — NOT YET COMMUNICATED"}</p>` : "";
  const disclaimer = textSlot(c, "labreport", "footer").trim();
  const html = `
    ${headerHtml(c)}
    <div class="lr-top">
      <div><div class="lr-title">${esc(label(c, "labreport.title"))}</div>
        <div class="muted">${esc(d.testName)} · ${esc(label(c, "labreport.sample"))} ${esc(sample)}${flag("specimen") && d.specimen ? ` · ${esc(d.specimen)}` : ""}</div></div>
      <div class="r"><div><b>${esc(d.patient)}</b></div><div class="muted">${d.mrn ? `${esc(label(c, "common.cardNo"))} ${esc(d.mrn)}` : ""}</div></div>
    </div>
    <div class="muted">${[d.priority ? `${esc(label(c, "labreport.priority"))} ${esc(d.priority)}` : "",
      flag("orderedBy") && d.orderedBy ? `${esc(label(c, "labreport.orderedBy"))} ${esc(d.orderedBy)}` : ""].filter(Boolean).join(" · ")}</div>
    ${d.clinicalNote && flag("clinicalNote") ? `<div class="muted">${esc(d.clinicalNote)}</div>` : ""}
    <table class="lr"><thead><tr><th>${esc(label(c, "labreport.analyte"))}</th><th>${esc(label(c, "labreport.result"))}</th>
      <th>${esc(label(c, "labreport.reference"))}</th>${flag("flags") ? `<th>${esc(label(c, "labreport.flag"))}</th>` : ""}</tr></thead>
      <tbody>${rows}</tbody></table>
    ${critical}
    <div class="lr-trail">${trail}</div>
    <div class="lr-foot">
      <div class="muted lr-disc">${disclaimer ? multiline(disclaimer) : ""}</div>
      <div style="display:flex;gap:14px;align-items:flex-end">
        ${flag("stamp") ? stampBox(label(c, "common.stamp")) : ""}
        ${flag("signature") ? signatureBox(label(c, "common.signatureStamp"), signer(c, "labreport", d.validatedBy)) : ""}
      </div>
    </div>
    ${duplicateHtml(c, o.duplicate, (iso) => fmtDate(iso, loc, true))}
    ${footerHtml(c, [`${esc(sample)}`])}`;
  return {
    html, paper, template, title: `${label(c, "labreport.title")} ${sample}`,
    css: `.lr-top{display:flex;justify-content:space-between;gap:14px;align-items:flex-start;margin-bottom:6px}
          .lr-title{font-size:1.3em;font-weight:700;color:var(--accent)} .r{text-align:right}
          .k2{color:var(--muted);font-size:.78em;text-transform:uppercase;letter-spacing:.06em;margin-right:6px}
          table.lr{width:100%;border-collapse:collapse;margin-top:10px}
          table.lr th{text-align:left;font-size:.78em;text-transform:uppercase;color:var(--muted);padding:6px 8px;border-bottom:2px solid var(--accent)}
          table.lr td{padding:6px 8px;border-bottom:1px solid var(--line)}
          tr.abn td{background:#fffbeb} tr.crit td{background:#fef2f2;font-weight:600;color:#b91c1c}
          .critnote{color:#b91c1c;font-weight:600;margin-top:12px}
          .lr-trail{margin-top:14px;font-size:.95em}
          .lr-foot{display:flex;justify-content:space-between;gap:20px;align-items:flex-end;margin-top:26px}
          .lr-disc{max-width:55%;font-size:.88em}`,
  };
}
