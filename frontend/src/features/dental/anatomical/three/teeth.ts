// The 3D teeth, procedural: real tooth sizes (mm) and the shapes built from them.
// Ported from section 3 of dental-chart-reference_3d.html — WID, TORQ, TIP, OB,
// dims(), crownGeo(), rootSpecs(), implantGeos() — numbers unchanged: they encode real
// dental anatomy. To use professional models later, replace crownGeo()/rootSpecs()
// with loaded GLB geometry; scene.ts asks only for these.
import * as THREE from "three";

import { isUp, qd, ty, type ToothType } from "@/features/dental/anatomical/geometry";

export const sm = (a: number, b: number, x: number) => { x = Math.min(1, Math.max(0, (x - a) / (b - a))); return x * x * (3 - 2 * x); };
const se = (a: number, e: number) => Math.sign(a) * Math.pow(Math.abs(a), e);

/** Real mesiodistal widths in mm. */
export const WID = { u: [0, 8.5, 6.5, 7.6, 7, 6.6, 10.2, 9, 8.5], l: [0, 5.4, 5.9, 6.9, 7, 7.1, 11, 10.5, 10], cu: [0, 6.5, 5.1, 7, 7.3, 8.2], cl: [0, 4.2, 4.6, 5.2, 7.7, 9.9] };
/** Natural inclination (torque), angulation (tip), overbite. */
export const TORQ = { u: [0, 16, 12, 6, -4, -4, -6, -6, -6], l: [0, 8, 8, 0, -8, -10, -12, -14, -14] };
export const TIP = { u: [0, 5, 8, 10, 2, 2, 4, 4, 4], l: [0, 2, 2, 5, 2, 2, 2, 2, 2] };
export const OB: Record<number, number> = { 1: -2, 2: -1.6, 3: -1.1 };

export interface Dims { w: number; dp: number; h: number; L: number; t: ToothType; c: boolean; u: boolean; d: number; torq: number; tip: number; ob: number }

export function dims(n: number): Dims {
  const d = n % 10, c = qd(n) >= 5, u = isUp(n), t = ty(n), f = c ? 0.8 : 1, ni = c && d >= 4 ? d + 2 : d, nf = c ? 0.5 : 1;
  const w = (c ? (u ? WID.cu : WID.cl) : u ? WID.u : WID.l)[d];
  const dp = { inc: u ? 7 : 6, can: u ? 8 : 7.6, pre: u ? 9 : 8, mol: u ? 11 : 10.4 }[t] * f;
  const h = { inc: u ? 9.8 : 8.8, can: u ? 9.6 : 10, pre: 8, mol: 7.3 }[t] * (c ? 0.74 : 1);
  const L = { inc: u ? 13 : 12.5, can: u ? 17 : 16, pre: 14, mol: u ? 12.5 : 13.5 }[t] * (c ? 0.62 : 1);
  return { w, dp, h, L, t, c, u, d, torq: (u ? TORQ.u : TORQ.l)[ni] * nf, tip: (u ? TIP.u : TIP.l)[ni] * nf, ob: u && d <= 3 ? (OB[d] || 0) * (c ? 0.5 : 1) : 0 };
}

