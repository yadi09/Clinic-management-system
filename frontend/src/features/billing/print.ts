// Lightweight print helpers: open a blank window, write a self-contained slip,
// and trigger the browser's print dialog. Kept dependency-free (no print CSS on
// the app shell) so a receipt/Z-report prints cleanly on its own.

function openAndPrint(title: string, bodyHTML: string) {
  const w = window.open("", "_blank", "width=420,height=640");
  if (!w) return;
  w.document.write(`<!doctype html><html><head><title>${title}</title>
    <style>
      *{box-sizing:border-box} body{font-family:ui-monospace,Menlo,Consolas,monospace;font-size:13px;color:#111;margin:0;padding:18px}
      h1{font-size:16px;margin:0 0 2px} .muted{color:#666;font-size:11px}
      hr{border:none;border-top:1px dashed #bbb;margin:10px 0}
      table{width:100%;border-collapse:collapse} td{padding:2px 0;vertical-align:top}
      .r{text-align:right} .b{font-weight:700} .lg{font-size:15px}
      .center{text-align:center} .mt{margin-top:10px}
    </style></head><body>${bodyHTML}
    <script>window.onload=function(){window.print();}<\/script></body></html>`);
  w.document.close();
}

function esc(s: string) {
  return String(s ?? "").replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c] as string));
}

export function printReceipt(o: {
  clinic: string;
  receiptNo?: number;
  patient: string;
  mrn?: string;
  description: string;
  amount: string;
  currency: string;
  method?: string;
  cashier?: string;
  when: string;
  refund?: boolean;
}) {
  const no = o.receiptNo != null ? `RCP-${String(o.receiptNo).padStart(6, "0")}` : "—";
  printReceiptRaw(no, o);
}

function printReceiptRaw(no: string, o: Parameters<typeof printReceipt>[0]) {
  const body = `
    <h1 class="center">${esc(o.clinic)}</h1>
    <div class="center muted">${o.refund ? "REFUND SLIP" : "PAYMENT RECEIPT"}</div>
    <hr/>
    <table>
      <tr><td class="muted">Receipt</td><td class="r b">${no}</td></tr>
      <tr><td class="muted">Date</td><td class="r">${esc(new Date(o.when).toLocaleString())}</td></tr>
      <tr><td class="muted">Patient</td><td class="r">${esc(o.patient)}${o.mrn ? ` (${esc(o.mrn)})` : ""}</td></tr>
    </table>
    <hr/>
    <table>
      <tr><td>${esc(o.description)}</td><td class="r">${esc(o.currency)} ${esc(o.amount)}</td></tr>
    </table>
    <hr/>
    <table>
      <tr><td class="b lg">TOTAL</td><td class="r b lg">${esc(o.currency)} ${esc(o.amount)}</td></tr>
      <tr><td class="muted">Method</td><td class="r">${esc(o.method || "—")}</td></tr>
      <tr><td class="muted">Cashier</td><td class="r">${esc(o.cashier || "—")}</td></tr>
    </table>
    <hr/>
    <div class="center muted mt">Thank you. Keep this receipt for your records.</div>`;
  openAndPrint(no, body);
}

