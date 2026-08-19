import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Plus } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { toast } from "@/components/ui/sonner";
import { createDrug, listDrugs, updateDrug, type Drug } from "@/features/pharmacy/api";

type Editing = (Partial<Drug> & { isNew?: boolean }) | null;

export function CatalogAdminPage() {
  const qc = useQueryClient();
  const drugs = useQuery({ queryKey: ["drugs"], queryFn: () => listDrugs() });
  const [editing, setEditing] = useState<Editing>(null);

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1>Drug catalog admin</h1>
          <p className="text-sm text-muted-foreground">Maintain catalog &amp; pricing</p>
        </div>
        <Button onClick={() => setEditing({ isNew: true, is_controlled: false, is_active: true })}>
          <Plus /> Add drug
        </Button>
      </div>

      <Card className="overflow-hidden">
        <div className="overflow-x-auto">
          {/* Phones: this table is wider than the screen — scroll it sideways instead of crushing the columns. */}
          <table className="w-full min-w-[560px] text-sm">
            <thead className="border-b bg-muted/40 text-left text-xs uppercase tracking-wide text-muted-foreground">
              <tr>
                <th className="p-3 font-medium">Drug</th>
                <th className="font-medium">Form</th>
                <th className="font-medium">Class</th>
                <th className="font-medium">Reorder lvl</th>
                <th className="font-medium">Price</th>
                <th className="p-3 font-medium"></th>
              </tr>
            </thead>
            <tbody>
              {(drugs.data ?? []).map((d) => (
                <tr key={d.id} className="border-b">
                  <td className="p-3 font-medium">
                    {d.name} {!d.is_active && <Badge variant="outline">inactive</Badge>}
                  </td>
                  <td>{d.form || "—"}</td>
                  <td>{d.drug_class || "—"}{d.is_controlled ? " (controlled)" : ""}</td>
                  <td>{d.reorder_level}</td>
                  <td className="font-medium">{d.unit_price}</td>
                  <td className="p-3 text-right">
                    <button className="text-xs text-primary hover:underline" onClick={() => setEditing({ ...d })}>
                      Edit
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {(drugs.data?.length ?? 0) === 0 && <p className="p-8 text-center text-sm text-muted-foreground">No drugs yet.</p>}
      </Card>

      {editing && <DrugDialog editing={editing} onClose={() => setEditing(null)} onDone={() => qc.invalidateQueries({ queryKey: ["drugs"] })} />}
    </div>
  );
}

function DrugDialog({ editing, onClose, onDone }: { editing: Editing; onClose: () => void; onDone: () => void }) {
  const isNew = !!editing?.isNew;
  const [form, setForm] = useState({
    name: editing?.name ?? "",
    form: editing?.form ?? "",
    drug_class: editing?.drug_class ?? "",
    is_controlled: editing?.is_controlled ?? false,
    unit_price: editing?.unit_price ?? "0",
    reorder_level: editing?.reorder_level ?? 0,
    is_active: editing?.is_active ?? true,
  });
  useEffect(() => {
    setForm({
      name: editing?.name ?? "",
      form: editing?.form ?? "",
      drug_class: editing?.drug_class ?? "",
      is_controlled: editing?.is_controlled ?? false,
      unit_price: editing?.unit_price ?? "0",
      reorder_level: editing?.reorder_level ?? 0,
      is_active: editing?.is_active ?? true,
    });
  }, [editing]);

  const mut = useMutation({
    mutationFn: async () => {
      const body = {
        name: form.name,
        form: form.form || undefined,
        drug_class: form.drug_class || undefined,
        is_controlled: form.is_controlled,
        unit_price: Number(form.unit_price) || 0,
        reorder_level: Number(form.reorder_level) || 0,
      };
      if (isNew) await createDrug(body);
      else await updateDrug(editing!.id as string, { ...body, is_active: form.is_active });
    },
    onSuccess: () => {
      toast.success(isNew ? "Drug added" : "Drug updated");
      onDone();
      onClose();
    },
    onError: () => toast.error("Could not save (name may already exist)"),
  });

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{isNew ? "Add drug" : "Edit drug"}</DialogTitle>
        </DialogHeader>
        <div className="grid grid-cols-2 gap-3">
          <div className="col-span-2 space-y-1.5">
            <Label>Name</Label>
            <Input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="Azithromycin 500mg" />
          </div>
          <div className="space-y-1.5">
            <Label>Form</Label>
            <Input value={form.form} onChange={(e) => setForm({ ...form, form: e.target.value })} placeholder="Tablet" />
          </div>
          <div className="space-y-1.5">
            <Label>Class</Label>
            <Input value={form.drug_class} onChange={(e) => setForm({ ...form, drug_class: e.target.value })} placeholder="Macrolide" />
          </div>
          <div className="space-y-1.5">
            <Label>Unit price (ETB)</Label>
            <Input type="number" value={form.unit_price} onChange={(e) => setForm({ ...form, unit_price: e.target.value })} />
          </div>
          <div className="space-y-1.5">
            <Label>Reorder level</Label>
            <Input type="number" value={form.reorder_level} onChange={(e) => setForm({ ...form, reorder_level: Number(e.target.value) })} />
          </div>
          <div className="space-y-1.5">
            <Label>Controlled</Label>
            <select className="block w-full rounded-md border bg-background px-2 py-2 text-sm" value={form.is_controlled ? "yes" : "no"} onChange={(e) => setForm({ ...form, is_controlled: e.target.value === "yes" })}>
              <option value="no">No</option>
              <option value="yes">Yes</option>
            </select>
          </div>
          {!isNew && (
            <div className="space-y-1.5">
              <Label>Status</Label>
              <select className="block w-full rounded-md border bg-background px-2 py-2 text-sm" value={form.is_active ? "active" : "inactive"} onChange={(e) => setForm({ ...form, is_active: e.target.value === "active" })}>
                <option value="active">Active</option>
                <option value="inactive">Inactive</option>
              </select>
            </div>
          )}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>Cancel</Button>
          <Button disabled={!form.name.trim()} loading={mut.isPending} onClick={() => mut.mutate()}>Save</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
