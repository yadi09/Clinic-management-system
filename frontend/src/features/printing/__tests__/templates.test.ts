// What a clinic's papers actually say, drawn from its settings: the identity block in
// each header style, the receipt as a till slip and as a sheet, the prescription in
// its three layouts, every optional part behind its switch, the clinic's own wording,
// the reprint mark, and the guarantee that nothing typed becomes markup.
import { describe, expect, test } from "vitest";

import { docInfo } from "@/features/printing/catalog";
import { build, pageHtml, previewHtml, refOf, type DocData } from "@/features/printing/engine";
import type { PrintCtx } from "@/features/printing/blocks";
import { DEFAULT_SETTINGS, resolveSettings } from "@/features/printing/settings";
import type { ReceiptDoc } from "@/features/printing/templates/receipt";
import type { PrescriptionDoc } from "@/features/printing/templates/sheet";

const textOf = (html: string) => {
  const doc = new DOMParser().parseFromString(html, "text/html");
  doc.querySelectorAll("script,style").forEach((n) => n.remove());
  const w = doc.createTreeWalker(doc.body, NodeFilter.SHOW_TEXT);
  const parts: string[] = [];
  for (let n = w.nextNode(); n; n = w.nextNode()) parts.push(n.textContent ?? "");
  return parts.join(" ").replace(/\s+/g, " ").trim();
};

const ctx = (raw: unknown = {}, over: Partial<PrintCtx> = {}): PrintCtx => ({
  settings: resolveSettings(raw), logo: "", clinicName: "Registered Name", branch: null, ...over,
});

const receipt = (over: Partial<ReceiptDoc> = {}): DocData => ({
  doc: "receipt",
  data: {
    kind: "payment", number: "RCP-000042", when: "2026-10-03T09:41:00+03:00", patient: "Abebe Kebede", mrn: "P000033",
    lines: [{ description: "Root canal", amount: "1500" }], total: "1500", currency: "ETB",
    method: "Telebirr", reference: "CJ47X", cashier: "Hana", ...over,
  },
});
const rx = (over: Partial<PrescriptionDoc> = {}): DocData => ({
  doc: "prescription",
  data: {
    clinic: "", rxRef: "Rx 4F2A", qrData: "x", patient: "Abebe Kebede", mrn: "P000033", age: 29, gender: "male",
    weightKg: "62", prescriber: "Dr Yonas", prescriberLicense: "L-9", when: "2026-10-03T09:41:00+03:00",
    diagnoses: [{ description: "Pulpitis" }], meds: [{ drug_name: "Amoxicillin", dose: "1 cap" }],
    note: "Review", allergies: ["Penicillin"], ...over,
  },
});
const render = (d: DocData, c: PrintCtx, o = {}) => {
  const b = build(d, c, o);
  return { ...b, page: pageHtml(b, c), text: textOf(b.html) };
};

