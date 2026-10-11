// The pieces every printed paper is built from.
//
// A template is a few of these in a different order, so the clinic's identity, the
// look, the wording, the duplicate mark and the escaping are decided in one place.
// Everything that comes from data or settings passes through `esc` here: a patient's
// name, or a clinic's footer text, must never become markup on the page.
import { defaultLabel } from "@/features/printing/labels";
import { docInfo } from "@/features/printing/catalog";
import { PAPERS, type DocId, type Identity, type PaperId, type PrintSettings } from "@/features/printing/settings";

export function esc(s: unknown): string {
  return String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c] as string));
}

/** Newlines in clinic-written text become line breaks (after escaping). */
export const multiline = (s: string) => esc(s).replace(/\r?\n/g, "<br>");

export interface PrintCtx {
  settings: PrintSettings;
  /** The logo as a data URL, or "". */
  logo: string;
  /** The clinic's registered name, the fallback when no print name is set. */
  clinicName: string;
  /** The branch the paper is printed at (its own address and phone). */
  branch: { id?: string; name?: string; address?: string; phone?: string } | null;
  /** A contact line older call sites pass, used only when nothing else is set. */
  fallbackContact?: string;
}

/** The clinic's identity as it will be printed: print settings over branch over defaults. */
export function identityOf(c: PrintCtx): Identity & { branchName: string } {
  const s = c.settings.identity;
  const b = c.branch?.id ? c.settings.branches[c.branch.id] : undefined;
  const address = b?.addressLines?.length ? b.addressLines
    : s.addressLines.length ? s.addressLines
      : c.branch?.address ? [c.branch.address]
        : c.fallbackContact ? [c.fallbackContact] : [];
  const phones = b?.phones?.length ? b.phones : s.phones.length ? s.phones : c.branch?.phone ? [c.branch.phone] : [];
  return {
    ...s,
    nameEn: s.nameEn.trim() || c.clinicName || "Clinic",
    addressLines: address,
    phones,
    email: b?.email || s.email,
    tin: b?.tin || s.tin,
    branchName: c.branch?.name ?? "",
  };
}

/** One label, in the clinic's own words if they rewrote it. */
export function label(c: PrintCtx, key: string): string {
  const own = c.settings.labels[key];
  return own && own.trim() ? own : defaultLabel(key, c.settings.locale.language);
}

export function showFlag(c: PrintCtx, doc: DocId, id: string): boolean {
  const o = c.settings.docs[doc]?.show?.[id];
  if (typeof o === "boolean") return o;
  const t = docInfo(doc)?.toggles.find((x) => x.id === id);
  return t?.fallback ? t.fallback(c.settings) : t?.default ?? false;
}

/** The name printed under a signature line — or none, when several people sign from
 *  one account and the line is left for whoever signs. */
export function signer(c: PrintCtx, doc: DocId, who?: string): string | undefined {
  return showFlag(c, doc, "signerName") ? who : undefined;
}

export function textSlot(c: PrintCtx, doc: DocId, id: string): string {
  const o = c.settings.docs[doc]?.text?.[id];
  if (typeof o === "string") return o;
  return docInfo(doc)?.texts.find((t) => t.id === id)?.default ?? "";
}

// --- the clinic header ------------------------------------------------------------

const LOGO_PX = { small: 40, medium: 56, large: 84 } as const;
const LOGO_RADIUS = { square: "0", rounded: "10px", circle: "50%" } as const;

function logoHtml(c: PrintCtx, centered: boolean): string {
  const { look } = c.settings;
  if (look.logoPosition === "none") return "";
  const px = LOGO_PX[look.logoSize];
  // Square shows the picture whole. Rounded and circle crop it to the shape — a
  // circle drawn round a picture with a plain background would not be seen at all.
  const fit = look.logoShape === "square" ? "contain" : "cover";
  const inner = c.logo
    ? `<img src="${esc(c.logo)}" alt="" style="width:${px}px;height:${px}px;object-fit:${fit};border-radius:${LOGO_RADIUS[look.logoShape]};display:block">`
    : "";
  // A block as wide as the page would leave the picture at its left edge: the
  // wrapper is only as wide as the picture, so auto margins can centre it.
  return inner ? `<div class="logo"${centered ? ' style="width:fit-content;margin:0 auto 4px"' : ""}>${inner}</div>` : "";
}

/** Identity lines under the name: address, phones, email, web, tax numbers, extras. */
function identityLines(c: PrintCtx, id: ReturnType<typeof identityOf>, compact: boolean): string[] {
  if (compact) {
    const one = [id.addressLines[0], id.phones.join(" · ")].filter(Boolean).join(" · ");
    return one ? [esc(one)] : [];
  }
  const out: string[] = [];
  if (id.branchName) out.push(esc(id.branchName));
  for (const a of id.addressLines) if (a.trim()) out.push(esc(a));
  const contact = [...id.phones, id.email, id.website].filter((x) => x && x.trim());
  if (contact.length) out.push(esc(contact.join(" · ")));
  const nums = [
    id.tin ? `${esc(label(c, "common.tin"))} ${esc(id.tin)}` : "",
    id.vatNo ? `${esc(label(c, "common.vat"))} ${esc(id.vatNo)}` : "",
    id.licenseNo ? `${esc(label(c, "common.license"))} ${esc(id.licenseNo)}` : "",
  ].filter(Boolean);
  if (nums.length) out.push(nums.join(" · "));
  for (const e of id.extras) if (e.value.trim()) out.push(e.label.trim() ? `${esc(e.label)}: ${esc(e.value)}` : esc(e.value));
  return out;
}

