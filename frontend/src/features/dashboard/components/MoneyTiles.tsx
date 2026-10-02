// The money, in four tiles, each opening the page behind it.
//
// "Collected today" is compared with yesterday AT THIS HOUR. Comparing 10:00 today
// with all of yesterday showed a drop every morning; the old tile then printed the
// drop as a bare "97%", which read as good news.
import { useId } from "react";
import { Link } from "react-router-dom";
import { ArrowRight } from "lucide-react";

import { cn } from "@/lib/utils";
import type { DashMoney } from "../api";
import { change, etb, num, plural } from "../format";
import type { DashLinks, Href } from "../links";
import { Num } from "./Num";

export function MoneyTiles({ m, links }: { m: DashMoney; links: DashLinks }) {
  const today = num(m.collected_today);
  const byNow = num(m.collected_yesterday_by_now);
  const last7 = num(m.last_7);
  const owed = num(m.owed), atCashier = num(m.owed_at_cashier), unbilled = num(m.owed_unbilled);
  const series = m.series.map((p) => num(p.amount));
  const fin = links.finance();
  const diff = today - byNow;

  return (
    <section aria-labelledby="money" className="space-y-2.5">
      <div className="flex items-baseline justify-between gap-3">
        <h2 id="money" className="text-[15px] font-semibold">Money</h2>
        {fin && (
          <Link to={fin} className="inline-flex items-center gap-1 text-[13px] font-medium text-primary hover:underline">
            Open finance <ArrowRight className="h-3.5 w-3.5" />
          </Link>
        )}
      </div>
      <div className={cn("grid grid-cols-2 gap-3", links.dental ? "lg:grid-cols-4" : "lg:grid-cols-3")}>
        <Tile label="Collected today" to={links.finance("today") ?? links.cashier()} value={today}
          note={byNow <= 0 && today <= 0 ? "Nothing collected yet today"
            : byNow <= 0 ? "Nothing by this time yesterday"
              : <><Signed v={diff} /> {diff >= 0 ? "more" : "less"} than yesterday by now</>}>
          <Spark values={series} tone="primary" />
        </Tile>
        <Tile label="Last 7 days" to={links.finance("7d")} value={last7}
          note={<Pct cur={last7} prev={num(m.prev_7)} suffix="on the week before" />}>
          <Spark values={series} tone="brand" />
        </Tile>
        <Tile label="Owed to you" to={links.receivables() ?? links.finance()} value={owed} danger={owed > 0}
          note={owed > 0 ? `${plural(m.owed_patients, "patient", "patients")}${m.oldest_days > 0 ? ` · oldest ${m.oldest_days} days` : ""}` : "Nobody owes you"}>
          {owed > 0 && (
            <>
              <div className="mt-3 flex h-1.5 overflow-hidden rounded-full bg-muted">
                <span className="bg-warning" style={{ width: `${(atCashier / owed) * 100}%` }} />
                <span className="bg-destructive" style={{ width: `${(unbilled / owed) * 100}%` }} />
              </div>
              <div className="mt-1.5 flex flex-wrap justify-between gap-x-2 text-xs text-muted-foreground">
                <span><b className="font-semibold text-foreground">{Math.round(atCashier).toLocaleString()}</b> at the cashier</span>
                {unbilled > 0 && <span><b className="font-semibold text-foreground">{Math.round(unbilled).toLocaleString()}</b> not sent</span>}
              </div>
            </>
          )}
        </Tile>
        {links.dental && (
          <Tile label="Booked ahead" to={links.finance(undefined, "book") ?? links.appointments({ view: "followups" })}
            value={num(m.booked_ahead)}
            note={m.booked_visits > 0 ? `${plural(m.booked_visits, "treatment visit", "treatment visits")} still to come` : "No visits booked ahead"} />
        )}
      </div>
    </section>
  );
}

function Tile({ label, value, note, to, danger, children }: {
  label: string; value: number; note: React.ReactNode; to: Href; danger?: boolean; children?: React.ReactNode;
}) {
  const body = (
    <>
      <span className="block text-[13px] text-muted-foreground">{label}</span>
      <span className={cn("mt-0.5 block whitespace-nowrap text-[22px] font-bold tracking-tight tabular-nums sm:text-[26px]",
        danger && "text-destructive")}>
        <Num value={value} /><span className="ml-1 text-sm font-semibold tracking-normal text-muted-foreground">ETB</span>
      </span>
      <span className="mt-0.5 block text-[12.5px] leading-snug text-muted-foreground">{note}</span>
      {children}
    </>
  );
  const cls = "block min-w-0 overflow-hidden rounded-xl border bg-card px-3.5 pb-3 pt-3.5 shadow-card sm:px-4";
  return to
    ? <Link to={to} className={cn(cls, "transition-[border-color,box-shadow] hover:border-brand/40 hover:shadow-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring")}>{body}</Link>
    : <div className={cls}>{body}</div>;
}

function Signed({ v }: { v: number }) {
  return (
    <b className={cn("font-semibold", v >= 0 ? "text-primary" : "text-destructive")}>
      {v >= 0 ? "↑" : "↓"} {etb(Math.abs(v))}
    </b>
  );
}

export function Pct({ cur, prev, suffix }: { cur: number; prev: number; suffix: string }) {
  const c = change(cur, prev);
  if (c === null) return <>{cur > 0 ? "Nothing to compare with yet" : "Nothing collected"}</>;
  return (
    <>
      <b className={cn("font-semibold", c >= 0 ? "text-primary" : "text-destructive")}>{c >= 0 ? "↑" : "↓"} {Math.abs(c)}%</b> {suffix}
    </>
  );
}

/** A fortnight as a line, drawn in plain SVG so it is on screen before the chart
 *  library has even loaded. Decoration with a purpose: the tile's number is the fact,
 *  this is whether the fact is normal. */
function Spark({ values, tone }: { values: number[]; tone: "primary" | "brand" }) {
  const gid = useId().replace(/:/g, "");
  if (values.length < 2 || values.every((v) => v === 0)) return <div className="mt-2 h-9" aria-hidden />;
  const w = 200, h = 36, max = Math.max(...values, 1);
  const pts = values.map((v, i) => [(i * w) / (values.length - 1), h - 3 - (v / max) * (h - 8)] as const);
  const line = pts.map(([x, y], i) => `${i ? "L" : "M"}${x.toFixed(1)} ${y.toFixed(1)}`).join(" ");
  const [lx, ly] = pts[pts.length - 1];
  const color = tone === "primary" ? "hsl(var(--primary))" : "hsl(var(--brand))";
  return (
    <svg className="mt-2 block h-9 w-full" viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none" aria-hidden>
      <defs>
        <linearGradient id={gid} x1="0" x2="0" y1="0" y2="1">
          <stop offset="0" stopColor={color} stopOpacity=".2" />
          <stop offset="1" stopColor={color} stopOpacity="0" />
        </linearGradient>
      </defs>
      <path d={`${line} L${w} ${h} L0 ${h} Z`} fill={`url(#${gid})`} />
      <path d={line} fill="none" stroke={color} strokeWidth="2" vectorEffect="non-scaling-stroke" strokeLinejoin="round" />
      <circle cx={lx} cy={ly} r="3" fill={color} />
    </svg>
  );
}
