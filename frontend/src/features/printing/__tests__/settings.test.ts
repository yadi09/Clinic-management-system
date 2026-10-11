// A stored printing document is never trusted to be complete or well-formed: every
// read is merged over the defaults, so an old, partial or damaged document still
// prints, and a clinic that saved last month's version gets this month's options.
import { describe, expect, test } from "vitest";

import { DEFAULT_SETTINGS, PAPERS, resolveSettings } from "@/features/printing/settings";
import { pick } from "@/features/printing/templates/resolve";
import { defaultLabel, LABELS } from "@/features/printing/labels";
import { CATALOG, docInfo, docsFor } from "@/features/printing/catalog";

describe("REG-FE-PRSET printing settings", () => {
  test("REG-FE-PRSET-001 nothing stored, or junk, reads as the defaults", () => {
    for (const raw of [undefined, null, "text", 5, [], {}]) {
      expect(resolveSettings(raw)).toEqual(DEFAULT_SETTINGS);
    }
  });

  test("REG-FE-PRSET-002 a partial document keeps what it set and takes the rest from the defaults", () => {
    const s = resolveSettings({
      identity: { nameEn: "Abeba", tin: "001" }, look: { accent: "#112233", header: "letterhead", letterheadMm: 55 },
      locale: { language: "both", dates: "ethiopian", time24: true, currency: "Birr", thousands: false },
    });
    expect(s.identity.nameEn).toBe("Abeba");
    expect(s.identity.tin).toBe("001");
    expect(s.identity.phones).toEqual([]);
    expect(s.look).toMatchObject({ accent: "#112233", header: "letterhead", letterheadMm: 55, logoPosition: "left", rule: true });
    expect(s.locale).toEqual({ language: "both", dates: "ethiopian", time24: true, currency: "Birr", thousands: false });
    expect(s.integrity.duplicateMark).toBe(true);
  });

  test("REG-FE-PRSET-003 wrong types and unknown choices fall back; colours must be six-digit hex", () => {
    const s = resolveSettings({
      identity: { nameEn: 5, phones: "0911", addressLines: ["a", 3, "b"], extras: [{ label: 1, value: "v" }, "x"] },
      look: { accent: "red", header: "banner", logoPosition: "up", letterheadMm: 900, rule: "yes" },
      locale: { language: "fr", currency: "  " },
      integrity: { duplicateText: "   " },
    });
    expect(s.identity.nameEn).toBe("");
    expect(s.identity.phones).toEqual([]);
    expect(s.identity.addressLines).toEqual(["a", "b"]);
    expect(s.identity.extras).toEqual([{ label: "", value: "v" }]);
    expect(s.look.accent).toBe(DEFAULT_SETTINGS.look.accent);
    expect(s.look.header).toBe("full");
    expect(s.look.logoPosition).toBe("left");
    expect(s.look.letterheadMm).toBe(80);
    expect(s.look.rule).toBe(true);
    expect(s.locale.language).toBe("en");
    expect(s.locale.currency).toBe("ETB");
    expect(s.integrity.duplicateText).toBe("DUPLICATE");
  });

  test("REG-FE-PRSET-004 lists are capped (three lines, three phones, three extras) and unknown keys are dropped", () => {
    const s = resolveSettings({
      identity: { addressLines: ["1", "2", "3", "4"], phones: ["1", "2", "3", "4"], extras: [{}, {}, {}, {}] },
      surprise: true,
    });
    expect(s.identity.addressLines).toHaveLength(3);
    expect(s.identity.phones).toHaveLength(3);
    expect(s.identity.extras).toHaveLength(3);
    expect(s).not.toHaveProperty("surprise");
  });

  test("REG-FE-PRSET-005 per-paper choices, switches, texts, wording and branch overrides are read; bad ones dropped", () => {
    const s = resolveSettings({
      docs: {
        receipt: { template: "sheet", paper: "a4", show: { mrn: false, cashier: "no" }, text: { thanks: "Betam amesegnalehu", terms: 4 } },
        prescription: { paper: "postcard" },
        broken: 5,
      },
      labels: { "receipt.total": "Jemmer", "receipt.method": "  " },
      branches: { br1: { addressLines: ["Bole"], phones: ["0911"], email: "a@b.c", tin: "9" }, br2: 5 },
    });
    expect(s.docs.receipt).toEqual({ template: "sheet", paper: "a4", show: { mrn: false }, text: { thanks: "Betam amesegnalehu" } });
    expect(s.docs.prescription).toEqual({});
    expect(s.labels).toEqual({ "receipt.total": "Jemmer" });
    expect(s.branches.br1).toEqual({ addressLines: ["Bole"], phones: ["0911"], email: "a@b.c", tin: "9" });
    expect(s.branches.br2).toBeUndefined();
  });

  test("REG-FE-PRSET-006 a template is only ever drawn on a paper it suits, and each default is one of them", () => {
    for (const d of CATALOG) {
      for (const t of d.templates) {
        expect(t.papers).toContain(t.paper);
        for (const p of t.papers) expect(PAPERS[p]).toBeDefined();
      }
    }
    // Asking for a till slip on A4 gives the slip's own paper, not a broken page.
    expect(pick("receipt", DEFAULT_SETTINGS, { template: "slip", paper: "a4" })).toEqual({ template: "slip", paper: "slip80" });
    expect(pick("receipt", DEFAULT_SETTINGS, { template: "sheet", paper: "a4" })).toEqual({ template: "sheet", paper: "a4" });
    expect(pick("receipt", resolveSettings({ docs: { receipt: { template: "sheet" } } }), {})).toEqual({ template: "sheet", paper: "a5" });
    expect(pick("receipt", DEFAULT_SETTINGS, { template: "nope" })).toEqual({ template: "slip", paper: "slip80" });
    expect(docInfo("receipt")?.logKind).toBe("receipt");
    expect(docInfo("zreport")?.logKind).toBe("zreport");
    // A statement is regenerated with new figures every time: it is never counted as a copy.
    expect(docInfo("statement")?.logKind).toBeUndefined();
    expect(docInfo("nope" as never)).toBeUndefined();
  });

  test("REG-FE-PRSET-009 the signer's name is on unless the clinic switched it off; a wrong type falls back to on", () => {
    expect(DEFAULT_SETTINGS.signature.showName).toBe(true);
    expect(resolveSettings({ signature: { showName: false } }).signature.showName).toBe(false);
    expect(resolveSettings({ signature: { showName: "no" } }).signature.showName).toBe(true);
    expect(resolveSettings({ signature: "off" }).signature.showName).toBe(true);
  });

  test("REG-FE-PRSET-010 papers follow the clinic's modules: a dental clinic is not offered the laboratory's", () => {
    const ids = (flags: string[]) => docsFor((f) => flags.includes(f)).map((d) => d.id).sort();
    const core = ["certificate", "prescription", "receipt", "statement", "zreport"];
    expect(ids([])).toEqual([...core, "labrequest"].sort());
    expect(ids(["dental"])).toEqual([...core, "exam"].sort());
    expect(ids(["laboratory", "pharmacy"])).toEqual([...core, "dispense", "labreport"].sort());
    expect(ids(["dental", "laboratory", "pharmacy"])).toEqual([...core, "dispense", "exam", "labreport"].sort());
  });

  test("REG-FE-PRSET-008 the catalog covers every document, with unique ids, and every wording key it offers exists", () => {
    const ids = CATALOG.map((d) => d.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect([...ids].sort()).toEqual(["certificate", "dispense", "exam", "labreport", "labrequest", "prescription", "receipt", "statement", "zreport"]);
    for (const d of CATALOG) {
      expect(new Set(d.templates.map((t) => t.id)).size).toBe(d.templates.length);
      expect(new Set(d.toggles.map((t) => t.id)).size).toBe(d.toggles.length);
      for (const key of d.labels) expect(LABELS[key], `${d.id}: ${key}`).toBeDefined();
    }
  });

  test("REG-FE-PRSET-007 labels: English, Amharic, both; an unknown key is its own name", () => {
    expect(defaultLabel("common.total", "en")).toBe("Total");
    expect(defaultLabel("common.total", "am")).toBe("ጠቅላላ");
    expect(defaultLabel("common.total", "both")).toBe("Total · ጠቅላላ");
    expect(defaultLabel("no.such.key", "en")).toBe("no.such.key");
  });
});
