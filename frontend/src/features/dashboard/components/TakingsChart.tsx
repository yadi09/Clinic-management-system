// The money chart: what came in, where from, and how it was paid.
//
// Loaded lazily (React.lazy in the page), because the chart library is the heaviest
// thing on the page and the one thing on it nobody needs in the first second. Its
// data is its own request for the same reason.
//
// A bar opens that day in Finance. On a touch screen the first tap shows the day
// instead — a tap meant to read a bar must not throw you onto another page — with the
// link to open it right there.
import { useMemo, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { ArrowRight } from "lucide-react";
import { Bar, BarChart, CartesianGrid, Cell, Pie, PieChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";

import { LoadError } from "@/components/LoadError";
import { Segmented } from "@/components/ui/segmented";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import { dashKeys, dashboardTakings, type DashLine } from "../api";
import { dayMonth, etb, num, shortDay, weekday } from "../format";
import type { DashLinks } from "../links";
import { Pct } from "./MoneyTiles";
import { Num } from "./Num";

const RANGES = [7, 30, 90] as const;
type Range = (typeof RANGES)[number];
const STORE = "dashboard:range";

const PALETTE = ["hsl(var(--brand))", "hsl(var(--primary))", "#3A86C8", "hsl(var(--warning))", "hsl(var(--muted-foreground))"];

interface Point { key: string; label: string; date: string; amount: number; count: number; today: boolean; week: boolean }

function savedRange(): Range {
  try {
    const v = Number(localStorage.getItem(STORE));
    return (RANGES as readonly number[]).includes(v) ? (v as Range) : 30;
  } catch { return 30; }
}

// The plot's left and right gutters, shared by the chart and the touch hit-test.
const Y_AXIS = 40;
const RIGHT = 4;

const coarse = () => typeof window !== "undefined" && window.matchMedia?.("(pointer: coarse)").matches;

export default function TakingsChart({ links, today }: { links: DashLinks; today: string }) {
  const [range, setRange] = useState<Range>(savedRange);
  const [picked, setPicked] = useState<Point | null>(null);
  const navigate = useNavigate();
  const q = useQuery({
    queryKey: dashKeys.takings(range),
    queryFn: () => dashboardTakings(range),
    refetchInterval: 120_000,
    placeholderData: (prev) => prev,
  });
  const choose = (r: Range) => {
    setRange(r); setPicked(null);
    try { localStorage.setItem(STORE, String(r)); } catch { /* private mode */ }
  };

  const points = useMemo<Point[]>(() => {
    const s = q.data?.series ?? [];
    if (range !== 90) {
      return s.map((p) => ({
        key: p.date, date: p.date, amount: num(p.amount), count: p.count, today: p.date === today, week: false,
        label: p.date === today ? "Today" : range === 7 ? weekday(p.date) : dayMonth(p.date),
      }));
    }
    // Ninety bars are slivers; thirteen weeks are a shape.
    const out: Point[] = [];
    for (let end = s.length; end > 0; end -= 7) {
      const wk = s.slice(Math.max(0, end - 7), end);
      out.unshift({
        key: wk[0].date, date: wk[0].date, label: dayMonth(wk[0].date), today: false, week: true,
        amount: wk.reduce((a, p) => a + num(p.amount), 0), count: wk.reduce((a, p) => a + p.count, 0),
      });
    }
    return out;
  }, [q.data, range, today]);

  const open = (p: Point) => (p.week ? links.finance(`${range}d`) : links.finance(p.date));
  const onBar = (p: Point) => {
    const href = open(p);
    if (!href || coarse()) { setPicked(p); return; }
    navigate(href);
  };

  const total = num(q.data?.total), prev = num(q.data?.prev);
  const empty = !!q.data && points.every((p) => p.amount === 0);
  const tickEvery = range === 7 ? 1 : range === 30 ? 7 : 2;

  return (
    <div className="grid grid-cols-1 gap-3.5 xl:grid-cols-[minmax(0,1.75fr)_minmax(0,1fr)]">
      <div className="min-w-0 rounded-xl border bg-card p-4 shadow-card">
        <div className="mb-2 flex flex-wrap items-start justify-between gap-x-4 gap-y-2">
          <div>
            <p className="text-[13px] text-muted-foreground">Money collected</p>
            <p className="text-2xl font-bold tracking-tight tabular-nums">
              <Num value={total} /><span className="ml-1 text-sm font-semibold tracking-normal text-muted-foreground">ETB</span>
            </p>
            <p className="text-[13px] text-muted-foreground">
              {q.data ? <Pct cur={total} prev={prev} suffix={`on the ${range} days before`} /> : " "}
            </p>
          </div>
          <Segmented size="sm" ariaLabel="Range" value={String(range)} onChange={(v) => choose(Number(v) as Range)}
            options={RANGES.map((r) => ({ value: String(r), label: `${r} days` }))} />
        </div>

        {q.isError && !q.data ? (
          <LoadError what="the money chart" onRetry={() => void q.refetch()} />
        ) : !q.data ? (
          <Skeleton className="h-[230px] w-full" />
        ) : empty ? (
          <div className="flex h-[230px] flex-col items-center justify-center gap-1 rounded-lg border border-dashed px-4 text-center text-sm text-muted-foreground">
            <b className="text-foreground">Nothing collected in the last {range} days.</b>
            The chart fills in day by day as payments are taken.
          </div>
        ) : (
          <div className={cn("h-[230px] w-full", q.isFetching && "opacity-70 transition-opacity")}
            // Touch: Recharts cancels touch events to drive its own tooltip, so a tap
            // never becomes a click. Work out the bar from where the finger landed.
            onPointerUp={(e) => {
              if (e.pointerType === "mouse" || points.length === 0) return;
              const r = e.currentTarget.getBoundingClientRect();
              const left = r.left + Y_AXIS, width = r.width - Y_AXIS - RIGHT;
              const i = Math.floor(((e.clientX - left) / width) * points.length);
              if (i >= 0 && i < points.length) setPicked(points[i]);
            }}>
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={points} margin={{ top: 8, right: RIGHT, bottom: 0, left: 0 }} accessibilityLayer>
                <CartesianGrid vertical={false} stroke="hsl(var(--border))" strokeDasharray="3 4" />
                <XAxis dataKey="label" tickLine={false} axisLine={false} fontSize={11} tickMargin={6}
                  interval={0} tick={(props) => <Tick {...props} points={points} every={tickEvery} />} />
                <YAxis width={Y_AXIS} tickLine={false} axisLine={false} fontSize={11}
                  tick={{ fill: "hsl(var(--muted-foreground))" }}
                  tickFormatter={(v: number) => (v >= 1000 ? `${Math.round(v / 100) / 10}k` : String(v))} />
                <Tooltip cursor={{ fill: "hsl(var(--muted))", opacity: 0.6 }} content={<TipBox />} />
                <Bar dataKey="amount" radius={[4, 4, 0, 0]} maxBarSize={36} className="cursor-pointer">
                  {points.map((p) => (
                    // On the bar itself: a tap has no hover, so the chart's "active" bar
                    // is unset on touch and a chart-level click cannot tell which it was.
                    <Cell key={p.key} onClick={() => onBar(p)}
                      fill={p.amount === 0 ? "hsl(var(--muted))" : p.today ? "hsl(var(--primary))" : "hsl(var(--brand))"}
                      fillOpacity={p.today || p.amount === 0 ? 1 : 0.85} />
                  ))}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          </div>
        )}

        {picked && (
          <div className="mt-2 flex flex-wrap items-center justify-between gap-2 rounded-lg bg-muted/70 px-3 py-2 text-sm">
            <span>
              <b>{picked.week ? `Week of ${dayMonth(picked.date)}` : picked.today ? "Today so far" : shortDay(picked.date)}</b>
              {" · "}{etb(picked.amount)}{picked.count > 0 && ` · ${picked.count} payments`}
            </span>
            {open(picked) && (
              <Link to={open(picked)!} className="inline-flex items-center gap-1 font-medium text-primary hover:underline">
                See {picked.week ? "these days" : "this day"} <ArrowRight className="h-3.5 w-3.5" />
              </Link>
            )}
          </div>
        )}
      </div>

      <Breakdown sources={q.data?.by_source} methods={q.data?.by_method} range={range} links={links} loading={!q.data} />
    </div>
  );
}

/** Every label for a week; one a week for a month; one a fortnight for a quarter.
 *  Today is always labelled, because it is the bar people look for first. */
function Tick(props: { x?: number | string; y?: number | string; index?: number; payload?: { value: string }; points: Point[]; every: number }) {
  const { index = 0, payload, points, every } = props;
  const x = Number(props.x ?? 0), y = Number(props.y ?? 0);
  const last = points.length - 1;
  const p = points[index];
  if (!p || (!p.today && (last - index) % every !== 0)) return <g />;
  return (
    // The last label is anchored at its end, or "Today" runs off the right edge.
    <text x={x} y={y + 10} textAnchor={index === last ? "end" : "middle"} fontSize={11}
      fill={p.today ? "hsl(var(--primary))" : "hsl(var(--muted-foreground))"} fontWeight={p.today ? 600 : 400}>
      {payload?.value}
    </text>
  );
}

function TipBox({ active, payload }: { active?: boolean; payload?: { payload: Point }[] }) {
  const p = active ? payload?.[0]?.payload : undefined;
  if (!p) return null;
  const closed = !p.week && p.amount === 0 && new Date(`${p.date}T00:00:00`).getDay() === 0;
  return (
    <div className="rounded-lg bg-foreground px-3 py-2 text-[12.5px] leading-snug text-background shadow-popover">
      <div>{p.week ? `Week of ${dayMonth(p.date)}` : p.today ? "Today so far" : shortDay(p.date)}</div>
      {p.amount > 0
        ? <div><b className="text-sm">{etb(p.amount)}</b>{p.count > 0 && ` · ${p.count} payments`}</div>
        : <div>{closed ? "Closed" : "Nothing collected"}</div>}
    </div>
  );
}

function Breakdown({ sources, methods, range, links, loading }: {
  sources?: DashLine[]; methods?: DashLine[]; range: number; links: DashLinks; loading: boolean;
}) {
  const src = (sources ?? []).filter((s) => num(s.amount) > 0);
  const total = src.reduce((a, s) => a + num(s.amount), 0);
  const met = (methods ?? []).filter((m) => num(m.amount) > 0);
  const mtotal = met.reduce((a, m) => a + num(m.amount), 0);
  const services = links.finance(`${range}d`, "services");
  const cash = links.finance(`${range}d`, "cash");

  return (
    <div className="min-w-0 rounded-xl border bg-card p-4 shadow-card [container-type:inline-size]">
      <p className="mb-2.5 text-[13px] text-muted-foreground">Where it came from · {range} days</p>
      {loading ? (
        <Skeleton className="h-[200px] w-full" />
      ) : total <= 0 ? (
        <p className="py-10 text-center text-sm text-muted-foreground">Nothing collected in this period.</p>
      ) : (
        <>
          <div className="flex items-center gap-4 [@container(max-width:320px)]:flex-col">
            <div className="relative h-[124px] w-[124px] shrink-0">
              <ResponsiveContainer width="100%" height="100%">
                <PieChart>
                  <Pie data={src.map((s) => ({ name: s.label, value: num(s.amount) }))} dataKey="value" nameKey="name"
                    innerRadius={44} outerRadius={60} paddingAngle={src.length > 1 ? 2 : 0} stroke="none" isAnimationActive>
                    {src.map((s, i) => <Cell key={s.key} fill={PALETTE[i % PALETTE.length]} />)}
                  </Pie>
                </PieChart>
              </ResponsiveContainer>
              <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center">
                <span className="text-base font-bold tabular-nums">{total >= 10000 ? `${Math.round(total / 1000)}k` : Math.round(total).toLocaleString()}</span>
                <span className="text-[10.5px] text-muted-foreground">ETB</span>
              </div>
            </div>
            <ul className="w-full min-w-0 flex-1">
              {src.map((s, i) => {
                const row = (
                  <>
                    <span className="h-2.5 w-2.5 shrink-0 rounded-[3px]" style={{ background: PALETTE[i % PALETTE.length] }} />
                    <span className="min-w-0 flex-1 truncate">{s.label}</span>
                    <b className="font-semibold tabular-nums">{Math.round(num(s.amount)).toLocaleString()}</b>
                  </>
                );
                return (
                  <li key={s.key} title={`${Math.round((num(s.amount) / total) * 100)}%`}>
                    {services
                      ? <Link to={services} className="-mx-1.5 flex items-center gap-2 rounded-md px-1.5 py-1 text-[13.5px] hover:bg-muted/60">{row}</Link>
                      : <div className="flex items-center gap-2 py-1 text-[13.5px]">{row}</div>}
                  </li>
                );
              })}
            </ul>
          </div>
          {mtotal > 0 && (
            <div className="mt-3.5 border-t pt-3">
              <div className="mb-1.5 flex items-baseline justify-between">
                <p className="text-[13px] text-muted-foreground">How it was paid</p>
                {cash && <Link to={cash} className="text-[12.5px] font-medium text-primary hover:underline">Cash & shifts</Link>}
              </div>
              <div className="flex h-3 gap-0.5 overflow-hidden rounded-full">
                {met.map((m, i) => (
                  <span key={m.key} style={{ width: `${(num(m.amount) / mtotal) * 100}%`, background: PALETTE[i % PALETTE.length] }} />
                ))}
              </div>
              <div className="mt-2 flex flex-wrap gap-x-3.5 gap-y-1 text-[12.5px] text-muted-foreground">
                {met.map((m, i) => (
                  <span key={m.key} className="inline-flex items-center gap-1.5">
                    <span className="h-2.5 w-2.5 rounded-[3px]" style={{ background: PALETTE[i % PALETTE.length] }} />
                    {m.label} <b className="text-foreground">{Math.round((num(m.amount) / mtotal) * 100)}%</b>
                  </span>
                ))}
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}
