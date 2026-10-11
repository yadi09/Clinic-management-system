// The dispensing slip: what the pharmacy gave, how to take it, from which batch.
// Until now the pharmacy "Print" button printed the whole web page, menus and all.
import {
  duplicateHtml, esc, footerHtml, headerHtml, kvRow, label, multiline, showFlag, signatureBox, signer, textSlot,
  type PrintCtx,
} from "@/features/printing/blocks";
import { fmtDate } from "@/features/printing/format";
import { pick } from "@/features/printing/templates/resolve";
import type { Built, RenderOpts } from "@/features/printing/templates/types";

export interface DispenseDoc {
  rxRef: string;
  patient: string;
  mrn?: string;
  prescriber?: string;
  when: string;
  items: { drug: string; sig?: string; qty?: number; batch?: string; expiry?: string; blocked?: string }[];
  counselling?: string;
  allergies?: string[];
  dispensedBy?: string;
  /** Not handed over yet (still at the cashier or being prepared). */
  pending?: boolean;
}

export function renderDispense(d: DispenseDoc, c: PrintCtx, o: RenderOpts = {}): Built {
  const { template, paper } = pick("dispense", c.settings, o);
  const loc = c.settings.locale;
  const flag = (id: string) => showFlag(c, "dispense", id);
  const slip = template === "slip";
  // A column appears only when the caller knows it: a paper full of dashes reads as
  // missing information, and a guessed batch number is worse than none.
  const hasQty = d.items.some((i) => i.qty != null);
  const hasBatch = flag("batch") && d.items.some((i) => i.batch);
  const rows = d.items.map((i) => `<tr>
      <td><b>${esc(i.drug)}</b>${i.sig ? `<div class="muted">${esc(i.sig)}</div>` : ""}${i.blocked ? `<div class="blocked">${esc(i.blocked)}</div>` : ""}</td>
      ${hasQty ? `<td class="r nw">${i.qty != null ? esc(i.qty) : "—"}</td>` : ""}
      ${hasBatch ? `<td class="nw">${esc(i.batch || "—")}${i.expiry ? `<div class="muted">${esc(label(c, "dispense.expiry"))} ${esc(i.expiry)}</div>` : ""}</td>` : ""}
    </tr>`).join("");
  const text = textSlot(c, "dispense", "footer").trim();
  const html = `
    ${headerHtml(c, { slip })}
    <div class="dp-title">${esc(label(c, "dispense.title"))}${d.pending ? ` — ${esc(label(c, "dispense.pending"))}` : ""}</div>
    ${kvRow(label(c, "dispense.prescription"), `<b>${esc(d.rxRef)}</b>`)}
    ${kvRow(label(c, "common.date"), esc(fmtDate(d.when, loc, true)))}
    ${kvRow(label(c, "common.patient"), `${esc(d.patient)}${d.mrn ? ` (${esc(d.mrn)})` : ""}`)}
    ${d.prescriber ? kvRow(label(c, "prescription.prescriber"), esc(d.prescriber)) : ""}
    <table class="dp"><thead><tr><th>${esc(label(c, "dispense.drug"))}</th>${hasQty ? `<th class="r">${esc(label(c, "dispense.qty"))}</th>` : ""}
      ${hasBatch ? `<th>${esc(label(c, "dispense.batch"))}</th>` : ""}</tr></thead><tbody>${rows}</tbody></table>
    ${flag("allergies") && d.allergies && d.allergies.length ? `<p class="warnline"><b>${esc(label(c, "prescription.allergies"))}:</b> ${d.allergies.map(esc).join(", ")}</p>` : ""}
    ${flag("counselling") && d.counselling?.trim() ? `<p><span class="k2">${esc(label(c, "dispense.counselling"))}</span>${multiline(d.counselling)}</p>` : ""}
    ${flag("signature") ? signatureBox(label(c, "common.signature"), signer(c, "dispense", d.dispensedBy)) : ""}
    ${duplicateHtml(c, o.duplicate, (iso) => fmtDate(iso, loc, true))}
    ${footerHtml(c, text ? [multiline(text)] : [])}`;
  return {
    html, paper, template, title: `${label(c, "dispense.title")} ${d.rxRef}`,
    css: `.dp-title{text-align:center;font-weight:700;letter-spacing:.05em;text-transform:uppercase;margin:8px 0}
          table.dp{width:100%;border-collapse:collapse;margin-top:8px}
          table.dp th{text-align:left;font-size:.78em;text-transform:uppercase;color:var(--muted);border-bottom:1px solid var(--line);padding:4px 6px 4px 0}
          table.dp td{padding:6px 6px 6px 0;border-bottom:1px dashed #cdd3da;vertical-align:top}
          .r{text-align:right} .nw{white-space:nowrap}
          .blocked{color:#b91c1c;font-weight:600}
          .warnline{color:#9a3412;margin-top:8px}
          .k2{color:var(--muted);font-size:.78em;text-transform:uppercase;letter-spacing:.07em;margin-right:6px}`,
  };
}