describe("REG-FE-PRTPL the identity block", () => {
  test("REG-FE-PRTPL-001 with nothing set the registered name is used; with a print name, that wins", () => {
    expect(render(receipt(), ctx()).text).toContain("Registered Name");
    const r = render(receipt(), ctx({ identity: { nameEn: "Abeba Dental", nameAm: "አበባ" } }));
    expect(r.text).toContain("Abeba Dental");
    expect(r.text).toContain("አበባ");
    expect(r.text).not.toContain("Registered Name");
  });

  test("REG-FE-PRTPL-002 full header: address, phones, email, web, tax numbers and the clinic's own lines", () => {
    const r = render(receipt(), ctx({
      identity: {
        nameEn: "Abeba", tagline: "Smile more", addressLines: ["Bole, Addis Ababa", "Near Edna Mall"], phones: ["0911 00 00 00", "0922 11 11 11"],
        email: "hi@abeba.et", website: "abeba.et", tin: "0012345678", vatNo: "VAT-1", licenseNo: "AA/1234",
        extras: [{ label: "Bank", value: "CBE 1000123" }, { label: "", value: "Open 8-6" }, { label: "Empty", value: "" }],
      },
    }));
    for (const part of ["Smile more", "Bole, Addis Ababa", "Near Edna Mall", "0911 00 00 00 · 0922 11 11 11", "hi@abeba.et", "abeba.et",
      "TIN 0012345678", "VAT no. VAT-1", "Licence no. AA/1234", "Bank: CBE 1000123", "Open 8-6"]) {
      expect(r.text).toContain(part);
    }
    expect(r.text).not.toContain("Empty");
  });

  test("REG-FE-PRTPL-003 compact is the name and one contact line; name-only is the name and the tax number", () => {
    const id = { nameEn: "Abeba", addressLines: ["Bole"], phones: ["0911"], email: "e@x", tin: "99", tagline: "Slogan" };
    const compact = render(receipt(), ctx({ identity: id, look: { header: "compact" } }));
    expect(compact.text).toContain("Bole · 0911");
    expect(compact.text).not.toContain("e@x");
    expect(compact.text).not.toContain("Slogan");
    const name = render(receipt(), ctx({ identity: id, look: { header: "name" } }));
    expect(name.text).toContain("TIN 99");
    expect(name.text).not.toContain("Bole");
  });

  test("REG-FE-PRTPL-004 on a pre-printed letterhead nothing of the clinic prints, and the space is kept", () => {
    const r = render(rx(), ctx({ identity: { nameEn: "Abeba" }, look: { header: "letterhead", letterheadMm: 55 } }));
    expect(r.html).toContain('class="lh" style="height:55mm"');
    expect(r.html).not.toContain('class="cname"');
    // The guide is drawn on screen only; it must not print.
    expect(r.page).toContain("@media print{.lh{border:0;color:transparent}}");
  });

  test("REG-FE-PRTPL-005 the logo appears at its size, shape and place, or not at all", () => {
    const logo = "data:image/png;base64,AAAA";
    const r = render(receipt(), ctx({ look: { logoSize: "large", logoShape: "circle" } }, { logo }));
    expect(r.html).toContain(`<img src="${logo}"`);
    expect(r.html).toContain("width:84px;height:84px");
    expect(r.html).toContain("border-radius:50%");
    expect(render(receipt(), ctx({ look: { logoPosition: "none" } }, { logo })).html).not.toContain("<img");
    expect(render(receipt(), ctx({}, { logo: "" })).html).not.toContain("<img");
    const right = render(rx(), ctx({ look: { logoPosition: "right" } }, { logo }));
    expect(right.html.indexOf('class="ident"')).toBeLessThan(right.html.indexOf("<img"));
    expect(render(rx(), ctx({ look: { logoPosition: "center" } }, { logo })).html).toContain("hd-col");
  });

  test("REG-FE-PRTPL-006 a branch's own address, phone and tax number replace the clinic's; an old call site's contact is the last resort", () => {
    const settings = {
      identity: { addressLines: ["Head office"], phones: ["0911"], tin: "1" },
      branches: { b1: { addressLines: ["Bole branch"], phones: ["0922"], tin: "2", email: "bole@x" } },
    };
    const a = render(receipt(), ctx(settings, { branch: { id: "b1", name: "Bole" } }));
    expect(a.text).toContain("Bole branch");
    expect(a.text).toContain("0922");
    expect(a.text).toContain("TIN 2");
    expect(a.text).toContain("bole@x");
    expect(a.text).not.toContain("Head office");
    const b = render(receipt(), ctx({}, { branch: { id: "b9", address: "Branch Rd", phone: "0933" } }));
    expect(b.text).toContain("Branch Rd");
    expect(b.text).toContain("0933");
    expect(render(receipt(), ctx({}, { fallbackContact: "Old contact line" })).text).toContain("Old contact line");
  });
});

