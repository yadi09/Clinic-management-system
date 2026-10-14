// The anatomical tooth chart's drawing rules, ported from dental-chart-reference.html.
//
// Everything here is copied from the reference as-is — the shapes (P, TV), the crown
// extents (EXT), the scale (S, MM), the colours, and the side/quadrant logic (mir,
// isUp, sideRegions, topRegions, layout). Only the data shape is ours: the reference
// keeps {surf, crown, rct, missing, pos:{rot, tilt, bl, vert, gap}}; the app stores
// ToothAnatomy {surfaces, crown, root_canal, missing, rotation, tipping,
// buccal_lingual, vertical, gap_mesial}. Change a number here and the chart stops
// matching the reference.
import type { SurfaceKey, ToothAnatomy } from "@/features/dental/api";

/* ---------- Colours and scale ---------- */
export const C = { caries: "#E24B4A", filling: "#378ADD", crown: "#EF9F27", rct: "#7F77DD", gap: "#1D9E75" } as const;
export const S = 0.65; // drawing scale of a tooth in the chart
export const MM = 4; // chart pixels per mm of gap (deliberately enlarged so gaps are visible)

export type ToothType = "inc" | "can" | "pre" | "mol";

/* ---------- Tooth shapes (local box 40 wide x 100 tall, crown at bottom) ---------- */
// c = crown path, r = root paths, l = root canal lines
export const P: Record<ToothType, { c: string; r: string[]; l: string[] }> = {
  inc: { c: "M10,60 L30,60 L32,95 Q20,99 8,95 Z", r: ["M12,60 Q14,10 20,4 Q26,10 28,60 Z"], l: ["M20,57 L20,14"] },
  can: { c: "M10,60 L30,60 L31,88 L20,99 L9,88 Z", r: ["M12,60 Q15,2 20,0 Q25,2 28,60 Z"], l: ["M20,57 L20,8"] },
  pre: { c: "M8,60 L32,60 Q34,85 30,94 Q25,99 20,93 Q15,99 10,94 Q6,85 8,60 Z", r: ["M12,60 Q15,12 20,8 Q25,12 28,60 Z"], l: ["M20,57 L20,16"] },
  mol: {
    c: "M4,60 L36,60 Q38,86 34,94 Q29,99 25,93 Q20,99 15,93 Q11,99 6,94 Q2,86 4,60 Z",
    r: ["M6,60 Q5,20 11,12 Q16,24 17,60 Z", "M23,60 Q24,24 29,12 Q35,20 34,60 Z"],
    l: ["M11,57 L11,22", "M29,57 L29,22"],
  },
};
// horizontal crown extent per type (used to size each tooth's slot so neighbors touch)
export const EXT: Record<ToothType, [number, number]> = { inc: [8, 32], can: [9, 31], pre: [7, 33], mol: [3, 37] };
// top (occlusal) view shapes, local box 40x40: o = outline, g = grooves/cusps
export const TV: Record<ToothType, { o: string; g: string }> = {
  inc: { o: "M5,15 Q20,6 35,15 Q37,22 33,27 Q20,32 7,27 Q3,22 5,15 Z", g: "M9,19 Q20,15 31,19" },
  can: { o: "M6,20 Q12,8 20,6 Q28,8 34,20 Q30,32 20,35 Q10,32 6,20 Z", g: "M12,20 L20,12 L28,20" },
  pre: { o: "M7,12 Q20,3 33,12 Q37,20 33,28 Q20,37 7,28 Q3,20 7,12 Z", g: "M11,20 Q20,17 29,20 M15,12 L15,14 M25,12 L25,14" },
  mol: { o: "M5,6 Q20,1 35,6 Q39,20 35,34 Q20,39 5,34 Q1,20 5,6 Z", g: "M8,20 Q14,17 20,20 Q26,23 32,20 M20,6 Q18,13 20,20 Q22,27 20,34" },
};

/* ---------- Names ---------- */
const NAMES: Record<number, string> = { 1: "central incisor", 2: "lateral incisor", 3: "canine", 4: "first premolar", 5: "second premolar", 6: "first molar", 7: "second molar", 8: "third molar" };
const NAMES_C: Record<number, string> = { 1: "primary central incisor", 2: "primary lateral incisor", 3: "primary canine", 4: "primary first molar", 5: "primary second molar" };
const QN: Record<number, string> = { 1: "Upper right", 2: "Upper left", 3: "Lower left", 4: "Lower right", 5: "Upper right", 6: "Upper left", 7: "Lower left", 8: "Lower right" };
export const SN: Record<SurfaceKey, string> = { O: "occlusal", M: "mesial", D: "distal", B: "buccal", L: "lingual" };
export const SURFACE_ORDER: SurfaceKey[] = ["O", "M", "D", "B", "L"];

