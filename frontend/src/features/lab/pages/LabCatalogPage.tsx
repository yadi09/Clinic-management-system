import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ChevronDown, ChevronRight, Plus } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { toast } from "@/components/ui/sonner";
import { AppError } from "@/lib/api-client";
import { addAnalyte, createTest, listAnalytes, listTests, type LabTest } from "@/features/lab/api";

export function LabCatalogPage() {
  const qc = useQueryClient();
  const tests = useQuery({ queryKey: ["lab-tests"], queryFn: () => listTests(false) });
  const [open, setOpen] = useState<string | null>(null);
  const [newTest, setNewTest] = useState(false);

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1>Lab test catalog</h1>
          <p className="text-sm text-muted-foreground">Tests/panels and their analytes with reference &amp; critical ranges.</p>
        </div>
        <Button onClick={() => setNewTest(true)}>
          <Plus className="h-4 w-4" /> New test
        </Button>
      </div>

      <div className="space-y-2">
        {(tests.data ?? []).map((t) => (
          <Card key={t.id} className="overflow-hidden">
            <button
              className="flex w-full items-center justify-between gap-3 p-4 text-left hover:bg-muted/30"
              onClick={() => setOpen(open === t.id ? null : t.id)}
            >
              <div className="flex items-center gap-2">
                {open === t.id ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
                <span className="font-mono text-xs text-muted-foreground">{t.code}</span>
                <span className="font-medium">{t.name}</span>
                {!t.is_active && <Badge variant="outline">inactive</Badge>}
              </div>
              <span className="text-xs text-muted-foreground">
                {t.specimen ? `${t.specimen} · ` : ""}{t.analyte_count} analyte{t.analyte_count === 1 ? "" : "s"}
              </span>
            </button>
            {open === t.id && <AnalytePanel test={t} />}
          </Card>
        ))}
        {(tests.data?.length ?? 0) === 0 && <Card className="p-10 text-center text-sm text-muted-foreground">No tests yet.</Card>}
      </div>

      <NewTestDialog open={newTest} onOpenChange={setNewTest} onCreated={() => qc.invalidateQueries({ queryKey: ["lab-tests"] })} />
    </div>
  );
}

function AnalytePanel({ test }: { test: LabTest }) {
  const qc = useQueryClient();
  const analytes = useQuery({ queryKey: ["lab-analytes", test.id], queryFn: () => listAnalytes(test.id) });
  const [add, setAdd] = useState(false);

  return (
    <div className="border-t bg-muted/20 p-4">
      <table className="w-full text-sm">
        <thead className="text-left text-xs uppercase tracking-wide text-muted-foreground">
          <tr>
            <th className="py-1 font-medium">Analyte</th>
            <th className="font-medium">Unit</th>
            <th className="font-medium">Reference</th>
            <th className="font-medium">Critical</th>
          </tr>
        </thead>
        <tbody>
          {(analytes.data ?? []).map((a) => (
            <tr key={a.id} className="border-b last:border-0">
              <td className="py-1.5">{a.name}</td>
              <td className="text-muted-foreground">{a.unit || "—"}</td>
              <td className="text-muted-foreground">{[a.ref_low, a.ref_high].some(Boolean) ? `${a.ref_low ?? ""}–${a.ref_high ?? ""}` : "—"}</td>
              <td className="text-muted-foreground">{[a.critical_low, a.critical_high].some(Boolean) ? `${a.critical_low ?? ""}–${a.critical_high ?? ""}` : "—"}</td>
            </tr>
          ))}
          {(analytes.data?.length ?? 0) === 0 && (
            <tr><td colSpan={4} className="py-2 text-xs text-muted-foreground">No analytes — add at least one.</td></tr>
          )}
        </tbody>
      </table>
      <Button size="sm" variant="outline" className="mt-3" onClick={() => setAdd(true)}>
        <Plus className="h-3.5 w-3.5" /> Add analyte
      </Button>
      <AddAnalyteDialog test={test} open={add} onOpenChange={setAdd} onAdded={() => {
        qc.invalidateQueries({ queryKey: ["lab-analytes", test.id] });
        qc.invalidateQueries({ queryKey: ["lab-tests"] });
      }} />
    </div>
  );
}

function NewTestDialog({ open, onOpenChange, onCreated }: { open: boolean; onOpenChange: (v: boolean) => void; onCreated: () => void }) {
  const [form, setForm] = useState({ code: "", name: "", specimen: "" });
  const mut = useMutation({
    mutationFn: () => createTest(form),
    onSuccess: () => { setForm({ code: "", name: "", specimen: "" }); onOpenChange(false); onCreated(); },
    onError: (e) => toast.error(e instanceof AppError ? e.message : "Could not create test"),
  });
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader><DialogTitle>New lab test</DialogTitle></DialogHeader>
        <div className="grid grid-cols-2 gap-3">
          <div className="space-y-1.5"><Label>Code</Label><Input value={form.code} onChange={(e) => setForm({ ...form, code: e.target.value })} placeholder="CBC" /></div>
          <div className="space-y-1.5"><Label>Specimen</Label><Input value={form.specimen} onChange={(e) => setForm({ ...form, specimen: e.target.value })} placeholder="Whole blood" /></div>
          <div className="col-span-2 space-y-1.5"><Label>Name</Label><Input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="Complete Blood Count" /></div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button disabled={!form.code.trim() || !form.name.trim()} loading={mut.isPending} onClick={() => mut.mutate()}>Create</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function AddAnalyteDialog({ test, open, onOpenChange, onAdded }: { test: LabTest; open: boolean; onOpenChange: (v: boolean) => void; onAdded: () => void }) {
  const empty = { name: "", unit: "", ref_low: "", ref_high: "", critical_low: "", critical_high: "" };
  const [form, setForm] = useState(empty);
  const mut = useMutation({
    mutationFn: () => addAnalyte(test.id, form),
    onSuccess: () => { setForm(empty); onOpenChange(false); onAdded(); },
    onError: (e) => toast.error(e instanceof AppError ? e.message : "Could not add analyte"),
  });
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader><DialogTitle>Add analyte to {test.name}</DialogTitle></DialogHeader>
        <div className="grid grid-cols-2 gap-3">
          <div className="space-y-1.5"><Label>Name</Label><Input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="Hemoglobin" /></div>
          <div className="space-y-1.5"><Label>Unit</Label><Input value={form.unit} onChange={(e) => setForm({ ...form, unit: e.target.value })} placeholder="g/dL" /></div>
          <div className="space-y-1.5"><Label>Ref low</Label><Input value={form.ref_low} onChange={(e) => setForm({ ...form, ref_low: e.target.value })} placeholder="13" /></div>
          <div className="space-y-1.5"><Label>Ref high</Label><Input value={form.ref_high} onChange={(e) => setForm({ ...form, ref_high: e.target.value })} placeholder="17" /></div>
          <div className="space-y-1.5"><Label>Critical low</Label><Input value={form.critical_low} onChange={(e) => setForm({ ...form, critical_low: e.target.value })} placeholder="7" /></div>
          <div className="space-y-1.5"><Label>Critical high</Label><Input value={form.critical_high} onChange={(e) => setForm({ ...form, critical_high: e.target.value })} placeholder="20" /></div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button disabled={!form.name.trim()} loading={mut.isPending} onClick={() => mut.mutate()}>Add</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
