// Who is in the clinic today, as a journey: booked, waiting, in the chair, done.
//
// The old tiles counted four different things in four different ways — "seen today"
// counted closed doctor's notes, which a dental check-out never produces, so it sat at
// zero beside two patients in the chair. These are all patients, counted the way the
// reception screen counts them, so the two screens tell the same story.
import { Link } from "react-router-dom";
import { ArrowRight } from "lucide-react";

import { cn } from "@/lib/utils";
import type { DashFlow, DashUpcoming } from "../api";
import { clock, initials, minutes, plural } from "../format";
import type { DashLinks, Href } from "../links";
import { Num } from "./Num";

export function TodayFlow({ f, date, links }: { f: DashFlow; date: string; links: DashLinks }) {
  const total = Math.max(1, f.booked + f.walk_ins);
  const seg = (v: number) => `${(v / total) * 100}%`;
  const queue = links.queue();
  return (
    <section aria-labelledby="today" className="space-y-2.5">
      <div className="flex items-baseline justify-between gap-3">
        <h2 id="today" className="text-[15px] font-semibold">Today in the clinic</h2>
        {queue && (
          <Link to={queue} className="inline-flex items-center gap-1 text-[13px] font-medium text-primary hover:underline">
            Open {links.dental ? "chairside" : "reception"} <ArrowRight className="h-3.5 w-3.5" />
          </Link>
        )}
      </div>
      <div className="grid grid-cols-1 gap-3.5 xl:grid-cols-[minmax(0,1.75fr)_minmax(0,1fr)]">
        <div className="flex flex-col rounded-xl border bg-card px-1 pb-3.5 pt-4 shadow-card">
          <div className="grid grid-cols-2 sm:grid-cols-4">
            <Stage label="Booked today" value={f.booked} to={links.appointments({ date })}
              sub={f.walk_ins > 0 ? <>plus <b>{plural(f.walk_ins, "walk-in", "walk-ins")}</b></> : "no walk-ins yet"} />
            <Stage label="Waiting" value={f.waiting} tone="wait" to={links.reception() ?? queue}
              sub={f.waiting > 0 && f.longest_wait > 0 ? <>longest <b>{minutes(f.longest_wait)}</b></> : "nobody waiting"} />
            <Stage label={links.dental ? "In the chair" : "With a clinician"} value={f.in_chair} tone="chair" to={links.chair()}
              live={f.in_chair > 0} sub={f.in_chair > 0 ? "being seen now" : "nobody right now"} />
            <Stage label="Done" value={f.done} tone="done" to={links.reception()}
              sub={<><b>{f.to_come}</b> still to come{f.late > 0 && <>, <b className="text-destructive">{f.late} late</b></>}</>} />
          </div>
          <div className="mx-3.5 mt-4 flex h-2.5 overflow-hidden rounded-full bg-muted" role="img"
            aria-label={`${f.done} done, ${f.in_chair} being seen, ${f.waiting} waiting, ${f.to_come} still to come`}>
            <span className="bg-primary transition-[width] duration-700" style={{ width: seg(f.done) }} />
            <span className="bg-brand transition-[width] duration-700" style={{ width: seg(f.in_chair) }} />
            <span className="bg-warning transition-[width] duration-700" style={{ width: seg(f.waiting) }} />
          </div>
          <div className="mx-3.5 mt-2 flex flex-wrap gap-x-3.5 gap-y-1 text-[12.5px] text-muted-foreground">
            <Key c="bg-primary" t="Done" /><Key c="bg-brand" t={links.dental ? "In the chair" : "With a clinician"} />
            <Key c="bg-warning" t="Waiting" /><Key c="bg-muted border" t="Still to come" />
          </div>
          <dl className="mx-3.5 mt-auto grid grid-cols-2 gap-2.5 pt-4 sm:grid-cols-4">
            <Stat k="Average wait" v={f.avg_wait > 0 ? minutes(f.avg_wait) : "—"} />
            <Stat k="Average visit" v={f.avg_visit > 0 ? minutes(f.avg_visit) : "—"} />
            <Stat k="First patient" v={f.first_arrival ? clock(f.first_arrival) : "—"} />
            <Stat k="Walk-ins" v={String(f.walk_ins)} />
          </dl>
        </div>

        <Upcoming list={f.upcoming} toCome={f.to_come} links={links} />
      </div>
    </section>
  );
}

