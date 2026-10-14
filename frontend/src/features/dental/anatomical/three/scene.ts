// The 3D model: the dental arches with gums and papillae, natural tooth angles,
// overbite and curve of Spee, camera presets, drag/zoom/tap, floating labels.
// Ported from section 3 of dental-chart-reference_3d.html (init3D/build3D) onto the
// current Three.js. Two library changes since the reference's r128 are handled so it
// looks the same: colours are colour-managed now (the reference's linear-converted
// colours are plain hex here; the ones it used raw stay raw via `raw()`), and lights
// are physically based (the reference's intensities × π).
//
// It reads the same ChartState as the 2D chart (model.ts) and never writes it: a tap
// only reports the tooth, so both views show one record.
import * as THREE from "three";

import type { Position } from "@/features/dental/api";
import { SETS, isUp, type Dentition } from "@/features/dental/anatomical/geometry";
import { NO_POS, bridgeOf, toothOf, tstat, type ChartState } from "@/features/dental/anatomical/model";
import { crownGeo, dims, implantGeos, rootSpecs, type Dims, type RootSpec } from "@/features/dental/anatomical/three/teeth";

export type View3D = "front" | "open" | "upper" | "lower" | "side" | "custom";
export interface BuildParams { state: ChartState; positions: Record<string, Position>; sel: number; today: string; mode: Dentition; xray: boolean; nums: boolean }
export interface Scene3D { build(p: BuildParams): void; setView(v: View3D): void; dispose(): void }

const V = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z);
/** A colour the reference used without conversion (taken as linear). */
const raw = (h: number) => new THREE.Color().setRGB(((h >> 16) & 255) / 255, ((h >> 8) & 255) / 255, (h & 255) / 255, THREE.LinearSRGBColorSpace);
const PI = Math.PI;

