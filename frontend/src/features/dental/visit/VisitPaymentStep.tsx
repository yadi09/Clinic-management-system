// The money, asked first — before the note, not after it.
//
// Recording used to come first and the fee was resolved afterwards, in an amber
// panel below the saved note. That is the wrong order for the desk: the patient is
// standing in front of the dentist, and the question "has this visit been paid for"
// is answered by walking to the cashier, not by reading a panel after the fact. So
// the visit now opens on a three-stop pipeline — unpaid, at the cashier, paid — and
// the treatment form is what sits behind it.
//
// It is a sequence, not a gate. "Treat now, pay later" is on every step, because the
// clinic's rule is that a patient may be treated on a promise. The pipeline makes
// the normal path obvious; it does not make the other path impossible.
import { useEffect, useRef, useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { Check, HandCoins, Loader2, Pencil, TriangleAlert, Undo2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { toast } from "@/components/ui/sonner";
import { cn } from "@/lib/utils";
import { AppError } from "@/lib/api-client";
import {
  collectSession, repriceSession, setPayLater, uncollectSession,
  type Plan, type Session,
} from "@/features/dental/api";
import { birr, num, splitRounded } from "@/features/dental/money";
import { formatEthiopian } from "@/lib/ethiopian";

const todayISO = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};
/** "Aug 8" — enough to place a visit; the timeline below carries the full date. */
const shortDate = (iso: string) =>
  new Date(`${iso}T00:00:00`).toLocaleDateString(undefined, { month: "short", day: "numeric" });
/** "2 Nehase" — the same date in the calendar the patient actually uses. */
const shortEc = (iso: string) => {
  try { return formatEthiopian(iso, { dayFirst: true }).replace(/,? \d{4}$/, ""); } catch { return ""; }
};

/** Where this visit's fee has got to. Drives the pipeline and what is offered. */
export type FeeStage = "unpaid" | "atCashier" | "paid" | "promised";

export function feeStage(s: Session): FeeStage {
  if (s.payment === "paid" || s.payment === "waived") return "paid";
  if (s.payment === "billed") return "atCashier";
  if (s.pay_later) return "promised";
  return "unpaid";
}

/** Is the treatment form open? Paid or promised — the two honest answers.
 *  Note this is NOT the same question as whether the payment panel collapses: a
 *  promise opens the form but keeps the panel, because it can still be undone. */
export function feeResolved(s: Session): boolean {
  const st = feeStage(s);
  return st === "paid" || st === "promised";
}

// --- the pipeline ------------------------------------------------------------

function Pipeline({ stage }: { stage: FeeStage }) {
  const steps = stage === "promised"
    ? [{ k: "promised", label: "Pay later" }, { k: "atCashier", label: "At cashier" }, { k: "paid", label: "Paid" }]
    : [{ k: "unpaid", label: "Payment" }, { k: "atCashier", label: "At cashier" }, { k: "paid", label: "Paid" }];
  const order = ["unpaid", "promised", "atCashier", "paid"];
  const at = order.indexOf(stage);
  return (
    <div className="flex items-center" aria-label={`Fee: ${stage}`}>
      {steps.map((s, i) => {
        const idx = order.indexOf(s.k);
        const done = idx < at || stage === "paid";
        const here = s.k === stage;
        return (
          <div key={s.k} className={cn("flex items-center", i < steps.length - 1 && "flex-1")}>
            <div className="flex flex-col items-center gap-1">
              <span className={cn(
                "flex h-6 w-6 items-center justify-center rounded-full border text-[11px] font-bold",
                done ? "border-emerald-600 bg-emerald-600 text-white"
                  : here ? (stage === "promised" ? "border-amber-500 bg-amber-500 text-white" : "border-brand bg-brand text-brand-foreground")
                    : "border-muted-foreground/30 text-muted-foreground",
              )}>
                {done ? <Check className="h-3.5 w-3.5" /> : i + 1}
              </span>
              <span className={cn("text-[10px] font-semibold uppercase tracking-wide",
                here ? "text-foreground" : done ? "text-emerald-600" : "text-muted-foreground")}>
                {s.label}
              </span>
            </div>
            {i < steps.length - 1 && (
              <div className={cn("mx-2 mb-4 h-0.5 flex-1 rounded", done ? "bg-emerald-500" : "bg-muted")} />
            )}
          </div>
        );
      })}
    </div>
  );
}

// --- the course, at a glance -------------------------------------------------

/** Sessions that can still absorb a price change: later, live, and unbilled. */
export function respreadPool(plan: Plan, current: Session): Session[] {
  return plan.sessions.filter(
    (s) => s.seq > current.seq && s.status !== "cancelled"
      && s.payment !== "paid" && s.payment !== "billed" && s.payment !== "waived",
  );
}

function CourseRecap({ plan, current }: { plan: Plan; current: Session }) {
  const total = num(plan.money.planned) || num(plan.total_amount);
  const paid = num(plan.money.collected);
  const queued = num(plan.money.at_cashier);
  const left = Math.max(0, total - paid - queued);
  const pct = total > 0 ? Math.min(100, Math.round((paid / total) * 100)) : 0;
  const cells = [
    { k: "Total", v: total, tone: "" },
    { k: "Paid", v: paid, tone: "text-emerald-600" },
    { k: "With cashier", v: queued, tone: queued > 0.005 ? "text-amber-600" : "" },
    { k: "Left", v: left, tone: left > 0.005 ? "text-foreground" : "" },
  ];
  return (
    <div className="space-y-2">
      <p className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
        {plan.title} — the whole course
      </p>
      <div className="grid grid-cols-2 gap-px overflow-hidden rounded-md border bg-border sm:grid-cols-4">
        {cells.map((c) => (
          <div key={c.k} className="bg-card px-3 py-2">
            <div className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">{c.k}</div>
            <div className={cn("tabular-nums text-sm font-bold", c.tone)}>{birr(String(c.v))}</div>
          </div>
        ))}
      </div>
      {total > 0 && (
        <div className="flex items-center gap-2">
          <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-muted">
            <div className="h-full rounded-full bg-emerald-500 transition-all" style={{ width: `${pct}%` }} />
          </div>
          <span className="text-[11px] font-semibold text-emerald-600">{pct}% collected</span>
        </div>
      )}
      <CourseTrack plan={plan} current={current} />
    </div>
  );
}

// --- the course, visit by visit ---------------------------------------------

/**
 * What each visit is, when it is, what it costs and where its money stands.
 *
 * This was one line of "1 ✓ 4,000 ETB · 2 ✓ 4,000 ETB · NOW 3 · 5,000 ETB". Every
 * part of that had to be decoded: the number was not labelled a visit, the tick had
 * to be guessed as paid, the dot meant nothing at all, and there were no dates — so
 * the one question the strip existed to answer, "where are we in this course", could
 * not be answered by looking at it. Each visit is now a card that says all four
 * things in words.
 */
function visitState(s: Session, todayISO: string): { label: string; cls: string; dot: string } {
  const st = feeStage(s);
  if (s.status === "done") {
    if (st === "paid") return { label: "Paid", cls: "text-emerald-700", dot: "bg-emerald-500" };
    if (st === "atCashier") return { label: "At cashier", cls: "text-amber-700", dot: "bg-amber-500" };
    return { label: "Owed", cls: "text-destructive", dot: "bg-destructive" };
  }
  if (st === "paid") return { label: "Paid ahead", cls: "text-emerald-700", dot: "bg-emerald-500" };
  if (st === "atCashier") return { label: "At cashier", cls: "text-amber-700", dot: "bg-amber-500" };
  if (s.scheduled_date < todayISO) return { label: "Missed", cls: "text-destructive", dot: "bg-destructive" };
  return { label: "Booked", cls: "text-muted-foreground", dot: "bg-muted-foreground/40" };
}

function CourseTrack({ plan, current }: { plan: Plan; current: Session }) {
  const today = todayISO();
  const rail = useRef<HTMLDivElement>(null);
  const live = plan.sessions.filter((s) => s.status !== "cancelled");
  const done = live.filter((s) => s.status === "done").length;

  // With a dozen visits the current one can sit off-screen, which is the one card
  // the dentist opened this panel to look at.
  useEffect(() => {
    rail.current?.querySelector('[data-now="1"]')?.scrollIntoView({ block: "nearest", inline: "center" });
  }, [current.id]);

  const items: { key: string; title: string; date?: string; amount: string; st: ReturnType<typeof visitState>; now: boolean }[] = [];
  if (plan.deposit && num(plan.deposit.amount_due) > 0.005) {
    const d = plan.deposit;
    const paid = d.payment === "paid";
    items.push({
      key: "deposit", title: "Down payment", date: d.scheduled_date, amount: d.amount_due, now: false,
      st: paid ? { label: "Paid", cls: "text-emerald-700", dot: "bg-emerald-500" }
        : d.payment === "billed" ? { label: "At cashier", cls: "text-amber-700", dot: "bg-amber-500" }
          : { label: "Owed", cls: "text-destructive", dot: "bg-destructive" },
    });
  }
  for (const s of live) {
    items.push({
      key: s.id, title: `Visit ${s.seq}`, date: s.scheduled_date, amount: s.amount_due,
      st: visitState(s, today), now: s.id === current.id,
    });
  }

  return (
    <div className="space-y-1.5">
      <p className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
        The course — {done} of {live.length} visit{live.length === 1 ? "" : "s"} done
        {live.some((s) => s.id === current.id && s.status !== "done") && ", 1 in the chair"}
      </p>
      <div ref={rail} className="flex gap-2 overflow-x-auto pb-1">
        {items.map((it) => (
          <div key={it.key} data-now={it.now ? "1" : undefined}
            className={cn(
              "min-w-[7.5rem] shrink-0 rounded-md border bg-card px-2.5 py-2",
              it.now ? "border-brand ring-1 ring-brand" : "border-border",
            )}>
            <div className="flex items-center gap-1.5">
              <span className={cn("h-1.5 w-1.5 shrink-0 rounded-full", it.now ? "bg-brand" : it.st.dot)} />
              <span className={cn("truncate text-[10px] font-bold uppercase tracking-wide",
                it.now ? "text-brand" : "text-muted-foreground")}>
                {it.title}
              </span>
            </div>
            {it.date && (
              <div className="mt-1 leading-tight">
                <div className={cn("text-[11px] font-medium", it.date === today && "text-brand")}>
                  {it.date === today ? "Today" : shortDate(it.date)}
                </div>
                <div className="text-[10px] text-muted-foreground">{shortEc(it.date)}</div>
              </div>
            )}
            <div className="mt-1 tabular-nums text-xs font-bold">{birr(it.amount)}</div>
            <div className={cn("text-[10px] font-semibold", it.now ? "text-brand" : it.st.cls)}>
              {it.now ? "In the chair" : it.st.label}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

// --- changing this visit's fee -----------------------------------------------

function FeeEditor({ patientId, plan, session, onDone, onCancel }: {
  patientId: string; plan: Plan; session: Session; onDone: () => void; onCancel: () => void;
}) {
  const was = num(session.amount_due);
  const [val, setVal] = useState(String(Math.round(was)));
  const [mode, setMode] = useState<"respread" | "total">("respread");
  const next = num(val);
  const delta = next - was;
  const pool = respreadPool(plan, session);
  const poolTotal = pool.reduce((a, s) => a + num(s.amount_due), 0);
  const canRespread = pool.length > 0 && poolTotal - delta >= 0;
  const courseTotal = num(plan.money.planned) || num(plan.total_amount);

  // With nothing left to absorb it, the only truthful option is moving the total.
  useEffect(() => { if (!canRespread && mode === "respread") setMode("total"); }, [canRespread, mode]);

  // The SAME split the server will perform, not an average of it. A preview that
  // says 3,333.33 while the row is written as 3,300 is a promise to the patient
  // that the receipt then breaks.
  const shares = splitRounded(poolTotal - delta, pool.length);
  const each = shares[0] ?? 0;
  const last = shares[shares.length - 1] ?? 0;
  const save = useMutation({
    mutationFn: () => repriceSession(patientId, session.id, { amount: String(next), mode }),
    onSuccess: () => { toast.success("Fee updated"); onDone(); },
    onError: (e) => toast.error(e instanceof AppError ? e.message : "Could not change the fee"),
  });

  const label = pool.length === 1
    ? `visit ${pool[0].seq} of ${plan.session_count}`
    : `visits ${pool.map((s) => s.seq).join(", ")}`;

  return (
    <div className="space-y-3 rounded-md border bg-card p-3">
      <div className="flex flex-wrap items-end gap-3">
        <div className="space-y-1.5">
          <Label htmlFor="fee" className="text-xs">This visit's fee</Label>
          <div className="flex items-center gap-1.5">
            <Input id="fee" type="number" min={0} autoFocus value={val}
              onChange={(e) => setVal(e.target.value)} className="h-9 w-32 text-right tabular-nums" />
            <span className="text-xs text-muted-foreground">ETB</span>
          </div>
        </div>
        <p className="pb-2 text-xs text-muted-foreground">was {birr(String(was))}</p>
      </div>

      {Math.abs(delta) > 0.005 && (
        <div className="space-y-2">
          <p className="text-sm font-medium">
            {birr(String(Math.abs(delta)))} {delta > 0 ? "more" : "less"}.{" "}
            {delta > 0 ? "Where does it come from?" : "Where does it go?"}
          </p>

          {pool.length === 0 ? (
            <p className="flex items-start gap-2 rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-900">
              <TriangleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" />
              <span>
                This is the last visit — there is nothing left to re-spread.
                The course becomes <b>{birr(String(courseTotal + delta))}</b> (was {birr(String(courseTotal))}).
              </span>
            </p>
          ) : (
            <div className="space-y-1.5">
              <label className={cn("flex cursor-pointer items-start gap-2 rounded-md border p-2 text-xs",
                mode === "respread" ? "border-brand bg-brand/5" : "hover:bg-muted",
                !canRespread && "cursor-not-allowed opacity-50")}>
                <input type="radio" className="mt-0.5" checked={mode === "respread"} disabled={!canRespread}
                  onChange={() => setMode("respread")} />
                <span>
                  <b>The rest of the course</b> — total stays {birr(String(courseTotal))}
                  <span className="mt-0.5 block tabular-nums text-muted-foreground">
                    {canRespread
                      ? <>
                          {label} {birr(pool[0].amount_due)} → {birr(String(each))}{pool.length > 1 ? " each" : ""}
                          {pool.length > 1 && Math.abs(last - each) > 0.005 && <> (last {birr(String(last))})</>}
                        </>
                      : <>the remaining {pool.length === 1 ? "visit holds" : "visits hold"} only {birr(String(poolTotal))} — not enough</>}
                  </span>
                </span>
              </label>
              <label className={cn("flex cursor-pointer items-start gap-2 rounded-md border p-2 text-xs",
                mode === "total" ? "border-brand bg-brand/5" : "hover:bg-muted")}>
                <input type="radio" className="mt-0.5" checked={mode === "total"} onChange={() => setMode("total")} />
                <span>
                  <b>{delta > 0 ? "On top of" : "Off"} the course</b> — total becomes {birr(String(courseTotal + delta))}
                  <span className="mt-0.5 block text-muted-foreground">{label} unchanged</span>
                </span>
              </label>
            </div>
          )}
        </div>
      )}

      <div className="flex flex-wrap gap-2">
        <Button size="sm" loading={save.isPending} disabled={next < 0 || Math.abs(delta) < 0.005}
          onClick={() => save.mutate()}>Save fee</Button>
        <Button size="sm" variant="outline" onClick={onCancel}>Cancel</Button>
      </div>
    </div>
  );
}

// --- the step ----------------------------------------------------------------

export function VisitPaymentStep({ patientId, plan, session, canCollect, editable, onChanged }: {
  patientId: string; plan: Plan; session: Session; canCollect: boolean; editable: boolean; onChanged: () => void;
}) {
  const stage = feeStage(session);
  const [editing, setEditing] = useState(false);
  const [promise, setPromise] = useState(session.pay_later_note ?? "");

  // While the money is with the cashier the dentist should not have to refresh to
  // find out it has been paid — the step advances on its own.
  useEffect(() => {
    if (stage !== "atCashier") return;
    const t = setInterval(onChanged, 6000);
    return () => clearInterval(t);
  }, [stage, onChanged]);

  const run = (fn: () => Promise<unknown>, msg: string) => ({
    mutationFn: fn,
    onSuccess: () => { toast.success(msg); onChanged(); },
    onError: (e: unknown) => toast.error(e instanceof AppError ? e.message : "That didn't work"),
  });
  const bill = useMutation(run(() => collectSession(patientId, session.id), "Sent to the cashier"));
  const pull = useMutation(run(() => uncollectSession(patientId, session.id), "Pulled back from the cashier"));
  const later = useMutation(run(() => setPayLater(patientId, session.id, { on: true, note: promise.trim() }), "Recorded as pay later"));
  const undoLater = useMutation(run(() => setPayLater(patientId, session.id, { on: false, note: "" }), "Promise removed"));

  const payLaterButton = (
    <Button variant="ghost" size="sm" className="text-muted-foreground"
      loading={later.isPending} onClick={() => later.mutate()}>
      Treat now, pay later
    </Button>
  );

  return (
    <div className="space-y-3 rounded-md border bg-muted/20 p-3">
      <Pipeline stage={stage} />
      <CourseRecap plan={plan} current={session} />

      {editing ? (
        <FeeEditor patientId={patientId} plan={plan} session={session}
          onDone={() => { setEditing(false); onChanged(); }} onCancel={() => setEditing(false)} />
      ) : (
        <div className="rounded-md border bg-card p-3">
          {stage === "unpaid" && (
            <>
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                <span className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">This visit's fee</span>
                <span className="tabular-nums text-lg font-bold">{birr(session.amount_due)}</span>
                {editable && (
                  <Button variant="outline" size="sm" className="h-7 px-2 text-xs" onClick={() => setEditing(true)}>
                    <Pencil className="h-3 w-3" /> Change
                  </Button>
                )}
              </div>
              <p className="mt-0.5 text-xs text-muted-foreground">Nothing has been billed for it yet.</p>
              <div className="mt-3 flex flex-wrap items-center gap-2">
                {canCollect && (
                  <Button loading={bill.isPending} onClick={() => bill.mutate()}>
                    <HandCoins className="h-4 w-4" /> Send to cashier
                  </Button>
                )}
                {payLaterButton}
              </div>
            </>
          )}

          {stage === "atCashier" && (
            <>
              <div className="flex flex-wrap items-center gap-2">
                <Loader2 className="h-4 w-4 animate-spin text-amber-600" />
                <span className="tabular-nums text-lg font-bold text-amber-700">{birr(session.amount_due)}</span>
                <span className="text-sm font-medium text-amber-800">is with the cashier</span>
              </div>
              <p className="mt-0.5 text-xs text-muted-foreground">
                Send the patient to the desk. This updates on its own.
              </p>
              <div className="mt-3 flex flex-wrap items-center gap-2">
                {canCollect && (
                  <Button variant="outline" size="sm" loading={pull.isPending} onClick={() => pull.mutate()}>
                    <Undo2 className="h-4 w-4" /> Pull back from cashier
                  </Button>
                )}
                {payLaterButton}
              </div>
            </>
          )}

          {stage === "promised" && (
            <>
              <div className="flex flex-wrap items-center gap-2">
                <TriangleAlert className="h-4 w-4 text-amber-600" />
                <span className="text-sm font-medium text-amber-900">
                  Owed after this visit — <span className="tabular-nums font-bold">{birr(session.amount_due)}</span>
                </span>
              </div>
              <div className="mt-2 space-y-1.5">
                <Label htmlFor="promise" className="text-xs">Promised by (optional)</Label>
                <Input id="promise" value={promise} onChange={(e) => setPromise(e.target.value)}
                  onBlur={() => { if (promise.trim() !== (session.pay_later_note ?? "")) later.mutate(); }}
                  placeholder="Next visit · end of the month · after salary" className="h-8 max-w-sm text-xs" />
                <p className="text-xs text-muted-foreground">
                  Shows in Unbilled treatment until it is collected. Nothing is written off.
                </p>
              </div>
              <div className="mt-3 flex flex-wrap items-center gap-2">
                <Button variant="outline" size="sm" loading={undoLater.isPending} onClick={() => undoLater.mutate()}>
                  <Undo2 className="h-4 w-4" /> Undo
                </Button>
                {canCollect && (
                  <Button size="sm" loading={bill.isPending} onClick={() => bill.mutate()}>
                    <HandCoins className="h-4 w-4" /> Send to cashier
                  </Button>
                )}
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}

/** Once recording, the money collapses to one line that stays in view. */
export function FeeStrip({ session, planTitle }: { session: Session; planTitle: string }) {
  const stage = feeStage(session);
  const meta = {
    paid: { label: "Paid", cls: "bg-emerald-600 text-white" },
    atCashier: { label: "At cashier", cls: "bg-amber-500 text-white" },
    promised: { label: "Pay later", cls: "bg-amber-100 text-amber-900 border border-amber-300" },
    unpaid: { label: "Unpaid", cls: "bg-destructive text-destructive-foreground" },
  }[stage];
  return (
    <div className="flex flex-wrap items-center gap-2 rounded-md border bg-muted/30 px-3 py-1.5 text-xs">
      <span className={cn("rounded-full px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide", meta.cls)}>
        {meta.label}
      </span>
      <span className="tabular-nums font-semibold">{birr(session.amount_due)}</span>
      <span className="text-muted-foreground">· {planTitle} · visit {session.seq}</span>
    </div>
  );
}