describe("REG-FE-PRTPL receipts", () => {
  test("REG-FE-PRTPL-010 the till slip: number, date and time on the Addis clock, patient, lines, total, how, who", () => {
    const r = render(receipt(), ctx());
    expect(r.template).toBe("slip");
    expect(r.paper).toBe("slip80");
    expect(r.title).toBe("RCP-000042");
    for (const part of ["Payment receipt", "RCP-000042", "3 Oct 2026, 9:41 AM", "Abebe Kebede (P000033)", "Root canal", "ETB 1,500.00",
      "Paid by Telebirr", "Reference CJ47X", "Received by Hana", "Thank you. Keep this receipt for your records."]) {
      expect(r.text).toContain(part);
    }
    expect(r.page).toContain("@page{size:80mm auto;margin:4mm}");
  });

  test("REG-FE-PRTPL-011 the sheet receipt on A5 or A4, with a lines table and boxes for a signature and a stamp", () => {
    const c = ctx({ docs: { receipt: { template: "sheet", paper: "a4", show: { customerSign: true, stamp: true } } } });
    const r = render(receipt(), c);
    expect(r.template).toBe("sheet");
    expect(r.paper).toBe("a4");
    expect(r.html).toContain("<table class=\"lines\">");
    expect(r.text).toContain("Customer signature");
    expect(r.text).toContain("Stamp");
    expect(r.page).toContain("@page{size:210mm 297mm;margin:14mm}");
    expect(render(receipt(), ctx({ docs: { receipt: { template: "sheet" } } })).paper).toBe("a5");
  });

  test("REG-FE-PRTPL-012 each optional part is behind its own switch", () => {
    const off = ctx({ docs: { receipt: { show: { mrn: false, cashier: false, method: false, reference: false, time: false } } } });
    const t = render(receipt(), off).text;
    expect(t).toContain("Abebe Kebede");
    expect(t).not.toContain("P000033");
    expect(t).not.toContain("Hana");
    expect(t).not.toContain("Telebirr");
    expect(t).not.toContain("CJ47X");
    expect(t).toContain("3 Oct 2026");
    expect(t).not.toContain("9:41");
    const on = render(receipt({ phone: "0911 22", balance: "3000" }), ctx({ docs: { receipt: { show: { phone: true, inWords: true } } } })).text;
    expect(on).toContain("0911 22");
    expect(on).toContain("In words: One thousand five hundred birr only");
    expect(on).toContain("Balance remaining ETB 3,000.00");
    // Nothing remaining, nothing printed.
    expect(render(receipt({ balance: "0" }), ctx()).text).not.toContain("Balance remaining");
  });

  test("REG-FE-PRTPL-013 a refund slip and a refunded payment say so; a refund total is marked negative", () => {
    const refund = render(receipt({ kind: "refund", original: "RCP-000040", reason: "Service not provided", total: "1500" }), ctx());
    expect(refund.text).toContain("Refund slip");
    expect(refund.text).toContain("RCP-000040");
    expect(refund.text).toContain("Service not provided");
    expect(refund.text).toContain("− ETB 1,500.00");
    expect(render(receipt({ refunded: true }), ctx()).text).toContain("Payment receipt — REFUNDED");
  });

  test("REG-FE-PRTPL-014 a receipt with no number prints a dash and a missing method or cashier prints dashes, never 'undefined'", () => {
    const r = render(receipt({ number: "", method: undefined, cashier: undefined, reference: undefined, lines: [] }), ctx());
    expect(r.title).toBe("—");
    expect(r.text).toContain("Paid by —");
    expect(r.text).toContain("Received by —");
    expect(r.text).not.toContain("undefined");
  });

  test("REG-FE-PRTPL-015 the clinic's wording, footer, terms, currency and calendar are used", () => {
    const c = ctx({
      locale: { currency: "Birr", dates: "both", time24: true, thousands: false, language: "am" },
      labels: { "receipt.title": "Yekifiya Deresegn" },
      footer: { text: "Open daily 8–6" },
      docs: { receipt: { text: { thanks: "Betam Amesegnalehu", terms: "No refunds after 7 days." } } },
    });
    const r = render(receipt(), c);
    expect(r.text).toContain("Yekifiya Deresegn");
    expect(r.text).toContain("Betam Amesegnalehu");
    expect(r.text).toContain("No refunds after 7 days.");
    expect(r.text).toContain("Open daily 8–6");
    expect(r.text).toContain("Birr 1500.00");
    expect(r.text).toContain("3 Oct 2026 · 23 Meskerem 2019, 09:41");
    expect(r.text).toContain("ታካሚ"); // an untouched label, in Amharic
  });

  test("REG-FE-PRTPL-016 a reprint is marked, with who printed it first, when and which copy", () => {
    const dup = { count: 2, firstBy: "Hana", firstAt: "2026-10-03T09:41:00+03:00" };
    const r = render(receipt(), ctx(), { duplicate: dup });
    expect(r.html).toContain('class="dup">DUPLICATE');
    expect(r.text).toContain("Copy 3");
    expect(r.text).toContain("Printed by Hana");
    expect(r.text).toContain("3 Oct 2026, 9:41 AM");
    expect(render(receipt(), ctx(), { duplicate: null }).html).not.toContain('class="dup"');
    const quiet = render(receipt(), ctx({ integrity: { duplicateText: "COPY", showReprintLine: false } }), { duplicate: dup });
    expect(quiet.html).toContain('class="dup">COPY');
    expect(quiet.html).not.toContain("dupline");
    expect(render(receipt(), ctx({ integrity: { duplicateMark: false } }), { duplicate: dup }).html).not.toContain('class="dup"');
  });

  test("REG-FE-PRTPL-017 nothing typed becomes markup: patient, clinic, footer, terms and wording are escaped", () => {
    const r = render(
      receipt({ patient: "<img src=x onerror=alert(1)>", lines: [{ description: "<script>1</script>", amount: "1" }] }),
      ctx({
        identity: { nameEn: "A&B <Clinic>" }, footer: { text: "<b>x</b>\nline two" },
        labels: { "common.patient": "<i>Pt</i>" }, docs: { receipt: { text: { terms: "<u>t</u>" } } },
      }),
    );
    for (const injected of ["<img", "<script", "<i>Pt", "<u>t", "<b>x"]) expect(r.html).not.toContain(injected);
    expect(r.html).toContain("A&amp;B &lt;Clinic&gt;");
    expect(r.html).toContain("&lt;b&gt;x&lt;/b&gt;<br>line two");
  });
});

