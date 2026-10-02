// Printing an examination: a new window gets one self-contained HTML page. The
// window is faked, and the test reads the HTML it was given — the clinic, the
// patient line, the sections in reading order, empty sections left out, and every
// value escaped so a note cannot inject markup into the print.
import { afterEach, beforeEach, describe, expect, test, vi, type MockInstance } from "vitest";

import { printExamination } from "@/features/dental/printExam";
import type { Exam } from "@/features/dental/api";

function exam(over: Partial<Exam> = {}): Exam {
  return {
    id: "ex1", visit_date: "2026-08-12", extraoral: [], intraoral: [], investigations: [],
    treatment_given: [], procedures: [], created_at: "", updated_at: "", ...over,
  } as Exam;
}

let written = "";
let fakeWin: { document: { write: ReturnType<typeof vi.fn>; close: ReturnType<typeof vi.fn> } };
let openSpy: MockInstance<typeof window.open>;

beforeEach(() => {
  written = "";
  fakeWin = { document: { write: vi.fn((s: string) => { written += s; }), close: vi.fn() } };
  openSpy = vi.spyOn(window, "open").mockReturnValue(fakeWin as unknown as Window);
});
afterEach(() => vi.restoreAllMocks());

/** The text between a section's heading and the next one. */
const section = (title: string) => {
  const m = written.match(new RegExp(`<section><h2>${title}</h2>(.*?)</section>`, "s"));
  return m ? m[1] : null;
};

