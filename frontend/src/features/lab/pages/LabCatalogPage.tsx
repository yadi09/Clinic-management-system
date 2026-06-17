import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ChevronDown, ChevronRight, Pencil, Plus, Trash2, Upload } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { toast } from "@/components/ui/sonner";
import { AppError } from "@/lib/api-client";
import {
  addAnalyte, createTest, deleteAnalyte, deleteTest, importCatalog, listAnalytes, listTests,
  setTestActive, updateAnalyte, updateTest, type Analyte, type ImportRow, type LabTest,
} from "@/features/lab/api";

const IMPORT_COLS = ["test_code", "test_name", "specimen", "analyte_name", "unit", "ref_low", "ref_high", "critical_low", "critical_high"];

// parseCsv accepts an optional header row; values here are simple (no embedded commas).
function parseCsv(text: string): ImportRow[] {
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  if (lines.length === 0) return [];
  const start = lines[0].toLowerCase().includes("test_code") ? 1 : 0;
  const rows: ImportRow[] = [];
  for (let i = start; i < lines.length; i++) {
    const c = lines[i].split(",").map((s) => s.trim());
    if (!c[0]) continue;
    rows.push({
      test_code: c[0], test_name: c[1] ?? "", specimen: c[2] ?? "", analyte_name: c[3] ?? "",
      unit: c[4] ?? "", ref_low: c[5] ?? "", ref_high: c[6] ?? "", critical_low: c[7] ?? "", critical_high: c[8] ?? "",
    });
  }
  return rows;
}

export function LabCatalogPage() {
  const qc = useQueryClient();
  const tests = useQuery({ queryKey: ["lab-tests"], queryFn: () => listTests(false) });
  const [open, setOpen] = useState<string | null>(null);
  const [newTest, setNewTest] = useState(false);
  const [importing, setImporting] = useState(false);
  const invalidate = () => qc.invalidateQueries({ queryKey: ["lab-tests"] });

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1>Lab test catalog</h1>
          <p className="text-sm text-muted-foreground">
            Tests/panels and their analytes with reference &amp; critical ranges. Toggle a test's
            availability to control what doctors can order.
          </p>
        </div>
        <div className="flex gap-2">
          <Button variant="outline" onClick={() => setImporting(true)}>
            <Upload className="h-4 w-4" /> Import CSV
          </Button>
          <Button onClick={() => setNewTest(true)}>
            <Plus className="h-4 w-4" /> New test
          </Button>
        </div>
      </div>

      <div className="space-y-2">
        {(tests.data ?? []).map((t) => (
          <TestRow key={t.id} test={t} expanded={open === t.id} onToggle={() => setOpen(open === t.id ? null : t.id)} />
        ))}
        {(tests.data?.length ?? 0) === 0 && <Card className="p-10 text-center text-sm text-muted-foreground">No tests yet.</Card>}
      </div>

      <TestDialog open={newTest} onOpenChange={setNewTest} onDone={invalidate} />
      <ImportDialog open={importing} onOpenChange={setImporting} onDone={invalidate} />
    </div>
  );
}

function TestRow({ test, expanded, onToggle }: { test: LabTest; expanded: boolean; onToggle: () => void }) {
  const qc = useQueryClient();
  const [edit, setEdit] = useState(false);
  const invalidate = () => qc.invalidateQueries({ queryKey: ["lab-tests"] });

  const toggle = useMutation({
    mutationFn: () => setTestActive(test.id, !test.is_active),
    onSuccess: invalidate,
    onError: (e) => toast.error(e instanceof AppError ? e.message : "Could not update availability"),
  });
  const del = useMutation({
    mutationFn: () => deleteTest(test.id),
    onSuccess: () => { toast.success(`${test.name} removed from the catalog`); invalidate(); },
    onError: (e) => toast.error(e instanceof AppError ? e.message : "Could not delete"),
  });

  return (
    <Card className="overflow-hidden">
      <div className="flex items-center justify-between gap-3 p-4">
        <button className="flex min-w-0 items-center gap-2 text-left" onClick={onToggle}>
          {expanded ? <ChevronDown className="h-4 w-4 shrink-0" /> : <ChevronRight className="h-4 w-4 shrink-0" />}
          <span className="font-mono text-xs text-muted-foreground">{test.code}</span>
          <span className="truncate font-medium">{test.name}</span>
          <span className="hidden text-xs text-muted-foreground sm:inline">
            · {test.specimen ? `${test.specimen} · ` : ""}{test.analyte_count} analyte{test.analyte_count === 1 ? "" : "s"}
          </span>
        </button>
        <div className="flex shrink-0 items-center gap-1.5">
          <button
            onClick={() => toggle.mutate()}
            disabled={toggle.isPending}
            title={test.is_active ? "Available to order — click to make unavailable" : "Not orderable — click to make available"}
            className={`rounded-full border px-2.5 py-1 text-xs font-medium transition-colors ${
              test.is_active ? "border-emerald-200 bg-emerald-50 text-emerald-700" : "border-slate-200 bg-slate-50 text-muted-foreground"
            }`}
          >
            {test.is_active ? "Available" : "Unavailable"}
          </button>
          <button onClick={() => setEdit(true)} className="rounded-md p-1.5 text-muted-foreground hover:bg-muted hover:text-foreground" title="Edit test">
            <Pencil className="h-4 w-4" />
          </button>
          <button
            onClick={() => { if (window.confirm(`Remove "${test.name}" from the catalog? It will no longer be orderable. Past results are kept.`)) del.mutate(); }}
            className="rounded-md p-1.5 text-muted-foreground hover:bg-muted hover:text-destructive"
            title="Delete test"
          >
            <Trash2 className="h-4 w-4" />
          </button>
        </div>
      </div>
      {expanded && <AnalytePanel test={test} />}
      <TestDialog test={test} open={edit} onOpenChange={setEdit} onDone={invalidate} />
    </Card>
  );
}

