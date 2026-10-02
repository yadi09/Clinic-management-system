// resolveFocus decides which visit the dental patient page is about. Ported case for
// case from the old focusVisit.check.ts. The case that matters most is 002: a patient
// mid-course with nothing booked today must still resolve to their open session (the
// page this replaced landed them on last year's finished treatment).
import { describe, expect, test } from "vitest";

import { resolveFocus } from "@/features/dental/visit/useFocusVisit";
import { P, S } from "./fixtures";

const T = "2026-08-12";

describe("REG-FE-FOCUS resolveFocus (which visit the dental page opens on)", () => {
  test("REG-FE-FOCUS-001 a visit booked today wins over everything", () => {
    const r = resolveFocus([P("p1", "RCT", [S("s1", "2026-08-01", 1, "done"), S("s2", T, 2), S("s3", "2026-09-01", 3)])], T);
    expect(r.rung).toBe("today");
  });

  test("REG-FE-FOCUS-002 nothing today but a course running resolves to the open course, not history", () => {
    const r = resolveFocus([P("p1", "RCT", [S("s1", "2026-08-01", 1, "done"), S("s2", "2026-08-20", 2)])], T);
    expect(r.rung).toBe("next");
    expect(r.focus?.session.id).toBe("s2");
  });

  test("REG-FE-FOCUS-003 missed beats upcoming and picks the next step (first not done)", () => {
    const r = resolveFocus([P("p1", "RCT", [S("s1", "2026-08-07", 1), S("s2", "2026-08-20", 2)])], T);
    expect(r.rung).toBe("missed");
    expect(r.focus?.session.id).toBe("s1");
  });

  test("REG-FE-FOCUS-004 two concurrent courses: today wins, both listed, other's missed known", () => {
    const r = resolveFocus([P("p1", "RCT", [S("s1", T, 1)]), P("p2", "Scaling", [S("s2", "2026-08-07", 1)])], T);
    expect(r.focus?.session.id).toBe("s1");
    expect(r.treatments.map((t) => t.plan.id)).toEqual(["p1", "p2"]);
    expect(r.treatments[1].missed.map((s) => s.id)).toEqual(["s2"]);
  });

  test("REG-FE-FOCUS-005 a finished course shows the last visit, not an empty page", () => {
    const r = resolveFocus([P("p1", "RCT", [S("s1", "2026-07-01", 1, "done"), S("s2", "2026-08-01", 2, "done")])], T);
    expect(r.focus?.session.id).toBe("s2");
  });

  test("REG-FE-FOCUS-006 an explicit ?visit= always wins, even a done visit", () => {
    expect(resolveFocus([P("p1", "RCT", [S("s1", T, 1), S("s2", "2026-09-01", 2)])], T, "s2").focus?.session.id).toBe("s2");
    expect(resolveFocus([P("p1", "RCT", [S("s1", "2026-08-01", 1, "done"), S("s2", T, 2)])], T, "s1").rung).toBe("chosen");
  });

  test("REG-FE-FOCUS-007 a stale ?visit= falls back instead of blanking the page", () => {
    expect(resolveFocus([P("p1", "RCT", [S("s1", T, 1)])], T, "deleted").rung).toBe("today");
  });

  test("REG-FE-FOCUS-008 cancelled plans are not live work", () => {
    expect(resolveFocus([P("p1", "Old", [S("s1", T, 1)], "cancelled")], T).rung).toBe("none");
  });

  test("REG-FE-FOCUS-009 a cancelled session is not an open visit", () => {
    const r = resolveFocus([P("p1", "RCT", [S("s1", T, 1, "cancelled"), S("s2", "2026-09-01", 2)])], T);
    expect(r.focus?.session.id).toBe("s2");
  });

  test("REG-FE-FOCUS-010 no plans at all", () => {
    expect(resolveFocus([], T).rung).toBe("none");
  });

  test("REG-FE-FOCUS-011 an abandoned course does not capture the page from a current one", () => {
    const r = resolveFocus([
      P("old", "Abandoned scaling", [S("a1", "2026-02-01", 1)]),
      P("new", "Root canal", [S("b1", "2026-08-10", 1)]),
    ], T);
    expect(r.focus?.session.id).toBe("b1");
  });

  test("REG-FE-FOCUS-012 the real patient: three root canals, opens visit 2 of 5 of the current one as missed", () => {
    const t = "2026-10-02";
    const r = resolveFocus([
      P("a", "Root canel", [S("a1", "2026-08-17", 1), S("a2", "2026-08-24", 2), S("a3", "2026-08-24", 3, "done")]),
      P("b", "Root canel", [S("b1", "2026-08-24", 1), S("b2", "2026-09-07", 2), S("b3", "2026-10-08", 3), S("b4", "2026-10-05", 4)]),
      P("c", "Root canel", [S("c1", "2026-08-24", 1, "done"), S("c2", "2026-09-07", 2), S("c3", "2026-09-21", 3), S("c4", "2026-10-05", 4), S("c5", "2026-10-19", 5)]),
    ], t);
    expect(r.focus?.plan.id).toBe("c");
    expect(r.focus?.session.id).toBe("c2");
    expect(r.rung).toBe("missed");
    expect([r.focus?.position, r.focus?.count]).toEqual([2, 5]);
    expect(r.treatments.find((x) => x.plan.id === "c")?.missed.map((s) => s.id)).toEqual(["c2", "c3"]);
    expect(r.treatments).toHaveLength(3);
  });

  test("REG-FE-FOCUS-013 numbers follow the calendar, so a moved visit cannot read 1, 3, 2", () => {
    const r = resolveFocus([P("p1", "RCT", [S("s1", "2026-08-01", 1, "done"), S("s3", "2026-10-08", 3), S("s4", "2026-10-05", 4)])], T);
    expect(r.focus?.session.id).toBe("s4");
    expect(r.focus?.position).toBe(2);
  });

  test("REG-FE-FOCUS-014 a missed visit recorded today keeps its number", () => {
    const t = "2026-10-02";
    const plans = [P("c", "Root canal", [S("c1", "2026-08-24", 1, "done"), S("c2", t, 2, "done"), S("c3", "2026-09-21", 3), S("c4", "2026-10-05", 4)])];
    expect(resolveFocus(plans, t, "c2").focus?.position).toBe(2);
    const r = resolveFocus(plans, t);
    expect(r.focus?.session.id).toBe("c3");
    expect(r.focus?.position).toBe(3);
  });
});
