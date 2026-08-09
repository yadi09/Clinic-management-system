import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Activity, AlertCircle, Baby, CheckCircle2, Clock, UserCheck } from "lucide-react";
import { Badge } from "@/components/ui/badge";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card } from "@/components/ui/card";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Textarea } from "@/components/ui/textarea";
import { toast } from "@/components/ui/sonner";
import { listBranches, listDepartments, listProviders } from "@/features/admin/api";
import { useAuth } from "@/app/auth-context";
import { getVisit, getVitalFields, recordVitals, vitalFlag, type VitalsBody, type VitalField } from "@/features/clinical/api";
import { assignProvider, listQueue, type QueueEntry } from "@/features/scheduling/api";
import { PregnancyDatingDialog } from "@/features/maternity/PregnancyCalculator";
import { DateRangeFilter, windowFor, type DateWindow } from "@/components/ui/date-range-filter";
import { DictateButton } from "@/features/clinical/components/DictateButton";

function waitMins(iso: string) {
  return Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 60000));
}

export function TriagePage() {
  const qc = useQueryClient();
  const { activeBranchId, flagOn } = useAuth();
  const branches = useQuery({ queryKey: ["branches"], queryFn: listBranches });
  const departments = useQuery({ queryKey: ["departments"], queryFn: listDepartments });
  const [dept, setDept] = useState("");
  // Default (and re-default on branch switch) to a department in the active branch.
  useEffect(() => {
    const list = (departments.data ?? []).filter((d) => !activeBranchId || d.branch_id === activeBranchId);
    if (list.length && !list.some((d) => d.id === dept)) setDept(list[0].id);
  }, [departments.data, activeBranchId, dept]);

  const [win, setWin] = useState<DateWindow>(() => windowFor("today"));

  const branchId = activeBranchId ?? branches.data?.[0]?.id;
  const queue = useQuery({
    queryKey: ["triage", dept, win.from, win.to],
    queryFn: () => listQueue(dept, "triage", win),
    enabled: !!dept,
    refetchInterval: 30000,
  });

  // Patients we've already sent to a doctor (stage moves to 'with_doctor' on
  // assignment). Kept visible here so triage keeps the trail after handoff.
  const assignedQ = useQuery({
    queryKey: ["triage-assigned", dept, win.from, win.to],
    queryFn: () => listQueue(dept, "with_doctor", win),
    enabled: !!dept,
    refetchInterval: 30000,
  });

  const [vitalsFor, setVitalsFor] = useState<QueueEntry | null>(null);
  const [datingFor, setDatingFor] = useState<string | null>(null);
  const [tab, setTab] = useState<"awaiting" | "ready" | "assigned">("awaiting");

  const entries = queue.data ?? [];
  const awaiting = entries.filter((e) => !e.has_vitals);
  const ready = entries.filter((e) => e.has_vitals);
  const assigned = assignedQ.data ?? [];
  const shown = tab === "awaiting" ? awaiting : ready;
  const refresh = () => {
    qc.invalidateQueries({ queryKey: ["triage", dept] });
    qc.invalidateQueries({ queryKey: ["triage-assigned", dept] });
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1>Triage</h1>
          <p className="text-sm text-muted-foreground">Take vitals first, then send the patient to a doctor — assignment is blocked until vitals are recorded.</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <DateRangeFilter onChange={setWin} />
          <div className="w-56">
            <Select value={dept} onValueChange={setDept}>
              <SelectTrigger><SelectValue placeholder="Select department" /></SelectTrigger>
              <SelectContent>
                {(departments.data ?? []).filter((d) => !activeBranchId || d.branch_id === activeBranchId).map((d) => (
                  <SelectItem key={d.id} value={d.id}>{d.name}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>
      </div>

      <div className="inline-flex rounded-lg border p-0.5">
        <TabBtn active={tab === "awaiting"} onClick={() => setTab("awaiting")} label="Awaiting vitals" count={awaiting.length} />
        <TabBtn active={tab === "ready"} onClick={() => setTab("ready")} label="Ready for doctor" count={ready.length} />
        <TabBtn active={tab === "assigned"} onClick={() => setTab("assigned")} label="Sent to doctor" count={assigned.length} />
      </div>

      {tab === "assigned" ? (
        <div className="space-y-3">
          {!dept && <Card className="p-12 text-center text-sm text-muted-foreground">Select a department.</Card>}
          {dept && assigned.length === 0 && (
            <Card className="p-12 text-center text-sm text-muted-foreground">No patients sent to a doctor in this range.</Card>
          )}
          {assigned.map((e) => (
            <AssignedCard key={e.id} entry={e} />
          ))}
        </div>
      ) : (
      <div className="space-y-3">
        {!dept && <Card className="p-12 text-center text-sm text-muted-foreground">Select a department.</Card>}
        {dept && shown.length === 0 && (
          <Card className="p-12 text-center text-sm text-muted-foreground">
            {tab === "awaiting" ? "No patients waiting for vitals." : "No patients ready for a doctor yet — record vitals first."}
          </Card>
        )}
        {shown.map((e) => (
          <Card key={e.id} className="flex flex-wrap items-center justify-between gap-3 p-4">
            <div className="min-w-0 space-y-1">
              <p className="font-medium text-brand">{e.patient_name}</p>
              <div className="flex flex-wrap items-center gap-2 text-xs">
                <span className="font-mono text-muted-foreground">{e.mrn}</span>
                <span className="inline-flex items-center gap-1 text-muted-foreground"><Clock className="h-3 w-3" /> {waitMins(e.enqueued_at)}m</span>
                {e.has_vitals ? (
                  <Badge variant="success" className="gap-1"><CheckCircle2 className="h-3 w-3" /> Vitals recorded</Badge>
                ) : (
                  <Badge variant="warning" className="gap-1"><AlertCircle className="h-3 w-3" /> Vitals pending</Badge>
                )}
              </div>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <Button variant={e.has_vitals ? "ghost" : "default"} size="sm" onClick={() => setVitalsFor(e)}>
                <Activity className="h-4 w-4" /> {e.has_vitals ? "Edit vitals" : "Record vitals"}
              </Button>
              {flagOn("maternity") && (
                <Button variant="outline" size="sm" onClick={() => setDatingFor(e.patient_id)}>
                  <Baby className="h-4 w-4" /> Dating
                </Button>
              )}
              {e.has_vitals && <AssignControl queueId={e.id} onAssigned={refresh} />}
            </div>
          </Card>
        ))}
      </div>
      )}

      {vitalsFor && branchId && (
        <VitalsDialog
          entry={vitalsFor}
          branchId={branchId}
          departmentId={dept}
          onOpenChange={(o) => !o && setVitalsFor(null)}
          onSaved={() => { setVitalsFor(null); setTab("ready"); refresh(); }}
        />
      )}
      {datingFor && (
        <PregnancyDatingDialog patientId={datingFor} open onOpenChange={(o) => !o && setDatingFor(null)} onSaved={refresh} />
      )}
    </div>
  );
}

const STATE_BADGE: Record<string, { label: string; variant: "default" | "brand" | "success" | "warning" | "destructive" }> = {
  waiting: { label: "Waiting for doctor", variant: "warning" },
  called: { label: "Called", variant: "brand" },
  in_consult: { label: "In consultation", variant: "brand" },
  done: { label: "Seen", variant: "success" },
  no_show: { label: "No-show", variant: "destructive" },
};

// Read-only card for a patient already handed off to a doctor — triage keeps the trail.
function AssignedCard({ entry }: { entry: QueueEntry }) {
  const st = STATE_BADGE[entry.state] ?? { label: entry.state, variant: "default" as const };
  return (
    <Card className="flex flex-wrap items-center justify-between gap-3 p-4">
      <div className="min-w-0 space-y-1">
        <p className="font-medium text-brand">{entry.patient_name}</p>
        <div className="flex flex-wrap items-center gap-2 text-xs">
          <span className="font-mono text-muted-foreground">{entry.mrn}</span>
          <span className="inline-flex items-center gap-1 text-muted-foreground"><Clock className="h-3 w-3" /> {waitMins(entry.enqueued_at)}m</span>
          {entry.provider_name && (
            <span className="inline-flex items-center gap-1 text-muted-foreground"><UserCheck className="h-3 w-3" /> {entry.provider_name}</span>
          )}
        </div>
      </div>
      <Badge variant={st.variant}>{st.label}</Badge>
    </Card>
  );
}

function TabBtn({ active, onClick, label, count }: { active: boolean; onClick: () => void; label: string; count: number }) {
  return (
    <button onClick={onClick} className={`rounded-md px-4 py-1.5 text-sm font-medium ${active ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:text-foreground"}`}>
      {label} {count > 0 && <span className={`ml-1 rounded-full px-1.5 text-xs ${active ? "bg-background/20" : "bg-muted"}`}>{count}</span>}
    </button>
  );
}

function AssignControl({ queueId, onAssigned }: { queueId: string; onAssigned: () => void }) {
  const providers = useQuery({ queryKey: ["providers"], queryFn: listProviders });
  const [provider, setProvider] = useState("");
  const mut = useMutation({
    mutationFn: () => assignProvider(queueId, provider),
    onSuccess: () => {
      toast.success("Assigned to doctor");
      onAssigned();
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : "Could not assign"),
  });
  const list = providers.data ?? [];
  return (
    <div className="flex items-center gap-2">
      <div className="w-44">
        <Select value={provider} onValueChange={setProvider}>
          <SelectTrigger>
            <SelectValue placeholder={list.length === 0 ? "No doctors available" : "Assign doctor…"} />
          </SelectTrigger>
          <SelectContent>
            {list.map((u) => (
              <SelectItem key={u.id} value={u.id}>{u.full_name}</SelectItem>
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

// A field's data-entry error (plausibility / required), or null if fine.
function fieldError(f: VitalField, raw: string | undefined): string | null {
  if (raw === undefined || raw === "") return f.required ? "Required" : null;
  const n = Number(raw);
  if (Number.isNaN(n)) return "Enter a number";
  if (f.min != null && n < f.min) return `Below min ${f.min}`;
  if (f.max != null && n > f.max) return `Above max ${f.max}`;
  return null;
}

const FLAG_BADGE: Record<"low" | "normal" | "high", { label: string; variant: "warning" | "success" }> = {
  low: { label: "Low", variant: "warning" },
  normal: { label: "Normal", variant: "success" },
  high: { label: "High", variant: "warning" },
};

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
  const qc = useQueryClient();
  const [vals, setVals] = useState<Record<string, string>>({});
  const [notes, setNotes] = useState("");

  // The clinic's configurable vitals form (enabled fields, in order).
  const fieldsQ = useQuery({ queryKey: ["vital-fields"], queryFn: getVitalFields });
  const fields = (fieldsQ.data ?? []).filter((f) => f.enabled).sort((a, b) => a.order - b.order);

  // When editing, load the most recent recorded reading and prefill the form.
  const visit = useQuery({ queryKey: ["visit", entry.id], queryFn: () => getVisit(entry.id), enabled: entry.has_vitals });
  const [prefilled, setPrefilled] = useState(false);
  if (entry.has_vitals && visit.data && !prefilled) {
    const v = visit.data.vitals?.[0];
    if (v) {
      const init: Record<string, string> = {};
      for (const f of fields) {
        const cur = (v as unknown as Record<string, unknown>)[f.key];
        if (cur !== null && cur !== undefined) init[f.key] = String(cur);
      }
      setVals(init);
      setNotes(v.notes ?? "");
    }
    setPrefilled(true);
  }

  const errors = fields.map((f) => fieldError(f, vals[f.key])).filter(Boolean) as string[];
  const hasErrors = errors.length > 0;

  const mut = useMutation({
    mutationFn: () => {
      const body: VitalsBody = { branch_id: branchId, department_id: departmentId, notes };
      for (const f of fields) {
        const v = vals[f.key];
        if (v !== undefined && v !== "") (body as unknown as Record<string, number | string>)[f.key] = Number(v);
      }
      return recordVitals(entry.id, entry.patient_id, body);
    },
    onSuccess: () => {
      toast.success("Vitals recorded");
      qc.invalidateQueries({ queryKey: ["visit", entry.id] });
      onSaved();
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : "Could not record vitals"),
  });

  return (
    <Dialog open onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Vitals · {entry.patient_name}</DialogTitle>
        </DialogHeader>
        {entry.has_vitals && visit.isLoading && <p className="text-xs text-muted-foreground">Loading the current reading…</p>}
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          {fields.map((f) => {
            const raw = vals[f.key] ?? "";
            const err = fieldError(f, raw);
            const flag = !err && raw !== "" ? vitalFlag(f, Number(raw)) : null;
            return (
              <div key={f.key} className="space-y-1.5">
                <Label className="flex items-center justify-between gap-1 text-xs">
                  <span>
                    {f.label} <span className="text-muted-foreground">{f.unit}</span>
                    {f.required && <span className="text-destructive"> *</span>}
                  </span>
                  {flag && <Badge variant={FLAG_BADGE[flag].variant} className="px-1.5 py-0 text-[10px]">{FLAG_BADGE[flag].label}</Badge>}
                </Label>
                <Input
                  type="number"
                  inputMode="decimal"
                  step={f.decimals > 0 ? 1 / 10 ** f.decimals : 1}
                  className={err && raw !== "" ? "border-destructive focus-visible:ring-destructive" : undefined}
                  value={raw}
                  onChange={(e) => setVals((s) => ({ ...s, [f.key]: e.target.value }))}
                />
                {err && raw !== "" && <p className="text-[10px] text-destructive">{err}</p>}
              </div>
            );
          })}
        </div>
        <div className="space-y-1.5">
          <div className="flex items-center justify-between gap-2">
            <Label>Notes</Label>
            <DictateButton onText={(t) => setNotes((n) => (n.trim() ? `${n.replace(/\s*$/, "")} ${t}` : t))} />
          </div>
          <Textarea value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Triage notes" />
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button loading={mut.isPending} disabled={hasErrors || fields.length === 0} onClick={() => mut.mutate()}>
            Save vitals
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
