// The medical certificate, as it leaves the building.
//
// This sheet is read by someone who does not trust it: an employer deciding whether
// to pay for three days of absence, or a school registrar. So it is built to be
// checked — a reference number, the clinic's own details, the name of the clinician
// who signed it, and a QR carrying the reference so a phone can pull it up.
//
// Two deliberate choices a generic "print view" would miss:
//
//   The diagnosis is omitted unless the clinician ticked otherwise. A certificate is
//   handed to an employer, and "unfit for work" is the part they are entitled to;
//   what the patient is suffering from is not.
//
//   A voided certificate still prints, watermarked VOID. Refusing to print it would
//   leave the copy already in someone's file as the only version in existence.
import QRCode from "qrcode";

function esc(s: unknown) {
  return String(s ?? "").replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c] as string));
}

export interface CertificatePrint {
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
}

const TITLE: Record<CertificatePrint["kind"], string> = {
  sick_leave: "Medical Certificate",
  fitness: "Certificate of Fitness",
  attendance: "Certificate of Attendance",
};

/** The sentence the document exists to say, in the register a third party expects. */
function statement(o: CertificatePrint): string {
  const who = `<b>${esc(o.patient)}</b>`;
  switch (o.kind) {
    case "sick_leave":
      return `This is to certify that ${who} attended this clinic and was examined on
        ${esc(o.issuedOn)}${o.issuedOnEc ? ` (${esc(o.issuedOnEc)})` : ""}. In my professional opinion the
        patient is <b>unfit for work or study</b> and requires rest for
        <b>${o.restDays} day${o.restDays === 1 ? "" : "s"}</b>.`;
    case "fitness":
      return `This is to certify that ${who} was examined at this clinic on
        ${esc(o.issuedOn)}${o.issuedOnEc ? ` (${esc(o.issuedOnEc)})` : ""} and is, in my professional
        opinion, <b>fit to resume normal duties</b>.`;
    case "attendance":
      return `This is to certify that ${who} <b>attended this clinic</b> on
        ${esc(o.issuedOn)}${o.issuedOnEc ? ` (${esc(o.issuedOnEc)})` : ""} and received medical attention.`;
  }
}

