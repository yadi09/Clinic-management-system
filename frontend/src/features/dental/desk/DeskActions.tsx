// The two things the front desk does that the clinician's page has no reason to show.
//
// The desk's job on a dental patient is money and dates: take payment for what has
// been given, and rebook what was missed. Everything else it needs — the balance, the
// schedule, the statement — the shared page already provides.
//
// Kept as one component so the desk view can be the SAME page as the dentist's with a
// different action strip, rather than a second 474-line implementation of the same
// patient. The two drifted for months: the same session read "Due" on one screen and
// "Unpaid" on the other, and every fix had to be made twice.
import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { AlertTriangle, CalendarClock, CheckCircle2, HandCoins, Wallet } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { toast } from "@/components/ui/sonner";
import { cn } from "@/lib/utils";
import { AppError } from "@/lib/api-client";
import { DualDate } from "@/components/DualDate";
import { MoveSessionDialog } from "@/features/dental/shared/MoveSessionDialog";
import { birr, isBillable, sessionMoneyState } from "@/features/dental/money";
import { collectSessions, type Plan, type Session } from "@/features/dental/api";

/** The parts of a visit, down payment or extra the desk needs to bill it. */
interface Line { id: string; amount_due: string; payment: Session["payment"]; status: string; scheduled_date: string; seq: number; pay_later?: boolean }
interface Row { plan: Plan; s: Line; label: string; kind: "visit" | "deposit" | "extra" }

// Everything that can be billed: the visits, the down payment and the extras. The
// server hands the deposit and extras out separately from plan.sessions, so reading
// only plan.sessions showed "Nothing owed yet" over an unpaid 20,000 ETB down
// payment, with no way to bill it from the desk (audit D10/W8).
const rowsOf = (plans: Plan[]): Row[] =>
  plans.filter((p) => p.status !== "cancelled").flatMap((plan) => {
    const out: Row[] = [];
    const d = plan.deposit;
    if (d) {
      // A deposit has no status of its own on the wire: it is always 'planned'.
      out.push({ plan, s: { ...d, status: "planned", seq: 0 }, label: `${plan.title} · down payment`, kind: "deposit" });
    }
    for (const s of plan.sessions.filter((x) => x.status !== "cancelled")) {
      out.push({ plan, s, label: `${plan.title} · visit ${s.seq}`, kind: "visit" });
      for (const x of (s.extras ?? []).filter((e) => e.status !== "cancelled")) {
        out.push({
          plan, s: { ...x, scheduled_date: s.scheduled_date, seq: s.seq },
          label: `${x.service_name || "Extra"} · at visit ${s.seq} of ${plan.title}`, kind: "extra",
        });
      }
    }
    return out;
  });

/** Owed now, by the server's rule: a visit or extra once given; a down payment from
 *  the day the course was agreed — it is never "done", there is nothing to deliver. */
const owesNow = (r: Row) => {
  const st = sessionMoneyState(r.s);
  if (r.kind === "deposit") return st !== "paid" && st !== "atCashier" && st !== "waived" && st !== "cancelled";
  return st === "owedNow" || st === "refunded";
};

