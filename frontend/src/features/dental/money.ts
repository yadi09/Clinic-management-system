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
    // The clinic's policy: the money went back, the treatment still happened, so it
    // is owed again. A muted "Refunded" chip said the opposite on the same screen as
    // a red balance demanding it.
    label: "Refunded — owed again",
    hint: "Paid, then given back. The treatment stands, so this is owed again.",
    variant: "destructive",
    countsAsOwed: true,
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
 * `payment` is the server's wire state. It carries `refunded` and `waived` only once
 * the server's projection ships; until then those branches simply never fire, which
 * is why this is safe to deploy first. It must never THROW on an unknown state — a
 * server that learns a new one before the client does must degrade to a readable
 * badge, not to a blank chairside record.
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
  if (s.payment === "waived") return "waived";
  // Paid, then given back. NOT the same as never paid: the treatment still happened,
  // so it stays visible rather than being silently written off.
  if (s.payment === "refunded") return "refunded";
  // Unpaid. Whether that is a debt turns on whether the work actually happened.
  //
  // pay_later is deliberately NOT part of this, and must match the server's
  // `delivered` exactly. Before the billing gate was removed, "pay later" was how the
  // record form got unlocked, so promises exist against visits that never happened —
  // Cure Dental has one for 4,000 ETB. Counting it here offered to bill a patient for
  // treatment they have not had.
  return s.status === "done" ? "owedNow" : "notYetDue";
}

/**
 * Can a charge be raised for this session?
 *
 * Mirrors the server's collect guard exactly. "unpaid" is the obvious case; a
 * REFUNDED session is billable too, because the money went back and the treatment
 * stands — the report offers "Bill again" for precisely this, and gating the button
 * on unpaid alone meant it was owed on every screen and billable on none.
 */
export function isBillable(s: { payment: string; amount_due?: string }): boolean {
  return (s.payment === "unpaid" || s.payment === "refunded") && Number(s.amount_due || 0) > 0;
}
