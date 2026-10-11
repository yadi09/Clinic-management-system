// Prescription and laboratory request: the same sheet with a different list on it.
//
// Three layouts. Classic is the full page with the clinic's header. Compact is the
// same at A5 with smaller type. Pad leaves the top blank for a clinic that already
// has its own printed pad or letterhead — which is how many clinics really work.
import {
  duplicateHtml, esc, footerHtml, identityOf, label, multiline, showFlag, signatureBox, signer, stampBox, textSlot, topHtml,
  type PrintCtx,
} from "@/features/printing/blocks";
import { fmtDate } from "@/features/printing/format";
import { pick } from "@/features/printing/templates/resolve";
import type { Built, RenderOpts } from "@/features/printing/templates/types";

export interface PrescriptionDoc {
  /** Fallback clinic name, used only when the clinic has set none in Printing. */
  clinic: string;
  clinicContact?: string;
  rxRef: string;
  /** What the QR carries. The print engine sets it to the paper's check link when
   *  `verify` is given; empty means no QR rather than a QR that checks nothing. */
  qrData: string;
  /** Names the prescription so the server can issue its check (see verification). */
  verify?: { kind: "dental_rx" | "encounter_rx"; id: string };
  /** Set by the engine from the issued check: the short code and the address. */
  verifyCode?: string;
  verifyHost?: string;
  patient: string;
  mrn?: string;
  age?: number;
  gender?: string;
  weightKg?: string;
  prescriber?: string;
  /** The prescriber's professional registration number, when known. */
  prescriberLicense?: string;
  when: string;
  diagnoses: { code?: string; description: string }[];
  /** What the visit was about when there is no diagnosis (a dental treatment). */
  context?: string;
  meds: { drug_name: string; dose?: string; frequency?: string; duration?: string; instructions?: string }[];
  note?: string;
  allergies?: string[];
}

export interface LabRequestDoc {
  clinic: string;
  clinicContact?: string;
  ref: string;
  qrData: string;
  patient: string;
  mrn?: string;
  age?: number;
  gender?: string;
  prescriber?: string;
  prescriberLicense?: string;
  when: string;
  tests: string[];
  indication?: string;
}

const SHEET_CSS = `
  .sheet-meta{display:flex;justify-content:space-between;gap:16px;align-items:flex-start}
  .pname{font-size:1.3em;font-weight:700;line-height:1.2}
  .pmeta{color:var(--muted);margin-top:2px}
  .side{text-align:right;font-size:.95em}
  .side .qr{display:flex;flex-direction:column;align-items:flex-end;margin-bottom:6px}
  .vcode{font-family:ui-monospace,Menlo,Consolas,monospace;font-size:1.05em;font-weight:700;letter-spacing:.08em;margin-top:2px}
  .vhint{font-size:.78em;color:var(--muted)}
  .side>div{margin-bottom:2px}
  .kk{color:var(--muted);font-size:.78em;text-transform:uppercase;letter-spacing:.06em;margin-right:6px}
  .dxline{margin-top:10px}
  .rxmark{font-size:1.9em;font-weight:700;color:var(--accent);margin:14px 0 0;line-height:1}
  ol.items{list-style:none;margin:8px 0 0;padding:0}
  ol.items li{padding:9px 0;border-bottom:1px dashed #cdd3da}
  ol.items li:first-child{border-top:1px dashed #cdd3da}
  .nm{font-size:1.15em;font-weight:700;display:flex;gap:10px;align-items:baseline}
  .num{display:inline-flex;align-items:center;justify-content:center;min-width:1.7em;height:1.7em;border-radius:50%;background:#ecf4ee;color:var(--accent);font-size:.8em;font-weight:700}
  .det{margin:2px 0 0 2.5em;color:#374151}
  .ins{margin:2px 0 0 2.5em;color:var(--muted);font-style:italic}
  .warnline{margin-top:10px;color:#9a3412}
  .grid-foot{display:flex;justify-content:space-between;align-items:flex-end;gap:20px;margin-top:30px}
  .grid-foot .valid{font-size:.88em;color:var(--muted);max-width:55%;line-height:1.5}
  .grid-foot .right{display:flex;gap:16px;align-items:flex-end}
  .compact{font-size:.93em}
  .compact .pname{font-size:1.15em}`;

