// The payment receipt, the visit receipt and the refund slip: one document, two
// layouts. A till slip for a thermal roll, or a sheet (A5/A4) with the clinic's full
// header, a lines table and boxes for a signature and a stamp.
import {
  duplicateHtml, esc, footerHtml, headerHtml, kvRow, label, multiline, showFlag, signatureBox, stampBox, textSlot,
  type PrintCtx,
} from "@/features/printing/blocks";
import { amountInWords, fmtDate, money } from "@/features/printing/format";
import { pick } from "@/features/printing/templates/resolve";
import type { Built, RenderOpts } from "@/features/printing/templates/types";

export interface ReceiptDoc {
  kind: "payment" | "refund";
  /** "RCP-000123", or "" when the payment has no number yet. */
  number: string;
  when: string;
  patient: string;
  mrn?: string;
  phone?: string;
  lines: { description: string; amount: string }[];
  total: string;
  currency: string;
  method?: string;
  reference?: string;
  cashier?: string;
  /** This payment has since been refunded: the paper must say so. */
  refunded?: boolean;
  /** What is still owed after this payment, when the caller knows. */
  balance?: string;
  /** For a refund: the receipt it reverses, and why. */
  original?: string;
  reason?: string;
}

const DASH = "—";

function titleOf(d: ReceiptDoc, c: PrintCtx) {
  if (d.kind === "refund") return label(c, "receipt.refundTitle");
  if (d.refunded) return label(c, "receipt.refundedTitle");
  return label(c, "receipt.title");
}