describe("REG-FE-PRTPL prescriptions and lab requests", () => {
  test("REG-FE-PRTPL-020 classic: header, patient line, prescriber with licence, diagnosis, medicine, note, allergies, signature", () => {
    const r = render(rx(), ctx({ identity: { nameEn: "Abeba" } }), { qrSvg: "<svg></svg>" });
    expect(r.template).toBe("classic");
    expect(r.paper).toBe("a4");
    for (const part of ["Abeba", "Abebe Kebede", "Card no. P000033", "29M", "62 kg", "3 Oct 2026", "Dr Yonas", "Licence no. L-9",
      "Diagnosis Pulpitis", "Amoxicillin", "1 cap", "Note Review", "Allergies Penicillin", "Signature & stamp", "Rx 4F2A"]) {
      expect(r.text).toContain(part);
    }
    expect(r.html).toContain('<div class="qr"><svg></svg>');
  });

  test("REG-FE-PRTPL-021 compact is A5; the pre-printed pad keeps the top blank whatever the header setting", () => {
    expect(render(rx(), ctx({ docs: { prescription: { template: "compact" } } })).paper).toBe("a5");
    const pad = render(rx(), ctx({ identity: { nameEn: "Abeba" }, docs: { prescription: { template: "pad" } } }));
    expect(pad.template).toBe("pad");
    expect(pad.paper).toBe("a5");
    expect(pad.html).toContain('class="lh"');
    expect(pad.html).not.toContain('class="cname"');
  });

  test("REG-FE-PRTPL-022 each optional part of a prescription is behind its own switch", () => {
    const off = ctx({ docs: { prescription: { show: {
      diagnosis: false, weight: false, allergies: false, note: false, qr: false, license: false, signature: false, stamp: false, validity: false,
    } } } });
    const r = render(rx(), off, { qrSvg: "<svg></svg>" });
    for (const part of ["Pulpitis", "62 kg", "Penicillin", "Review", "Licence no.", "Signature & stamp", "Valid only with"]) {
      expect(r.text).not.toContain(part);
    }
    expect(r.html).not.toContain('class="qr"');
    expect(r.html).not.toContain("stampbox");
    const on = render(rx(), ctx(), {});
    expect(on.text).toContain("Valid only with the prescriber's signature");
  });

  test("REG-FE-PRTPL-023 a lab request in the same three layouts, with its own wording and instruction", () => {
    const d: DocData = {
      doc: "labrequest",
      data: {
        clinic: "", ref: "Lab 1", qrData: "x", patient: "Abebe", mrn: "M1", age: 30, gender: "female", prescriber: "Dr H",
        prescriberLicense: "L-1", when: "2026-10-03T09:00:00+03:00", tests: ["CBC", " "], indication: "Fever",
      },
    };
    const r = render(d, ctx({ docs: { labrequest: { text: { instruction: "Return to the clinic." } } } }));
    for (const part of ["Laboratory request", "Requested tests", "CBC", "Clinical indication Fever", "Requested by Dr H", "Licence no. L-1", "Return to the clinic."]) {
      expect(r.text).toContain(part);
    }
    expect((r.html.match(/class="num"/g) ?? []).length).toBe(1); // the blank test is dropped
    expect(render(d, ctx({ docs: { labrequest: { template: "pad" } } })).html).toContain('class="lh"');
    expect(render(d, ctx({ docs: { labrequest: { show: { indication: false } } } })).text).not.toContain("Fever");
  });

  test("REG-FE-PRTPL-024 a reprint of a prescription is marked", () => {
    expect(render(rx(), ctx(), { duplicate: { count: 1 } }).text).toContain("DUPLICATE");
  });
});

describe("REG-FE-PRTPL page rules", () => {
  test("REG-FE-PRTPL-030 paper size, margins, accent, typeface and text size reach the page", () => {
    const r = render(receipt(), ctx({
      look: { accent: "#aa0000", font: "serif", textSize: "large" },
      docs: { receipt: { template: "slip", paper: "slip58" } },
    }));
    expect(r.page).toContain("--accent:#aa0000");
    expect(r.page).toContain("Georgia");
    expect(r.page).toContain("@page{size:58mm auto;margin:3mm}");
    expect(r.page).toContain("width:52mm");
    const small = render(receipt(), ctx({ look: { textSize: "small" } }));
    const big = render(receipt(), ctx({ look: { textSize: "large" } }));
    const px = (h: string) => Number(/font-size:([\d.]+)px;line-height:1\.45/.exec(h)![1]);
    expect(px(small.page)).toBeLessThan(px(big.page));
  });

  test("REG-FE-PRTPL-031 every default and every template renders without leaving a hole", () => {
    for (const d of [receipt(), rx(), { doc: "labrequest", data: { clinic: "", ref: "L", qrData: "", patient: "P", when: "2026-10-03", tests: ["T"] } } as DocData]) {
      for (const template of ["slip", "sheet", "classic", "compact", "pad"]) {
        const r = render(d, ctx(DEFAULT_SETTINGS), { template });
        expect(r.page).not.toContain("undefined");
        expect(r.page).not.toContain("[object Object]");
      }
    }
  });
});

// ---- the other six papers -----------------------------------------------------------------

const statement = (over: Record<string, unknown> = {}): DocData => ({
  doc: "statement",
  data: {
    patient: "Sara Bekele", mrn: "P000077", phone: "0922000000", currency: "ETB",
    lines: [{ date: "2026-10-01", description: "Consult", status: "Paid", amount: "300" }],
    charged: "300", paid: "300", refunded: "0", outstanding: "0", issuedBy: "Hana", ...over,
  },
} as DocData);
const zreport = (over: Record<string, unknown> = {}): DocData => ({
  doc: "zreport",
  data: {
    cashier: "Hana", businessDate: "2026-10-03", currency: "ETB",
    byMethod: [{ label: "Cash", total: "1000", count: 3, cash: true }, { label: "Telebirr", total: "500", count: 1 }],
    expected: "1000", counted: "950", variance: "-50", ...over,
  },
} as DocData);
const labreport = (over: Record<string, unknown> = {}): DocData => ({
  doc: "labreport",
  data: {
    sampleNo: 1042, testName: "Complete blood count", patient: "Abebe Kebede", mrn: "P000033", priority: "routine",
    status: "validated", orderedBy: "Dr Yonas", specimen: "Whole blood", collectedBy: "Selam", collectedAt: "2026-10-03T08:00:00+03:00",
    reportedAt: "2026-10-03T10:00:00+03:00", validatedAt: "2026-10-03T10:30:00+03:00", validatedBy: "Dr Meron",
    clinicalNote: "Fever", critical: false,
    analytes: [
      { name: "Haemoglobin", value: "13.4", unit: "g/dL", refLow: "13", refHigh: "17", flag: "normal" },
      { name: "WBC", value: "18", unit: "x10^9/L", refLow: "4", refHigh: "11", flag: "high" },
      { name: "Platelets", flag: "normal" },
    ],
    ...over,
  },
} as DocData);
const dispense = (over: Record<string, unknown> = {}): DocData => ({
  doc: "dispense",
  data: {
    rxRef: "R-1042", patient: "Abebe Kebede", mrn: "P000033", prescriber: "Dr Yonas", when: "2026-10-03T09:41:00+03:00",
    items: [
      { drug: "Amoxicillin 500 mg", sig: "1 cap, 3 times a day", qty: 21, batch: "AMX-22", expiry: "2027-08" },
      { drug: "Penicillin V", sig: "1 tab", blocked: "patient allergic to penicillin" },
    ],
    allergies: ["Penicillin"], counselling: "Finish the course", dispensedBy: "Selam", ...over,
  },
} as DocData);

