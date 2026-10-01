// Prescription print: open a blank window, write a clean, branded, self-contained
// script, and trigger the browser print dialog. Used when the clinic has no
// in-house pharmacy — the patient takes the printed prescription to an outside one.
//
// The QR (top-right) is generated here as inline SVG so the print window needs no
// network (it carries a verification reference back to this encounter).
import QRCode from "qrcode";

function esc(s: unknown) {
  return String(s ?? "").replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c] as string));
}

// Shared print sheet styling (prescription + lab request).
const SHEET_CSS = `
  :root{--brand:#14532d;--ink:#111827;--muted:#6b7280;--line:#e5e7eb}
  @page{margin:14mm}
  *{box-sizing:border-box}
  body{font-family:ui-sans-serif,system-ui,-apple-system,Segoe UI,Roboto,sans-serif;color:var(--ink);margin:0;padding:28px}
  .sheet{max-width:680px;margin:0 auto}
  header{display:flex;justify-content:space-between;align-items:flex-start;gap:20px}
  .brand{display:flex;gap:14px;align-items:center}
  .logo{width:48px;height:48px;border-radius:12px;background:var(--brand);color:#fff;font-size:26px;font-weight:700;display:flex;align-items:center;justify-content:center;flex:0 0 auto}
  h1{font-size:22px;margin:0;color:var(--brand);line-height:1.1}
  .contact{font-size:12px;color:var(--muted);margin-top:2px}
  .tag{font-size:11px;letter-spacing:.18em;text-transform:uppercase;color:var(--muted);margin-top:3px}
  .qr{text-align:center;flex:0 0 auto}
  .qr svg{width:96px;height:96px;display:block}
  .qr .ref{font-family:ui-monospace,Menlo,Consolas,monospace;font-size:11px;font-weight:700;margin-top:3px;color:var(--ink)}
  .qr .scan{font-size:9px;color:var(--muted);text-transform:uppercase;letter-spacing:.08em}
  .rule{height:3px;background:var(--brand);border-radius:2px;margin:14px 0 16px}
  .meta{display:flex;justify-content:space-between;gap:16px;flex-wrap:wrap}
  .pname{font-size:17px;font-weight:700}
  .pmeta{font-size:13px;color:var(--muted);margin-top:2px}
  .meta .right{font-size:13px;text-align:right}
  .meta .right>div{margin-bottom:2px}
  .k{color:var(--muted);font-size:10px;text-transform:uppercase;letter-spacing:.06em;margin-right:6px}
  .dx{font-size:14px;margin-top:10px}
  .rx{font-size:18px;font-weight:700;color:var(--brand);margin:14px 0 2px}
  ol.meds{list-style:none;margin:14px 0 0;padding:0}
  ol.meds li{padding:12px 0;border-bottom:1px dashed #d1d5db}
  ol.meds li:first-child{border-top:1px dashed #d1d5db}
  ol.meds li>.n{display:inline-flex;align-items:center;justify-content:center;min-width:22px;height:22px;border-radius:50%;background:#ecfdf5;color:var(--brand);font-size:12px;font-weight:700;margin-right:10px}
  .drug{font-size:16px;font-weight:700;display:flex;align-items:baseline;gap:10px}
  .drug .n{display:inline-flex;align-items:center;justify-content:center;min-width:22px;height:22px;border-radius:50%;background:#ecfdf5;color:var(--brand);font-size:12px;font-weight:700}
  .detail{font-size:14px;color:#374151;margin:3px 0 0 32px}
  .instr{font-size:13px;color:var(--muted);font-style:italic;margin:2px 0 0 32px}
  .muted{color:var(--muted)}
  .foot-grid{display:flex;justify-content:space-between;align-items:flex-end;gap:24px;margin-top:44px}
  .note{font-size:11px;color:var(--muted);max-width:300px;line-height:1.5}
  .sign{width:230px;text-align:center}
  .sign .line{border-top:1px solid #374151;margin-bottom:5px}
  .sign .who{font-size:14px;font-weight:600}
  .sign .muted{font-size:11px}
  .issued{margin-top:26px;font-size:10px;border-top:1px solid var(--line);padding-top:8px;text-align:center}`;

export interface PrescriptionDoc {
  clinic: string;
  clinicContact?: string; // address / phone line under the clinic name
  rxRef: string; // short human reference (also shown by the QR)
  qrData: string; // payload encoded into the QR (verification reference)
  patient: string;
  mrn?: string;
  age?: number;
  gender?: string;
  weightKg?: string; // optional, useful for dosing
  prescriber?: string;
  when: string;
  diagnoses: { code?: string; description: string }[];
  meds: { drug_name: string; dose?: string; frequency?: string; duration?: string; instructions?: string }[];
  /** The prescriber's note to the patient or pharmacist. */
  note?: string;
  /** Known allergies, printed so the pharmacist sees them too. Absent = not stated. */
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
  when: string;
  tests: string[];
  indication?: string;
}

