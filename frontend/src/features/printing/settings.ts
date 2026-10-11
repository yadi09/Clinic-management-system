// How a clinic's printed papers look: the shape of the settings document, its
// defaults, and how a stored (possibly old, possibly partial) document is read.
//
// The server keeps this as an opaque JSON object; this file owns what is in it. A
// stored document is never trusted to be complete: every read is merged over the
// defaults, so a clinic that saved last month's version still prints with this
// month's options, and a hand-edited or damaged one cannot break a print.

export type PaperId = "slip58" | "slip80" | "a5" | "a4";

export const PAPERS: Record<PaperId, { label: string; hint: string; widthMm: number; heightMm: number | null; marginMm: number }> = {
  slip58: { label: "Till slip 58 mm", hint: "Narrow thermal roll", widthMm: 58, heightMm: null, marginMm: 3 },
  slip80: { label: "Till slip 80 mm", hint: "Standard thermal roll", widthMm: 80, heightMm: null, marginMm: 4 },
  a5: { label: "A5", hint: "Half a sheet, 148 × 210 mm", widthMm: 148, heightMm: 210, marginMm: 10 },
  a4: { label: "A4", hint: "Full sheet, 210 × 297 mm", widthMm: 210, heightMm: 297, marginMm: 14 },
};

export type DocId = "receipt" | "prescription" | "labrequest" | "statement" | "zreport" | "labreport" | "certificate" | "exam" | "dispense";

export interface Identity {
  nameEn: string;
  nameAm: string;
  tagline: string;
  addressLines: string[];
  phones: string[];
  email: string;
  website: string;
  tin: string;
  vatNo: string;
  licenseNo: string;
  /** Up to three of the clinic's own lines — "Bank: CBE 1000…", "Open 8–6". */
  extras: { label: string; value: string }[];
}

export interface Look {
  logoPosition: "left" | "center" | "right" | "none";
  logoSize: "small" | "medium" | "large";
  logoShape: "square" | "rounded" | "circle";
  accent: string;
  font: "sans" | "serif" | "mono";
  textSize: "small" | "medium" | "large";
  /** full: logo and every line · compact: logo, name, one contact line · name: the
   *  name alone · letterhead: nothing, the paper is already printed. */
  header: "full" | "compact" | "name" | "letterhead";
  /** Blank space kept at the top when printing on a pre-printed letterhead. */
  letterheadMm: number;
  rule: boolean;
}

export interface Locale {
  language: "en" | "am" | "both";
  dates: "gregorian" | "ethiopian" | "both";
  time24: boolean;
  currency: string;
  thousands: boolean;
}

export interface Integrity {
  duplicateMark: boolean;
  duplicateText: string;
  showReprintLine: boolean;
}

export interface Signatures {
  /** Print the signer's name under signature lines. Off when several people work from
   *  one account and the line should be left for whoever signs. */
  showName: boolean;
}

export interface DocOverrides {
  template?: string;
  paper?: PaperId;
  show?: Record<string, boolean>;
  text?: Record<string, string>;
}

export interface BranchOverride {
  addressLines?: string[];
  phones?: string[];
  email?: string;
  tin?: string;
}

export interface PrintSettings {
  version: 1;
  identity: Identity;
  look: Look;
  locale: Locale;
  footer: { text: string };
  integrity: Integrity;
  signature: Signatures;
  docs: Partial<Record<DocId, DocOverrides>>;
  /** The clinic's own wording for any fixed label, keyed "receipt.total", "common.patient". */
  labels: Record<string, string>;
  branches: Record<string, BranchOverride>;
}

