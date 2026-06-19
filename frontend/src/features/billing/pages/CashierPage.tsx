import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { BadgeDollarSign, Check, HandCoins, Inbox } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { toast } from "@/components/ui/sonner";
import { AppError } from "@/lib/api-client";
import { pendingCharges, settleCharge, voidCharge, waiveCharge, waiverReasons, type PendingCharge } from "@/features/billing/api";

const VOID_REASONS = ["Keying error", "Duplicate charge", "Patient left without service", "Wrong patient"];

const METHODS = ["cash", "card", "mobile", "transfer"];

export function CashierPage() {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ["pending-charges"], queryFn: pendingCharges, refetchInterval: 15000 });
  const reasons = useQuery({ queryKey: ["waiver-reasons"], queryFn: waiverReasons });
  const [method, setMethod] = useState("cash");
  const [waiving, setWaiving] = useState<PendingCharge | null>(null);
  const [voiding, setVoiding] = useState<PendingCharge | null>(null);

  const refresh = () => {
    qc.invalidateQueries({ queryKey: ["pending-charges"] });
    qc.invalidateQueries({ queryKey: ["queue"] });
  };
  const settle = useMutation({
    mutationFn: (id: string) => settleCharge(id, method),
    onSuccess: () => { toast.success("Payment recorded"); refresh(); },
    onError: (e) => toast.error(e instanceof AppError ? e.message : "Could not settle"),
  });

  // Group pending charges by patient.
  const groups = useMemo(() => {
    const m = new Map<string, { name: string; mrn: string; items: PendingCharge[]; total: number; currency: string }>();
    for (const c of q.data ?? []) {
      const k = `${c.patient_name}|${c.mrn}`;
      const g = m.get(k) ?? { name: c.patient_name, mrn: c.mrn, items: [], total: 0, currency: c.currency };
      g.items.push(c);
      g.total += parseFloat(c.amount) || 0;
      m.set(k, g);
    }
    return [...m.values()];
  }, [q.data]);

  const count = q.data?.length ?? 0;

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1>Cashier</h1>
          <p className="text-sm text-muted-foreground">Pending payments. Take payment or waive with a reason; settling lets the patient proceed.</p>
        </div>
        <div className="flex items-end gap-2">
          <div className="space-y-1">
            <Label className="text-xs">Payment method</Label>
            <Select value={method} onValueChange={setMethod}>
              <SelectTrigger className="w-36 capitalize"><SelectValue /></SelectTrigger>
              <SelectContent>
                {METHODS.map((m) => <SelectItem key={m} value={m} className="capitalize">{m}</SelectItem>)}
              </SelectContent>
            </Select>
          </div>
        </div>
      </div>

      {count === 0 ? (
        <Card className="flex flex-col items-center justify-center gap-2 p-12 text-center text-sm text-muted-foreground">
          <Inbox className="h-5 w-5" />
          <p className="font-medium text-foreground">No pending payments</p>
          <p>When reception or a clinician raises a charge, it appears here for the patient to pay.</p>
        </Card>
      ) : (
        <div className="space-y-4">
          {groups.map((g) => (
            <Card key={`${g.name}|${g.mrn}`} className="overflow-hidden">
              <div className="flex items-center justify-between gap-3 border-b bg-muted/30 px-4 py-2.5">
                <div>
                  <span className="font-medium text-brand">{g.name}</span>
                  <span className="ml-2 font-mono text-xs text-muted-foreground">{g.mrn}</span>
                </div>
                <span className="text-sm font-semibold">{g.currency} {g.total.toFixed(2)}</span>
              </div>
              <div className="divide-y">
                {g.items.map((c) => (
                  <div key={c.id} className="flex flex-wrap items-center justify-between gap-3 px-4 py-2.5">
                    <div className="min-w-0">
                      <span className="text-sm font-medium">{c.description}</span>
                      <Badge variant="outline" className="ml-2 capitalize">{c.source}</Badge>
                    </div>
                    <div className="flex items-center gap-2">
                      <span className="font-mono text-sm font-semibold">{c.currency} {c.amount}</span>
                      <Button size="sm" variant="ghost" className="text-muted-foreground" onClick={() => setVoiding(c)}>Void</Button>
                      <Button size="sm" variant="outline" onClick={() => setWaiving(c)}>Waive</Button>
                      <Button size="sm" loading={settle.isPending} onClick={() => settle.mutate(c.id)}>
                        <HandCoins className="h-3.5 w-3.5" /> Take payment
                      </Button>
                    </div>
                  </div>
                ))}
              </div>
            </Card>
          ))}
        </div>
      )}

      <WaiveDialog charge={waiving} reasons={reasons.data ?? []} onClose={() => setWaiving(null)} onDone={() => { setWaiving(null); refresh(); }} />
      <VoidDialog charge={voiding} onClose={() => setVoiding(null)} onDone={() => { setVoiding(null); refresh(); }} />
    </div>
  );
}

