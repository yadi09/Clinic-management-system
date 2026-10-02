// The clinic, right now.
//
// The order is the order the questions get asked. What needs me? Who is in the
// building? How is the money going? Who owes me, and what is coming? "Needs you" comes
// first because a dashboard's job is not to reassure: a clinic with 22,000 ETB of
// unbilled treatment should see that before it sees today's takings.
//
// Everything on the page opens what it shows — a patient opens the patient, a bar
// opens that day in Finance — unless the person cannot open it (see links.ts). The
// money comes from the same finance service the Finance page reads, so the two
// cannot disagree; the earlier version's "owed" was half of Finance's, and said so
// to the owner every morning.
//
// Sections the server leaves out are not drawn: a receptionist gets the day without
// the takings, a cashier the takings without the queue.
import { Suspense, lazy, useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { HandCoins, Search, UserPlus, Wallet } from "lucide-react";

import { useAuth } from "@/app/auth-context";
import { LoadError } from "@/components/LoadError";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { formatEthiopian } from "@/lib/ethiopian";
import { dashKeys, dashboardToday } from "@/features/dashboard/api";
import { useDashLinks } from "@/features/dashboard/links";
import { NeedsYou } from "@/features/dashboard/components/NeedsYou";
import { TodayFlow } from "@/features/dashboard/components/TodayFlow";
import { MoneyTiles } from "@/features/dashboard/components/MoneyTiles";
import { OwedCard, WeekAhead } from "@/features/dashboard/components/OwedAndWeek";

// The chart library is the heaviest thing on the page and the last thing anyone
// needs; it arrives after the numbers rather than in front of them.
const TakingsChart = lazy(() => import("@/features/dashboard/components/TakingsChart"));

export function DashboardPage() {
  const { user, can } = useAuth();
  const links = useDashLinks();
  const q = useQuery({
    queryKey: dashKeys.today,
    queryFn: dashboardToday,
    // A clinic changes while you are looking at it: someone pays, someone arrives.
    refetchInterval: 30_000,
  });
  const d = q.data;
  const first = (user?.full_name || "").trim().split(/\s+/)[0] || "there";
  const hour = d?.hour ?? new Date().getHours();

  return (
    <div className="space-y-6">
      <header className="flex flex-wrap items-end justify-between gap-x-5 gap-y-3">
        <div className="min-w-0">
          <h1 className="text-h1 leading-tight">{greeting(hour)}, {first}</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            {d ? <DateLine date={d.date} /> : " "}
            {d?.clinic_name && <> · {d.clinic_name}</>}
            {d && <>, {d.branch_name || "all branches"}</>}
          </p>
        </div>
        <div className="flex flex-col items-start gap-2 sm:items-end">
          <div className="flex flex-wrap gap-2">
            {/* The codes are the real ones from the permission catalogue — guessing at
                "patient.manage" or "report.view" silently hid the two actions this page
                exists for. */}
            {can("patient.create") && <QuickAction to="/reception" icon={UserPlus} label="Register a patient" primary />}
            {!can("patient.create") && (can("patient.read") || can("patient.search")) &&
              <QuickAction to="/patients" icon={Search} label="Find a patient" primary />}
            {can("payment.collect") && <QuickAction to="/cashier" icon={HandCoins} label="Take a payment" />}
            {can("billing.manage") && links.finance() && <QuickAction to={links.finance()!} icon={Wallet} label="Finance" />}
          </div>
          <Freshness at={q.dataUpdatedAt} fetching={q.isFetching} failed={q.isError && !!d} />
        </div>
      </header>

      {q.isError && !d ? (
        <LoadError what="the dashboard" onRetry={() => void q.refetch()} />
      ) : !d ? (
        <Loading />
      ) : (
        <>
          <NeedsYou items={d.attention} links={links} canSeeMoney={!!d.money} />
          {d.flow && <TodayFlow f={d.flow} date={d.date} links={links} />}
          {d.money && <MoneyTiles m={d.money} links={links} />}
          {d.money && (
            <Suspense fallback={<div className="grid grid-cols-1 gap-3.5 xl:grid-cols-[1.75fr_1fr]"><Skeleton className="h-[330px]" /><Skeleton className="h-[330px]" /></div>}>
              <TakingsChart links={links} today={d.date} />
            </Suspense>
          )}
          {((d.money?.aging.length ?? 0) > 0 || (d.week?.length ?? 0) > 0) && (
            <div className="grid grid-cols-1 gap-3.5 lg:grid-cols-2">
              {d.money && d.money.aging.length > 0 && <OwedCard aging={d.money.aging} owers={d.money.top_owers} links={links} />}
              {d.week && d.week.length > 0 && <WeekAhead week={d.week} links={links} showMoney={!!d.money} />}
            </div>
          )}
          <p className="text-xs text-muted-foreground">
            {d.patients.toLocaleString()} patients registered
            {d.branch_name ? ` · numbers for ${d.branch_name}; switch branch at the top` : ""}
          </p>
        </>
      )}
    </div>
  );
}

function DateLine({ date }: { date: string }) {
  const g = new Date(`${date}T00:00:00`).toLocaleDateString(undefined, { weekday: "long", day: "numeric", month: "long", year: "numeric" });
  return <><b className="font-semibold text-foreground">{g}</b> · {formatEthiopian(date, { dayFirst: true })}</>;
}

/** "Live · updated 12 s ago". Ticks on its own so the page does not re-render. */
function Freshness({ at, fetching, failed }: { at: number; fetching: boolean; failed: boolean }) {
  const [, tick] = useState(0);
  useEffect(() => { const t = setInterval(() => tick((n) => n + 1), 10_000); return () => clearInterval(t); }, []);
  if (!at) return null;
  if (failed) return <span className="text-xs font-medium text-destructive">Couldn't refresh · showing the last numbers</span>;
  const s = Math.max(0, Math.round((Date.now() - at) / 1000));
  return (
    <span className="inline-flex items-center gap-1.5 text-xs text-muted-foreground">
      <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-primary" />
      {fetching ? "Updating…" : s < 10 ? "Live · just updated" : `Live · updated ${s < 60 ? `${s} s` : `${Math.round(s / 60)} min`} ago`}
    </span>
  );
}

function QuickAction({ to, icon: Icon, label, primary }: { to: string; icon: typeof Wallet; label: string; primary?: boolean }) {
  return (
    <Button asChild size="sm" variant={primary ? "default" : "outline"} className="touch-hit">
      <Link to={to}><Icon className="h-4 w-4" />{label}</Link>
    </Button>
  );
}

function Loading() {
  return (
    <div className="space-y-6" aria-busy="true" aria-label="Loading the dashboard">
      <Skeleton className="h-20 w-full" />
      <div className="grid grid-cols-1 gap-3.5 xl:grid-cols-[1.75fr_1fr]"><Skeleton className="h-56" /><Skeleton className="h-56" /></div>
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">{[0, 1, 2, 3].map((i) => <Skeleton key={i} className="h-32" />)}</div>
    </div>
  );
}

function greeting(h: number) {
  return h < 12 ? "Good morning" : h < 17 ? "Good afternoon" : "Good evening";
}
