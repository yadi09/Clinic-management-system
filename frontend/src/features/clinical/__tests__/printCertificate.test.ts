// Printing a medical certificate (the dental workspace's Certificates tab and the
// patient profile both call this). The window is faked and the test reads the HTML
// it was given: the clinic and branch header, the reference and its QR, the title
// and sentence for each kind, the patient block, Gregorian + Ethiopian dates, the
// rest period, the diagnosis only when ticked, the VOID watermark — and every
// value a person typed escaped, so a name cannot inject markup into the print.
import { afterEach, beforeEach, describe, expect, test, vi, type MockInstance } from "vitest";

import QRCode from "qrcode";
import { printCertificate, type CertificatePrint } from "@/features/clinical/printCertificate";

let written = "";
let fakeWin: { document: { write: ReturnType<typeof vi.fn>; close: ReturnType<typeof vi.fn> } };
let openSpy: MockInstance<typeof window.open>;

beforeEach(() => {
  written = "";
  fakeWin = { document: { write: vi.fn((s: string) => { written += s; }), close: vi.fn() } };
  openSpy = vi.spyOn(window, "open").mockReturnValue(fakeWin as unknown as Window);
});
afterEach(() => vi.restoreAllMocks());

function mc(over: Partial<CertificatePrint> = {}): CertificatePrint {
  return {
    clinic: "Cure Dental", ref: "MC-2026-0041", kind: "sick_leave", patient: "Abebe Kebede",
    showDiagnosis: false, restDays: 3, issuedOn: "2026-10-01", status: "active", ...over,
  };
}
/** The certifying sentence, whitespace collapsed. */
const stmt = () => (written.match(/<p class="stmt">([\s\S]*?)<\/p>/)?.[1] ?? "").replace(/\s+/g, " ").trim();