export function renderReceipt(d: ReceiptDoc, c: PrintCtx, o: RenderOpts = {}): Built {
  const { template, paper } = pick("receipt", c.settings, o);
  const loc = c.settings.locale;
  // The clinic's own label for its currency ("Birr", "Br") stands in for the base code;
  // a charge in another currency keeps its own code rather than being mislabelled.
  const code = d.currency || "ETB";
  const cc = code === "ETB" ? loc.currency || "ETB" : code;
  const amt = (v: string) => `${esc(cc)} ${esc(money(v, loc))}`;
  const when = fmtDate(d.when, loc, showFlag(c, "receipt", "time"));
  const title = titleOf(d, c);
  const number = d.number || DASH;
  const dup = duplicateHtml(c, o.duplicate, (iso) => fmtDate(iso, loc, true));
  const patient = `${esc(d.patient)}${d.mrn && showFlag(c, "receipt", "mrn") ? ` (${esc(d.mrn)})` : ""}`;
  const negative = d.kind === "refund";

  const paidBy = [
    showFlag(c, "receipt", "method") ? kvRow(label(c, "receipt.method"), esc(d.method || DASH)) : "",
    d.reference && showFlag(c, "receipt", "reference") ? kvRow(label(c, "receipt.reference"), esc(d.reference)) : "",
    showFlag(c, "receipt", "cashier") ? kvRow(label(c, "receipt.cashier"), esc(d.cashier || DASH)) : "",
    d.original ? kvRow(label(c, "receipt.number"), esc(d.original)) : "",
    d.reason ? kvRow(label(c, "common.note"), esc(d.reason)) : "",
    d.balance !== undefined && showFlag(c, "receipt", "balance") && Number(d.balance) > 0
      ? kvRow(label(c, "receipt.balance"), amt(d.balance)) : "",
  ].join("");
  const words = showFlag(c, "receipt", "inWords")
    ? `<div class="words">${esc(label(c, "receipt.inWords"))}: ${esc(amountInWords(d.total, code))}</div>` : "";
  const thanks = textSlot(c, "receipt", "thanks").trim();
  const terms = textSlot(c, "receipt", "terms").trim();
  const closing = [thanks ? multiline(thanks) : "", terms ? multiline(terms) : ""];

  if (template === "slip") {
    const rows = d.lines
      .map((l) => `<div class="kv"><span class="k ink">${esc(l.description)}</span><span class="v">${amt(l.amount)}</span></div>`)
      .join("");
    const html = `
      ${headerHtml(c, { slip: true })}
      <div class="rtitle">${esc(title)}</div>
      ${kvRow(label(c, "receipt.number"), `<b>${esc(number)}</b>`)}
      ${kvRow(label(c, "common.date"), esc(when))}
      ${kvRow(label(c, "common.patient"), patient)}
      ${d.phone && showFlag(c, "receipt", "phone") ? kvRow(label(c, "common.phone"), esc(d.phone)) : ""}
      <div class="dash"></div>
      ${rows || `<div class="muted">—</div>`}
      <div class="dash"></div>
      ${kvRow(label(c, "common.total"), `${negative ? "− " : ""}${amt(d.total)}`, { strong: true })}
      ${words}
      ${paidBy}
      ${showFlag(c, "receipt", "customerSign") ? signatureBox(label(c, "receipt.customerSign")) : ""}
      ${showFlag(c, "receipt", "stamp") ? `<div style="display:flex;justify-content:center;margin-top:8px">${stampBox(label(c, "common.stamp"))}</div>` : ""}
      ${dup}
      ${footerHtml(c, closing)}`;
    return {
      html, paper, template, title: number,
      css: `.rtitle{text-align:center;font-weight:700;letter-spacing:.04em;text-transform:uppercase;margin:6px 0 8px}
            .dash{border-top:1px dashed #999;margin:6px 0}
            .ink{color:var(--ink)} .words{font-size:.92em;margin:2px 0 4px}`,
    };
  }

  // sheet
  const rows = d.lines
    .map((l) => `<tr><td>${esc(l.description)}</td><td class="r">${amt(l.amount)}</td></tr>`)
    .join("");
  const html = `
    ${headerHtml(c)}
    <div class="sheet-top">
      <div class="rtitle">${esc(title)}</div>
      <div class="rno"><span class="muted">${esc(label(c, "receipt.number"))}</span> <b>${esc(number)}</b></div>
    </div>
    <div class="who">
      <div><div class="muted">${esc(label(c, "common.patient"))}</div><div class="pn">${patient}</div>
        ${d.phone && showFlag(c, "receipt", "phone") ? `<div class="muted">${esc(d.phone)}</div>` : ""}</div>
      <div class="r"><div class="muted">${esc(label(c, "common.date"))}</div><div>${esc(when)}</div></div>
    </div>
    <table class="lines"><thead><tr><th></th><th class="r"></th></tr></thead><tbody>${rows}</tbody></table>
    <div class="totbox">
      ${kvRow(label(c, "common.total"), `${negative ? "− " : ""}${amt(d.total)}`, { strong: true })}
      ${words}
    </div>
    <div class="paid">${paidBy}</div>
    <div class="boxes">
      ${showFlag(c, "receipt", "customerSign") ? signatureBox(label(c, "receipt.customerSign")) : "<span></span>"}
      ${showFlag(c, "receipt", "stamp") ? stampBox(label(c, "common.stamp")) : ""}
    </div>
    ${dup}
    ${footerHtml(c, closing)}`;
  return {
    html, paper, template, title: number,
    css: `.sheet-top{display:flex;justify-content:space-between;align-items:baseline;gap:12px;margin-bottom:10px}
          .rtitle{font-size:1.35em;font-weight:700;text-transform:uppercase;letter-spacing:.05em}
          .who{display:flex;justify-content:space-between;gap:16px;margin-bottom:12px}
          .pn{font-weight:700;font-size:1.1em} .r{text-align:right}
          table.lines{width:100%;border-collapse:collapse;margin-bottom:10px}
          table.lines td{padding:6px 8px 6px 0;border-bottom:1px solid var(--line);vertical-align:top}
          table.lines thead th{border-bottom:2px solid var(--accent);padding:0}
          .totbox{margin-left:auto;min-width:240px;max-width:60%;border-top:2px solid var(--accent);padding-top:6px}
          .words{font-size:.92em;margin-top:4px;text-align:right}
          .paid{margin-top:12px;max-width:340px}
          .boxes{display:flex;justify-content:space-between;align-items:flex-end;gap:20px;margin-top:26px}`,
  };
}
