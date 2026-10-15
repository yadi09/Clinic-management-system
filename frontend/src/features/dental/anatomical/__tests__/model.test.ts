// The anatomical chart's business rules (model.ts), ported from
// dental-chart-reference_3d.html: what each tool does, what it refuses and in what
// words, bridges, implants, extractions, "mark as done", the two lists, and the
// conversion to and from the server's rows.
import { describe, expect, test } from "vitest";

import {
  EMPTY_STATE, bracesOf, hasBracket, tryBraces, wholeArchBraces, bridgeOf, changedTeeth, completeAction, confirmNote, fromItems, items, planAndDone, shownStatus,
  surfaceAction, toItems, toolAction, toothState, tryBridge, tstat, type ChartState, type Ctx, type Tool,
} from "@/features/dental/anatomical/model";
import type { ChartItem } from "@/features/dental/api";

const T = "2026-10-14";
const ctx = (over: Partial<Ctx> = {}): Ctx => ({ sel: 16, tool: "caries", stat: "existing", fillMat: "composite", crownMat: "zirconia", dentition: "adult", ...over });
const tool = (s: ChartState, t: Tool, over: Partial<Ctx> = {}) => toolAction(s, ctx({ tool: t, ...over }));
const words = (s: ChartState, n: number) => items(s, n, T).map((i) => `${i.t} (${i.s})`);
/** A mouth with the given teeth missing. */
const gone = (...ns: number[]): ChartState => ({ teeth: Object.fromEntries(ns.map((n) => [n, { surf: {}, missing: { s: "existing" } }])), bridges: [], braces: [] });

