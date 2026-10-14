// The anatomical chart's data model and business rules, shared by every view of it
// (2D now, 3D next). Ported from section 1 of dental-chart-reference_3d.html —
// bridgeOf, items, toolAction, surfaceAction, completeAction, tryBridge — with the
// same rules and the same plain-language messages. The difference is the shape:
// every function here is pure (state in, new state out), so a change can be undone,
// saved, or refused by the server and put back.
//
// The server (internal/dental/service/chart_items.go) enforces the same rules on
// every save; keep the two in step.
import type { ChartItem, CrownMaterial, FillMaterial, ItemInput, ItemStatus, Position, SurfaceKey } from "@/features/dental/api";
import { SETS, isUp, type Dentition } from "@/features/dental/anatomical/geometry";

export type Status = ItemStatus;
/** A status-bearing record. `on` is the clinic day it became done (absent until saved). */
export interface Rec<M = never> { m: M; s: Status; on?: string }
export interface StatusOnly { s: Status; on?: string }
export interface SurfRec { car?: true; fill?: Rec<FillMaterial> }
export interface ToothRec {
  surf: Partial<Record<SurfaceKey, SurfRec>>;
  crown?: Rec<CrownMaterial>;
  rct?: StatusOnly;
  implant?: Rec<CrownMaterial>;
  ext?: { s: "planned" };
  /** Missing; s "done" = extracted in a visit (on = that day). */
  missing?: StatusOnly;
  /** Notes kept by the server on items (e.g. "material not recorded"), by item key. */
  notes?: Record<string, string>;
}
export interface Bridge { a: number; b: number; m: CrownMaterial; s: Status; on?: string; note?: string }
export interface ChartState { teeth: Record<number, ToothRec>; bridges: Bridge[] }

export type Tool = "caries" | "filling" | "crown" | "rct" | "extract" | "missing" | "implant" | "bridge" | "clear";
export interface Ctx { sel: number; tool: Tool; stat: Status; fillMat: FillMaterial; crownMat: CrownMaterial; dentition: Dentition }
export interface Outcome { state: ChartState; msg: string; err?: boolean; bridgeStart?: number | null }

export const EMPTY_STATE: ChartState = { teeth: {}, bridges: [] };

/* ---------- Words (the reference's ML, SN, SL) ---------- */
export const ML: Record<string, string> = { composite: "composite", amalgam: "amalgam", zirconia: "zirconia", pfm: "porcelain-metal", gold: "gold", steel: "stainless steel" };
export const SN: Record<SurfaceKey, string> = { O: "top", M: "front side", D: "back side", B: "cheek side", L: "tongue side" };
export const SL: Record<Status, string> = { existing: "already in mouth", planned: "to be done", done: "done today" };
const cap = (s: string) => s[0].toUpperCase() + s.slice(1);

/* ---------- Reading ---------- */
const clone = (s: ChartState): ChartState => JSON.parse(JSON.stringify(s)) as ChartState;
export const toothOf = (s: ChartState, n: number): ToothRec => s.teeth[n] ?? { surf: {} };
const arrOf = (n: number, dentition: Dentition) => (isUp(n) ? SETS[dentition].up : SETS[dentition].lo);
export const dentitionOf = (n: number): Dentition => (Math.floor(n / 10) >= 5 ? "child" : "adult");

export interface BridgeRole { b: Bridge; role: "abut" | "pontic"; units: number[] }
export function bridgeOf(s: ChartState, n: number): BridgeRole | null {
  const dent = dentitionOf(n);
  for (const b of s.bridges) {
    if (isUp(n) !== isUp(b.a) || dentitionOf(b.a) !== dent) continue;
    const ar = arrOf(n, dent), i = ar.indexOf(b.a), j = ar.indexOf(b.b), k = ar.indexOf(n), lo = Math.min(i, j), hi = Math.max(i, j);
    if (k >= lo && k <= hi) return { b, role: k === lo || k === hi ? "abut" : "pontic", units: ar.slice(lo, hi + 1) };
  }
  return null;
}

