// The examination form's catalogue and helpers: the exclusive "Within normal
// limits" rule, which findings are flagged as abnormal, the one-line headline of a
// collapsed record, and the blank-record guard that stops an empty save.
import { describe, expect, test } from "vitest";

import {
  ANAESTHESIA, EXAM_GROUPS, REASSURING_FINDINGS, examHeadline, isAbnormal, isBlankExam, toggleOption,
} from "@/features/dental/examination";

const extra = EXAM_GROUPS.find((g) => g.key === "extraoral")!;
const intra = EXAM_GROUPS.find((g) => g.key === "intraoral")!;

const blank = () => ({
  chief_complaint: "", hpi: "", past_dental_history: "", extraoral: [] as string[], extraoral_notes: "",
  intraoral: [] as string[], intraoral_notes: "", investigations: [] as string[], investigation_results: "",
  diagnosis: "", treatment_plan: "", treatment_given: [] as string[], anaesthesia: "None", complications: "",
  procedures: [] as { tooth?: string; procedure?: string; notes?: string }[], postop: "",
});

describe("REG-FE-EXAM examination catalogue and helpers", () => {
  test("REG-FE-EXAM-001 the four groups, in the paper form's order, with None first in anaesthesia", () => {
    expect(EXAM_GROUPS.map((g) => g.key)).toEqual(["extraoral", "intraoral", "investigations", "treatment_given"]);
    expect(extra.exclusive).toBe("Within normal limits");
    expect(extra.options).toContain("Within normal limits");
    expect(intra.exclusive).toBeUndefined();
    expect(ANAESTHESIA[0]).toBe("None");
  });

  test("REG-FE-EXAM-002 toggleOption: on, off, and a plain group just appends", () => {
    expect(toggleOption(intra, [], "Caries present")).toEqual(["Caries present"]);
    expect(toggleOption(intra, ["Caries present"], "Halitosis")).toEqual(["Caries present", "Halitosis"]);
    expect(toggleOption(intra, ["Caries present", "Halitosis"], "Caries present")).toEqual(["Halitosis"]);
  });

  test("REG-FE-EXAM-003 toggleOption: Within normal limits clears the findings, and a finding clears it", () => {
    expect(toggleOption(extra, ["Facial asymmetry", "TMJ tenderness / clicking"], "Within normal limits"))
      .toEqual(["Within normal limits"]);
    expect(toggleOption(extra, ["Within normal limits"], "Facial asymmetry")).toEqual(["Facial asymmetry"]);
    expect(toggleOption(extra, ["Within normal limits"], "Within normal limits")).toEqual([]);
  });

  test("REG-FE-EXAM-004 isAbnormal: only the reassuring findings are not abnormal", () => {
    expect(REASSURING_FINDINGS.has("Lip competence normal")).toBe(true);
    expect(isAbnormal("Within normal limits")).toBe(false);
    expect(isAbnormal("Lip competence normal")).toBe(false);
    expect(isAbnormal("Caries present")).toBe(true);
  });

  test("REG-FE-EXAM-005 examHeadline: diagnosis, then complaint, then treatment, then Examination", () => {
    expect(examHeadline({ diagnosis: " Pulpitis ", chief_complaint: "Pain", treatment_given: ["Extraction"] })).toBe("Pulpitis");
    expect(examHeadline({ diagnosis: "  ", chief_complaint: " Pain ", treatment_given: ["Extraction"] })).toBe("Pain");
    expect(examHeadline({ treatment_given: ["Extraction", "Suturing"] })).toBe("Extraction, Suturing");
    expect(examHeadline({ treatment_given: [] })).toBe("Examination");
  });

  test("REG-FE-EXAM-006 isBlankExam: an untouched form is blank, whitespace counts as nothing", () => {
    expect(isBlankExam(blank())).toBe(true);
    expect(isBlankExam({ ...blank(), chief_complaint: "   ", procedures: [{ tooth: "", procedure: " ", notes: "" }] })).toBe(true);
    expect(isBlankExam({ ...blank(), anaesthesia: "" })).toBe(true);
    expect(isBlankExam({ ...blank(), anaesthesia: undefined })).toBe(true);
  });

  test("REG-FE-EXAM-007 isBlankExam: any one text, chip, anaesthesia or tooth row makes it worth saving", () => {
    expect(isBlankExam({ ...blank(), postop: "Rinse" })).toBe(false);
    expect(isBlankExam({ ...blank(), diagnosis: "Caries" })).toBe(false);
    expect(isBlankExam({ ...blank(), intraoral: ["Halitosis"] })).toBe(false);
    expect(isBlankExam({ ...blank(), investigations: ["Bitewing X-ray"] })).toBe(false);
    expect(isBlankExam({ ...blank(), treatment_given: ["Other"] })).toBe(false);
    expect(isBlankExam({ ...blank(), anaesthesia: "Topical" })).toBe(false);
    expect(isBlankExam({ ...blank(), procedures: [{ tooth: "UR6" }] })).toBe(false);
  });
});