describe("REG-FE-ANAT2 rules", () => {
  test("REG-FE-ANAT2-001 caries and fillings go on surfaces; an existing or done filling replaces the caries, a planned one does not", () => {
    let s = surfaceAction(EMPTY_STATE, ctx({ tool: "caries" }), "O").state;
    expect(words(s, 16)).toEqual(["caries, top (existing)"]);
    const planned = surfaceAction(s, ctx({ tool: "filling", stat: "planned" }), "O");
    expect(planned.msg).toBe("Composite filling (to be done) on the top of 16.");
    expect(words(planned.state, 16)).toEqual(["caries, top (existing)", "composite filling, top (planned)"]);
    s = surfaceAction(s, ctx({ tool: "filling", fillMat: "amalgam", stat: "existing" }), "O").state;
    expect(words(s, 16)).toEqual(["amalgam filling, top (existing)"]);
    // The same filling again takes it off.
    const off = surfaceAction(s, ctx({ tool: "filling", fillMat: "amalgam", stat: "existing" }), "O");
    expect(off.msg).toBe("Filling removed.");
    expect(words(off.state, 16)).toEqual([]);
    expect(surfaceAction(EMPTY_STATE, ctx({ tool: "caries" }), "B").msg).toBe("Caries marked on the cheek side of 16.");
  });

  test("REG-FE-ANAT2-002 nothing is marked on a missing tooth or under a real crown, and the reasons say why", () => {
    const m = gone(16);
    expect(surfaceAction(m, ctx({ tool: "caries" }), "O")).toMatchObject({ err: true, msg: "This tooth is missing." });
    expect(tool(m, "filling")).toMatchObject({ err: true, msg: "This tooth is missing, so it has no surfaces to mark." });
    expect(tool(m, "crown")).toMatchObject({ err: true, msg: "This tooth is missing. Use Missing to bring it back, or Clear tooth." });
    const crowned = tool(EMPTY_STATE, "crown", { stat: "existing" }).state;
    expect(surfaceAction(crowned, ctx({ tool: "caries" }), "O")).toMatchObject({ err: true, msg: "This tooth is covered by a crown." });
    expect(tool(crowned, "caries")).toMatchObject({ err: true, msg: "This tooth is covered by a crown, so its surfaces are hidden." });
    // A planned crown does not cover the tooth yet.
    const planned = tool(EMPTY_STATE, "crown", { stat: "planned" }).state;
    expect(surfaceAction(planned, ctx({ tool: "caries" }), "O").err).toBeFalsy();
    expect(tool(EMPTY_STATE, "caries").msg).toBe("Now tap a surface below.");
  });

  test("REG-FE-ANAT2-003 crown and root canal toggle with their material and status", () => {
    const c = tool(EMPTY_STATE, "crown", { stat: "planned", crownMat: "pfm" });
    expect(c.msg).toBe("Porcelain-metal crown (to be done) on 16.");
    expect(words(c.state, 16)).toEqual(["porcelain-metal crown (planned)"]);
    expect(tool(c.state, "crown").msg).toBe("Crown removed.");
    const r = tool(EMPTY_STATE, "rct", { stat: "done" });
    expect(r.msg).toBe("Root canal (done today) on 16.");
    expect(tool(r.state, "rct").msg).toBe("Root canal removed.");
  });

  test("REG-FE-ANAT2-004 extraction: refused as already in mouth, planned turns the tooth red, done today makes it missing (extracted)", () => {
    expect(tool(EMPTY_STATE, "extract", { stat: "existing" })).toMatchObject({ err: true, msg: 'For a tooth that is already gone, use Missing. Extraction is for "To be done" or "Done today".' });
    const p = tool(EMPTY_STATE, "extract", { stat: "planned" });
    expect(p.msg).toBe("Extraction of 16 planned. The tooth is shown in red.");
    expect(toothState(p.state, 16).extP).toBe(true);
    expect(tool(p.state, "extract", { stat: "planned" }).msg).toBe("Planned extraction removed.");
    const d = tool(EMPTY_STATE, "extract", { stat: "done" });
    expect(d.msg).toBe("Tooth 16 extracted today.");
    expect(words(d.state, 16)).toEqual(["extracted (done)"]);
    expect(toothState(d.state, 16).ghost).toBe(true);
  });

  test("REG-FE-ANAT2-005 missing toggles; a tooth with an implant or in a bridge cannot be toggled", () => {
    const m = tool(EMPTY_STATE, "missing");
    expect(m.msg).toBe("Tooth 16 marked as missing.");
    expect(tool(m.state, "missing").msg).toBe("Tooth 16 is back.");
    const imp = tool(m.state, "implant").state;
    expect(tool(imp, "missing")).toMatchObject({ err: true, msg: "This tooth has an implant. Tap Implant again to remove it first." });
  });

  test("REG-FE-ANAT2-006 implant only on a missing tooth; removing it leaves the tooth missing; never on baby teeth", () => {
    expect(tool(EMPTY_STATE, "implant")).toMatchObject({ err: true, msg: "An implant replaces a missing tooth. Mark this tooth as Missing first (or extract it)." });
    const s = tool(gone(16), "implant", { crownMat: "gold", stat: "planned" });
    expect(s.msg).toBe("Implant added.");
    expect(words(s.state, 16)).toEqual(["implant with gold crown (planned)"]);
    expect(toothState(s.state, 16).allPlan).toBe(true);
    const off = tool(s.state, "implant");
    expect(off.msg).toBe("Implant removed. The tooth is back to missing.");
    expect(words(off.state, 16)).toEqual(["missing (existing)"]);
    expect(tool(gone(54), "implant", { sel: 54, dentition: "child" })).toMatchObject({ err: true, msg: "Implants are not used for baby teeth." });
  });

  test("REG-FE-ANAT2-007 a bridge: start, end, the teeth it covers; every refusal in words", () => {
    const start = tool(EMPTY_STATE, "bridge", { sel: 13 });
    expect(start).toMatchObject({ msg: "Bridge starts at 13. Now tap the natural tooth on the other side of the gap.", bridgeStart: 13 });
    const m = gone(14, 15);
    const ok = tryBridge(m, 13, 16, ctx({ crownMat: "zirconia", stat: "existing" }));
    expect(ok.msg).toBe("Bridge 16–13 added.");
    expect(ok.state.bridges).toEqual([{ a: 13, b: 16, m: "zirconia", s: "existing" }]);
    expect(bridgeOf(ok.state, 15)).toMatchObject({ role: "pontic", units: [16, 15, 14, 13] });
    expect(bridgeOf(ok.state, 13)?.role).toBe("abut");
    expect(words(ok.state, 16)).toEqual(["zirconia bridge 16–13 (existing)"]);
    expect(words(ok.state, 14)).toEqual(["zirconia bridge 16–13, replacement tooth (existing)"]);
    expect(words(ok.state, 13)).toEqual(["bridge crown (part of bridge 16–13) (existing)"]);
    const no = (a: number, b: number, s: ChartState) => tryBridge(s, a, b, ctx());
    expect(no(13, 13, m).msg).toBe("Pick a different tooth for the other end of the bridge.");
    expect(no(13, 43, m).msg).toBe("A bridge has to stay in one jaw. Pick a tooth in the same jaw.");
    expect(no(13, 12, m).msg).toBe("These teeth are next to each other. A bridge needs at least one missing tooth between its two ends.");
    expect(no(12, 17, gone(13, 14, 15, 16)).msg).toBe("A bridge can replace at most 3 missing teeth. Pick end teeth closer together.");
    expect(no(14, 17, m).msg).toBe("Tooth 14 is missing. Both ends of a bridge must be natural teeth.");
    expect(no(13, 17, m).msg).toBe("A bridge fills the space of missing teeth, but 16 is not missing. Mark it as Missing first.");
    expect(no(12, 16, gone(14)).msg).toBe("A bridge fills the space of missing teeth, but 15, 13 are not missing. Mark them as Missing first.");
    expect(no(13, 16, ok.state).msg).toBe("Some of these teeth are already part of a bridge.");
    expect(tool(EMPTY_STATE, "bridge", { sel: 54, dentition: "child" }).msg).toBe("Bridges are not used for baby teeth.");
    expect(tool(gone(16), "bridge").msg).toBe("Select a natural tooth at one end of the gap first, then tap Bridge.");
    // On the bridge: no crown on its ends, no Missing, no Extraction; Clear removes the whole bridge.
    expect(tool(ok.state, "crown", { sel: 13 }).msg).toBe("Bridge end teeth already have crowns.");
    expect(tool(ok.state, "missing", { sel: 14 }).msg).toBe("This tooth is part of a bridge. Use Clear tooth to remove the bridge first.");
    expect(tool(ok.state, "extract", { sel: 13, stat: "planned" }).msg).toBe("This tooth is part of a bridge. Use Clear tooth first.");
    expect(surfaceAction(ok.state, ctx({ sel: 16 }), "O").msg).toBe("This tooth is covered by a crown.");
    const cleared = tool(ok.state, "clear", { sel: 15 });
    expect(cleared.msg).toBe("Tooth 15 cleared.");
    expect(cleared.state.bridges).toEqual([]);
  });

  test("REG-FE-ANAT2-008 'mark planned work as done' finishes every planned item on the tooth and its bridge", () => {
    let s = tool(EMPTY_STATE, "crown", { stat: "planned" }).state;
    s = tool(s, "rct", { stat: "planned" }).state;
    const c = completeAction(s, 16);
    expect(c.msg).toBe("Planned work on 16 marked as done.");
    expect(words(c.state, 16)).toEqual(["zirconia crown (done)", "root canal (done)"]);
    let f = surfaceAction(EMPTY_STATE, ctx({ tool: "caries" }), "M").state;
    f = surfaceAction(f, ctx({ tool: "filling", stat: "planned" }), "M").state;
    expect(words(completeAction(f, 16).state, 16)).toEqual(["composite filling, front side (done)"]);
    const ext = tool(EMPTY_STATE, "extract", { stat: "planned" }).state;
    expect(words(completeAction(ext, 16).state, 16)).toEqual(["extracted (done)"]);
    const b = tryBridge(gone(14, 15), 13, 16, ctx({ stat: "planned" })).state;
    expect(completeAction(b, 15).state.bridges[0].s).toBe("done");
  });

  test("REG-FE-ANAT2-009 the tooth number's colour: planned red, done today green; work done on an earlier day is simply in the mouth", () => {
    expect(tstat(tool(EMPTY_STATE, "rct", { stat: "planned" }).state, 16, T)).toBe("pl");
    expect(tstat(tool(EMPTY_STATE, "rct", { stat: "done" }).state, 16, T)).toBe("dn");
    const earlier: ChartState = { teeth: { 16: { surf: {}, rct: { s: "done", on: "2026-10-01" } } }, bridges: [], braces: [] };
    expect(tstat(earlier, 16, T)).toBe("");
    expect(shownStatus({ s: "done", on: "2026-10-01" }, T)).toBe("existing");
    expect(shownStatus({ s: "done", on: T }, T)).toBe("done");
  });

  test("REG-FE-ANAT2-010 the plan and done-today lists name each item once, a bridge once", () => {
    let s = tryBridge(gone(14, 15), 13, 16, ctx({ stat: "planned" })).state;
    s = tool(s, "rct", { sel: 21, stat: "done" }).state;
    s = surfaceAction(s, ctx({ sel: 36, tool: "filling", stat: "planned", fillMat: "amalgam" }), "O").state;
    const l = planAndDone(s, T, "adult");
    expect(l.plan).toEqual(["zirconia bridge 16–13", "36 · amalgam filling, top"]);
    expect(l.done).toEqual(["21 · root canal"]);
  });

  test("REG-FE-ANAT2-011 rows from the server become the chart and back, every kind, with notes and done days", () => {
    const rows: ChartItem[] = [
      { id: "1", tooth: 16, kind: "caries", surface: "O", status: "existing" },
      { id: "2", tooth: 16, kind: "filling", surface: "M", material: "amalgam", status: "done", done_on: T },
      { id: "3", tooth: 26, kind: "crown", material: "pfm", status: "existing", note: "Migrated: material not recorded." },
      { id: "4", tooth: 26, kind: "root_canal", status: "planned" },
      { id: "5", tooth: 38, kind: "extraction", status: "planned" },
      { id: "6", tooth: 46, kind: "missing", status: "existing" },
      { id: "7", tooth: 46, kind: "implant", material: "zirconia", status: "planned" },
      { id: "8", tooth: 14, kind: "missing", status: "existing" },
      { id: "9", tooth: 13, kind: "bridge", bridge_end: 15, material: "gold", status: "existing" },
    ];
    const s = fromItems(rows);
    expect(s.teeth[26].notes).toEqual({ "crown|": "Migrated: material not recorded." });
    expect(s.teeth[16].surf.M?.fill).toEqual({ m: "amalgam", s: "done", on: T });
    expect(s.bridges).toEqual([{ a: 13, b: 15, m: "gold", s: "existing" }]);
    expect(toItems(s, 16)).toEqual([
      { kind: "caries", surface: "O", status: "existing" },
      { kind: "filling", surface: "M", material: "amalgam", status: "done" },
    ]);
    expect(toItems(s, 46)).toEqual([{ kind: "implant", material: "zirconia", status: "planned" }, { kind: "missing", status: "existing" }]);
    expect(toItems(s, 13)).toEqual([{ kind: "bridge", bridge_end: 15, material: "gold", status: "existing" }]);
    expect(toItems(s, 38)).toEqual([{ kind: "extraction", status: "planned" }]);
    expect(toItems(s, 26)).toEqual([{ kind: "crown", material: "pfm", status: "existing" }, { kind: "root_canal", status: "planned" }]);
    expect(fromItems(undefined)).toEqual({ teeth: {}, bridges: [], braces: [] });
  });

  test("REG-FE-ANAT2-012 only the teeth that changed are sent; clearing a bridge's pontic sends the bridge's own tooth", () => {
    const s = tryBridge(gone(14, 15), 13, 16, ctx()).state;
    const cleared = tool(s, "clear", { sel: 15 }).state;
    expect(changedTeeth(s, cleared)).toEqual([13, 15]);
    expect(changedTeeth(s, s)).toEqual([]);
    const c = confirmNote({ teeth: { 26: { surf: {}, notes: { "crown|": "x" } } }, bridges: [], braces: [] }, 26, "crown|");
    expect(c.teeth[26].notes).toBeUndefined();
  });

  test("REG-FE-ANAT2-013 a refused action leaves the chart exactly as it was", () => {
    const s = gone(16);
    const o = tool(s, "crown");
    expect(o.err).toBe(true);
    expect(o.state).toBe(s);
  });

  test("REG-FE-ANAT2-014 braces: start on a tooth, end on another in the same jaw; metal or ceramic; with every status", () => {
    const start = tool(EMPTY_STATE, "braces", { sel: 17 });
    expect(start).toMatchObject({ msg: "Braces start at 17. Now tap the last tooth of the braces, or tap Whole arch.", bracesStart: 17 });
    const b = tryBraces(EMPTY_STATE, 17, 27, ctx({ braceMat: "ceramic", stat: "planned" }));
    expect(b.msg).toBe("Ceramic braces 17–27 added.");
    expect(b.state.braces).toEqual([{ a: 17, b: 27, m: "ceramic", s: "planned" }]);
    expect(bracesOf(b.state, 11)?.units).toEqual([17, 16, 15, 14, 13, 12, 11, 21, 22, 23, 24, 25, 26, 27]);
    expect(bracesOf(b.state, 18)).toBeNull();
    expect(bracesOf(b.state, 41)).toBeNull();
    expect(words(b.state, 11)).toEqual(["ceramic braces 17–27 (planned)"]);
    expect(tstat(b.state, 22, T)).toBe("pl");
    // Listed once in the plan.
    expect(planAndDone(b.state, T, "adult").plan).toEqual(["17 · ceramic braces 17–27"]);
    // Fitted today: "mark planned work as done" on any of its teeth.
    const done = completeAction(b.state, 12).state;
    expect(done.braces[0].s).toBe("done");
    expect(planAndDone(done, T, "adult").done).toEqual(["17 · ceramic braces 17–27"]);
  });

  test("REG-FE-ANAT2-015 braces refusals in words; a missing tooth inside gets no bracket; Clear keeps them; Braces again removes them", () => {
    const no = (a: number, b: number, s: ChartState = EMPTY_STATE) => tryBraces(s, a, b, ctx()).msg;
    expect(no(17, 17)).toBe("Pick a different tooth for the other end of the braces.");
    expect(no(17, 47)).toBe("Braces stay on one jaw. Pick the last tooth in the same jaw.");
    expect(no(17, 27, gone(27))).toBe("Tooth 27 is missing. Start and end the braces on teeth that are there.");
    expect(tool(gone(16), "braces").msg).toBe("Start the braces on a tooth that is there.");
    const on = tryBraces(gone(12), 17, 27, ctx()).state;
    expect(no(14, 24, on)).toBe("This jaw already has braces. Remove them first (tap Braces on one of their teeth).");
    expect(hasBracket(on, 12)).toBe(false); // missing: no bracket
    expect(hasBracket(on, 11)).toBe(true);
    const cleared = tool(on, "clear", { sel: 11 });
    expect(cleared.msg).toBe("Tooth 11 cleared. The braces stay — tap Braces to remove them.");
    expect(cleared.state.braces).toHaveLength(1);
    const off = tool(on, "braces", { sel: 23 });
    expect(off.msg).toBe("Metal braces 17–27 removed.");
    expect(off.state.braces).toEqual([]);
    // A child's braces; changing only the braces sends only their first tooth.
    const kid = tryBraces(EMPTY_STATE, 85, 75, ctx({ dentition: "child" }));
    expect(kid.msg).toBe("Metal braces 85–75 added.");
    expect(changedTeeth(EMPTY_STATE, kid.state)).toEqual([85]);
    expect(toItems(kid.state, 85)).toEqual([{ kind: "braces", bridge_end: 75, material: "metal", status: "existing" }]);
    expect(fromItems([{ id: "x", tooth: 85, kind: "braces", bridge_end: 75, material: "metal", status: "existing" }]).braces).toEqual([{ a: 85, b: 75, m: "metal", s: "existing" }]);
  });

  test("REG-FE-ANAT2-016 Whole arch: second molar to second molar from the teeth that are there; a child's whole jaw", () => {
    expect(wholeArchBraces(EMPTY_STATE, ctx({ sel: 11 })).msg).toBe("Metal braces 17–27 added.");
    expect(wholeArchBraces(gone(17, 37), ctx({ sel: 36 })).msg).toBe("Metal braces 47–36 added.");
    expect(wholeArchBraces(EMPTY_STATE, ctx({ sel: 54, dentition: "child" })).msg).toBe("Metal braces 55–65 added.");
    const all = gone(...[18, 17, 16, 15, 14, 13, 12, 11, 21, 22, 23, 24, 25, 26, 27, 28].filter((n) => n !== 11));
    expect(wholeArchBraces(all, ctx({ sel: 11 })).msg).toBe("This jaw does not have enough teeth for braces.");
  });
});