describe("REG-FE-PRTPL statement of account", () => {
  test("REG-FE-PRTPL-040 lines, totals, who issued it, and the phone only when the clinic switches it on", () => {
    const r = render(statement(), ctx());
    for (const part of ["Statement of account", "Sara Bekele", "P000077", "2026-10-01 Consult Paid ETB 300.00", "Total charged ETB 300.00", "Balance outstanding ETB 0.00", "by Hana"]) {
      expect(r.text).toContain(part);
    }
    expect(r.text).not.toContain("0922000000");
    expect(render(statement(), ctx({ docs: { statement: { show: { phone: true } } } })).text).toContain("0922000000");
  });

  test("REG-FE-PRTPL-041 the status column, the issuer and the 'how to pay' box each have a switch", () => {
    const d = statement({ payTo: [{ label: "CBE", account: "1000" }] });
    expect(render(d, ctx()).text).toContain("How to pay CBE · 1000");
    const off = render(d, ctx({ docs: { statement: { show: { status: false, issuedBy: false, payTo: false } } } })).text;
    expect(off).not.toContain("How to pay");
    expect(off).not.toContain("by Hana");
    expect(off).not.toMatch(/Consult Paid/);
  });

  test("REG-FE-PRTPL-042 dental: balance owed now adds treatment given but not billed; a statement is never counted as a reprint", () => {
    const r = render(statement({ outstanding: "2000", unbilled: "1500", upcoming: "4000", charged: "5000", paid: "3000" }), ctx());
    expect(r.text).toContain("Balance owed now ETB 3,500.00");
    expect(r.text).toContain("Still to come on treatment plans (not yet owed) ETB 4,000.00");
    // A statement is regenerated with new figures each time, so it carries no log reference.
    expect(refOf(statement())).toBe("");
  });

  test("REG-FE-PRTPL-043 the clinic's terms print under the totals, and its own currency word replaces ETB", () => {
    const r = render(statement(), ctx({ docs: { statement: { text: { terms: "Settle within 14 days." } } }, locale: { currency: "Birr" } }));
    expect(r.text).toContain("Settle within 14 days.");
    expect(r.text).toContain("Birr 300.00");
  });
});

describe("REG-FE-PRTPL end-of-day Z-report", () => {
  test("REG-FE-PRTPL-044 methods, drawer reconciliation, the verdict, and both signature lines", () => {
    const r = render(zreport(), ctx());
    for (const part of ["End-of-day Z-report", "Cashier Hana", "Cash (3) ETB 1,000.00", "Telebirr (1) — not in drawer ETB 500.00",
      "Expected cash ETB 1,000.00", "Counted cash ETB 950.00", "Variance (SHORT) ETB -50.00", "Cashier signature", "Manager signature"]) {
      expect(r.text).toContain(part);
    }
    expect(r.title).toBe("Z-2026-10-03");
    expect(render(zreport({ variance: "0" }), ctx()).text).toContain("Variance (BALANCED)");
    expect(render(zreport({ variance: "20" }), ctx()).text).toContain("Variance (OVER)");
  });

  test("REG-FE-PRTPL-045 one close-out per cashier per day is the counted reference; a note and the branch print when present", () => {
    expect(refOf(zreport())).toBe("Z-2026-10-03-Hana");
    const r = render(zreport({ note: "Gave change" }), ctx({}, { branch: { id: "b1", name: "Bole" } }));
    expect(r.text).toContain("Note Gave change");
    expect(r.text).toContain("Branch Bole");
    const off = render(zreport(), ctx({ docs: { zreport: { show: { managerSign: false, printedAt: false } } } })).text;
    expect(off).not.toContain("Manager signature");
    expect(off).not.toContain("Printed");
  });

  test("REG-FE-PRTPL-046 it fits a till slip and a sheet, with no hole in either", () => {
    for (const template of ["slip", "sheet"]) {
      const r = render(zreport(), ctx(), { template });
      expect(r.page).not.toContain("undefined");
      expect(r.paper).toBe(template === "slip" ? "slip80" : "a5");
    }
  });
});

