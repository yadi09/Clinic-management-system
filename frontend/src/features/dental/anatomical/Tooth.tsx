// One tooth, drawn as in the reference: from the side (crown + roots) and from above
// (the chewing surface). Ported from sideView() / topView() in
// dental-chart-reference.html; every coordinate and transform is the reference's.
import type { CSSProperties } from "react";

import type { SurfaceKey, ToothAnatomy } from "@/features/dental/api";
import { C, P, TV, W, isUp, mir, pos, sideRegions, topRegions, ty } from "@/features/dental/anatomical/geometry";

const ST: CSSProperties = { stroke: "var(--text-secondary)", strokeWidth: 1.5 };
const MISSING: CSSProperties = { strokeDasharray: "4 3", opacity: 0.45 };

function surfaceRects(a: ToothAnatomy | undefined, regions: Record<SurfaceKey, [number, number, number, number]>, clipId: string) {
  return Object.entries(a?.surfaces ?? {}).map(([k, v]) => {
    const r = regions[k as SurfaceKey];
    if (!r || !v) return null;
    return <rect key={k} x={r[0]} y={r[1]} width={r[2]} height={r[3]} fill={C[v]} clipPath={`url(#${clipId})`} />;
  });
}

/** sideView(n, id) */
export function ToothSide({ n, a, clipId }: { n: number; a?: ToothAnatomy; clipId: string }) {
  const p = P[ty(n)], ms = !!a?.missing, st = ms ? MISSING : {}, q = pos(a);
  const ang = ms ? 0 : mir(n) ? -q.tilt : q.tilt, dy = ms ? 0 : q.vert * 3;
  return (
    <g transform={`translate(0,${dy}) rotate(${ang} 20 30)`}>
      {p.r.map((r) => <path key={r} d={r} style={{ fill: "var(--surface-1)", ...ST, ...st }} />)}
      {a?.root_canal && !ms && p.l.map((l) => <path key={l} d={l} stroke={C.rct} strokeWidth={4} strokeLinecap="round" fill="none" />)}
      <clipPath id={clipId}><path d={p.c} /></clipPath>
      <path d={p.c} style={{ fill: a?.crown && !ms ? C.crown : "var(--surface-2)", ...st }} />
      {!ms && !a?.crown && surfaceRects(a, sideRegions(n), clipId)}
      <path d={p.c} style={{ fill: "none", ...ST, ...st }} />
    </g>
  );
}

/** topView(n, id) */
export function ToothTop({ n, a, clipId }: { n: number; a?: ToothAnatomy; clipId: string }) {
  const p = TV[ty(n)], ms = !!a?.missing, st = ms ? MISSING : {}, q = pos(a);
  const dy = ms ? 0 : (isUp(n) ? -1 : 1) * q.bl * 2.5, r = ms ? 0 : q.rot, sx = W(n) / 36;
  return (
    <g transform={`translate(20,${dy}) rotate(${r} 0 20) scale(${sx},1) translate(-20,0)`}>
      <clipPath id={clipId}><path d={p.o} /></clipPath>
      <path d={p.o} style={{ fill: a?.crown && !ms ? C.crown : "var(--surface-2)", ...st }} />
      {!ms && !a?.crown && surfaceRects(a, topRegions(n), clipId)}
      {!ms && <path d={p.g} style={{ fill: "none", stroke: "var(--text-muted)", strokeWidth: 1.2, strokeLinecap: "round" }} />}
      <path d={p.o} style={{ fill: "none", ...ST, ...st }} />
    </g>
  );
}
