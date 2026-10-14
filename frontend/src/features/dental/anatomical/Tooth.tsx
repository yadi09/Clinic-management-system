// One tooth, as in the reference: from the side (crown + roots) and from above (the
// chewing surface). Ported from side2() / top2() / surfOverlay() in
// dental-chart-reference_3d.html; every coordinate, colour and transform is the
// reference's. What a tooth holds comes from toothState() in model.ts.
import type { CSSProperties, ReactNode } from "react";

import type { Position, SurfaceKey } from "@/features/dental/api";
import { C2, P, TV, W, isUp, mir, sideRegions, topRegions, ty, type Rect } from "@/features/dental/anatomical/geometry";
import { NO_POS, SURFACES, type ToothRec, type toothState } from "@/features/dental/anatomical/model";

type TS = ReturnType<typeof toothState>;
const ST: CSSProperties = { stroke: "var(--text-secondary)", strokeWidth: 1.5 };
const GHOST: CSSProperties = { strokeDasharray: "4 3", opacity: 0.4 };
const crownColour = (m: string) => C2[m as keyof typeof C2] as string;

/** surfOverlay(): existing/done fillings in their material, caries brown, planned fillings red. */
function surfaces(d: ToothRec, R: Record<SurfaceKey, Rect>, clip: string): ReactNode[] {
  const out: ReactNode[] = [];
  for (const k of SURFACES) {
    const o = d.surf[k];
    if (!o) continue;
    const r = R[k];
    let fill: string | null = null;
    let composite = false;
    if (o.fill && o.fill.s !== "planned") { fill = crownColour(o.fill.m); composite = o.fill.m === "composite"; }
    else if (o.car) fill = C2.caries;
    if (fill) {
      out.push(<rect key={`${k}f`} x={r[0]} y={r[1]} width={r[2]} height={r[3]} fill={fill} clipPath={`url(#${clip})`}
        {...(composite ? { stroke: C2.edge, strokeWidth: 2.5 } : {})} />);
    }
    if (o.fill && o.fill.s === "planned") {
      out.push(<rect key={`${k}p`} x={r[0]} y={r[1]} width={r[2]} height={r[3]} fill={C2.plan} opacity={0.6} clipPath={`url(#${clip})`} />);
    }
  }
  return out;
}

/** side2(n, id) */
export function ToothSide({ n, S, p, clipId }: { n: number; S: TS; p?: Position; clipId: string }) {
  const path = P[ty(n)], q = p ?? NO_POS, st = S.ghost ? GHOST : {};
  const a = S.ghost ? 0 : mir(n) ? -q.tipping : q.tipping, dy = S.ghost ? 0 : q.vertical * 3;
  const base = S.real && !S.allPlan ? crownColour(S.cr!.m) : "var(--surface-2)";
  const planCover = S.allPlan || (S.cr && S.cr.s === "planned") || S.extP;
  return (
    <g transform={`translate(0,${dy}) rotate(${a} 20 30)`}>
      {S.imp ? (<>
        <path d="M15,60 L15,16 Q20,6 25,16 L25,60 Z" fill={S.allPlan ? C2.plan : C2.ti} opacity={S.allPlan ? 0.6 : 1} style={ST} />
        {[18, 24, 30, 36, 42, 48, 54].map((y) => <line key={y} x1={13} y1={y} x2={27} y2={y + 2} stroke={S.allPlan ? C2.plan : "#6f757c"} strokeWidth={1.5} />)}
      </>) : !S.pontic && (<>
        {path.r.map((r) => <path key={r} d={r} style={{ fill: "var(--surface-1)", ...ST, ...st }} />)}
        {S.d.rct && !S.ghost && path.l.map((l) => <path key={l} d={l} stroke={S.d.rct!.s === "planned" ? C2.plan : C2.rct} strokeWidth={4} strokeLinecap="round" fill="none" />)}
        {S.extP && path.r.map((r) => <path key={`x${r}`} d={r} fill={C2.plan} opacity={0.45} />)}
      </>)}
      <clipPath id={clipId}><path d={path.c} /></clipPath>
      <path d={path.c} style={{ fill: base, ...st }} />
      {!S.real && !S.ghost && !S.pontic && !S.imp && surfaces(S.d, sideRegions(n), clipId)}
      {S.real && !S.allPlan && S.cr!.m === "pfm" && <rect x={0} y={60} width={40} height={3} fill="#5f5c58" clipPath={`url(#${clipId})`} />}
      {planCover && <path d={path.c} fill={C2.plan} opacity={0.55} />}
      <path d={path.c} style={{ fill: "none", ...ST, ...st }} />
    </g>
  );
}

/** top2(n, id) */
export function ToothTop({ n, S, p, clipId }: { n: number; S: TS; p?: Position; clipId: string }) {
  const path = TV[ty(n)], q = p ?? NO_POS, st = S.ghost ? GHOST : {};
  const dy = S.ghost ? 0 : (isUp(n) ? -1 : 1) * q.buccal_lingual * 2.5, r = S.ghost ? 0 : q.rotation, sx = W(n) / 36;
  const base = S.real && !S.allPlan ? crownColour(S.cr!.m) : "var(--surface-2)";
  const planCover = S.allPlan || (S.cr && S.cr.s === "planned") || S.extP;
  return (
    <g transform={`translate(20,${dy}) rotate(${r} 0 20) scale(${sx},1) translate(-20,0)`}>
      <clipPath id={clipId}><path d={path.o} /></clipPath>
      <path d={path.o} style={{ fill: base, ...st }} />
      {!S.real && !S.ghost && !S.pontic && !S.imp && surfaces(S.d, topRegions(n), clipId)}
      {!S.ghost && !S.real && <path d={path.g} style={{ fill: "none", stroke: "var(--text-muted)", strokeWidth: 1.2, strokeLinecap: "round" }} />}
      {planCover && <path d={path.o} fill={C2.plan} opacity={0.55} />}
      <path d={path.o} style={{ fill: "none", ...ST, ...st }} />
    </g>
  );
}
