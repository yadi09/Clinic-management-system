import { useQuery } from "@tanstack/react-query";
import { useNavigate } from "react-router-dom";
import { AlertTriangle } from "lucide-react";

import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { bedReport } from "@/features/inpatient/api";

const birr = (s: string) => `ETB ${Number(s || 0).toLocaleString(undefined, { minimumFractionDigits: 2 })}`;
const day = (iso?: string) => (iso ? new Date(iso).toLocaleDateString(undefined, { day: "numeric", month: "short" }) : "—");

export function BedReportsPage() {
  const navigate = useNavigate();
  const q = useQuery({ queryKey: ["bed-report"], queryFn: bedReport });

  if (q.isLoading) return <div className="space-y-4"><Skeleton className="h-24 w-full" /><Skeleton className="h-40 w-full" /></div>;
  if (q.isError || !q.data) return <div className="p-8 text-sm text-destructive">Could not load the report.</div>;
  const r = q.data;
  const occ = r.total_beds ? Math.round((r.occupied / r.total_beds) * 100) : 0;

  return (
    <div className="space-y-6">
      <div><h1>Bed reports</h1><p className="text-sm text-muted-foreground">Occupancy and revenue for this branch.</p></div>

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Tile label="Occupancy" value={`${occ}%`} hint={`${r.occupied}/${r.total_beds} beds`} />
        <Tile label="Available" value={String(r.available)} hint="ready now" />
        <Tile label="Avg length of stay" value={`${r.avg_los_days} d`} hint="discharged patients" />
        <Tile label="Bed revenue" value={birr(r.bed_revenue)} hint="collected" />
      </div>

      <Card className="p-4">
        <h2 className="mb-3 text-h3">By ward</h2>
        {r.by_ward.length === 0 ? (
          <p className="text-sm text-muted-foreground">No wards.</p>
        ) : (
          <Table>
            <TableHeader><TableRow><TableHead>Ward</TableHead><TableHead className="text-center">Occupied</TableHead><TableHead className="text-center">Total</TableHead><TableHead className="text-right">Occupancy</TableHead></TableRow></TableHeader>
            <TableBody>
              {r.by_ward.map((w) => (
                <TableRow key={w.ward}>
                  <TableCell className="font-medium">{w.ward}</TableCell>
                  <TableCell className="text-center tabular-nums">{w.occupied}</TableCell>
                  <TableCell className="text-center tabular-nums">{w.total}</TableCell>
                  <TableCell className="text-right tabular-nums">{w.total ? Math.round((w.occupied / w.total) * 100) : 0}%</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </Card>

      <Card className="p-4">
        <h2 className="mb-3 flex items-center gap-2 text-h3">Overdue payments {r.overdue.length > 0 && <Badge variant="destructive">{r.overdue.length}</Badge>}</h2>
        {r.overdue.length === 0 ? (
          <p className="text-sm text-muted-foreground">No overdue bed payments.</p>
        ) : (
          <Table>
            <TableHeader><TableRow><TableHead>Patient</TableHead><TableHead>Bed</TableHead><TableHead>Since</TableHead><TableHead>Due</TableHead><TableHead className="text-right">Est. owed</TableHead></TableRow></TableHeader>
            <TableBody>
              {r.overdue.map((a, i) => (
                <TableRow key={i} className="cursor-pointer" onClick={() => a.mrn && navigate(`/patients?q=${encodeURIComponent(a.mrn)}`)}>
                  <TableCell className="font-medium text-brand">{a.patient_name} <span className="font-mono text-xs text-muted-foreground">{a.mrn}</span></TableCell>
                  <TableCell>{a.ward_name} · {a.bed_label}</TableCell>
                  <TableCell className="tabular-nums">{day(a.admitted_at)}</TableCell>
                  <TableCell className="tabular-nums text-destructive"><span className="inline-flex items-center gap-1"><AlertTriangle className="h-3 w-3" /> {day(a.payment_due_at)}</span></TableCell>
                  <TableCell className="text-right tabular-nums font-semibold">{birr(a.est_cost)}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </Card>
    </div>
  );
}

function Tile({ label, value, hint }: { label: string; value: string; hint: string }) {
  return (
    <Card className="p-4">
      <p className="text-sm text-muted-foreground">{label}</p>
      <p className="mt-1 text-2xl font-bold tabular-nums text-brand">{value}</p>
      <p className="mt-1 text-xs text-muted-foreground">{hint}</p>
    </Card>
  );
}
