import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Download } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { toast } from "@/components/ui/sonner";
import { pharmacyReport, type Report } from "@/features/pharmacy/api";

const REPORTS = [
  { kind: "consumption", title: "Consumption", sub: "Top dispensed / sold drugs" },
  { kind: "margins", title: "Margins", sub: "Sell vs avg cost" },
  { kind: "wastage", title: "Wastage / expiry", sub: "Value at risk" },
  { kind: "controlled", title: "Controlled drugs", sub: "Register & audit" },
  { kind: "valuation", title: "Stock valuation", sub: "Value on hand" },
  { kind: "supplier", title: "Supplier performance", sub: "POs & lead time" },
];

function csvCell(v: string) {
  return /[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
}
function toCsv(r: Report) {
  return [r.columns, ...r.rows].map((row) => row.map(csvCell).join(",")).join("\r\n");
}
function download(filename: string, text: string) {
  const url = URL.createObjectURL(new Blob([text], { type: "text/csv;charset=utf-8" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

export function ReportsPage() {
  const [active, setActive] = useState<{ kind: string; title: string } | null>(null);
  const [exporting, setExporting] = useState<string | null>(null);

  const exportCsv = async (kind: string) => {
    setExporting(kind);
    try {
      const r = await pharmacyReport(kind);
      if (!r.rows.length) {
        toast.message("Nothing to export — no data yet.");
        return;
      }
      download(`pharmacy-${kind}.csv`, toCsv(r));
    } catch {
      toast.error("Could not export the report");
    } finally {
      setExporting(null);
    }
  };

  return (
    <div className="space-y-6">
      <div>
        <h1>Pharmacy reports</h1>
        <p className="text-sm text-muted-foreground">View on screen or export to CSV.</p>
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
              <Button variant="outline" loading={exporting === r.kind} onClick={() => exportCsv(r.kind)}>
                <Download className="h-4 w-4" /> Export
              </Button>
            </CardContent>
          </Card>
        ))}
      </div>
      {active && <ReportDialog kind={active.kind} title={active.title} onExport={() => exportCsv(active.kind)} onClose={() => setActive(null)} />}
    </div>
  );
}

function ReportDialog({ kind, title, onExport, onClose }: { kind: string; title: string; onExport: () => void; onClose: () => void }) {
  const q = useQuery({ queryKey: ["report", kind], queryFn: () => pharmacyReport(kind) });
  const hasData = (q.data?.rows.length ?? 0) > 0;
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-3xl">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
        </DialogHeader>
        {q.isLoading ? (
          <p className="text-sm text-muted-foreground">Loading…</p>
        ) : !hasData ? (
          <p className="text-sm text-muted-foreground">No data yet.</p>
        ) : (
          <>
            <div className="flex justify-end">
              <Button size="sm" variant="outline" onClick={onExport}>
                <Download className="h-3.5 w-3.5" /> Export CSV
              </Button>
            </div>
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
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
