import { useQuery } from "@tanstack/react-query";
import { useNavigate } from "react-router-dom";

import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { dispenseQueue } from "@/features/pharmacy/api";

function Kpi({ label, value }: { label: string; value: number | string }) {
  return (
    <Card className="p-4">
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className="text-2xl font-semibold text-brand">{value}</p>
    </Card>
  );
}

export function DispenseQueuePage() {
  const navigate = useNavigate();
  const q = useQuery({ queryKey: ["dispense-queue"], queryFn: dispenseQueue, refetchInterval: 30000 });
  const k = q.data?.kpis;

  return (
    <div className="space-y-6">
      <div>
        <h1>Dispense queue</h1>
        <p className="text-sm text-muted-foreground">Signed prescriptions</p>
      </div>

      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <Kpi label="To dispense" value={k?.to_dispense ?? "—"} />
        <Kpi label="Dispensed today" value={k?.dispensed_today ?? "—"} />
        <Kpi label="Low stock" value={k?.low_stock ?? "—"} />
        <Kpi label="Near expiry" value={k?.near_expiry ?? "—"} />
      </div>

      <Card className="overflow-hidden">
        <table className="w-full text-sm">
          <thead className="border-b bg-muted/40 text-left text-xs uppercase tracking-wide text-muted-foreground">
            <tr>
              <th className="p-3 font-medium">Rx</th>
              <th className="font-medium">Patient</th>
              <th className="font-medium">Prescriber</th>
              <th className="font-medium">Items</th>
              <th className="font-medium">Flags</th>
              <th className="p-3 font-medium">Status</th>
            </tr>
          </thead>
          <tbody>
            {(q.data?.items ?? []).map((it) => (
              <tr
                key={it.id}
                className={`border-b ${it.dispensed ? "" : "cursor-pointer hover:bg-muted/30"}`}
                onClick={() => !it.dispensed && navigate(`/pharmacy/dispense/${it.id}`)}
              >
                <td className="p-3 font-mono text-xs">R-{it.rx_no}</td>
                <td>
                  {it.patient_name} <span className="font-mono text-xs text-muted-foreground">{it.mrn}</span>
                </td>
                <td>{it.prescriber || "—"}</td>
                <td>{it.item_count}</td>
                <td>
                  {it.flags.map((f) => (
                    <Badge key={f} variant="outline" className="mr-1 border-amber-300 text-amber-700">
                      {f}
                    </Badge>
                  ))}
                </td>
                <td className="p-3">
                  <Badge variant={it.dispensed ? "success" : "outline"}>{it.dispensed ? "dispensed" : "ready"}</Badge>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {(q.data?.items?.length ?? 0) === 0 && (
          <div className="p-10 text-center">
            <p className="text-sm font-medium">Nothing to dispense right now</p>
            <p className="mt-1 text-sm text-muted-foreground">
              When a doctor signs a prescription, it appears here ready for you to dispense. Open a row to pick the
              batch, counsel the patient, and hand it out.
            </p>
          </div>
        )}
      </Card>
    </div>
  );
}
