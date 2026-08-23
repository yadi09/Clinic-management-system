import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, BadgeDollarSign, CalendarCheck, Check, ChevronDown, HandCoins, Inbox, Lock, MoreVertical } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Label } from "@/components/ui/label";
import { Segmented } from "@/components/ui/segmented";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { toast } from "@/components/ui/sonner";
import { AppError } from "@/lib/api-client";
import { useAuth } from "@/app/auth-context";
import { getClinic } from "@/features/admin/api";
import { closeDay, dayClose, dayCloses, paymentsToday, pendingCharges, refundVisit, settleVisit, voidCharge, waiveCharge, waiverReasons, type DaySummary, type PaidVisit, type PendingCharge } from "@/features/billing/api";
import { DateRangeFilter, windowFor, type DateWindow } from "@/components/ui/date-range-filter";
import { EMPTY_PAYMENT, PaymentRailPicker, paymentIncomplete, usePaymentRails, type PaymentChoice } from "@/features/billing/PaymentRail";
import { printVisitReceipt, printZReport } from "@/features/billing/print";
import { Input } from "@/components/ui/input";
import { formatEthiopian } from "@/lib/ethiopian";
import { cn } from "@/lib/utils";
import { Printer, Receipt, RotateCcw } from "lucide-react";

const VOID_REASONS = ["Keying error", "Duplicate charge", "Patient left without service", "Wrong patient"];

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
  const [tab, setTab] = useState<"pending" | "paid" | "days">("pending");
  const [paidWin, setPaidWin] = useState<DateWindow>(() => windowFor("today"));
  const q = useQuery({ queryKey: ["pending-charges"], queryFn: pendingCharges, refetchInterval: 15000 });
  const paid = useQuery({ queryKey: ["payments-today", paidWin.from, paidWin.to], queryFn: () => paymentsToday(paidWin.from, paidWin.to), enabled: tab === "paid" });
  const days = useQuery({ queryKey: ["day-closes"], queryFn: () => dayCloses(), enabled: tab === "days" });
  const reasons = useQuery({ queryKey: ["waiver-reasons"], queryFn: waiverReasons });
  const clinic = useQuery({ queryKey: ["clinic"], queryFn: getClinic, retry: false });
  const [waiving, setWaiving] = useState<PendingCharge | null>(null);
  const [voiding, setVoiding] = useState<PendingCharge | null>(null);
  const [closingDate, setClosingDate] = useState<string | null>(null);
  const [refunding, setRefunding] = useState<PaidVisit | null>(null);

  const refresh = () => {
    qc.invalidateQueries({ queryKey: ["pending-charges"] });
    qc.invalidateQueries({ queryKey: ["payments-today"] });
    qc.invalidateQueries({ queryKey: ["queue"] });
  };
  const refreshDays = () => {
    qc.invalidateQueries({ queryKey: ["day-closes"] });
    qc.invalidateQueries({ queryKey: ["day-close"] });
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
  const openDays = (days.data ?? []).filter((d) => !d.closed && d.business_date < todayISO()).length;

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1>Cashier</h1>
          <p className="text-sm text-muted-foreground">
            {tab === "pending"
              ? "All pending checkouts waiting to be collected — regardless of when they were raised."
              : tab === "paid"
                ? "A record of settled payments to reprint or refund."
                : "Close off each day's drawer. A day you forgot to close stays here until you do."}
          </p>
        </div>
        {tab === "paid" && <DateRangeFilter onChange={setPaidWin} />}
      </div>

      {/* Segmented instead of the hand-rolled strip: real tablist (arrow keys, aria-selected)
          and it scrolls in place at phone widths instead of the third tab clipping. */}
      <Segmented
        value={tab}
        onChange={setTab}
        ariaLabel="Cashier views"
        options={[
          { value: "pending", label: "Pending", badge: groups.length > 0 ? groups.length : undefined },
          { value: "paid", label: "Paid" },
          // The unclosed-days count keeps its amber pill — it is a warning, not a tally.
          { value: "days", label: "Day close", badge: openDays > 0 ? <span className="rounded-full bg-amber-500 px-1.5 text-xs text-white">{openDays}</span> : undefined },
        ]}
      />

      {tab === "days" ? (
        <DayCloseList q={days} clinicName={clinicName} cashierName={cashierName} onClose={setClosingDate} />
      ) : tab === "pending" ? (
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
      <DayCloseDialog date={closingDate} onClose={() => setClosingDate(null)} onDone={refreshDays} />
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
      // The cashier recorded on the payment, not whoever is at the terminal now:
      // one receipt number must always print one name.
      lines: v.lines, total: v.total, currency: v.currency,
      method: v.method_label || v.method, reference: v.reference, cashier: v.settled_by || cashierName,
      when: v.settled_at || new Date().toISOString(),
    });
  if (loading) return <Card className="p-8 text-center text-sm text-muted-foreground">Loading…</Card>;
  if (payments.length === 0) return <Card className="p-12 text-center text-sm text-muted-foreground">No payments in this range.</Card>;
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
              {v.lines.map((l) => l.description).join(" · ")} · {v.method_label || v.method || "—"}
              {v.settled_at ? ` · ${new Date(v.settled_at).toLocaleTimeString()}` : ""}
            </div>
            {/* The reference is the whole point of having asked for it: it is what a
                patient disputing this payment, or a clerk reconciling the day, needs
                to find the transfer. It was recorded and then shown nowhere. */}
            {v.reference && (
              <div className="mt-0.5 flex items-center gap-1 text-xs">
                <Receipt className="h-3 w-3 text-muted-foreground" />
                <span className="font-mono">{v.reference}</span>
              </div>
            )}
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
  const rails = usePaymentRails();
  const [pay, setPay] = useState<PaymentChoice>(EMPTY_PAYMENT);
  // Default to the clinic's first configured method rather than assuming cash — for a
  // clinic paid mostly by Telebirr, "cash" is the wrong thing to leave pre-selected
  // under a big green button.
  useEffect(() => {
    const first = rails.data?.[0];
    if (first && !pay.railId) setPay({ railId: first.id, method: first.key, reference: "" });
  }, [rails.data, pay.railId]);
  const incomplete = paymentIncomplete(rails.data, pay);
  const checkout = useMutation({
    mutationFn: () => settleVisit(group.patientId, { rail_id: pay.railId || undefined, method: pay.method, reference: pay.reference }),
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
        <span className="whitespace-nowrap text-base font-semibold tabular-nums">{group.currency} {group.total.toFixed(2)}</span>
      </div>

      <div className="flex-1 divide-y">
        {group.items.map((c) => (
          <div key={c.id} className="group flex items-center justify-between gap-2 px-4 py-2.5 text-sm">
            {/* Phones: descriptions carry the identifying tail ("… / Bed-12"), so let
                them wrap to two lines instead of truncating it away, keep the amount
                on one line, and give the source badge its own row — inline it rode
                inside the truncated span and vanished first. Desktop keeps the
                single-line row with the inline badge. */}
            <div className="min-w-0">
              <span className="max-md:line-clamp-2 md:block md:truncate">
                {c.description}
                <Badge variant="outline" className="ml-2 align-middle text-[10px] capitalize max-md:hidden">{c.source}</Badge>
              </span>
              <Badge variant="outline" className="mt-0.5 text-[10px] capitalize md:hidden">{c.source}</Badge>
            </div>
            <div className="flex items-center gap-1">
              <span className="font-mono max-md:whitespace-nowrap max-md:text-right">{c.currency} {c.amount}</span>
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  {/* Waive/Void must not hide behind hover — touch has none, so the kebab was
                      unreachable there; desktop keeps its quiet reveal. touch-hit lifts the
                      24px trigger to a 40px target without moving the row. */}
                  <button className="touch-hit rounded p-1 text-muted-foreground opacity-100 transition-opacity hover:bg-accent focus-visible:opacity-100 md:opacity-0 md:group-hover:opacity-100" aria-label="Line actions">
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

      {/* Side by side the method select + pay button overflow a 360px screen and the
          amount truncates at the viewport edge — money is the one thing this button
          must show. Stack them below sm; desktop keeps the single row. */}
      {/* Method and reference stack above the button: a reference field beside a
          full-width amount button fits no phone, and it is the one thing here that
          must not be squeezed into a corner. */}
      <div className="space-y-2 border-t bg-muted/10 px-4 py-3">
        <PaymentRailPicker rails={rails.data} value={pay} onChange={setPay} />
        <Button className="w-full" loading={checkout.isPending} disabled={incomplete} onClick={() => checkout.mutate()}>
          <HandCoins className="h-4 w-4" /> Take payment · <span className="whitespace-nowrap tabular-nums">{group.currency} {group.total.toFixed(2)}</span>
        </Button>
      </div>
    </Card>
  );
}

const todayISO = () => new Date().toISOString().slice(0, 10);
const etbFmt = (v: string | number) => Number(v || 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const longDay = (iso: string) => new Date(`${iso}T00:00:00`).toLocaleDateString(undefined, { weekday: "short", day: "numeric", month: "short", year: "numeric" });

/** Day-close overview: one expandable row per business day, newest first. */
function DayCloseList({ q, clinicName, cashierName, onClose }: {
  q: { data?: DaySummary[]; isLoading: boolean };
  clinicName: string;
  cashierName: string;
  onClose: (date: string) => void;
}) {
  const today = todayISO();
  // Always offer today, even before any payment has come in.
  const rows = useMemo(() => {
    const list = [...(q.data ?? [])];
    if (!list.some((d) => d.business_date === today)) {
      list.unshift({ business_date: today, expected_total: "0", count: 0, closed: false });
    }
    return list.sort((a, b) => b.business_date.localeCompare(a.business_date));
  }, [q.data, today]);
  const missed = rows.filter((d) => !d.closed && d.business_date < today);

  if (q.isLoading) return <Card className="p-8 text-center text-sm text-muted-foreground">Loading…</Card>;
  return (
    <div className="space-y-3">
      {missed.length > 0 && (
        <div className="flex flex-wrap items-center gap-2 rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-800">
          <AlertTriangle className="h-4 w-4 shrink-0" />
          <span><b>{missed.length}</b> earlier {missed.length === 1 ? "day was" : "days were"} never closed. You can still close {missed.length === 1 ? "it" : "them"} now — the takings are counted against that day's date.</span>
        </div>
      )}
      {rows.map((d) => (
        <DayCloseRow key={d.business_date} d={d} isToday={d.business_date === today} clinicName={clinicName} cashierName={cashierName} onClose={onClose} />
      ))}
    </div>
  );
}

function DayCloseRow({ d, isToday, clinicName, cashierName, onClose }: {
  d: DaySummary; isToday: boolean; clinicName: string; cashierName: string; onClose: (date: string) => void;
}) {
  const [open, setOpen] = useState(false);
  // Method breakdown is only needed once a row is opened.
  const detail = useQuery({ queryKey: ["day-close", d.business_date], queryFn: () => dayClose(d.business_date), enabled: open });
  const variance = Number(d.variance || 0);
  const missed = !d.closed && !isToday;

  const printZ = () => printZReport({
    clinic: clinicName, cashier: cashierName, businessDate: d.business_date,
    byMethod: detail.data?.by_method ?? [], expected: d.expected_total,
    counted: d.counted_total ?? "0", variance: d.variance ?? "0", note: d.note,
  });

  return (
    <Card className={cn("overflow-hidden", missed && "border-amber-300")}>
      {/* "Close day" used to live inside the row's <button> behind a stopPropagation
          span — a button-in-button, so focus and screen readers saw one mixed-up
          control. The toggle is now its own button (chevron + summary) and the
          action a true sibling; no propagation games needed. */}
      <div className="flex w-full flex-wrap items-center gap-3 p-4 hover:bg-accent/40">
        <button type="button" aria-expanded={open} onClick={() => setOpen((o) => !o)} className="flex min-w-0 flex-1 items-center gap-3 text-left">
          <ChevronDown className={cn("h-4 w-4 shrink-0 text-muted-foreground transition-transform", !open && "-rotate-90")} />
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <span className="font-semibold text-brand">{longDay(d.business_date)}</span>
              {isToday && <Badge variant="outline">today</Badge>}
              {d.closed ? (
                <Badge variant="success"><Check className="mr-1 h-3 w-3" /> closed</Badge>
              ) : missed ? (
                <Badge variant="warning"><AlertTriangle className="mr-1 h-3 w-3" /> needs closing</Badge>
              ) : (
                <Badge variant="outline">open</Badge>
              )}
              {d.closed && variance !== 0 && (
                <Badge variant={variance > 0 ? "warning" : "destructive"}>{variance > 0 ? "over" : "short"} ETB {etbFmt(Math.abs(variance))}</Badge>
              )}
            </div>
            <div className="mt-0.5 text-xs text-muted-foreground">
              {formatEthiopian(d.business_date)} EC · {d.count} payment{d.count === 1 ? "" : "s"}
              {d.closed && d.closed_at ? ` · closed ${new Date(d.closed_at).toLocaleString()}` : ""}
            </div>
          </div>
        </button>
        <div className="ml-auto flex items-center gap-2">
          <span className="whitespace-nowrap font-mono text-sm font-semibold">ETB {etbFmt(d.expected_total)}</span>
          {!d.closed && (
            <Button size="sm" variant={missed ? "default" : "outline"} className="touch-hit" onClick={() => onClose(d.business_date)}><Lock className="h-3.5 w-3.5" /> Close day</Button>
          )}
        </div>
      </div>

      {open && (
        <div className="space-y-3 border-t bg-muted/20 p-4">
          <div>
            <p className="mb-1 text-xs font-medium uppercase tracking-wide text-muted-foreground">Collected</p>
            <div className="divide-y rounded-md border bg-card text-sm">
              {(detail.data?.by_method ?? []).map((m) => (
                <div key={m.label} className="flex justify-between px-3 py-1.5"><span className="capitalize">{m.label} ({m.count})</span><span className="font-mono">ETB {etbFmt(m.total)}</span></div>
              ))}
              {(detail.data?.by_method ?? []).length === 0 && <div className="px-3 py-1.5 text-muted-foreground">{detail.isLoading ? "Loading…" : "No payments on this day."}</div>}
              <div className="flex justify-between px-3 py-1.5 font-semibold"><span>Expected</span><span className="font-mono">ETB {etbFmt(d.expected_total)}</span></div>
            </div>
          </div>
          {d.closed ? (
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div className="text-sm">
                <span className="text-muted-foreground">Counted </span><span className="font-mono font-medium">ETB {etbFmt(d.counted_total ?? "0")}</span>
                <span className="text-muted-foreground"> · variance </span>
                <span className={cn("font-mono font-medium", variance === 0 ? "text-emerald-600" : "text-rose-600")}>ETB {etbFmt(d.variance ?? "0")}</span>
                {d.note && <p className="mt-1 text-xs text-muted-foreground">{d.note}</p>}
              </div>
              <div className="flex gap-2">
                <Button size="sm" variant="outline" onClick={printZ}><Printer className="h-3.5 w-3.5" /> Print Z-report</Button>
                <Button size="sm" variant="ghost" onClick={() => onClose(d.business_date)}>Re-close…</Button>
              </div>
            </div>
          ) : (
            <div className="flex flex-wrap items-center justify-between gap-3">
              <p className="text-sm text-muted-foreground">
                {missed ? "This day was never closed off." : "Close the drawer at the end of the day to file the Z-report."}
              </p>
              <Button size="sm" onClick={() => onClose(d.business_date)}><Lock className="h-3.5 w-3.5" /> Count &amp; close</Button>
            </div>
          )}
        </div>
      )}
    </Card>
  );
}

function DayCloseDialog({ date, onClose, onDone }: { date: string | null; onClose: () => void; onDone: () => void }) {
  const { user } = useAuth();
  const open = !!date;
  const exp = useQuery({ queryKey: ["day-close", date], queryFn: () => dayClose(date!), enabled: open });
  const clinic = useQuery({ queryKey: ["clinic"], queryFn: getClinic, retry: false, enabled: open });
  const [counted, setCounted] = useState("");
  const cashierName = user?.full_name || "Cashier";
  const e = exp.data;
  const mut = useMutation({
    mutationFn: () => closeDay({ business_date: date ?? undefined, counted: Number(counted) || 0, note: "" }),
    onSuccess: (rec) => {
      toast.success(`Day closed — variance ETB ${rec.variance}`);
      printZReport({
        clinic: clinic.data?.name || "Clinic", cashier: cashierName, businessDate: rec.business_date,
        byMethod: e?.by_method ?? [], expected: rec.expected_total, counted: rec.counted_total, variance: rec.variance, note: rec.note,
      });
      setCounted("");
      onDone();
      onClose();
    },
    onError: (err) => toast.error(err instanceof AppError ? err.message : "Could not close the day"),
  });
  const isPast = !!date && date < todayISO();
  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) { setCounted(""); onClose(); } }}>
      <DialogContent>
        <DialogHeader><DialogTitle>Close day — {date ? longDay(date) : "today"}</DialogTitle></DialogHeader>
        {isPast && (
          <p className="flex items-start gap-2 rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-800">
            <CalendarCheck className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            Closing an earlier day. The Z-report is filed against <b>{date}</b>, not today.
          </p>
        )}
        {e?.closed && <p className="rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-800">Already closed — saving again updates the closeout.</p>}
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
          <Button variant="outline" onClick={() => { setCounted(""); onClose(); }}>Cancel</Button>
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
            <Input value={note} onChange={(e) => setNote(e.target.value)} placeholder="Explain" />
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
            <Input value={note} onChange={(e) => setNote(e.target.value)} placeholder="Explain the exemption" />
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
