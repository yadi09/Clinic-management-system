// Collected over time — the chart the finance page is read for.
//
// It replaced a row of CSS divs whose only interaction was the browser's own
// `title` tooltip, and whose bars were one pixel wide because ninety flex children
// in a 900px card leave nothing for the bar. Three things were wrong with that and
// all three are structural rather than cosmetic:
//
//   Ninety daily bars for a clinic that takes money on twelve days is mostly empty
//   space. The bucket now follows the range — days for a fortnight, weeks for a
//   quarter, months beyond — so every bar carries data and is thick enough to aim at.
//
//   A native `title` is a 500ms browser tooltip in the OS font. A chart's hover
//   layer is part of the chart: the hovered bar lifts, the readout leads with the
//   value, and keyboard focus shows exactly what hover shows.
//
//   Nothing was reachable without hovering. There is a table view now, so every
//   number is readable without a pointer at all.
//
// Colour: one measure, so one hue — the app's primary teal, which passes the
// lightness band, chroma floor and 3:1 contrast against a white card. The previous
// period is deliberately NOT a second identity colour; it is the same measure
// earlier, so it is drawn as a neutral 2px line. Form (line vs bar) carries the
// distinction as well as tone, and the legend names both.
import { useEffect, useMemo, useRef, useState } from "react";
import { Table2, BarChart3 } from "lucide-react";

import type { FinDayPoint } from "@/features/billing/api";

const SERIES = "#148f77";       // primary teal — validated for light surface
const COMPARE = "#6b7280";      // muted-foreground: context, not identity
const GRID = "#e5e7eb";         // one shade off the surface, solid hairline

const num = (s?: string) => Number(s || 0);
const fmtShort = (iso: string) =>
  new Date(`${iso}T00:00:00`).toLocaleDateString(undefined, { month: "short", day: "numeric" });
const etb = (n: number) => `${n.toLocaleString(undefined, { maximumFractionDigits: 0 })} ETB`;

type Bucket = {
  key: string; label: string; full: string; now: number; before: number;
  /** The comparison point's OWN day, which is not the day under it on the axis. */
  beforeFull: string;
  /** The same, short enough for the axis. */
  beforeLabel: string;
};

/**
 * Group the daily series so the marks stay legible.
 *
 * A bar has to be wide enough to hit and to see: past about a fortnight, one bar
 * per day stops being a chart and starts being a texture.
 *
 * The comparison series is aligned BY POSITION, not by date: point i of the previous
 * window sits above point i of this one. For every preset that is the same weekday a
 * period earlier, which is the comparison an owner wants — but it means the line's
 * peak sits above a date it did not happen on. That confused a reader into thinking
 * the chart was inventing data, so each point now carries its own day and states it
 * wherever the value is read.
 */
function bucketise(series: FinDayPoint[], prev: FinDayPoint[]): { buckets: Bucket[]; grain: string } {
  const n = series.length;
  // A month of daily bars still clears the 24px cap with air between them, and a
  // month is exactly the window someone wants day-by-day. Weeks take over where a
  // day would be a hairline; months where a week would be.
  const grain = n <= 31 ? "day" : n <= 120 ? "week" : "month";
  const fmtDay = (iso: string) =>
    new Date(`${iso}T00:00:00`).toLocaleDateString(undefined, { month: "short", day: "numeric" });
  const longDay = (iso: string) =>
    new Date(`${iso}T00:00:00`).toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" });

  if (grain === "day") {
    return {
      grain,
      buckets: series.map((p, i) => ({
        key: p.date,
        label: fmtDay(p.date),
        full: longDay(p.date),
        now: num(p.amount),
        before: num(prev[i]?.amount),
        beforeFull: prev[i] ? longDay(prev[i].date) : "",
        beforeLabel: prev[i] ? fmtDay(prev[i].date) : "",
      })),
    };
  }

  // Weeks and months bucket by a key derived from the date, and the comparison
  // series is bucketed BY POSITION so the two stay aligned even when the previous
  // window straddles different month boundaries.
  const keyOf = (iso: string) => {
    const d = new Date(`${iso}T00:00:00`);
    if (grain === "month") return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
    // Monday-start week, keyed by that Monday.
    const day = (d.getDay() + 6) % 7;
    d.setDate(d.getDate() - day);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  };

  const order: string[] = [];
  const map = new Map<string, Bucket>();
  series.forEach((p, i) => {
    const k = keyOf(p.date);
    if (!map.has(k)) {
      order.push(k);
      map.set(k, {
        key: k,
        label: grain === "month"
          ? new Date(`${k}-01T00:00:00`).toLocaleDateString(undefined, { month: "short" })
          : fmtDay(k),
        full: grain === "month"
          ? new Date(`${k}-01T00:00:00`).toLocaleDateString(undefined, { month: "long", year: "numeric" })
          : `week of ${fmtDay(k)}`,
        now: 0,
        before: 0,
        beforeFull: "",
        beforeLabel: "",
      });
    }
    const b = map.get(k)!;
    b.now += num(p.amount);
    b.before += num(prev[i]?.amount);
    // The comparison bucket spans whichever previous-window days landed in it.
    const pd = prev[i]?.date;
    if (pd) {
      const first = b.beforeFull.split(" – ")[0] || fmtDay(pd);
      b.beforeFull = first === fmtDay(pd) ? first : `${first} – ${fmtDay(pd)}`;
      b.beforeLabel = b.beforeFull;
    }
  });
  return { grain, buckets: order.map((k) => map.get(k)!) };
}

