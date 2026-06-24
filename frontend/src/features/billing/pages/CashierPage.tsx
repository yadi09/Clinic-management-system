import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { BadgeDollarSign, Check, HandCoins, Inbox, MoreVertical } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { toast } from "@/components/ui/sonner";
import { AppError } from "@/lib/api-client";
import { useAuth } from "@/app/auth-context";
import { getClinic } from "@/features/admin/api";
import { closeDay, dayClose, paymentsToday, pendingCharges, refundVisit, settleVisit, voidCharge, waiveCharge, waiverReasons, type PaidVisit, type PendingCharge } from "@/features/billing/api";
import { printVisitReceipt, printZReport } from "@/features/billing/print";
import { Input } from "@/components/ui/input";
import { Printer, RotateCcw } from "lucide-react";

const VOID_REASONS = ["Keying error", "Duplicate charge", "Patient left without service", "Wrong patient"];
const METHODS = ["cash", "card", "mobile", "transfer"];

interface Group {
  patientId: string;
  name: string;
  mrn: string;
  items: PendingCharge[];
  total: number;
  currency: string;
}

export function CashierPage() {
  const qc = useQueryClient();
  const { user, can } = useAuth();
  const [tab, setTab] = useState<"pending" | "paid">("pending");
  const q = useQuery({ queryKey: ["pending-charges"], queryFn: pendingCharges, refetchInterval: 15000 });
  const paid = useQuery({ queryKey: ["payments-today"], queryFn: () => paymentsToday(), enabled: tab === "paid" });
  const reasons = useQuery({ queryKey: ["waiver-reasons"], queryFn: waiverReasons });
  const clinic = useQuery({ queryKey: ["clinic"], queryFn: getClinic, retry: false });
  const [waiving, setWaiving] = useState<PendingCharge | null>(null);
  const [voiding, setVoiding] = useState<PendingCharge | null>(null);
  const [closing, setClosing] = useState(false);
  const [refunding, setRefunding] = useState<PaidVisit | null>(null);

  const refresh = () => {
    qc.invalidateQueries({ queryKey: ["pending-charges"] });
    qc.invalidateQueries({ queryKey: ["payments-today"] });
    qc.invalidateQueries({ queryKey: ["queue"] });
  };

  // Group pending charges by patient (one checkout per patient).
  const groups = useMemo(() => {
    const m = new Map<string, Group>();
    for (const c of q.data ?? []) {
      const g = m.get(c.patient_id) ?? { patientId: c.patient_id, name: c.patient_name, mrn: c.mrn, items: [], total: 0, currency: c.currency };
      g.items.push(c);
      g.total += parseFloat(c.amount) || 0;
      m.set(c.patient_id, g);
    }
    return [...m.values()];
  }, [q.data]);

  const clinicName = clinic.data?.name || "Clinic";
  const cashierName = user?.full_name || "Cashier";

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1>Cashier</h1>
          <p className="text-sm text-muted-foreground">Pending checkouts, and a record of today's payments to reprint or refund.</p>
        </div>
        {tab === "paid" && <Button variant="outline" onClick={() => setClosing(true)}>Close day</Button>}
      </div>

      <div className="inline-flex rounded-lg border p-0.5">
        <button onClick={() => setTab("pending")} className={`rounded-md px-4 py-1.5 text-sm font-medium ${tab === "pending" ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:text-foreground"}`}>
          Pending {groups.length > 0 && <span className="ml-1 rounded-full bg-background/20 px-1.5 text-xs">{groups.length}</span>}
        </button>
        <button onClick={() => setTab("paid")} className={`rounded-md px-4 py-1.5 text-sm font-medium ${tab === "paid" ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:text-foreground"}`}>
          Paid today
        </button>
      </div>

      {tab === "pending" ? (
        groups.length === 0 ? (
          <Card className="flex flex-col items-center justify-center gap-2 p-12 text-center text-sm text-muted-foreground">
            <Inbox className="h-5 w-5" />
            <p className="font-medium text-foreground">No pending payments</p>
            <p>When reception or a clinician raises a charge, it appears here for the patient to pay.</p>
          </Card>
        ) : (
          <div className="grid gap-4 lg:grid-cols-2">
            {groups.map((g) => (
              <PatientCheckout key={g.patientId} group={g} onWaive={setWaiving} onVoid={setVoiding} onPaid={() => { refresh(); setTab("paid"); }} />
            ))}
          </div>
        )
      ) : (
        <PaidList
          payments={paid.data ?? []}
          loading={paid.isLoading}
          canRefund={can("billing.manage")}
          clinicName={clinicName}
          cashierName={cashierName}
          onRefund={setRefunding}
        />
      )}

      <WaiveDialog charge={waiving} reasons={reasons.data ?? []} onClose={() => setWaiving(null)} onDone={() => { setWaiving(null); refresh(); }} />
      <VoidDialog charge={voiding} onClose={() => setVoiding(null)} onDone={() => { setVoiding(null); refresh(); }} />
      <DayCloseDialog open={closing} onClose={() => setClosing(false)} />
      <RefundVisitDialog visit={refunding} onClose={() => setRefunding(null)} onDone={() => { setRefunding(null); refresh(); }} />
    </div>
  );
}

