import { useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { FlaskConical, ScanLine } from "lucide-react";

import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { toast } from "@/components/ui/sonner";
import { AppError } from "@/lib/api-client";
import { findSample, worklist, type WorklistItem } from "@/features/lab/api";

function waitMins(iso: string) {
  return Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 60000));
}

const TABS = [
  { key: "pending", label: "To collect", match: (s: string) => s === "ordered" },
  { key: "entry", label: "Result entry", match: (s: string) => s === "collected" || s === "in_process" },
  { key: "validate", label: "Awaiting validation", match: (s: string) => s === "resulted" },
  { key: "done", label: "Validated", match: (s: string) => s === "validated" },
] as const;

const PRIORITY: Record<string, string> = {
  stat: "border-rose-300 bg-rose-50 text-rose-700",
  urgent: "border-amber-300 bg-amber-50 text-amber-700",
  routine: "border-slate-200 text-muted-foreground",
};

export function LabWorklistPage() {
  const navigate = useNavigate();
  const [tab, setTab] = useState<(typeof TABS)[number]["key"]>("pending");
  const q = useQuery({ queryKey: ["lab-worklist"], queryFn: () => worklist(), refetchInterval: 20000 });

  const buckets = useMemo(() => {
    const all = q.data ?? [];
    const out: Record<string, WorklistItem[]> = {};
    for (const t of TABS) out[t.key] = all.filter((i) => t.match(i.status));
    return out;
  }, [q.data]);

  const rows = buckets[tab] ?? [];

  const [scan, setScan] = useState("");
  const [finding, setFinding] = useState(false);
  const lookup = async () => {
    const n = parseInt(scan.replace(/[^0-9]/g, ""), 10); // tolerate an "S-" prefix from a scanner
    if (!n) {
      toast.error("Enter a sample number");
      return;
    }
    setFinding(true);
    try {
      const ref = await findSample(n);
      navigate(`/lab/items/${ref.id}`);
    } catch (e) {
      toast.error(e instanceof AppError ? e.message : "Sample not found");
    } finally {
      setFinding(false);
    }
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1>Laboratory worklist</h1>
          <p className="text-sm text-muted-foreground">Collect samples, enter results, release to the ordering doctor.</p>
        </div>
        <div className="flex items-end gap-2">
          <div className="relative">
            <ScanLine className="pointer-events-none absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
            <Input
              className="w-44 pl-8"
              placeholder="Scan / sample #"
              value={scan}
              onChange={(e) => setScan(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") lookup(); }}
            />
          </div>
          <Button variant="outline" loading={finding} onClick={lookup}>Find</Button>
        </div>
      </div>

      <div className="flex flex-wrap gap-1 border-b">
        {TABS.map((t) => (
          <button
            key={t.key}
            onClick={() => setTab(t.key)}
            className={`-mb-px border-b-2 px-4 py-2 text-sm font-medium ${
              tab === t.key ? "border-primary text-primary" : "border-transparent text-muted-foreground hover:text-foreground"
            }`}
          >
            {t.label}
            <span className="ml-2 rounded-full bg-muted px-2 py-0.5 text-xs">{buckets[t.key]?.length ?? 0}</span>
          </button>
        ))}
      </div>

      <Card className="overflow-hidden">
        <table className="w-full text-sm">
          <thead className="border-b bg-muted/40 text-left text-xs uppercase tracking-wide text-muted-foreground">
            <tr>
              <th className="p-3 font-medium">Sample</th>
              <th className="font-medium">Test</th>
              <th className="font-medium">Patient</th>
              <th className="font-medium">Priority</th>
              <th className="font-medium">Ordered</th>
              <th className="p-3 font-medium">Status</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((it) => (
              <tr key={it.id} className="cursor-pointer border-b hover:bg-muted/30" onClick={() => navigate(`/lab/items/${it.id}`)}>
                <td className="p-3 font-mono text-xs">S-{it.sample_no}</td>
                <td>{it.test_name}</td>
                <td>
                  {it.patient_name} <span className="font-mono text-xs text-muted-foreground">{it.mrn}</span>
                </td>
                <td>
                  <Badge variant="outline" className={PRIORITY[it.priority] ?? PRIORITY.routine}>
                    {it.priority}
                  </Badge>
                </td>
                <td className="text-xs text-muted-foreground">{waitMins(it.ordered_at)}m ago</td>
                <td className="p-3">
                  <Badge variant="outline">{it.status.replace("_", " ")}</Badge>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {rows.length === 0 && (
          <div className="p-10 text-center">
            <FlaskConical className="mx-auto h-5 w-5 text-muted-foreground" />
            <p className="mt-2 text-sm font-medium">No samples in this list</p>
            <p className="mt-1 text-sm text-muted-foreground">
              When a doctor orders a lab, it arrives under <span className="font-medium">To collect</span> — accession the
              sample, enter results, then submit for validation.
            </p>
          </div>
        )}
      </Card>
    </div>
  );
}
