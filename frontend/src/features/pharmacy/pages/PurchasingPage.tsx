import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Plus, Trash2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { toast } from "@/components/ui/sonner";
import { createPO, createSupplier, getPO, listPOs, listSuppliers, receivePO, searchDrugs, setPOStatus, type Drug } from "@/features/pharmacy/api";

function statusBadge(s: string) {
  if (s === "received") return <Badge className="bg-emerald-100 text-emerald-700">received</Badge>;
  if (s === "ordered") return <Badge className="bg-amber-100 text-amber-800">awaiting receipt</Badge>;
  if (s === "cancelled") return <Badge variant="outline">cancelled</Badge>;
  return <Badge variant="outline">draft</Badge>;
}

export function PurchasingPage() {
  const qc = useQueryClient();
  const pos = useQuery({ queryKey: ["pos"], queryFn: listPOs });
  const [newPO, setNewPO] = useState(false);
  const [suppliers, setSuppliers] = useState(false);
  const [receiving, setReceiving] = useState<string | null>(null);

  const refresh = () => {
    qc.invalidateQueries({ queryKey: ["pos"] });
    qc.invalidateQueries({ queryKey: ["batches"] });
    qc.invalidateQueries({ queryKey: ["pharmacy-dashboard"] });
  };
  const status = useMutation({
    mutationFn: ({ id, s }: { id: string; s: string }) => setPOStatus(id, s),
    onSuccess: refresh,
    onError: () => toast.error("Could not update PO"),
  });

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1>Purchasing</h1>
          <p className="text-sm text-muted-foreground">Replenish stock</p>
        </div>
        <div className="flex gap-2">
          <Button variant="outline" onClick={() => setSuppliers(true)}>Suppliers</Button>
          <Button onClick={() => setNewPO(true)}><Plus /> New PO</Button>
        </div>
      </div>

      <Card className="overflow-hidden">
        <table className="w-full text-sm">
          <thead className="border-b bg-muted/40 text-left text-xs uppercase tracking-wide text-muted-foreground">
            <tr>
              <th className="p-3 font-medium">PO</th>
              <th className="font-medium">Supplier</th>
              <th className="font-medium">Items</th>
              <th className="font-medium">Value</th>
              <th className="font-medium">Status</th>
              <th className="p-3 font-medium"></th>
            </tr>
          </thead>
          <tbody>
            {(pos.data ?? []).map((p) => (
              <tr key={p.id} className="border-b">
                <td className="p-3 font-mono text-xs">PO-{p.po_no}</td>
                <td>{p.supplier}</td>
                <td>{p.item_count}</td>
                <td className="font-medium">{p.total}</td>
                <td>{statusBadge(p.status)}</td>
                <td className="p-3 text-right">
                  <div className="flex justify-end gap-3">
                    {p.status === "draft" && (
                      <button className="text-xs text-primary hover:underline" onClick={() => status.mutate({ id: p.id, s: "ordered" })}>Mark ordered</button>
                    )}
                    {(p.status === "draft" || p.status === "ordered") && (
                      <button className="text-xs text-primary hover:underline" onClick={() => setReceiving(p.id)}>Receive</button>
                    )}
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {(pos.data?.length ?? 0) === 0 && <p className="p-8 text-center text-sm text-muted-foreground">No purchase orders yet.</p>}
      </Card>

      {newPO && <NewPODialog onClose={() => setNewPO(false)} onDone={refresh} />}
      {suppliers && <SuppliersDialog onClose={() => setSuppliers(false)} />}
      {receiving && <ReceiveDialog poId={receiving} onClose={() => setReceiving(null)} onDone={refresh} />}
    </div>
  );
}

function SuppliersDialog({ onClose }: { onClose: () => void }) {
  const qc = useQueryClient();
  const list = useQuery({ queryKey: ["suppliers"], queryFn: listSuppliers });
  const [name, setName] = useState("");
  const [contact, setContact] = useState("");
  const [lead, setLead] = useState(0);
  const add = useMutation({
    mutationFn: () => createSupplier({ name, contact, lead_time_days: lead }),
    onSuccess: () => {
      toast.success("Supplier added");
      setName("");
      setContact("");
      setLead(0);
      qc.invalidateQueries({ queryKey: ["suppliers"] });
    },
    onError: () => toast.error("Could not add (name may exist)"),
  });
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader><DialogTitle>Suppliers</DialogTitle></DialogHeader>
        <ul className="max-h-48 space-y-1.5 overflow-auto">
          {(list.data ?? []).map((s) => (
            <li key={s.id} className="rounded-md border p-2 text-sm">
              <span className="font-medium">{s.name}</span>
              {s.contact ? <span className="text-muted-foreground"> · {s.contact}</span> : null}
              <span className="text-xs text-muted-foreground"> · {s.lead_time_days}d lead</span>
            </li>
          ))}
          {(list.data?.length ?? 0) === 0 && <p className="text-sm text-muted-foreground">No suppliers yet.</p>}
        </ul>
        <div className="flex items-end gap-2 border-t pt-3">
          <div className="flex-1 space-y-1.5"><Label>Name</Label><Input value={name} onChange={(e) => setName(e.target.value)} /></div>
          <div className="space-y-1.5"><Label>Contact</Label><Input value={contact} onChange={(e) => setContact(e.target.value)} /></div>
          <div className="w-20 space-y-1.5"><Label>Lead d</Label><Input type="number" value={lead} onChange={(e) => setLead(Number(e.target.value))} /></div>
          <Button disabled={!name.trim()} loading={add.isPending} onClick={() => add.mutate()}>Add</Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

interface POLine { drug: Drug; qty: number; cost: number }

function NewPODialog({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const suppliers = useQuery({ queryKey: ["suppliers"], queryFn: listSuppliers });
  const [supplierId, setSupplierId] = useState("");
  const [expected, setExpected] = useState("");
  const [term, setTerm] = useState("");
  const [lines, setLines] = useState<POLine[]>([]);
  const results = useQuery({ queryKey: ["po-drug-search", term], queryFn: () => searchDrugs(term), enabled: term.trim().length > 0 });

  const addDrug = (d: Drug) => {
    setLines((ls) => (ls.find((l) => l.drug.id === d.id) ? ls : [...ls, { drug: d, qty: 1, cost: Number(d.unit_price) || 0 }]));
    setTerm("");
  };
  const total = lines.reduce((s, l) => s + l.cost * l.qty, 0);

  const create = useMutation({
    mutationFn: () =>
      createPO({
        supplier_id: supplierId,
        expected_date: expected || undefined,
        lines: lines.map((l) => ({ drug_id: l.drug.id, qty: l.qty, unit_cost: l.cost })),
      }),
    onSuccess: () => {
      toast.success("Purchase order created (draft)");
      onDone();
      onClose();
    },
    onError: () => toast.error("Could not create PO"),
  });

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-2xl">
        <DialogHeader><DialogTitle>New purchase order</DialogTitle></DialogHeader>
        <div className="flex gap-3">
          <div className="flex-1 space-y-1.5">
            <Label>Supplier</Label>
            <select className="block w-full rounded-md border bg-background px-2 py-2 text-sm" value={supplierId} onChange={(e) => setSupplierId(e.target.value)}>
              <option value="">Select…</option>
              {(suppliers.data ?? []).map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
            </select>
          </div>
          <div className="space-y-1.5"><Label>Expected</Label><Input type="date" value={expected} onChange={(e) => setExpected(e.target.value)} /></div>
        </div>
        <div className="relative">
          <Label>Add drug</Label>
          <Input placeholder="Search drugs…" value={term} onChange={(e) => setTerm(e.target.value)} />
          {term.trim() && (results.data?.length ?? 0) > 0 && (
            <div className="absolute z-10 mt-1 max-h-48 w-full overflow-auto rounded-md border bg-background shadow-md">
              {(results.data ?? []).map((d) => (
                <button key={d.id} onClick={() => addDrug(d)} className="block w-full px-3 py-2 text-left text-sm hover:bg-muted">{d.name}</button>
              ))}
            </div>
          )}
        </div>
        <div className="divide-y rounded-md border">
          {lines.length === 0 ? <p className="p-3 text-sm text-muted-foreground">No lines.</p> : lines.map((l) => (
            <div key={l.drug.id} className="flex items-center gap-2 p-2 text-sm">
              <span className="min-w-0 flex-1">{l.drug.name}</span>
              <span className="text-xs text-muted-foreground">qty</span>
              <Input type="number" min={1} className="w-16" value={l.qty} onChange={(e) => setLines((ls) => ls.map((x) => x.drug.id === l.drug.id ? { ...x, qty: Math.max(1, Number(e.target.value)) } : x))} />
              <span className="text-xs text-muted-foreground">cost</span>
              <Input type="number" className="w-20" value={l.cost} onChange={(e) => setLines((ls) => ls.map((x) => x.drug.id === l.drug.id ? { ...x, cost: Number(e.target.value) } : x))} />
              <button onClick={() => setLines((ls) => ls.filter((x) => x.drug.id !== l.drug.id))} className="text-muted-foreground hover:text-destructive"><Trash2 className="h-4 w-4" /></button>
            </div>
          ))}
        </div>
        <DialogFooter>
          <span className="mr-auto self-center text-sm font-medium">Total: {total.toFixed(2)}</span>
          <Button variant="outline" onClick={onClose}>Cancel</Button>
          <Button disabled={!supplierId || lines.length === 0} loading={create.isPending} onClick={() => create.mutate()}>Create PO</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function ReceiveDialog({ poId, onClose, onDone }: { poId: string; onClose: () => void; onDone: () => void }) {
  const po = useQuery({ queryKey: ["po", poId], queryFn: () => getPO(poId) });
  const [rows, setRows] = useState<Record<string, { batch_no: string; expiry: string }>>({});

  const recv = useMutation({
    mutationFn: () =>
      receivePO(poId, (po.data?.items ?? []).map((it) => ({ po_item_id: it.id, batch_no: rows[it.id]?.batch_no || undefined, expiry: rows[it.id]?.expiry || undefined }))),
    onSuccess: () => {
      toast.success("Received — stock added");
      onDone();
      onClose();
    },
    onError: () => toast.error("Could not receive"),
  });

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-2xl">
        <DialogHeader><DialogTitle>Receive PO-{po.data?.po_no}</DialogTitle></DialogHeader>
        <p className="text-xs text-muted-foreground">Enter the batch and expiry for each line; receiving adds stock.</p>
        <div className="max-h-[50vh] divide-y overflow-auto rounded-md border">
          {(po.data?.items ?? []).map((it) => (
            <div key={it.id} className="flex items-center gap-2 p-2 text-sm">
              <span className="min-w-0 flex-1">{it.drug_name} <span className="text-xs text-muted-foreground">×{it.qty}</span></span>
              <Input placeholder="Batch no." className="w-32" value={rows[it.id]?.batch_no ?? ""} onChange={(e) => setRows((r) => ({ ...r, [it.id]: { ...r[it.id], batch_no: e.target.value } }))} />
              <Input type="date" className="w-40" value={rows[it.id]?.expiry ?? ""} onChange={(e) => setRows((r) => ({ ...r, [it.id]: { ...r[it.id], expiry: e.target.value } }))} />
            </div>
          ))}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>Cancel</Button>
          <Button loading={recv.isPending} disabled={(po.data?.items?.length ?? 0) === 0} onClick={() => recv.mutate()}>Receive &amp; add stock</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