function prescriberLine(c: PrintCtx, name?: string, license?: string, labelKey = "prescription.prescriber", doc: "prescription" | "labrequest" = "prescription"): string {
  if (!name || !showFlag(c, doc, "signerName")) return "";
  const lic = license && showFlag(c, doc, "license") ? ` · ${esc(label(c, "common.license"))} ${esc(license)}` : "";
  return `<div><span class="kk">${esc(label(c, labelKey))}</span>${esc(name)}${lic}</div>`;
}

export function renderPrescription(d: PrescriptionDoc, c: PrintCtx, o: RenderOpts = {}): Built {
  const { template, paper } = pick("prescription", c.settings, o);
  const loc = c.settings.locale;
  const flag = (id: string) => showFlag(c, "prescription", id);
  const dx = flag("diagnosis")
    ? d.diagnoses.map((x) => esc([x.code, x.description].filter(Boolean).join(" "))).join(", ") : "";
  const meds = d.meds.map((m, i) => {
    const detail = [m.dose, m.frequency, m.duration].filter(Boolean).map(esc).join(" · ");
    return `<li><div class="nm"><span class="num">${i + 1}</span>${esc(m.drug_name)}</div>
      ${detail ? `<div class="det">${detail}</div>` : ""}${m.instructions ? `<div class="ins">${esc(m.instructions)}</div>` : ""}</li>`;
  }).join("");
  const meta = [
    d.mrn ? `${esc(label(c, "common.cardNo"))} ${esc(d.mrn)}` : "",
    d.age != null ? `${esc(d.age)}${d.gender ? esc(d.gender[0].toUpperCase()) : ""}` : "",
    d.weightKg && flag("weight") ? `${esc(d.weightKg)} kg` : "",
  ].filter(Boolean).join("&nbsp;&nbsp;·&nbsp;&nbsp;");
  // Under the QR: the reference, and what to type when a camera will not read it.
  const qr = flag("qr") && o.qrSvg
    ? `<div class="qr">${o.qrSvg}<div class="ref">${esc(d.rxRef)}</div>${d.verifyCode
      ? `<div class="vcode">${esc(d.verifyCode)}</div><div class="vhint">${esc(label(c, "prescription.verifyAt"))} ${esc(d.verifyHost || "")}/v</div>` : ""}</div>` : "";
  const valid = flag("validity") ? multiline(textSlot(c, "prescription", "validity")) : "";
  // How long it stays valid, printed as a date so a pharmacist need not do the sum.
  const days = parseInt(textSlot(c, "prescription", "validDays"), 10);
  const until = days > 0 && !Number.isNaN(new Date(d.when).getTime())
    ? fmtDate(new Date(new Date(d.when).getTime() + days * 86_400_000).toISOString(), loc) : "";
  const dup = duplicateHtml(c, o.duplicate, (iso) => fmtDate(iso, loc, true));
  const title = label(c, "prescription.title");
  const id = identityOf(c);

  const html = `
    <div class="${template === "compact" ? "compact" : ""}">
    ${topHtml(c, template)}
    <div class="sheet-meta">
      <div>
        <div class="pname">${esc(d.patient)}</div>
        ${meta ? `<div class="pmeta">${meta}</div>` : ""}
      </div>
      <div class="side">
        ${qr}
        <div><span class="kk">${esc(label(c, "common.date"))}</span>${esc(fmtDate(d.when, loc))}</div>
        ${until ? `<div><span class="kk">${esc(label(c, "prescription.validUntil"))}</span>${esc(until)}</div>` : ""}
        ${prescriberLine(c, d.prescriber, d.prescriberLicense)}
      </div>
    </div>
    ${dx ? `<div class="dxline"><span class="kk">${esc(label(c, "prescription.diagnosis"))}</span>${dx}</div>` : ""}
    ${!dx && d.context ? `<div class="dxline"><span class="kk">${esc(label(c, "prescription.context"))}</span>${esc(d.context)}</div>` : ""}
    <div class="rxmark">℞ <span class="kk" style="font-size:.4em;vertical-align:middle">${esc(title)}</span></div>
    <ol class="items">${meds || `<li class="muted">—</li>`}</ol>
    ${d.note && flag("note") ? `<div class="dxline"><span class="kk">${esc(label(c, "common.note"))}</span>${esc(d.note)}</div>` : ""}
    ${flag("allergies") && d.allergies && d.allergies.length > 0
      ? `<div class="warnline"><span class="kk">${esc(label(c, "prescription.allergies"))}</span><b>${d.allergies.map(esc).join(", ")}</b></div>` : ""}
    <div class="grid-foot">
      <div class="valid">${valid}</div>
      <div class="right">
        ${flag("stamp") ? stampBox(label(c, "common.stamp")) : ""}
        ${flag("signature") ? signatureBox(label(c, "common.signatureStamp"), signer(c, "prescription", d.prescriber)) : ""}
      </div>
    </div>
    ${dup}
    ${footerHtml(c, [`${esc(id.nameEn)} · ${esc(d.rxRef)}`])}
    </div>`;
  return { html, paper, template, title: `${title} · ${d.patient}`, css: SHEET_CSS };
}

