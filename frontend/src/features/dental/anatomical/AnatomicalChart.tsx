// The two arches (render2D() of dental-chart-reference_3d.html): upper side view,
// upper top view, the numbers, lower top view, lower side view (mirrored so the crowns
// face each other). Teeth touch; a mesial gap pushes them apart and is drawn as a
// green band with its size; a bridge is a bar across its teeth. Tooth numbers: blue
// selected, red planned work, green work done today, orange position changed.
import { useId, type KeyboardEvent } from "react";

import type { Position } from "@/features/dental/api";
import { C2, EXT, S, SETS, layout, ty, type Dentition } from "@/features/dental/anatomical/geometry";
import { bracesOf, bridgeOf, hasBracket, items, posEmpty, toothOf, toothState, tstat, SL, type ChartState } from "@/features/dental/anatomical/model";
import { palmerOf, toothName } from "@/features/dental/anatomical/geometry";
import { ToothSide, ToothTop } from "@/features/dental/anatomical/Tooth";

export interface ClinicMark { code: string; label: string; color: string }

export function AnatomicalChart({ dentition, state, positions, today, marks, selected, onSelect, maxHeight, fill }: {
  dentition: Dentition;
  state: ChartState;
  positions: Record<string, Position>;
  /** The clinic day (YYYY-MM-DD): "done today" is work done on it. */
  today: string;
  /** The simple chart's mark on a tooth (the clinic's own condition), by Palmer code. */
  marks?: (palmer: string) => ClinicMark | null;
  selected: number;
  onSelect: (n: number) => void;
  /** The tallest the drawing may be (CSS); it keeps its proportions and is centred. */
  maxHeight?: string;
  /** Fill the parent's height (and width), keeping the proportions, centred. */
  fill?: boolean;
}) {
  // Unique per chart on the page, so two charts never share a clipPath id.
  const uid = useId().replace(/[^a-zA-Z0-9_-]/g, "");
  const set = SETS[dentition];
  const pos = (n: number) => positions[String(n)];
  const gp = (n: number) => { const d = toothOf(state, n); return d.missing && !d.implant ? 0 : pos(n)?.gap_mesial ?? 0; };
  const A = layout(set.up, gp), B = layout(set.lo, gp);
  const VW = Math.max(A.width, B.width, 330) + 12, ox = (VW - A.width) / 2, lx = (VW - B.width) / 2, VH = 262;

  const numStyle = (n: number) => {
    const t = tstat(state, n, today);
    const fill = n === selected ? "var(--text-accent)" : t === "pl" ? "var(--text-danger)" : t === "dn" ? "var(--text-success)" : !posEmpty(pos(n)) ? "var(--text-warning)" : "var(--text-secondary)";
    return { fontSize: 10, fontWeight: t || n === selected ? 600 : 400, fill };
  };
  const markOf = (n: number) => { const p = palmerOf(n); return p && marks ? marks(p) : null; };
  // A healthy mark is a mark, but a bar under every healthy tooth would drown the rest.
  const barOf = (n: number) => { const m = markOf(n); return m && m.code !== "healthy" ? m : null; };
  const gapRect = (key: string, x: number, w: number, y1: number, y2: number) => (
    <g key={key}>
      <rect x={x} y={y1} width={w} height={y2 - y1} fill={C2.gap} opacity={0.18} />
      <line x1={x} y1={y1} x2={x} y2={y2} stroke={C2.gap} strokeDasharray="2 2" />
      <line x1={x + w} y1={y1} x2={x + w} y2={y2} stroke={C2.gap} strokeDasharray="2 2" />
    </g>
  );
  const pill = (key: string, cx: number, cy: number, g: number) => (
    <g key={key}>
      <rect x={cx - 16} y={cy - 7} width={32} height={14} rx={5} fill={C2.gap} />
      <text x={cx} y={cy + 3.5} textAnchor="middle" style={{ fontSize: 10, fill: "#fff" }}>{g}mm</text>
    </g>
  );
  const label = (n: number) => {
    const f = items(state, n, today).map((i) => `${i.t} (${SL[i.s]})`), m = markOf(n);
    return `Tooth ${n}, ${toothName(n)}${m ? `, ${m.label}` : ""}${f.length ? `: ${f.join(", ")}` : ""}`;
  };
  const hit = (n: number, x: number, y: number, w: number) => (
    <rect key={`hit${n}`} data-n={n} x={x} y={y} width={w} height={114} fill="transparent" className="ta-hit" style={{ cursor: "pointer" }}
      role="button" tabIndex={0} aria-label={label(n)} aria-pressed={n === selected}
      onClick={() => onSelect(n)}
      onKeyDown={(e: KeyboardEvent) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onSelect(n); } }} />
  );
  const cx: Record<number, number> = {};
  const bracketOf = (n: number) => {
    if (!hasBracket(state, n)) return null;
    const b = bracesOf(state, n)!.b;
    return { m: b.m, planned: b.s === "planned" };
  };

  const upper = A.items.map(({ n, x, w }) => {
    const X = ox + x, lo = EXT[ty(n)][0], m = barOf(n), st = toothState(state, n);
    cx[n] = X + w / 2;
    return (
      <g key={n}>
        {n === selected && <rect x={X} y={14} width={w} height={114} rx={3} style={{ fill: "var(--bg-accent)" }} />}
        <g transform={`translate(${X - lo * S},16) scale(${S})`}><ToothSide n={n} S={st} p={pos(n)} clipId={`${uid}us${n}`} bracket={bracketOf(n)} /></g>
        <g transform={`translate(${X + w / 2 - 20 * S},86) scale(${S})`}><ToothTop n={n} S={st} p={pos(n)} clipId={`${uid}ut${n}`} bracket={bracketOf(n)} /></g>
        <text x={X + w / 2} y={124} textAnchor="middle" style={numStyle(n)}>{n}</text>
        {m && <rect data-mark={n} x={X + 2} y={125.5} width={w - 4} height={2.5} rx={1} fill={m.color}><title>{m.label}</title></rect>}
      </g>
    );
  });
  const lower = B.items.map(({ n, x, w }) => {
    const X = lx + x, lo = EXT[ty(n)][0], m = barOf(n), st = toothState(state, n);
    cx[n] = X + w / 2;
    return (
      <g key={n}>
        {n === selected && <rect x={X} y={132} width={w} height={114} rx={3} style={{ fill: "var(--bg-accent)" }} />}
        <text x={X + w / 2} y={141} textAnchor="middle" style={numStyle(n)}>{n}</text>
        {m && <rect data-mark={n} x={X + 2} y={143} width={w - 4} height={2.5} rx={1} fill={m.color}><title>{m.label}</title></rect>}
        <g transform={`translate(${X + w / 2 - 20 * S},147) scale(${S})`}><ToothTop n={n} S={st} p={pos(n)} clipId={`${uid}lt${n}`} bracket={bracketOf(n)} /></g>
        <g transform={`translate(${X - lo * S},243) scale(${S},-${S})`}><ToothSide n={n} S={st} p={pos(n)} clipId={`${uid}ls${n}`} bracket={bracketOf(n)} /></g>
      </g>
    );
  });
  const bars = state.bridges.filter((b) => set.up.includes(b.a) || set.lo.includes(b.a)).map((b) => {
    const u = bridgeOf(state, b.a)?.units ?? [b.a, b.b];
    const y = set.up.includes(b.a) ? 66 : 193, c = b.s === "planned" ? C2.plan : b.m === "gold" ? C2.gold : "#8d8a84";
    return <line key={`br${b.a}-${b.b}`} data-bridge={`${u[0]}-${u[u.length - 1]}`} x1={cx[u[0]]} y1={y} x2={cx[u[u.length - 1]]} y2={y} stroke={c} strokeWidth={3} strokeLinecap="round" opacity={0.9} />;
  });

  // The wire: through the brackets of the braces, at bracket height.
  const wires = (state.braces ?? []).filter((b) => set.up.includes(b.a) || set.lo.includes(b.a)).map((b) => {
    const u = bracesOf(state, b.a)?.units ?? [b.a, b.b];
    const y = set.up.includes(b.a) ? 16 + 76.5 * S : 243 - 76.5 * S;
    return <line key={`bc${b.a}-${b.b}`} data-braces={`${u[0]}-${u[u.length - 1]}`} x1={cx[u[0]]} y1={y} x2={cx[u[u.length - 1]]} y2={y}
      stroke={b.s === "planned" ? C2.plan : C2.wire} strokeWidth={1.4} strokeLinecap="round" />;
  });

  return (
    <svg viewBox={`0 0 ${VW} ${VH}`} width="100%" role="group" aria-label={`${dentition === "adult" ? "Adult" : "Child"} tooth chart`}
      style={{ display: "block", touchAction: "manipulation", maxHeight, ...(fill ? { height: "100%" } : {}) }}>
      <line x1={6} y1={130} x2={VW - 6} y2={130} style={{ stroke: "var(--border)" }} />
      <line x1={ox + A.mid} y1={14} x2={ox + A.mid} y2={128} style={{ stroke: "var(--border-strong)" }} strokeDasharray="3 3" />
      <line x1={lx + B.mid} y1={132} x2={lx + B.mid} y2={246} style={{ stroke: "var(--border-strong)" }} strokeDasharray="3 3" />
      {A.gaps.map((g, i) => gapRect(`ag${i}`, ox + g.x, g.w, 16, 114))}
      {B.gaps.map((g, i) => gapRect(`bg${i}`, lx + g.x, g.w, 145, 244))}
      {upper}
      {lower}
      {bars}
      {wires}
      {A.gaps.map((g, i) => pill(`ap${i}`, ox + g.x + g.w / 2, 7, g.g))}
      {B.gaps.map((g, i) => pill(`bp${i}`, lx + g.x + g.w / 2, 254, g.g))}
      {A.items.map(({ n, x, w }) => hit(n, ox + x, 14, w))}
      {B.items.map(({ n, x, w }) => hit(n, lx + x, 132, w))}
    </svg>
  );
}
