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
  financeBook, financeCash, financeOverview, financeReceivables, financeServices,
  type FinAlert, type FinBook, type FinCash, type FinDayPoint, type FinOverview,
  type FinLine, type FinReceivables, type FinServiceLine,
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
  { key: "cash", label: "Cash & shifts" },
  { key: "services", label: "Services" },
  { key: "book", label: "Treatment book", dental: true },
];

export function FinancePage() {
  const { can, flagOn } = useAuth();
  const [params, setParams] = useSearchParams();
  const tab = params.get("tab") ?? "overview";
  const period = params.get("period") ?? "7d";
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
  const cash = useQuery({
    queryKey: ["fin-cash", from, to, branch],
    queryFn: () => financeCash({ from, to, branch: branch || undefined }),
    enabled: tab === "cash" || tab === "overview",
  });
  const services = useQuery({
    queryKey: ["fin-services", from, to, branch],
    queryFn: () => financeServices({ from, to, branch: branch || undefined }),
    enabled: tab === "services",
  });
  const book = useQuery({
    queryKey: ["fin-book", branch],
    queryFn: () => financeBook({ branch: branch || undefined }),
    enabled: tab === "book",
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
        options={TABS.filter((t) => !t.dental || flagOn("dental")).map((t) => ({
          value: t.key,
          label: t.label,
          badge: t.key === "receivables" ? receivables.data?.count
            : t.key === "cash" ? (cash.data?.shifts.filter((sh) => num(sh.variance) !== 0).length || undefined)
              : undefined,
        }))}
      />

      {tab === "overview" && (
        <OverviewTab data={overview.data} owed={receivables.data} loading={overview.isLoading} dental={flagOn("dental")} />
      )}
      {tab === "receivables" && <ReceivablesTab data={receivables.data} loading={receivables.isLoading} params={params} onSet={set} />}
      {tab === "cash" && <CashTab data={cash.data} loading={cash.isLoading} />}
      {tab === "services" && <ServicesTab rows={services.data} loading={services.isLoading} />}
      {tab === "book" && <BookTab data={book.data} loading={book.isLoading} />}
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
  const label = (iso?: string) =>
    iso ? new Date(`${iso}T00:00:00`).toLocaleDateString(undefined, { month: "short", day: "numeric" }) : "";
  return (
    <div className="space-y-1.5">
      <div className="flex h-36 items-end gap-px sm:gap-0.5">
        {series.map((p, i) => {
          const v = num(p.amount);
          const before = num(prev[i]?.amount);
          return (
            // h-full matters: a percentage height resolves against the PARENT's
            // height, and this column had none — every bar computed to zero and the
            // chart rendered as an empty box with a dozen payments behind it.
            <div key={p.date} className="group relative flex h-full flex-1 flex-col justify-end"
              title={`${p.date} · ${etb(v)}${prev[i] ? ` (was ${etb(before)})` : ""}`}>
              <div className="absolute inset-x-0 bottom-0 rounded-sm bg-muted"
                style={{ height: `${(before / max) * 100}%` }} />
              {/* A day with nothing in it still gets a hairline, so ninety days of
                  quiet read as a timeline rather than as blank card. */}
              <div className={cn("relative rounded-sm transition-all", v > 0 ? "bg-emerald-500" : "bg-muted-foreground/15")}
                style={{ height: v > 0 ? `${Math.max(4, (v / max) * 100)}%` : "2px" }} />
            </div>
          );
        })}
      </div>
      <div className="flex items-center justify-between text-[10px] tabular-nums text-muted-foreground">
        <span>{label(series[0]?.date)}</span>
        <span className="font-medium">peak {etb(max)}</span>
        <span>{label(series[series.length - 1]?.date)}</span>
      </div>
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
  // The mix is GROSS: the sources are what was billed, before refunds are taken
  // off the top. Dividing a gross line by net collected printed "Dental 111%",
  // which is not a share of anything.
  const grossMix = Math.max(1, data.by_source.reduce((a, s) => a + num(s.amount), 0));

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
            {/* A window with no money in it renders as an empty frame otherwise —
                the largest thing on the page, saying nothing. */}
            {now === 0 && num(data.collected_prev) === 0
              ? (
                <div className="flex flex-col items-center gap-1 py-10 text-center">
                  <span className="flex h-10 w-10 items-center justify-center rounded-full bg-muted text-muted-foreground">
                    <Wallet className="h-5 w-5" />
                  </span>
                  <p className="mt-1 text-sm font-medium">Nothing collected in this period</p>
                  <p className="text-xs text-muted-foreground">Try a longer period, or check Receivables for what is owed.</p>
                </div>
              )
              : <TrendBars series={data.series} prev={data.series_prev} />}
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm">Where it came from</CardTitle>
            <p className="text-xs text-muted-foreground">
              Billed before refunds{num(data.refunded) > 0 ? ` — ${etb(data.refunded)} was refunded` : ""}.
            </p>
          </CardHeader>
          <CardContent className="space-y-2">
            {data.by_source.length === 0 && <p className="text-sm text-muted-foreground">No revenue in this period.</p>}
            {data.by_source.map((s) => (
              <div key={s.key} className="space-y-1">
                <div className="flex items-baseline justify-between gap-2 text-sm">
                  <span className="font-medium">{s.label}</span>
                  <span className="tabular-nums">
                    {etb(s.amount)}
                    <span className="ml-2 text-xs text-muted-foreground">
                      {Math.round((num(s.amount) / grossMix) * 100)}%
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

// --- Cash & shifts ----------------------------------------------------------

function Split({ title, rows, total }: { title: string; rows: FinLine[]; total: number }) {
  return (
    <Card>
      <CardHeader className="pb-2"><CardTitle className="text-sm">{title}</CardTitle></CardHeader>
      <CardContent className="space-y-2">
        {rows.length === 0 && <p className="text-sm text-muted-foreground">Nothing collected.</p>}
        {rows.map((r) => (
          <div key={r.key || r.label} className="space-y-1">
            <div className="flex items-baseline justify-between gap-2 text-sm">
              <span className="min-w-0 truncate font-medium capitalize">{r.label || "not recorded"}</span>
              <span className="shrink-0 tabular-nums">{etb(r.amount)}</span>
            </div>
            <div className="h-1.5 overflow-hidden rounded-full bg-muted">
              <div className="h-full rounded-full bg-brand" style={{ width: `${(num(r.amount) / Math.max(1, total)) * 100}%` }} />
            </div>
          </div>
        ))}
      </CardContent>
    </Card>
  );
}

function CashTab({ data, loading }: { data?: FinCash; loading: boolean }) {
  if (loading || !data) return <p className="p-8 text-center text-sm text-muted-foreground">Loading…</p>;
  const total = Math.max(1, ...data.by_method.map((m) => num(m.amount)));
  const off = data.shifts.filter((s) => num(s.variance) !== 0);

  return (
    <div className="space-y-4">
      {(off.length > 0 || data.open_drawers.length > 0) && (
        <div className="grid gap-2 sm:grid-cols-2">
          {off.length > 0 && (
            <div className="flex items-center gap-2.5 rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm">
              <AlertTriangle className="h-4 w-4 shrink-0 text-destructive" />
              <span className="flex-1 text-destructive">{off.length} cash count(s) did not balance</span>
              <span className="font-semibold tabular-nums text-destructive">{etb(data.variance)}</span>
            </div>
          )}
          {data.open_drawers.map((d) => (
            <div key={d.key} className="flex items-center gap-2.5 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm">
              <AlertTriangle className="h-4 w-4 shrink-0 text-amber-600" />
              <span className="flex-1 text-amber-900">{d.label} has not counted today's drawer</span>
              <span className="font-semibold tabular-nums text-amber-900">{etb(d.amount)}</span>
            </div>
          ))}
        </div>
      )}

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm">Day closeouts</CardTitle>
          <p className="text-xs text-muted-foreground">What the drawer should have held, against what was counted.</p>
        </CardHeader>
        <CardContent className="p-0">
          {data.shifts.length === 0 ? (
            <p className="py-10 text-center text-sm text-muted-foreground">No drawer has been counted in this period.</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="border-b bg-muted/40 text-left text-[10px] uppercase tracking-wide text-muted-foreground">
                  <tr>
                    <th className="px-4 py-2 font-semibold">Date</th>
                    <th className="px-4 py-2 font-semibold">Cashier</th>
                    <th className="px-4 py-2 text-right font-semibold">Expected</th>
                    <th className="px-4 py-2 text-right font-semibold">Counted</th>
                    <th className="px-4 py-2 text-right font-semibold">Variance</th>
                  </tr>
                </thead>
                <tbody className="divide-y">
                  {data.shifts.map((s, i) => {
                    const v = num(s.variance);
                    return (
                      <tr key={`${s.date}-${s.cashier}-${i}`} className={cn(v !== 0 && "bg-destructive/5")}>
                        <td className="px-4 py-2.5 tabular-nums">{s.date}</td>
                        <td className="px-4 py-2.5">
                          {s.cashier}
                          {s.note && <span className="block text-xs text-muted-foreground">{s.note}</span>}
                        </td>
                        <td className="px-4 py-2.5 text-right tabular-nums">{etb(s.expected)}</td>
                        <td className="px-4 py-2.5 text-right tabular-nums">{etb(s.counted)}</td>
                        <td className={cn("px-4 py-2.5 text-right font-semibold tabular-nums",
                          v === 0 ? "text-emerald-600" : "text-destructive")}>
                          {v > 0 ? "+" : ""}{etb(s.variance)}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>

      <div className="grid gap-4 lg:grid-cols-3">
        <Split title="By payment method" rows={data.by_method} total={total} />
        <Split title="By cashier" rows={data.by_cashier} total={total} />
        <Split title="By branch" rows={data.by_branch} total={total} />
      </div>
    </div>
  );
}

// --- Services ---------------------------------------------------------------

function ServicesTab({ rows, loading }: { rows?: FinServiceLine[]; loading: boolean }) {
  if (loading || !rows) return <p className="p-8 text-center text-sm text-muted-foreground">Loading…</p>;
  const top = Math.max(1, ...rows.map((r) => num(r.revenue)));
  const total = rows.reduce((a, r) => a + num(r.revenue), 0);

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-sm">What earned, in this period</CardTitle>
        <p className="text-xs text-muted-foreground">
          Dental work is grouped by its course, not by instalment — forty payments towards one root canal are one line.
        </p>
      </CardHeader>
      <CardContent className="p-0">
        {rows.length === 0 ? (
          <p className="py-10 text-center text-sm text-muted-foreground">Nothing was billed in this period.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="border-b bg-muted/40 text-left text-[10px] uppercase tracking-wide text-muted-foreground">
                <tr>
                  <th className="px-4 py-2 font-semibold">Service</th>
                  <th className="px-4 py-2 text-right font-semibold">Payments</th>
                  <th className="px-4 py-2 text-right font-semibold">Revenue</th>
                  <th className="px-4 py-2 text-right font-semibold">Average</th>
                  <th className="w-40 px-4 py-2 font-semibold">Share</th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {rows.map((r, i) => (
                  <tr key={`${r.label}-${i}`} className="hover:bg-muted/30">
                    <td className="px-4 py-2.5">
                      <span className="font-medium">{r.label}</span>
                      <span className="ml-2 rounded-full bg-muted px-1.5 py-0.5 text-[10px] uppercase text-muted-foreground">{r.source}</span>
                    </td>
                    <td className="px-4 py-2.5 text-right tabular-nums text-muted-foreground">{r.count}</td>
                    <td className="px-4 py-2.5 text-right font-semibold tabular-nums">{etb(r.revenue)}</td>
                    <td className="px-4 py-2.5 text-right tabular-nums text-muted-foreground">{etb(r.avg)}</td>
                    <td className="px-4 py-2.5">
                      <div className="flex items-center gap-2">
                        <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-muted">
                          <div className="h-full rounded-full bg-brand" style={{ width: `${(num(r.revenue) / top) * 100}%` }} />
                        </div>
                        <span className="w-9 shrink-0 text-right text-xs tabular-nums text-muted-foreground">
                          {Math.round((num(r.revenue) / Math.max(1, total)) * 100)}%
                        </span>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

// --- Treatment book (dental) ------------------------------------------------

function BookTab({ data, loading }: { data?: FinBook; loading: boolean }) {
  if (loading || !data) return <p className="p-8 text-center text-sm text-muted-foreground">Loading…</p>;
  const top = Math.max(1, ...data.by_month.map((m) => num(m.amount)));

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm">
            Booked ahead
            <span className="ml-2 font-normal tabular-nums text-muted-foreground">
              {etb(data.total)} over {data.visits} visit(s)
            </span>
          </CardTitle>
          <p className="text-xs text-muted-foreground">
            Treatment scheduled and not yet billed. This is intent, not revenue — a course can stop at any visit.
          </p>
        </CardHeader>
        <CardContent className="space-y-2">
          {data.by_month.length === 0 && <p className="text-sm text-muted-foreground">No visits are scheduled.</p>}
          {data.by_month.map((m) => (
            <div key={m.key} className="space-y-1">
              <div className="flex items-baseline justify-between gap-2 text-sm">
                <span className="font-medium">{m.label}</span>
                <span className="tabular-nums">
                  {etb(m.amount)}
                  <span className="ml-2 text-xs text-muted-foreground">{m.count} visit(s)</span>
                </span>
              </div>
              <div className="h-2 overflow-hidden rounded-full bg-muted">
                <div className="h-full rounded-full bg-brand" style={{ width: `${(num(m.amount) / top) * 100}%` }} />
              </div>
            </div>
          ))}
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm">Courses at risk</CardTitle>
          <p className="text-xs text-muted-foreground">
            A visit has come and gone without being recorded. This is money already planned for that will not arrive on its own.
          </p>
        </CardHeader>
        <CardContent className="p-0">
          {data.at_risk.length === 0 ? (
            <div className="flex flex-col items-center gap-2 py-10 text-center">
              <span className="flex h-11 w-11 items-center justify-center rounded-full bg-emerald-100 text-emerald-700">
                <Wallet className="h-5 w-5" />
              </span>
              <p className="text-sm font-medium">Every course is on schedule</p>
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="border-b bg-muted/40 text-left text-[10px] uppercase tracking-wide text-muted-foreground">
                  <tr>
                    <th className="px-4 py-2 font-semibold">Patient</th>
                    <th className="px-4 py-2 font-semibold">Course</th>
                    <th className="px-4 py-2 font-semibold">Why</th>
                    <th className="px-4 py-2 text-right font-semibold">At risk</th>
                    <th className="px-4 py-2" />
                  </tr>
                </thead>
                <tbody className="divide-y">
                  {data.at_risk.map((r) => (
                    <tr key={`${r.id}-${r.plan}`} className="hover:bg-muted/30">
                      <td className="px-4 py-2.5">
                        <Link to={`/patients/${r.id}`} className="font-medium text-brand hover:underline">{r.patient}</Link>
                        <span className="block text-xs text-muted-foreground">{r.mrn}</span>
                      </td>
                      <td className="px-4 py-2.5">{r.plan}</td>
                      <td className="px-4 py-2.5 text-muted-foreground">
                        {r.reason}
                        {r.days_idle > 0 && <span className="ml-1 text-xs">· {r.days_idle} days late</span>}
                      </td>
                      <td className="px-4 py-2.5 text-right font-semibold tabular-nums">{etb(r.at_risk)}</td>
                      <td className="px-4 py-2.5 text-right">
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
