// Printing an examination. The paper is drawn by the shared print engine from the
// clinic's own settings; the test reads the page that reaches the printer — the
// clinic, the patient line, the sections in reading order, empty sections left out,
// and every value escaped so a note cannot inject markup into the print.
import { beforeEach, describe, expect, test, vi } from "vitest";

import { printExamination } from "@/features/dental/printExam";
import type { Exam } from "@/features/dental/api";
import { setPrintContext } from "@/features/printing/context";
import { transport } from "@/features/printing/engine";
import { DEFAULT_SETTINGS, resolveSettings } from "@/features/printing/settings";

const api = vi.hoisted(() => ({
  peekPrint: vi.fn(), logPrint: vi.fn(), getPrintSettings: vi.fn(), savePrintSettings: vi.fn(),
}));
vi.mock("@/features/printing/api", () => api);

function exam(over: Partial<Exam> = {}): Exam {
  return {
    id: "ex1", visit_date: "2026-08-12", extraoral: [], intraoral: [], investigations: [],
    treatment_given: [], procedures: [], created_at: "", updated_at: "", ...over,
  } as Exam;
}

const sent: string[] = [];
beforeEach(() => {
  vi.restoreAllMocks();
  sent.length = 0;
  vi.spyOn(transport, "send").mockImplementation((html: string) => { sent.push(html); });
  api.peekPrint.mockReset().mockResolvedValue({ count: 0 });
  api.logPrint.mockReset().mockResolvedValue({ count: 1 });
  setPrintContext({ settings: DEFAULT_SETTINGS, logo: "", clinicName: "", branch: null });
});