// Branded external-lab request the patient carries to an outside lab.
export async function printLabRequest(o: LabRequestDoc) {
  let qrSvg = "";
  try {
    qrSvg = await QRCode.toString(o.qrData, { type: "svg", margin: 0, errorCorrectionLevel: "M" });
  } catch {
    qrSvg = "";
  }
  const patientLine = [o.mrn ? `MRN ${esc(o.mrn)}` : "", o.age != null ? `${esc(o.age)}${o.gender ? esc(o.gender[0].toUpperCase()) : ""}` : ""]
    .filter(Boolean)
    .join("&nbsp;&nbsp;·&nbsp;&nbsp;");
  const tests = o.tests.filter((t) => t.trim()).map((t, i) => `<li><span class="n">${i + 1}</span>${esc(t)}</li>`).join("");

  const body = `
    <div class="sheet">
      <header>
        <div class="brand">
          <div class="logo">🧪</div>
          <div>
            <h1>${esc(o.clinic)}</h1>
            ${o.clinicContact ? `<div class="contact">${esc(o.clinicContact)}</div>` : ""}
            <div class="tag">Laboratory Request</div>
          </div>
        </div>
        <div class="qr">${qrSvg || ""}<div class="ref">${esc(o.ref)}</div><div class="scan">Scan to verify</div></div>
      </header>
      <div class="rule"></div>
      <section class="meta">
        <div><div class="pname">${esc(o.patient)}</div>${patientLine ? `<div class="pmeta">${patientLine}</div>` : ""}</div>
        <div class="right">
          <div><span class="k">Date</span> ${esc(new Date(o.when).toLocaleDateString())}</div>
          ${o.prescriber ? `<div><span class="k">Requested by</span> ${esc(o.prescriber)}</div>` : ""}
        </div>
      </section>
      ${o.indication ? `<div class="dx"><span class="k">Clinical indication</span> ${esc(o.indication)}</div>` : ""}
      <div class="rx">Requested tests</div>
      <ol class="meds">${tests || `<li class="muted">No tests listed.</li>`}</ol>
      <div class="foot-grid">
        <div class="note">Please perform the tests above and return the report to the patient / referring clinic.</div>
        <div class="sign"><div class="line"></div><div class="who">${esc(o.prescriber || "Requesting clinician")}</div><div class="muted">Signature &amp; stamp</div></div>
      </div>
      <div class="issued muted">Issued by ${esc(o.clinic)} · ${esc(o.ref)}</div>
    </div>`;

  const w = window.open("", "_blank", "width=760,height=940");
  if (!w) return;
  w.document.write(`<!doctype html><html><head><title>Lab request · ${esc(o.patient)}</title>
    <style>${SHEET_CSS}</style></head><body>${body}
    <script>window.onload=function(){window.print();}<\/script></body></html>`);
  w.document.close();
}

export async function printPrescription(o: PrescriptionDoc) {
  let qrSvg = "";
  try {
    qrSvg = await QRCode.toString(o.qrData, { type: "svg", margin: 0, errorCorrectionLevel: "M" });
  } catch {
    qrSvg = "";
  }

  const dx = o.diagnoses.map((d) => esc([d.code, d.description].filter(Boolean).join(" "))).join(", ");
  const meds = o.meds
    .map((m, i) => {
      const detail = [m.dose, m.frequency, m.duration].filter(Boolean).map(esc).join(" · ");
      return `<li>
        <div class="drug"><span class="n">${i + 1}</span>${esc(m.drug_name)}</div>
        ${detail ? `<div class="detail">${detail}</div>` : ""}
        ${m.instructions ? `<div class="instr">${esc(m.instructions)}</div>` : ""}
      </li>`;
    })
    .join("");

  const patientLine = [
    o.mrn ? `MRN ${esc(o.mrn)}` : "",
    o.age != null ? `${esc(o.age)}${o.gender ? esc(o.gender[0].toUpperCase()) : ""}` : "",
    o.weightKg ? `${esc(o.weightKg)} kg` : "",
  ]
    .filter(Boolean)
    .join("&nbsp;&nbsp;·&nbsp;&nbsp;");

  const body = `
    <div class="sheet">
      <header>
        <div class="brand">
          <div class="logo">℞</div>
          <div>
            <h1>${esc(o.clinic)}</h1>
            ${o.clinicContact ? `<div class="contact">${esc(o.clinicContact)}</div>` : ""}
            <div class="tag">Prescription</div>
          </div>
        </div>
        <div class="qr">
          ${qrSvg || ""}
          <div class="ref">${esc(o.rxRef)}</div>
          <div class="scan">Scan to verify</div>
        </div>
      </header>

      <div class="rule"></div>

      <section class="meta">
        <div>
          <div class="pname">${esc(o.patient)}</div>
          ${patientLine ? `<div class="pmeta">${patientLine}</div>` : ""}
        </div>
        <div class="right">
          <div><span class="k">Date</span> ${esc(new Date(o.when).toLocaleDateString())}</div>
          ${o.prescriber ? `<div><span class="k">Prescriber</span> ${esc(o.prescriber)}</div>` : ""}
        </div>
      </section>

      ${dx ? `<div class="dx"><span class="k">Diagnosis</span> ${dx}</div>` : ""}

      <ol class="meds">${meds || `<li class="muted">No medication prescribed.</li>`}</ol>
      ${o.note ? `<div class="dx"><span class="k">Note</span> ${esc(o.note)}</div>` : ""}
      ${o.allergies && o.allergies.length > 0 ? `<div class="dx"><span class="k">Allergies</span> <b>${o.allergies.map(esc).join(", ")}</b></div>` : ""}

      <div class="foot-grid">
        <div class="note">
          Valid only with the prescriber's signature &amp; clinic stamp.<br/>
          Present this prescription at any licensed pharmacy.
        </div>
        <div class="sign">
          <div class="line"></div>
          <div class="who">${esc(o.prescriber || "Prescriber")}</div>
          <div class="muted">Signature &amp; stamp</div>
        </div>
      </div>

      <div class="issued muted">Issued by ${esc(o.clinic)} · ${esc(o.rxRef)}</div>
    </div>`;

  const w = window.open("", "_blank", "width=760,height=1000");
  if (!w) return;
  w.document.write(`<!doctype html><html><head><title>Prescription · ${esc(o.patient)}</title>
    <style>${SHEET_CSS}</style></head><body>${body}
    <script>window.onload=function(){window.print();}<\/script></body></html>`);
  w.document.close();
}