function AnalytePanel({ test }: { test: LabTest }) {
  const qc = useQueryClient();
  const analytes = useQuery({ queryKey: ["lab-analytes", test.id], queryFn: () => listAnalytes(test.id) });
  const [add, setAdd] = useState(false);
  const [editing, setEditing] = useState<Analyte | null>(null);
  const refresh = () => {
    qc.invalidateQueries({ queryKey: ["lab-analytes", test.id] });
    qc.invalidateQueries({ queryKey: ["lab-tests"] });
  };
  const del = useMutation({
    mutationFn: (id: string) => deleteAnalyte(id),
    onSuccess: () => { toast.success("Analyte removed"); refresh(); },
    onError: (e) => toast.error(e instanceof AppError ? e.message : "Could not delete analyte"),
  });

  return (
    <div className="border-t bg-muted/20 p-4">
      <table className="w-full text-sm">
        <thead className="text-left text-xs uppercase tracking-wide text-muted-foreground">
          <tr>
            <th className="py-1 font-medium">Analyte</th>
            <th className="font-medium">Unit</th>
            <th className="font-medium">Reference</th>
            <th className="font-medium">Critical</th>
            <th className="w-16"></th>
          </tr>
        </thead>
        <tbody>
          {(analytes.data ?? []).map((a) => (
            <tr key={a.id} className="group border-b last:border-0">
              <td className="py-1.5">{a.name}</td>
              <td className="text-muted-foreground">{a.unit || "—"}</td>
              <td className="text-muted-foreground">{[a.ref_low, a.ref_high].some(Boolean) ? `${a.ref_low ?? ""}–${a.ref_high ?? ""}` : "—"}</td>
              <td className="text-muted-foreground">{[a.critical_low, a.critical_high].some(Boolean) ? `${a.critical_low ?? ""}–${a.critical_high ?? ""}` : "—"}</td>
              <td>
                <div className="flex items-center justify-end gap-1 opacity-60 group-hover:opacity-100">
                  <button onClick={() => setEditing(a)} className="rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground" title="Edit analyte">
                    <Pencil className="h-3.5 w-3.5" />
                  </button>
                  <button
                    onClick={() => { if (window.confirm(`Delete analyte "${a.name}"?`)) del.mutate(a.id); }}
                    className="rounded p-1 text-muted-foreground hover:bg-muted hover:text-destructive"
                    title="Delete analyte"
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </button>
                </div>
              </td>
            </tr>
          ))}
          {(analytes.data?.length ?? 0) === 0 && (
            <tr><td colSpan={5} className="py-2 text-xs text-muted-foreground">No analytes — add at least one.</td></tr>
          )}
        </tbody>
      </table>
      <Button size="sm" variant="outline" className="mt-3" onClick={() => setAdd(true)}>
        <Plus className="h-3.5 w-3.5" /> Add analyte
      </Button>
      <AnalyteDialog test={test} open={add} onOpenChange={setAdd} onDone={refresh} />
      <AnalyteDialog test={test} analyte={editing ?? undefined} open={!!editing} onOpenChange={(v) => !v && setEditing(null)} onDone={refresh} />
    </div>
  );
}

