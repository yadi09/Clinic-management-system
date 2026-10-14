// The two arches, as in render() of dental-chart-reference.html: upper side view,
// upper top view, the numbers, lower top view, lower side view (mirrored so the
// crowns face each other). Teeth touch; a mesial gap pushes them apart and is drawn
// as a green band with its size in mm.
import { useId, type KeyboardEvent } from "react";

import type { ToothAnatomy } from "@/features/dental/api";
import { C, EXT, S, SETS, layout, moved, palmerOf, toothName, ty, findings, type Dentition } from "@/features/dental/anatomical/geometry";
import { ToothSide, ToothTop } from "@/features/dental/anatomical/Tooth";

export interface ClinicMark { code: string; label: string; color: string }

export function AnatomicalChart({ dentition, anatomy, marks, selected, onSelect, maxHeight, fill }: {
  dentition: Dentition;
  anatomy: Record<string, ToothAnatomy>;
  /** The simple chart's mark on a tooth (the clinic's own condition), by Palmer code. */
  marks?: (palmer: string) => ClinicMark | null;
  selected: number;
  onSelect: (n: number) => void;
  /** The tallest the drawing may be (CSS), so it always fits on screen; it then keeps
   *  its proportions and is centred. */
  maxHeight?: string;
  /** Fill the parent's height (and width), keeping the proportions, centred. */
  fill?: boolean;
}) {
  // Unique per chart on the page, so two charts never share a clipPath id.
  const uid = useId().replace(/[^a-zA-Z0-9_-]/g, "");
  const get = (n: number) => anatomy[String(n)];
  const set = SETS[dentition];
  const A = layout(set.up, get), B = layout(set.lo, get);
  const VW = Math.max(A.width, B.width, 330) + 12, ox = (VW - A.width) / 2, lx = (VW - B.width) / 2, VH = 262;

  const numFill = (n: number) => (n === selected ? "var(--text-accent)" : moved(get(n)) ? "var(--text-warning)" : "var(--text-secondary)");
  const markOf = (n: number) => { const p = palmerOf(n); return p && marks ? marks(p) : null; };
  // A healthy mark is a mark, but a bar under every healthy tooth would drown the rest.
  const barOf = (n: number) => { const m = markOf(n); return m && m.code !== "healthy" ? m : null; };
  const gapRect = (key: string, x: number, w: number, y1: number, y2: number) => (
    <g key={key}>
      <rect x={x} y={y1} width={w} height={y2 - y1} fill={C.gap} opacity={0.18} />
      <line x1={x} y1={y1} x2={x} y2={y2} stroke={C.gap} strokeDasharray="2 2" />
      <line x1={x + w} y1={y1} x2={x + w} y2={y2} stroke={C.gap} strokeDasharray="2 2" />
    </g>
  );
  const pill = (key: string, cx: number, cy: number, g: number) => (
    <g key={key}>
      <rect x={cx - 16} y={cy - 7} width={32} height={14} rx={5} fill={C.gap} />
      <text x={cx} y={cy + 3.5} textAnchor="middle" style={{ fontSize: 10, fill: "#fff" }}>{g}mm</text>
    </g>
  );
  const label = (n: number) => {
    const f = findings(get(n)), m = markOf(n);
    return `Tooth ${n}, ${toothName(n)}${m ? `, ${m.label}` : ""}${f.length ? `: ${f.join(", ")}` : ""}`;
  };
  const hit = (n: number, x: number, y: number, w: number) => (
    <rect key={`hit${n}`} data-n={n} x={x} y={y} width={w} height={114} fill="transparent" className="ta-hit" style={{ cursor: "pointer" }}
      role="button" tabIndex={0} aria-label={label(n)} aria-pressed={n === selected}
      onClick={() => onSelect(n)}
      onKeyDown={(e: KeyboardEvent) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onSelect(n); } }} />
  );

  return (
    <svg viewBox={`0 0 ${VW} ${VH}`} width="100%" role="group" aria-label={`${dentition === "adult" ? "Adult" : "Child"} tooth chart`} style={{ display: "block", touchAction: "manipulation", maxHeight, ...(fill ? { height: "100%" } : {}) }}>
      <line x1={6} y1={130} x2={VW - 6} y2={130} style={{ stroke: "var(--border)" }} />
      <line x1={ox + A.mid} y1={14} x2={ox + A.mid} y2={128} style={{ stroke: "var(--border-strong)" }} strokeDasharray="3 3" />
      <line x1={lx + B.mid} y1={132} x2={lx + B.mid} y2={246} style={{ stroke: "var(--border-strong)" }} strokeDasharray="3 3" />
      {A.gaps.map((g, i) => gapRect(`ag${i}`, ox + g.x, g.w, 16, 114))}
      {B.gaps.map((g, i) => gapRect(`bg${i}`, lx + g.x, g.w, 145, 244))}
      {A.items.map(({ n, x, w }) => {
        const X = ox + x, lo = EXT[ty(n)][0], m = barOf(n);
        return (
          <g key={n}>
            {n === selected && <rect x={X} y={14} width={w} height={114} rx={3} style={{ fill: "var(--bg-accent)" }} />}
            <g transform={`translate(${X - lo * S},16) scale(${S})`}><ToothSide n={n} a={get(n)} clipId={`${uid}us${n}`} /></g>
            <g transform={`translate(${X + w / 2 - 20 * S},86) scale(${S})`}><ToothTop n={n} a={get(n)} clipId={`${uid}ut${n}`} /></g>
            <text x={X + w / 2} y={124} textAnchor="middle" style={{ fontSize: 10, fill: numFill(n) }}>{n}</text>
            {m && <rect data-mark={n} x={X + 2} y={125.5} width={w - 4} height={2.5} rx={1} fill={m.color}><title>{m.label}</title></rect>}
          </g>
        );
      })}
      {B.items.map(({ n, x, w }) => {
        const X = lx + x, lo = EXT[ty(n)][0], m = barOf(n);
        return (
          <g key={n}>
            {n === selected && <rect x={X} y={132} width={w} height={114} rx={3} style={{ fill: "var(--bg-accent)" }} />}
            <text x={X + w / 2} y={141} textAnchor="middle" style={{ fontSize: 10, fill: numFill(n) }}>{n}</text>
            {m && <rect data-mark={n} x={X + 2} y={143} width={w - 4} height={2.5} rx={1} fill={m.color}><title>{m.label}</title></rect>}
            <g transform={`translate(${X + w / 2 - 20 * S},147) scale(${S})`}><ToothTop n={n} a={get(n)} clipId={`${uid}lt${n}`} /></g>
            <g transform={`translate(${X - lo * S},243) scale(${S},-${S})`}><ToothSide n={n} a={get(n)} clipId={`${uid}ls${n}`} /></g>
          </g>
        );
      })}
      {A.gaps.map((g, i) => pill(`ap${i}`, ox + g.x + g.w / 2, 7, g.g))}
      {B.gaps.map((g, i) => pill(`bp${i}`, lx + g.x + g.w / 2, 254, g.g))}
      {A.items.map(({ n, x, w }) => hit(n, ox + x, 14, w))}
      {B.items.map(({ n, x, w }) => hit(n, lx + x, 132, w))}
    </svg>
  );
}

