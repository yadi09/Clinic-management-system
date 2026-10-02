// Who owes you and for how long; and the week ahead.
//
// Ageing comes from the Finance page's own Receivables (the same buckets, the same
// order — oldest debt first, because old debt is the debt that never arrives). It is
// the "debt ageing" line of a plan, so it is absent when the plan does not include it.
import { Link } from "react-router-dom";
import { ArrowRight } from "lucide-react";

import { cn } from "@/lib/utils";
import type { DashBucket, DashOwer, DashWeekDay } from "../api";
import { etb, initials, num, plural, weekday } from "../format";
import type { DashLinks } from "../links";

const BUCKET_COLOR: Record<string, string> = {
  "0-30": "bg-warning", "31-60": "bg-orange-500", "61-90": "bg-destructive", "90+": "bg-red-900",
};
const BUCKET_LABEL: Record<string, string> = {
  "0-30": "Under 30 days", "31-60": "30 to 60", "61-90": "60 to 90", "90+": "Over 90",
};

export function OwedCard({ aging, owers, links }: { aging: DashBucket[]; owers: DashOwer[]; links: DashLinks }) {
  const total = aging.reduce((s, b) => s + num(b.amount), 0);
  const all = links.receivables();
  return (
    <div className="rounded-xl border bg-card p-4 shadow-card">
      <div className="flex items-baseline justify-between gap-2">
        <h3 className="text-sm font-semibold">Who owes you, by how long</h3>
        {all && <Link to={all} className="inline-flex items-center gap-1 text-[13px] font-medium text-primary hover:underline">All <ArrowRight className="h-3.5 w-3.5" /></Link>}
      </div>
      {total <= 0 ? (
        <p className="py-8 text-center text-sm text-muted-foreground">Nobody owes you anything.</p>
      ) : (
        <>
          <div className="my-3 flex h-3.5 gap-0.5 overflow-hidden rounded-full">
            {aging.filter((b) => num(b.amount) > 0).map((b) => (
              <span key={b.key} className={BUCKET_COLOR[b.key]} style={{ width: `${(num(b.amount) / total) * 100}%` }}
                title={`${BUCKET_LABEL[b.key]}: ${etb(b.amount)}`} />
            ))}
          </div>
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
            {aging.map((b) => {
              const href = links.receivables(b.key);
              const body = (
                <>
                  <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
                    <span className={cn("h-2 w-2 rounded-sm", BUCKET_COLOR[b.key])} />{BUCKET_LABEL[b.key]}
                  </span>
                  <span className="block text-[14px] font-semibold tabular-nums">{Math.round(num(b.amount)).toLocaleString()}</span>
                  <span className="block text-xs text-muted-foreground">{plural(b.count, "patient", "patients")}</span>
                </>
              );
              return href && b.count > 0
                ? <Link key={b.key} to={href} className="-m-1 rounded-lg p-1 transition-colors hover:bg-muted/60">{body}</Link>
                : <div key={b.key}>{body}</div>;
            })}
          </div>
          <ul className="mt-3 divide-y border-t">
            {owers.map((o) => {
              const href = links.patient(o.patient_id, { money: true });
              const row = (
                <>
                  <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-brand/10 text-[11px] font-bold text-brand">{initials(o.name)}</span>
                  <span className="min-w-0 flex-1 truncate text-sm">
                    {o.name}<span className="ml-1.5 text-[12.5px] text-muted-foreground">{o.why}</span>
                  </span>
                  <span className={cn("shrink-0 whitespace-nowrap rounded-full px-2 py-0.5 text-[11.5px] font-semibold",
                    o.oldest_days > 60 ? "bg-destructive/10 text-destructive" : "bg-warning/10 text-warning")}>
                    {o.oldest_days === 0 ? "today" : plural(o.oldest_days, "day", "days")}
                  </span>
                  <b className="w-16 shrink-0 text-right text-sm tabular-nums">{Math.round(num(o.owed)).toLocaleString()}</b>
                </>
              );
              return (
                <li key={o.patient_id}>
                  {href
                    ? <Link to={href} className="-mx-2 flex items-center gap-2.5 rounded-lg px-2 py-2 transition-colors hover:bg-muted/60">{row}</Link>
                    : <div className="flex items-center gap-2.5 py-2">{row}</div>}
                </li>
              );
            })}
          </ul>
        </>
      )}
    </div>
  );
}

export function WeekAhead({ week, links, showMoney }: { week: DashWeekDay[]; links: DashLinks; showMoney: boolean }) {
  const max = Math.max(1, ...week.map((d) => d.visits));
  const visits = week.reduce((s, d) => s + d.visits, 0);
  const worth = week.reduce((s, d) => s + num(d.amount), 0);
  const all = links.appointments();
  return (
    <div className="rounded-xl border bg-card p-4 shadow-card">
      <div className="flex items-baseline justify-between gap-2">
        <h3 className="text-sm font-semibold">The week ahead</h3>
        {all && <Link to={all} className="inline-flex items-center gap-1 text-[13px] font-medium text-primary hover:underline">Appointments <ArrowRight className="h-3.5 w-3.5" /></Link>}
      </div>
      <div className="mt-2 grid h-[136px] grid-cols-7 items-end gap-1.5 sm:gap-2">
        {week.map((d, i) => {
          const href = links.appointments({ date: d.date });
          const body = (
            <>
              <span className="text-[12.5px] font-semibold tabular-nums">{d.visits || ""}</span>
              <span className={cn("w-full max-w-[34px] rounded-t-md rounded-b-sm transition-[height] duration-700",
                d.visits === 0 ? "bg-muted" : i === 0 ? "bg-primary" : "bg-brand/85")}
                style={{ height: d.visits ? `${(d.visits / max) * 88}px` : "4px" }} />
              <span className="whitespace-nowrap text-[11.5px] text-muted-foreground">{i === 0 ? "Tomorrow" : weekday(d.date)}</span>
            </>
          );
          const cls = "flex h-full min-w-0 flex-col items-center justify-end gap-1";
          return href
            ? <Link key={d.date} to={href} aria-label={`${weekday(d.date)}: ${plural(d.visits, "visit", "visits")}`}
                className={cn(cls, "rounded-lg transition-colors hover:bg-muted/50")}>{body}</Link>
            : <div key={d.date} className={cls}>{body}</div>;
        })}
      </div>
      <div className="mt-3 flex flex-wrap justify-between gap-2 border-t pt-2.5 text-[13px] text-muted-foreground">
        <span><b className="text-foreground">{plural(visits, "visit", "visits")}</b> booked in the next 7 days</span>
        {showMoney && worth > 0 && <span>Worth about <b className="text-foreground">{etb(worth)}</b></span>}
      </div>
    </div>
  );
}