function PaidList({ payments, loading, canRefund, clinicName, cashierName, onRefund }: {
  payments: PaidVisit[];
  loading: boolean;
  canRefund: boolean;
  clinicName: string;
  cashierName: string;
  onRefund: (v: PaidVisit) => void;
}) {
  const print = (v: PaidVisit) =>
    printVisitReceipt({
      clinic: clinicName, receiptNo: v.receipt_no, patient: v.patient_name, mrn: v.mrn,
      lines: v.lines, total: v.total, currency: v.currency, method: v.method, cashier: cashierName,
      when: v.settled_at || new Date().toISOString(),
    });
  if (loading) return <Card className="p-8 text-center text-sm text-muted-foreground">Loading…</Card>;
  if (payments.length === 0) return <Card className="p-12 text-center text-sm text-muted-foreground">No payments collected today yet.</Card>;
  return (
    <div className="space-y-3">
      {payments.map((v) => (
        <Card key={v.receipt_no} className="flex flex-wrap items-center justify-between gap-3 p-4">
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <span className="font-mono text-xs text-muted-foreground">RCP-{String(v.receipt_no).padStart(6, "0")}</span>
              <span className="font-medium text-brand">{v.patient_name}</span>
              <span className="font-mono text-xs text-muted-foreground">{v.mrn}</span>
              {v.refunded && <Badge variant="destructive">refunded</Badge>}
            </div>
            <div className="mt-0.5 text-xs text-muted-foreground">
              {v.lines.map((l) => l.description).join(" · ")} · {v.method || "—"}
              {v.settled_at ? ` · ${new Date(v.settled_at).toLocaleTimeString()}` : ""}
            </div>
          </div>
          <div className="flex items-center gap-2">
            <span className={`font-mono text-sm font-semibold ${v.refunded ? "text-muted-foreground line-through" : ""}`}>{v.currency} {v.total}</span>
            <Button size="sm" variant="outline" onClick={() => print(v)}><Printer className="h-3.5 w-3.5" /> Print</Button>
            {canRefund && !v.refunded && (
              <Button size="sm" variant="ghost" className="text-rose-600" onClick={() => onRefund(v)}><RotateCcw className="h-3.5 w-3.5" /> Refund</Button>
            )}
          </div>
        </Card>
      ))}
    </div>
  );
}