describe("REG-FE-EXAM printing an examination", () => {
  test("REG-FE-EXAM-008 opens a blank window, writes one page, closes the document, and prints on load", () => {
    printExamination({ clinic: "Cure Dental", patient: "Abebe Kebede", exam: exam({ chief_complaint: "Pain" }) });
    expect(openSpy).toHaveBeenCalledWith("", "_blank", "width=820,height=1000");
    expect(fakeWin.document.write).toHaveBeenCalledTimes(1);
    expect(fakeWin.document.close).toHaveBeenCalledTimes(1);
    expect(written).toMatch(/^<!doctype html>/);
    expect(written).toContain("<title>Examination — Abebe Kebede — 2026-08-12</title>");
    expect(written).toContain("window.onload=function(){window.print();}");
    expect(written).toContain("<h1>Cure Dental</h1>");
    expect(written).toContain("Clinical record issued by Cure Dental.");
  });

  test("REG-FE-EXAM-009 a blocked pop-up does nothing and does not throw", () => {
    openSpy.mockReturnValue(null);
    expect(() => printExamination({ clinic: "C", patient: "P", exam: exam() })).not.toThrow();
    expect(fakeWin.document.write).not.toHaveBeenCalled();
  });

  test("REG-FE-EXAM-010 the header and patient line: contact, MRN, age, gender, examiner, visit date", () => {
    printExamination({
      clinic: "Cure Dental", clinicContact: "Bole Rd · 0911", patient: "Abebe Kebede", mrn: "CD-0042",
      age: 34, gender: "male", exam: exam({ recorded_by: "Dr Hana" }),
    });
    expect(written).toContain('<div class="contact">Bole Rd · 0911</div>');
    expect(written).toContain('<div class="pname">Abebe Kebede</div>');
    expect(written).toContain('<div class="pmeta">CD-0042 · 34 yrs · male</div>');
    expect(written).toContain('<span class="k">Examined by</span>Dr Hana');
    expect(written).toContain("<b>2026-08-12</b>");
  });

  test("REG-FE-EXAM-011 no contact, MRN, age or examiner: those parts are left out, age 0 still prints", () => {
    printExamination({ clinic: "C", patient: "P", exam: exam() });
    expect(written).not.toContain('class="contact"');
    expect(written).toContain('<div class="pmeta"></div>');
    expect(written).not.toContain("Examined by");
    printExamination({ clinic: "C", patient: "P", age: 0, exam: exam() });
    expect(written).toContain('<div class="pmeta">0 yrs</div>');
  });

  test("REG-FE-EXAM-012 an empty examination prints no section headings at all", () => {
    printExamination({ clinic: "C", patient: "P", exam: exam({ anaesthesia: "None", complications: "  " }) });
    expect(written).not.toContain("<section>");
  });

  test("REG-FE-EXAM-013 a full examination: every section with its content, in the order a clinician reads", () => {
    printExamination({
      clinic: "C", patient: "P",
      exam: exam({
        chief_complaint: "Pain lower right", hpi: "3 days\nworse at night", past_dental_history: "Filling 2024",
        extraoral: ["Facial asymmetry"], extraoral_notes: "Mild swelling",
        intraoral: ["Caries present", "Halitosis"], intraoral_notes: "Deep caries 46",
        investigations: ["Periapical X-ray"], investigation_results: "PA lesion",
        diagnosis: "Irreversible pulpitis — 46", treatment_plan: "RCT then crown",
        treatment_given: ["Root Canal Treatment"], anaesthesia: "Nerve Block", complications: "Bleeding",
        procedures: [{ tooth: "46", procedure: "Access opening", notes: "MB2 found" }, { tooth: "", procedure: "", notes: "" }],
        postop: "Soft diet",
      }),
    });
    expect(section("Presenting complaint")).toBe("<p>Pain lower right</p><p>3 days<br>worse at night</p>");
    expect(section("Past dental history")).toBe("<p>Filling 2024</p>");
    expect(section("Extraoral examination")).toBe('<ul class="chips"><li>Facial asymmetry</li></ul><p>Mild swelling</p>');
    expect(section("Intraoral examination")).toBe('<ul class="chips"><li>Caries present</li><li>Halitosis</li></ul><p>Deep caries 46</p>');
    expect(section("Investigations")).toBe('<ul class="chips"><li>Periapical X-ray</li></ul><p>PA lesion</p>');
    expect(section("Diagnosis")).toBe('<p class="dx">Irreversible pulpitis — 46</p>');
    expect(section("Treatment plan")).toBe("<p>RCT then crown</p>");
    const tx = section("Treatment given this visit")!;
    expect(tx).toContain('<ul class="chips"><li>Root Canal Treatment</li></ul>');
    expect(tx).toContain('<span class="k">Anaesthesia</span>Nerve Block');
    expect(tx).toContain('<tr><td class="nw">46</td><td>Access opening</td><td>MB2 found</td></tr>');
    // The blank trailing row of the form's tooth table is not printed.
    expect(tx.match(/<tr>/g)).toHaveLength(2); // header + one row
    expect(tx).toContain('<p class="warn"><span class="k">Complications</span>Bleeding</p>');
    expect(section("Post-operative instructions")).toBe("<p>Soft diet</p>");
    const order = ["Presenting complaint", "Past dental history", "Extraoral", "Intraoral", "Investigations",
      "Diagnosis", "Treatment plan", "Treatment given", "Post-operative"].map((t) => written.indexOf(`<h2>${t}`));
    expect([...order].sort((a, b) => a - b)).toEqual(order);
  });

  test("REG-FE-EXAM-014 anaesthesia None is not printed; a tooth table alone still makes the treatment section", () => {
    printExamination({ clinic: "C", patient: "P", exam: exam({ anaesthesia: "None", procedures: [{ tooth: "11" }] }) });
    const tx = section("Treatment given this visit")!;
    expect(tx).not.toContain("Anaesthesia");
    expect(tx).toContain('<td class="nw">11</td><td></td><td></td>');
  });

  test("REG-FE-EXAM-015 markup in any value is escaped, never injected into the print", () => {
    printExamination({
      clinic: "A&B <Dental>", patient: "<img src=x onerror=alert(1)>",
      exam: exam({ diagnosis: "<script>alert(1)</script>", intraoral: ["<b>x</b>"], procedures: [{ tooth: "<i>", procedure: "a&b" }] }),
    });
    expect(written).toContain("<h1>A&amp;B &lt;Dental&gt;</h1>");
    expect(written).toContain('<div class="pname">&lt;img src=x onerror=alert(1)&gt;</div>');
    expect(written).toContain('<p class="dx">&lt;script&gt;alert(1)&lt;/script&gt;</p>');
    expect(written).toContain("<li>&lt;b&gt;x&lt;/b&gt;</li>");
    expect(written).toContain('<td class="nw">&lt;i&gt;</td><td>a&amp;b</td>');
    expect(written).not.toContain("<img src=x");
  });
});