describe("REG-FE-PRTPL laboratory report", () => {
  test("REG-FE-PRTPL-047 the results table with reference ranges and flags, and the collection and validation trail", () => {
    const r = render(labreport(), ctx());
    for (const part of ["Laboratory report", "Complete blood count", "Sample S-1042", "Whole blood", "Abebe Kebede", "Card no. P000033",
      "Haemoglobin 13.4 g/dL 13–17 g/dL", "WBC 18 x10^9/L 4–11 x10^9/L HIGH", "Platelets — — NORMAL", "Collected", "Selam", "Validated by Dr Meron"]) {
      expect(r.text).toContain(part);
    }
    expect(r.html).toContain('class="abn"');
    expect(refOf(labreport())).toBe("S-1042");
  });

  test("REG-FE-PRTPL-048 a critical value says whether it was communicated; the clinic can hide the trail and the flags", () => {
    const notYet = render(labreport({ critical: true }), ctx()).text;
    expect(notYet).toContain("Critical value");
    expect(notYet).toContain("NOT YET COMMUNICATED");
    const told = render(labreport({ critical: true, notifiedAt: "2026-10-03T11:00:00+03:00", notifiedBy: "Selam" }), ctx()).text;
    expect(told).toContain("notified");
    expect(told).toContain("by Selam");
    expect(told).not.toContain("NOT YET COMMUNICATED");
    const off = render(labreport({ critical: true }), ctx({ docs: { labreport: { show: { flags: false, collection: false, validatedBy: false, critical: false } } } })).text;
    expect(off).not.toContain("HIGH");
    expect(off).not.toContain("Collected");
    expect(off).not.toContain("Validated by");
    expect(off).not.toContain("Critical value");
  });

  test("REG-FE-PRTPL-049 a lab report is counted, so a reprint is marked; the closing disclaimer is the clinic's to reword", () => {
    expect(render(labreport(), ctx(), { duplicate: { count: 1 } }).text).toContain("DUPLICATE");
    expect(render(labreport(), ctx()).text).toContain("Results relate only to the sample received.");
    expect(render(labreport(), ctx({ docs: { labreport: { text: { footer: "Verified by QC." } } } })).text).toContain("Verified by QC.");
  });
});

describe("REG-FE-PRTPL medical certificate and examination", () => {
  const cert = (over: Record<string, unknown> = {}): DocData => ({
    doc: "certificate",
    data: {
      clinic: "", ref: "MC-1", kind: "sick_leave", patient: "Abebe", showDiagnosis: false, restDays: 2,
      issuedOn: "2026-10-01", status: "active", ...over,
    },
  } as DocData);

  test("REG-FE-PRTPL-050 a certificate is counted under its own reference and a voided one is watermarked", () => {
    expect(refOf(cert())).toBe("MC-1");
    expect(render(cert({ status: "void" }), ctx()).html).toContain('class="void-wm"');
    expect(render(cert(), ctx(), { duplicate: { count: 2 } }).text).toContain("DUPLICATE");
  });

  test("REG-FE-PRTPL-051 an examination is not counted, and each of its sections is behind a switch", () => {
    const d = {
      doc: "exam",
      data: {
        patient: "Abebe", visitDate: "2026-10-01", extraoral: ["Swelling"], intraoral: [], investigations: [],
        treatmentGiven: [], procedures: [], chiefComplaint: "Pain", diagnosis: "Pulpitis", treatmentPlan: "RCT", postop: "Soft diet",
      },
    } as DocData;
    expect(refOf(d)).toBe("");
    const all = render(d, ctx()).text;
    for (const part of ["Presenting complaint", "Extraoral examination", "Diagnosis", "Treatment plan", "Post-operative instructions"]) {
      expect(all).toContain(part);
    }
    const some = render(d, ctx({ docs: { exam: { show: { complaint: false, findings: false, plan: false, postop: false } } } })).text;
    expect(some).not.toContain("Presenting complaint");
    expect(some).not.toContain("Extraoral");
    expect(some).not.toContain("Treatment plan");
    expect(some).toContain("Diagnosis");
  });
});

describe("REG-FE-PRTPL dispensing slip", () => {
  test("REG-FE-PRTPL-052 medicines with quantity, batch and expiry; an allergy-blocked line says so and is not given a quantity", () => {
    const r = render(dispense(), ctx());
    for (const part of ["Dispensing slip", "R-1042", "Abebe Kebede (P000033)", "Dr Yonas", "Amoxicillin 500 mg 1 cap, 3 times a day",
      "21", "AMX-22 Expiry 2027-08", "patient allergic to penicillin", "Allergies: Penicillin", "Counselling Finish the course", "Selam"]) {
      expect(r.text).toContain(part);
    }
    expect(render(dispense(), ctx()).paper).toBe("slip80");
  });

  test("REG-FE-PRTPL-053 the quantity and batch columns appear only when the caller knows them; never a guessed value", () => {
    const bare = render(dispense({ items: [{ drug: "Ibuprofen", sig: "1 tab" }] }), ctx());
    expect(bare.text).not.toContain("Qty");
    expect(bare.text).not.toContain("Batch");
    expect(bare.text).not.toContain("—");
    expect(render(dispense({ pending: true }), ctx()).text).toContain("not yet handed over");
    const off = render(dispense(), ctx({ docs: { dispense: { show: { batch: false, allergies: false, counselling: false } } } })).text;
    expect(off).not.toContain("AMX-22");
    expect(off).not.toContain("Allergies:");
    expect(off).not.toContain("Counselling");
  });

  test("REG-FE-PRTPL-054 a slip printed before hand-over is a different paper from the final one in the print log", () => {
    expect(refOf(dispense())).toBe("R-1042");
    expect(refOf(dispense({ pending: true }))).toBe("R-1042-pending");
  });
});

