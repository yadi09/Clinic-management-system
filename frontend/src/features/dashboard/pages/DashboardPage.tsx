// The clinic, right now.
//
// What was here before was configuration trivia: how many modules are enabled, how
// many permissions your role carries, what your role is called, and a list of module
// chips. All true, none of it a reason to open the page twice — and it told an owner
// nothing about the day they were standing in.
//
// The order below is the order the questions actually get asked. Is anything wrong
// (money given away, debt ageing, patients not arriving)? What is happening in the
// building right now? How is the money going? Anything I need to open? Attention
// comes FIRST because a dashboard's job is not to reassure — a clinic with 22,000 ETB
// of unbilled treatment should see that before it sees today's takings.
//
// Every figure is asked for once, from one endpoint, and the money in it comes from
// the same finance service the Finance page reads. The two cannot drift.
import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import {
  AlertTriangle, ArrowRight, ArrowUpRight, ArrowDownRight, CalendarClock,
  HandCoins, Search, Stethoscope, UserPlus, Users, Wallet,
} from "lucide-react";

import { Card, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import { useAuth } from "@/app/auth-context";
import { dashboardToday, type DashAlert } from "@/features/dashboard/api";

const num = (s?: string) => Number(s || 0);
const etb = (s?: string | number) =>
  `${Number(s || 0).toLocaleString(undefined, { maximumFractionDigits: 0 })} ETB`;

export function DashboardPage() {
  const { user, can } = useAuth();
  const q = useQuery({
    queryKey: ["dashboard-today"],
    queryFn: dashboardToday,
    // A clinic changes while you are looking at it: someone pays, someone arrives.
    refetchInterval: 60_000,
  });
  const d = q.data;
  const first = (user?.full_name || "").trim().split(/\s+/)[0] || "there";

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-h1">{greeting()}, {first}</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          {d?.clinic_name ? `${d.clinic_name} — ` : ""}{today()}
        </p>
      </div>

      {/* WHAT NEEDS YOU. First, deliberately. */}
      <Attention items={d?.attention ?? []} loading={q.isLoading} />

      {/* THE BUILDING, RIGHT NOW. */}
      {d?.flow && (
        <section className="space-y-2">
          <h2 className="text-xs font-bold uppercase tracking-wide text-muted-foreground">Right now</h2>
          <div className="grid gap-3 grid-cols-2 lg:grid-cols-4">
            <Tile to="/reception" icon={Users} label="Waiting" value={d.flow.waiting}
              hint={d.flow.waiting === 0 ? "nobody in the queue" : "in the queue"}
              loud={d.flow.waiting > 0} />
            <Tile to="/worklist" icon={Stethoscope} label="With a clinician" value={d.flow.in_consult} hint="being seen" />
            <Tile to="/appointments" icon={CalendarClock} label="Booked today" value={d.flow.booked_today}
              hint={`${d.flow.arrived} arrived`} />
            <Tile icon={Users} label="Seen today" value={d.flow.seen_today} hint="visits completed" />
          </div>
        </section>
      )}

      {/* THE MONEY. Only for staff who may see it. */}
      {d?.money && (
        <section className="space-y-2">
          <h2 className="text-xs font-bold uppercase tracking-wide text-muted-foreground">Money</h2>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            <Card>
              <CardContent className="p-4">
                <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Collected today</p>
                <p className="mt-1 text-3xl font-bold tabular-nums text-emerald-700">{etb(d.money.collected_today)}</p>
                <Delta today={num(d.money.collected_today)} before={num(d.money.collected_yesterday)} />
              </CardContent>
            </Card>
            <Link to="/finance?tab=receivables" className="rounded-lg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand">
              <Card className={cn("h-full transition-colors hover:border-brand/40", num(d.money.owed) > 0 && "border-destructive/40")}>
                <CardContent className="p-4">
                  <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Owed to you</p>
                  <p className={cn("mt-1 text-3xl font-bold tabular-nums", num(d.money.owed) > 0 ? "text-destructive" : "text-foreground")}>
                    {etb(d.money.owed)}
                  </p>
                  <p className="mt-1 text-xs text-muted-foreground">
                    {d.money.owed_patients} patient{d.money.owed_patients === 1 ? "" : "s"}
                    {d.money.oldest_days > 0 && ` · oldest ${d.money.oldest_days} days`}
                  </p>
                </CardContent>
              </Card>
            </Link>
            <Card className="max-lg:hidden">
              <CardContent className="p-4">
                <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Booked ahead</p>
                <p className="mt-1 text-3xl font-bold tabular-nums">{etb(d.money.booked_ahead)}</p>
                <p className="mt-1 text-xs text-muted-foreground">
                  {d.money.booked_visits} visit{d.money.booked_visits === 1 ? "" : "s"} scheduled — intent, not revenue
                </p>
              </CardContent>
            </Card>
          </div>
          {(d.series?.length ?? 0) > 1 && <Trend series={d.series!} />}
        </section>
      )}

      {q.isLoading && !d && (
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          {[0, 1, 2, 3].map((i) => <Skeleton key={i} className="h-24 w-full" />)}
        </div>
      )}

      {/* THE FEW THINGS PEOPLE OPEN THIS PAGE TO DO. */}
      <section className="space-y-2">
        <h2 className="text-xs font-bold uppercase tracking-wide text-muted-foreground">Quick actions</h2>
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          {/* The codes are the real ones from the permission catalogue — guessing at
              "patient.manage" or "report.view" silently hid the two actions this page
              exists for. */}
          {can("patient.create") && <Action to="/reception" icon={UserPlus} label="Register a patient" />}
          {(can("patient.read") || can("patient.search")) && <Action to="/patients" icon={Search} label="Find a patient" />}
          {can("payment.collect") && <Action to="/cashier" icon={HandCoins} label="Take a payment" />}
          {can("billing.manage") && <Action to="/finance" icon={Wallet} label="Finance" />}
        </div>
      </section>

      {d && (
        <p className="text-xs text-muted-foreground">
          {d.patients.toLocaleString()} patients registered.
          {q.isFetching && <span className="ml-1">Refreshing…</span>}
        </p>
      )}
    </div>
  );
}

