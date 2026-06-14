import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Plus } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { toast } from "@/components/ui/sonner";
import { useAuth } from "@/app/auth-context";
import { adjustStock, listBatches, listDrugs, quarantineBatch } from "@/features/pharmacy/api";

function statusBadge(s: string) {
  if (s === "expired") return <Badge className="bg-rose-100 text-rose-700">expired</Badge>;
  if (s === "near_expiry") return <Badge className="bg-amber-100 text-amber-800">near expiry</Badge>;
  if (s === "quarantine") return <Badge variant="outline">quarantine</Badge>;
  return <Badge className="bg-emerald-100 text-emerald-700">ok</Badge>;
}

export function BatchesPage() {
  const qc = useQueryClient();
  const { can } = useAuth();
  const manage = can("pharmacy.stock");
  const batches = useQuery({ queryKey: ["batches"], queryFn: listBatches });
  const [open, setOpen] = useState(false);

  const quarantine = useMutation({
    mutationFn: ({ id, q }: { id: string; q: boolean }) => quarantineBatch(id, q),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["batches"] }),
    onError: () => toast.error("Could not update batch"),
  });

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1>Batches &amp; expiry</h1>
          <p className="text-sm text-muted-foreground">Stock by batch</p>
        </div>
        {manage && (
          <Button onClick={() => setOpen(true)}>
            <Plus /> Stock adjust
          </Button>
        )}
      </div>

      <Card className="overflow-hidden">
        <table className="w-full text-sm">
          <thead className="border-b bg-muted/40 text-left text-xs uppercase tracking-wide text-muted-foreground">
            <tr>
              <th className="p-3 font-medium">Drug</th>
              <th className="font-medium">Batch</th>
              <th className="font-medium">Expiry</th>
              <th className="font-medium">On hand</th>
              <th className="font-medium">Status</th>
              <th className="p-3 font-medium"></th>
            </tr>
          </thead>
          <tbody>
            {(batches.data ?? []).map((b) => (
              <tr key={b.id} className="border-b">
                <td className="p-3">{b.drug_name}</td>
                <td className="font-mono text-xs">{b.batch_no}</td>
                <td>{b.expiry_date?.slice(0, 7) ?? "—"}</td>
                <td>{b.qty_on_hand}</td>
                <td>{statusBadge(b.status)}</td>
                <td className="p-3 text-right">
                  {manage && (
                    <button
                      className="text-xs text-muted-foreground hover:text-foreground"
                      onClick={() => quarantine.mutate({ id: b.id, q: !b.quarantined })}
                    >
                      {b.quarantined ? "Release" : "Quarantine"}
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {(batches.data?.length ?? 0) === 0 && <p className="p-8 text-center text-sm text-muted-foreground">No stock batches yet.</p>}
      </Card>

      {open && <StockAdjustDialog onClose={() => setOpen(false)} onDone={() => qc.invalidateQueries({ queryKey: ["batches"] })} />}
    </div>
  );
}

function StockAdjustDialog({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const drugs = useQuery({ queryKey: ["drugs"], queryFn: () => listDrugs() });
  const batches = useQuery({ queryKey: ["batches"], queryFn: listBatches });
  const [drugId, setDrugId] = useState("");
  const [mode, setMode] = useState<"existing" | "new">("existing");
  const [batchId, setBatchId] = useState("");
  const [batchNo, setBatchNo] = useState("");
  const [expiry, setExpiry] = useState("");
  const [delta, setDelta] = useState(0);
  const [note, setNote] = useState("");

  const drugBatches = useMemo(() => (batches.data ?? []).filter((b) => b.drug_id === drugId), [batches.data, drugId]);

  const mut = useMutation({
    mutationFn: () =>
      adjustStock({
        drug_id: drugId,
        batch_id: mode === "existing" ? batchId : undefined,
        batch_no: mode === "new" ? batchNo : undefined,
        expiry: mode === "new" && expiry ? expiry : undefined,
        delta,
        reason: "adjust",
        note,
      }),
    onSuccess: () => {
      toast.success("Stock adjusted");
      onDone();
      onClose();
    },
    onError: () => toast.error("Could not adjust stock"),
  });

  const valid = drugId && delta !== 0 && (mode === "existing" ? batchId : batchNo);

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Stock adjust</DialogTitle>
        </DialogHeader>
        <div className="space-y-3">
          <div className="space-y-1.5">
            <Label>Drug</Label>
            <select className="block w-full rounded-md border bg-background px-2 py-2 text-sm" value={drugId} onChange={(e) => { setDrugId(e.target.value); setBatchId(""); }}>
              <option value="">Select…</option>
              {(drugs.data ?? []).map((d) => (
                <option key={d.id} value={d.id}>{d.name}</option>
              ))}
            </select>
          </div>
          <div className="flex gap-2 text-sm">
            <button className={`rounded-md border px-3 py-1.5 ${mode === "existing" ? "border-primary text-primary" : ""}`} onClick={() => setMode("existing")}>Adjust a batch</button>
            <button className={`rounded-md border px-3 py-1.5 ${mode === "new" ? "border-primary text-primary" : ""}`} onClick={() => setMode("new")}>New batch</button>
          </div>
          {mode === "existing" ? (
            <div className="space-y-1.5">
              <Label>Batch</Label>
              <select className="block w-full rounded-md border bg-background px-2 py-2 text-sm" value={batchId} onChange={(e) => setBatchId(e.target.value)} disabled={!drugId}>
                <option value="">Select…</option>
                {drugBatches.map((b) => (
                  <option key={b.id} value={b.id}>{b.batch_no} · {b.qty_on_hand} on hand</option>
                ))}
              </select>
            </div>
          ) : (
            <div className="flex gap-2">
              <div className="flex-1 space-y-1.5">
                <Label>Batch no.</Label>
                <Input value={batchNo} onChange={(e) => setBatchNo(e.target.value)} placeholder="AZ-2026-04" />
              </div>
              <div className="space-y-1.5">
                <Label>Expiry</Label>
                <Input type="date" value={expiry} onChange={(e) => setExpiry(e.target.value)} />
              </div>
            </div>
          )}
          <div className="space-y-1.5">
            <Label>{mode === "new" ? "Initial quantity" : "Change (+/−)"}</Label>
            <Input type="number" value={delta} onChange={(e) => setDelta(Number(e.target.value))} />
          </div>
          <div className="space-y-1.5">
            <Label>Note</Label>
            <Input value={note} onChange={(e) => setNote(e.target.value)} placeholder="reason / reference" />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>Cancel</Button>
          <Button disabled={!valid} loading={mut.isPending} onClick={() => mut.mutate()}>Apply</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
