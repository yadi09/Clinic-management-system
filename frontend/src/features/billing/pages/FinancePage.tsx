// Finance — the owner's view of the money.
//
// The old page was a single screen of four totals for one hard-coded window. It
// answered "what did we take today" and nothing else: no comparison, so a good day
// and a bad day looked identical; no ageing, so 96,000 ETB of debt was one number
// with no indication that a third of it was four months old; and nothing on it was
// actionable, so noticing a problem and doing something about it were separate
// jobs on separate screens.
//
// An owner asks five questions. Each is a tab, they share one period and branch
// filter, and that filter lives in the URL so a period survives a refresh and can
// be sent to somebody else.
import { useEffect, useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { useSearchParams, Link } from "react-router-dom";
import { AlertTriangle, ArrowDownRight, ArrowUpRight, Phone, Wallet } from "lucide-react";

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Segmented } from "@/components/ui/segmented";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { cn } from "@/lib/utils";
import { useAuth } from "@/app/auth-context";
import { listBranches } from "@/features/admin/api";
import {
  financeOverview, financeReceivables,
  type FinAlert, type FinDayPoint, type FinOverview, type FinReceivables,
} from "@/features/billing/api";

const num = (s?: string) => Number(s || 0);
const etb = (s?: string | number) =>
  `${Number(s || 0).toLocaleString(undefined, { maximumFractionDigits: 0 })} ETB`;

const isoDay = (d: Date) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

/** The windows an owner actually reaches for, resolved to real dates on click. */
const PERIODS = [
  { key: "today", label: "Today", days: 0 },
  { key: "7d", label: "7 days", days: 6 },
  { key: "30d", label: "30 days", days: 29 },
  { key: "90d", label: "90 days", days: 89 },
];

function rangeFor(key: string) {
  const to = new Date();
  const from = new Date();
  const p = PERIODS.find((x) => x.key === key) ?? PERIODS[0];
  from.setDate(from.getDate() - p.days);
  return { from: isoDay(from), to: isoDay(to) };
}

const TABS = [
  { key: "overview", label: "Overview" },
  { key: "receivables", label: "Receivables" },
];

export function FinancePage() {
  const { can, flagOn } = useAuth();
  const [params, setParams] = useSearchParams();
  const tab = params.get("tab") ?? "overview";
  const period = params.get("period") ?? "today";
  const branch = params.get("branch") ?? "";
  const { from, to } = useMemo(() => rangeFor(period), [period]);

  const branches = useQuery({ queryKey: ["branches"], queryFn: listBranches });

  const set = (patch: Record<string, string>) => {
    const next = new URLSearchParams(params);
    for (const [k, v] of Object.entries(patch)) {
      if (v) next.set(k, v); else next.delete(k);
    }
    setParams(next, { replace: true });
  };

  const overview = useQuery({
    queryKey: ["fin-overview", from, to, branch],
    queryFn: () => financeOverview({ from, to, branch: branch || undefined }),
    enabled: tab === "overview",
  });
  const receivables = useQuery({
    queryKey: ["fin-receivables", branch],
    queryFn: () => financeReceivables({ branch: branch || undefined }),
    // Loaded on both tabs: Overview's headline "owed" and the Receivables table
    // must be the same number, and the only way to guarantee that is one source.
    enabled: true,
  });

  // A tab in the URL that does not exist would render nothing at all.
  useEffect(() => {
    if (!TABS.some((t) => t.key === tab)) set({ tab: "overview" });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab]);

  if (!can("billing.manage")) {
    return <p className="p-6 text-sm text-muted-foreground">You do not have access to the finance figures.</p>;
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Finance</h1>
          <p className="text-sm text-muted-foreground">
            Money taken, money owed, and where it came from. Revenue — not profit: this system does not hold your costs.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Segmented
            size="sm"
            ariaLabel="Period"
            value={period}
            onChange={(v) => set({ period: v })}
            options={PERIODS.map((p) => ({ value: p.key, label: p.label }))}
          />
          {(branches.data?.length ?? 0) > 1 && (
            <Select value={branch || "all"} onValueChange={(v) => set({ branch: v === "all" ? "" : v })}>
              <SelectTrigger className="h-8 w-44"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All branches</SelectItem>
                {(branches.data ?? []).map((b) => <SelectItem key={b.id} value={b.id}>{b.name}</SelectItem>)}
              </SelectContent>
            </Select>
          )}
        </div>
      </div>

      <Segmented
        ariaLabel="Finance view"
        value={tab}
        onChange={(v) => set({ tab: v })}
        options={TABS.map((t) => ({
          value: t.key,
          label: t.label,
          badge: t.key === "receivables" ? receivables.data?.count : undefined,
        }))}
      />

      {tab === "overview" && (
        <OverviewTab data={overview.data} owed={receivables.data} loading={overview.isLoading} dental={flagOn("dental")} />
      )}
      {tab === "receivables" && <ReceivablesTab data={receivables.data} loading={receivables.isLoading} params={params} onSet={set} />}
    </div>
  );
}