export async function printCertificate(o: CertificatePrint) {
  // The QR carries what a verifier needs to ring the clinic and quote it back.
  let qr = "";
  try {
    qr = await QRCode.toString(
      `MC:${o.ref}\n${o.clinic}\n${o.patient}${o.mrn ? " " + o.mrn : ""}\n${o.issuedOn}`,
      { type: "svg", margin: 0, width: 96 },
    );
  } catch { /* a certificate without a QR is still a valid certificate */ }

  const isVoid = o.status === "void";
  const period = o.restFrom && o.restTo
    ? `<table class="period">
         <tr><td class="k">From</td><td><b>${esc(o.restFrom)}</b>${o.restFromEc ? ` · ${esc(o.restFromEc)}` : ""}</td></tr>
         <tr><td class="k">To</td><td><b>${esc(o.restTo)}</b>${o.restToEc ? ` · ${esc(o.restToEc)}` : ""}</td></tr>
         <tr><td class="k">Days</td><td><b>${o.restDays}</b> (inclusive)</td></tr>
       </table>`
    : "";

  const body = `
    ${isVoid ? '<div class="void">VOID</div>' : ""}
    <header>
      <div>
        <h1>${esc(o.clinic)}</h1>
        ${o.clinicContact ? `<div class="contact">${esc(o.clinicContact)}</div>` : ""}
        ${o.branch ? `<div class="contact">${esc(o.branch)}</div>` : ""}
      </div>
      <div class="qr">${qr}<div class="ref">${esc(o.ref)}</div><div class="scan">reference</div></div>
    </header>
    <div class="rule"></div>
    <h2>${esc(TITLE[o.kind])}</h2>

    <table class="meta">
      <tr><td class="k">Patient</td><td><b>${esc(o.patient)}</b></td>
          <td class="k">MRN</td><td>${esc(o.mrn ?? "—")}</td></tr>
      <tr><td class="k">Age</td><td>${o.age ? esc(o.age) + " years" : "—"}</td>
          <td class="k">Sex</td><td class="cap">${esc(o.gender ?? "—")}</td></tr>
    </table>

    <p class="stmt">${statement(o)}</p>
    ${period}
    ${o.showDiagnosis && o.diagnosis ? `<p class="dx"><span class="k">Diagnosis</span> ${esc(o.diagnosis)}</p>` : ""}
    ${o.notes ? `<p class="notes">${esc(o.notes)}</p>` : ""}
    ${isVoid ? `<p class="voidnote">This certificate was withdrawn by the issuing clinic${o.voidReason ? `: ${esc(o.voidReason)}` : ""}. It should not be relied upon.</p>` : ""}

    <div class="sign">
      <div class="line"></div>
      <div class="who">${esc(o.issuedBy ?? "")}</div>
      <div class="role">Attending clinician · signature &amp; clinic stamp</div>
      <div class="on">Issued ${esc(o.issuedOn)}${o.issuedOnEc ? ` · ${esc(o.issuedOnEc)}` : ""}</div>
    </div>
    <p class="foot">
      Issued by ${esc(o.clinic)} and recorded under reference ${esc(o.ref)}. To verify, contact the
      clinic and quote the reference above.
    </p>`;

  const w = window.open("", "_blank", "width=820,height=1000");
  if (!w) return;
  w.document.write(`<!doctype html><html><head><title>${esc(TITLE[o.kind])} — ${esc(o.patient)} — ${esc(o.ref)}</title><style>
    :root{--brand:#14532d;--ink:#111827;--muted:#6b7280;--line:#e5e7eb}
    @page{margin:18mm}
    *{box-sizing:border-box}
    body{font-family:ui-sans-serif,system-ui,-apple-system,Segoe UI,Roboto,sans-serif;color:var(--ink);margin:0;padding:32px;font-size:13.5px;line-height:1.6;position:relative}
    header{display:flex;justify-content:space-between;align-items:flex-start;gap:24px}
    h1{font-size:22px;margin:0;color:var(--brand);line-height:1.1}
    .contact{font-size:11.5px;color:var(--muted);margin-top:2px}
    .qr{text-align:center;flex:0 0 auto}
    .qr svg{width:92px;height:92px;display:block}
    .ref{font-family:ui-monospace,Menlo,Consolas,monospace;font-size:12px;font-weight:700;margin-top:3px}
    .scan{font-size:9px;color:var(--muted);text-transform:uppercase;letter-spacing:.09em}
    .rule{height:3px;background:var(--brand);border-radius:2px;margin:14px 0 18px}
    h2{font-size:17px;text-align:center;letter-spacing:.04em;text-transform:uppercase;margin:0 0 18px}
    table.meta{width:100%;border-collapse:collapse;margin-bottom:16px}
    table.meta td{padding:4px 10px 4px 0;vertical-align:top}
    .k{color:var(--muted);font-size:10px;text-transform:uppercase;letter-spacing:.07em;white-space:nowrap;width:1%}
    .cap{text-transform:capitalize}
    .stmt{font-size:14.5px;line-height:1.75;margin:0 0 14px;text-align:justify}
    table.period{border-collapse:collapse;margin:0 0 14px;border:1px solid var(--line);border-radius:6px}
    table.period td{padding:6px 14px 6px 10px;border-bottom:1px solid var(--line)}
    table.period tr:last-child td{border-bottom:0}
    .dx{margin:0 0 10px}
    .notes{margin:0 0 10px;white-space:pre-wrap}
    .voidnote{color:#9f1239;font-weight:600}
    .sign{margin-top:46px;width:270px}
    .sign .line{border-top:1px solid #333;margin-bottom:5px}
    .who{font-weight:700}
    .role{font-size:10.5px;color:var(--muted)}
    .on{font-size:10.5px;color:var(--muted);margin-top:3px}
    .foot{margin-top:30px;padding-top:10px;border-top:1px solid var(--line);font-size:10.5px;color:var(--muted)}
    .void{position:absolute;top:38%;left:0;right:0;text-align:center;font-size:110px;font-weight:800;
      color:rgba(159,18,57,.13);letter-spacing:.15em;transform:rotate(-18deg);pointer-events:none}
  </style></head><body>${body}
  <script>window.onload=function(){window.print();}<\/script></body></html>`);
  w.document.close();
}
