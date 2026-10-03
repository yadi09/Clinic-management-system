// Printing a prescription (and an outside-lab request): a new window gets one
// self-contained HTML page with an inline QR. The window is faked and the test
// reads the HTML it was given — the clinic header, the patient line, each drug's
// dose · frequency · duration, the allergies a pharmacist must see, and every
// value escaped so a drug or patient name cannot inject markup into the print.
import { afterEach, beforeEach, describe, expect, test, vi, type MockInstance } from "vitest";

import QRCode from "qrcode";
import { printLabRequest, printPrescription, type LabRequestDoc, type PrescriptionDoc } from "@/features/clinical/print";

let written = "";
let fakeWin: { document: { write: ReturnType<typeof vi.fn>; close: ReturnType<typeof vi.fn> } };
let openSpy: MockInstance<typeof window.open>;

beforeEach(() => {
  written = "";
  fakeWin = { document: { write: vi.fn((s: string) => { written += s; }), close: vi.fn() } };
  openSpy = vi.spyOn(window, "open").mockReturnValue(fakeWin as unknown as Window);
});
afterEach(() => vi.restoreAllMocks());

function rx(over: Partial<PrescriptionDoc> = {}): PrescriptionDoc {
  return {
    clinic: "Cure Dental", rxRef: "RX-7F3A", qrData: "rx:enc_1", patient: "Abebe Kebede",
    when: "2026-08-12T09:00:00Z", diagnoses: [], meds: [], ...over,
  };
}

describe("REG-FE-RX printing a prescription", () => {
  test("REG-FE-RX-001 opens one window, writes one page with a QR, closes it, and prints on load", async () => {
    await printPrescription(rx({ meds: [{ drug_name: "Amoxicillin 500mg" }] }));
    expect(openSpy).toHaveBeenCalledWith("", "_blank", "width=760,height=1000");
    expect(fakeWin.document.write).toHaveBeenCalledTimes(1);
    expect(fakeWin.document.close).toHaveBeenCalledTimes(1);
    expect(written).toMatch(/^<!doctype html>/);
    expect(written).toContain("<title>Prescription · Abebe Kebede</title>");
    expect(written).toContain("window.onload=function(){window.print();}");
    expect(written).toMatch(/<div class="qr">\s*<svg/);
    expect(written).toContain('<div class="ref">RX-7F3A</div>');
    expect(written).toContain("Issued by Cure Dental · RX-7F3A");
  });

  test("REG-FE-RX-002 the clinic header and patient line: contact, MRN, age+sex, weight, prescriber, date", async () => {
    await printPrescription(rx({
      clinicContact: "Bole Rd · 0911 000 000", mrn: "CD-0042", age: 34, gender: "male", weightKg: "72",
      prescriber: "Dr Hana",
    }));
    expect(written).toContain("<h1>Cure Dental</h1>");
    expect(written).toContain('<div class="contact">Bole Rd · 0911 000 000</div>');
    expect(written).toContain('<div class="pname">Abebe Kebede</div>');
    expect(written).toContain('<div class="pmeta">MRN CD-0042&nbsp;&nbsp;·&nbsp;&nbsp;34M&nbsp;&nbsp;·&nbsp;&nbsp;72 kg</div>');
    expect(written).toContain('<span class="k">Prescriber</span> Dr Hana');
    expect(written).toContain('<div class="who">Dr Hana</div>');
    expect(written).toContain(new Date("2026-08-12T09:00:00Z").toLocaleDateString());
  });

  test("REG-FE-RX-003 nothing optional given: no contact, no patient line, no prescriber; signature says 'Prescriber'", async () => {
    await printPrescription(rx());
    expect(written).not.toContain('class="contact"');
    expect(written).not.toContain('class="pmeta"');
    expect(written).not.toContain('<span class="k">Prescriber</span>');
    expect(written).toContain('<div class="who">Prescriber</div>');
    expect(written).toContain('<li class="muted">No medication prescribed.</li>');
    expect(written).not.toContain("Diagnosis");
    expect(written).not.toContain("Allergies");
    expect(written).not.toContain('<span class="k">Note</span>');
  });

  test("REG-FE-RX-004 age 0 still prints; age without gender prints the number alone", async () => {
    await printPrescription(rx({ age: 0 }));
    expect(written).toContain('<div class="pmeta">0</div>');
  });

  test("REG-FE-RX-005 each drug numbered, with dose · frequency · duration and the instructions", async () => {
    await printPrescription(rx({
      meds: [
        { drug_name: "Amoxicillin 500mg", dose: "1 cap", frequency: "TID", duration: "7 days", instructions: "After food" },
        { drug_name: "Ibuprofen 400mg", frequency: "PRN" },
        { drug_name: "Chlorhexidine rinse" },
      ],
    }));
    expect(written).toMatch(/<span class="n">1<\/span>Amoxicillin 500mg/);
    expect(written).toContain('<div class="detail">1 cap · TID · 7 days</div>');
    expect(written).toContain('<div class="instr">After food</div>');
    expect(written).toMatch(/<span class="n">2<\/span>Ibuprofen 400mg/);
    expect(written).toContain('<div class="detail">PRN</div>');
    expect(written).toMatch(/<span class="n">3<\/span>Chlorhexidine rinse<\/div>\s*\n\s*\n\s*<\/li>/);
    expect(written.match(/class="detail"/g)).toHaveLength(2);
    expect(written.match(/class="instr"/g)).toHaveLength(1);
    expect(written).not.toContain("No medication prescribed.");
  });

  test("REG-FE-RX-006 diagnoses join code and description; the note prints", async () => {
    await printPrescription(rx({
      diagnoses: [{ code: "K04.7", description: "Periapical abscess" }, { description: "Dental caries" }],
      note: "Review in 1 week",
    }));
    expect(written).toContain('<span class="k">Diagnosis</span> K04.7 Periapical abscess, Dental caries');
    expect(written).toContain('<span class="k">Note</span> Review in 1 week');
  });

  test("REG-FE-RX-007 known allergies are printed in bold so the outside pharmacist sees them", async () => {
    await printPrescription(rx({ allergies: ["Penicillin", "Sulfa"] }));
    expect(written).toContain('<span class="k">Allergies</span> <b>Penicillin, Sulfa</b>');
    written = "";
    await printPrescription(rx({ allergies: [] }));
    expect(written).not.toContain("Allergies");
  });

  test("REG-FE-RX-008 markup in a drug, patient, clinic, note or allergy is escaped, never injected", async () => {
    const evil = '<img src=x onerror="alert(1)">';
    await printPrescription(rx({
      clinic: `Cure ${evil}`, clinicContact: evil, patient: `Abebe ${evil}`, mrn: evil, gender: "<b>", weightKg: evil,
      prescriber: evil, rxRef: evil, note: evil, allergies: [evil],
      diagnoses: [{ code: "<script>", description: evil }],
      meds: [{ drug_name: `Amox ${evil}`, dose: evil, frequency: "&", duration: ">", instructions: evil }],
    }));
    expect(written).not.toContain("<img");
    expect(written).not.toMatch(/<script>(?!window\.onload)/);
    expect(written).toContain("Abebe &lt;img src=x onerror=\"alert(1)\"&gt;");
    expect(written).toContain("Amox &lt;img");
    expect(written).toContain("<title>Prescription · Abebe &lt;img");
    expect(written).toContain("&lt;script&gt;");
    expect(written).toContain(" · &amp; · &gt;");
    // The single real script tag is the print trigger.
    expect(written.match(/<script>/g)).toHaveLength(1);
  });

  test("REG-FE-RX-009 a blocked pop-up does nothing and does not throw", async () => {
    openSpy.mockReturnValue(null);
    await expect(printPrescription(rx({ meds: [{ drug_name: "X" }] }))).resolves.toBeUndefined();
    expect(fakeWin.document.write).not.toHaveBeenCalled();
  });

  test("REG-FE-RX-010 a QR that cannot be generated still prints the prescription, without the code", async () => {
    vi.spyOn(QRCode, "toString").mockRejectedValue(new Error("too long") as never);
    await printPrescription(rx({ meds: [{ drug_name: "Amoxicillin" }] }));
    expect(written).not.toContain("<svg");
    expect(written).toContain('<div class="ref">RX-7F3A</div>');
    expect(written).toContain("Amoxicillin");
  });
});

