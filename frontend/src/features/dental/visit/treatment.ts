// The words the visit card uses for a treatment's visits, decided in one place.
//
// Each panel used to work out "missed", "owed" and "visit N of M" for itself, with
// small differences, so the same visit could read three ways on one page. The card
// takes every one of those answers from here.
import type { Plan, Session } from "@/features/dental/api";

/** A treatment's visits as the patient lives them: not cancelled, the ones done
 *  first, then the ones still to do, each in date order. Done first because a
 *  treatment goes step by step: a missed visit 2 recorded today is still the second
 *  step, even though visit 3's (also missed) booked day is earlier. By date alone it
 *  would turn into visit 3 the moment it was saved. Date rather than seq inside each
 *  group, because a rescheduled visit keeps its original number. */
export function liveVisits(plan: Plan): Session[] {
  const rank = (s: Session) => (s.status === "done" ? 0 : 1);
  return plan.sessions
    .filter((s) => s.status !== "cancelled")
    .sort((a, b) => rank(a) - rank(b) || a.scheduled_date.localeCompare(b.scheduled_date) || a.seq - b.seq);
}

/** "Visit 2 of 5": the visit's place in that order, so the numbers on the card
 *  always run 1, 2, 3 left to right, even after a visit has been moved. */
export function visitPosition(plan: Plan, sessionId: string): { position: number; count: number } {
  const live = liveVisits(plan);
  return { position: live.findIndex((s) => s.id === sessionId) + 1, count: live.length };
}

/** The next step of the treatment: its first visit not yet done. */
export function nextStep(plan: Plan): Session | undefined {
  return liveVisits(plan).find((s) => s.status === "planned");
}

export function missedVisits(plan: Plan, todayISO: string): Session[] {
  return liveVisits(plan).filter((s) => s.status === "planned" && s.scheduled_date < todayISO);
}

export type VisitWord = "Done" | "Missed" | "Today" | "Next" | "Later";

/** What has happened to a visit, in one word. "Next" is the first visit still to
 *  come; the ones after it are "Later". */
export function visitWord(plan: Plan, s: Session, todayISO: string): VisitWord {
  if (s.status === "done") return "Done";
  if (s.scheduled_date < todayISO) return "Missed";
  if (s.scheduled_date === todayISO) return "Today";
  const firstUpcoming = liveVisits(plan).find((v) => v.status === "planned" && v.scheduled_date > todayISO);
  return firstUpcoming?.id === s.id ? "Next" : "Later";
}

export type PayTone = "good" | "wait" | "owed" | "plain";

/** A visit's money in two words. "Paid ahead" is a paid visit not yet given, which
 *  is otherwise invisible: the money is in, the treatment is still owed to the
 *  patient. "Owed" is only for treatment given and not paid for. */
export function payWord(s: Session): { label: string; tone: PayTone } {
  switch (s.payment) {
    case "paid":
      return s.status === "done" ? { label: "Paid", tone: "good" } : { label: "Paid ahead", tone: "good" };
    case "billed":
      return { label: "At cashier", tone: "wait" };
    case "waived":
      return { label: "Free of charge", tone: "plain" };
    case "refunded":
      return { label: "Refunded", tone: "plain" };
    default:
      if (s.status === "done") return { label: "Owed", tone: "owed" };
      if (s.pay_later) return { label: "Pay later", tone: "wait" };
      return { label: "Not paid", tone: "plain" };
  }
}

/** The treatment's money, from the server's ledger figures (one definition, the
 *  same as the money panel). Left to pay leaves out what is already at the cashier,
 *  as the treatments panel does, so the two never disagree. */
export function planMoney(plan: Plan): { paid: number; total: number; atCashier: number; left: number } {
  const n = (v?: string) => Number(v ?? 0) || 0;
  const paid = n(plan.money.collected);
  const total = n(plan.money.planned);
  const atCashier = n(plan.money.at_cashier);
  return { paid, total, atCashier, left: Math.max(0, total - paid - atCashier) };
}

/** Visits that are paid for but not given yet, by their place in the treatment. */
export function paidAhead(plan: Plan): number[] {
  return liveVisits(plan)
    .map((s, i) => ({ s, n: i + 1 }))
    .filter(({ s }) => s.status === "planned" && s.payment === "paid")
    .map(({ n }) => n);
}

/** "2", "2 and 3", "2, 3 and 4". */
export function joinNumbers(ns: number[]): string {
  if (ns.length <= 1) return ns.join("");
  return `${ns.slice(0, -1).join(", ")} and ${ns[ns.length - 1]}`;
}