function VoidDialog({ charge, onClose, onDone }: { charge: PendingCharge | null; onClose: () => void; onDone: () => void }) {
  const [reason, setReason] = useState("");
  const [note, setNote] = useState("");
  const mut = useMutation({
    mutationFn: () => voidCharge(charge!.id, reason === "Other" && note.trim() ? `Other: ${note.trim()}` : reason),
    onSuccess: () => { toast.success("Charge voided"); setReason(""); setNote(""); onDone(); },
    onError: (e) => toast.error(e instanceof AppError ? e.message : "Could not void"),
  });
  return (
    <Dialog open={!!charge} onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader><DialogTitle>Void charge</DialogTitle></DialogHeader>
        <p className="text-sm text-muted-foreground">Cancels an unpaid charge (a mistake, or the patient left). No payment is taken and it leaves the worklist. Unlike a waiver, no service was given.</p>
        {charge && (
          <p className="text-sm"><BadgeDollarSign className="mr-1 inline h-4 w-4" />{charge.description} · {charge.currency} {charge.amount} · {charge.patient_name}</p>
        )}
        <div className="space-y-1.5">
          <Label>Reason (required)</Label>
          <Select value={reason} onValueChange={setReason}>
            <SelectTrigger><SelectValue placeholder="Why void this charge?" /></SelectTrigger>
            <SelectContent>
              {VOID_REASONS.map((r) => <SelectItem key={r} value={r}>{r}</SelectItem>)}
              <SelectItem value="Other">Other</SelectItem>
            </SelectContent>
          </Select>
        </div>
        {reason === "Other" && (
          <div className="space-y-1.5">
            <Label>Note</Label>
            <input className="w-full rounded-md border px-3 py-2 text-sm" value={note} onChange={(e) => setNote(e.target.value)} placeholder="Explain" />
          </div>
        )}
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>Cancel</Button>
          <Button variant="destructive" disabled={!reason} loading={mut.isPending} onClick={() => mut.mutate()}>Void charge</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function WaiveDialog({ charge, reasons, onClose, onDone }: { charge: PendingCharge | null; reasons: string[]; onClose: () => void; onDone: () => void }) {
  const [reason, setReason] = useState("");
  const [note, setNote] = useState("");
  const mut = useMutation({
    mutationFn: () => waiveCharge(charge!.id, reason === "Other" && note.trim() ? `Other: ${note.trim()}` : reason),
    onSuccess: () => { toast.success("Charge waived"); setReason(""); setNote(""); onDone(); },
    onError: (e) => toast.error(e instanceof AppError ? e.message : "Could not waive"),
  });
  return (
    <Dialog open={!!charge} onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader><DialogTitle>Waive charge</DialogTitle></DialogHeader>
        {charge && (
          <p className="text-sm text-muted-foreground">
            <BadgeDollarSign className="mr-1 inline h-4 w-4" />
            {charge.description} · {charge.currency} {charge.amount} · {charge.patient_name}
          </p>
        )}
        <div className="space-y-1.5">
          <Label>Reason (required)</Label>
          <Select value={reason} onValueChange={setReason}>
            <SelectTrigger><SelectValue placeholder="Why is this waived?" /></SelectTrigger>
            <SelectContent>
              {reasons.map((r) => <SelectItem key={r} value={r}>{r}</SelectItem>)}
            </SelectContent>
          </Select>
        </div>
        {reason === "Other" && (
          <div className="space-y-1.5">
            <Label>Note</Label>
            <input className="w-full rounded-md border px-3 py-2 text-sm" value={note} onChange={(e) => setNote(e.target.value)} placeholder="Explain the exemption" />
          </div>
        )}
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>Cancel</Button>
          <Button disabled={!reason} loading={mut.isPending} onClick={() => mut.mutate()}>
            <Check className="h-4 w-4" /> Waive
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