// TestDialog creates a new test (no `test`) or edits an existing one.
function TestDialog({ test, open, onOpenChange, onDone }: { test?: LabTest; open: boolean; onOpenChange: (v: boolean) => void; onDone: () => void }) {
  const editing = !!test;
  const [form, setForm] = useState({ code: "", name: "", specimen: "" });
  useEffect(() => {
    if (open) setForm(test ? { code: test.code, name: test.name, specimen: test.specimen ?? "" } : { code: "", name: "", specimen: "" });
  }, [open, test]);
  const mut = useMutation({
    mutationFn: async () => { if (editing && test) await updateTest(test.id, form); else await createTest(form); },
    onSuccess: () => { onOpenChange(false); onDone(); },
    onError: (e) => toast.error(e instanceof AppError ? e.message : "Could not save the test"),
  });
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader><DialogTitle>{editing ? "Edit lab test" : "New lab test"}</DialogTitle></DialogHeader>
        <div className="grid grid-cols-2 gap-3">
          <div className="space-y-1.5"><Label>Code</Label><Input value={form.code} onChange={(e) => setForm({ ...form, code: e.target.value })} placeholder="CBC" /></div>
          <div className="space-y-1.5"><Label>Specimen</Label><Input value={form.specimen} onChange={(e) => setForm({ ...form, specimen: e.target.value })} placeholder="Whole blood" /></div>
          <div className="col-span-2 space-y-1.5"><Label>Name</Label><Input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="Complete Blood Count" /></div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button disabled={!form.code.trim() || !form.name.trim()} loading={mut.isPending} onClick={() => mut.mutate()}>{editing ? "Save" : "Create"}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// AnalyteDialog adds a new analyte (no `analyte`) or edits an existing one.
function AnalyteDialog({ test, analyte, open, onOpenChange, onDone }: { test: LabTest; analyte?: Analyte; open: boolean; onOpenChange: (v: boolean) => void; onDone: () => void }) {
  const editing = !!analyte;
  const empty = { name: "", unit: "", ref_low: "", ref_high: "", critical_low: "", critical_high: "" };
  const [form, setForm] = useState(empty);
  useEffect(() => {
    if (open) {
      setForm(analyte
        ? { name: analyte.name, unit: analyte.unit ?? "", ref_low: analyte.ref_low ?? "", ref_high: analyte.ref_high ?? "", critical_low: analyte.critical_low ?? "", critical_high: analyte.critical_high ?? "" }
        : empty);
    }
  }, [open, analyte]);
  const mut = useMutation({
    mutationFn: () => (editing && analyte ? updateAnalyte(analyte.id, form) : addAnalyte(test.id, form)),
    onSuccess: () => { onOpenChange(false); onDone(); },
    onError: (e) => toast.error(e instanceof AppError ? e.message : "Could not save the analyte"),
  });
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader><DialogTitle>{editing ? `Edit ${analyte?.name}` : `Add analyte to ${test.name}`}</DialogTitle></DialogHeader>
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
          <Button disabled={!form.name.trim()} loading={mut.isPending} onClick={() => mut.mutate()}>{editing ? "Save" : "Add"}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function ImportDialog({ open, onOpenChange, onDone }: { open: boolean; onOpenChange: (v: boolean) => void; onDone: () => void }) {
  const [text, setText] = useState("");
  const rows = parseCsv(text);
  const mut = useMutation({
    mutationFn: () => importCatalog(rows),
    onSuccess: (r) => {
      toast.success(`Imported: ${r.tests_created} test(s), ${r.analytes_added} analyte(s)${r.rows_skipped_dup ? `, ${r.rows_skipped_dup} dup skipped` : ""}`);
      setText("");
      onOpenChange(false);
      onDone();
    },
    onError: (e) => toast.error(e instanceof AppError ? e.message : "Import failed — check the numeric columns"),
  });
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader><DialogTitle>Import catalog (CSV)</DialogTitle></DialogHeader>
        <p className="text-xs text-muted-foreground">
          One row per analyte. Columns: <span className="font-mono">{IMPORT_COLS.join(",")}</span>. Tests are reused/created by code; existing analytes are skipped.
        </p>
        <Textarea
          rows={8}
          className="font-mono text-xs"
          placeholder={"test_code,test_name,specimen,analyte_name,unit,ref_low,ref_high,critical_low,critical_high\nTSH,Thyroid stimulating hormone,Serum,TSH,mIU/L,0.4,4.0,0.1,10"}
          value={text}
          onChange={(e) => setText(e.target.value)}
        />
        <DialogFooter>
          <span className="mr-auto self-center text-xs text-muted-foreground">{rows.length} row{rows.length === 1 ? "" : "s"} parsed</span>
          <Button variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button disabled={rows.length === 0} loading={mut.isPending} onClick={() => mut.mutate()}>Import</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