describe("REG-FE-PRTPL every document renders on every template and paper without a hole", () => {
  test("REG-FE-PRTPL-055 no 'undefined' or '[object Object]' on any template of any paper", () => {
    const docs: DocData[] = [statement(), zreport(), labreport(), dispense()];
    for (const d of docs) {
      const info = docInfo(d.doc)!;
      for (const t of info.templates) {
        for (const paper of t.papers) {
          const r = render(d, ctx(DEFAULT_SETTINGS), { template: t.id, paper });
          expect(r.page, `${d.doc}/${t.id}/${paper}`).not.toContain("undefined");
          expect(r.page, `${d.doc}/${t.id}/${paper}`).not.toContain("[object Object]");
          expect(r.paper).toBe(paper);
        }
      }
    }
  });
});

describe("REG-FE-PRTPL the paper as drawn on a screen", () => {
  test("REG-FE-PRTPL-060 the preview draws the paper's real margins on both sides; the printed page is left to the printer", () => {
    const slip = render(receipt(), ctx({ docs: { receipt: { template: "slip", paper: "slip80" } } }));
    const shown = previewHtml(slip.page, "slip80");
    // 80 mm paper with 4 mm margins: the text starts 4 mm in, not at the edge.
    expect(shown).toContain("body{margin:0;padding:4mm;width:80mm}");
    const a4 = previewHtml(render(rx(), ctx()).page, "a4");
    expect(a4).toContain("body{margin:0;padding:14mm;width:210mm}");
    // What goes to the printer carries no such padding: the printer applies @page.
    expect(slip.page).not.toContain("padding:4mm;width:80mm");
    expect(slip.page).toContain("@page{size:80mm auto;margin:4mm}");
  });

  test("REG-FE-PRTPL-061 the logo is centred on a till slip when the clinic centres it, and sits at the side on a sheet", () => {
    const logo = "data:image/png;base64,AAAA";
    const slip = render(receipt(), ctx({ look: { logoPosition: "center" }, docs: { receipt: { template: "slip" } } }, { logo }));
    expect(slip.html).toContain('class="logo" style="width:fit-content;margin:0 auto 4px"');
    const sheet = render(receipt(), ctx({ docs: { receipt: { template: "sheet" } } }, { logo }));
    expect(sheet.html).toContain('<div class="logo">');
  });
});

describe("REG-FE-PRTPL the logo's position, size and shape are obeyed on every paper", () => {
  const logo = "data:image/png;base64,AAAA";
  const header = (look: Record<string, unknown>, template: string) =>
    render(receipt(), ctx({ look, docs: { receipt: { template } } }, { logo })).html.split("</header>")[0];

  test("REG-FE-PRTPL-062 on a till slip: centre stacks the logo above the name, left and right put it beside it, none drops it", () => {
    const centre = header({ logoPosition: "center" }, "slip");
    expect(centre).toContain("slip-hd");
    expect(centre.indexOf('class="logo"')).toBeLessThan(centre.indexOf('class="ident"'));
    const left = header({ logoPosition: "left" }, "slip");
    expect(left).toContain("hd-row slip-row");
    expect(left.indexOf('class="logo"')).toBeLessThan(left.indexOf('class="ident"'));
    const right = header({ logoPosition: "right" }, "slip");
    expect(right).toContain("hd-row slip-row");
    expect(right.indexOf('class="ident"')).toBeLessThan(right.indexOf('class="logo"'));
    expect(header({ logoPosition: "none" }, "slip")).not.toContain("<img");
  });

  test("REG-FE-PRTPL-063 on a sheet: the same choices, in the same order", () => {
    const left = header({ logoPosition: "left" }, "sheet");
    expect(left.indexOf('class="logo"')).toBeLessThan(left.indexOf('class="ident"'));
    const right = header({ logoPosition: "right" }, "sheet");
    expect(right.indexOf('class="ident"')).toBeLessThan(right.indexOf('class="logo"'));
    expect(header({ logoPosition: "center" }, "sheet")).toContain("hd-col");
  });

  test("REG-FE-PRTPL-064 the shape crops the picture (rounded, circle) or shows it whole (square); the size is in pixels", () => {
    expect(header({ logoShape: "circle", logoSize: "small" }, "sheet")).toContain("width:40px;height:40px;object-fit:cover;border-radius:50%");
    expect(header({ logoShape: "rounded", logoSize: "medium" }, "sheet")).toContain("width:56px;height:56px;object-fit:cover;border-radius:10px");
    expect(header({ logoShape: "square", logoSize: "large" }, "sheet")).toContain("width:84px;height:84px;object-fit:contain;border-radius:0");
  });
});