/**
 * The top of the paper. `slip` stacks everything centred (a till roll is narrow);
 * a sheet puts the logo beside the identity, and may reserve blank space for a
 * pre-printed letterhead instead.
 */
export function headerHtml(c: PrintCtx, o: { slip?: boolean } = {}): string {
  const { look } = c.settings;
  const id = identityOf(c);
  if (look.header === "letterhead") {
    // The paper is already printed. Keep the space, and draw a guide on screen only.
    return `<div class="lh" style="height:${look.letterheadMm}mm"><span>Space for your letterhead</span></div>`;
  }
  const compact = look.header === "compact";
  const nameOnly = look.header === "name";
  const names = [`<div class="cname">${esc(id.nameEn)}</div>`];
  // The Amharic name is printed whenever the clinic gave one: they typed it to be seen.
  if (id.nameAm.trim()) names.push(`<div class="cname-am">${esc(id.nameAm)}</div>`);
  if (id.tagline.trim() && !nameOnly && !compact) names.push(`<div class="tagline">${esc(id.tagline)}</div>`);
  const lines = nameOnly ? (id.tin ? [`${esc(label(c, "common.tin"))} ${esc(id.tin)}`] : []) : identityLines(c, id, compact);
  const text = `<div class="ident">${names.join("")}${lines.map((l) => `<div class="cline">${l}</div>`).join("")}</div>`;
  const rule = look.rule ? `<div class="rule"></div>` : "";

  const pos = look.logoPosition;
  if (o.slip) {
    // A till roll is narrow, so the logo is stacked above the name by default; the
    // clinic's choice of left or right puts it beside the name instead.
    if (pos === "left" || pos === "right") {
      const sides = pos === "left" ? `${logoHtml(c, false)}${text}` : `${text}${logoHtml(c, false)}`;
      return `<header class="hd hd-row slip-row">${sides}</header>${rule}`;
    }
    return `<header class="hd slip-hd">${logoHtml(c, true)}${text}</header>${rule}`;
  }
  const logo = logoHtml(c, false);
  const body =
    pos === "center"
      ? `<div class="hd-col">${logo}${text}</div>`
      : pos === "right"
        ? `<div class="hd-row">${text}${logo}</div>`
        : `<div class="hd-row">${logo}${text}</div>`;
  return `<header class="hd">${body}</header>${rule}`;
}

/** The clinic's header, or — on a pre-printed pad — the blank space it needs. */
export function topHtml(c: PrintCtx, template: string, o: { slip?: boolean } = {}): string {
  if (template !== "pad") return headerHtml(c, o);
  return headerHtml({ ...c, settings: { ...c.settings, look: { ...c.settings.look, header: "letterhead" } } });
}

// --- parts ---------------------------------------------------------------------------

export function footerHtml(c: PrintCtx, extra: string[] = []): string {
  const parts = [...extra, c.settings.footer.text.trim() ? multiline(c.settings.footer.text) : ""].filter((p) => p && p.trim());
  return parts.length ? `<footer class="ft">${parts.map((p) => `<div>${p}</div>`).join("")}</footer>` : "";
}

export interface DuplicateInfo { count: number; firstBy?: string; lastBy?: string; firstAt?: string; lastAt?: string }

/** The reprint mark and the line that says who printed it before, when, and which copy. */
export function duplicateHtml(c: PrintCtx, dup: DuplicateInfo | null | undefined, when: (iso: string) => string): string {
  const ig = c.settings.integrity;
  if (!ig.duplicateMark || !dup || dup.count < 1) return "";
  const stamp = `<div class="dup">${esc(ig.duplicateText)}</div>`;
  if (!ig.showReprintLine) return stamp;
  const bits = [`${esc(label(c, "common.reprint"))} ${dup.count + 1}`];
  if (dup.firstBy) bits.push(`${esc(label(c, "common.printedBy"))} ${esc(dup.firstBy)}${dup.firstAt ? ` · ${esc(when(dup.firstAt))}` : ""}`);
  return `${stamp}<div class="dupline">${bits.join(" · ")}</div>`;
}

export function signatureBox(caption: string, who?: string): string {
  return `<div class="sig"><div class="sig-line"></div>${who ? `<div class="sig-who">${esc(who)}</div>` : ""}<div class="sig-cap">${esc(caption)}</div></div>`;
}

