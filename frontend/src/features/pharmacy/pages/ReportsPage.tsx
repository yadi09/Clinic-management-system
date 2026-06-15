import { useState } from "react";
import { useQuery } from "@tanstack/react-query";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { pharmacyReport } from "@/features/pharmacy/api";

const REPORTS = [
  { kind: "consumption", title: "Consumption", sub: "Top dispensed / sold drugs" },
  { kind: "margins", title: "Margins", sub: "Sell vs avg cost" },
  { kind: "wastage", title: "Wastage / expiry", sub: "Value at risk" },
  { kind: "controlled", title: "Controlled drugs", sub: "Register & audit" },
  { kind: "valuation", title: "Stock valuation", sub: "Value on hand" },
  { kind: "supplier", title: "Supplier performance", sub: "POs & lead time" },
];

export function ReportsPage() {
  const [active, setActive] = useState<{ kind: string; title: string } | null>(null);
  return (
    <div className="space-y-6">
      <div>
        <h1>Pharmacy reports</h1>
        <p className="text-sm text-muted-foreground">View now · CSV export coming later</p>
      </div>
      <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
        {REPORTS.map((r) => (
          <Card key={r.kind}>
            <CardHeader>
              <CardTitle>{r.title}</CardTitle>
              <CardDescription>{r.sub}</CardDescription>
            </CardHeader>
            <CardContent className="flex gap-2">
              <Button variant="outline" onClick={() => setActive({ kind: r.kind, title: r.title })}>View</Button>
              <Button variant="outline" disabled title="Coming later">Export</Button>
            </CardContent>
          </Card>
        ))}
      </div>
      {active && <ReportDialog kind={active.kind} title={active.title} onClose={() => setActive(null)} />}
    </div>
  );
}

function ReportDialog({ kind, title, onClose }: { kind: string; title: string; onClose: () => void }) {
  const q = useQuery({ queryKey: ["report", kind], queryFn: () => pharmacyReport(kind) });
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-3xl">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
        </DialogHeader>
        {q.isLoading ? (
          <p className="text-sm text-muted-foreground">Loading…</p>
        ) : (q.data?.rows.length ?? 0) === 0 ? (
          <p className="text-sm text-muted-foreground">No data yet.</p>
        ) : (
          <div className="max-h-[60vh] overflow-auto">
            <table className="w-full text-sm">
              <thead className="border-b text-left text-xs uppercase tracking-wide text-muted-foreground">
                <tr>{(q.data?.columns ?? []).map((c) => <th key={c} className="p-2 font-medium">{c}</th>)}</tr>
              </thead>
              <tbody>
                {(q.data?.rows ?? []).map((row, i) => (
                  <tr key={i} className="border-b">
                    {row.map((cell, j) => <td key={j} className="p-2">{cell}</td>)}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