export function printVisitReceipt(o: {
  clinic: string;
  receiptNo?: number;
  patient: string;
  mrn?: string;
  lines: { description: string; amount: string }[];
  total: string;
  currency: string;
  method?: string;
  cashier?: string;
  when: string;
}) {
  const no = o.receiptNo != null ? `RCP-${String(o.receiptNo).padStart(6, "0")}` : "—";
  const rows = o.lines
    .map((l) => `<tr><td>${esc(l.description)}</td><td class="r">${esc(o.currency)} ${esc(l.amount)}</td></tr>`)
    .join("");
  const body = `
    <h1 class="center">${esc(o.clinic)}</h1>
    <div class="center muted">PAYMENT RECEIPT</div>
    <hr/>
    <table>
      <tr><td class="muted">Receipt</td><td class="r b">${no}</td></tr>
      <tr><td class="muted">Date</td><td class="r">${esc(new Date(o.when).toLocaleString())}</td></tr>
      <tr><td class="muted">Patient</td><td class="r">${esc(o.patient)}${o.mrn ? ` (${esc(o.mrn)})` : ""}</td></tr>
    </table>
    <hr/>
    <table>${rows}</table>
    <hr/>
    <table>
      <tr><td class="b lg">TOTAL</td><td class="r b lg">${esc(o.currency)} ${esc(o.total)}</td></tr>
      <tr><td class="muted">Method</td><td class="r">${esc(o.method || "—")}</td></tr>
      <tr><td class="muted">Cashier</td><td class="r">${esc(o.cashier || "—")}</td></tr>
    </table>
    <hr/>
    <div class="center muted mt">Thank you. Keep this receipt for your records.</div>`;
  openAndPrint(no, body);
}

/**
 * Patient statement of account — an A4 document, not a till slip.
 *
 * A receipt proves one payment; a statement answers "what has this patient been
 * charged, what have they paid, and what is still owed?". Dental treatment runs
 * over months in instalments, so patients (and the employers/insurers who
 * reimburse them) routinely ask for exactly this on paper.
 *
 * Cancelled bills are deliberately excluded: no money ever moved, and listing
 * them makes an official document look like the patient owes more than they do.
 */
