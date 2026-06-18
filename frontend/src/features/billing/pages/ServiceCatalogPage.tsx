import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Pencil, Plus, Trash2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { toast } from "@/components/ui/sonner";
import { AppError } from "@/lib/api-client";
import { createService, deleteService, listServices, setServiceActive, setServiceDefault, updateService, type ServiceItem } from "@/features/billing/api";

export function ServiceCatalogPage() {
  const qc = useQueryClient();
  const services = useQuery({ queryKey: ["services-all"], queryFn: () => listServices(false) });
  const [editing, setEditing] = useState<ServiceItem | null>(null);
  const [creating, setCreating] = useState(false);
  const refresh = () => qc.invalidateQueries({ queryKey: ["services-all"] });

  const toggle = useMutation({
    mutationFn: (s: ServiceItem) => setServiceActive(s.id, !s.is_active),
    onSuccess: refresh,
    onError: (e) => toast.error(e instanceof AppError ? e.message : "Could not update"),
  });
  const toggleDefault = useMutation({
    mutationFn: (s: ServiceItem) => setServiceDefault(s.id, !s.is_default),
    onSuccess: refresh,
    onError: (e) => toast.error(e instanceof AppError ? e.message : "Could not update"),
  });
  const del = useMutation({
    mutationFn: (id: string) => deleteService(id),
    onSuccess: () => { toast.success("Service removed"); refresh(); },
    onError: (e) => toast.error(e instanceof AppError ? e.message : "Could not delete"),
  });

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1>Service catalog</h1>
          <p className="text-sm text-muted-foreground">What the clinic bills for, and how much. Prices feed the charges patients pay at the cashier. <span className="font-medium text-foreground">Default</span> services are pre-selected at reception (e.g. a registration fee).</p>
        </div>
        <Button onClick={() => setCreating(true)}><Plus className="h-4 w-4" /> New service</Button>
      </div>

      <Card className="overflow-hidden">
        <table className="w-full text-sm">
          <thead className="border-b bg-muted/40 text-left text-xs uppercase tracking-wide text-muted-foreground">
            <tr>
              <th className="p-3 font-medium">Code</th>
              <th className="font-medium">Service</th>
              <th className="font-medium">Category</th>
              <th className="font-medium">Price</th>
              <th className="font-medium">Available</th>
              <th className="font-medium">Default</th>
              <th className="p-3 font-medium"></th>
            </tr>
          </thead>
          <tbody>
            {(services.data ?? []).map((s) => (
              <tr key={s.id} className="group border-b last:border-0">
                <td className="p-3 font-mono text-xs text-muted-foreground">{s.code}</td>
                <td className="font-medium">{s.name}</td>
                <td className="text-muted-foreground capitalize">{s.category}</td>
                <td className="font-mono">{s.currency} {s.price}</td>
                <td>
                  <button
                    onClick={() => toggle.mutate(s)}
                    className={`rounded-full border px-2.5 py-1 text-xs font-medium ${s.is_active ? "border-emerald-200 bg-emerald-50 text-emerald-700" : "border-slate-200 bg-slate-50 text-muted-foreground"}`}
                  >
                    {s.is_active ? "Available" : "Off"}
                  </button>
                </td>
                <td>
                  <button
                    onClick={() => toggleDefault.mutate(s)}
                    className={`rounded-full border px-2.5 py-1 text-xs font-medium ${s.is_default ? "border-primary/30 bg-primary/10 text-primary" : "border-slate-200 bg-slate-50 text-muted-foreground"}`}
                    title={s.is_default ? "Pre-selected at reception — click to unset" : "Not pre-selected — click to make a reception default"}
                  >
                    {s.is_default ? "Default" : "—"}
                  </button>
                </td>
                <td className="p-3">
                  <div className="flex items-center justify-end gap-1 opacity-60 group-hover:opacity-100">
                    <button onClick={() => setEditing(s)} className="rounded p-1.5 text-muted-foreground hover:bg-muted hover:text-foreground" title="Edit"><Pencil className="h-4 w-4" /></button>
                    <button onClick={() => { if (window.confirm(`Remove "${s.name}"?`)) del.mutate(s.id); }} className="rounded p-1.5 text-muted-foreground hover:bg-muted hover:text-destructive" title="Delete"><Trash2 className="h-4 w-4" /></button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {(services.data?.length ?? 0) === 0 && <p className="p-10 text-center text-sm text-muted-foreground">No services yet — add the ones your clinic bills for.</p>}
      </Card>

      <ServiceDialog open={creating} onOpenChange={setCreating} onDone={refresh} />
      <ServiceDialog svc={editing ?? undefined} open={!!editing} onOpenChange={(o) => !o && setEditing(null)} onDone={refresh} />
    </div>
  );
}

function ServiceDialog({ svc, open, onOpenChange, onDone }: { svc?: ServiceItem; open: boolean; onOpenChange: (v: boolean) => void; onDone: () => void }) {
  const editing = !!svc;
  const [form, setForm] = useState({ code: "", name: "", category: "general", price: "" });
  useEffect(() => {
    if (open) setForm(svc ? { code: svc.code, name: svc.name, category: svc.category, price: svc.price } : { code: "", name: "", category: "general", price: "" });
  }, [open, svc]);
  const mut = useMutation({
    mutationFn: async () => {
      const body = { code: form.code, name: form.name, category: form.category, price: parseFloat(form.price) || 0 };
      if (editing && svc) await updateService(svc.id, body); else await createService(body);
    },
    onSuccess: () => { onOpenChange(false); onDone(); },
    onError: (e) => toast.error(e instanceof AppError ? e.message : "Could not save the service"),
  });
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader><DialogTitle>{editing ? "Edit service" : "New service"}</DialogTitle></DialogHeader>
        <div className="grid grid-cols-2 gap-3">
          <div className="space-y-1.5"><Label>Code</Label><Input value={form.code} onChange={(e) => setForm({ ...form, code: e.target.value })} placeholder="CONSULT" /></div>
          <div className="space-y-1.5"><Label>Category</Label><Input value={form.category} onChange={(e) => setForm({ ...form, category: e.target.value })} placeholder="consultation" /></div>
          <div className="col-span-2 space-y-1.5"><Label>Name</Label><Input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="Consultation" /></div>
          <div className="space-y-1.5"><Label>Price (ETB)</Label><Input type="number" min="0" step="0.01" value={form.price} onChange={(e) => setForm({ ...form, price: e.target.value })} placeholder="100" /></div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button disabled={!form.code.trim() || !form.name.trim()} loading={mut.isPending} onClick={() => mut.mutate()}>{editing ? "Save" : "Create"}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