export function DeskActions({ patientId, plans, todayISO, canCollect, canReschedule, onChanged }: {
  patientId: string;
  plans: Plan[];
  todayISO: string;
  canCollect: boolean;
  canReschedule: boolean;
  onChanged: () => void;
}) {
  const [collecting, setCollecting] = useState(false);
  const [moving, setMoving] = useState<Row | null>(null);

  const rows = rowsOf(plans);
  const billable = rows.filter((r) => isBillable(r.s));
  const owed = billable.filter(owesNow);
  // Booked, the day has passed, and nobody recorded anything: the patient did not come.
  const missed = rows.filter((r) => r.kind === "visit" && r.s.status === "planned" && r.s.scheduled_date < todayISO);

  if (!canCollect && !canReschedule) return null;
  if (billable.length === 0 && missed.length === 0) return null;

  return (
    <>
      {canCollect && billable.length > 0 && (
        <Card className={cn(owed.length > 0 && "border-destructive/40")}>
          <CardContent className="flex flex-wrap items-center gap-x-4 gap-y-2 p-3">
            <HandCoins className={cn("h-5 w-5 shrink-0", owed.length > 0 ? "text-destructive" : "text-muted-foreground")} />
            <div className="min-w-0 flex-1 text-sm">
              {owed.length > 0 ? (
                <>
                  <span className="font-medium text-destructive">
                    {birr(owed.reduce((a, r) => a + Number(r.s.amount_due || 0), 0))} owed now
                  </span>
                  <span className="text-muted-foreground">
                    {" "}· {owed.map((r) => r.kind === "deposit" ? "down payment" : r.kind === "extra" ? "extra" : `visit ${r.s.seq}`).join(", ")}
                  </span>
                </>
              ) : (
                <span className="text-muted-foreground">
                  Nothing owed yet · {billable.length} future visit{billable.length === 1 ? "" : "s"} can be paid in advance
                </span>
              )}
            </div>
            <Button onClick={() => setCollecting(true)}>
              <HandCoins className="h-4 w-4" /> Take payment
            </Button>
          </CardContent>
        </Card>
      )}

      {missed.length > 0 && (
        <Card className="border-amber-300">
          <CardContent className="space-y-1.5 p-3">
            <p className="flex items-center gap-2 text-sm font-medium text-amber-800">
              <AlertTriangle className="h-4 w-4" />
              {missed.length} missed visit{missed.length === 1 ? "" : "s"} — nothing was recorded on the day
            </p>
            {/* Every one of them, not the first three. A missed visit that is not on
                screen is a patient nobody rings. */}
            {missed.map((r) => (
              <div key={r.s.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-md px-2 py-1.5 text-sm hover:bg-muted/60">
                <span className="min-w-0 flex-1 truncate">
                  {r.label}
                  <span className="ml-2 text-xs text-muted-foreground"><DualDate iso={r.s.scheduled_date} relative /></span>
                </span>
                <span className="tabular-nums text-muted-foreground">{birr(r.s.amount_due)}</span>
                {canReschedule && (
                  <Button size="sm" variant="outline" onClick={() => setMoving(r)}>
                    <CalendarClock className="h-3.5 w-3.5" /> Rebook
                  </Button>
                )}
              </div>
            ))}
          </CardContent>
        </Card>
      )}

      {collecting && (
        <CollectDialog patientId={patientId} rows={billable}
          onClose={() => setCollecting(false)} onDone={onChanged} />
      )}
      {moving && (
        <MoveSessionDialog
          patientId={patientId} sessionId={moving.s.id} planTitle={moving.plan.title}
          currentDate={moving.s.scheduled_date} seq={moving.s.seq} sessionCount={moving.plan.session_count} missed
          clashes={(iso) => rows
            .filter((r) => r.s.id !== moving.s.id && r.s.scheduled_date === iso)
            .map((r) => ({ id: r.s.id, label: `${r.plan.title} · visit ${r.s.seq}`, done: r.s.status === "done" }))}
          onClose={() => setMoving(null)} onMoved={onChanged}
        />
      )}
    </>
  );
}

/** Tick what the patient is paying for; it goes to the cashier's queue. */
function CollectDialog({ patientId, rows, onClose, onDone }: {
  patientId: string; rows: Row[]; onClose: () => void; onDone: () => void;
}) {
  // Default to what is actually owed. Prepaying a future visit is a real thing
  // patients do, but it should be a deliberate tick rather than the default.
  const [picked, setPicked] = useState<string[]>(
    () => rows.filter(owesNow).map((r) => r.s.id),
  );
  const toggle = (id: string) => setPicked((p) => (p.includes(id) ? p.filter((x) => x !== id) : [...p, id]));
  const total = rows.filter((r) => picked.includes(r.s.id)).reduce((a, r) => a + Number(r.s.amount_due || 0), 0);

  const mut = useMutation({
    mutationFn: () => collectSessions(patientId, picked),
    onSuccess: (r) => {
      toast.success(`${r.billed} visit${r.billed === 1 ? "" : "s"} sent to the cashier · ${birr(r.total)}`);
      onDone(); onClose();
    },
    onError: (e) => toast.error(e instanceof AppError ? e.message : "Could not send to the cashier"),
  });

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-lg">
        <DialogHeader><DialogTitle>Take payment</DialogTitle></DialogHeader>
        <p className="text-sm text-muted-foreground">
          Tick what the patient is paying for. It goes to the cashier's queue — they take the money
          and issue the receipt.
        </p>
        <div className="max-h-[45vh] space-y-1 overflow-y-auto rounded-md border p-1">
          {rows.map((r) => {
            const on = picked.includes(r.s.id);
            const st = sessionMoneyState(r.s);
            return (
              <button key={r.s.id} type="button" onClick={() => toggle(r.s.id)}
                className="flex w-full items-center gap-3 rounded-md px-2 py-2 text-left text-sm hover:bg-accent">
                <span className={cn("flex h-4 w-4 shrink-0 items-center justify-center rounded border",
                  on ? "border-brand bg-brand text-brand-foreground" : "border-input")}>
                  {on && <CheckCircle2 className="h-3 w-3" />}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate">{r.label}</span>
                  {/* A course's start date is not when its down payment fell due. */}
                  {r.kind !== "deposit" && <span className="text-xs text-muted-foreground"><DualDate iso={r.s.scheduled_date} /></span>}
                </span>
                {owesNow(r) && st !== "refunded" && <Badge variant="destructive">Owed now</Badge>}
                {st === "refunded" && <Badge variant="destructive">Refunded</Badge>}
                <span className="w-24 text-right font-mono tabular-nums">{birr(r.s.amount_due)}</span>
              </button>
            );
          })}
        </div>
        <div className="flex items-center justify-between rounded-md bg-muted px-3 py-2 text-sm">
          <span className="font-medium">{picked.length} selected</span>
          <span className="font-mono text-base font-semibold tabular-nums">{birr(total)}</span>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>Cancel</Button>
          <Button disabled={picked.length === 0} loading={mut.isPending} onClick={() => mut.mutate()}>
            <Wallet className="h-4 w-4" /> Send to cashier
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
