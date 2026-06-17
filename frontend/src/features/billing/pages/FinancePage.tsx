import { useState } from "react";
import { useQuery } from "@tanstack/react-query";

import { Card } from "@/components/ui/card";
import { cashSummary } from "@/features/billing/api";

function startOf(range: "today" | "7d" | "30d") {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  if (range === "7d") d.setDate(d.getDate() - 6);
  if (range === "30d") d.setDate(d.getDate() - 29);
  return d.toISOString();
}

const RANGES = [
  { key: "today", label: "Today" },
  { key: "7d", label: "Last 7 days" },
  { key: "30d", label: "Last 30 days" },
] as const;

function Kpi({ label, value, sub, tone }: { label: string; value: string; sub: string; tone?: string }) {
  return (
    <Card className="p-4">
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className={`text-2xl font-semibold ${tone ?? "text-brand"}`}>{value}</p>
      <p className="text-xs text-muted-foreground">{sub}</p>
    </Card>
  );
}

export function FinancePage() {
  const [range, setRange] = useState<(typeof RANGES)[number]["key"]>("today");
  const q = useQuery({ queryKey: ["cash", range], queryFn: () => cashSummary(startOf(range)), refetchInterval: 30000 });
  const c = q.data;
  const cur = "ETB";

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1>Finance</h1>
          <p className="text-sm text-muted-foreground">Cash collected, waived, and outstanding.</p>
        </div>
        <div className="flex gap-1 rounded-md border p-0.5">
          {RANGES.map((r) => (
            <button
              key={r.key}
              onClick={() => setRange(r.key)}
              className={`rounded px-3 py-1.5 text-sm font-medium ${range === r.key ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:text-foreground"}`}
            >
              {r.label}
            </button>
          ))}
        </div>
      </div>

      <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
        <Kpi label="Collected" value={`${cur} ${c?.collected ?? "—"}`} sub={`${c?.collected_count ?? 0} payment(s)`} tone="text-emerald-600" />
        <Kpi label="Waived (forgone)" value={`${cur} ${c?.waived ?? "—"}`} sub={`${c?.waived_count ?? 0} waiver(s)`} tone="text-amber-600" />
        <Kpi label="Outstanding" value={`${cur} ${c?.outstanding ?? "—"}`} sub={`${c?.outstanding_count ?? 0} unpaid now`} tone="text-rose-600" />
      </div>

      <Card className="overflow-hidden">
        <div className="border-b px-4 py-2.5 text-sm font-medium">Collected by service</div>
        <table className="w-full text-sm">
          <thead className="border-b bg-muted/40 text-left text-xs uppercase tracking-wide text-muted-foreground">
            <tr><th className="p-3 font-medium">Source</th><th className="font-medium">Payments</th><th className="p-3 text-right font-medium">Total</th></tr>
          </thead>
          <tbody>
            {(c?.by_source ?? []).map((l) => (
              <tr key={l.source} className="border-b last:border-0">
                <td className="p-3 capitalize">{l.source}</td>
                <td>{l.count}</td>
                <td className="p-3 text-right font-mono">{cur} {l.total}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {(c?.by_source?.length ?? 0) === 0 && <p className="p-8 text-center text-sm text-muted-foreground">No collections in this period.</p>}
      </Card>
    </div>
  );
}
