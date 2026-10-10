// Printing a prescription (and an outside-lab request). The paper is drawn by the
// shared print engine from the clinic's own settings; the test reads the page that
// arrives at the printer — the clinic header, the patient line, each drug's dose ·
// frequency · duration, the allergies a pharmacist must see, and every value escaped
// so a drug or patient name cannot inject markup into the print.
import { beforeEach, describe, expect, test, vi } from "vitest";

import { printLabRequest, printPrescription, type LabRequestDoc, type PrescriptionDoc } from "@/features/clinical/print";
import { setPrintContext } from "@/features/printing/context";
import { transport } from "@/features/printing/engine";
import { DEFAULT_SETTINGS, resolveSettings } from "@/features/printing/settings";

vi.mock("@/features/printing/api", () => ({
  peekPrint: vi.fn(async () => ({ count: 0 })), logPrint: vi.fn(async () => ({ count: 1 })),
  getPrintSettings: vi.fn(), savePrintSettings: vi.fn(),
}));

const sent: string[] = [];
beforeEach(() => {
  sent.length = 0;
  vi.spyOn(transport, "send").mockImplementation((html: string) => { sent.push(html); });
  setPrintContext({ settings: DEFAULT_SETTINGS, logo: "", clinicName: "", branch: null });
});

const page = () => sent[sent.length - 1] ?? "";
const textOf = (html: string) => {
  const doc = new DOMParser().parseFromString(html, "text/html");
  doc.querySelectorAll("script,style").forEach((n) => n.remove());
  const walker = doc.createTreeWalker(doc.body, NodeFilter.SHOW_TEXT);
  const parts: string[] = [];
  for (let n = walker.nextNode(); n; n = walker.nextNode()) parts.push(n.textContent ?? "");
  return parts.join(" ").replace(/\s+/g, " ").trim();
};
const text = () => textOf(page());
const done = async () => { await vi.waitFor(() => expect(sent.length).toBeGreaterThan(0)); };

function rx(over: Partial<PrescriptionDoc> = {}): PrescriptionDoc {
  return {
    clinic: "Cure Dental", rxRef: "RX-7F3A", qrData: "rx:enc_1", patient: "Abebe Kebede",
    when: "2026-08-12T09:00:00+03:00", diagnoses: [], meds: [], ...over,
  };
}