export function renderLabRequest(d: LabRequestDoc, c: PrintCtx, o: RenderOpts = {}): Built {
  const { template, paper } = pick("labrequest", c.settings, o);
  const loc = c.settings.locale;
  const flag = (id: string) => showFlag(c, "labrequest", id);
  const tests = d.tests.filter((t) => t.trim()).map((t, i) =>
    `<li><div class="nm"><span class="num">${i + 1}</span>${esc(t)}</div></li>`).join("");
  const meta = [
    d.mrn ? `${esc(label(c, "common.cardNo"))} ${esc(d.mrn)}` : "",
    d.age != null ? `${esc(d.age)}${d.gender ? esc(d.gender[0].toUpperCase()) : ""}` : "",
  ].filter(Boolean).join("&nbsp;&nbsp;·&nbsp;&nbsp;");
  const qr = flag("qr") && o.qrSvg ? `<div class="qr">${o.qrSvg}<div class="ref">${esc(d.ref)}</div></div>` : "";
  const dup = duplicateHtml(c, o.duplicate, (iso) => fmtDate(iso, loc, true));
  const title = label(c, "labrequest.title");
  const id = identityOf(c);
  const html = `
    <div class="${template === "compact" ? "compact" : ""}">
    ${topHtml(c, template)}
    <div class="sheet-meta">
      <div>
        <div class="kk" style="font-size:.9em">${esc(title)}</div>
        <div class="pname">${esc(d.patient)}</div>
        ${meta ? `<div class="pmeta">${meta}</div>` : ""}
      </div>
      <div class="side">
        ${qr}
        <div><span class="kk">${esc(label(c, "common.date"))}</span>${esc(fmtDate(d.when, loc))}</div>
        ${prescriberLine(c, d.prescriber, d.prescriberLicense, "labrequest.requestedBy", "labrequest")}
      </div>
    </div>
    ${d.indication && flag("indication")
      ? `<div class="dxline"><span class="kk">${esc(label(c, "labrequest.indication"))}</span>${esc(d.indication)}</div>` : ""}
    <div class="rxmark"><span class="kk" style="font-size:.5em;vertical-align:middle">${esc(label(c, "labrequest.tests"))}</span></div>
    <ol class="items">${tests || `<li class="muted">—</li>`}</ol>
    <div class="grid-foot">
      <div class="valid">${multiline(textSlot(c, "labrequest", "instruction"))}</div>
      <div class="right">${flag("signature") ? signatureBox(label(c, "common.signatureStamp"), signer(c, "labrequest", d.prescriber)) : ""}</div>
    </div>
    ${dup}
    ${footerHtml(c, [`${esc(id.nameEn)} · ${esc(d.ref)}`])}
    </div>`;
  return { html, paper, template, title: `${title} · ${d.patient}`, css: SHEET_CSS };
}