/**
 * Axis ticks on clean numbers — 0 / 5,000 / 10,000, never 0 / 4,317 / 8,634.
 *
 * The top tick must be at or ABOVE the biggest value, because the plot is scaled to
 * it: this stopped at the last tick below the max, so 26,000 against a 20,000 top
 * put the bar 30% above the plot and the SVG simply cut it off. A day of 28,333 ETB
 * was drawn the same height as the 20,000 gridline it had passed — the one reading
 * on the chart that has to be trustworthy is the height of the bars.
 */
function niceTicks(max: number, count = 4): number[] {
  if (max <= 0) return [0];
  const raw = max / count;
  const mag = Math.pow(10, Math.floor(Math.log10(raw)));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= raw) ?? 10 * mag;
  const top = Math.ceil(max / step) * step;
  const out: number[] = [];
  for (let v = 0; v <= top + step * 0.001; v += step) out.push(v);
  return out;
}

export function RevenueChart({ series, prev, comparing }: {
  series: FinDayPoint[];
  prev: FinDayPoint[];
  /** Label for the comparison window, e.g. "previous 30 days". */
  comparing: string;
}) {
  const [view, setView] = useState<"chart" | "table">("chart");
  const [hover, setHover] = useState<number | null>(null);
  // The plot is drawn at the container's REAL width, so one viewBox unit is one CSS
  // pixel. A fixed 720-wide viewBox looked right on a desk and fell apart on a phone:
  // scaled to a 293px card it shrank every 10px label to 4px AND, because the box
  // kept its 234px height while the drawing scaled uniformly, squeezed the plot into
  // the middle 40% of a mostly-empty card. At 1:1 a bar is 24px because it says 24.
  const wrapRef = useRef<HTMLDivElement>(null);
  const [boxW, setBoxW] = useState(720);
  useEffect(() => {
    const el = wrapRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(([e]) => setBoxW(Math.max(280, Math.round(e.contentRect.width))));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const { buckets, grain } = useMemo(() => bucketise(series, prev), [series, prev]);

  const max = Math.max(1, ...buckets.map((b) => Math.max(b.now, b.before)));
  const ticks = niceTicks(max);
  const top = ticks[ticks.length - 1];
  const hasCompare = buckets.some((b) => b.before > 0);

  // Geometry in a fixed viewBox, scaled by CSS. The container includes the axis
  // band, so the card never grows a nested scrollbar to show its own labels.
  // The axis carries a second row of dates when a comparison is drawn: the grey
  // line's points are aligned by position, so the day under them on the axis is NOT
  // the day they happened on. Without its own labels the line's peak reads as this
  // period's data for a date that has none, which is exactly how it was misread.
  const W = boxW, H = hasCompare ? 234 : 220, padL = 52, padR = 8, padT = 8;
  const padB = hasCompare ? 40 : 26;
  const plotW = W - padL - padR, plotH = H - padT - padB;
  const band = plotW / Math.max(1, buckets.length);
  const barW = Math.min(24, Math.max(3, band - 2)); // ≤24px cap, 2px surface gap
  const y = (v: number) => padT + plotH - (v / top) * plotH;
  const xMid = (i: number) => padL + band * i + band / 2;

  const peak = buckets.reduce((a, b) => (b.now > a.now ? b : a), buckets[0] ?? { now: 0 } as Bucket);
  const active = hover !== null ? buckets[hover] : null;
  // The comparison window, stated outright rather than left to be worked out.
  const prevSpan = prev.length
    ? `${fmtShort(prev[0].date)} – ${fmtShort(prev[prev.length - 1].date)}`
    : "";

  if (buckets.length === 0) {
    return <p className="py-10 text-center text-sm text-muted-foreground">No days in this period.</p>;
  }

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center justify-between gap-2">
        {/* Legend: present because two encodings are on the plot, and mirroring the
            mark — a rect for the bars, a stroke for the line. */}
        <div className="flex flex-wrap items-center gap-3 text-xs">
          <span className="inline-flex items-center gap-1.5">
            <span className="h-2.5 w-2.5 rounded-sm" style={{ background: SERIES }} />
            <span className="text-muted-foreground">This period</span>
          </span>
          {hasCompare && (
            <span className="inline-flex items-center gap-1.5">
              <svg width="14" height="6" aria-hidden><line x1="0" y1="3" x2="14" y2="3" stroke={COMPARE} strokeWidth="2" strokeLinecap="round" /></svg>
              {/* "day for day" is the honest claim: point i against point i. Only the
                  7-day preset happens to line the weekdays up, so the exact date is
                  given wherever the value is actually read. */}
              <span className="text-muted-foreground">
                {comparing}{prevSpan && ` · ${prevSpan}`}
              </span>
            </span>
          )}
          <span className="rounded-full bg-muted px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
            by {grain}
          </span>
        </div>
        <button type="button" onClick={() => setView(view === "chart" ? "table" : "chart")}
          className="inline-flex items-center gap-1.5 rounded-md border px-2 py-1 text-xs font-medium text-muted-foreground transition-colors hover:bg-accent hover:text-foreground">
          {view === "chart" ? <><Table2 className="h-3.5 w-3.5" /> Table</> : <><BarChart3 className="h-3.5 w-3.5" /> Chart</>}
        </button>
      </div>

      {view === "table" ? (
        // Every value the tooltip shows, reachable without a pointer.
        <div className="max-h-64 overflow-y-auto rounded-md border">
          <table className="w-full text-sm">
            <thead className="sticky top-0 border-b bg-muted/60 text-left text-[10px] uppercase tracking-wide text-muted-foreground">
              <tr>
                <th className="px-3 py-1.5 font-semibold">{grain === "day" ? "Day" : grain === "week" ? "Week" : "Month"}</th>
                <th className="px-3 py-1.5 text-right font-semibold">This period</th>
                {hasCompare && <th className="px-3 py-1.5 text-right font-semibold">{comparing}</th>}
              </tr>
            </thead>
            <tbody className="divide-y">
              {buckets.map((b) => (
                <tr key={b.key}>
                  <td className="px-3 py-1.5">{b.full}</td>
                  <td className="px-3 py-1.5 text-right tabular-nums">{b.now > 0 ? etb(b.now) : "—"}</td>
                  {hasCompare && (
                    <td className="px-3 py-1.5 text-right tabular-nums text-muted-foreground">
                      {b.before > 0 ? etb(b.before) : "—"}
                      {b.beforeFull && <span className="ml-1.5 text-[11px]">{b.beforeFull}</span>}
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <div className="relative" ref={wrapRef}>
          {/* One pointer handler for the whole plot rather than per-bar enter/leave.
              React's synthetic mouseenter did not fire on these SVG rects at all —
              hover worked on keyboard focus and silently not with a mouse — and
              resolving the band from the pointer's x gives a hit area the width of
              the band, which is what the reader is aiming at anyway. */}
          <svg viewBox={`0 0 ${W} ${H}`} className="w-full" style={{ height: H }}
            role="img" aria-label={`Collected per ${grain}. Peak ${etb(peak?.now ?? 0)}.`}
            onPointerMove={(e) => {
              const r = e.currentTarget.getBoundingClientRect();
              const x = ((e.clientX - r.left) / r.width) * W;
              if (x < padL || x > W - padR) { setHover(null); return; }
              const i = Math.floor((x - padL) / band);
              setHover(i >= 0 && i < buckets.length ? i : null);
            }}
            onPointerLeave={() => setHover(null)}>
            {/* Solid hairline grid, one shade off the surface. Never dashed. */}
            {ticks.map((t) => (
              <g key={t}>
                <line x1={padL} y1={y(t)} x2={W - padR} y2={y(t)} stroke={GRID} strokeWidth="1" />
                <text x={padL - 8} y={y(t) + 3.5} textAnchor="end"
                  className="fill-muted-foreground" style={{ fontSize: 10, fontVariantNumeric: "tabular-nums" }}>
                  {t.toLocaleString()}
                </text>
              </g>
            ))}

            {buckets.map((b, i) => {
              const on = hover === i;
              const h = b.now > 0 ? Math.max(3, plotH - (y(b.now) - padT)) : 0;
              return (
                <g key={b.key}>
                  {/* The hit area is the whole band, not the painted bar: a 3px
                      column is not something anyone lands on. */}
                  {/* Focusable so a keyboard reader gets the same readout a pointer
                      does; the pointer itself is handled once, on the svg. */}
                  <rect x={padL + band * i} y={padT} width={band} height={plotH} fill="transparent"
                    tabIndex={0} role="button"
                    aria-label={`${b.full}: ${etb(b.now)}`}
                    onFocus={() => setHover(i)} onBlur={() => setHover(null)}
                    style={{ outline: "none" }} />
                  {on && <rect x={padL + band * i} y={padT} width={band} height={plotH} fill={SERIES} opacity={0.06} />}
                  {b.now > 0 && (
                    // 4px rounded data-end, square at the baseline: draw the bar as a
                    // path so only the top corners round.
                    <path
                      d={roundedTop(xMid(i) - barW / 2, y(b.now), barW, h, 4)}
                      fill={SERIES}
                      opacity={hover === null || on ? 1 : 0.55}
                      style={{ transition: "opacity 120ms" }}
                    />
                  )}
                </g>
              );
            })}

            {/* The comparison, as a 2px round-capped line above the bars — with a dot
                on every point it was actually measured at.
                Without the dots the line is read as a continuous quantity, and a
                single day's takings between two empty days becomes a mountain whose
                slopes look like data for the days under them. The dots say "seven
                daily figures, joined", which is what it is. */}
            {hasCompare && (
              <>
                <polyline
                  points={buckets.map((b, i) => `${xMid(i)},${y(b.before)}`).join(" ")}
                  fill="none" stroke={COMPARE} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"
                  opacity={0.75}
                />
                {buckets.length <= 31 && buckets.map((b, i) => (
                  <circle key={b.key} cx={xMid(i)} cy={y(b.before)} r={2.5}
                    fill={COMPARE} opacity={hover === i ? 1 : 0.75} />
                ))}
              </>
            )}

            {/* Selective direct label: the peak only. A number on every bar is noise. */}
            {peak && peak.now > 0 && hover === null && (
              <text x={xMid(buckets.indexOf(peak))} y={y(peak.now) - 6} textAnchor="middle"
                className="fill-foreground" style={{ fontSize: 10, fontWeight: 600 }}>
                {etb(peak.now)}
              </text>
            )}

            {/* X labels, thinned so they never collide. Two rows when comparing: this
                period's day, and under it in grey the day the line's point is from. */}
            {buckets.map((b, i) => {
              // One label per ~52px of plot: "Aug 14" is about 36px at this size, so
              // a fixed "every 8th" collided as soon as the card got narrow.
              const room = Math.max(2, Math.floor(plotW / 52));
              const every = Math.ceil(buckets.length / room);
              if (i % every !== 0 && i !== buckets.length - 1) return null;
              return (
                <g key={b.key}>
                  <text x={xMid(i)} y={H - (hasCompare ? 22 : 8)} textAnchor="middle"
                    className="fill-muted-foreground" style={{ fontSize: 10 }}>
                    {b.label}
                  </text>
                  {hasCompare && b.beforeLabel && (
                    <text x={xMid(i)} y={H - 8} textAnchor="middle"
                      fill={COMPARE} opacity={0.8} style={{ fontSize: 9 }}>
                      {b.beforeLabel}
                    </text>
                  )}
                </g>
              );
            })}
          </svg>

          {/* The readout. Value leads, label follows — the reader has the series and
              wants the number. Positioned by band so it never covers its own bar. */}
          {active && (
            <div
              className="pointer-events-none absolute top-2 z-10 min-w-[9rem] rounded-lg border bg-popover p-2.5 shadow-modal"
              style={{
                left: `${((padL + band * (hover ?? 0) + band / 2) / W) * 100}%`,
                transform: (hover ?? 0) > buckets.length / 2 ? "translateX(-105%)" : "translateX(5%)",
              }}
            >
              <div className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">{active.full}</div>
              <div className="mt-0.5 flex items-baseline gap-1.5">
                <span className="h-2.5 w-0.5 rounded" style={{ background: SERIES }} />
                <span className="text-base font-bold tabular-nums">{etb(active.now)}</span>
              </div>
              {hasCompare && (
                <div className="mt-0.5 flex items-baseline gap-1.5">
                  <svg width="10" height="4" aria-hidden><line x1="0" y1="2" x2="10" y2="2" stroke={COMPARE} strokeWidth="2" strokeLinecap="round" /></svg>
                  {/* The comparison value is NOT this day's — say whose it is, or the
                      line reads as a second measurement of the date under it. */}
                  <span className="text-xs tabular-nums text-muted-foreground">
                    {etb(active.before)}
                    {active.beforeFull && <span className="ml-1">· {active.beforeFull}</span>}
                  </span>
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/** A bar with only its top corners rounded — the data-end is round, the baseline square. */
function roundedTop(x: number, yTop: number, w: number, h: number, r: number) {
  const rr = Math.min(r, w / 2, h);
  const bottom = yTop + h;
  return `M${x},${bottom} L${x},${yTop + rr} Q${x},${yTop} ${x + rr},${yTop} L${x + w - rr},${yTop} Q${x + w},${yTop} ${x + w},${yTop + rr} L${x + w},${bottom} Z`;
}
