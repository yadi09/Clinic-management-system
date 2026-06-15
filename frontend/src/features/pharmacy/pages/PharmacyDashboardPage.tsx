import { useQuery } from "@tanstack/react-query";

import { Card } from "@/components/ui/card";
import { pharmacyDashboard } from "@/features/pharmacy/api";

function Kpi({ label, value }: { label: string; value: number | string }) {
  return (
    <Card className="p-4">
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className="text-2xl font-semibold text-brand">{value}</p>
    </Card>
  );
}

export function PharmacyDashboardPage() {
  const q = useQuery({ queryKey: ["pharmacy-dashboard"], queryFn: pharmacyDashboard, refetchInterval: 60000 });
  const d = q.data;
  const max = Math.max(1, ...(d?.volume ?? []).map((v) => v.count));

  return (
    <div className="space-y-6">
      <div>
        <h1>Pharmacy dashboard</h1>
        <p className="text-sm text-muted-foreground">Today</p>
      </div>

      <div className="grid grid-cols-2 gap-3 md:grid-cols-5">
        <Kpi label="Dispensed today" value={d?.dispensed_today ?? "—"} />
        <Kpi label="Value on hand" value={d ? `${d.value_on_hand} ETB` : "—"} />
        <Kpi label="Low stock" value={d?.low_stock ?? "—"} />
        <Kpi label="Near expiry" value={d?.near_expiry ?? "—"} />
        <Kpi label="Open POs" value={d?.open_pos ?? "—"} />
      </div>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
        <Card className="p-4 lg:col-span-2">
          <h2 className="mb-4 text-h3">Dispensing volume (14 days)</h2>
          <div className="flex h-48 items-end gap-1.5">
            {(d?.volume ?? []).length === 0 ? (
              <p className="text-sm text-muted-foreground">No dispensing in the last 14 days.</p>
            ) : (
              (d?.volume ?? []).map((v) => (
                <div key={v.day} className="flex flex-1 flex-col items-center gap-1" title={`${v.day}: ${v.count}`}>
                  <div className="w-full rounded-t bg-primary/70" style={{ height: `${(v.count / max) * 100}%` }} />
                  <span className="text-[10px] text-muted-foreground">{v.day.slice(5)}</span>
                </div>
              ))
            )}
          </div>
        </Card>
        <Card className="p-4">
          <h2 className="mb-3 text-h3">Alerts</h2>
          {(d?.alerts ?? []).length === 0 ? (
            <p className="text-sm text-muted-foreground">All clear.</p>
          ) : (
            <ul className="space-y-2 text-sm">
              {(d?.alerts ?? []).map((a) => (
                <li key={a} className="flex items-start gap-2">
                  <span className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-amber-500" />
                  {a}
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>
    </div>
  );
}
