import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { UserPlus, Radio } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { toast } from "@/components/ui/sonner";
import { useAuth } from "@/app/auth-context";
import { listBranches, listDepartments } from "@/features/admin/api";
import { listQueue, queueStreamUrl, transitionQueue, walkIn, type QueueEntry } from "@/features/scheduling/api";
import { PatientCombobox } from "@/features/scheduling/components/BookingDialog";

const COLUMNS: { key: string; label: string; next?: string; nextLabel?: string }[] = [
  { key: "waiting", label: "Waiting", next: "called", nextLabel: "Call" },
  { key: "called", label: "Called", next: "in_consult", nextLabel: "Start" },
  { key: "in_consult", label: "In consult", next: "done", nextLabel: "Complete" },
  { key: "done", label: "Done" },
];

function waitMins(iso: string) {
  return Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 60000));
}

export function QueuePage() {
  const qc = useQueryClient();
  const { can } = useAuth();
  const manage = can("queue.manage");

  const departments = useQuery({ queryKey: ["departments"], queryFn: listDepartments });
  const [dept, setDept] = useState("");
  useEffect(() => {
    if (!dept && departments.data?.length) setDept(departments.data[0].id);
  }, [departments.data, dept]);

  const queue = useQuery({
    queryKey: ["queue", dept],
    queryFn: () => listQueue(dept),
    enabled: !!dept,
    refetchInterval: 60000, // safety net; SSE drives most updates
  });

  // Live updates via SSE (Postgres LISTEN/NOTIFY).
  useEffect(() => {
    if (!dept) return;
    const es = new EventSource(queueStreamUrl(dept));
    es.addEventListener("queue", () => qc.invalidateQueries({ queryKey: ["queue", dept] }));
    return () => es.close();
  }, [dept, qc]);

  const transition = useMutation({
    mutationFn: ({ id, state }: { id: string; state: string }) => transitionQueue(id, state),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["queue", dept] }),
  });

  const grouped = useMemo(() => {
    const m: Record<string, QueueEntry[]> = { waiting: [], called: [], in_consult: [], done: [] };
    for (const e of queue.data ?? []) {
      if (e.state === "no_show") m.done.push(e);
      else (m[e.state] ??= []).push(e);
    }
    return m;
  }, [queue.data]);

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="flex items-center gap-2">
            Queue <Radio className="h-4 w-4 text-primary" aria-label="live" />
          </h1>
          <p className="text-sm text-muted-foreground">Live department board</p>
        </div>
        <div className="flex items-center gap-2">
          <div className="w-56">
            <Select value={dept} onValueChange={setDept}>
              <SelectTrigger>
                <SelectValue placeholder="Select department" />
              </SelectTrigger>
              <SelectContent>
                {(departments.data ?? []).map((d) => (
                  <SelectItem key={d.id} value={d.id}>
                    {d.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          {manage && dept && <WalkInDialog departmentId={dept} onAdded={() => qc.invalidateQueries({ queryKey: ["queue", dept] })} />}
        </div>
      </div>

      {!dept ? (
        <Card className="p-12 text-center text-sm text-muted-foreground">
          Create a department in Settings to use the queue.
        </Card>
      ) : (
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-4">
          {COLUMNS.map((col) => (
            <div key={col.key} className="space-y-3">
              <div className="flex items-center justify-between">
                <h2 className="text-h3">{col.label}</h2>
                <Badge variant="outline">{grouped[col.key]?.length ?? 0}</Badge>
              </div>
              <div className="space-y-2">
                {(grouped[col.key] ?? []).map((e) => (
                  <Card key={e.id} className="p-3">
                    <div className="flex items-start justify-between gap-2">
                      <div className="min-w-0">
                        <p className="font-medium text-brand">{e.patient_name}</p>
                        <p className="font-mono text-xs text-muted-foreground">{e.mrn}</p>
                      </div>
                      {e.state !== "done" && e.state !== "no_show" && (
                        <span className="shrink-0 text-xs text-muted-foreground">{waitMins(e.enqueued_at)}m</span>
                      )}
                    </div>
                    {manage && col.next && (
                      <div className="mt-3 flex gap-2">
                        <Button size="sm" className="h-8 flex-1" onClick={() => transition.mutate({ id: e.id, state: col.next! })}>
                          {col.nextLabel}
                        </Button>
                        <Button size="sm" variant="outline" className="h-8" onClick={() => transition.mutate({ id: e.id, state: "no_show" })}>
                          No-show
                        </Button>
                      </div>
                    )}
                  </Card>
                ))}
                {!(grouped[col.key] ?? []).length && (
                  <p className="rounded-md border border-dashed p-4 text-center text-xs text-muted-foreground">Empty</p>
                )}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function WalkInDialog({ departmentId, onAdded }: { departmentId: string; onAdded: () => void }) {
  const [open, setOpen] = useState(false);
  const [patient, setPatient] = useState<{ id: string; name: string } | null>(null);
  const branches = useQuery({ queryKey: ["branches"], queryFn: listBranches, enabled: open });

  const mut = useMutation({
    mutationFn: () => walkIn({ branch_id: branches.data![0].id, department_id: departmentId, patient_id: patient!.id }),
    onSuccess: (r) => {
      toast.success(r.gated ? "Billed — sent to cashier. Patient joins the queue once payment is collected." : "Added to queue");
      setPatient(null);
      onAdded();
      setOpen(false);
    },
    onError: () => toast.error("Could not add walk-in"),
  });

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <Button onClick={() => setOpen(true)}>
        <UserPlus /> Walk-in
      </Button>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Add walk-in to queue</DialogTitle>
        </DialogHeader>
        <div className="space-y-1.5">
          <Label>Patient</Label>
          <PatientCombobox value={patient} onSelect={setPatient} />
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => setOpen(false)}>
            Cancel
          </Button>
          <Button disabled={!patient || !branches.data?.length} loading={mut.isPending} onClick={() => mut.mutate()}>
            Add to queue
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