// --- Overview ---------------------------------------------------------------

function Kpi({ label, value, tone, foot }: { label: string; value: string; tone?: string; foot?: React.ReactNode }) {
  return (
    <div className="rounded-lg border bg-card p-4 shadow-sm">
      <div className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">{label}</div>
      <div className={cn("mt-1 text-2xl font-bold tabular-nums", tone)}>{value}</div>
      {foot && <div className="mt-1 text-xs text-muted-foreground">{foot}</div>}
    </div>
  );
}

/** Bars, drawn in CSS. A trend has to be seen; a column of numbers is not one. */
function TrendBars({ series, prev }: { series: FinDayPoint[]; prev: FinDayPoint[] }) {
  const max = Math.max(1, ...series.map((p) => num(p.amount)), ...prev.map((p) => num(p.amount)));
  return (
    <div className="flex h-32 items-end gap-1">
      {series.map((p, i) => {
        const v = num(p.amount);
        const before = num(prev[i]?.amount);
        return (
          <div key={p.date} className="group relative flex flex-1 flex-col justify-end gap-0.5"
            title={`${p.date} · ${etb(v)}${prev[i] ? ` (was ${etb(before)})` : ""}`}>
            {/* The previous window sits behind as a faint ghost, so "is this normal"
                is answered by looking rather than by remembering last week. */}
            <div className="absolute inset-x-0 bottom-0 rounded-sm bg-muted"
              style={{ height: `${(before / max) * 100}%` }} />
            <div className={cn("relative rounded-sm transition-all", v > 0 ? "bg-emerald-500" : "bg-muted")}
              style={{ height: `${Math.max(v > 0 ? 3 : 0, (v / max) * 100)}%` }} />
          </div>
        );
      })}
    </div>
  );
}

function AttentionRow({ a }: { a: FinAlert }) {
  return (
    <Link to={a.href}
      className="flex items-center gap-2.5 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm transition-colors hover:bg-amber-100">
      <AlertTriangle className="h-4 w-4 shrink-0 text-amber-600" />
      <span className="min-w-0 flex-1 text-amber-900">{a.text}</span>
      {a.amount && num(a.amount) > 0 && <span className="shrink-0 font-semibold tabular-nums text-amber-900">{etb(a.amount)}</span>}
    </Link>
  );
}