function RefundVisitDialog({ visit, onClose, onDone }: { visit: PaidVisit | null; onClose: () => void; onDone: () => void }) {
  const [reason, setReason] = useState("");
  const mut = useMutation({
    mutationFn: () => refundVisit(visit!.receipt_no, reason === "Other" ? "Other" : reason),
    onSuccess: () => { toast.success("Payment refunded"); setReason(""); onDone(); },
    onError: (e) => toast.error(e instanceof AppError ? e.message : "Could not refund"),
  });
  const REASONS = ["Service not provided", "Overcharged", "Duplicate payment", "Patient cancelled", "Billing error"];
  return (
    <Dialog open={!!visit} onOpenChange={(o) => { if (!o) { setReason(""); onClose(); } }}>
      <DialogContent>
        <DialogHeader><DialogTitle>Refund payment</DialogTitle></DialogHeader>
        <p className="text-sm text-muted-foreground">Refunds the whole receipt — each line gets a reversing entry dated now. The original payment stays on record; Finance nets it out.</p>
        {visit && <p className="text-sm">RCP-{String(visit.receipt_no).padStart(6, "0")} · {visit.patient_name} · {visit.currency} {visit.total}</p>}
        <div className="space-y-1.5">
          <Label>Reason (required)</Label>
          <Select value={reason} onValueChange={setReason}>
            <SelectTrigger><SelectValue placeholder="Why refund?" /></SelectTrigger>
            <SelectContent>{REASONS.map((r) => <SelectItem key={r} value={r}>{r}</SelectItem>)}</SelectContent>
          </Select>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => { setReason(""); onClose(); }}>Cancel</Button>
          <Button variant="destructive" disabled={!reason} loading={mut.isPending} onClick={() => mut.mutate()}>Refund</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function PatientCheckout({ group, onWaive, onVoid, onPaid }: {
  group: Group;
  onWaive: (c: PendingCharge) => void;
  onVoid: (c: PendingCharge) => void;
  onPaid: () => void;
}) {
  const [method, setMethod] = useState("cash");
  const checkout = useMutation({
    mutationFn: () => settleVisit(group.patientId, method),
    onSuccess: (r) => {
      toast.success(`Paid ${group.currency} ${r.total} · receipt RCP-${String(r.receipt_no).padStart(6, "0")} — print it from "Paid today".`);
      onPaid();
    },
    onError: (e) => toast.error(e instanceof AppError ? e.message : "Could not take payment"),
  });

  return (
    <Card className="flex flex-col overflow-hidden">
      <div className="flex items-center justify-between gap-3 border-b bg-muted/30 px-4 py-2.5">
        <div className="min-w-0">
          <span className="font-medium text-brand">{group.name}</span>
          <span className="ml-2 font-mono text-xs text-muted-foreground">{group.mrn}</span>
        </div>
        <span className="text-base font-semibold">{group.currency} {group.total.toFixed(2)}</span>
      </div>

      <div className="flex-1 divide-y">
        {group.items.map((c) => (
          <div key={c.id} className="group flex items-center justify-between gap-2 px-4 py-2.5 text-sm">
            <span className="min-w-0 truncate">
              {c.description}
              <Badge variant="outline" className="ml-2 align-middle text-[10px] capitalize">{c.source}</Badge>
            </span>
            <div className="flex items-center gap-1">
              <span className="font-mono">{c.currency} {c.amount}</span>
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <button className="rounded p-1 text-muted-foreground opacity-0 transition-opacity hover:bg-accent group-hover:opacity-100" aria-label="Line actions">
                    <MoreVertical className="h-4 w-4" />
                  </button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                  <DropdownMenuItem onSelect={() => onWaive(c)}>Waive…</DropdownMenuItem>
                  <DropdownMenuItem onSelect={() => onVoid(c)} className="text-destructive">Void…</DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            </div>
          </div>
        ))}
      </div>

      <div className="flex items-center gap-2 border-t bg-muted/10 px-4 py-3">
        <Select value={method} onValueChange={setMethod}>
          <SelectTrigger className="w-32 capitalize"><SelectValue /></SelectTrigger>
          <SelectContent>
            {METHODS.map((m) => <SelectItem key={m} value={m} className="capitalize">{m}</SelectItem>)}
          </SelectContent>
        </Select>
        <Button className="flex-1" loading={checkout.isPending} onClick={() => checkout.mutate()}>
          <HandCoins className="h-4 w-4" /> Take payment · {group.currency} {group.total.toFixed(2)}
        </Button>
      </div>
    </Card>
  );
}

function DayCloseDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { user } = useAuth();
  const exp = useQuery({ queryKey: ["day-close"], queryFn: () => dayClose(), enabled: open });
  const clinic = useQuery({ queryKey: ["clinic"], queryFn: getClinic, retry: false, enabled: open });
  const [counted, setCounted] = useState("");
  const cashierName = user?.full_name || "Cashier";
  const e = exp.data;
  const mut = useMutation({
    mutationFn: () => closeDay({ business_date: e?.business_date, counted: Number(counted) || 0, note: "" }),
    onSuccess: (rec) => {
      toast.success(`Day closed — variance ETB ${rec.variance}`);
      printZReport({
        clinic: clinic.data?.name || "Clinic", cashier: cashierName, businessDate: rec.business_date,
        byMethod: e?.by_method ?? [], expected: rec.expected_total, counted: rec.counted_total, variance: rec.variance, note: rec.note,
      });
      onClose();
    },
    onError: (err) => toast.error(err instanceof AppError ? err.message : "Could not close the day"),
  });
  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader><DialogTitle>Close day — {e?.business_date ?? "today"}</DialogTitle></DialogHeader>
        {e?.closed && <p className="rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-800">Already closed once today — saving again updates the closeout.</p>}
        <div>
          <p className="mb-1 text-xs font-medium uppercase tracking-wide text-muted-foreground">Expected (what you collected)</p>
          <div className="rounded-md border divide-y text-sm">
            {(e?.by_method ?? []).map((m) => (
              <div key={m.label} className="flex justify-between px-3 py-1.5"><span className="capitalize">{m.label} ({m.count})</span><span className="font-mono">ETB {m.total}</span></div>
            ))}
            <div className="flex justify-between px-3 py-1.5 font-semibold"><span>Expected total</span><span className="font-mono">ETB {e?.expected_total ?? "0"}</span></div>
          </div>
        </div>
        <div className="space-y-1.5">
          <Label>Counted cash in drawer (ETB)</Label>
          <Input type="number" min="0" step="0.01" value={counted} onChange={(ev) => setCounted(ev.target.value)} placeholder="0.00" />
          {counted !== "" && e && (
            <p className={`text-xs ${Number(counted) - Number(e.expected_total) === 0 ? "text-emerald-600" : "text-rose-600"}`}>
              Variance: ETB {(Number(counted) - Number(e.expected_total)).toFixed(2)}
            </p>
          )}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>Cancel</Button>
          <Button disabled={counted === ""} loading={mut.isPending} onClick={() => mut.mutate()}>Close &amp; print Z-report</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
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
