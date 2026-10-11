// The end-of-day cash report: a record the cashier and the manager sign and file.
// Not given to patients, so it is built for being read in a folder a year later: who
// closed which day at which branch, how the drawer reconciled, and a place to sign.
import {
  duplicateHtml, esc, footerHtml, headerHtml, identityOf, kvRow, label, multiline, showFlag, signatureBox, signer, textSlot,
  type PrintCtx,
} from "@/features/printing/blocks";
import { fmtDate, money } from "@/features/printing/format";
import { pick } from "@/features/printing/templates/resolve";
import type { Built, RenderOpts } from "@/features/printing/templates/types";

export interface ZReportDoc {
  cashier: string;
  businessDate: string;
  byMethod: { label: string; total: string; count: number; cash?: boolean }[];
  expected: string;
  counted: string;
  variance: string;
  note?: string;
  currency?: string;
}

export function renderZReport(d: ZReportDoc, c: PrintCtx, o: RenderOpts = {}): Built {
  const { template, paper } = pick("zreport", c.settings, o);
  const loc = c.settings.locale;
  const code = d.currency || "ETB";
  const cur = code === "ETB" ? loc.currency || "ETB" : code;
  const amt = (v: string) => `${esc(cur)} ${esc(money(v, loc))}`;
  const flag = (id: string) => showFlag(c, "zreport", id);
  const v = parseFloat(d.variance);
  const verdict = v === 0 ? label(c, "zreport.balanced") : v > 0 ? label(c, "zreport.over") : label(c, "zreport.short");
  const id = identityOf(c);
  const methods = d.byMethod.map((m) =>
    kvRow(`${m.label} (${m.count})${m.cash ? "" : ` — ${label(c, "zreport.notInDrawer")}`}`, amt(m.total))).join("")
    || kvRow(label(c, "zreport.none"), amt("0"));
  const sign = [
    flag("signature") ? signatureBox(label(c, "zreport.cashierSign"), signer(c, "zreport", d.cashier)) : "",
    flag("managerSign") ? signatureBox(label(c, "zreport.managerSign")) : "",
  ].join("");
  const extra = textSlot(c, "zreport", "footer").trim();
  const html = `
    ${headerHtml(c, { slip: template === "slip" })}
    <div class="zr-title">${esc(label(c, "zreport.title"))}</div>
    ${kvRow(label(c, "zreport.cashier"), esc(d.cashier))}
    ${kvRow(label(c, "zreport.businessDate"), esc(fmtDate(d.businessDate, loc)))}
    ${id.branchName ? kvRow(label(c, "common.branch"), esc(id.branchName)) : ""}
    ${flag("printedAt") ? kvRow(label(c, "common.printedAt"), esc(fmtDate(new Date().toISOString(), loc, true))) : ""}
    <div class="dash"></div>
    <div class="muted">${esc(label(c, "zreport.collected"))}</div>
    ${methods}
    <div class="dash"></div>
    ${kvRow(label(c, "zreport.expected"), `<b>${amt(d.expected)}</b>`)}
    ${kvRow(label(c, "zreport.counted"), `<b>${amt(d.counted)}</b>`)}
    ${kvRow(`${label(c, "zreport.variance")} (${verdict})`, amt(d.variance), { strong: true })}
    ${d.note ? `<div class="dash"></div><div class="muted">${esc(label(c, "common.note"))}</div><div>${multiline(d.note)}</div>` : ""}
    <div class="zr-sign">${sign}</div>
    ${duplicateHtml(c, o.duplicate, (iso) => fmtDate(iso, loc, true))}
    ${footerHtml(c, extra ? [multiline(extra)] : [])}`;
  return {
    html, paper, template, title: `Z-${d.businessDate}`,
    css: `.zr-title{text-align:center;font-weight:700;letter-spacing:.05em;text-transform:uppercase;margin:6px 0 10px}
          .dash{border-top:1px dashed #999;margin:8px 0}
          .zr-sign{display:flex;gap:20px;justify-content:space-between;margin-top:24px}`,
  };
}