/* ---------- Dentitions ---------- */
export type Dentition = "adult" | "child";
export const SETS: Record<Dentition, { up: number[]; lo: number[]; sel: number; label: string }> = {
  adult: { up: [18, 17, 16, 15, 14, 13, 12, 11, 21, 22, 23, 24, 25, 26, 27, 28], lo: [48, 47, 46, 45, 44, 43, 42, 41, 31, 32, 33, 34, 35, 36, 37, 38], sel: 11, label: "Adult (32)" },
  child: { up: [55, 54, 53, 52, 51, 61, 62, 63, 64, 65], lo: [85, 84, 83, 82, 81, 71, 72, 73, 74, 75], sel: 54, label: "Child (20)" },
};

/* ---------- Helpers ---------- */
export const qd = (n: number) => Math.floor(n / 10); // FDI quadrant (1-4 adult, 5-8 child)
export const ty = (n: number): ToothType => {
  const d = n % 10;
  if (d <= 2) return "inc";
  if (d == 3) return "can";
  if (qd(n) >= 5) return "mol";
  return d <= 5 ? "pre" : "mol";
};
export const mir = (n: number) => [1, 4, 5, 8].includes(qd(n)); // patient's right side: mesial faces screen-right
export const isUp = (n: number) => [1, 2, 5, 6].includes(qd(n));
export const dentitionOf = (n: number): Dentition => (qd(n) >= 5 ? "child" : "adult");

/** The reference's position record, read from ours. */
export interface Pos { rot: number; tilt: number; bl: number; vert: number; gap: number }
export const pos = (a?: ToothAnatomy): Pos => ({
  rot: a?.rotation ?? 0, tilt: a?.tipping ?? 0, bl: a?.buccal_lingual ?? 0, vert: a?.vertical ?? 0, gap: a?.gap_mesial ?? 0,
});
export const moved = (a?: ToothAnatomy) => { const q = pos(a); return !!(q.rot || q.tilt || q.bl || q.vert || q.gap); };

export const W = (n: number) => { const e = EXT[ty(n)]; return e[1] - e[0]; };
export const SW = (n: number) => W(n) * S + 0.6; // slot width in chart px

export type Rect = [number, number, number, number];
export function sideRegions(n: number): Record<SurfaceKey, Rect> {
  const m = mir(n);
  return { O: [0, 88, 40, 12], M: [m ? 26 : 0, 60, 14, 28], D: [m ? 0 : 26, 60, 14, 28], B: [14, 60, 12, 14], L: [14, 74, 12, 14] };
}
export function topRegions(n: number): Record<SurfaceKey, Rect> {
  const m = mir(n), u = isUp(n);
  return { O: [12, 12, 16, 16], M: [m ? 28 : 0, 0, 12, 40], D: [m ? 0 : 28, 0, 12, 40], B: [0, u ? 0 : 28, 40, 12], L: [0, u ? 28 : 0, 40, 12] };
}

/* ---------- Arch layout: teeth touch; mesial gaps push teeth apart ---------- */
export interface Slot { n: number; x: number; w: number }
export interface GapSlot { x: number; w: number; g: number }
export function layout(arr: number[], get: (n: number) => ToothAnatomy | undefined) {
  const gp = (n: number) => { const a = get(n); return a?.missing ? 0 : pos(a).gap; };
  let x = 0, mid = 0;
  const items: Slot[] = [], gaps: GapSlot[] = [], h = arr.length / 2 - 1;
  arr.forEach((n, i) => {
    const w = SW(n);
    items.push({ n, x, w });
    x += w;
    if (i < arr.length - 1) {
      const b = arr[i + 1];
      const g = (mir(n) ? gp(n) : 0) + (!mir(b) ? gp(b) : 0);
      if (i == h) mid = x + (g * MM) / 2;
      if (g) { gaps.push({ x, w: g * MM, g }); x += g * MM; }
    }
  });
  return { items, gaps, width: x, mid };
}

/* ---------- Words ---------- */
export function toothName(n: number) {
  return `${QN[qd(n)]} ${qd(n) >= 5 ? NAMES_C[n % 10] : NAMES[n % 10]}`;
}