const printed = async (o: Parameters<typeof printExamination>[0]) => {
  const before = sent.length;
  printExamination(o);
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
/** The markup between a section's heading and its end. */
const section = (html: string, title: string) => {
  const m = html.match(new RegExp(`<section><h3>${title}</h3>(.*?)</section>`, "s"));
  return m ? m[1] : null;
};

describe("REG-FE-EXAM printing an examination", () => {
  test("REG-FE-EXAM-008 one page goes to the printer, with the clinic and the confidentiality line", async () => {
    const p = await printed({ clinic: "Cure Dental", patient: "Abebe Kebede", exam: exam({ chief_complaint: "Pain" }) });
    expect(sent).toHaveLength(1);
    expect(p).toMatch(/^<!doctype html>/);
    expect(p).toContain("<title>Clinical examination — Abebe Kebede — 2026-08-12</title>");
    expect(p).toContain('<div class="cname">Cure Dental</div>');
    expect(textOf(p)).toContain("Confidential — for the named patient and their treating clinicians.");
  });

  test("REG-FE-EXAM-009 a pop-up blocker cannot swallow it: no window is opened", async () => {
    const open = vi.spyOn(window, "open").mockReturnValue(null);
    await printed({ clinic: "C", patient: "P", exam: exam() });
    expect(open).not.toHaveBeenCalled();
  });

  test("REG-FE-EXAM-010 the header and patient line: contact, MRN, age, gender, examiner, visit date", async () => {
    const p = await printed({
      clinic: "Cure Dental", clinicContact: "Bole Rd · 0911", patient: "Abebe Kebede", mrn: "CD-0042",
      age: 34, gender: "male", exam: exam({ recorded_by: "Dr Hana" }),
    });
    const t = textOf(p);
    expect(t).toContain("Bole Rd · 0911");
    expect(p).toContain('<div class="pname">Abebe Kebede</div>');
    expect(t).toContain("CD-0042 · 34 yrs · male");
    expect(t).toContain("Examined by Dr Hana");
    expect(t).toContain("12 Aug 2026");
  });

  test("REG-FE-EXAM-011 no contact, MRN, age or examiner: those parts are left out, age 0 still prints", async () => {
    let p = await printed({ clinic: "C", patient: "P", exam: exam() });
    expect(p).not.toContain('class="cline"');
    expect(textOf(p)).not.toContain("Examined by");
    p = await printed({ clinic: "C", patient: "P", age: 0, exam: exam() });
    expect(textOf(p)).toContain("0 yrs");
  });

  test("REG-FE-EXAM-012 an empty examination prints no section headings at all", async () => {
    const p = await printed({ clinic: "C", patient: "P", exam: exam({ anaesthesia: "None", complications: "  " }) });
    expect(p).not.toContain("<section>");
  });

  test("REG-FE-EXAM-013 a full examination: every section with its content, in the order a clinician reads", async () => {
    const p = await printed({
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
    expect(section(p, "Presenting complaint")).toBe("<p>Pain lower right</p><p>3 days<br>worse at night</p>");
    expect(section(p, "Past dental history")).toBe("<p>Filling 2024</p>");
    expect(section(p, "Extraoral examination")).toBe('<ul class="chips"><li>Facial asymmetry</li></ul><p>Mild swelling</p>');
    expect(section(p, "Intraoral examination")).toBe('<ul class="chips"><li>Caries present</li><li>Halitosis</li></ul><p>Deep caries 46</p>');
    expect(section(p, "Investigations")).toBe('<ul class="chips"><li>Periapical X-ray</li></ul><p>PA lesion</p>');
    expect(section(p, "Diagnosis")).toBe('<p class="dxl">Irreversible pulpitis — 46</p>');
    expect(section(p, "Treatment plan")).toBe("<p>RCT then crown</p>");
    const tx = section(p, "Treatment given this visit")!;
    expect(tx).toContain('<ul class="chips"><li>Root Canal Treatment</li></ul>');
    expect(tx).toContain('<span class="k2">Anaesthesia</span>Nerve Block');
    expect(tx).toContain('<tr><td class="nw">46</td><td>Access opening</td><td>MB2 found</td></tr>');
    // The blank trailing row of the form's tooth table is not printed.
    expect(tx.match(/<tr>/g)).toHaveLength(2); // header + one row
    expect(tx).toContain('<p class="warn"><span class="k2">Complications</span>Bleeding</p>');
    expect(section(p, "Post-operative instructions")).toBe("<p>Soft diet</p>");
    const order = ["Presenting complaint", "Past dental history", "Extraoral", "Intraoral", "Investigations",
      "Diagnosis", "Treatment plan", "Treatment given", "Post-operative"].map((t) => p.indexOf(`<h3>${t}`));
    expect([...order].sort((a, b) => a - b)).toEqual(order);
  });

  test("REG-FE-EXAM-014 anaesthesia None is not printed; a tooth table alone still makes the treatment section", async () => {
    const p = await printed({ clinic: "C", patient: "P", exam: exam({ anaesthesia: "None", procedures: [{ tooth: "11" }] }) });
    const tx = section(p, "Treatment given this visit")!;
    expect(tx).not.toContain("Anaesthesia");
    expect(tx).toContain('<td class="nw">11</td><td></td><td></td>');
  });

  test("REG-FE-EXAM-015 markup in any value is escaped, never injected into the print", async () => {
    const p = await printed({
      clinic: "A&B <Dental>", patient: "<img src=x onerror=alert(1)>",
      exam: exam({ diagnosis: "<script>alert(1)</script>", intraoral: ["<b>x</b>"], procedures: [{ tooth: "<i>", procedure: "a&b" }] }),
    });
    expect(p).toContain('<div class="cname">A&amp;B &lt;Dental&gt;</div>');
    expect(p).toContain('<div class="pname">&lt;img src=x onerror=alert(1)&gt;</div>');
    expect(p).toContain('<p class="dxl">&lt;script&gt;alert(1)&lt;/script&gt;</p>');
    expect(p).toContain("<li>&lt;b&gt;x&lt;/b&gt;</li>");
    expect(p).toContain('<td class="nw">&lt;i&gt;</td><td>a&amp;b</td>');
    expect(p).not.toContain("<img src=x");
    expect(p).not.toMatch(/<script/i);
  });

  test("REG-FE-EXAM-016 the clinic can leave out whole sections it does not want on the paper", async () => {
    setPrintContext({
      settings: resolveSettings({ docs: { exam: { show: { history: false, postop: false } } } }),
      logo: "", clinicName: "", branch: null,
    });
    const p = await printed({
      clinic: "C", patient: "P",
      exam: exam({ chief_complaint: "Pain", past_dental_history: "Filling 2024", postop: "Soft diet", diagnosis: "Pulpitis" }),
    });
    expect(section(p, "Presenting complaint")).not.toBeNull();
    expect(section(p, "Past dental history")).toBeNull();
    expect(section(p, "Post-operative instructions")).toBeNull();
    // The diagnosis is the point of the paper: it has no switch.
    expect(section(p, "Diagnosis")).not.toBeNull();
  });
});