describe("REG-FE-PRTPL the signer's name can be left off, for one paper or for all", () => {
  const sigNames = (html: string) => [...html.matchAll(/class="sig-who">([^<]*)</g)].map((m) => m[1]);
  const labrequest = (): DocData => ({
    doc: "labrequest",
    data: { clinic: "", ref: "L1", qrData: "", patient: "P", prescriber: "Dr Yonas", when: "2026-10-03", tests: ["CBC"] },
  } as DocData);
  const cert = (): DocData => ({
    doc: "certificate",
    data: { clinic: "", ref: "MC-1", kind: "sick_leave", patient: "Abebe", showDiagnosis: false, restDays: 2, issuedOn: "2026-10-01", issuedBy: "Dr Yonas", status: "active" },
  } as DocData);
  const exam = (): DocData => ({
    doc: "exam",
    data: { patient: "Abebe", visitDate: "2026-10-01", recordedBy: "Dr Yonas", extraoral: [], intraoral: [], investigations: [], treatmentGiven: [], procedures: [], chiefComplaint: "Pain" },
  } as DocData);
  const all: [string, () => DocData][] = [
    ["prescription", () => rx()], ["labrequest", labrequest], ["certificate", cert], ["exam", exam],
    ["labreport", () => labreport()], ["dispense", () => dispense()], ["zreport", () => zreport()],
  ];

  test("REG-FE-PRTPL-070 by default every signed paper prints the signer's name under its line", () => {
    for (const [name, make] of all) {
      expect(sigNames(render(make(), ctx()).html), name).toHaveLength(1);
    }
  });

  test("REG-FE-PRTPL-071 one switch for every paper leaves the line blank for whoever signs", () => {
    for (const [name, make] of all) {
      const r = render(make(), ctx({ signature: { showName: false } }));
      expect(sigNames(r.html), name).toHaveLength(0);
      expect(r.html, name).toContain("sig-line");
    }
  });

  test("REG-FE-PRTPL-072 shared account: the doctor's name goes from the details at the top as well, on every paper that shows it", () => {
    const on = render(rx(), ctx()).text;
    expect(on).toContain("Prescriber Dr Yonas");
    const off = render(rx(), ctx({ signature: { showName: false } })).text;
    expect(off).not.toContain("Dr Yonas");
    expect(render(labrequest(), ctx({ signature: { showName: false } })).text).not.toContain("Dr Yonas");
    expect(render(exam(), ctx()).text).toContain("Examined by Dr Yonas");
    expect(render(exam(), ctx({ signature: { showName: false } })).text).not.toContain("Dr Yonas");
    // The lab report names the ordering doctor at the top and the validator in its trail.
    expect(render(labreport(), ctx()).text).toContain("Ordered by Dr Yonas");
    const lab = render(labreport(), ctx({ signature: { showName: false } })).text;
    expect(lab).not.toContain("Dr Yonas");
    expect(lab).not.toContain("Dr Meron");
    // The dispensing slip names the prescriber.
    expect(render(dispense(), ctx()).text).toContain("Prescriber Dr Yonas");
    expect(render(dispense(), ctx({ signature: { showName: false } })).text).not.toContain("Dr Yonas");
  });

  test("REG-FE-PRTPL-075 the one switch on one paper hides every doctor's name on that paper, and only that paper", () => {
    const show = { docs: { labreport: { show: { signerName: false } } } };
    const lab = render(labreport(), ctx(show)).text;
    expect(lab).not.toContain("Dr Yonas");
    expect(lab).not.toContain("Dr Meron");
    const p = render(rx(), ctx(show));
    expect(p.text).toContain("Prescriber Dr Yonas");
    const off = render(rx(), ctx({ docs: { prescription: { show: { signerName: false } } } }));
    expect(off.text).not.toContain("Dr Yonas");
    expect(sigNames(off.html)).toHaveLength(0);
    // The Z-report's cashier row is accountability, not a doctor's name: only the line goes.
    const z = render(zreport(), ctx({ docs: { zreport: { show: { signerName: false } } } }));
    expect(z.text).toContain("Cashier Hana");
    expect(sigNames(z.html)).toHaveLength(0);
  });

  test("REG-FE-PRTPL-073 a paper can override the one switch, either way", () => {
    const offHere = render(rx(), ctx({ docs: { prescription: { show: { signerName: false } } } }));
    expect(sigNames(offHere.html)).toHaveLength(0);
    expect(offHere.text).not.toContain("Prescriber");
    const onHere = render(rx(), ctx({ signature: { showName: false }, docs: { prescription: { show: { signerName: true } } } }));
    expect(sigNames(onHere.html)).toEqual(["Dr Yonas"]);
    expect(onHere.text).toContain("Prescriber Dr Yonas");
    // Another paper still follows the one switch.
    expect(sigNames(render(cert(), ctx({ signature: { showName: false }, docs: { prescription: { show: { signerName: true } } } })).html)).toHaveLength(0);
  });

  test("REG-FE-PRTPL-074 the statement and the receipt never carried a name under a line, so nothing changes there", () => {
    expect(sigNames(render(statement(), ctx({ docs: { statement: { show: { signature: true } } } })).html)).toHaveLength(0);
    expect(docInfo("statement")?.toggles.some((t) => t.id === "signerName")).toBe(false);
    expect(docInfo("receipt")?.toggles.some((t) => t.id === "signerName")).toBe(false);
  });
});
