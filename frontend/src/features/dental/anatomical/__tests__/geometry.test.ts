// The drawing rules of the anatomical chart, which must match dental-chart-reference.html:
// tooth types, which side is mesial in each quadrant, where the buccal side is in
// the top view, how gaps push teeth apart, and the words a dentist reads.
import { describe, expect, test } from "vitest";

import {
  EMPTY, FMT, MM, SETS, SW, findings, fdiOf, full, isEmpty, isUp, layout, mir, moved, palmerOf, pos,
  sideRegions, toothName, topRegions, ty,
} from "@/features/dental/anatomical/geometry";
import type { ToothAnatomy } from "@/features/dental/api";

const T = (over: Partial<ToothAnatomy>): ToothAnatomy => ({ ...EMPTY, ...over });

describe("REG-FE-ANAT geometry", () => {
  test("REG-FE-ANAT-001 tooth types: incisors, canines, premolars, molars; children have no premolars", () => {
    expect([11, 12, 13, 14, 15, 16, 17, 18].map(ty)).toEqual(["inc", "inc", "can", "pre", "pre", "mol", "mol", "mol"]);
    expect([31, 33, 35, 36, 48].map(ty)).toEqual(["inc", "can", "pre", "mol", "mol"]);
    expect([51, 52, 53, 54, 55, 74, 85].map(ty)).toEqual(["inc", "inc", "can", "mol", "mol", "mol", "mol"]);
  });

  test("REG-FE-ANAT-002 the dentitions: 32 adult and 20 child teeth, each arch running from the patient's right to left", () => {
    expect(SETS.adult.up.length + SETS.adult.lo.length).toBe(32);
    expect(SETS.child.up.length + SETS.child.lo.length).toBe(20);
    expect(SETS.adult.up[7]).toBe(11);
    expect(SETS.adult.up[8]).toBe(21);
    expect(new Set([...SETS.adult.up, ...SETS.adult.lo, ...SETS.child.up, ...SETS.child.lo]).size).toBe(52);
  });

  test("REG-FE-ANAT-003 the patient's right side is mirrored, and upper is upper", () => {
    expect([11, 21, 31, 41, 51, 61, 71, 81].map(mir)).toEqual([true, false, false, true, true, false, false, true]);
    expect([11, 21, 31, 41, 55, 65, 75, 85].map(isUp)).toEqual([true, true, false, false, true, true, false, false]);
  });

  test("REG-FE-ANAT-004 mesial always faces the midline in the side view", () => {
    // 11 is right of the midline on screen-left: its mesial side is screen-right (x 26).
    expect(sideRegions(11).M[0]).toBe(26);
    expect(sideRegions(11).D[0]).toBe(0);
    // 21 is on the other side: mesial is screen-left (x 0).
    expect(sideRegions(21).M[0]).toBe(0);
    expect(sideRegions(21).D[0]).toBe(26);
    expect(sideRegions(46).M[0]).toBe(26);
    expect(sideRegions(36).M[0]).toBe(0);
  });

  test("REG-FE-ANAT-005 in the top view buccal is at the top for upper teeth and at the bottom for lower ones", () => {
    expect(topRegions(16).B[1]).toBe(0);
    expect(topRegions(16).L[1]).toBe(28);
    expect(topRegions(36).B[1]).toBe(28);
    expect(topRegions(36).L[1]).toBe(0);
    expect(topRegions(26).M[0]).toBe(0);
    expect(topRegions(16).M[0]).toBe(28);
  });

  test("REG-FE-ANAT-006 with no gaps the teeth touch: the arch is exactly the sum of the slots and the midline sits between 11 and 21", () => {
    const L = layout(SETS.adult.up, () => undefined);
    expect(L.gaps).toEqual([]);
    expect(L.width).toBeCloseTo(SETS.adult.up.reduce((s, n) => s + SW(n), 0));
    for (let i = 1; i < L.items.length; i++) expect(L.items[i].x).toBeCloseTo(L.items[i - 1].x + L.items[i - 1].w);
    expect(L.mid).toBeCloseTo(L.items[8].x);
  });

  test("REG-FE-ANAT-007 a gap belongs to the mesial side of its tooth, pushes the teeth apart by 4 px per mm, and keeps its real size", () => {
    const anatomy: Record<string, ToothAnatomy> = { 11: T({ gap_mesial: 2 }), 12: T({ gap_mesial: 1.5 }), 24: T({ gap_mesial: 1 }) };
    const L = layout(SETS.adult.up, (n) => anatomy[n]);
    const at = (n: number) => L.items.find((i) => i.n === n)!;
    // 11's gap is between 11 and 21 (its mesial side faces the midline)…
    const g11 = L.gaps.find((g) => g.g === 2)!;
    expect(g11.x).toBeCloseTo(at(11).x + at(11).w);
    expect(g11.w).toBe(2 * MM);
    expect(at(21).x).toBeCloseTo(g11.x + g11.w);
    // …and the midline runs through the middle of that gap.
    expect(L.mid).toBeCloseTo(g11.x + g11.w / 2);
    // 12's mesial side faces 11; 24's faces 23.
    expect(L.gaps.find((g) => g.g === 1.5)!.x).toBeCloseTo(at(12).x + at(12).w);
    expect(L.gaps.find((g) => g.g === 1)!.x).toBeCloseTo(at(23).x + at(23).w);
    const plain = layout(SETS.adult.up, () => undefined);
    expect(L.width).toBeCloseTo(plain.width + 4.5 * MM);
  });

  test("REG-FE-ANAT-008 gaps on both sides of one contact add up; a missing tooth keeps no gap", () => {
    const L = layout(SETS.adult.lo, (n) => ({ 31: T({ gap_mesial: 1 }), 41: T({ gap_mesial: 2 }), 35: T({ gap_mesial: 3, missing: true }) } as Record<number, ToothAnatomy>)[n]);
    expect(L.gaps).toHaveLength(1);
    expect(L.gaps[0].g).toBe(3);
  });

  test("REG-FE-ANAT-009 tooth names", () => {
    expect(toothName(11)).toBe("Upper right central incisor");
    expect(toothName(38)).toBe("Lower left third molar");
    expect(toothName(45)).toBe("Lower right second premolar");
    expect(toothName(54)).toBe("Upper right primary first molar");
    expect(toothName(73)).toBe("Lower left primary canine");
  });

  test("REG-FE-ANAT-010 findings read in plain words, in the reference's order", () => {
    expect(findings(undefined)).toEqual([]);
    expect(findings(T({
      missing: true, crown: true, root_canal: true, surfaces: { O: "caries", M: "filling" },
      rotation: -20, tipping: 10, buccal_lingual: -1.5, vertical: 2, gap_mesial: 3,
    }))).toEqual([
      "missing", "crown", "root canal", "caries (occlusal)", "filling (mesial)",
      "rotated 20° counterclockwise", "tipped 10° mesially", "1.5mm lingual", "2mm extruded", "3mm gap on mesial side",
    ]);
    // Surfaces read in one fixed order however they were stored (O M D B L).
    expect(findings(T({ surfaces: { L: "filling", M: "filling", O: "caries", B: "caries", D: "caries" } }))).toEqual([
      "caries (occlusal)", "filling (mesial)", "caries (distal)", "caries (buccal)", "filling (lingual)",
    ]);
    expect(findings(T({ rotation: 5, tipping: -5, buccal_lingual: 1, vertical: -1 }))).toEqual([
      "rotated 5° clockwise", "tipped 5° distally", "1mm buccal", "1mm intruded",
    ]);
  });

  test("REG-FE-ANAT-011 the slider read-outs", () => {
    expect([FMT.rot(0), FMT.rot(30), FMT.rot(-30)]).toEqual(["0°", "30° cw", "30° ccw"]);
    expect([FMT.tilt(0), FMT.tilt(10), FMT.tilt(-10)]).toEqual(["0°", "10° mes", "10° dist"]);
    expect([FMT.bl(0), FMT.bl(1.5), FMT.bl(-1.5)]).toEqual(["0mm", "1.5mm buc", "1.5mm ling"]);
    expect([FMT.vert(0), FMT.vert(2), FMT.vert(-2)]).toEqual(["0mm", "2mm up", "2mm down"]);
    expect(FMT.gap(2.5)).toBe("2.5mm");
  });

  test("REG-FE-ANAT-012 a record: empty, moved, filled in from a partial server row", () => {
    expect(isEmpty(undefined)).toBe(true);
    expect(isEmpty(EMPTY)).toBe(true);
    expect(isEmpty(T({ surfaces: { L: "caries" } }))).toBe(false);
    expect(isEmpty(T({ vertical: -0.5 }))).toBe(false);
    expect(moved(T({ crown: true }))).toBe(false);
    expect(moved(T({ gap_mesial: 1 }))).toBe(true);
    const f = full({ missing: true });
    expect(f).toEqual({ ...EMPTY, missing: true, surfaces: {} });
    expect(pos(undefined)).toEqual({ rot: 0, tilt: 0, bl: 0, vert: 0, gap: 0 });
  });

  test("REG-FE-ANAT-013 Palmer and FDI name the same tooth both ways; children have no Palmer code", () => {
    for (const n of [...SETS.adult.up, ...SETS.adult.lo]) expect(fdiOf(palmerOf(n)!)).toBe(n);
    expect(palmerOf(11)).toBe("UR1");
    expect(palmerOf(28)).toBe("UL8");
    expect(palmerOf(36)).toBe("LL6");
    expect(palmerOf(47)).toBe("LR7");
    expect(palmerOf(54)).toBeUndefined();
    expect(fdiOf("UR9")).toBeUndefined();
    expect(fdiOf("11")).toBeUndefined();
  });
});