export function createScene(stage: HTMLElement, lbBox: HTMLElement, onSelect: (n: number) => void, onCustomView: () => void): Scene3D {
  let P: BuildParams | null = null;
  let view3d: View3D = "front";

  const R = new THREE.WebGLRenderer({ antialias: true, alpha: true });
  R.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  R.outputColorSpace = THREE.SRGBColorSpace;
  R.toneMapping = THREE.ACESFilmicToneMapping;
  R.toneMappingExposure = 0.82;
  stage.insertBefore(R.domElement, lbBox);
  R.domElement.style.display = "block";

  const scene = new THREE.Scene(), cam = new THREE.PerspectiveCamera(32, 1, 1, 1000);
  const pm = new THREE.PMREMGenerator(R), es = new THREE.Scene();
  es.add(new THREE.Mesh(new THREE.BoxGeometry(100, 100, 100), new THREE.MeshBasicMaterial({ color: raw(0x3a3a3a), side: THREE.BackSide })));
  ([[0, 45, 0, 60, 1, 60, 3], [42, 10, 25, 1, 30, 30, 2.5], [-42, 0, 20, 1, 30, 30, 1.6], [0, 10, -45, 40, 30, 1, 1.2], [0, -5, 45, 50, 20, 1, 2]] as const).forEach(([x, y, z, a, b, c, i]) => {
    const m = new THREE.Mesh(new THREE.BoxGeometry(a, b, c), new THREE.MeshBasicMaterial({ color: new THREE.Color().setRGB(i, i, i, THREE.LinearSRGBColorSpace) }));
    m.position.set(x, y, z);
    es.add(m);
  });
  const envRT = pm.fromScene(es, 0.04);
  scene.environment = envRT.texture;
  scene.add(new THREE.HemisphereLight(raw(0xfff4ea), raw(0x5a3c3c), 0.38 * PI));
  const key = new THREE.DirectionalLight(raw(0xfff6ee), 1.05 * PI); key.position.set(55, 18, 85); scene.add(key);
  const fillL = new THREE.DirectionalLight(raw(0xf0f0ff), 0.4 * PI); fillL.position.set(-45, -35, 70); scene.add(fillL);
  const rim = new THREE.DirectionalLight(raw(0xffe8e0), 0.45 * PI); rim.position.set(-60, 30, -40); scene.add(rim);

  const C = (h: number) => new THREE.Color(h);
  const enamel = new THREE.MeshPhysicalMaterial({ color: 0xffffff, vertexColors: true, roughness: 0.38, clearcoat: 0.55, clearcoatRoughness: 0.25, envMapIntensity: 0.55 });
  const rootMat = new THREE.MeshStandardMaterial({ color: C(0xd8bf8c), roughness: 0.7, side: THREE.DoubleSide, envMapIntensity: 0.5 });
  const gumMat = new THREE.MeshPhysicalMaterial({ color: C(0xbf5a64), roughness: 0.45, clearcoat: 0.35, clearcoatRoughness: 0.35, envMapIntensity: 0.5 });
  const CM: Record<string, THREE.MeshStandardMaterial> = {
    zirconia: new THREE.MeshPhysicalMaterial({ color: C(0xf2eee6), roughness: 0.22, clearcoat: 1, clearcoatRoughness: 0.1, envMapIntensity: 0.6 }),
    pfm: new THREE.MeshPhysicalMaterial({ color: C(0xeee4cf), roughness: 0.2, clearcoat: 1, clearcoatRoughness: 0.1, envMapIntensity: 0.6 }),
    gold: new THREE.MeshPhysicalMaterial({ color: C(0xe2b85c), metalness: 1, roughness: 0.22, clearcoat: 0.6 }),
    steel: new THREE.MeshStandardMaterial({ color: C(0xc9ccd0), metalness: 1, roughness: 0.3 }),
  };
  const FM: Record<string, THREE.MeshStandardMaterial> = {
    composite: new THREE.MeshPhysicalMaterial({ color: C(0xf3ead2), roughness: 0.12, clearcoat: 1, clearcoatRoughness: 0.05, envMapIntensity: 0.8 }),
    amalgam: new THREE.MeshStandardMaterial({ color: C(0xaab0b8), metalness: 0.85, roughness: 0.3 }),
  };
  const compEdge = new THREE.MeshStandardMaterial({ color: C(0x378add), roughness: 0.5 });
  const collarM = new THREE.MeshStandardMaterial({ color: C(0x6d6a66), metalness: 0.9, roughness: 0.35 });
  const tiM = new THREE.MeshStandardMaterial({ color: C(0x9da3aa), metalness: 0.9, roughness: 0.35 });
  const cariesM = new THREE.MeshStandardMaterial({ color: C(0x2a1a10), roughness: 0.95 });
  const stainM = new THREE.MeshStandardMaterial({ color: C(0x8c6236), roughness: 0.8 });
  const gpM = new THREE.MeshStandardMaterial({ color: C(0xe0703c), roughness: 0.5, emissive: C(0x5a1a00), emissiveIntensity: 0.4 });
  const planM = new THREE.MeshBasicMaterial({ color: raw(0xe24b4a), transparent: true, opacity: 0.5, depthWrite: false });
  const planCanal = new THREE.MeshBasicMaterial({ color: raw(0xe24b4a) });
  const ghostM = new THREE.MeshBasicMaterial({ color: raw(0x378add), transparent: true, opacity: 0.14, depthWrite: false });
  const shared: THREE.Material[] = [enamel, rootMat, gumMat, ...Object.values(CM), ...Object.values(FM), compEdge, collarM, tiM, cariesM, stainM, gpM, planM, planCanal, ghostM];

  const lowerG = new THREE.Group(), upperPivot = new THREE.Group(), upperG = new THREE.Group();
  upperPivot.position.set(0, 0, -30); upperG.position.set(0, 0, 30); upperPivot.add(upperG); scene.add(lowerG, upperPivot);

  interface G0 { m: Dims; crown: THREE.BufferGeometry; probe: THREE.Mesh; roots: RootSpec[]; imp: THREE.BufferGeometry[] }
  const cache: Record<string, G0> = {}, dGeo = new THREE.SphereGeometry(1, 24, 16), rc = new THREE.Raycaster();
  const geos = (n: number): G0 => {
    const k = `${n}`;
    if (cache[k]) return cache[k];
    const m = dims(n), crown = crownGeo(m);
    return (cache[k] = { m, crown, probe: new THREE.Mesh(crown, new THREE.MeshBasicMaterial({ side: THREE.DoubleSide })), roots: rootSpecs(m), imp: implantGeos(m) });
  };
  function surfPoint(G: G0, k: string, ms: number) {
    const { w, dp, h } = G.m;
    let o: THREE.Vector3, d: THREE.Vector3;
    if (k === "O") { o = V(0, h + 20, 0); d = V(0, -1, 0); }
    else if (k === "B") { o = V(0, h * 0.6, dp + 20); d = V(0, 0, -1); }
    else if (k === "L") { o = V(0, h * 0.6, -dp - 20); d = V(0, 0, 1); }
    else { const s = k === "M" ? ms : -ms; o = V(s * (w + 20), h * 0.55, dp * 0.18); d = V(-s, 0, 0); }
    rc.set(o, d);
    const hit = rc.intersectObject(G.probe)[0];
    return hit && hit.face ? { p: hit.point, n: hit.face.normal.clone() } : null;
  }
  function decal(par: THREE.Object3D, hit: { p: THREE.Vector3; n: THREE.Vector3 }, r: number, mat: THREE.Material, flat: number, inset: number) {
    const m = new THREE.Mesh(dGeo, mat);
    m.scale.set(r, r, r * flat);
    m.quaternion.setFromUnitVectors(V(0, 0, 1), hit.n);
    m.position.copy(hit.p).addScaledVector(hit.n, -r * flat * inset);
    par.add(m);
  }
  /** Half dental arch in mm. */
  const BASE = [[0, 22], [8, 20.6], [15, 16.6], [20.6, 10], [24.2, 1.4], [26.6, -9], [28.2, -21], [29.2, -33], [30, -45]];
  const arch = (up: boolean, c: boolean) => { const k = c ? 0.8 : 1, s = up ? 1.07 : 1; return new THREE.CatmullRomCurve3(BASE.map(([x, z]) => V(x * k * s, 0, (z * s + (up ? 0.8 : 0)) * k))); };
  /** The curve of Spee. */
  const spee = (s: number) => (P!.mode === "child" ? 0 : s > 16 ? 2.4 * Math.min(1, (s - 16) / 48) ** 2 : 0);
  const onArch = (curve: THREE.CatmullRomCurve3, len: number, s: number) => {
    const u = Math.min(s / len, 1), p = curve.getPointAt(u).clone(), T = curve.getTangentAt(u).clone();
    if (s > len) p.addScaledVector(T, s - len);
    return { p, T };
  };
  let picks: THREE.Mesh[] = [];
  let labels: { el: HTMLDivElement; obj: THREE.Object3D; loc: THREE.Vector3; up: boolean }[] = [];
  let ctr: Record<number, THREE.Vector3> = {};
  const owned = new Set<THREE.Material>();
  const ownedGeo = new Set<THREE.BufferGeometry>();
  function clearG(g: THREE.Group) {
    while (g.children.length) g.remove(g.children[g.children.length - 1]);
  }
  const own = <M extends THREE.Material>(m: M): M => { const c = m.clone() as M; owned.add(c); return c; };
  const pos = (n: number): Position => Object.assign({}, NO_POS, P!.positions[String(n)]);
  const gp = (n: number) => { const d = toothOf(P!.state, n); return d.missing && !d.implant ? 0 : pos(n).gap_mesial; };

  function place(n: number, curve: THREE.CatmullRomCurve3, len: number, c: number, sx: number, up: boolean, G: THREE.Group, cy: number) {
    const st = P!.state, G0 = geos(n), { w, dp, h, torq, tip } = G0.m, a = onArch(curve, len, c), T = a.T, N = V(-T.z, 0, T.x), p = a.p;
    p.x *= sx; T.x *= sx; N.x *= sx;
    const Y = V(0, up ? -1 : 1, 0), X = V(0, 0, 0).crossVectors(Y, N).normalize(), ms = X.dot(T) > 0 ? -1 : 1;
    const outer = new THREE.Group();
    outer.quaternion.setFromRotationMatrix(new THREE.Matrix4().makeBasis(X, Y, N));
    outer.position.set(p.x, cy, p.z);
    ctr[n] = V(0, h * 0.45, 0).applyQuaternion(outer.quaternion).add(outer.position);
    const nat = new THREE.Group();
    nat.rotation.set(THREE.MathUtils.degToRad(torq), 0, -ms * THREE.MathUtils.degToRad(tip));
    outer.add(nat);
    const q = pos(n), inner = new THREE.Group();
    nat.add(inner);
    G.add(outer);
    const el = document.createElement("div");
    el.className = `lb ${n === P!.sel ? "sel" : tstat(st, n, P!.today)}`;
    el.textContent = String(n);
    lbBox.appendChild(el);
    labels.push({ el, obj: outer, loc: V(0, -5.5, dp / 2 + 2.5), up });
    const d = toothOf(st, n), isSel = n === P!.sel, br = bridgeOf(st, n);
    const selE = <M extends THREE.MeshStandardMaterial>(m: M) => { if (isSel) { m.emissive = raw(0x1d5fb0); m.emissiveIntensity = 0.3; } return m; };
    const pick = (mesh: THREE.Mesh) => { mesh.userData = { n, up }; picks.push(mesh); inner.add(mesh); return mesh; };
    inner.position.set(0, q.vertical, q.buccal_lingual);
    inner.rotation.set(0, THREE.MathUtils.degToRad(q.rotation), -ms * THREE.MathUtils.degToRad(q.tipping), "ZYX");
    const collar = (mat: THREE.Material) => {
      const geo = new THREE.TorusGeometry(1, 0.05, 8, 40); ownedGeo.add(geo);
      const t = new THREE.Mesh(geo, mat);
      t.rotation.x = Math.PI / 2; t.scale.set((w / 2) * 0.72, (dp / 2) * 0.72, 1); t.position.y = 0.35; inner.add(t);
    };
    const redShell = () => { const sh = new THREE.Mesh(G0.crown, planM); sh.scale.set(1.08, 1.04, 1.08); inner.add(sh); };
    if (br && br.role === "pontic") {
      const pl = br.b.s === "planned";
      pick(new THREE.Mesh(G0.crown, pl ? planM : selE(own(CM[br.b.m]))));
      if (!pl && br.b.m === "pfm") collar(collarM);
      return;
    }
    if (d.implant) {
      const pl = d.implant.s === "planned";
      pick(new THREE.Mesh(G0.crown, pl ? planM : selE(own(CM[d.implant.m]))));
      if (!pl && d.implant.m === "pfm") collar(collarM);
      G0.imp.forEach((g) => pick(new THREE.Mesh(g, pl ? planM : tiM)));
      return;
    }
    if (d.missing) { const gm = own(ghostM); gm.opacity = isSel ? 0.35 : 0.12; pick(new THREE.Mesh(G0.crown, gm)); return; }
    const cr = d.crown ?? (br && br.role === "abut" ? { m: br.b.m, s: br.b.s } : null), crReal = !!cr && cr.s !== "planned", extP = !!d.ext && d.ext.s === "planned";
    const em = own(crReal ? CM[cr!.m] : enamel) as THREE.MeshStandardMaterial;
    selE(em);
    pick(new THREE.Mesh(G0.crown, em));
    if (crReal && cr!.m === "pfm") collar(collarM);
    if ((cr && cr.s === "planned") || extP) redShell();
    const rm = own(rootMat);
    if (P!.xray) { rm.transparent = true; rm.opacity = 0.45; rm.depthWrite = false; }
    if (extP) { rm.emissive = raw(0x9a1414); rm.emissiveIntensity = 0.45; }
    if (isSel) { rm.emissive = raw(0x1d5fb0); rm.emissiveIntensity = 0.25; }
    G0.roots.forEach((sp) => {
      const r = new THREE.Mesh(sp.geo, rm);
      r.position.set(sp.x, 0, sp.z); r.rotation.set(sp.rx, 0, sp.rz); r.scale.set(sp.sx, 1, 1);
      r.userData = { n, up }; picks.push(r);
      if (d.rct) r.add(new THREE.Mesh(sp.cn, d.rct.s === "planned" ? planCanal : gpM));
      inner.add(r);
    });
    if (!crReal) for (const k of ["O", "M", "D", "B", "L"] as const) {
      const o = d.surf[k];
      if (!o) continue;
      const hit = surfPoint(G0, k, ms);
      if (!hit) continue;
      const r = k === "O" ? Math.min(w, dp) * 0.22 : Math.min(w, h) * 0.19;
      if (o.fill && o.fill.s !== "planned") {
        if (o.fill.m === "composite") decal(inner, hit, r * 1.5, compEdge, 0.26, 0.5);
        decal(inner, hit, r * 1.3, FM[o.fill.m], 0.3, 0.45);
        continue;
      }
      if (o.car) { decal(inner, hit, r * 1.55, stainM, 0.22, 0.55); decal(inner, hit, r, cariesM, 0.35, 0.3); }
      if (o.fill) decal(inner, hit, r * 1.4, planM, 0.34, 0.25);
    }
  }
  function papilla(G: THREE.Group, curve: THREE.CatmullRomCurve3, len: number, s: number, sx: number, y: number, width: number, depth: number) {
    const a = onArch(curve, len, s); a.p.x *= sx; a.T.x *= sx;
    const Yv = V(0, 1, 0), Z = V(0, 0, 0).crossVectors(a.T, Yv).normalize();
    const m = new THREE.Mesh(dGeo, gumMat);
    m.quaternion.setFromRotationMatrix(new THREE.Matrix4().makeBasis(a.T.clone().normalize(), Yv, Z));
    m.scale.set(width / 2, 2.4, depth / 2); m.position.set(a.p.x, y, a.p.z); G.add(m);
  }

  function build(p: BuildParams) {
    // A different dentition needs different teeth: the cache is per tooth number, and
    // FDI numbers never overlap between adult and child.
    P = p;
    clearG(lowerG); clearG(upperG);
    owned.forEach((m) => m.dispose()); owned.clear();
    ownedGeo.forEach((g) => g.dispose()); ownedGeo.clear();
    lbBox.innerHTML = ""; picks = []; labels = []; ctr = {};
    const set = SETS[p.mode], child = p.mode === "child";
    ([[set.up, true], [set.lo, false]] as const).forEach(([arr, up]) => {
      const curve = arch(up, child), len = curve.getLength(), G = up ? upperG : lowerG, half = arr.length / 2;
      const sides = [arr.slice(0, half).reverse(), arr.slice(half)], gum: THREE.Vector3[][] = [[], []], first: number[][] = [];
      sides.forEach((list, si) => {
        const sx = si ? 1 : -1;
        let s = 0;
        const spans: number[][] = [];
        list.forEach((n) => {
          const m = geos(n).m;
          s += gp(n);
          const c = s + m.w / 2, cy = up ? m.h + 0.6 + m.ob + spee(c) : -m.h + spee(c);
          spans.push([s, s + m.w, cy, m.dp]);
          place(n, curve, len, c, sx, up, G, cy);
          s += m.w + 0.2;
        });
        first.push(spans[0]);
        for (let i = 0; i < spans.length - 1; i++) {
          const a = spans[i], b = spans[i + 1], cyv = (a[2] + b[2]) / 2;
          papilla(G, curve, len, (a[1] + b[0]) / 2, sx, up ? cyv - 1.9 : cyv + 1.9, 1.6 + (b[0] - a[1]), Math.min(a[3], b[3]) * 0.85);
        }
        const end = s + 2, rawPts: number[][] = [];
        for (let i = 0; i <= 30; i++) { const ss = (end * i) / 30; let cyv = spans[0][2]; for (const sp of spans) if (ss >= sp[0]) cyv = sp[2]; rawPts.push([ss, cyv]); }
        rawPts.forEach(([ss], i) => {
          const cyv = (rawPts[Math.max(0, i - 1)][1] + rawPts[i][1] + rawPts[Math.min(rawPts.length - 1, i + 1)][1]) / 3, a = onArch(curve, len, ss);
          gum[si].push(V(a.p.x * sx, up ? cyv - 0.5 + 10.2 : cyv + 0.5 - 10.2, a.p.z));
        });
      });
      const a0 = first[0], b0 = first[1], cym = (a0[2] + b0[2]) / 2;
      papilla(G, curve, len, 0, 1, up ? cym - 1.9 : cym + 1.9, 1.6 + a0[0] + b0[0], Math.min(a0[3], b0[3]) * 0.85);
      const full = gum[0].slice().reverse().concat(gum[1].slice(1)), flat = new THREE.CatmullRomCurve3(full.map((v) => V(v.x, 0, v.z))), yc = new THREE.CatmullRomCurve3(full);
      const TS = 220, RS = 28, tg = new THREE.TubeGeometry(flat, TS, 6.6, RS, false);
      tg.scale(1, 1.55, 1);
      const tp = tg.attributes.position;
      for (let i = 0; i <= TS; i++) { const yy = yc.getPointAt(i / TS).y; for (let j = 0; j <= RS; j++) { const ix = i * (RS + 1) + j; tp.setY(ix, tp.getY(ix) + yy); } }
      tg.computeVertexNormals();
      ownedGeo.add(tg);
      G.add(new THREE.Mesh(tg, gumMat));
      [full[0], full[full.length - 1]].forEach((v) => { const cc = new THREE.Mesh(dGeo, gumMat); cc.scale.set(6.6, 10.2, 6.6); cc.position.copy(v); G.add(cc); });
      p.state.bridges.filter((b) => isUp(b.a) === up && (set.up.includes(b.a) || set.lo.includes(b.a))).forEach((b) => {
        const u = bridgeOf(p.state, b.a)?.units ?? [];
        for (let i = 0; i < u.length - 1; i++) {
          const m = new THREE.Mesh(dGeo, b.s === "planned" ? planM : CM[b.m]);
          m.position.copy(ctr[u[i]]).add(ctr[u[i + 1]]).multiplyScalar(0.5);
          m.scale.set(1.6, 2, 2.2);
          G.add(m);
        }
      });
    });
    gumMat.transparent = p.xray; gumMat.opacity = p.xray ? 0.22 : 1; gumMat.depthWrite = !p.xray; gumMat.needsUpdate = true;
  }

  const VIEWS: Record<Exclude<View3D, "custom">, { phi: number; th: number; r: number; open: number }> = {
    front: { phi: 1.42, th: 0, r: 125, open: 0 }, open: { phi: 1.1, th: 0, r: 140, open: 1 },
    upper: { phi: Math.PI - 0.12, th: 0, r: 118, open: 0 }, lower: { phi: 0.12, th: 0, r: 118, open: 0 },
    side: { phi: 1.45, th: 1.25, r: 125, open: 0 },
  };
  const cur = { ...VIEWS.front }, tgt = { ...VIEWS.front };
  const H3 = () => stage.clientHeight || 440;
  function rs() { const w = stage.clientWidth || 380; R.setSize(w, H3()); cam.aspect = w / H3(); cam.updateProjectionMatrix(); }
  const ro = new ResizeObserver(rs);
  ro.observe(stage);
  rs();
  const tv = new THREE.Vector3();
  let raf = 0;
  const loop = () => {
    raf = requestAnimationFrame(loop);
    for (const k of Object.keys(cur) as (keyof typeof cur)[]) cur[k] += (tgt[k] - cur[k]) * 0.12;
    const asp = cam.aspect < 1.25 ? 1.25 / cam.aspect : 1, r = cur.r * asp, tgY = view3d === "upper" ? 6 : view3d === "lower" ? -4 : 0;
    cam.position.set(r * Math.sin(cur.phi) * Math.sin(cur.th), tgY + r * Math.cos(cur.phi), -6 + r * Math.sin(cur.phi) * Math.cos(cur.th));
    cam.lookAt(0, tgY, -6);
    upperPivot.rotation.x = -0.55 * cur.open; upperPivot.position.y = 7 * cur.open;
    upperPivot.visible = view3d !== "lower"; lowerG.visible = view3d !== "upper";
    scene.updateMatrixWorld();
    const W = stage.clientWidth, H = H3();
    labels.forEach((l) => {
      const vis = !!P?.nums && (l.up ? upperPivot.visible : lowerG.visible);
      if (!vis) { l.el.style.display = "none"; return; }
      l.obj.localToWorld(tv.copy(l.loc));
      const out = V(tv.x, 0, tv.z + 6).normalize(), toC = cam.position.clone().sub(tv).normalize();
      if (out.dot(toC) < 0.05 && view3d !== "upper" && view3d !== "lower") { l.el.style.display = "none"; return; }
      tv.project(cam);
      if (tv.z > 1) { l.el.style.display = "none"; return; }
      l.el.style.display = ""; l.el.style.left = `${((tv.x + 1) / 2) * W}px`; l.el.style.top = `${((1 - tv.y) / 2) * H}px`;
    });
    R.render(scene, cam);
  };
  loop();

  // Drag to rotate, two fingers or the wheel to zoom, a tap to select.
  const ptrs = new Map<number, [number, number]>();
  let downAt: [number, number] | null = null, pinch = 0;
  const el = R.domElement;
  const onDown = (e: PointerEvent) => { el.setPointerCapture?.(e.pointerId); ptrs.set(e.pointerId, [e.clientX, e.clientY]); downAt = [e.clientX, e.clientY]; stage.style.cursor = "grabbing"; };
  const onMove = (e: PointerEvent) => {
    if (!ptrs.has(e.pointerId)) return;
    const pr = ptrs.get(e.pointerId)!;
    if (ptrs.size === 2) {
      ptrs.set(e.pointerId, [e.clientX, e.clientY]);
      const [a, b] = [...ptrs.values()], dd = Math.hypot(a[0] - b[0], a[1] - b[1]);
      if (pinch) tgt.r = cur.r = Math.min(260, Math.max(55, (cur.r * pinch) / dd));
      pinch = dd;
      return;
    }
    const dx = e.clientX - pr[0], dy = e.clientY - pr[1];
    ptrs.set(e.pointerId, [e.clientX, e.clientY]);
    tgt.th = cur.th = cur.th - dx * 0.008;
    tgt.phi = cur.phi = Math.min(Math.PI - 0.05, Math.max(0.05, cur.phi - dy * 0.008));
    if (view3d !== "custom" && view3d !== "upper" && view3d !== "lower" && downAt && Math.hypot(e.clientX - downAt[0], e.clientY - downAt[1]) > 6) {
      const ko = tgt.open; view3d = "custom"; tgt.open = ko; onCustomView();
    }
  };
  const onUp = (e: PointerEvent) => {
    const was = ptrs.has(e.pointerId);
    ptrs.delete(e.pointerId);
    if (ptrs.size < 2) pinch = 0;
    stage.style.cursor = "grab";
    if (was && downAt && Math.hypot(e.clientX - downAt[0], e.clientY - downAt[1]) < 6 && ptrs.size === 0) {
      const rect = el.getBoundingClientRect(), ndc = new THREE.Vector2(((e.clientX - rect.left) / rect.width) * 2 - 1, -((e.clientY - rect.top) / rect.height) * 2 + 1);
      const ray = new THREE.Raycaster();
      ray.setFromCamera(ndc, cam);
      const hits = ray.intersectObjects(picks.filter((m) => (m.userData.up ? upperPivot.visible : lowerG.visible)));
      if (hits.length) onSelect(hits[0].object.userData.n as number);
    }
    downAt = null;
  };
  const onWheel = (e: WheelEvent) => { e.preventDefault(); tgt.r = cur.r = Math.min(260, Math.max(55, cur.r * (1 + e.deltaY * 0.001))); };
  el.addEventListener("pointerdown", onDown);
  el.addEventListener("pointermove", onMove);
  el.addEventListener("pointerup", onUp);
  el.addEventListener("pointercancel", onUp);
  el.addEventListener("wheel", onWheel, { passive: false });

  return {
    build,
    setView(v) { view3d = v; if (v !== "custom") Object.assign(tgt, VIEWS[v]); },
    dispose() {
      cancelAnimationFrame(raf);
      ro.disconnect();
      el.removeEventListener("pointerdown", onDown);
      el.removeEventListener("pointermove", onMove);
      el.removeEventListener("pointerup", onUp);
      el.removeEventListener("pointercancel", onUp);
      el.removeEventListener("wheel", onWheel);
      clearG(lowerG); clearG(upperG);
      owned.forEach((m) => m.dispose()); ownedGeo.forEach((g) => g.dispose());
      for (const g0 of Object.values(cache)) { g0.crown.dispose(); (g0.probe.material as THREE.Material).dispose(); g0.roots.forEach((r) => { r.geo.dispose(); r.cn.dispose(); }); g0.imp.forEach((g) => g.dispose()); }
      dGeo.dispose();
      shared.forEach((m) => m.dispose());
      es.traverse((o) => { if (o instanceof THREE.Mesh) { o.geometry.dispose(); (o.material as THREE.Material).dispose(); } });
      envRT.dispose(); pm.dispose();
      R.dispose(); R.forceContextLoss();
      R.domElement.remove();
      lbBox.innerHTML = "";
    },
  };
}