/** Done in an earlier visit: it is now simply part of the mouth. */
export const doneBefore = (r: { s: Status; on?: string } | undefined, today: string) => !!r && r.s === "done" && !!r.on && r.on !== today;
/** The status as the screen shows it today: an earlier "done" reads as already in mouth. */
export const shownStatus = (r: { s: Status; on?: string }, today: string): Status => (doneBefore(r, today) ? "existing" : r.s);

export interface Line { t: string; s: Status; br?: true; on?: string; key: string }
/** Everything recorded on a tooth, in words (the reference's items()). */
export function items(s: ChartState, n: number, today: string): Line[] {
  const d = toothOf(s, n), br = bridgeOf(s, n), out: Line[] = [];
  const st = (r: { s: Status; on?: string }) => shownStatus(r, today);
  if (br && (br.role === "pontic" || n === br.units[0]))
    out.push({ t: `${ML[br.b.m]} bridge ${br.units[0]}–${br.units[br.units.length - 1]}${br.role === "pontic" ? ", replacement tooth" : ""}`, s: st(br.b), br: true, on: br.b.on, key: "bridge|" });
  if (br && br.role === "abut" && n !== br.units[0])
    out.push({ t: `bridge crown (part of bridge ${br.units[0]}–${br.units[br.units.length - 1]})`, s: st(br.b), br: true, on: br.b.on, key: "bridge|" });
  if (d.implant) out.push({ t: `implant with ${ML[d.implant.m]} crown`, s: st(d.implant), on: d.implant.on, key: "implant|" });
  else if (d.missing && !(br && br.role === "pontic"))
    out.push({ t: d.missing.s === "done" ? "extracted" : "missing", s: st(d.missing), on: d.missing.on, key: "missing|" });
  if (d.ext) out.push({ t: "extraction", s: d.ext.s, key: "extraction|" });
  if (d.crown) out.push({ t: `${ML[d.crown.m]} crown`, s: st(d.crown), on: d.crown.on, key: "crown|" });
  if (d.rct) out.push({ t: "root canal", s: st(d.rct), on: d.rct.on, key: "root_canal|" });
  for (const k of SURFACES) {
    const o = d.surf[k];
    if (!o) continue;
    if (o.car && !(o.fill && o.fill.s !== "planned")) out.push({ t: `caries, ${SN[k]}`, s: "existing", key: `caries|${k}` });
    if (o.fill) out.push({ t: `${ML[o.fill.m]} filling, ${SN[k]}`, s: st(o.fill), on: o.fill.on, key: `filling|${k}` });
  }
  return out;
}
export const SURFACES: SurfaceKey[] = ["O", "M", "D", "B", "L"];

/** "pl" planned work, "dn" work done today, "" neither (the tooth number's colour). */
export function tstat(s: ChartState, n: number, today: string): "pl" | "dn" | "" {
  const ss = items(s, n, today).map((i) => i.s);
  return ss.includes("planned") ? "pl" : ss.includes("done") ? "dn" : "";
}

/** How a tooth is drawn (the reference's toothState()). */
export function toothState(s: ChartState, n: number) {
  const d = toothOf(s, n), br = bridgeOf(s, n), pontic = !!br && br.role === "pontic", imp = d.implant;
  const cr = pontic ? { m: br!.b.m, s: br!.b.s } : imp ? { m: imp.m, s: imp.s } : d.crown ?? (br && br.role === "abut" ? { m: br.b.m, s: br.b.s } : null);
  return {
    d, br, pontic, imp, cr,
    real: !!cr && cr.s !== "planned",
    allPlan: (pontic && br!.b.s === "planned") || (!!imp && imp.s === "planned"),
    ghost: !!d.missing && !imp && !pontic,
    extP: !!d.ext && d.ext.s === "planned",
  };
}

/* ---------- Changing (pure) ---------- */
function rec(s: ChartState, n: number): ToothRec {
  return (s.teeth[n] ??= { surf: {} });
}

