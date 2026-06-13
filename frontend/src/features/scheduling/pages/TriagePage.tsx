import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Activity, UserCheck } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card } from "@/components/ui/card";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Textarea } from "@/components/ui/textarea";
import { toast } from "@/components/ui/sonner";
import { listBranches, listDepartments, listUsers } from "@/features/admin/api";
import { recordVitals, type VitalsBody } from "@/features/clinical/api";
import { assignProvider, listQueue, type QueueEntry } from "@/features/scheduling/api";

function waitMins(iso: string) {
  return Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 60000));
}

export function TriagePage() {
  const qc = useQueryClient();
  const branches = useQuery({ queryKey: ["branches"], queryFn: listBranches });
  const departments = useQuery({ queryKey: ["departments"], queryFn: listDepartments });
  const [dept, setDept] = useState("");
  useEffect(() => {
    if (!dept && departments.data?.length) setDept(departments.data[0].id);
  }, [departments.data, dept]);

  const branchId = branches.data?.[0]?.id;
  const queue = useQuery({
    queryKey: ["triage", dept],
    queryFn: () => listQueue(dept, "triage"),
    enabled: !!dept,
    refetchInterval: 30000,
  });

  const [vitalsFor, setVitalsFor] = useState<QueueEntry | null>(null);

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1>Triage</h1>
          <p className="text-sm text-muted-foreground">Record vitals and assign a doctor.</p>
        </div>
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
      </div>

      <div className="space-y-3">
        {(queue.data ?? []).map((e) => (
          <Card key={e.id} className="flex flex-wrap items-center justify-between gap-3 p-4">
            <div className="min-w-0">
              <p className="font-medium text-brand">{e.patient_name}</p>
              <p className="font-mono text-xs text-muted-foreground">
                {e.mrn} · waiting {waitMins(e.enqueued_at)}m
              </p>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <Button variant="outline" size="sm" onClick={() => setVitalsFor(e)}>
                <Activity /> Vitals
              </Button>
              <AssignControl queueId={e.id} onAssigned={() => qc.invalidateQueries({ queryKey: ["triage", dept] })} />
            </div>
          </Card>
        ))}
        {dept && (queue.data?.length ?? 0) === 0 && (
          <Card className="p-12 text-center text-sm text-muted-foreground">No patients waiting for triage.</Card>
        )}
        {!dept && <Card className="p-12 text-center text-sm text-muted-foreground">Select a department.</Card>}
      </div>

      {vitalsFor && branchId && (
        <VitalsDialog
          entry={vitalsFor}
          branchId={branchId}
          departmentId={dept}
          onOpenChange={(o) => !o && setVitalsFor(null)}
          onSaved={() => {
            setVitalsFor(null);
            qc.invalidateQueries({ queryKey: ["triage", dept] });
          }}
        />
      )}
    </div>
  );
}

function AssignControl({ queueId, onAssigned }: { queueId: string; onAssigned: () => void }) {
  const providers = useQuery({ queryKey: ["users"], queryFn: listUsers });
  const [provider, setProvider] = useState("");
  const mut = useMutation({
    mutationFn: () => assignProvider(queueId, provider),
    onSuccess: () => {
      toast.success("Assigned to doctor");
      onAssigned();
    },
    onError: () => toast.error("Could not assign"),
  });
  return (
    <div className="flex items-center gap-2">
      <div className="w-44">
        <Select value={provider} onValueChange={setProvider}>
          <SelectTrigger>
            <SelectValue placeholder="Assign doctor…" />
          </SelectTrigger>
          <SelectContent>
            {(providers.data ?? []).filter((u) => u.status === "active").map((u) => (
              <SelectItem key={u.id} value={u.id}>
                {u.full_name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      <Button size="sm" disabled={!provider} loading={mut.isPending} onClick={() => mut.mutate()}>
        <UserCheck /> Assign
      </Button>
    </div>
  );
}

const NUM_FIELDS = [
  { key: "systolic", label: "Systolic", unit: "mmHg" },
  { key: "diastolic", label: "Diastolic", unit: "mmHg" },
  { key: "pulse", label: "Pulse", unit: "bpm" },
  { key: "resp_rate", label: "Resp", unit: "/min" },
  { key: "spo2", label: "SpO₂", unit: "%" },
  { key: "temp_c", label: "Temp", unit: "°C" },
  { key: "weight_kg", label: "Weight", unit: "kg" },
  { key: "height_cm", label: "Height", unit: "cm" },
] as const;

function VitalsDialog({
  entry,
  branchId,
  departmentId,
  onOpenChange,
  onSaved,
}: {
  entry: QueueEntry;
  branchId: string;
  departmentId: string;
  onOpenChange: (o: boolean) => void;
  onSaved: () => void;
}) {
  const [vals, setVals] = useState<Record<string, string>>({});
  const [notes, setNotes] = useState("");

  const mut = useMutation({
    mutationFn: () => {
      const body: VitalsBody = { branch_id: branchId, department_id: departmentId, notes };
      for (const f of NUM_FIELDS) {
        const v = vals[f.key];
        if (v !== undefined && v !== "") (body as unknown as Record<string, number | string>)[f.key] = Number(v);
      }
      return recordVitals(entry.id, entry.patient_id, body);
    },
    onSuccess: () => {
      toast.success("Vitals recorded");
      onSaved();
    },
    onError: () => toast.error("Could not record vitals"),
  });

  return (
    <Dialog open onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Vitals · {entry.patient_name}</DialogTitle>
        </DialogHeader>
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          {NUM_FIELDS.map((f) => (
            <div key={f.key} className="space-y-1.5">
              <Label className="text-xs">
                {f.label} <span className="text-muted-foreground">{f.unit}</span>
              </Label>
              <Input
                type="number"
                inputMode="decimal"
                value={vals[f.key] ?? ""}
                onChange={(e) => setVals((s) => ({ ...s, [f.key]: e.target.value }))}
              />
            </div>
          ))}
        </div>
        <div className="space-y-1.5">
          <Label>Notes</Label>
          <Textarea value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Triage notes" />
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button loading={mut.isPending} onClick={() => mut.mutate()}>
            Save vitals
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