describe("REG-FE-RX printing a prescription", () => {
  test("REG-FE-RX-001 one page, with the clinic's name, a QR and the reference, sent to the printer once", async () => {
    await printPrescription(rx({ meds: [{ drug_name: "Amoxicillin 500mg" }] }));
    await done();
    expect(sent).toHaveLength(1);
    expect(page()).toMatch(/^<!doctype html>/);
    expect(page()).toContain("<title>Prescription · Abebe Kebede</title>");
    expect(page()).toMatch(/<div class="qr"><svg/);
    expect(page()).toContain('<div class="ref">RX-7F3A</div>');
    expect(text()).toContain("Cure Dental");
    expect(text()).toContain("RX-7F3A");
  });

  test("REG-FE-RX-002 the patient line and the prescriber: card number, age and sex, weight, date, licence", async () => {
    await printPrescription(rx({
      clinicContact: "Bole Rd · 0911 000 000", mrn: "CD-0042", age: 34, gender: "male", weightKg: "72",
      prescriber: "Dr Hana", prescriberLicense: "L-77",
    }));
    await done();
    const t = text();
    expect(t).toContain("Bole Rd · 0911 000 000");
    expect(t).toContain("Abebe Kebede");
    expect(t).toContain("Card no. CD-0042");
    expect(t).toContain("34M");
    expect(t).toContain("72 kg");
    expect(t).toContain("Dr Hana");
    expect(t).toContain("Licence no. L-77");
    expect(t).toContain("12 Aug 2026");
  });

  test("REG-FE-RX-003 nothing optional given: no contact, no patient line, no prescriber", async () => {
    await printPrescription(rx());
    await done();
    expect(page()).not.toContain('class="pmeta"');
    expect(page()).not.toContain("Prescriber</span>");
    expect(text()).not.toContain("undefined");
  });

  test("REG-FE-RX-004 age 0 still prints; age without a sex prints the number alone", async () => {
    await printPrescription(rx({ age: 0 }));
    await done();
    expect(page()).toContain('<div class="pmeta">0</div>');
  });

  test("REG-FE-RX-005 each drug is numbered, with dose · frequency · duration and the instructions", async () => {
    await printPrescription(rx({
      meds: [
        { drug_name: "Amoxicillin 500mg", dose: "1 cap", frequency: "3x daily", duration: "7 days", instructions: "After food" },
        { drug_name: "Ibuprofen" },
      ],
    }));
    await done();
    expect(page()).toMatch(/<span class="num">1<\/span>Amoxicillin 500mg/);
    expect(page()).toContain('<div class="det">1 cap · 3x daily · 7 days</div>');
    expect(page()).toContain('<div class="ins">After food</div>');
    expect(page()).toMatch(/<span class="num">2<\/span>Ibuprofen/);
  });

  test("REG-FE-RX-006 diagnoses join code and description; a treatment context stands in when there is none; the note prints", async () => {
    await printPrescription(rx({ diagnoses: [{ code: "K04.0", description: "Pulpitis" }, { description: "Caries" }], note: "Review in 1 week" }));
    await done();
    expect(text()).toContain("Diagnosis K04.0 Pulpitis, Caries");
    expect(text()).toContain("Note Review in 1 week");
    sent.length = 0;
    await printPrescription(rx({ diagnoses: [], context: "Root canal (36)" }));
    await vi.waitFor(() => expect(sent.length).toBe(1));
    expect(text()).toContain("Treatment Root canal (36)");
    expect(text()).not.toContain("Diagnosis");
  });

  test("REG-FE-RX-007 known allergies are printed in bold so the outside pharmacist sees them", async () => {
    await printPrescription(rx({ allergies: ["Penicillin", "Sulfa"] }));
    await done();
    expect(page()).toContain("<b>Penicillin, Sulfa</b>");
  });

  test("REG-FE-RX-008 markup in a drug, patient, clinic, note or allergy is escaped, never injected", async () => {
    await printPrescription(rx({
      clinic: "A&B <Clinic>", patient: 'Abebe <img src=x onerror="alert(1)">', note: "<script>1</script>",
      allergies: ["<b>x</b>"], meds: [{ drug_name: "<i>Drug</i>", instructions: "<u>u</u>" }],
    }));
    await done();
    expect(page()).not.toContain("<img src=x");
    expect(page()).not.toContain("<script>1");
    expect(page()).toContain("A&amp;B &lt;Clinic&gt;");
    expect(page()).toContain("&lt;i&gt;Drug&lt;/i&gt;");
    expect(page()).toContain("&lt;b&gt;x&lt;/b&gt;");
  });

  test("REG-FE-RX-009 the clinic's own settings win: its name, logo, tax number and what is shown", async () => {
    setPrintContext({
      settings: resolveSettings({
        identity: { nameEn: "Abeba Dental Clinic", nameAm: "አበባ የጥርስ ክሊኒክ", phones: ["0911 00 00 00"], tin: "0012345678" },
        docs: { prescription: { show: { diagnosis: false, qr: false } } },
      }),
      logo: "data:image/png;base64,AAAA", clinicName: "Registered Name Ltd", branch: null,
    });
    await printPrescription(rx({ diagnoses: [{ description: "Pulpitis" }] }));
    await done();
    const t = text();
    expect(t).toContain("Abeba Dental Clinic");
    expect(t).toContain("አበባ የጥርስ ክሊኒክ");
    expect(t).toContain("TIN 0012345678");
    expect(t).not.toContain("Registered Name Ltd");
    expect(t).not.toContain("Pulpitis");
    expect(page()).toContain('<img src="data:image/png;base64,AAAA"');
    expect(page()).not.toContain('class="qr"');
  });

  test("REG-FE-RX-010 a QR that cannot be generated still prints the prescription, without the code", async () => {
    vi.resetModules();
    const QR = await import("qrcode");
    vi.spyOn(QR.default, "toString").mockRejectedValueOnce(new Error("no qr"));
    await printPrescription(rx({ meds: [{ drug_name: "Amoxicillin" }] }));
    await done();
    expect(page()).not.toContain("<svg");
    expect(text()).toContain("Amoxicillin");
  });
});

function lab(over: Partial<LabRequestDoc> = {}): LabRequestDoc {
  return {
    clinic: "Cure Dental", ref: "LAB-1", qrData: "lab:1", patient: "Abebe Kebede", when: "2026-08-12T09:00:00+03:00",
    tests: ["CBC", "FBS"], ...over,
  };
}

describe("REG-FE-RX printing an outside-lab request", () => {
  test("REG-FE-RX-011 the full request: header, patient line, requester, indication, numbered tests", async () => {
    await printLabRequest(lab({
      clinicContact: "Bole · 0911", mrn: "M1", age: 30, gender: "female", prescriber: "Dr Hana", indication: "Fever 3 days",
    }));
    await done();
    const t = text();
    expect(t).toContain("Laboratory request");
    expect(t).toContain("Bole · 0911");
    expect(t).toContain("Card no. M1");
    expect(t).toContain("30F");
    expect(t).toContain("Requested by Dr Hana");
    expect(t).toContain("Clinical indication Fever 3 days");
    expect(page()).toMatch(/<span class="num">1<\/span>CBC/);
    expect(page()).toMatch(/<span class="num">2<\/span>FBS/);
  });

  test("REG-FE-RX-012 nothing optional and no tests: a placeholder line, no blanks", async () => {
    await printLabRequest(lab({ tests: [] }));
    await done();
    expect(page()).toContain('<li class="muted">—</li>');
    expect(text()).not.toContain("Clinical indication");
    expect(text()).not.toContain("undefined");
  });

  test("REG-FE-RX-013 lab request: markup escaped", async () => {
    await printLabRequest(lab({ tests: ["<b>CBC</b>"], indication: "<i>x</i>", patient: "<img src=x>" }));
    await done();
    expect(page()).toContain("&lt;b&gt;CBC&lt;/b&gt;");
    expect(page()).not.toContain("<img src=x>");
  });
});
