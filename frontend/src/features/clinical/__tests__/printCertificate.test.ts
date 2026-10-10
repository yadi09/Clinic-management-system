// Printing a medical certificate (the dental workspace's Certificates tab and the
// patient profile both call this). The paper is drawn by the shared print engine from
// the clinic's own settings; the test reads the page that reaches the printer: the
// clinic header, the reference and its QR, the title and sentence for each kind, the
// patient block, Gregorian + Ethiopian dates, the rest period, the diagnosis only
// when ticked, the VOID watermark — and every value a person typed escaped, so a
// name cannot inject markup into the print.
import { beforeEach, describe, expect, test, vi } from "vitest";

import QRCode from "qrcode";
import { printCertificate, type CertificatePrint } from "@/features/clinical/printCertificate";
import { setPrintContext } from "@/features/printing/context";
import { transport } from "@/features/printing/engine";
import { DEFAULT_SETTINGS, resolveSettings } from "@/features/printing/settings";

const api = vi.hoisted(() => ({
  peekPrint: vi.fn(), logPrint: vi.fn(), getPrintSettings: vi.fn(), savePrintSettings: vi.fn(),
}));
vi.mock("@/features/printing/api", () => api);

const sent: string[] = [];
beforeEach(() => {
  vi.restoreAllMocks();
  sent.length = 0;
  vi.spyOn(transport, "send").mockImplementation((html: string) => { sent.push(html); });
  api.peekPrint.mockReset().mockResolvedValue({ count: 0 });
  api.logPrint.mockReset().mockResolvedValue({ count: 1 });
  setPrintContext({ settings: DEFAULT_SETTINGS, logo: "", clinicName: "", branch: null });
});

function mc(over: Partial<CertificatePrint> = {}): CertificatePrint {
  return {
    clinic: "Cure Dental", ref: "MC-2026-0041", kind: "sick_leave", patient: "Abebe Kebede",
    showDiagnosis: false, restDays: 3, issuedOn: "2026-10-01", status: "active", ...over,
  };
}
const printed = async (c: CertificatePrint) => {
  const before = sent.length;
  await printCertificate(c);
  await vi.waitFor(() => expect(sent.length).toBeGreaterThan(before));
  return sent[sent.length - 1];
};
const textOf = (html: string) => {
  const doc = new DOMParser().parseFromString(html, "text/html");
  doc.querySelectorAll("script,style").forEach((n) => n.remove());
  const walker = doc.createTreeWalker(doc.body, NodeFilter.SHOW_TEXT);
  const parts: string[] = [];
  for (let n = walker.nextNode(); n; n = walker.nextNode()) parts.push(n.textContent ?? "");
  return parts.join(" ").replace(/\s+/g, " ").trim();
};
/** The certifying sentence, whitespace collapsed. */
const stmt = (html: string) => (html.match(/<p class="stmt">([\s\S]*?)<\/p>/)?.[1] ?? "").replace(/\s+/g, " ").trim();

