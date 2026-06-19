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
