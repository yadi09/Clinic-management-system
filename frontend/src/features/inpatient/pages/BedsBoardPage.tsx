import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "react-router-dom";
import { AlertTriangle, ArrowLeftRight, BadgeDollarSign, BedDouble, HandCoins, LogOut, Plus } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Skeleton } from "@/components/ui/skeleton";
import { toast } from "@/components/ui/sonner";
import { AppError } from "@/lib/api-client";
import { EthiopianDateInput } from "@/components/EthiopianDateInput";
import { PatientCombobox } from "@/features/scheduling/components/BookingDialog";
import { cn } from "@/lib/utils";
import { useAuth } from "@/app/auth-context";
import { admit, bedBoard, discharge, topUp, transfer, type BoardBed } from "@/features/inpatient/api";

const fmtBirr = (s?: string) => (s ? `ETB ${Number(s).toLocaleString(undefined, { minimumFractionDigits: 2 })}` : "—");
const num = (n: number) => n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const fmtDate = (iso?: string) => (iso ? new Date(iso).toLocaleDateString(undefined, { day: "numeric", month: "short" }) : "");

export function BedsBoardPage() {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const board = useQuery({ queryKey: ["bed-board"], queryFn: bedBoard });
  const [admitBed, setAdmitBed] = useState<BoardBed | null>(null);
  const [transferAdm, setTransferAdm] = useState<BoardBed | null>(null);
  const [dischargeBed, setDischargeBed] = useState<BoardBed | null>(null);
  const [topUpBed, setTopUpBed] = useState<BoardBed | null>(null);

  const refresh = () => qc.invalidateQueries({ queryKey: ["bed-board"] });
  const beds = board.data ?? [];
  const wards = useMemo(() => {
    const m = new Map<string, BoardBed[]>();
    for (const b of beds) (m.get(b.ward_name) ?? m.set(b.ward_name, []).get(b.ward_name)!).push(b);
    return [...m.entries()];
  }, [beds]);
  const freeBeds = beds.filter((b) => !b.occupied && !b.out_of_service);

  const dischargeMut = useMutation({
    mutationFn: (adm: string) => discharge(adm),
    onSuccess: (a) => { toast.success(`Discharged — ${a.days} day${a.days === 1 ? "" : "s"}, ${fmtBirr(a.est_cost)} total`); setDischargeBed(null); refresh(); },
    onError: (e) => toast.error(e instanceof AppError ? e.message : "Could not discharge"),
  });

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1>Beds</h1>
          <p className="text-sm text-muted-foreground">
            {board.isLoading ? "Loading…" : `${beds.filter((b) => b.occupied).length} occupied · ${freeBeds.length} available · ${beds.length} beds`}
          </p>
        </div>
      </div>

      {board.isLoading ? (
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">{Array.from({ length: 6 }).map((_, i) => <Skeleton key={i} className="h-28" />)}</div>
      ) : beds.length === 0 ? (
        <Card className="p-12 text-center text-sm text-muted-foreground">No beds configured yet. Add wards and beds in Bed setup.</Card>
      ) : (
        wards.map(([ward, wbeds]) => (
          <section key={ward}>
            <div className="mb-2 flex items-baseline gap-2">
              <h2 className="text-h3">{ward}</h2>
              <span className="text-sm text-muted-foreground">{wbeds.filter((b) => b.occupied).length}/{wbeds.length} occupied</span>
            </div>
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
              {wbeds.map((b) => <BedCard key={b.id} b={b} onAdmit={() => setAdmitBed(b)} onDischarge={() => setDischargeBed(b)} onTransfer={() => setTransferAdm(b)} onTopUp={() => setTopUpBed(b)} onOpenPatient={(p) => navigate(`/patients/${p}`)} />)}
            </div>
          </section>
        ))
      )}

      {admitBed && <AdmitDialog bed={admitBed} onOpenChange={(o) => !o && setAdmitBed(null)} onDone={refresh} />}
      {transferAdm && <TransferDialog from={transferAdm} freeBeds={freeBeds} onOpenChange={(o) => !o && setTransferAdm(null)} onDone={refresh} />}
      {topUpBed && <TopUpDialog bed={topUpBed} onOpenChange={(o) => !o && setTopUpBed(null)} onDone={refresh} />}

      <Dialog open={!!dischargeBed} onOpenChange={(o) => !o && setDischargeBed(null)}>
        <DialogContent>
          <DialogHeader><DialogTitle>Discharge patient</DialogTitle></DialogHeader>
          {dischargeBed && (
            <p className="text-sm text-muted-foreground">
              Discharge <b>{dischargeBed.patient_name}</b> from {dischargeBed.ward_name} · {dischargeBed.label}?
              {" "}The stay comes to {fmtBirr(dischargeBed.est_cost)} for {dischargeBed.days} night{dischargeBed.days === 1 ? "" : "s"}.
              {Number(dischargeBed.unbilled || 0) > 0.005
                ? ` ${fmtBirr(dischargeBed.unbilled)} has not been billed yet and goes to the cashier now.`
                : " Everything has already been billed."}
              {Number(dischargeBed.outstanding || 0) > 0.005
                ? ` ${fmtBirr(dischargeBed.outstanding)} will still be owed after discharge.`
                : " Nothing is left to pay."}
            </p>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={() => setDischargeBed(null)}>Cancel</Button>
            <Button loading={dischargeMut.isPending} onClick={() => dischargeBed?.admission_id && dischargeMut.mutate(dischargeBed.admission_id)}>Discharge</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

/**
 * What the family has paid, and what is still to come.
 *
 * The card used to say "5 days · est. ETB 10,450" and stop, which tells a nurse
 * nothing they can act on: not whether a birr had been collected, not how far a part
 * payment reached, not whether the cashier was already holding a bill for it. A bed
 * is the one place in the clinic where money accrues while the patient sleeps, so it
 * is the one place that has to show its own arithmetic.
 *
 * The bar is the stay itself. Green is paid for, amber is slept but not paid for, and
 * the grey tail is the nights still booked ahead — so "paid ten of thirty days" is
 * something you see before you read it.
 */
function MoneyRow({ label, value, tone, strong }: { label: string; value?: string; tone?: "danger"; strong?: boolean }) {
  return (
    <div className="flex items-baseline justify-between gap-2 text-xs">
      <span className={tone === "danger" ? "text-destructive" : "text-muted-foreground"}>{label}</span>
      {value !== undefined && (
        <span className={cn("tabular-nums", strong ? "font-semibold" : "font-medium", tone === "danger" && "text-destructive")}>
          {fmtBirr(value)}
        </span>
      )}
    </div>
  );
}

function SplitRow({ label, value }: { label: string; value: number }) {
  const zero = value <= 0.005;
  return (
    <div className={cn("flex items-baseline justify-between gap-2 text-[11px]",
      zero ? "text-muted-foreground/50" : "text-muted-foreground")}>
      <span>{label}</span>
      <span className="tabular-nums">{num(value)}</span>
    </div>
  );
}

function StayMoney({ b }: { b: BoardBed }) {
  const owed = Number(b.outstanding || 0);
  const unbilled = Number(b.unbilled || 0);
  // Already asked for and sitting at the till, as opposed to never billed at all.
  const atCashier = Math.max(0, owed - unbilled);
  const planned = b.planned_nights || 0;
  const scale = Math.max(planned, b.days, b.covered_nights, 1);
  const pct = (n: number) => `${Math.min(100, (n / scale) * 100)}%`;

  return (
    <div className="mt-2 space-y-1.5 rounded-md bg-muted/40 p-2">
      {/* A ledger, not three unrelated figures.
          The card used to put "Still to pay ETB 1,800" in the loudest red next to a
          button reading "Ask for ETB 300", with the sentence that reconciles them in
          grey below a progress bar. Both numbers were right — 1,800 is what four
          nights have cost and nobody has paid, 300 is the part of it that has never
          been raised as a charge — but nothing on the card said they were parts of
          one sum, so it read as a contradiction.
          The amount on the button is now a line of the total it belongs to. */}
      <MoneyRow label="Stay so far" value={b.est_cost} />
      <MoneyRow label="Paid" value={b.paid ?? "0"} />
      {owed > 0.005 ? (
        <>
          <MoneyRow label="Still to pay" value={b.outstanding} tone="danger" strong />
          {/* Always both halves, including the zero.
              When one of them was a sentence instead — "All of it is waiting at the
              cashier." — the card stopped looking like the card beside it, and the
              missing Bill button read as something broken rather than as nothing to
              bill. A row that says 0.00 answers the question the button's absence
              raises; a paragraph in grey does not. */}
          <div className="ml-1 space-y-0.5 border-l-2 border-slate-200 pl-2">
            <SplitRow label="at the cashier now" value={atCashier} />
            <SplitRow label="not billed yet" value={unbilled} />
          </div>
        </>
      ) : (
        <MoneyRow label="Nothing owed" />
      )}

      <div className="flex h-1.5 overflow-hidden rounded-full bg-slate-200">
        <div className="bg-emerald-500" style={{ width: pct(b.covered_nights) }} />
        <div className="bg-amber-400" style={{ width: pct(Math.max(0, b.days - b.covered_nights)) }} />
      </div>
      <p className="text-[11px] leading-tight text-muted-foreground">
        {b.covered_nights > 0
          ? <>
              Paid through {fmtDate(b.covered_thru)} ·{" "}
              {/* Against the booking if there is one, otherwise against the nights
                  actually slept — but never "2 of 1", which is what dividing by a
                  total the family has already paid past used to produce. */}
              {b.covered_nights <= (planned || b.days)
                ? `${b.covered_nights} of ${planned || b.days} nights`
                : `${b.covered_nights} night${b.covered_nights === 1 ? "" : "s"} covered`}
            </>
          : <>No nights paid for yet{planned ? ` · booked for ${planned} nights` : ""}</>}
      </p>
    </div>
  );
}

function BedCard({ b, onAdmit, onDischarge, onTransfer, onTopUp, onOpenPatient }: { b: BoardBed; onAdmit: () => void; onDischarge: () => void; onTransfer: () => void; onTopUp: () => void; onOpenPatient: (id: string) => void }) {
  const { can } = useAuth();
  const navigate = useNavigate();
  const unbilled = Number(b.unbilled || 0);
  const outstanding = Number(b.outstanding || 0);
  const accent = b.out_of_service ? "border-l-slate-300" : b.occupied ? (b.overdue ? "border-l-destructive" : "border-l-primary") : "border-l-emerald-500";
  return (
    <Card className={`border-l-4 p-3 ${accent}`}>
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="flex items-center gap-1.5 font-semibold text-brand"><BedDouble className="h-4 w-4" /> {b.label}</div>
          <div className="text-xs capitalize text-muted-foreground">{b.bed_type} · {fmtBirr(b.daily_rate)}/day</div>
        </div>
        {b.out_of_service ? (
          <Badge variant="outline">out of service</Badge>
        ) : b.occupied ? (
          <Badge variant={b.overdue ? "destructive" : "success"}>{b.overdue ? "payment overdue" : "occupied"}</Badge>
        ) : (
          <Badge variant="success">available</Badge>
        )}
      </div>

      {b.occupied ? (
        <div className="mt-2 space-y-1">
          <button className="block truncate font-medium text-brand hover:underline" onClick={() => b.patient_id && onOpenPatient(b.patient_id)}>{b.patient_name}</button>
          <div className="text-xs text-muted-foreground">{b.mrn} · {b.days} night{b.days === 1 ? "" : "s"} in this bed</div>
          {b.overdue && b.payment_due_at && (
            <div className="flex items-center gap-1 text-xs text-destructive"><AlertTriangle className="h-3 w-3" /> due {fmtDate(b.payment_due_at)}</div>
          )}
          <StayMoney b={b} />
          {/* Money owed always has a next move, and the card should name it.
              Where nothing is left to bill, the money is already on the cashier's
              list — so the move is to go and take it, not to raise it again. */}
          {unbilled > 0.005 && can("payment.charge") ? (
            <Button size="sm" className="mt-2 w-full" onClick={onTopUp}>
              <HandCoins className="h-3.5 w-3.5 shrink-0" />
              <span className="truncate">Bill {fmtBirr(unbilled.toFixed(2))}</span>
            </Button>
          ) : outstanding > 0.005 && can("payment.collect") ? (
            <Button size="sm" variant="outline" className="mt-2 w-full" title="Opens the Cashier"
              onClick={() => navigate("/cashier")}>
              <BadgeDollarSign className="h-3.5 w-3.5 shrink-0" />
              <span className="truncate">Collect {fmtBirr(b.outstanding)}</span>
            </Button>
          ) : null}
          <div className="mt-2 flex gap-2">
            <Button size="sm" variant="outline" onClick={onTransfer}><ArrowLeftRight className="h-3.5 w-3.5" /> Transfer</Button>
            <Button size="sm" variant="ghost" onClick={onDischarge}><LogOut className="h-3.5 w-3.5" /> Discharge</Button>
          </div>
        </div>
      ) : b.out_of_service ? (
        <p className="mt-3 text-xs text-muted-foreground">Not in use.</p>
      ) : (
        <Button size="sm" className="mt-3 w-full" onClick={onAdmit}><Plus className="h-3.5 w-3.5" /> Admit patient</Button>
      )}
    </Card>
  );
}

function AdmitDialog({ bed, onOpenChange, onDone }: { bed: BoardBed; onOpenChange: (o: boolean) => void; onDone: () => void }) {
  const [patient, setPatient] = useState<{ id: string; name: string } | null>(null);
  // Two different numbers that staff kept having to hold in their head at once: how
  // long the bed is booked for, and how much of it the family is paying now. Both are
  // counted in nights, because that is how the ward talks about them; birr is shown
  // back so nobody has to do the multiplication.
  const [bookedNights, setBookedNights] = useState("");
  const [payNights, setPayNights] = useState("");
  const [dueAt, setDueAt] = useState("");
  const [note, setNote] = useState("");
  const rate = Number(bed.daily_rate || 0);
  const deposit = payNights ? (Number(payNights) * rate).toFixed(2) : "";
  const expected = bookedNights
    ? new Date(Date.now() + Number(bookedNights) * 864e5).toISOString().slice(0, 10)
    : "";
  const mut = useMutation({
    mutationFn: () => admit({ patient_id: patient!.id, bed_id: bed.id, deposit_amount: deposit || undefined, expected_discharge: expected || undefined, payment_due_at: dueAt ? new Date(dueAt + "T23:59:59").toISOString() : undefined, note: note || undefined }),
    onSuccess: () => { toast.success("Patient admitted"); onOpenChange(false); onDone(); },
    onError: (e) => toast.error(e instanceof AppError ? e.message : "Could not admit"),
  });
  return (
    <Dialog open onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader><DialogTitle>Admit to {bed.ward_name} · {bed.label}</DialogTitle></DialogHeader>
        <div className="space-y-4">
          <p className="text-sm text-muted-foreground">{bed.bed_type} bed · {fmtBirr(bed.daily_rate)}/day.</p>
          <div className="space-y-1.5"><Label>Patient</Label><PatientCombobox value={patient} onSelect={setPatient} /></div>
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label>Booked for</Label>
              <div className="flex items-center gap-2">
                <Input type="number" min={1} placeholder="—" value={bookedNights} onChange={(e) => setBookedNights(e.target.value)} />
                <span className="shrink-0 text-sm text-muted-foreground">nights</span>
              </div>
              <p className="text-xs text-muted-foreground">
                {bookedNights ? `${fmtBirr((Number(bookedNights) * rate).toFixed(2))} in all` : "Optional — how long the bed is held."}
              </p>
            </div>
            <div className="space-y-1.5">
              <Label>Paying now for</Label>
              <div className="flex items-center gap-2">
                <Input type="number" min={0} placeholder="0" value={payNights} onChange={(e) => setPayNights(e.target.value)} />
                <span className="shrink-0 text-sm text-muted-foreground">nights</span>
              </div>
              <p className="text-xs text-muted-foreground">
                {deposit ? `${fmtBirr(deposit)} to the cashier now` : "Nothing collected up front."}
              </p>
            </div>
          </div>
          <div className="space-y-1.5"><Label>Payment deadline <span className="text-muted-foreground">(optional)</span></Label><EthiopianDateInput value={dueAt} onChange={setDueAt} showAge={false} /></div>
          <div className="space-y-1.5"><Label>Note <span className="text-muted-foreground">(optional)</span></Label><Input value={note} onChange={(e) => setNote(e.target.value)} placeholder="Reason for admission" /></div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button disabled={!patient} loading={mut.isPending} onClick={() => mut.mutate()}>Admit</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function TransferDialog({ from, freeBeds, onOpenChange, onDone }: { from: BoardBed; freeBeds: BoardBed[]; onOpenChange: (o: boolean) => void; onDone: () => void }) {
  const [target, setTarget] = useState("");
  const mut = useMutation({
    mutationFn: () => transfer(from.admission_id!, target),
    onSuccess: () => { toast.success("Patient transferred"); onOpenChange(false); onDone(); },
    onError: (e) => toast.error(e instanceof AppError ? e.message : "Could not transfer"),
  });
  return (
    <Dialog open onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader><DialogTitle>Transfer {from.patient_name}</DialogTitle></DialogHeader>
        <div className="space-y-3">
          <p className="text-sm text-muted-foreground">From {from.ward_name} · {from.label}. Choose an available bed.</p>
          <Select value={target} onValueChange={setTarget}>
            <SelectTrigger><SelectValue placeholder="Choose a bed…" /></SelectTrigger>
            <SelectContent>
              {freeBeds.length === 0 && <SelectItem value="none" disabled>No free beds</SelectItem>}
              {freeBeds.map((b) => <SelectItem key={b.id} value={b.id}>{b.ward_name} · {b.label} ({fmtBirr(b.daily_rate)}/day)</SelectItem>)}
            </SelectContent>
          </Select>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button disabled={!target} loading={mut.isPending} onClick={() => mut.mutate()}>Transfer</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/**
 * Ask the family for more of the running bed bill.
 *
 * Nothing here caps the ask at what has already accrued: paying ahead is the ordinary
 * case, and a family booking thirty days and paying for ten is exactly the situation
 * that had nowhere to go before.
 */
function TopUpDialog({ bed, onOpenChange, onDone }: { bed: BoardBed; onOpenChange: (o: boolean) => void; onDone: () => void }) {
  const rate = Number(bed.daily_rate || 0);
  const unbilled = Number(bed.unbilled || 0);
  const atCashier = Math.max(0, Number(bed.outstanding || 0) - unbilled);
  const [mode, setMode] = useState<"nights" | "amount">("nights");
  const [nights, setNights] = useState(rate > 0 ? String(Math.max(1, Math.ceil(unbilled / rate))) : "1");
  const [amount, setAmount] = useState(unbilled > 0 ? unbilled.toFixed(2) : "");
  const total = mode === "nights" ? (Number(nights || 0) * rate).toFixed(2) : (amount || "0");
  const mut = useMutation({
    mutationFn: () => topUp(bed.admission_id!, mode === "nights" ? { nights: Number(nights) } : { amount }),
    onSuccess: (a) => { toast.success(`${fmtBirr(a.est_cost)} added to the cashier`); onOpenChange(false); onDone(); },
    onError: (e) => toast.error(e instanceof AppError ? e.message : "Could not raise the charge"),
  });
  return (
    <Dialog open onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader><DialogTitle>Ask {bed.patient_name} for payment</DialogTitle></DialogHeader>
        <div className="space-y-4">
          {/* The same ledger the card shows, so the screen that takes the decision
              and the screen that prompted it cannot disagree. */}
          <div className="space-y-1 rounded-md bg-muted/40 p-3 text-sm">
            <div className="flex justify-between"><span className="text-muted-foreground">Stay so far · {bed.days} night{bed.days === 1 ? "" : "s"}</span><span className="tabular-nums">{fmtBirr(bed.est_cost)}</span></div>
            <div className="flex justify-between"><span className="text-muted-foreground">Paid</span><span className="tabular-nums">{fmtBirr(bed.paid ?? "0")}</span></div>
            {atCashier > 0.005 && (
              <div className="flex justify-between"><span className="text-muted-foreground">Already at the cashier</span><span className="tabular-nums">{fmtBirr(atCashier.toFixed(2))}</span></div>
            )}
            <div className="flex justify-between font-medium"><span>Never billed</span><span className="tabular-nums">{fmtBirr(unbilled.toFixed(2))}</span></div>
          </div>
          <p className="text-sm text-muted-foreground">
            {bed.ward_name} · {bed.label} at {fmtBirr(bed.daily_rate)}/night.
          </p>

          <div className="flex gap-2">
            <Button size="sm" variant={mode === "nights" ? "default" : "outline"} onClick={() => setMode("nights")}>By nights</Button>
            <Button size="sm" variant={mode === "amount" ? "default" : "outline"} onClick={() => setMode("amount")}>By amount</Button>
          </div>

          {mode === "nights" ? (
            <div className="space-y-1.5">
              <Label>Nights to pay for</Label>
              <div className="flex items-center gap-2">
                <Input type="number" min={1} value={nights} onChange={(e) => setNights(e.target.value)} />
                <span className="shrink-0 text-sm text-muted-foreground">× {fmtBirr(bed.daily_rate)}</span>
              </div>
            </div>
          ) : (
            <div className="space-y-1.5">
              <Label>Amount (ETB)</Label>
              <Input type="number" min={0} value={amount} onChange={(e) => setAmount(e.target.value)} />
              <p className="text-xs text-muted-foreground">For a part payment that is not a whole number of nights.</p>
            </div>
          )}

          <div className="rounded-md bg-muted/50 p-3 text-sm">
            <div className="flex items-center justify-between">
              <span className="text-muted-foreground">Goes to the cashier</span>
              <span className="text-lg font-semibold tabular-nums">{fmtBirr(total)}</span>
            </div>
            {unbilled > 0.005 && (
              <p className="mt-1 text-xs text-muted-foreground">
                Billing {fmtBirr(unbilled.toFixed(2))} clears everything slept so far.
              </p>
            )}
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button disabled={Number(total) <= 0} loading={mut.isPending} onClick={() => mut.mutate()}>Send to cashier</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
