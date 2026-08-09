import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "react-router-dom";
import { AlertTriangle, ArrowLeftRight, BedDouble, LogOut, Plus } from "lucide-react";

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
import { admit, bedBoard, discharge, transfer, type BoardBed } from "@/features/inpatient/api";

const fmtBirr = (s?: string) => (s ? `ETB ${Number(s).toLocaleString(undefined, { minimumFractionDigits: 2 })}` : "—");
const fmtDate = (iso?: string) => (iso ? new Date(iso).toLocaleDateString(undefined, { day: "numeric", month: "short" }) : "");

export function BedsBoardPage() {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const board = useQuery({ queryKey: ["bed-board"], queryFn: bedBoard });
  const [admitBed, setAdmitBed] = useState<BoardBed | null>(null);
  const [transferAdm, setTransferAdm] = useState<BoardBed | null>(null);
  const [dischargeBed, setDischargeBed] = useState<BoardBed | null>(null);

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
              {wbeds.map((b) => <BedCard key={b.id} b={b} onAdmit={() => setAdmitBed(b)} onDischarge={() => setDischargeBed(b)} onTransfer={() => setTransferAdm(b)} onOpenPatient={(p) => navigate(`/patients/${p}`)} />)}
            </div>
          </section>
        ))
      )}

      {admitBed && <AdmitDialog bed={admitBed} onOpenChange={(o) => !o && setAdmitBed(null)} onDone={refresh} />}
      {transferAdm && <TransferDialog from={transferAdm} freeBeds={freeBeds} onOpenChange={(o) => !o && setTransferAdm(null)} onDone={refresh} />}

      <Dialog open={!!dischargeBed} onOpenChange={(o) => !o && setDischargeBed(null)}>
        <DialogContent>
          <DialogHeader><DialogTitle>Discharge patient</DialogTitle></DialogHeader>
          {dischargeBed && (
            <p className="text-sm text-muted-foreground">
              Discharge <b>{dischargeBed.patient_name}</b> from {dischargeBed.ward_name} · {dischargeBed.label}? This bills the stay
              ({dischargeBed.days} day{dischargeBed.days === 1 ? "" : "s"} × {fmtBirr(dischargeBed.daily_rate)}) and frees the bed.
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

function BedCard({ b, onAdmit, onDischarge, onTransfer, onOpenPatient }: { b: BoardBed; onAdmit: () => void; onDischarge: () => void; onTransfer: () => void; onOpenPatient: (id: string) => void }) {
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
          <div className="text-xs text-muted-foreground">{b.mrn} · {b.days} day{b.days === 1 ? "" : "s"} · est. {fmtBirr(b.est_cost)}</div>
          {b.overdue && b.payment_due_at && (
            <div className="flex items-center gap-1 text-xs text-destructive"><AlertTriangle className="h-3 w-3" /> due {fmtDate(b.payment_due_at)}</div>
          )}
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
  const [deposit, setDeposit] = useState("");
  const [dueAt, setDueAt] = useState("");
  const [note, setNote] = useState("");
  const mut = useMutation({
    mutationFn: () => admit({ patient_id: patient!.id, bed_id: bed.id, deposit_amount: deposit || undefined, payment_due_at: dueAt ? new Date(dueAt + "T23:59:59").toISOString() : undefined, note: note || undefined }),
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
            <div className="space-y-1.5"><Label>Deposit (ETB)</Label><Input type="number" min={0} placeholder="0" value={deposit} onChange={(e) => setDeposit(e.target.value)} /></div>
            <div className="space-y-1.5"><Label>Payment deadline</Label><EthiopianDateInput value={dueAt} onChange={setDueAt} showAge={false} /></div>
          </div>
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