describe("REG-FE-CERTPRINT printing a medical certificate", () => {
  test("REG-FE-CERTPRINT-001 one window, one page with a QR, closed, printing on load", async () => {
    await printCertificate(mc());
    expect(openSpy).toHaveBeenCalledWith("", "_blank", "width=820,height=1000");
    expect(fakeWin.document.write).toHaveBeenCalledTimes(1);
    expect(fakeWin.document.close).toHaveBeenCalledTimes(1);
    expect(written).toMatch(/^<!doctype html>/);
    expect(written).toContain("<title>Medical Certificate — Abebe Kebede — MC-2026-0041</title>");
    expect(written).toContain("window.onload=function(){window.print();}");
    expect(written).toMatch(/<div class="qr"><svg/);
    expect(written).toContain('<div class="ref">MC-2026-0041</div>');
    expect(written).toMatch(/Issued by Cure Dental and recorded under reference MC-2026-0041\./);
  });

  test("REG-FE-CERTPRINT-002 the QR carries ref, clinic, patient + MRN and the issue date", async () => {
    const spy = vi.spyOn(QRCode, "toString");
    await printCertificate(mc({ mrn: "CD-1" }));
    expect(spy.mock.calls[0][0]).toBe("MC:MC-2026-0041\nCure Dental\nAbebe Kebede CD-1\n2026-10-01");
    expect(spy.mock.calls[0][1]).toMatchObject({ type: "svg", margin: 0, width: 96 });
    spy.mockClear();
    await printCertificate(mc());
    expect(spy.mock.calls[0][0]).toBe("MC:MC-2026-0041\nCure Dental\nAbebe Kebede\n2026-10-01");
  });

  test("REG-FE-CERTPRINT-003 the clinic header: name, contact line and branch", async () => {
    await printCertificate(mc({ clinicContact: "Bole Rd · 0911", branch: "Bole" }));
    expect(written).toContain("<h1>Cure Dental</h1>");
    expect(written).toContain('<div class="contact">Bole Rd · 0911</div>');
    expect(written).toContain('<div class="contact">Bole</div>');
  });

  test("REG-FE-CERTPRINT-004 the patient block: name, MRN, age in years, sex", async () => {
    await printCertificate(mc({ mrn: "CD-1", age: "34", gender: "male", issuedBy: "Dr Hana" }));
    expect(written).toContain("<td><b>Abebe Kebede</b></td>");
    expect(written).toContain("<td>CD-1</td>");
    expect(written).toContain("<td>34 years</td>");
    expect(written).toContain('<td class="cap">male</td>');
    expect(written).toContain('<div class="who">Dr Hana</div>');
  });

  test("REG-FE-CERTPRINT-005 nothing optional: dashes for MRN/age/sex, no contact, no branch, blank signer", async () => {
    await printCertificate(mc());
    expect(written).not.toContain('class="contact"');
    expect(written).toMatch(/MRN<\/td><td>—<\/td>/);
    expect(written).toMatch(/Age<\/td><td>—<\/td>/);
    expect(written).toContain('<td class="cap">—</td>');
    expect(written).toContain('<div class="who"></div>');
    expect(written).not.toContain('class="period"');
    expect(written).not.toContain('class="dx"');
    expect(written).not.toContain('class="notes"');
    expect(written).not.toContain('class="void"');
    expect(written).not.toContain('class="voidnote"');
  });

  test("REG-FE-CERTPRINT-006 sick leave: the title and 'unfit … rest for N days', singular for one day", async () => {
    await printCertificate(mc());
    expect(written).toContain("<h2>Medical Certificate</h2>");
    expect(stmt()).toBe("This is to certify that <b>Abebe Kebede</b> attended this clinic and was examined on 2026-10-01. In my professional opinion the patient is <b>unfit for work or study</b> and requires rest for <b>3 days</b>.");
    written = "";
    await printCertificate(mc({ restDays: 1 }));
    expect(stmt()).toContain("<b>1 day</b>.");
  });

  test("REG-FE-CERTPRINT-007 fitness: its own title and 'fit to resume normal duties'", async () => {
    await printCertificate(mc({ kind: "fitness", restDays: undefined }));
    expect(written).toContain("<h2>Certificate of Fitness</h2>");
    expect(written).toContain("<title>Certificate of Fitness — ");
    expect(stmt()).toBe("This is to certify that <b>Abebe Kebede</b> was examined at this clinic on 2026-10-01 and is, in my professional opinion, <b>fit to resume normal duties</b>.");
    expect(written).not.toContain("unfit");
  });

  test("REG-FE-CERTPRINT-008 attendance: its own title and 'attended this clinic … received medical attention'", async () => {
    await printCertificate(mc({ kind: "attendance", restDays: undefined }));
    expect(written).toContain("<h2>Certificate of Attendance</h2>");
    expect(stmt()).toBe("This is to certify that <b>Abebe Kebede</b> <b>attended this clinic</b> on 2026-10-01 and received medical attention.");
  });

  test("REG-FE-CERTPRINT-009 the Ethiopian date sits beside the Gregorian one, in the sentence and the signature, for every kind", async () => {
    for (const kind of ["sick_leave", "fitness", "attendance"] as const) {
      written = "";
      await printCertificate(mc({ kind, issuedOnEc: "21 Meskerem 2019" }));
      expect(stmt()).toContain("2026-10-01 (21 Meskerem 2019)");
      expect(written).toContain('<div class="on">Issued 2026-10-01 · 21 Meskerem 2019</div>');
    }
    written = "";
    await printCertificate(mc());
    expect(written).toContain('<div class="on">Issued 2026-10-01</div>');
  });

  test("REG-FE-CERTPRINT-010 the rest period: From / To with Ethiopian dates and the inclusive day count", async () => {
    await printCertificate(mc({ restFrom: "2026-10-01", restFromEc: "21 Meskerem 2019", restTo: "2026-10-03", restToEc: "23 Meskerem 2019" }));
    expect(written).toContain("<b>2026-10-01</b> · 21 Meskerem 2019");
    expect(written).toContain("<b>2026-10-03</b> · 23 Meskerem 2019");
    expect(written).toContain("<td><b>3</b> (inclusive)</td>");
    written = "";
    await printCertificate(mc({ restFrom: "2026-10-01", restTo: "2026-10-03" }));
    expect(written).toContain("<td><b>2026-10-01</b></td>");
    expect(written).toContain("<td><b>2026-10-03</b></td>");
    written = "";
    // Half a period is no period.
    await printCertificate(mc({ restFrom: "2026-10-01" }));
    expect(written).not.toContain('class="period"');
  });

  test("REG-FE-CERTPRINT-011 the diagnosis prints only when the clinician ticked it; notes print", async () => {
    await printCertificate(mc({ diagnosis: "Dry socket", showDiagnosis: false }));
    expect(written).not.toContain("Dry socket");
    written = "";
    await printCertificate(mc({ diagnosis: "Dry socket", showDiagnosis: true, notes: "Soft diet" }));
    expect(written).toContain('<p class="dx"><span class="k">Diagnosis</span> Dry socket</p>');
    expect(written).toContain('<p class="notes">Soft diet</p>');
    written = "";
    await printCertificate(mc({ showDiagnosis: true }));
    expect(written).not.toContain('class="dx"');
  });

  test("REG-FE-CERTPRINT-012 a void certificate still prints, watermarked VOID, with the reason", async () => {
    await printCertificate(mc({ status: "void", voidReason: "Wrong patient" }));
    expect(written).toContain('<div class="void">VOID</div>');
    expect(written).toContain("This certificate was withdrawn by the issuing clinic: Wrong patient. It should not be relied upon.");
    written = "";
    await printCertificate(mc({ status: "void" }));
    expect(written).toContain("withdrawn by the issuing clinic. It should not be relied upon.");
  });

  test("REG-FE-CERTPRINT-013 markup in every typed field is escaped, never injected", async () => {
    const evil = '<img src=x onerror="alert(1)">';
    await printCertificate(mc({
      clinic: `Cure ${evil}`, clinicContact: evil, branch: evil, ref: `MC-${evil}`, patient: `Abebe ${evil}`,
      mrn: evil, age: evil, gender: "<b>m</b>", diagnosis: evil, showDiagnosis: true, notes: `a & b ${evil}`,
      restFrom: evil, restFromEc: evil, restTo: evil, restToEc: evil, issuedOn: evil, issuedOnEc: evil,
      issuedBy: evil, status: "void", voidReason: `</script>${evil}`,
    }));
    expect(written).not.toContain("<img");
    expect(written).not.toContain("<b>m</b>");
    expect(written).toContain("&lt;b&gt;m&lt;/b&gt;");
    expect(written).toContain("<title>Medical Certificate — Abebe &lt;img");
    expect(written).toContain("<b>Abebe &lt;img src=x onerror=\"alert(1)\"&gt;</b>");
    expect(written).toContain("a &amp; b &lt;img");
    expect(written).toContain("&lt;/script&gt;");
    // The single real script is the print trigger, and it closes once.
    expect(written.match(/<script>/g)).toHaveLength(1);
    expect(written.match(/<\/script>/g)).toHaveLength(1);
  });

  test("REG-FE-CERTPRINT-014 a blocked pop-up does nothing and does not throw", async () => {
    openSpy.mockReturnValue(null);
    await expect(printCertificate(mc())).resolves.toBeUndefined();
    expect(fakeWin.document.write).not.toHaveBeenCalled();
  });

  test("REG-FE-CERTPRINT-015 a QR that cannot be generated still prints the certificate with its reference", async () => {
    vi.spyOn(QRCode, "toString").mockRejectedValue(new Error("too long") as never);
    await printCertificate(mc());
    expect(written).not.toContain("<svg");
    expect(written).toContain('<div class="qr"><div class="ref">MC-2026-0041</div>');
    expect(written).toContain("<h2>Medical Certificate</h2>");
  });
});
