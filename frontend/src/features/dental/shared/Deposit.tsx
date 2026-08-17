// The down payment, where the money actually is.
//
// A deposit is due the moment the course is agreed — that is what makes it a
// deposit. But the only place it appeared was a small inline line on the Money
// panel, three clicks away from the screen the dentist is on. So a course could be
// created with 20,000 ETB owed up front and the chairside panel said nothing at
// all: the fee shown was the first visit's 700 ETB, the progress read "0 of 35,000",
// and there was no way from there to send the patient to the desk.
//
// Two surfaces, one piece of logic, on purpose. The callout is for the chair, where
// the answer is "send them to the desk now"; the row is for the money panel, where
// the reader is auditing. Both read the same state and fire the same mutation, so
// they cannot come to different conclusions about whether a patient owes 20,000 ETB.
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { HandCoins, Wallet } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { toast } from "@/components/ui/sonner";
import { cn } from "@/lib/utils";
import { AppError } from "@/lib/api-client";
import { collectSession, type Plan } from "@/features/dental/api";
import { invalidateDental } from "@/features/dental/invalidate";
import { birr, num } from "@/features/dental/money";

export type DepositStage = "unpaid" | "atCashier" | "paid";

/** The deposit worth showing, and where its money has got to. */
export function depositOf(plan: Plan): { id: string; amount: string; stage: DepositStage } | null {
  const d = plan.deposit;
  if (!d || num(d.amount_due) <= 0.005) return null;
  const stage: DepositStage =
    d.payment === "paid" || d.payment === "waived" ? "paid"
      : d.payment === "billed" ? "atCashier" : "unpaid";
  return { id: d.id, amount: d.amount_due, stage };
}

/** Is there anything left to do about this plan's deposit? */
export function depositOutstanding(plan: Plan): boolean {
  const d = depositOf(plan);
  return !!d && d.stage !== "paid";
}

function useSendToCashier(patientId: string, depositId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => collectSession(patientId, depositId),
    onSuccess: () => {
      toast.success("Down payment sent to the cashier");
      invalidateDental(qc, patientId);
    },
    onError: (e) => toast.error(e instanceof AppError ? e.message : "Could not send it to the cashier"),
  });
}

/**
 * The chairside callout: what is owed before this course starts, and the one
 * button that deals with it.
 *
 * Deliberately loud. It is the only money on the page that is due right now, and
 * the cost of missing it is a course of treatment started for free.
 */
export function DepositCallout({ patientId, plan, canCollect, compact }: {
  patientId: string; plan: Plan; canCollect: boolean;
  /** Slimmer, for while a visit is being recorded and space is tight. */
  compact?: boolean;
}) {
  const d = depositOf(plan);
  const send = useSendToCashier(patientId, d?.id ?? "");
  if (!d || d.stage === "paid") return null;

  const queued = d.stage === "atCashier";
  return (
    <div className={cn(
      "flex flex-wrap items-center gap-x-3 gap-y-2 rounded-lg border-l-4 px-3",
      compact ? "py-2" : "py-2.5",
      queued ? "border-amber-500 bg-amber-50" : "border-destructive bg-destructive/5",
    )}>
      <span className={cn("flex h-8 w-8 shrink-0 items-center justify-center rounded-full",
        queued ? "bg-amber-500/15 text-amber-700" : "bg-destructive/10 text-destructive")}>
        <Wallet className="h-4 w-4" />
      </span>
      <div className="min-w-0 flex-1">
        <p className={cn("text-sm font-semibold", queued ? "text-amber-900" : "text-destructive")}>
          Down payment {birr(d.amount)} {queued ? "is with the cashier" : "is due before this course starts"}
        </p>
        <p className={cn("text-xs", queued ? "text-amber-800" : "text-muted-foreground")}>
          {queued
            ? "Send the patient to the desk — the rest of the course is unaffected."
            : `Agreed up front for ${plan.title}. The visits are priced separately.`}
        </p>
      </div>
      {!queued && canCollect && (
        <Button size="sm" loading={send.isPending} onClick={() => send.mutate()}>
          <HandCoins className="h-4 w-4" /> Send to cashier
        </Button>
      )}
      {queued && <Badge variant="warning">Awaiting payment</Badge>}
    </div>
  );
}

/**
 * The money-panel row: the same fact, indented under its course, for a reader who
 * is checking rather than acting.
 */
export function DepositRow({ patientId, plan, canCollect }: {
  patientId: string; plan: Plan; canCollect: boolean;
}) {
  const d = depositOf(plan);
  const send = useSendToCashier(patientId, d?.id ?? "");
  if (!d) return null;

  const meta = {
    paid: { label: "Paid", variant: "success" as const },
    atCashier: { label: "At cashier", variant: "warning" as const },
    unpaid: { label: "Owed now", variant: "destructive" as const },
  }[d.stage];

  return (
    <div className="ml-3 flex flex-wrap items-center gap-x-2 gap-y-1 border-l pl-3 text-xs">
      <span className="text-muted-foreground">Down payment</span>
      <span className="tabular-nums font-semibold">{birr(d.amount)}</span>
      <Badge variant={meta.variant}>{meta.label}</Badge>
      {d.stage === "unpaid" && canCollect && (
        <Button size="sm" variant="outline" className="h-6 px-2 text-xs"
          loading={send.isPending} onClick={() => send.mutate()}>
          Send to cashier
        </Button>
      )}
    </div>
  );
}