export function printStatement(o: {
  clinic: string;
  clinicContact?: string;
  patient: string;
  mrn?: string;
  phone?: string;
  currency: string;
  lines: { date: string; description: string; status: string; amount: string }[];
  charged: string;
  paid: string;
  refunded: string;
  outstanding: string;
  issuedBy?: string;
}) {
  const money = (v: string) => `${esc(o.currency)} ${Number(v || 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  const rows = o.lines
    .map(
      (l) => `<tr>
        <td class="nw">${esc(l.date)}</td>
        <td>${esc(l.description)}</td>
        <td class="nw">${esc(l.status)}</td>
        <td class="r nw">${money(l.amount)}</td>
      </tr>`,
    )
    .join("");
  const when = new Date().toLocaleDateString(undefined, { day: "numeric", month: "long", year: "numeric" });
  const body = `
    <div class="head">
      <div>
        <h1>${esc(o.clinic)}</h1>
        ${o.clinicContact ? `<div class="muted">${esc(o.clinicContact)}</div>` : ""}
        <div class="tag">Statement of account</div>
      </div>
      <div class="r muted">
        <div><b>Issued</b> ${esc(when)}</div>
        ${o.issuedBy ? `<div>by ${esc(o.issuedBy)}</div>` : ""}
      </div>
    </div>
    <div class="rule"></div>
    <table class="meta">
      <tr>
        <td><span class="muted">Patient</span><br/><b>${esc(o.patient)}</b></td>
        <td><span class="muted">Card / MRN</span><br/>${esc(o.mrn || "—")}</td>
        <td><span class="muted">Phone</span><br/>${esc(o.phone || "—")}</td>
      </tr>
    </table>
    <table class="lines">
      <thead><tr><th class="nw">Date</th><th>Description</th><th class="nw">Status</th><th class="r nw">Amount</th></tr></thead>
      <tbody>${rows || `<tr><td colspan="4" class="muted">No billing activity.</td></tr>`}</tbody>
    </table>
    <table class="totals">
      <tr><td>Total charged</td><td class="r">${money(o.charged)}</td></tr>
      <tr><td>Total paid</td><td class="r">${money(o.paid)}</td></tr>
      ${Number(o.refunded || 0) > 0 ? `<tr><td>Refunded</td><td class="r">− ${money(o.refunded)}</td></tr>` : ""}
      <tr class="grand"><td>Balance outstanding</td><td class="r">${money(o.outstanding)}</td></tr>
    </table>
    <div class="foot">
      <div class="muted">This statement reflects charges recorded at the clinic as of the issue date.
      Amounts still to be scheduled on an ongoing treatment plan are not included until billed.</div>
      <div class="sign"><div class="line"></div>Signature &amp; stamp</div>
    </div>`;
  const w = window.open("", "_blank", "width=820,height=1000");
  if (!w) return;
  w.document.write(`<!doctype html><html><head><title>Statement — ${esc(o.patient)}</title><style>
    @page{margin:16mm}
    *{box-sizing:border-box}
    body{font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;color:#111;margin:0;font-size:12.5px}
    h1{font-size:19px;margin:0}
    .muted{color:#666;font-size:11px}
    .r{text-align:right} .nw{white-space:nowrap}
    .head{display:flex;justify-content:space-between;align-items:flex-start;gap:16px}
    .tag{margin-top:6px;display:inline-block;text-transform:uppercase;letter-spacing:.08em;font-size:10px;font-weight:700;color:#14532d}
    .rule{height:3px;background:#14532d;margin:10px 0 14px}
    table{width:100%;border-collapse:collapse}
    .meta td{padding:0 12px 12px 0;vertical-align:top;width:33%}
    .lines th{text-align:left;font-size:10px;text-transform:uppercase;letter-spacing:.05em;color:#666;border-bottom:1px solid #ddd;padding:6px 8px 6px 0}
    .lines td{padding:6px 8px 6px 0;border-bottom:1px solid #f0f0f0;vertical-align:top}
    .totals{margin-top:14px;margin-left:auto;width:auto;min-width:280px}
    .totals td{padding:4px 0}
    .totals td:last-child{padding-left:28px}
    .totals .grand td{border-top:2px solid #14532d;font-weight:700;font-size:14px;padding-top:8px}
    .foot{display:flex;justify-content:space-between;gap:32px;margin-top:36px;align-items:flex-end}
    .foot .muted{max-width:60%}
    .sign{text-align:center;font-size:10px;color:#666}
    .sign .line{border-top:1px solid #333;width:190px;margin-bottom:4px}
  </style></head><body>${body}
  <script>window.onload=function(){window.print();}<\/script></body></html>`);
  w.document.close();
}

export function printZReport(o: {
  clinic: string;
  cashier: string;
  businessDate: string;
  byMethod: { label: string; total: string; count: number }[];
  expected: string;
  counted: string;
  variance: string;
  note?: string;
  currency?: string;
}) {
  const cur = o.currency || "ETB";
  const lines = o.byMethod
    .map((m) => `<tr><td class="muted">${esc(m.label)} (${m.count})</td><td class="r">${cur} ${esc(m.total)}</td></tr>`)
    .join("");
  const vNum = parseFloat(o.variance);
  const vLabel = vNum === 0 ? "BALANCED" : vNum > 0 ? "OVER" : "SHORT";
  const body = `
    <h1 class="center">${esc(o.clinic)}</h1>
    <div class="center muted">END-OF-DAY Z-REPORT</div>
    <hr/>
    <table>
      <tr><td class="muted">Cashier</td><td class="r">${esc(o.cashier)}</td></tr>
      <tr><td class="muted">Business date</td><td class="r">${esc(o.businessDate)}</td></tr>
    </table>
    <hr/>
    <div class="muted">Collected by method</div>
    <table>${lines || `<tr><td class="muted">No collections</td><td class="r">${cur} 0.00</td></tr>`}</table>
    <hr/>
    <table>
      <tr><td class="b">Expected</td><td class="r b">${cur} ${esc(o.expected)}</td></tr>
      <tr><td class="b">Counted</td><td class="r b">${cur} ${esc(o.counted)}</td></tr>
      <tr><td class="b lg">Variance (${vLabel})</td><td class="r b lg">${cur} ${esc(o.variance)}</td></tr>
    </table>
    ${o.note ? `<hr/><div class="muted">Note</div><div>${esc(o.note)}</div>` : ""}
    <hr/>
    <table><tr><td class="muted">Signature</td><td class="r">__________________</td></tr></table>`;
  openAndPrint(`Z-${o.businessDate}`, body);
}
