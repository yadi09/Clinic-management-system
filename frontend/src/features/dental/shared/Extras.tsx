// What else got done at this visit — and whether it has been paid for.
//
// A course is agreed in advance: six sessions, this much each. Real dentistry then
// happens: at session three the tooth needs an X-ray, or the patient mentions the
// molar on the other side. An extra is its own row, priced from the clinic's list,
// sitting under the visit it happened at. A price of 0 is a real answer — "included
// in the course" — and it says so, because a blank and a decision must not look alike.
//
// The part that matters at the chair is the SEQUENCE. An extra is a bill the patient
// did not expect, so it moves along the same three stops as the visit fee:
//
//     Not billed  →  At cashier  →  Paid
//
// with "Treat now, pay later" always available, because a patient in pain is treated
// and the money is owed rather than a reason to stop. It is a visible sequence, not a
// lock: the chair cannot be locked, and a control that is easy to get round teaches
// staff to ignore it. What the screen does instead is make the normal path obvious,
// tell the dentist the moment the cashier has been paid, and ask once — gently — if
// the visit is being finished with something still unpaid.
import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, HandCoins, Hourglass, Plus, Sparkles, Undo2, Wallet, X } from "lucide-react";

import { useAuth } from "@/app/auth-context";
import { useConfirmDialog } from "@/components/ConfirmDialog";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { toast } from "@/components/ui/sonner";
import { cn } from "@/lib/utils";
import { AppError } from "@/lib/api-client";
import {
  addExtra, collectSession, collectSessions, dentalSummary, popularExtras, removeExtra, setPayLater,
  uncollectSession, type Extra, type PopularExtra, type Session, type Summary,
} from "@/features/dental/api";
import { invalidateDental } from "@/features/dental/invalidate";
import { birr, num } from "@/features/dental/money";
import { RecordSection } from "@/features/dental/shared/RecordSection";
import { ServicePicker } from "@/features/dental/shared/ServicePicker";
import { settleVisit } from "@/features/billing/api";
import {
  EMPTY_PAYMENT, PaymentRailPicker, PaymentRefused, paymentBlocked, paymentIncomplete, usePaymentRails,
  type PaymentChoice,
} from "@/features/billing/PaymentRail";

/** Where one extra's money has got to. */
export type ExtraStage = "free" | "unpaid" | "atCashier" | "paid" | "promised";

export function extraStage(ex: Extra): ExtraStage {
  if (num(ex.amount_due) < 0.005) return "free";
  if (ex.payment === "paid" || ex.payment === "waived") return "paid";
  if (ex.payment === "billed") return "atCashier";
  if (ex.pay_later) return "promised";
  return "unpaid";
}

/** Total of a visit's extras. Exported because the fee strip has to add them in. */
export function extrasTotal(session: Session) {
  return (session.extras ?? []).reduce((a, e) => a + num(e.amount_due), 0);
}

/** The extras that would still be owed if the visit were finished now and nobody had
 *  decided anything: not paid, and not on a promise. */
export function unsettledExtras(session: Session): Extra[] {
  return (session.extras ?? []).filter((e) => {
    const st = extraStage(e);
    return st === "unpaid" || st === "atCashier";
  });
}

const STOPS = [
  { key: "unpaid", label: "Not billed" },
  { key: "atCashier", label: "At cashier" },
  { key: "paid", label: "Paid" },
] as const;

/** The three stops. A promise sits at the first one, named for what it is. */
function Pipe({ stage }: { stage: ExtraStage }) {
  const at = stage === "paid" ? 2 : stage === "atCashier" ? 1 : 0;
  return (
    <ol className="mt-2 flex items-center text-[11px] text-muted-foreground" aria-label="Payment progress">
      {STOPS.map((s, i) => {
        const done = stage === "paid" || i < at;
        const here = i === at && stage !== "paid";
        return (
          <li key={s.key} className={cn("flex items-center", i < STOPS.length - 1 && "flex-1")}>
            <span className="flex items-center gap-1.5">
              <span className={cn(
                "flex h-[18px] w-[18px] items-center justify-center rounded-full border-2 text-[10px] font-bold",
                done ? "border-emerald-600 bg-emerald-600 text-white"
                  : here ? "border-amber-500 text-amber-700" : "border-border")}>
                {done ? <Check className="h-2.5 w-2.5" strokeWidth={4} /> : i + 1}
              </span>
              <span className={cn(here && "font-medium text-foreground")}>
                {i === 0 ? (stage === "promised" ? "Pay later" : done ? "Billed" : s.label) : s.label}
              </span>
            </span>
            {i < STOPS.length - 1 && <span className={cn("mx-2 h-0.5 flex-1 rounded", done ? "bg-emerald-600" : "bg-border")} />}
          </li>
        );
      })}
    </ol>
  );
}