export function tryBridge(state: ChartState, a: number, b: number, ctx: Ctx): Outcome {
  const s = clone(state);
  const no = (msg: string): Outcome => ({ state, msg, err: true, bridgeStart: null });
  if (a === b) return no("Pick a different tooth for the other end of the bridge.");
  if (isUp(a) !== isUp(b)) return no("A bridge has to stay in one jaw. Pick a tooth in the same jaw.");
  const ar = arrOf(a, ctx.dentition), i = ar.indexOf(a), j = ar.indexOf(b), units = ar.slice(Math.min(i, j), Math.max(i, j) + 1), mid = units.slice(1, -1);
  if (!mid.length) return no("These teeth are next to each other. A bridge needs at least one missing tooth between its two ends.");
  if (mid.length > 3) return no("A bridge can replace at most 3 missing teeth. Pick end teeth closer together.");
  const ends = [a, b].filter((n) => { const d = toothOf(s, n); return d.missing || d.implant; });
  if (ends.length) return no(`Tooth ${ends[0]} is missing. Both ends of a bridge must be natural teeth.`);
  const notGone = mid.filter((n) => { const d = toothOf(s, n); return !d.missing || d.implant; });
  if (notGone.length) return no(`A bridge fills the space of missing teeth, but ${notGone.join(", ")} ${notGone.length > 1 ? "are" : "is"} not missing. Mark ${notGone.length > 1 ? "them" : "it"} as Missing first.`);
  if (units.some((n) => bridgeOf(s, n))) return no("Some of these teeth are already part of a bridge.");
  s.bridges.push({ a, b, m: ctx.crownMat, s: ctx.stat });
  return { state: s, msg: `Bridge ${units[0]}–${units[units.length - 1]} added.`, bridgeStart: null };
}

/** Pressing a tool for the selected tooth (the reference's toolAction()). */
export function toolAction(state: ChartState, ctx: Ctx, view3d = false): Outcome {
  const s = clone(state), sel = ctx.sel, t = rec(s, sel), br = bridgeOf(s, sel);
  const crownOn = (t.crown && t.crown.s !== "planned") || (br && br.role === "abut");
  const ok = (msg: string): Outcome => ({ state: s, msg, bridgeStart: null });
  const no = (msg: string): Outcome => ({ state, msg, err: true, bridgeStart: null });
  const { tool, stat } = ctx;
  if (tool === "caries" || tool === "filling") {
    if (t.missing || t.implant) return no("This tooth is missing, so it has no surfaces to mark.");
    if (crownOn) return no("This tooth is covered by a crown, so its surfaces are hidden.");
    return { state, msg: "Now tap a surface below.", bridgeStart: null };
  }
  if (tool === "clear") {
    s.teeth[sel] = { surf: {} };
    if (br) s.bridges = s.bridges.filter((x) => !(x.a === br.b.a && x.b === br.b.b));
    return ok(`Tooth ${sel} cleared.`);
  }
  if (tool === "missing") {
    if (br) return no("This tooth is part of a bridge. Use Clear tooth to remove the bridge first.");
    if (t.implant) return no("This tooth has an implant. Tap Implant again to remove it first.");
    if (t.missing) { s.teeth[sel] = { surf: {} }; return ok(`Tooth ${sel} is back.`); }
    s.teeth[sel] = { surf: {}, missing: { s: "existing" } };
    return ok(`Tooth ${sel} marked as missing.`);
  }
  if (tool === "implant") {
    if (ctx.dentition === "child") return no("Implants are not used for baby teeth.");
    if (br) return no("This tooth is part of a bridge.");
    if (t.implant) { delete t.implant; return ok("Implant removed. The tooth is back to missing."); }
    if (!t.missing) return no("An implant replaces a missing tooth. Mark this tooth as Missing first (or extract it).");
    t.implant = { m: ctx.crownMat, s: stat };
    return ok(view3d ? "Implant added. Turn on Show roots to see the screw in the bone." : "Implant added.");
  }
  if (tool === "bridge") {
    if (ctx.dentition === "child") return no("Bridges are not used for baby teeth.");
    if (t.missing || t.implant) return no("Select a natural tooth at one end of the gap first, then tap Bridge.");
    return { state, msg: `Bridge starts at ${sel}. Now tap the natural tooth on the other side of the gap.`, bridgeStart: sel };
  }
  if (t.missing || t.implant) return no("This tooth is missing. Use Missing to bring it back, or Clear tooth.");
  if (tool === "crown") {
    if (br) return no("Bridge end teeth already have crowns.");
    if (t.crown) { delete t.crown; return ok("Crown removed."); }
    t.crown = { m: ctx.crownMat, s: stat };
    return ok(`${cap(ML[ctx.crownMat])} crown (${SL[stat]}) on ${sel}.`);
  }
  if (tool === "rct") {
    if (t.rct) { delete t.rct; return ok("Root canal removed."); }
    t.rct = { s: stat };
    return ok(`Root canal (${SL[stat]}) on ${sel}.`);
  }
  // extract
  if (br) return no("This tooth is part of a bridge. Use Clear tooth first.");
  if (stat === "existing") return no('For a tooth that is already gone, use Missing. Extraction is for "To be done" or "Done today".');
  if (stat === "planned") {
    if (t.ext) { delete t.ext; return ok("Planned extraction removed."); }
    t.ext = { s: "planned" };
    return ok(`Extraction of ${sel} planned. The tooth is shown in red.`);
  }
  s.teeth[sel] = { surf: {}, missing: { s: "done" } };
  return ok(`Tooth ${sel} extracted today.`);
}

