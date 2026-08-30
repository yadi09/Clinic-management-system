// Work that was done and never billed, shown where the work is.
//
// The money was already correct — the banner said "Owes 22,000 ETB" and the course
// card said "2,000 owed now". Neither said WHAT, and neither offered the button. So a
// dentist opening a patient mid-course saw a number they could not account for: the
// 2,000 was an X-ray taken at visit 3, and the only place in the product that named
// it was the clinic-wide report on another page.
//
// An extra is the case that hides best. It belongs to a visit, so it is invisible
// until that visit is opened, and it survives the visit being paid — visit 3 settled
// at 6,000 while the X-ray taken during it stayed unbilled. Anything owed has to be
// legible from the chair, next to the treatment it was for, with the one button that
// deals with it.
//
// Same shape as Deposit.tsx on purpose: one selector, two views (a callout for the
// chair, rows for the money panel), so the two cannot disagree about what is owed.
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { ChevronRight, HandCoins, Receipt } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { toast } from "@/components/ui/sonner";
import { cn } from "@/lib/utils";
import { AppError } from "@/lib/api-client";
import { collectSession, type Plan, type Session } from "@/features/dental/api";
import { invalidateDental } from "@/features/dental/invalidate";
import { birr, isBillable, num } from "@/features/dental/money";

interface Opts {
  /** Ids another surface is already showing — never ask for the same money twice. */
  exclude?: Set<string>;
  /** Count an unpaid down payment as owed. Off by default; see owedOnPlan. */
  withDeposit?: boolean;
}

/** One thing that was delivered, is owed, and has no charge behind it. */
export interface OwedItem {
  sessionId: string;
  /** Which course it belongs to. A patient can have several, and they are very
   *  often called the same thing — "Root canal" three times over. Without this the
   *  chair cannot tell a debt on THIS course from a debt on another one. */
  planId: string;
  planStart: string;
  planTitle: string;
  /** The visit to open when the row is clicked. A debt names work; the work is
   *  somewhere, and a row that names it without going there makes the reader hunt.
   *  An extra opens the visit it was added to; a down payment opens the first visit
   *  of its course, because a deposit has no visit of its own. */
  openSessionId?: string;
  /** How it reads to a human. Mirrors the server's dental.SessionDesc. */
  label: string;
  amount: string;
  /** Paid then given back — owed again, and it must not read as "never billed". */
  refunded: boolean;
}

/**
 * Everything this course is owed for and has never billed: a delivered visit with no
 * charge, an extra taken during one, and — only where asked for — the down payment.
 *
 * Whatever another surface is already showing must be passed in `exclude`. Listing a
 * debt twice is how a clinic starts believing it is owed twice.
 */
export function owedOnPlan(plan: Plan, opts?: Opts): OwedItem[] {
  if (plan.status === "cancelled") return [];
  const { exclude, withDeposit } = opts ?? {};
  const out: OwedItem[] = [];
  // The deposit is included only where nothing else is showing it. On the money panel
  // its own callout sits directly above; in the cockpit it is shown for the focused
  // course but NOT for the others, which is how 20,000 ETB owed on a second course
  // stayed invisible while treating the first.
  const dep = plan.deposit;
  if (withDeposit && dep && !exclude?.has(dep.id) && num(dep.amount_due) > 0.005
      && (dep.payment === "unpaid" || dep.payment === "refunded")) {
    out.push({
      sessionId: dep.id, planId: plan.id, planStart: plan.start_date,
      openSessionId: plan.sessions.find((x) => x.status !== "cancelled")?.id,
      planTitle: plan.title, label: "down payment",
      amount: dep.amount_due, refunded: dep.payment === "refunded",
    });
  }
  const live = plan.sessions.filter((s) => s.status !== "cancelled");
  for (const s of live) {
    // The visit itself: only once it has actually happened. A booked visit is not a
    // debt, and offering to bill one charges a patient for treatment they have not had.
    if (s.status === "done" && isBillable(s) && !exclude?.has(s.id)) {
      out.push({
        sessionId: s.id,
        planId: plan.id,
        planStart: plan.start_date,
        openSessionId: s.id,
        planTitle: plan.title,
        label: `session ${s.seq} of ${plan.session_count}`,
        amount: s.amount_due,
        refunded: s.payment === "refunded",
      });
    }
    for (const ex of s.extras ?? []) {
      if (ex.status === "cancelled" || !isBillable(ex) || exclude?.has(ex.id)) continue;
      out.push({
        sessionId: ex.id,
        planId: plan.id,
        planStart: plan.start_date,
        openSessionId: s.id,
        planTitle: plan.title,
        label: `${ex.service_name || "extra treatment"} added at visit ${s.seq}`,
        amount: ex.amount_due,
        refunded: ex.payment === "refunded",
      });
    }
  }
  return out;
}

/** The same question across every course the patient has. */
export function owedForPatient(plans: Plan[], opts?: Opts): OwedItem[] {
  return plans.flatMap((p) => owedOnPlan(p, opts));
}

/** Everything the cockpit already deals with itself, so nothing is reported twice:
 *  the focused visit's own fee (the payment step), its extras (listed under it), and
 *  its course's down payment (the callout above). */