/**
 * What needs doing, loudest first.
 *
 * An empty state that says "nothing needs you" is worth as much as the list: it is
 * the difference between a clinic that has checked and one that has not looked.
 */
function Attention({ items, loading }: { items: DashAlert[]; loading: boolean }) {
  if (loading) return <Skeleton className="h-24 w-full" />;
  const order = { danger: 0, warn: 1, info: 2 } as const;
  const sorted = [...items].sort((a, b) => (order[a.tone] ?? 3) - (order[b.tone] ?? 3));

  if (sorted.length === 0) {
    return (
      <Card className="border-emerald-200 bg-emerald-50/60">
        <CardContent className="flex items-center gap-3 p-4">
          <span className="flex h-9 w-9 items-center justify-center rounded-full bg-emerald-600/10 text-emerald-700">✓</span>
          <div>
            <p className="text-sm font-semibold text-emerald-900">Nothing needs you</p>
            <p className="text-xs text-emerald-800">No unbilled treatment, no overdue debt, no unclosed till.</p>
          </div>
        </CardContent>
      </Card>
    );
  }

  return (
    <section className="space-y-2">
      <h2 className="text-xs font-bold uppercase tracking-wide text-muted-foreground">Needs you</h2>
      <div className="space-y-2">
        {sorted.map((a, i) => (
          <Link key={`${a.kind}-${i}`} to={a.href}
            className="group flex items-center gap-3 rounded-lg border border-l-4 bg-card p-3 transition-colors hover:bg-accent/40 max-md:min-h-14"
            style={{ borderLeftColor: a.tone === "danger" ? "hsl(var(--destructive))" : a.tone === "warn" ? "#f59e0b" : "hsl(var(--border))" }}>
            <AlertTriangle className={cn("h-4 w-4 shrink-0",
              a.tone === "danger" ? "text-destructive" : a.tone === "warn" ? "text-amber-600" : "text-muted-foreground")} />
            <span className="min-w-0 flex-1 text-sm">{a.text}</span>
            {a.amount && num(a.amount) > 0 && (
              <span className="shrink-0 whitespace-nowrap text-sm font-semibold tabular-nums">{etb(a.amount)}</span>
            )}
            <ArrowRight className="h-4 w-4 shrink-0 text-muted-foreground transition-transform group-hover:translate-x-0.5" />
          </Link>
        ))}
      </div>
    </section>
  );
}