/** The crown: a deformed sphere with cusps, grooves and enamel shading in vertex colours. */
export function crownGeo(m: Dims): THREE.BufferGeometry {
  const { w, dp, h, t, c } = m, g = new THREE.SphereGeometry(1, 72, 56), p = g.attributes.position, col = new Float32Array(p.count * 3);
  const ex = { inc: 0.78, can: 0.82, pre: 0.64, mol: 0.52 }[t], ey = { inc: 0.62, can: 0.85, pre: 0.55, mol: 0.45 }[t];
  // The reference built these as linear colours (convertSRGBToLinear); vertex colours are linear.
  const lin = (hx: number) => new THREE.Color(hx);
  const cC = lin(c ? 0xe9dcbd : 0xd6bf93), cB = lin(c ? 0xf3efe6 : 0xebe2cf), cE = lin(0xcfd6db), tmp = new THREE.Color();
  for (let i = 0; i < p.count; i++) {
    const y0 = p.getY(i), t1 = (y0 + 1) / 2;
    const x = se(p.getX(i), ex), z = se(p.getZ(i), ex);
    let Y = ((se(y0, ey) + 1) / 2) * h;
    const k = 0.7 + 0.3 * sm(0, 0.5, t1);
    let kx = k, kz = k;
    if (t === "inc") { kz *= 1 - 0.72 * sm(0.3, 1, t1); kx *= 1 + 0.06 * sm(0.4, 1, t1); }
    if (t === "can") { const a = sm(0.42, 1, t1); kz *= 1 - 0.5 * a; kx *= 1 - 0.6 * a; Y += h * 0.06 * a * (1 - Math.min(1, Math.abs(x) * 1.6)); }
    if (t === "pre") kz *= 1 - 0.12 * sm(0.6, 1, t1);
    if (t === "mol") kx *= 1 - 0.05 * sm(0.7, 1, t1);
    let gr = 0;
    if ((t === "mol" || t === "pre") && y0 > 0) {
      const wt = sm(0.55, 1, t1);
      let b = 0;
      const cs = t === "mol" ? [[-0.45, 0.42], [0.45, 0.42], [-0.45, -0.42], [0.42, -0.45]] : [[0, 0.45], [0, -0.45]];
      cs.forEach(([cx, cz]) => (b += Math.exp(-((x - cx) ** 2 + (z - cz) ** 2) / 0.11)));
      gr = Math.exp((-z * z) / 0.022);
      if (t === "mol") gr += 0.75 * Math.exp((-x * x) / 0.022) * (1 - Math.min(1, z * z * 2));
      Y += h * wt * (0.15 * b - 0.13 * gr);
      gr *= wt;
    }
    p.setXYZ(i, ((x * w) / 2) * kx, Y, ((z * dp) / 2) * kz);
    tmp.copy(cC).lerp(cB, sm(0.05, 0.5, t1));
    if (t === "inc" || t === "can") tmp.lerp(cE, 0.6 * sm(0.78, 1, t1));
    const sh = (1 - 0.3 * sm(0.68, 1, Math.abs(x))) * (1 - 0.25 * Math.min(1, gr));
    tmp.multiplyScalar(sh);
    col.set([tmp.r, tmp.g, tmp.b], i * 3);
  }
  g.setAttribute("color", new THREE.BufferAttribute(col, 3));
  g.computeVertexNormals();
  return g;
}

function lathe(r0: number, len: number) {
  const pts: THREE.Vector2[] = [];
  for (let i = 0; i <= 18; i++) { const s = i / 18; pts.push(new THREE.Vector2(Math.max(0.02, r0 * Math.pow(1 - s, 0.5) * (1 - 0.2 * s)), 1 - s * len)); }
  return new THREE.LatheGeometry(pts, 28);
}
function canal(len: number) {
  const g = new THREE.CylinderGeometry(0.32, 0.12, len * 0.85, 10);
  g.translate(0, 1 - len * 0.45, 0);
  return g;
}

export interface RootSpec { geo: THREE.BufferGeometry; cn: THREE.BufferGeometry; x: number; z: number; rx: number; rz: number; sx: number }

/** The roots (and their canals): one, two or three, splayed as real roots are. */
export function rootSpecs(m: Dims): RootSpec[] {
  const { w, dp, L, t, c, u, d } = m, out: RootSpec[] = [];
  const add = (r0: number, x: number, z: number, rx: number, rz: number, sx: number, len?: number) =>
    out.push({ geo: lathe(r0, len || L), cn: canal(len || L), x, z, rx, rz, sx });
  if (t === "inc" || t === "can") add(Math.min(w, dp) * 0.36, 0, 0, 0, 0, 0.8);
  else if (t === "pre") {
    if (u && !c && d === 4) { add(w * 0.24, 0, dp * 0.2, -0.06, 0, 1); add(w * 0.22, 0, -dp * 0.2, 0.08, 0, 1); }
    else add(Math.min(w, dp) * 0.35, 0, 0, 0, 0, 0.85);
  } else {
    const sp = c ? 2 : 1;
    if (u) { add(w * 0.17, -w * 0.24, dp * 0.2, -0.06, -0.1 * sp, 1); add(w * 0.17, w * 0.24, dp * 0.2, -0.06, 0.1 * sp, 1); add(w * 0.19, 0, -dp * 0.24, 0.16, 0, 1, L * 1.05); }
    else { add(w * 0.2, -w * 0.25, 0, 0, -0.09 * sp, 0.75); add(w * 0.2, w * 0.25, 0, 0, 0.09 * sp, 0.75); }
  }
  return out;
}

/** An implant: the screw with its threads, and the abutment. */
export function implantGeos(m: Dims): THREE.BufferGeometry[] {
  const r = Math.min(m.w, m.dp) * 0.2, len = Math.min(m.L * 0.85, 12), out: THREE.BufferGeometry[] = [];
  out.push(new THREE.CylinderGeometry(r, r * 0.7, len, 24).translate(0, -len / 2 + 0.4, 0));
  for (let i = 0; i < 7; i++) { const f = 1 - (0.28 * i) / 6; out.push(new THREE.TorusGeometry(r * f * 1.04, r * 0.13, 8, 28).rotateX(Math.PI / 2).translate(0, -1.2 - (i * (len - 2.2)) / 6, 0)); }
  out.push(new THREE.CylinderGeometry(r * 0.75, r * 1.05, 2.4, 20).translate(0, 1.2, 0));
  return out;
}