export const DEFAULT_SETTINGS: PrintSettings = {
  version: 1,
  identity: {
    nameEn: "", nameAm: "", tagline: "", addressLines: [], phones: [], email: "", website: "",
    tin: "", vatNo: "", licenseNo: "", extras: [],
  },
  look: {
    logoPosition: "left", logoSize: "medium", logoShape: "rounded", accent: "#14532d",
    font: "sans", textSize: "medium", header: "full", letterheadMm: 40, rule: true,
  },
  locale: { language: "en", dates: "gregorian", time24: false, currency: "ETB", thousands: true },
  footer: { text: "" },
  integrity: { duplicateMark: true, duplicateText: "DUPLICATE", showReprintLine: true },
  signature: { showName: true },
  docs: {},
  labels: {},
  branches: {},
};

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const str = (v: unknown, d: string) => (typeof v === "string" ? v : d);
const bool = (v: unknown, d: boolean) => (typeof v === "boolean" ? v : d);
const oneOf = <T extends string>(v: unknown, allowed: readonly T[], d: T): T => (allowed.includes(v as T) ? (v as T) : d);
const lines = (v: unknown, max: number): string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === "string").slice(0, max) : [];
const hex = (v: unknown, d: string) => (typeof v === "string" && /^#[0-9a-fA-F]{6}$/.test(v) ? v : d);

/** Read a stored document over the defaults. Unknown keys are dropped, wrong types fall back. */
export function resolveSettings(raw: unknown): PrintSettings {
  const d = DEFAULT_SETTINGS;
  const r = isObj(raw) ? raw : {};
  const id = isObj(r.identity) ? r.identity : {};
  const lk = isObj(r.look) ? r.look : {};
  const lc = isObj(r.locale) ? r.locale : {};
  const ig = isObj(r.integrity) ? r.integrity : {};
  const ft = isObj(r.footer) ? r.footer : {};
  const sg = isObj(r.signature) ? r.signature : {};
  const docs: PrintSettings["docs"] = {};
  if (isObj(r.docs)) {
    for (const [k, v] of Object.entries(r.docs)) {
      if (!isObj(v)) continue;
      const o: DocOverrides = {};
      if (typeof v.template === "string") o.template = v.template;
      if (typeof v.paper === "string" && v.paper in PAPERS) o.paper = v.paper as PaperId;
      if (isObj(v.show)) o.show = Object.fromEntries(Object.entries(v.show).filter(([, b]) => typeof b === "boolean")) as Record<string, boolean>;
      if (isObj(v.text)) o.text = Object.fromEntries(Object.entries(v.text).filter(([, s]) => typeof s === "string")) as Record<string, string>;
      docs[k as DocId] = o;
    }
  }
  const labels: Record<string, string> = {};
  if (isObj(r.labels)) for (const [k, v] of Object.entries(r.labels)) if (typeof v === "string" && v.trim()) labels[k] = v;
  const branches: Record<string, BranchOverride> = {};
  if (isObj(r.branches)) {
    for (const [k, v] of Object.entries(r.branches)) {
      if (!isObj(v)) continue;
      branches[k] = {
        addressLines: lines(v.addressLines, 3), phones: lines(v.phones, 3),
        email: str(v.email, ""), tin: str(v.tin, ""),
      };
    }
  }
  const extras = Array.isArray(id.extras)
    ? id.extras.filter(isObj).slice(0, 3).map((e) => ({ label: str(e.label, ""), value: str(e.value, "") }))
    : [];
  return {
    version: 1,
    identity: {
      nameEn: str(id.nameEn, d.identity.nameEn), nameAm: str(id.nameAm, ""), tagline: str(id.tagline, ""),
      addressLines: lines(id.addressLines, 3), phones: lines(id.phones, 3),
      email: str(id.email, ""), website: str(id.website, ""),
      tin: str(id.tin, ""), vatNo: str(id.vatNo, ""), licenseNo: str(id.licenseNo, ""), extras,
    },
    look: {
      logoPosition: oneOf(lk.logoPosition, ["left", "center", "right", "none"], d.look.logoPosition),
      logoSize: oneOf(lk.logoSize, ["small", "medium", "large"], d.look.logoSize),
      logoShape: oneOf(lk.logoShape, ["square", "rounded", "circle"], d.look.logoShape),
      accent: hex(lk.accent, d.look.accent),
      font: oneOf(lk.font, ["sans", "serif", "mono"], d.look.font),
      textSize: oneOf(lk.textSize, ["small", "medium", "large"], d.look.textSize),
      header: oneOf(lk.header, ["full", "compact", "name", "letterhead"], d.look.header),
      letterheadMm: typeof lk.letterheadMm === "number" ? Math.min(80, Math.max(0, Math.round(lk.letterheadMm))) : d.look.letterheadMm,
      rule: bool(lk.rule, d.look.rule),
    },
    locale: {
      language: oneOf(lc.language, ["en", "am", "both"], d.locale.language),
      dates: oneOf(lc.dates, ["gregorian", "ethiopian", "both"], d.locale.dates),
      time24: bool(lc.time24, d.locale.time24),
      currency: str(lc.currency, d.locale.currency).trim() || d.locale.currency,
      thousands: bool(lc.thousands, d.locale.thousands),
    },
    footer: { text: str(ft.text, "") },
    integrity: {
      duplicateMark: bool(ig.duplicateMark, d.integrity.duplicateMark),
      duplicateText: str(ig.duplicateText, d.integrity.duplicateText).trim() || d.integrity.duplicateText,
      showReprintLine: bool(ig.showReprintLine, d.integrity.showReprintLine),
    },
    signature: { showName: bool(sg.showName, d.signature.showName) },
    docs, labels, branches,
  };
}