/** Tapping a surface with caries or filling (the reference's surfaceAction()). */
export function surfaceAction(state: ChartState, ctx: Ctx, k: SurfaceKey): Outcome {
  const s = clone(state), sel = ctx.sel, t = rec(s, sel), br = bridgeOf(s, sel);
  const no = (msg: string): Outcome => ({ state, msg, err: true });
  if (t.missing || t.implant) return no("This tooth is missing.");
  if ((t.crown && t.crown.s !== "planned") || (br && br.role === "abut")) return no("This tooth is covered by a crown.");
  const o: SurfRec = { ...(t.surf[k] ?? {}) };
  let msg: string;
  if (ctx.tool === "caries") {
    if (o.car) { delete o.car; msg = "Caries removed."; } else { o.car = true; msg = `Caries marked on the ${SN[k]} of ${sel}.`; }
  } else {
    if (o.fill && o.fill.m === ctx.fillMat && o.fill.s === ctx.stat) { delete o.fill; msg = "Filling removed."; }
    else {
      o.fill = { m: ctx.fillMat, s: ctx.stat };
      if (ctx.stat !== "planned") delete o.car;
      msg = `${cap(ML[ctx.fillMat])} filling (${SL[ctx.stat]}) on the ${SN[k]} of ${sel}.`;
    }
  }
  if (o.car || o.fill) t.surf[k] = o; else delete t.surf[k];
  return { state: s, msg };
}

/** "Mark this tooth's planned work as done" (the reference's completeAction()). */
export function completeAction(state: ChartState, sel: number): Outcome {
  const s = clone(state), t = rec(s, sel), br = bridgeOf(s, sel);
  for (const k of SURFACES) {
    const o = t.surf[k];
    if (o?.fill && o.fill.s === "planned") { o.fill.s = "done"; delete o.car; }
  }
  for (const k of ["crown", "rct", "implant"] as const) {
    const r = t[k];
    if (r && r.s === "planned") r.s = "done";
  }
  if (t.ext && t.ext.s === "planned") s.teeth[sel] = { surf: {}, missing: { s: "done" }, notes: t.notes };
  if (br && br.b.s === "planned") {
    const b = s.bridges.find((x) => x.a === br.b.a && x.b === br.b.b);
    if (b) b.s = "done";
  }
  return { state: s, msg: `Planned work on ${sel} marked as done.` };
}

