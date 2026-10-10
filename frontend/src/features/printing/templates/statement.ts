// The patient's statement of account: what they have been charged, paid and still
// owe. An A4 (or A5) document handed to patients, employers and insurers, so it
// carries the clinic's identity, a date, who issued it, and — new — where to pay.
//
// Cancelled bills are left out by the caller: no money moved, and listing them makes
// an official paper look as though the patient owes more than they do.
import {
  duplicateHtml, esc, footerHtml, headerHtml, kvRow, label, multiline, showFlag, signatureBox, stampBox, textSlot,
  type PrintCtx,
} from "@/features/printing/blocks";
import { fmtDate, money } from "@/features/printing/format";
import { pick } from "@/features/printing/templates/resolve";
import type { Built, RenderOpts } from "@/features/printing/templates/types";

export interface StatementDoc {
  patient: string;
  mrn?: string;
  phone?: string;
  currency: string;
  lines: { date: string; description: string; status: string; amount: string }[];
  charged: string;
  paid: string;
  refunded: string;
  outstanding: string;
  /** Dental only: treatment given (or a down payment agreed) not yet billed, and future
   *  visits on running courses. Absent for a general clinic. */
  unbilled?: string;
  upcoming?: string;
  issuedBy?: string;
  /** Printed under the lines when they are a page and the totals are the whole account. */
  note?: string;
  /** The clinic's own accounts, so the patient knows where to send the money. */
  payTo?: { label: string; account: string }[];
}

export function renderStatement(d: StatementDoc, c: PrintCtx, o: RenderOpts = {}): Built {
  const { template, paper } = pick("statement", c.settings, o);
  const loc = c.settings.locale;
  const cur = d.currency && d.currency !== "ETB" ? d.currency : loc.currency || "ETB";
  const amt = (v: string) => `${esc(cur)} ${esc(money(v, loc))}`;
  const flag = (id: string) => showFlag(c, "statement", id);
  const issued = fmtDate(new Date().toISOString(), loc);
  const rows = d.lines.map((l) => `<tr>
      <td class="nw">${esc(l.date)}</td><td>${esc(l.description)}</td>
      ${flag("status") ? `<td class="nw">${esc(l.status)}</td>` : ""}
      <td class="r nw">${amt(l.amount)}</td></tr>`).join("");
  const colspan = flag("status") ? 4 : 3;
  const owed = Number(d.outstanding || 0) + Number(d.unbilled || 0);
  const dental = d.unbilled !== undefined;
  const totals = [
    kvRow(label(c, "statement.charged"), amt(d.charged)),
    kvRow(label(c, "statement.paid"), amt(d.paid)),
    Number(d.refunded || 0) > 0 ? kvRow(label(c, "statement.refunded"), `− ${amt(d.refunded)}`) : "",
    // A statement that said "0 outstanding" while treatment was owed but not yet billed
    // understated the account to the patient and any insurer (audit D15).
    dental ? kvRow(label(c, "statement.billedUnpaid"), amt(d.outstanding)) : "",
    dental ? kvRow(label(c, "statement.unbilled"), amt(d.unbilled!)) : "",
    kvRow(label(c, dental ? "statement.balanceNow" : "statement.outstanding"), amt(dental ? String(owed) : d.outstanding), { strong: true }),
    dental && Number(d.upcoming || 0) > 0 ? `<div class="muted">${kvRow(label(c, "statement.upcoming"), amt(d.upcoming!))}</div>` : "",
  ].join("");
  const payTo = flag("payTo") && d.payTo && d.payTo.length > 0
    ? `<div class="payto"><div class="k2">${esc(label(c, "statement.payTo"))}</div>${d.payTo
      .map((p) => `<div>${esc(p.label)}${p.account ? ` · <b>${esc(p.account)}</b>` : ""}</div>`).join("")}</div>` : "";
  const terms = textSlot(c, "statement", "terms").trim();

  const html = `
    ${headerHtml(c)}
    <div class="st-top">
      <div class="st-title">${esc(label(c, "statement.title"))}</div>
      <div class="r muted"><div><b>${esc(label(c, "statement.issued"))}</b> ${esc(issued)}</div>
        ${flag("issuedBy") && d.issuedBy ? `<div>${esc(label(c, "statement.by"))} ${esc(d.issuedBy)}</div>` : ""}</div>
    </div>
    <div class="st-meta">
      <div><div class="k2">${esc(label(c, "common.patient"))}</div><b>${esc(d.patient)}</b></div>
      <div><div class="k2">${esc(label(c, "common.cardNo"))}</div>${esc(d.mrn || "—")}</div>
      ${flag("phone") ? `<div><div class="k2">${esc(label(c, "common.phone"))}</div>${esc(d.phone || "—")}</div>` : ""}
    </div>
    <table class="lines">
      <thead><tr><th class="nw">${esc(label(c, "statement.date"))}</th><th>${esc(label(c, "statement.description"))}</th>
        ${flag("status") ? `<th class="nw">${esc(label(c, "statement.status"))}</th>` : ""}
        <th class="r nw">${esc(label(c, "statement.amount"))}</th></tr></thead>
      <tbody>${rows || `<tr><td colspan="${colspan}" class="muted">${esc(label(c, "statement.none"))}</td></tr>`}</tbody>
    </table>
    <div class="st-totals">${totals}</div>
    ${d.note ? `<div class="muted" style="margin-top:10px">${esc(d.note)}</div>` : ""}
    ${payTo}
    <div class="st-foot">
      <div class="muted st-terms">${terms ? multiline(terms) : ""}</div>
      <div class="st-sign">${flag("stamp") ? stampBox(label(c, "common.stamp")) : ""}${flag("signature") ? signatureBox(label(c, "common.signatureStamp")) : ""}</div>
    </div>
    ${duplicateHtml(c, o.duplicate, (iso) => fmtDate(iso, loc, true))}
    ${footerHtml(c)}`;
  return {
    html, paper, template, title: `${label(c, "statement.title")} — ${d.patient}`,
    css: `.st-top{display:flex;justify-content:space-between;align-items:flex-start;gap:14px;margin-bottom:10px}
          .st-title{font-size:1.25em;font-weight:700;text-transform:uppercase;letter-spacing:.06em;color:var(--accent)}
          .r{text-align:right} .nw{white-space:nowrap}
          .k2{color:var(--muted);font-size:.78em;text-transform:uppercase;letter-spacing:.06em}
          .st-meta{display:flex;gap:28px;flex-wrap:wrap;margin-bottom:12px}
          table.lines{width:100%;border-collapse:collapse}
          table.lines th{text-align:left;font-size:.78em;text-transform:uppercase;letter-spacing:.05em;color:var(--muted);border-bottom:1px solid var(--line);padding:6px 8px 6px 0}
          table.lines td{padding:6px 8px 6px 0;border-bottom:1px solid #f0f0f0;vertical-align:top}
          .st-totals{margin:14px 0 0 auto;min-width:300px;max-width:70%}
          .st-totals .kv.strong{border-top:2px solid var(--accent);margin-top:6px;padding-top:6px}
          .payto{margin-top:16px;padding:8px 10px;border:1px solid var(--line);border-radius:6px;font-size:.95em}
          .st-foot{display:flex;justify-content:space-between;gap:24px;margin-top:28px;align-items:flex-end}
          .st-terms{max-width:58%;font-size:.88em}
          .st-sign{display:flex;gap:14px;align-items:flex-end}`,
  };
}