export function stampBox(caption: string): string {
  return `<div class="stampbox"><span>${esc(caption)}</span></div>`;
}

export function kvRow(k: string, v: string, o: { strong?: boolean } = {}): string {
  return `<div class="kv${o.strong ? " strong" : ""}"><span class="k">${esc(k)}</span><span class="v">${v}</span></div>`;
}

// --- page styling -----------------------------------------------------------------------

const FONTS = {
  sans: "ui-sans-serif,system-ui,-apple-system,'Segoe UI',Roboto,'Noto Sans Ethiopic',sans-serif",
  serif: "Georgia,'Times New Roman','Noto Serif Ethiopic',serif",
  mono: "ui-monospace,Menlo,Consolas,'Noto Sans Ethiopic',monospace",
} as const;
const SCALE = { small: 0.9, medium: 1, large: 1.14 } as const;

/** The page rules shared by every template: size, margins, type, the header and parts. */
export function baseCss(c: PrintCtx, paper: PaperId): string {
  const { look } = c.settings;
  const p = PAPERS[paper];
  const slip = p.heightMm === null;
  const scale = SCALE[look.textSize];
  const base = (slip ? 12 : paper === "a5" ? 12.5 : 13.5) * scale;
  const size = slip ? `${p.widthMm}mm auto` : `${p.widthMm}mm ${p.heightMm}mm`;
  return `
  :root{--accent:${look.accent};--ink:#111827;--muted:#6b7280;--line:#d9dde3}
  @page{size:${size};margin:${p.marginMm}mm}
  *{box-sizing:border-box}
  html,body{margin:0;padding:0}
  body{font-family:${FONTS[look.font]};color:var(--ink);font-size:${base}px;line-height:1.45;
       ${slip ? `width:${p.widthMm - p.marginMm * 2}mm;` : ""}-webkit-print-color-adjust:exact;print-color-adjust:exact}
  .muted{color:var(--muted)}
  .hd-row{display:flex;gap:14px;align-items:center}
  .hd-col{display:flex;flex-direction:column;align-items:center;text-align:center;gap:6px}
  .slip-hd{text-align:center}
  .slip-row{gap:8px}.slip-row .ident{flex:1}
  .ident{min-width:0}
  .cname{font-size:${(slip ? 15 : 20) * scale}px;font-weight:700;color:var(--accent);line-height:1.15}
  .cname-am{font-size:${(slip ? 13 : 16) * scale}px;font-weight:600;color:var(--accent)}
  .tagline{font-size:${11 * scale}px;color:var(--muted);font-style:italic}
  .cline{font-size:${(slip ? 10.5 : 11.5) * scale}px;color:var(--muted)}
  .rule{height:${slip ? 0 : 3}px;${slip ? "border-top:1px dashed #999;margin:6px 0" : "background:var(--accent);border-radius:2px;margin:12px 0 14px"}}
  .lh{border:1.5px dashed #b6c0cc;border-radius:6px;display:flex;align-items:center;justify-content:center;color:#7a8a9a;font-size:11px;margin-bottom:10px}
  @media print{.lh{border:0;color:transparent}}
  .kv{display:flex;justify-content:space-between;gap:10px;padding:1px 0}
  .kv .k{color:var(--muted)}
  .kv .v{text-align:right}
  .kv.strong{font-weight:700;font-size:${1.12}em}
  .kv.strong .k{color:var(--ink)}
  .dup{border:2px solid #b42318;color:#b42318;font-weight:800;text-align:center;letter-spacing:.14em;padding:3px 8px;margin:8px auto;width:fit-content;transform:rotate(-3deg)}
  .dupline{text-align:center;font-size:${10.5 * scale}px;color:#b42318}
  .ft{margin-top:${slip ? 8 : 18}px;font-size:${(slip ? 10.5 : 11) * scale}px;color:var(--muted);text-align:${slip ? "center" : "left"}}
  .ft>div+div{margin-top:3px}
  .sig{width:${slip ? "100%" : "230px"};text-align:center;margin-top:${slip ? 16 : 6}px}
  .sig-line{border-top:1px solid #374151;margin-bottom:4px}
  .sig-who{font-weight:600}
  .sig-cap{font-size:${10.5 * scale}px;color:var(--muted)}
  .stampbox{border:1.5px dashed #9aa8b6;width:${slip ? 70 : 96}px;height:${slip ? 52 : 70}px;display:flex;align-items:flex-start;justify-content:center;padding-top:4px;font-size:${10 * scale}px;color:#7a8a9a}
  .qr svg{width:${slip ? 70 : 92}px;height:${slip ? 70 : 92}px;display:block}
  .qr{text-align:center}
  .qr .ref{font-family:ui-monospace,Menlo,Consolas,monospace;font-size:${11 * scale}px;font-weight:700;margin-top:3px}
  .void-wm{position:fixed;top:36%;left:0;right:0;text-align:center;font-size:96px;font-weight:800;color:rgba(180,35,24,.13);transform:rotate(-18deg);letter-spacing:.12em}`;
}