describe("REG-FE-CERTPRINT printing a medical certificate", () => {
  test("REG-FE-CERTPRINT-001 one page with a QR and the reference, sent to the printer once", async () => {
    const p = await printed(mc());
    expect(sent).toHaveLength(1);
    expect(p).toMatch(/^<!doctype html>/);
    expect(p).toContain("<title>Medical Certificate — Abebe Kebede — MC-2026-0041</title>");
    expect(p).toMatch(/<div class="qr"><svg/);
    expect(p).toContain('<div class="ref">MC-2026-0041</div>');
    expect(textOf(p)).toContain("To verify, contact the clinic and quote the reference: MC-2026-0041");
  });

  test("REG-FE-CERTPRINT-002 the QR carries ref, clinic, patient + MRN and the issue date", async () => {
    const spy = vi.spyOn(QRCode, "toString");
    await printed(mc({ mrn: "CD-1" }));
    expect(spy.mock.calls[0][0]).toBe("MC:MC-2026-0041\nCure Dental\nAbebe Kebede CD-1\n2026-10-01");
    expect(spy.mock.calls[0][1]).toMatchObject({ type: "svg", margin: 0 });
    spy.mockClear();
    await printed(mc());
    expect(spy.mock.calls[0][0]).toBe("MC:MC-2026-0041\nCure Dental\nAbebe Kebede\n2026-10-01");
  });

  test("REG-FE-CERTPRINT-003 the clinic header: name, contact line and the active branch", async () => {
    setPrintContext({ settings: DEFAULT_SETTINGS, logo: "", clinicName: "", branch: { id: "b1", name: "Bole" } });
    const p = await printed(mc({ clinicContact: "Bole Rd · 0911" }));
    expect(p).toContain('<div class="cname">Cure Dental</div>');
    const t = textOf(p);
    expect(t).toContain("Bole Rd · 0911");
    expect(t).toContain("Bole");
  });

  test("REG-FE-CERTPRINT-004 the patient block: name, MRN, age in years, sex, the signer", async () => {
    const p = await printed(mc({ mrn: "CD-1", age: "34", gender: "male", issuedBy: "Dr Hana" }));
    const t = textOf(p);
    expect(t).toContain("Patient Abebe Kebede");
    expect(t).toContain("MRN CD-1");
    expect(t).toContain("Age 34 years");
    expect(t).toContain("Sex male");
    expect(p).toContain('<div class="sig-who">Dr Hana</div>');
  });

  test("REG-FE-CERTPRINT-005 nothing optional: dashes for MRN/age/sex, no contact, blank signer, no extras", async () => {
    const p = await printed(mc());
    const t = textOf(p);
    expect(p).not.toContain('class="cline"');
    expect(t).toContain("MRN —");
    expect(t).toContain("Age —");
    expect(t).toContain("Sex —");
    expect(p).not.toContain('class="sig-who"');
    expect(p).not.toContain('class="period"');
    expect(p).not.toContain('class="notes"');
    expect(p).not.toContain('class="void-wm"');
    expect(p).not.toContain('class="voidnote"');
  });

  test("REG-FE-CERTPRINT-006 sick leave: the title and 'unfit … rest for N days', singular for one day", async () => {
    let p = await printed(mc());
    expect(p).toContain('<h2 class="cert-h">Medical Certificate</h2>');
    expect(stmt(p)).toBe("This is to certify that <b>Abebe Kebede</b> attended this clinic and was examined on 2026-10-01. In my professional opinion the patient is <b>unfit for work or study</b> and requires rest for <b>3 days</b>.");
    p = await printed(mc({ restDays: 1 }));
    expect(stmt(p)).toContain("<b>1 day</b>.");
  });

  test("REG-FE-CERTPRINT-007 fitness: its own title and 'fit to resume normal duties'", async () => {
    const p = await printed(mc({ kind: "fitness", restDays: undefined }));
    expect(p).toContain('<h2 class="cert-h">Certificate of Fitness</h2>');
    expect(p).toContain("<title>Certificate of Fitness — ");
    expect(stmt(p)).toBe("This is to certify that <b>Abebe Kebede</b> was examined at this clinic on 2026-10-01 and is, in my professional opinion, <b>fit to resume normal duties</b>.");
    expect(p).not.toContain("unfit");
  });

  test("REG-FE-CERTPRINT-008 attendance: its own title and 'attended this clinic … received medical attention'", async () => {
    const p = await printed(mc({ kind: "attendance", restDays: undefined }));
    expect(p).toContain('<h2 class="cert-h">Certificate of Attendance</h2>');
    expect(stmt(p)).toBe("This is to certify that <b>Abebe Kebede</b> <b>attended this clinic</b> on 2026-10-01 and received medical attention.");
  });

  test("REG-FE-CERTPRINT-009 the Ethiopian date sits beside the Gregorian one, in the sentence and the signature, for every kind", async () => {
    for (const kind of ["sick_leave", "fitness", "attendance"] as const) {
      const p = await printed(mc({ kind, issuedOnEc: "21 Meskerem 2019" }));
      expect(stmt(p)).toContain("2026-10-01 (21 Meskerem 2019)");
      expect(textOf(p)).toContain("Issued 1 Oct 2026 · 21 Meskerem 2019");
    }
    const p = await printed(mc());
    expect(textOf(p)).toContain("Issued 1 Oct 2026");
    expect(textOf(p)).not.toContain("Meskerem");
  });

  test("REG-FE-CERTPRINT-010 the rest period: From / To with Ethiopian dates and the inclusive day count", async () => {
    let p = await printed(mc({ restFrom: "2026-10-01", restFromEc: "21 Meskerem 2019", restTo: "2026-10-03", restToEc: "23 Meskerem 2019" }));
    let t = textOf(p);
    expect(t).toContain("From 2026-10-01 · 21 Meskerem 2019");
    expect(t).toContain("To 2026-10-03 · 23 Meskerem 2019");
    expect(t).toContain("Days 3 (inclusive)");
    p = await printed(mc({ restFrom: "2026-10-01", restTo: "2026-10-03" }));
    t = textOf(p);
    expect(t).toContain("From 2026-10-01 To 2026-10-03");
    // Half a period is no period.
    p = await printed(mc({ restFrom: "2026-10-01" }));
    expect(p).not.toContain('class="period"');
  });

  test("REG-FE-CERTPRINT-011 the diagnosis prints only when the clinician ticked it; notes print", async () => {
    let p = await printed(mc({ diagnosis: "Dry socket", showDiagnosis: false }));
    expect(p).not.toContain("Dry socket");
    p = await printed(mc({ diagnosis: "Dry socket", showDiagnosis: true, notes: "Soft diet" }));
    expect(textOf(p)).toContain("Diagnosis Dry socket");
    expect(p).toContain('<p class="notes">Soft diet</p>');
    p = await printed(mc({ showDiagnosis: true }));
    expect(textOf(p)).not.toContain("Diagnosis");
  });

  test("REG-FE-CERTPRINT-012 a void certificate still prints, watermarked VOID, with the reason", async () => {
    let p = await printed(mc({ status: "void", voidReason: "Wrong patient" }));
    expect(p).toContain('<div class="void-wm">VOID</div>');
    expect(textOf(p)).toContain("This certificate was withdrawn by the issuing clinic. It should not be relied upon. (Wrong patient)");
    p = await printed(mc({ status: "void" }));
    expect(textOf(p)).toContain("It should not be relied upon.");
    expect(textOf(p)).not.toContain("()");
  });

  test("REG-FE-CERTPRINT-013 markup in every typed field is escaped, never injected", async () => {
    const evil = '<img src=x onerror="alert(1)">';
    const p = await printed(mc({
      clinic: `Cure ${evil}`, clinicContact: evil, branch: evil, ref: `MC-${evil}`, patient: `Abebe ${evil}`,
      mrn: evil, age: evil, gender: "<b>m</b>", diagnosis: evil, showDiagnosis: true, notes: `a & b ${evil}`,
      restFrom: evil, restFromEc: evil, restTo: evil, restToEc: evil, issuedOn: evil, issuedOnEc: evil,
      issuedBy: evil, status: "void", voidReason: `</script>${evil}`,
    }));
    expect(p).not.toContain("<img");
    expect(p).not.toContain("<b>m</b>");
    expect(p).toContain("&lt;b&gt;m&lt;/b&gt;");
    expect(p).toContain("a &amp; b &lt;img");
    expect(p).toContain("&lt;/script&gt;");
    expect(p).toContain("<b>Abebe &lt;img src=x onerror=&quot;alert(1)&quot;&gt;</b>");
    expect(p).not.toMatch(/<script/i);
  });

  test("REG-FE-CERTPRINT-014 a pop-up blocker cannot swallow it: no window is opened", async () => {
    const open = vi.spyOn(window, "open").mockReturnValue(null);
    await printed(mc());
    expect(open).not.toHaveBeenCalled();
  });

  test("REG-FE-CERTPRINT-015 a QR that cannot be generated still prints the certificate with its reference", async () => {
    vi.spyOn(QRCode, "toString").mockRejectedValue(new Error("too long") as never);
    const p = await printed(mc());
    expect(p).not.toContain("<svg");
    expect(p).toContain('<div class="qr"><div class="ref">MC-2026-0041</div>');
    expect(p).toContain('<h2 class="cert-h">Medical Certificate</h2>');
  });

  test("REG-FE-CERTPRINT-016 the clinic's own wording replaces the sentence; {patient}, {date} and {days} are filled in", async () => {
    setPrintContext({
      settings: resolveSettings({
        docs: { certificate: { text: { sickLeave: "We confirm {patient} saw us on {date} and needs {days} of rest." } } },
      }),
      logo: "", clinicName: "", branch: null,
    });
    const p = await printed(mc());
    expect(stmt(p)).toBe("We confirm <b>Abebe Kebede</b> saw us on 2026-10-01 and needs <b>3 days</b> of rest.");
  });

  test("REG-FE-CERTPRINT-017 Ethiopian dates can be switched off, and so can the QR", async () => {
    setPrintContext({
      settings: resolveSettings({ docs: { certificate: { show: { ethiopian: false, qr: false } } } }),
      logo: "", clinicName: "", branch: null,
    });
    const p = await printed(mc({ issuedOnEc: "21 Meskerem 2019", restFrom: "2026-10-01", restFromEc: "21 Meskerem 2019", restTo: "2026-10-03", restToEc: "23 Meskerem 2019" }));
    expect(textOf(p)).not.toContain("Meskerem");
    expect(p).not.toContain("<svg");
    expect(p).toContain('<div class="ref">MC-2026-0041</div>');
  });

  test("REG-FE-CERTPRINT-018 a reprint says DUPLICATE and who printed it first; the print is counted under the reference", async () => {
    api.peekPrint.mockResolvedValue({ count: 1, first_by: "Hana", first_at: "2026-10-01T09:00:00Z", last_by: "Hana", last_at: "2026-10-01T09:00:00Z" });
    api.logPrint.mockResolvedValue({ count: 2, first_by: "Hana", first_at: "2026-10-01T09:00:00Z" });
    const p = await printed(mc());
    expect(api.logPrint).toHaveBeenCalledWith("certificate", "MC-2026-0041");
    expect(p).toContain("DUPLICATE");
    expect(textOf(p)).toContain("Printed by Hana");
  });

  test("REG-FE-CERTPRINT-019 on a pre-printed pad the clinic's header is left blank for its own letterhead", async () => {
    setPrintContext({
      settings: resolveSettings({ docs: { certificate: { template: "pad" } } }),
      logo: "", clinicName: "", branch: null,
    });
    const p = await printed(mc());
    expect(p).not.toContain('<div class="cname">');
    expect(p).toContain("Space for your letterhead");
    expect(p).toContain('<h2 class="cert-h">Medical Certificate</h2>');
  });
});