function OverviewTab({ data, owed, loading, dental }: {
  data?: FinOverview; owed?: FinReceivables; loading: boolean; dental: boolean;
}) {
  if (loading || !data) return <p className="p-8 text-center text-sm text-muted-foreground">Loading…</p>;
  const now = num(data.collected);
  const before = num(data.collected_prev);
  const delta = before > 0 ? Math.round(((now - before) / before) * 100) : null;
  const leak = num(data.refunded) + num(data.waived);
  const maxSource = Math.max(1, ...data.by_source.map((s) => num(s.amount)));

  return (
    <div className="space-y-4">
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Kpi label="Collected (net)" value={etb(data.collected)} tone="text-emerald-600"
          foot={
            <span className="flex flex-wrap items-center gap-1.5">
              {delta !== null && (
                <span className={cn("inline-flex items-center gap-0.5 font-semibold",
                  delta >= 0 ? "text-emerald-600" : "text-destructive")}>
                  {delta >= 0 ? <ArrowUpRight className="h-3 w-3" /> : <ArrowDownRight className="h-3 w-3" />}
                  {Math.abs(delta)}%
                </span>
              )}
              <span>{data.collected_count} payment(s) · vs {etb(data.collected_prev)} before</span>
            </span>
          } />
        <Kpi label="Owed to you" value={etb(owed?.total ?? data.outstanding)}
          tone={num(owed?.total ?? data.outstanding) > 0 ? "text-destructive" : ""}
          foot={owed ? `${owed.count} patient(s) · oldest ${data.oldest_days} days` : `${data.outstanding_patients} patient(s)`} />
        <Kpi label="Leakage" value={etb(leak)} tone={leak > 0 ? "text-amber-600" : ""}
          foot={`refunded ${etb(data.refunded)} · waived ${etb(data.waived)}`} />
        {dental
          ? <Kpi label="Booked ahead" value={etb(data.booked_ahead)}
              foot={`${data.booked_visits} visit(s) scheduled — intent, not revenue`} />
          : <Kpi label="Payments" value={String(data.collected_count)}
              foot="settled in this period" />}
      </div>

      {data.attention.length > 0 && (
        <div className="grid gap-2 sm:grid-cols-2">
          {data.attention.map((a) => <AttentionRow key={a.kind} a={a} />)}
        </div>
      )}

      <div className="grid gap-4 lg:grid-cols-[1.4fr_1fr]">
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm">Collected per day</CardTitle>
            <p className="text-xs text-muted-foreground">Green is this period; grey behind it is the same length before.</p>
          </CardHeader>
          <CardContent>
            {data.series.length === 0
              ? <p className="py-8 text-center text-sm text-muted-foreground">Nothing collected in this period.</p>
              : <TrendBars series={data.series} prev={data.series_prev} />}
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2"><CardTitle className="text-sm">Where it came from</CardTitle></CardHeader>
          <CardContent className="space-y-2">
            {data.by_source.length === 0 && <p className="text-sm text-muted-foreground">No revenue in this period.</p>}
            {data.by_source.map((s) => (
              <div key={s.key} className="space-y-1">
                <div className="flex items-baseline justify-between gap-2 text-sm">
                  <span className="font-medium">{s.label}</span>
                  <span className="tabular-nums">
                    {etb(s.amount)}
                    <span className="ml-2 text-xs text-muted-foreground">
                      {Math.round((num(s.amount) / Math.max(1, now)) * 100)}%
                    </span>
                  </span>
                </div>
                <div className="h-1.5 overflow-hidden rounded-full bg-muted">
                  <div className="h-full rounded-full bg-brand"
                    style={{ width: `${(num(s.amount) / maxSource) * 100}%` }} />
                </div>
              </div>
            ))}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}

// --- Receivables ------------------------------------------------------------

function ReceivablesTab({ data, loading, params, onSet }: {
  data?: FinReceivables; loading: boolean;
  params: URLSearchParams; onSet: (p: Record<string, string>) => void;
}) {
  const bucket = params.get("bucket") ?? "";
  if (loading || !data) return <p className="p-8 text-center text-sm text-muted-foreground">Loading…</p>;
  const rows = bucket ? data.rows.filter((r) => r.bucket === bucket) : data.rows;
  const total = Math.max(1, num(data.total));

  return (
    <div className="space-y-4">
      {/* Ageing first. The size of a debt matters less than its age: money owed for
          four months is money that usually never arrives. */}
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        {data.buckets.map((b) => {
          const on = bucket === b.key;
          const pct = Math.round((num(b.amount) / total) * 100);
          const old = b.key === "61-90" || b.key === "90+";
          return (
            <button key={b.key} type="button"
              onClick={() => onSet({ bucket: on ? "" : b.key })}
              className={cn("rounded-lg border bg-card p-4 text-left shadow-sm transition-colors",
                on ? "border-brand ring-1 ring-brand" : "hover:bg-accent/40")}>
              <div className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">{b.label}</div>
              <div className={cn("mt-1 text-xl font-bold tabular-nums", old && num(b.amount) > 0 && "text-destructive")}>
                {etb(b.amount)}
              </div>
              <div className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-muted">
                <div className={cn("h-full rounded-full", old ? "bg-destructive" : "bg-amber-500")}
                  style={{ width: `${pct}%` }} />
              </div>
              <div className="mt-1 text-xs text-muted-foreground">{b.count} patient(s) · {pct}%</div>
            </button>
          );
        })}
      </div>

      <Card>
        <CardHeader className="flex-row items-center justify-between gap-2 pb-2">
          <CardTitle className="text-sm">
            {bucket ? `Owing ${data.buckets.find((b) => b.key === bucket)?.label.toLowerCase()}` : "Everyone who owes"}
            <span className="ml-2 font-normal text-muted-foreground">{rows.length} patient(s)</span>
          </CardTitle>
          {bucket && (
            <button type="button" onClick={() => onSet({ bucket: "" })}
              className="text-xs font-medium text-brand hover:underline">Show all</button>
          )}
        </CardHeader>
        <CardContent className="p-0">
          {rows.length === 0 ? (
            <div className="flex flex-col items-center gap-2 py-12 text-center">
              <span className="flex h-11 w-11 items-center justify-center rounded-full bg-emerald-100 text-emerald-700">
                <Wallet className="h-5 w-5" />
              </span>
              <p className="text-sm font-medium">Nobody owes anything here</p>
              <p className="text-xs text-muted-foreground">Every charge raised has been settled.</p>
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="border-b bg-muted/40 text-left text-[10px] uppercase tracking-wide text-muted-foreground">
                  <tr>
                    <th className="px-4 py-2 font-semibold">Patient</th>
                    <th className="px-4 py-2 font-semibold">Owed</th>
                    <th className="px-4 py-2 font-semibold">Oldest</th>
                    <th className="px-4 py-2 font-semibold">Last paid</th>
                    <th className="px-4 py-2 font-semibold">Why</th>
                    <th className="px-4 py-2" />
                  </tr>
                </thead>
                <tbody className="divide-y">
                  {rows.map((r) => (
                    <tr key={r.id} className="hover:bg-muted/30">
                      <td className="px-4 py-2.5">
                        <Link to={`/patients/${r.id}`} className="font-medium text-brand hover:underline">{r.name}</Link>
                        <span className="block text-xs text-muted-foreground">{r.mrn}</span>
                      </td>
                      <td className="px-4 py-2.5 tabular-nums font-semibold">{etb(r.owed)}</td>
                      <td className="px-4 py-2.5">
                        <span className={cn("tabular-nums font-medium",
                          r.oldest_days > 60 ? "text-destructive" : r.oldest_days > 30 ? "text-amber-700" : "text-muted-foreground")}>
                          {r.oldest_days} days
                        </span>
                      </td>
                      <td className="px-4 py-2.5 text-muted-foreground">{r.last_paid || "never"}</td>
                      <td className="px-4 py-2.5 text-xs text-muted-foreground">{r.why}</td>
                      <td className="px-4 py-2.5 text-right">
                        {/* The phone number IS the action: this list exists to be
                            worked through, not admired. */}
                        {r.phone
                          ? <a href={`tel:${r.phone}`} className="inline-flex items-center gap-1 text-xs font-medium text-brand hover:underline">
                              <Phone className="h-3 w-3" /> {r.phone}
                            </a>
                          : <span className="text-xs text-muted-foreground">no phone</span>}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