/** Find an extra on a freshly read summary (to learn its bill's id). */
function findExtra(s: Summary, id: string): Extra | undefined {
  for (const p of s.plans) for (const se of p.sessions) for (const ex of se.extras ?? []) if (ex.id === id) return ex;
  return undefined;
}

/**
 * Take the money for one extra here and now, with the same payment step reception
 * uses (method, reference, bank check). Only for people who hold the collect
 * permission: the chair is not a till unless the clinic has made it one.
 */
function CollectHereDialog({ patientId, extra, onClose }: { patientId: string; extra: Extra | null; onClose: () => void }) {
  const qc = useQueryClient();
  const { can } = useAuth();
  const rails = usePaymentRails();
  const [pay, setPay] = useState<PaymentChoice>(EMPTY_PAYMENT);
  useEffect(() => {
    const first = rails.data?.[0];
    if (first && !pay.railId) setPay({ railId: first.id, method: first.key, reference: "" });
  }, [rails.data, pay.railId]);

  const take = useMutation({
    mutationFn: async (force: boolean) => {
      let chargeId = extra!.charge_id;
      if (!chargeId) {
        // Not billed yet: bill it, then read back which bill that made.
        await collectSession(patientId, extra!.id);
        chargeId = findExtra(await dentalSummary(patientId), extra!.id)?.charge_id;
      }
      if (!chargeId) throw new AppError(409, "NO_BILL", "That extra could not be billed. Send it to the cashier instead.");
      return settleVisit(patientId, {
        rail_id: pay.railId || undefined, method: pay.method, reference: pay.reference, force, charge_ids: [chargeId],
      });
    },
    onSuccess: (r) => {
      toast.success(`${extra?.service_name ?? "Extra"} paid · receipt RCP-${String(r.receipt_no).padStart(6, "0")}`);
      invalidateDental(qc, patientId);
      onClose();
    },
    onError: (e) => {
      // The bill may have been raised before the payment was refused: show that.
      invalidateDental(qc, patientId);
      toast.error(e instanceof AppError ? e.message : "Could not take the payment");
    },
  });

  return (
    <Dialog open={!!extra} onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent className="max-w-md">
        <DialogHeader><DialogTitle>Take payment for {extra?.service_name || "this extra"}</DialogTitle></DialogHeader>
        {extra && (
          <>
            <p className="text-sm text-muted-foreground">
              <b className="text-foreground">{birr(extra.amount_due)}</b> — paid here and now, with its own receipt.
            </p>
            <PaymentRailPicker rails={rails.data} value={pay} onChange={setPay}
              expected={num(extra.amount_due).toFixed(2)} patientId={patientId} />
          </>
        )}
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>Cancel</Button>
          {paymentBlocked(pay) ? (
            <PaymentRefused canOverride={can("payment.waive")} pending={take.isPending} onForce={() => take.mutate(true)} />
          ) : (
            <Button loading={take.isPending} disabled={paymentIncomplete(rails.data, pay)} onClick={() => take.mutate(false)}>
              <HandCoins className="h-4 w-4" /> Take {extra ? birr(extra.amount_due) : ""}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function ExtrasSection({ patientId, session, editable, canCollect }: {
  patientId: string;
  session: Session;
  /** Read-only on a finished visit that is being reviewed rather than recorded. */
  editable?: boolean;
  /** Billing an extra is the same permission as billing anything else. */
  canCollect?: boolean;
}) {
  const qc = useQueryClient();
  const { can } = useAuth();
  const canTakeMoney = can("payment.collect");
  const [adding, setAdding] = useState(false);
  const [picked, setPicked] = useState<{ id: string; name: string; price: string } | null>(null);
  const [price, setPrice] = useState("");
  const [collecting, setCollecting] = useState<Extra | null>(null);
  const { ask, dialog } = useConfirmDialog();

  const extras = useMemo(() => session.extras ?? [], [session.extras]);
  const refresh = () => invalidateDental(qc, patientId);

  // While something is with the cashier the dentist must not have to refresh to find
  // out it has been paid: the row turns green on its own.
  const waiting = extras.some((e) => extraStage(e) === "atCashier");
  useEffect(() => {
    if (!waiting) return;
    const t = setInterval(() => invalidateDental(qc, patientId), 6000);
    return () => clearInterval(t);
  }, [waiting, qc, patientId]);

  // The clinic's own usual extras, from what has actually been added.
  const popular = useQuery({
    queryKey: ["dental-popular-extras"],
    queryFn: popularExtras,
    enabled: !!editable,
    staleTime: 300_000,
    retry: false,
  });

  const note = (e: unknown, fallback: string) => toast.error(e instanceof AppError ? e.message : fallback);

  const add = useMutation({
    mutationFn: (v: { id: string; name: string; amount?: string }) =>
      // The amount is sent only when the dentist changed it, so the server prices
      // from its own list rather than trusting a number the browser worked out.
      addExtra(patientId, session.id, { service_id: v.id, amount: v.amount }),
    onSuccess: (_d, v) => {
      toast.success(`${v.name} added to this visit`);
      setAdding(false); setPicked(null); setPrice("");
      refresh();
    },
    onError: (e) => note(e, "Could not add it"),
  });
  const bill = useMutation({
    mutationFn: (id: string) => collectSession(patientId, id),
    onSuccess: () => { toast.success("Sent to the cashier"); refresh(); },
    onError: (e) => note(e, "Could not send it to the cashier"),
  });
  const billAll = useMutation({
    mutationFn: (ids: string[]) => collectSessions(patientId, ids),
    onSuccess: (r) => { toast.success(`${r.billed} sent to the cashier`); refresh(); },
    onError: (e) => note(e, "Could not send them to the cashier"),
  });
  const pull = useMutation({
    mutationFn: (v: { id: string; reason: string }) => uncollectSession(patientId, v.id, v.reason),
    onSuccess: () => { toast.success("Taken back from the cashier"); refresh(); },
    onError: (e) => note(e, "Could not take it back"),
  });
  const later = useMutation({
    mutationFn: (v: { id: string; note: string }) => setPayLater(patientId, v.id, { on: true, note: v.note.trim() }),
    onSuccess: () => { toast.success("Treated now — still owed"); refresh(); },
    onError: (e) => note(e, "Could not record that"),
  });
  const unlater = useMutation({
    mutationFn: (id: string) => setPayLater(patientId, id, { on: false, note: "" }),
    onSuccess: () => { toast.success("Promise removed"); refresh(); },
    onError: (e) => note(e, "Could not remove it"),
  });
  const drop = useMutation({
    mutationFn: (id: string) => removeExtra(patientId, id),
    onSuccess: () => { toast.success("Extra removed"); refresh(); },
    onError: (e) => note(e, "Could not remove it"),
  });

  const askLater = (ex: Extra) => ask({
    title: "Treat now, pay later?",
    description: <>
      <b>{ex.service_name || "This extra"}</b>, {birr(ex.amount_due)}, stays owed. It stays on the cashier's
      list and in the debt report — nothing is written off.
    </>,
    reason: { label: "Why? (kept on the record)", placeholder: "Emergency: pain, treat first · Staff · Settles monthly", required: true },
    confirmLabel: "Treat now, bill later",
    cancelLabel: "Go back",
  }, (reason) => later.mutateAsync({ id: ex.id, note: reason }));

  const askPull = (ex: Extra) => ask({
    title: "Take this bill back from the cashier?",
    description: "It goes back to not billed. The bill is cancelled, with your name and the reason.",
    reason: { label: "Why?", placeholder: "Sent by mistake", required: true },
    confirmLabel: "Take it back",
  }, (reason) => pull.mutateAsync({ id: ex.id, reason }));

  const askDrop = (ex: Extra) => ask({
    title: `Remove ${ex.service_name || "this extra"}?`,
    description: <>It will no longer be owed{num(ex.amount_due) > 0 ? <> — <b>{birr(ex.amount_due)}</b></> : null}. Use this only if it was added by mistake.</>,
    confirmLabel: "Remove",
    destructive: true,
  }, () => drop.mutateAsync(ex.id));

  const totals = useMemo(() => {
    let paid = 0, cashier = 0, notBilled = 0, promised = 0;
    const billable: string[] = [];
    for (const e of extras) {
      const st = extraStage(e);
      const v = num(e.amount_due);
      if (st === "paid") paid += v;
      else if (st === "atCashier") cashier += v;
      else if (st === "promised") promised += v;
      else if (st === "unpaid") { notBilled += v; billable.push(e.id); }
    }
    return { total: extrasTotal(session), paid, cashier, notBilled, promised, billable };
  }, [extras, session]);

  if (!editable && extras.length === 0) return null;

  const chips: PopularExtra[] = (popular.data ?? []).slice(0, 5);

  return (
    <>
      {dialog}
      <CollectHereDialog patientId={patientId} extra={collecting} onClose={() => setCollecting(null)} />
      <RecordSection
        icon={Sparkles} tone="media" title="Also done at this visit"
        hint="Anything the treatment did not plan for — an X-ray, a filling on another tooth."
        count={extras.length || undefined}
        action={editable && !adding ? (
          <Button variant="ghost" size="sm" className="h-7 px-2 text-xs" onClick={() => setAdding(true)}>
            <Plus className="h-3.5 w-3.5" /> Other…
          </Button>
        ) : undefined}
      >
        <div className="space-y-2">
          {/* One tap adds the clinic's usual extras at the list price. */}
          {editable && chips.length > 0 && (
            <div className="flex gap-1.5 overflow-x-auto pb-1 scrollbar-none md:flex-wrap" role="group" aria-label="Usual extras">
              {chips.map((c) => (
                <button key={c.service_id} type="button" disabled={add.isPending}
                  onClick={() => add.mutate({ id: c.service_id, name: c.name })}
                  className="touch-hit shrink-0 whitespace-nowrap rounded-full border bg-card px-3 py-1.5 text-sm font-medium hover:bg-accent disabled:opacity-50">
                  + {c.name} <span className="ml-1 font-normal text-muted-foreground">{num(c.price).toLocaleString()}</span>
                </button>
              ))}
            </div>
          )}

          {extras.map((ex) => {
            const st = extraStage(ex);
            const name = ex.service_name || "Procedure";
            const refunded = ex.payment === "refunded";
            return (
              <div key={ex.id} className={cn(
                "rounded-lg border px-3 py-2.5 text-sm",
                st === "unpaid" && "border-amber-200 bg-amber-50/60",
                st === "atCashier" && "border-sky-200 bg-sky-50/60",
                st === "promised" && "border-amber-200 bg-amber-50/40",
                st === "paid" && "border-emerald-200 bg-emerald-50/60",
                st === "free" && "bg-background")}>
                <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
                  <span className="min-w-0 flex-1 truncate font-semibold">{name}</span>
                  {st === "free"
                    ? <span className="text-xs text-muted-foreground">Included in the course</span>
                    : <span className="tabular-nums font-semibold">{birr(ex.amount_due)}</span>}
                  {editable && ex.payment !== "billed" && ex.payment !== "paid" && ex.payment !== "waived" && !ex.pay_later && (
                    <button type="button" onClick={() => askDrop(ex)} disabled={drop.isPending}
                      title="Remove this extra" aria-label={`Remove ${name}`}
                      className="touch-hit rounded p-1 text-muted-foreground hover:bg-muted hover:text-destructive">
                      <X className="h-3.5 w-3.5" />
                    </button>
                  )}
                </div>

                {st !== "free" && <Pipe stage={st} />}

                {st === "unpaid" && (
                  <div className="mt-2.5 flex flex-wrap items-center gap-2">
                    {refunded && <span className="text-xs font-medium text-destructive">Refunded — owed again</span>}
                    {canCollect && (
                      <Button size="sm" className="max-sm:w-full" loading={bill.isPending && bill.variables === ex.id}
                        onClick={() => bill.mutate(ex.id)}>
                        <HandCoins className="h-3.5 w-3.5" /> Send to cashier
                      </Button>
                    )}
                    {canTakeMoney && (
                      <Button size="sm" variant="outline" className="max-sm:w-full" onClick={() => setCollecting(ex)}>
                        <Wallet className="h-3.5 w-3.5" /> Collect here
                      </Button>
                    )}
                    {editable && (
                      <Button size="sm" variant="ghost" className="text-muted-foreground max-sm:w-full" onClick={() => askLater(ex)}>
                        Treat now, pay later…
                      </Button>
                    )}
                  </div>
                )}

                {st === "atCashier" && (
                  <div className="mt-2.5 flex flex-wrap items-center gap-2">
                    <span className="flex items-center gap-1.5 text-xs font-medium text-sky-800" role="status">
                      <Hourglass className="h-3.5 w-3.5" /> Waiting for the patient to pay at the cashier — this updates by itself
                    </span>
                    <span className="flex flex-wrap gap-2 max-sm:w-full">
                      {canTakeMoney && (
                        <Button size="sm" variant="outline" className="max-sm:flex-1" onClick={() => setCollecting(ex)}>
                          <Wallet className="h-3.5 w-3.5" /> Collect here
                        </Button>
                      )}
                      {editable && (
                        <Button size="sm" variant="ghost" className="text-muted-foreground max-sm:flex-1" onClick={() => askLater(ex)}>
                          Pay later…
                        </Button>
                      )}
                      {canCollect && (
                        <Button size="sm" variant="ghost" className="text-muted-foreground max-sm:flex-1" onClick={() => askPull(ex)}>
                          <Undo2 className="h-3.5 w-3.5" /> Take back
                        </Button>
                      )}
                    </span>
                  </div>
                )}

                {st === "promised" && (
                  <div className="mt-2.5 flex flex-wrap items-center gap-2">
                    <span className="text-xs font-medium text-amber-900">
                      Treated now — owed after this visit{ex.pay_later_note ? `: ${ex.pay_later_note}` : ""}
                    </span>
                    <span className="flex flex-wrap gap-2 max-sm:w-full">
                      {canCollect && (
                        <Button size="sm" className="max-sm:flex-1" loading={bill.isPending && bill.variables === ex.id}
                          onClick={() => bill.mutate(ex.id)}>
                          <HandCoins className="h-3.5 w-3.5" /> Send to cashier
                        </Button>
                      )}
                      {editable && (
                        <Button size="sm" variant="outline" className="max-sm:flex-1" loading={unlater.isPending && unlater.variables === ex.id}
                          onClick={() => unlater.mutate(ex.id)}>
                          <Undo2 className="h-3.5 w-3.5" /> Undo
                        </Button>
                      )}
                    </span>
                  </div>
                )}

                {st === "paid" && (
                  <p className="mt-2 text-xs font-semibold text-emerald-800">✓ Paid — go ahead</p>
                )}
              </div>
            );
          })}

          {extras.length === 0 && !adding && (
            <p className="py-1 text-xs text-muted-foreground">Nothing extra — this visit is what the treatment planned.</p>
          )}

          {extras.length > 0 && totals.total > 0.005 && (
            <div className="flex flex-wrap items-center justify-between gap-2 border-t pt-2 text-xs">
              <span className="text-muted-foreground">
                <b className="text-foreground">Extras: {birr(String(totals.total))}</b>
                {totals.paid > 0 && <> · {birr(String(totals.paid))} paid</>}
                {totals.cashier > 0 && <> · {birr(String(totals.cashier))} at cashier</>}
                {totals.promised > 0 && <> · {birr(String(totals.promised))} pay later</>}
                {totals.notBilled > 0 && <> · {birr(String(totals.notBilled))} not billed</>}
              </span>
              {canCollect && totals.billable.length > 1 && (
                <Button size="sm" variant="outline" loading={billAll.isPending} onClick={() => billAll.mutate(totals.billable)}>
                  <HandCoins className="h-3.5 w-3.5" /> Send all to cashier
                </Button>
              )}
            </div>
          )}

          {adding && (
            <div className="space-y-2 rounded-md border border-dashed p-3">
              <div className="space-y-1.5">
                <Label>Procedure</Label>
                <ServicePicker
                  value={picked?.name ?? ""}
                  selectedId={picked?.id}
                  onPick={(s) => { setPicked(s); setPrice(s ? s.price : ""); }}
                  // An extra has to be on the list — that is the whole point of it being
                  // countable. The picker can still create one on the spot.
                  onFreeText={() => toast.error("Pick it from the clinic's list, or add it to the list first")}
                  placeholder="Choose a procedure"
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="extra-price">Charge (ETB)</Label>
                <Input id="extra-price" type="number" min={0} step="0.01" value={price}
                  onChange={(e) => setPrice(e.target.value)} placeholder="0" />
                <p className="text-xs text-muted-foreground">
                  {picked && num(price) < 0.005
                    ? <>Zero means <b className="text-foreground">included in the course</b> — recorded, not billed.</>
                    : picked && Math.abs(num(price) - num(picked.price)) > 0.5
                      ? <>The list says {birr(picked.price)}.</>
                      : <>Priced from the clinic's list. Change it if this patient's case is different.</>}
                </p>
              </div>
              <div className="flex justify-end gap-2">
                <Button variant="outline" size="sm" onClick={() => { setAdding(false); setPicked(null); setPrice(""); }}>
                  Cancel
                </Button>
                <Button size="sm" disabled={!picked} loading={add.isPending}
                  onClick={() => add.mutate({
                    id: picked!.id, name: picked!.name, amount: price.trim() === "" ? undefined : price.trim(),
                  })}>
                  Add to this visit
                </Button>
              </div>
            </div>
          )}
        </div>
      </RecordSection>
    </>
  );
}

/**
 * The gentle stop: the visit is being finished while something added at the chair is
 * still unpaid. Three honest answers, never a dead end — and the third changes nothing,
 * because the money is simply still owed.
 */
export function UnpaidExtrasStop({ open, patientId, extras, canCollect, onClose, onProceed }: {
  open: boolean;
  patientId: string;
  extras: Extra[];
  canCollect?: boolean;
  onClose: () => void;
  /** Called once the dentist has chosen how to leave it; the caller then finishes. */
  onProceed: () => void;
}) {
  const qc = useQueryClient();
  const [note, setNote] = useState("");
  const [asking, setAsking] = useState(false);
  const unbilled = extras.filter((e) => extraStage(e) === "unpaid");
  const total = extras.reduce((a, e) => a + num(e.amount_due), 0);

  const send = useMutation({
    mutationFn: () => collectSessions(patientId, unbilled.map((e) => e.id)),
    onSuccess: () => { invalidateDental(qc, patientId); onProceed(); },
    onError: (e) => toast.error(e instanceof AppError ? e.message : "Could not send them to the cashier"),
  });
  const promise = useMutation({
    mutationFn: async () => { for (const e of extras) await setPayLater(patientId, e.id, { on: true, note: note.trim() }); },
    onSuccess: () => { invalidateDental(qc, patientId); setAsking(false); setNote(""); onProceed(); },
    onError: (e) => toast.error(e instanceof AppError ? e.message : "Could not record that"),
  });

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) { setAsking(false); onClose(); } }}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>{extras.length === 1 ? "1 extra has not been paid" : `${extras.length} extras have not been paid`}</DialogTitle>
        </DialogHeader>
        <ul className="space-y-1 text-sm">
          {extras.map((e) => (
            <li key={e.id} className="flex items-baseline justify-between gap-3">
              <span className="min-w-0 truncate">{e.service_name || "Procedure"}
                <span className="ml-2 text-xs text-muted-foreground">
                  {extraStage(e) === "atCashier" ? "at the cashier" : "not billed"}
                </span>
              </span>
              <span className="tabular-nums font-semibold">{birr(e.amount_due)}</span>
            </li>
          ))}
        </ul>
        {asking ? (
          <div className="space-y-1.5">
            <Label htmlFor="extras-why">Why? (kept on the record)</Label>
            <Input id="extras-why" value={note} onChange={(ev) => setNote(ev.target.value)}
              placeholder="Emergency: pain, treat first · Staff · Settles monthly" />
            <p className="text-xs text-muted-foreground">
              {birr(String(total))} stays owed — on the cashier's list and in the debt report. Nothing is written off.
            </p>
          </div>
        ) : (
          <p className="text-sm text-muted-foreground">
            The patient normally pays before the procedure goes ahead. You can still finish: it simply stays owed.
          </p>
        )}
        <DialogFooter className="sm:flex-col sm:items-stretch sm:space-x-0">
          {asking ? (
            <>
              <Button disabled={!note.trim()} loading={promise.isPending} onClick={() => promise.mutate()}>Treat now, bill later</Button>
              <Button variant="outline" onClick={() => setAsking(false)}>Back</Button>
            </>
          ) : (
            <>
              {canCollect && unbilled.length > 0 && (
                <Button loading={send.isPending} onClick={() => send.mutate()}>
                  <HandCoins className="h-4 w-4" /> Send to cashier and finish
                </Button>
              )}
              <Button variant="outline" onClick={() => setAsking(true)}>Treat now, pay later…</Button>
              <Button variant="ghost" onClick={onProceed}>Finish anyway — it stays owed</Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
