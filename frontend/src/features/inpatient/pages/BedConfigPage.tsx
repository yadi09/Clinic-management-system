import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Pencil, Plus } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { toast } from "@/components/ui/sonner";
import { AppError } from "@/lib/api-client";
import { createBed, createWard, listBeds, listWards, updateBed, updateWard, type Bed, type Ward } from "@/features/inpatient/api";

const BED_TYPES = ["general", "private", "semi_private", "icu", "maternity", "pediatric"];
const label = (t: string) => t.replace(/_/g, " ");

export function BedConfigPage() {
  const qc = useQueryClient();
  const wards = useQuery({ queryKey: ["wards"], queryFn: listWards });
  const beds = useQuery({ queryKey: ["beds"], queryFn: listBeds });
  const [newWard, setNewWard] = useState("");
  const [bedDialog, setBedDialog] = useState<{ mode: "new" | "edit"; bed?: Bed } | null>(null);
  const refresh = () => { qc.invalidateQueries({ queryKey: ["wards"] }); qc.invalidateQueries({ queryKey: ["beds"] }); };

  const addWard = useMutation({
    mutationFn: () => createWard(newWard.trim()),
    onSuccess: () => { toast.success("Ward added"); setNewWard(""); refresh(); },
    onError: (e) => toast.error(e instanceof AppError ? e.message : "Could not add ward"),
  });

  const activeWards = (wards.data ?? []).filter((w) => w.is_active);

  return (
    <div className="space-y-6">
      <div><h1>Bed setup</h1><p className="text-sm text-muted-foreground">Wards and beds for this branch.</p></div>

      <Card className="p-4">
        <h2 className="mb-3 text-h3">Wards</h2>
        <div className="mb-4 flex max-w-md gap-2">
          <Input placeholder="New ward name (e.g. Maternity)" value={newWard} onChange={(e) => setNewWard(e.target.value)} onKeyDown={(e) => e.key === "Enter" && newWard.trim() && addWard.mutate()} />
          <Button disabled={!newWard.trim()} loading={addWard.isPending} onClick={() => addWard.mutate()}><Plus className="h-4 w-4" /> Add</Button>
        </div>
        <div className="flex flex-wrap gap-2">
          {activeWards.length === 0 && <p className="text-sm text-muted-foreground">No wards yet.</p>}
          {activeWards.map((w) => <WardChip key={w.id} w={w} onChanged={refresh} />)}
        </div>
      </Card>

      <Card className="p-4">
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-h3">Beds</h2>
          <Button size="sm" disabled={activeWards.length === 0} onClick={() => setBedDialog({ mode: "new" })}><Plus className="h-4 w-4" /> New bed</Button>
        </div>
        {beds.isLoading ? (
          <p className="text-sm text-muted-foreground">Loading…</p>
        ) : (beds.data ?? []).length === 0 ? (
          <p className="text-sm text-muted-foreground">No beds yet. {activeWards.length === 0 ? "Add a ward first." : "Add your first bed."}</p>
        ) : (
          <Table>
            <TableHeader><TableRow><TableHead>Ward</TableHead><TableHead>Bed</TableHead><TableHead>Type</TableHead><TableHead>Rate/day</TableHead><TableHead>Status</TableHead><TableHead /></TableRow></TableHeader>
            <TableBody>
              {(beds.data ?? []).map((b) => (
                <TableRow key={b.id}>
                  <TableCell>{b.ward_name}</TableCell>
                  <TableCell className="font-medium text-brand">{b.label}</TableCell>
                  <TableCell className="capitalize">{label(b.bed_type)}</TableCell>
                  <TableCell className="tabular-nums">ETB {b.daily_rate}</TableCell>
                  <TableCell>{b.out_of_service ? <Badge variant="outline">out of service</Badge> : <Badge variant="success">in use</Badge>}</TableCell>
                  <TableCell className="text-right"><Button size="sm" variant="ghost" onClick={() => setBedDialog({ mode: "edit", bed: b })}><Pencil className="h-3.5 w-3.5" /></Button></TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </Card>

      {bedDialog && <BedDialog wards={activeWards} bed={bedDialog.bed} onOpenChange={(o) => !o && setBedDialog(null)} onDone={refresh} />}
    </div>
  );
}

function WardChip({ w, onChanged }: { w: Ward; onChanged: () => void }) {
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(w.name);
  const save = useMutation({
    mutationFn: () => updateWard(w.id, { name: name.trim() }),
    onSuccess: () => { toast.success("Ward renamed"); setEditing(false); onChanged(); },
    onError: (e) => toast.error(e instanceof AppError ? e.message : "Could not rename"),
  });
  const remove = useMutation({
    mutationFn: () => updateWard(w.id, { is_active: false }),
    onSuccess: () => { toast.success("Ward removed"); onChanged(); },
    onError: (e) => toast.error(e instanceof AppError ? e.message : "Could not remove"),
  });
  if (editing) {
    return (
      <span className="flex items-center gap-1">
        <Input className="h-8 w-40" value={name} onChange={(e) => setName(e.target.value)} />
        <Button size="sm" loading={save.isPending} onClick={() => save.mutate()}>Save</Button>
        <Button size="sm" variant="ghost" onClick={() => setEditing(false)}>Cancel</Button>
      </span>
    );
  }
  return (
    <span className="flex items-center gap-1 rounded-md border bg-background px-3 py-1.5 text-sm">
      <span className="font-medium">{w.name}</span>
      <span className="text-xs text-muted-foreground">({w.bed_count})</span>
      <button className="ml-1 text-muted-foreground hover:text-foreground" onClick={() => { setName(w.name); setEditing(true); }}><Pencil className="h-3 w-3" /></button>
      {w.bed_count === 0 && <button className="text-muted-foreground hover:text-destructive" title="Remove ward" onClick={() => remove.mutate()}>×</button>}
    </span>
  );
}

function BedDialog({ wards, bed, onOpenChange, onDone }: { wards: Ward[]; bed?: Bed; onOpenChange: (o: boolean) => void; onDone: () => void }) {
  const editing = !!bed;
  const [wardId, setWardId] = useState(bed?.ward_id ?? wards[0]?.id ?? "");
  const [lbl, setLbl] = useState(bed?.label ?? "");
  const [type, setType] = useState(bed?.bed_type ?? "general");
  const [rate, setRate] = useState(bed?.daily_rate ?? "");
  const [oos, setOos] = useState(bed?.out_of_service ?? false);

  const mut = useMutation({
    mutationFn: async () => {
      if (editing) {
        await updateBed(bed!.id, { ward_id: wardId, label: lbl.trim(), bed_type: type, daily_rate: rate || "0", out_of_service: oos });
      } else {
        await createBed({ ward_id: wardId, label: lbl.trim(), bed_type: type, daily_rate: rate || "0" });
      }
    },
    onSuccess: () => { toast.success(editing ? "Bed updated" : "Bed added"); onOpenChange(false); onDone(); },
    onError: (e) => toast.error(e instanceof AppError ? e.message : "Could not save the bed"),
  });
  const remove = useMutation({
    mutationFn: () => updateBed(bed!.id, { is_active: false }),
    onSuccess: () => { toast.success("Bed removed"); onOpenChange(false); onDone(); },
    onError: (e) => toast.error(e instanceof AppError ? e.message : "Could not remove the bed"),
  });

  return (
    <Dialog open onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader><DialogTitle>{editing ? "Edit bed" : "New bed"}</DialogTitle></DialogHeader>
        <div className="space-y-4">
          <div className="space-y-1.5">
            <Label>Ward</Label>
            <Select value={wardId} onValueChange={setWardId}>
              <SelectTrigger><SelectValue placeholder="Choose…" /></SelectTrigger>
              <SelectContent>{wards.map((w) => <SelectItem key={w.id} value={w.id}>{w.name}</SelectItem>)}</SelectContent>
            </Select>
          </div>
          <div className="grid gap-4 sm:grid-cols-3">
            <div className="space-y-1.5"><Label>Bed label</Label><Input value={lbl} onChange={(e) => setLbl(e.target.value)} placeholder="e.g. B1" /></div>
            <div className="space-y-1.5">
              <Label>Type</Label>
              <Select value={type} onValueChange={setType}>
                <SelectTrigger className="capitalize"><SelectValue /></SelectTrigger>
                <SelectContent>{BED_TYPES.map((t) => <SelectItem key={t} value={t} className="capitalize">{label(t)}</SelectItem>)}</SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5"><Label>Rate/day (ETB)</Label><Input type="number" min={0} value={rate} onChange={(e) => setRate(e.target.value)} placeholder="0" /></div>
          </div>
          {editing && (
            <label className="flex items-center gap-2 text-sm">
              <input type="checkbox" checked={oos} onChange={(e) => setOos(e.target.checked)} /> Out of service (maintenance)
            </label>
          )}
        </div>
        <DialogFooter>
          {editing && <Button variant="ghost" className="mr-auto text-destructive" loading={remove.isPending} onClick={() => remove.mutate()}>Remove bed</Button>}
          <Button variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button disabled={!wardId || !lbl.trim()} loading={mut.isPending} onClick={() => mut.mutate()}>{editing ? "Save" : "Add bed"}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