export function coveredByCockpit(session: Session, plan: Plan): Set<string> {
  const ids = [session.id, ...(session.extras ?? []).map((e) => e.id)];
  if (plan.deposit) ids.push(plan.deposit.id);
  return new Set(ids);
}

export function owedTotal(items: OwedItem[]): number {
  return items.reduce((a, i) => a + num(i.amount), 0);
}

function useSendToCashier(patientId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (sessionId: string) => collectSession(patientId, sessionId),
    onSuccess: () => {
      toast.success("Sent to the cashier");
      invalidateDental(qc, patientId);
    },
    onError: (e) => toast.error(e instanceof AppError ? e.message : "Could not send it to the cashier"),
  });
}

/**
 * The chairside callout: work that has been given away unless someone bills it.
 *
 * Deliberately quieter than the deposit's callout — that one blocks a course from
 * starting, this one is a debt already incurred — but still impossible to scroll past.
 */
export function UnbilledCallout({ patientId, items, canCollect, compact, focusedPlanId, onOpen }: {
  patientId: string;
  items: OwedItem[];
  canCollect: boolean;
  compact?: boolean;
  /** Open the visit a debt is for. Without it the row names work the reader then
   *  has to go and find, which on a patient with three courses is a search. */
  onOpen?: (sessionId: string) => void;
  /** The course being treated. Anything owed on a DIFFERENT course is still shown —
   *  that is the point of the callout — but it has to be marked as such. */
  focusedPlanId?: string;
}) {
  const send = useSendToCashier(patientId);
  if (items.length === 0) return null;

  return (
    <div className={cn("rounded-lg border border-l-4 border-l-destructive bg-destructive/5 px-3",
      compact ? "py-2" : "py-2.5")}>
      <p className="flex flex-wrap items-center gap-x-2 text-sm font-semibold text-destructive">
        <Receipt className="h-4 w-4 shrink-0" />
        {birr(owedTotal(items))} has not been billed
      </p>
      <p className="mt-0.5 text-xs text-muted-foreground">
        Work already done, or a course already agreed — no charge exists for it yet. Sending it to
        the desk is what turns it into money.
      </p>
      <div className="mt-2 space-y-1.5">
        {items.map((it) => {
          // A patient with three courses all called "Root canal" made this row read
          // as if it were about the visit in the chair: "Root canal · session 1 of 5,
          // 700 ETB" beside a visit worth 500. The money was right and owed; it just
          // belonged to a different course, and nothing on the row said so.
          const elsewhere = !!focusedPlanId && it.planId !== focusedPlanId;
          const open = onOpen && it.openSessionId ? () => onOpen(it.openSessionId!) : undefined;
          const text = (
            <span className={cn("min-w-0 truncate", open && "group-hover:underline")}>
              <span className="text-muted-foreground">{it.planTitle} · </span>{it.label}
            </span>
          );
          const mark = elsewhere ? (
            <span className="shrink-0 whitespace-nowrap rounded-full bg-amber-100 px-2 py-0.5 text-[11px] font-semibold text-amber-800">
              another course · from {startedOn(it.planStart)}
            </span>
          ) : null;
          return (
          <div key={it.sessionId} className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm">
            {open ? (
              <button type="button" onClick={open} title="Open this visit"
                className="group flex min-w-0 flex-1 items-center gap-1.5 rounded text-left">
                {text}{mark}
                <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground opacity-60 group-hover:opacity-100" />
              </button>
            ) : (
              <span className="flex min-w-0 flex-1 items-center gap-1.5">{text}{mark}</span>
            )}
            <span className="shrink-0 tabular-nums font-semibold">{birr(it.amount)}</span>
            {it.refunded && <Badge variant="destructive">Refunded — owed again</Badge>}
            {canCollect && (
              <Button size="sm" variant="outline" className="h-7 shrink-0 px-2 text-xs"
                loading={send.isPending && send.variables === it.sessionId}
                onClick={() => send.mutate(it.sessionId)}>
                <HandCoins className="h-3.5 w-3.5" /> Send to cashier
              </Button>
            )}
          </div>
          );
        })}
      </div>
    </div>
  );
}

const startedOn = (iso?: string) =>
  iso ? new Date(iso).toLocaleDateString(undefined, { day: "numeric", month: "short" }) : "an earlier date";

/** The money-panel version: the same facts, indented under their course, for a reader
 *  who is auditing rather than treating. */
export function UnbilledRows({ patientId, items, canCollect }: {
  patientId: string; items: OwedItem[]; canCollect: boolean;
}) {
  const send = useSendToCashier(patientId);
  if (items.length === 0) return null;

  return (
    <div className="mt-2 space-y-1">
      {items.map((it) => (
        <div key={it.sessionId} className="ml-3 flex flex-wrap items-center gap-x-2 gap-y-1 border-l pl-3 text-xs">
          <span className="min-w-0 truncate">{it.label}</span>
          <span className="tabular-nums font-semibold">{birr(it.amount)}</span>
          <Badge variant="destructive">{it.refunded ? "Refunded — owed again" : "Owed now"}</Badge>
          {canCollect && (
            <Button size="sm" variant="outline" className="touch-hit h-6 px-2 text-xs"
              loading={send.isPending && send.variables === it.sessionId}
              onClick={() => send.mutate(it.sessionId)}>
              Send to cashier
            </Button>
          )}
        </div>
      ))}
    </div>
  );
}
