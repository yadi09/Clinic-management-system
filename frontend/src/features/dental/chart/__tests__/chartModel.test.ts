// The chart's rules, with no screen: what an apply changes, what a shortcut selects,
// how marks are summarised and lettered, and how arrow keys walk the teeth.
import { describe, expect, test } from "vitest";

import {
  ALL_TEETH, CLEAR, HISTORY_LIMIT, LOWER_ARCH, UPPER_ARCH, capital, changesFor, glyphs, invert, neighbour,
  pushEntry, quickSelects, sameTeeth, summarize,
} from "@/features/dental/chart/chartModel";

const DEFS = [
  { code: "healthy", label: "Healthy" },
  { code: "decayed", label: "Decayed" },
  { code: "filled", label: "Filled" },
  { code: "extracted", label: "Extracted" },
  { code: "crown", label: "Crown" },
  { code: "cracked", label: "Cracked" },
];

describe("REG-FE-CHARTMODEL tooth chart rules", () => {
  test("REG-FE-CHARTMODEL-001 there are 32 teeth in chart-reading order, 16 to an arch", () => {
    expect(ALL_TEETH).toHaveLength(32);
    expect(new Set(ALL_TEETH).size).toBe(32);
    expect(UPPER_ARCH).toHaveLength(16);
    expect(LOWER_ARCH).toHaveLength(16);
    expect(ALL_TEETH.slice(0, 3)).toEqual(["UR8", "UR7", "UR6"]);
  });

  test("REG-FE-CHARTMODEL-002 an apply names only the teeth that would actually change", () => {
    const chart = { UR1: "decayed", UR2: "filled" };
    expect(changesFor(chart, ["UR1", "UR2", "UR3"], "decayed")).toEqual({ UR2: "decayed", UR3: "decayed" });
    // Clearing an unmarked tooth is nothing; clearing a marked one is a change.
    expect(changesFor(chart, ["UR1", "UR3"], CLEAR)).toEqual({ UR1: "" });
    expect(changesFor(chart, ["UR1"], "decayed")).toEqual({});
  });

  test("REG-FE-CHARTMODEL-003 shortcuts: arches, quadrants, unmarked, and only the conditions on the chart", () => {
    const chart = { UR1: "decayed", LL8: "decayed", UL3: "filled" };
    const q = Object.fromEntries(quickSelects(chart, DEFS).map((s) => [s.key, s]));
    expect(q.all.codes).toHaveLength(32);
    expect(q.upper.codes).toHaveLength(16);
    expect(q.ur.codes).toHaveLength(8);
    expect(q.unmarked.codes).toHaveLength(29);
    expect(q["is-decayed"].codes.sort()).toEqual(["LL8", "UR1"]);
    expect(q["is-decayed"].label).toBe("All decayed · 2");
    expect(q["is-crown"]).toBeUndefined();
  });

  test("REG-FE-CHARTMODEL-004 invert and set comparison", () => {
    expect(invert(new Set(UPPER_ARCH))).toEqual(LOWER_ARCH);
    expect(sameTeeth(new Set(["UR1", "UR2"]), ["UR2", "UR1"])).toBe(true);
    expect(sameTeeth(new Set(["UR1"]), ["UR1", "UR2"])).toBe(false);
    expect(sameTeeth(new Set(["UR1", "UR3"]), ["UR1", "UR2"])).toBe(false);
  });

  test("REG-FE-CHARTMODEL-005 the summary counts marks per condition, retired ones last", () => {
    const s = summarize({ UR1: "decayed", UR2: "decayed", UR3: "healthy", UL1: "old_mark" }, ["healthy", "decayed", "filled"]);
    expect(s.marked).toBe(4);
    expect(s.unmarked).toBe(28);
    expect(s.byCondition).toEqual([
      { code: "healthy", count: 1 }, { code: "decayed", count: 2 }, { code: "old_mark", count: 1 },
    ]);
    expect(summarize({}, []).marked).toBe(0);
  });

  test("REG-FE-CHARTMODEL-006 each condition gets a short unique letter; healthy none, extracted a cross", () => {
    const g = glyphs(DEFS);
    expect(g.healthy).toBe("");
    expect(g.extracted).toBe("✕");
    expect(g.decayed).toBe("D");
    expect(g.filled).toBe("F");
    // Two conditions starting with C do not share a letter.
    expect(g.crown).toBe("C");
    expect(g.cracked).toBe("Cr");
    expect(new Set(Object.values(g).filter(Boolean)).size).toBe(Object.values(g).filter(Boolean).length);
    // A label with no letters falls back to the code.
    expect(glyphs([{ code: "x9", label: "123" }]).x9).toBe("X");
  });

  test("REG-FE-CHARTMODEL-007 a lower-case clinic label reads with a capital", () => {
    expect(capital("bridge")).toBe("Bridge");
    expect(capital("")).toBe("");
  });

  test("REG-FE-CHARTMODEL-008 history keeps the last twenty steps", () => {
    let stack: ReturnType<typeof pushEntry> = [];
    for (let i = 0; i < HISTORY_LIMIT + 5; i++) stack = pushEntry(stack, { label: String(i), before: {}, after: {} });
    expect(stack).toHaveLength(HISTORY_LIMIT);
    expect(stack[0].label).toBe("5");
  });

  test("REG-FE-CHARTMODEL-009 arrow keys walk the two rows of sixteen and stop at the edges", () => {
    expect(neighbour("UR8", "ArrowLeft")).toBeNull();
    expect(neighbour("UR8", "ArrowRight")).toBe("UR7");
    expect(neighbour("UL8", "ArrowRight")).toBeNull();
    expect(neighbour("UR1", "ArrowRight")).toBe("UL1");
    expect(neighbour("UR8", "ArrowDown")).toBe("LR8");
    expect(neighbour("LR8", "ArrowUp")).toBe("UR8");
    expect(neighbour("UR8", "ArrowUp")).toBeNull();
    expect(neighbour("LL8", "ArrowDown")).toBeNull();
    expect(neighbour("LL8", "ArrowLeft")).toBe("LL7");
    expect(neighbour("XX1", "ArrowLeft")).toBeNull();
  });
});