/* ---------- To and from the server's rows ---------- */
export function fromItems(rows: ChartItem[] | undefined): ChartState {
  const s: ChartState = { teeth: {}, bridges: [] };
  for (const r of rows ?? []) {
    const t = rec(s, r.tooth);
    const key = `${r.kind}|${r.surface ?? ""}`;
    if (r.note) (t.notes ??= {})[key] = r.note;
    const st = { s: r.status, ...(r.done_on ? { on: r.done_on } : {}) };
    switch (r.kind) {
      case "caries": (t.surf[r.surface!] ??= {}).car = true; break;
      case "filling": (t.surf[r.surface!] ??= {}).fill = { m: r.material as FillMaterial, ...st }; break;
      case "crown": t.crown = { m: r.material as CrownMaterial, ...st }; break;
      case "implant": t.implant = { m: r.material as CrownMaterial, ...st }; break;
      case "root_canal": t.rct = st; break;
      case "extraction": t.ext = { s: "planned" }; break;
      case "missing": t.missing = st; break;
      case "bridge": s.bridges.push({ a: r.tooth, b: r.bridge_end!, m: r.material as CrownMaterial, ...st, ...(r.note ? { note: r.note } : {}) }); break;
    }
  }
  return s;
}

/** Every item a tooth holds, as the server stores it (a bridge lives on its `a` tooth). */
export function toItems(s: ChartState, n: number): ItemInput[] {
  const t = s.teeth[n], out: ItemInput[] = [];
  if (t) {
    for (const k of SURFACES) {
      const o = t.surf[k];
      if (o?.car) out.push({ kind: "caries", surface: k, status: "existing" });
      if (o?.fill) out.push({ kind: "filling", surface: k, material: o.fill.m, status: o.fill.s });
    }
    if (t.crown) out.push({ kind: "crown", material: t.crown.m, status: t.crown.s });
    if (t.rct) out.push({ kind: "root_canal", status: t.rct.s });
    if (t.implant) out.push({ kind: "implant", material: t.implant.m, status: t.implant.s });
    if (t.ext) out.push({ kind: "extraction", status: "planned" });
    if (t.missing) out.push({ kind: "missing", status: t.missing.s });
  }
  for (const b of s.bridges) if (b.a === n) out.push({ kind: "bridge", bridge_end: b.b, material: b.m, status: b.s });
  return out;
}

/** The teeth whose stored items differ between two states. */
export function changedTeeth(a: ChartState, b: ChartState): number[] {
  const all = new Set<number>([...Object.keys(a.teeth), ...Object.keys(b.teeth)].map(Number));
  for (const x of [...a.bridges, ...b.bridges]) all.add(x.a);
  return [...all].filter((n) => JSON.stringify(toItems(a, n)) !== JSON.stringify(toItems(b, n))).sort((x, y) => x - y);
}

/** Clear a migrated item's note once the dentist has looked at it. */
export function confirmNote(state: ChartState, n: number, key: string): ChartState {
  const s = clone(state), t = s.teeth[n];
  if (t?.notes) { delete t.notes[key]; if (!Object.keys(t.notes).length) delete t.notes; }
  return s;
}

/* ---------- Positions ---------- */
export const NO_POS: Position = { rotation: 0, tipping: 0, buccal_lingual: 0, vertical: 0, gap_mesial: 0 };
export const posEmpty = (p?: Position) => !p || (!p.rotation && !p.tipping && !p.buccal_lingual && !p.vertical && !p.gap_mesial);

/* ---------- The two lists below the chart ---------- */
export function planAndDone(s: ChartState, today: string, dentition: Dentition) {
  const P: string[] = [], D: string[] = [];
  for (const n of [...SETS[dentition].up, ...SETS[dentition].lo]) {
    for (const i of items(s, n, today)) {
      const br = bridgeOf(s, n);
      if (i.br && br && (br.role === "pontic" || n !== br.units[0])) continue;
      const line = i.br ? i.t : `${n} · ${i.t}`;
      if (i.s === "planned") P.push(line);
      if (i.s === "done") D.push(line);
    }
  }
  return { plan: P, done: D };
}