/** The plain-language findings, in the reference's order. */
export function findings(a?: ToothAnatomy): string[] {
  const f: string[] = [];
  if (!a) return f;
  const q = pos(a);
  if (a.missing) f.push("missing");
  if (a.crown) f.push("crown");
  if (a.root_canal) f.push("root canal");
  // A fixed order, O M D B L: the database keeps object keys in its own order, so
  // following the stored order made the same tooth read differently after a reload.
  for (const k of SURFACE_ORDER) { const v = a.surfaces?.[k]; if (v) f.push(`${v} (${SN[k]})`); }
  if (q.rot) f.push(`rotated ${Math.abs(q.rot)}° ${q.rot > 0 ? "clockwise" : "counterclockwise"}`);
  if (q.tilt) f.push(`tipped ${Math.abs(q.tilt)}° ${q.tilt > 0 ? "mesially" : "distally"}`);
  if (q.bl) f.push(`${Math.abs(q.bl)}mm ${q.bl > 0 ? "buccal" : "lingual"}`);
  if (q.vert) f.push(`${Math.abs(q.vert)}mm ${q.vert > 0 ? "extruded" : "intruded"}`);
  if (q.gap) f.push(`${q.gap}mm gap on mesial side`);
  return f;
}

/** Slider read-outs, as in the reference. */
export const FMT: Record<keyof Pos, (v: number) => string> = {
  rot: (v) => (v ? `${Math.abs(v)}° ${v > 0 ? "cw" : "ccw"}` : "0°"),
  tilt: (v) => (v ? `${Math.abs(v)}° ${v > 0 ? "mes" : "dist"}` : "0°"),
  bl: (v) => (v ? `${Math.abs(v)}mm ${v > 0 ? "buc" : "ling"}` : "0mm"),
  vert: (v) => (v ? `${Math.abs(v)}mm ${v > 0 ? "up" : "down"}` : "0mm"),
  gap: (v) => `${v}mm`,
};
/** The reference's slider ranges, and which stored field each one writes. */
export const SLIDERS: { k: keyof Pos; field: "rotation" | "tipping" | "buccal_lingual" | "vertical" | "gap_mesial"; label: string; min: number; max: number; step: number }[] = [
  { k: "rot", field: "rotation", label: "Rotation", min: -90, max: 90, step: 5 },
  { k: "tilt", field: "tipping", label: "Tipping", min: -30, max: 30, step: 5 },
  { k: "bl", field: "buccal_lingual", label: "Buccal/lingual", min: -3, max: 3, step: 0.5 },
  { k: "vert", field: "vertical", label: "Vertical", min: -3, max: 3, step: 0.5 },
  { k: "gap", field: "gap_mesial", label: "Gap (mesial)", min: 0, max: 6, step: 0.5 },
];

/* ---------- The record ---------- */
export const EMPTY: ToothAnatomy = {
  surfaces: {}, crown: false, root_canal: false, missing: false,
  rotation: 0, tipping: 0, buccal_lingual: 0, vertical: 0, gap_mesial: 0,
};
/** A full record from whatever the server sent (older rows may lack fields). */
export const full = (a?: Partial<ToothAnatomy>): ToothAnatomy => ({ ...EMPTY, ...(a ?? {}), surfaces: { ...(a?.surfaces ?? {}) } });
export const isEmpty = (a?: ToothAnatomy) => !a || (Object.keys(a.surfaces ?? {}).length === 0 && !a.crown && !a.root_canal && !a.missing && !moved(a));

/* ---------- Palmer <-> FDI (the simple chart's numbering, for permanent teeth) ---------- */
const PALMER_Q: Record<number, string> = { 1: "UR", 2: "UL", 3: "LL", 4: "LR" };
const FDI_Q: Record<string, number> = { UR: 1, UL: 2, LL: 3, LR: 4 };
/** "UR1" for 11; undefined for a child tooth (the simple chart has none). */
export const palmerOf = (n: number): string | undefined => (PALMER_Q[qd(n)] ? `${PALMER_Q[qd(n)]}${n % 10}` : undefined);
/** 11 for "UR1"; undefined for anything that is not a Palmer code. */
export const fdiOf = (code: string): number | undefined => {
  const m = /^(UR|UL|LL|LR)([1-8])$/.exec(code);
  return m ? FDI_Q[m[1]] * 10 + Number(m[2]) : undefined;
};