function Stage({ label, value, sub, tone, to, live }: {
  label: string; value: number; sub: React.ReactNode; tone?: "wait" | "chair" | "done"; to: Href; live?: boolean;
}) {
  const body = (
    <>
      <span className="flex items-center gap-1.5 whitespace-nowrap text-[13px] text-muted-foreground">
        {tone && (
          <span className={cn("h-2 w-2 rounded-full",
            tone === "wait" ? "bg-warning" : tone === "chair" ? "bg-brand" : "bg-primary",
            live && "animate-pulse")} />
        )}
        {label}
      </span>
      <span className={cn("my-0.5 block text-[38px] font-bold leading-tight tracking-tight tabular-nums",
        tone === "wait" && value > 0 ? "text-warning" : tone === "chair" ? "text-brand" : tone === "done" ? "text-primary" : "text-foreground")}>
        <Num value={value} />
      </span>
      <span className="block text-[12.5px] leading-snug text-muted-foreground [&_b]:font-semibold [&_b]:text-foreground">{sub}</span>
    </>
  );
  const cls = "block min-w-0 px-3.5 py-1 [&:nth-child(n+2)]:sm:border-l max-sm:[&:nth-child(even)]:border-l max-sm:[&:nth-child(n+3)]:mt-2 max-sm:[&:nth-child(n+3)]:border-t max-sm:[&:nth-child(n+3)]:pt-3";
  return to
    ? <Link to={to} className={cn(cls, "rounded-lg transition-colors hover:bg-muted/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring")}>{body}</Link>
    : <div className={cls}>{body}</div>;
}

function Key({ c, t }: { c: string; t: string }) {
  return <span className="inline-flex items-center gap-1.5"><span className={cn("h-2.5 w-2.5 rounded-[3px]", c)} />{t}</span>;
}

function Stat({ k, v }: { k: string; v: string }) {
  return (
    <div className="rounded-lg bg-muted/70 px-2.5 py-2">
      <dt className="text-xs text-muted-foreground">{k}</dt>
      <dd className="text-[15px] font-semibold tabular-nums">{v}</dd>
    </div>
  );
}

function Upcoming({ list, toCome, links }: { list: DashUpcoming[]; toCome: number; links: DashLinks }) {
  const more = toCome - list.length;
  const rest = links.reception() ?? links.appointments();
  return (
    <div className="rounded-xl border bg-card p-4 shadow-card">
      <div className="mb-1.5 flex items-baseline justify-between gap-2">
        <h3 className="text-sm font-semibold">Still to come</h3>
        <span className="text-[12.5px] text-muted-foreground">{toCome === 0 ? "everyone is here" : `${toCome} not here yet`}</span>
      </div>
      {list.length === 0 ? (
        <p className="py-6 text-center text-sm text-muted-foreground">
          {toCome === 0 ? "Nobody else is booked for today." : "No names to show."}
        </p>
      ) : (
        <ul className="divide-y">
          {list.map((u) => {
            const href = links.patient(u.patient_id);
            const row = (
              <>
                <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-brand/10 text-xs font-bold text-brand">
                  {initials(u.name)}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-semibold">{u.name}</span>
                  <span className="block truncate text-[12.5px] text-muted-foreground">
                    {[u.what, u.starts_at && clock(u.starts_at), u.provider].filter(Boolean).join(" · ")}
                  </span>
                </span>
                {(u.late_min ?? 0) > 0 && (
                  <span className="shrink-0 whitespace-nowrap rounded-full bg-destructive/10 px-2 py-0.5 text-[11.5px] font-semibold text-destructive">
                    {u.late_min! >= 60 ? `${Math.floor(u.late_min! / 60)} h late` : `${u.late_min} min late`}
                  </span>
                )}
              </>
            );
            return (
              <li key={u.patient_id}>
                {href
                  ? <Link to={href} className="-mx-2 flex items-center gap-2.5 rounded-lg px-2 py-2 transition-colors hover:bg-muted/60">{row}</Link>
                  : <div className="flex items-center gap-2.5 py-2">{row}</div>}
              </li>
            );
          })}
        </ul>
      )}
      {more > 0 && rest && (
        <Link to={rest} className="mt-1.5 inline-flex items-center gap-1 text-[13px] font-medium text-primary hover:underline">
          and {more} more <ArrowRight className="h-3.5 w-3.5" />
        </Link>
      )}
    </div>
  );
}