/** Today against yesterday, in words rather than a bare percentage. */
function Delta({ today, before }: { today: number; before: number }) {
  if (before <= 0 && today <= 0) return <p className="mt-1 text-xs text-muted-foreground">Nothing collected yet today.</p>;
  if (before <= 0) return <p className="mt-1 text-xs text-muted-foreground">Nothing was collected yesterday.</p>;
  const pct = Math.round(((today - before) / before) * 100);
  const up = pct >= 0;
  return (
    <p className={cn("mt-1 flex items-center gap-1 text-xs", up ? "text-emerald-700" : "text-muted-foreground")}>
      {up ? <ArrowUpRight className="h-3.5 w-3.5" /> : <ArrowDownRight className="h-3.5 w-3.5" />}
      {Math.abs(pct)}% vs yesterday ({etb(before)})
    </p>
  );
}

/**
 * A fortnight of collections. Bars, not a line: these are fourteen separate days,
 * and a line between them implies a quantity that flowed from one to the next.
 */
function Trend({ series }: { series: { date: string; amount: string }[] }) {
  const max = Math.max(1, ...series.map((p) => num(p.amount)));
  const total = series.reduce((a, p) => a + num(p.amount), 0);
  return (
    <Card>
      <CardContent className="p-4">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Collected, last 14 days</p>
          <p className="text-sm font-semibold tabular-nums">{etb(total)}</p>
        </div>
        <div className="mt-3 flex h-16 items-end gap-1">
          {series.map((p) => {
            const v = num(p.amount);
            return (
              <div key={p.date} className="group relative flex-1" title={`${p.date}: ${etb(v)}`}>
                <div
                  className={cn("w-full rounded-sm transition-colors", v > 0 ? "bg-brand/70 group-hover:bg-brand" : "bg-muted")}
                  style={{ height: `${Math.max(v > 0 ? 6 : 2, (v / max) * 64)}px` }}
                />
              </div>
            );
          })}
        </div>
        <div className="mt-1 flex justify-between text-[10px] text-muted-foreground">
          <span>{shortDay(series[0].date)}</span>
          <span>today</span>
        </div>
      </CardContent>
    </Card>
  );
}

function Tile({ to, icon: Icon, label, value, hint, loud }: {
  to?: string; icon: typeof Users; label: string; value: number; hint?: string; loud?: boolean;
}) {
  const body = (
    <Card className={cn("h-full transition-colors", to && "hover:border-brand/40", loud && "border-brand/50 bg-brand/5")}>
      <CardContent className="p-4">
        <p className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          <Icon className="h-3.5 w-3.5" /> {label}
        </p>
        <p className={cn("mt-1 text-3xl font-bold tabular-nums", loud ? "text-brand" : "text-foreground")}>{value}</p>
        {hint && <p className="mt-0.5 text-xs text-muted-foreground">{hint}</p>}
      </CardContent>
    </Card>
  );
  return to ? <Link to={to} className="rounded-lg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand">{body}</Link> : body;
}

function Action({ to, icon: Icon, label }: { to: string; icon: typeof Users; label: string }) {
  return (
    <Link to={to}
      className="flex min-h-14 items-center gap-3 rounded-lg border bg-card p-3 text-sm font-medium transition-colors hover:border-brand/40 hover:bg-accent/40">
      <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-brand/10 text-brand">
        <Icon className="h-4 w-4" />
      </span>
      <span className="min-w-0 truncate">{label}</span>
    </Link>
  );
}

function greeting() {
  const h = new Date().getHours();
  return h < 12 ? "Good morning" : h < 17 ? "Good afternoon" : "Good evening";
}
function today() {
  return new Date().toLocaleDateString(undefined, { weekday: "long", day: "numeric", month: "long" });
}
function shortDay(iso: string) {
  return new Date(`${iso}T00:00:00`).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}
