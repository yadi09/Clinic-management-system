// The money vocabulary, defined once.
//
// The dental surfaces currently say the same thing eight ways — "Due now", "Owes",
// "Outstanding", "Awaiting payment", "Needs payment", "Not due yet", "Bill",
// "Collect" — across the banner, the balance card, the plan strip, the session row
// and the payment history. Two of those tiles are both labelled "Paid" and are
// computed from different sources, so after any refund they disagree on one screen.
// A patient asking "how much do I owe?" can be given four different answers
// depending on which card the staff member happens to read.
//
// This module fixes the WORDS. It does not yet fix the NUMBERS: the server still
// folds refunded and voided charges into "unpaid", and the per-plan collected figure
// is summed from `amount_due` rather than from the charge ledger. Wiring these labels
// to the current figures would turn four honest disagreeing numbers into one
// confident wrong one, which is worse. So the states below are the target vocabulary,
// adopted for display only, and `refunded` / `waived` stay unreachable until the
// server can actually distinguish them.

/** What is true of one session's fee, from the payer's point of view. */
export type MoneyState =
  | "owedNow"    // service given, nothing queued — the actionable debt
  | "atCashier"  // charge raised and pending; the desk can settle it
  | "paid"       // settled
  | "notYetDue"  // scheduled but not yet delivered
  | "refunded"   // settled then reversed — NOT the same as never paid
  | "waived"     // deliberately free of charge
  | "cancelled"; // called off — never owed, never billable

export interface MoneyMeta {
  label: string;
  /** Second-person explanation, for tooltips and empty states. */
  hint: string;
  /** Maps to the Badge variants in components/ui/badge.tsx. */
  variant: "default" | "brand" | "success" | "warning" | "destructive" | "outline";
  /** Does this amount belong in the "what does the patient owe today" total? */
  countsAsOwed: boolean;
}

export const MONEY: Record<MoneyState, MoneyMeta> = {
  owedNow: {
    label: "Owed now",
    hint: "Treatment was given and nothing has been billed for it yet.",
    variant: "destructive",
    countsAsOwed: true,
  },
  atCashier: {
    // Deliberately not "owed": it is already queued, and counting it twice is why
    // the desk asks patients for money they have just been sent to pay.
    label: "At cashier",
    hint: "Already sent to the cashier — the patient pays at the desk.",
    variant: "warning",
    countsAsOwed: false,
  },
  paid: { label: "Paid", hint: "Settled in full.", variant: "success", countsAsOwed: false },
  notYetDue: {
    label: "Not yet due",
    hint: "Scheduled for a future visit. Nothing is owed until the treatment happens.",
    variant: "outline",
    countsAsOwed: false,
  },
  refunded: {
    label: "Refunded",
    hint: "Paid, then reversed. The money is back with the patient.",
    variant: "outline",
    countsAsOwed: false,
  },
  waived: {
    label: "Free of charge",
    hint: "Deliberately not charged for. Nothing is owed and nothing can be billed.",
    variant: "brand",
    countsAsOwed: false,
  },
  cancelled: {
    label: "Cancelled",
    hint: "This visit was called off. Nothing is owed for it.",
    variant: "outline",
    countsAsOwed: false,
  },
};

/** ETB, grouped, no decimals unless the amount has them. The clinic prices in whole birr. */
export function birr(amount: string | number | undefined): string {
  const n = typeof amount === "number" ? amount : Number(amount || 0);
  return `${n.toLocaleString(undefined, { maximumFractionDigits: 2 })} ETB`;
}

/**
 * Derive the display state of one session.
 *
 * `payment` is the server's `unpaid | billed | paid`. Note the deliberate gap: the
 * server maps refunded and voided charges to "unpaid", so this cannot yet return
 * `refunded` — see the header. Callers must not invent it.
 */
export function sessionMoneyState(s: {
  status: string;
  payment: string;
  pay_later?: boolean;
}): MoneyState {
  // Checked before payment: a cancelled session that had been deferred to pay-later
  // would otherwise land in "owed now" and be chased as a real debt.
  if (s.status === "cancelled") return "cancelled";
  if (s.payment === "paid") return "paid";
  if (s.payment === "billed") return "atCashier";
  // Unpaid. Whether that is a debt turns on whether the work actually happened —
  // NOT on whether the date has passed. A session booked for last Tuesday that the
  // patient never attended is a missed appointment to chase, not money owed; billing
  // it would charge for treatment nobody received.
  const delivered = s.status === "done" || s.pay_later === true;
  return delivered ? "owedNow" : "notYetDue";
}