function lab(over: Partial<LabRequestDoc> = {}): LabRequestDoc {
  return { clinic: "Cure Dental", ref: "LAB-1", qrData: "lab:1", patient: "Abebe Kebede", when: "2026-08-12T09:00:00Z", tests: [], ...over };
}

describe("REG-FE-RX printing an outside-lab request", () => {
  test("REG-FE-RX-011 the full request: header, patient line, requester, indication, numbered tests", async () => {
    await printLabRequest(lab({
      clinicContact: "Bole Rd", mrn: "CD-1", age: 40, gender: "female", prescriber: "Dr Hana",
      indication: "Pre-extraction work-up", tests: ["CBC", "  ", "Blood glucose"],
    }));
    expect(openSpy).toHaveBeenCalledWith("", "_blank", "width=760,height=940");
    expect(written).toContain("<title>Lab request · Abebe Kebede</title>");
    expect(written).toContain('<div class="contact">Bole Rd</div>');
    expect(written).toContain('<div class="pmeta">MRN CD-1&nbsp;&nbsp;·&nbsp;&nbsp;40F</div>');
    expect(written).toContain('<span class="k">Requested by</span> Dr Hana');
    expect(written).toContain('<span class="k">Clinical indication</span> Pre-extraction work-up');
    expect(written).toContain('<li><span class="n">1</span>CBC</li><li><span class="n">2</span>Blood glucose</li>');
    expect(written).toContain("<svg");
    expect(fakeWin.document.close).toHaveBeenCalledTimes(1);
  });

  test("REG-FE-RX-012 nothing optional and no tests: placeholder line, generic signature, no blanks", async () => {
    await printLabRequest(lab({ age: 5 }));
    expect(written).toContain('<li class="muted">No tests listed.</li>');
    expect(written).toContain('<div class="who">Requesting clinician</div>');
    expect(written).toContain('<div class="pmeta">5</div>');
    expect(written).not.toContain('class="contact"');
    expect(written).not.toContain("Requested by");
    expect(written).not.toContain("Clinical indication");
  });

  test("REG-FE-RX-013 lab request: markup escaped, blocked pop-up and failed QR handled", async () => {
    vi.spyOn(QRCode, "toString").mockRejectedValue(new Error("x") as never);
    await printLabRequest(lab({ patient: "<img onerror=x>", tests: ["<b>CBC</b>"] }));
    expect(written).not.toContain("<img");
    expect(written).toContain("&lt;b&gt;CBC&lt;/b&gt;");
    expect(written).not.toContain("<svg");
    written = "";
    openSpy.mockReturnValue(null);
    await expect(printLabRequest(lab())).resolves.toBeUndefined();
    expect(written).toBe("");
  });

  test("REG-FE-RX-014 a lab request with no patient line omits it", async () => {
    await printLabRequest(lab());
    expect(written).not.toContain('class="pmeta"');
  });
});
