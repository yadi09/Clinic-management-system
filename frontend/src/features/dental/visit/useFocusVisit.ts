// Which visit is this page about?
//
// The old page answered that by FILTERING: a date scope defaulting to "today" plus
// three plan tabs, applied in that order. For any patient not booked today the
// filter emptied the "in progress" tab and the dentist landed on last year's
// finished scaling. This RESOLVES instead, and always says what it chose.
//
// It works in two steps, the way a dentist does:
//   1. Which TREATMENT? The one booked today; otherwise the one whose next visit is
//      closest to today, so a treatment abandoned months ago cannot take the card
//      from the one the patient is actually here for. Every treatment in progress
//      is shown as a tab, so the choice is visible and one click to change.
//   2. Which VISIT of it? Its next step: the first visit not yet done. A dentist
//      continues a root canal from where it stopped, not from the latest missed date.
import { useMemo } from "react";

import type { Plan, Session } from "@/features/dental/api";
import { liveVisits, missedVisits, nextStep, visitPosition } from "@/features/dental/visit/treatment";

export type Rung = "chosen" | "today" | "missed" | "next" | "lastDone" | "none";

export interface FocusVisit {
  session: Session;
  plan: Plan;
  /** Place in the treatment, in date order: "visit 2 of 5". */
  position: number;
  count: number;
}

/** One treatment in progress, for the tabs. */
export interface Treatment {
  plan: Plan;
  /** Its first visit not yet done, if any. */
  next?: Session;
  missed: Session[];
  bookedToday: boolean;
}

export interface FocusResult {
  focus: FocusVisit | null;
  rung: Rung;
  /** Why this one: never a silent choice. */
  label: string;
  /** Every treatment in progress, in a stable order, so tabs never jump about. */
  treatments: Treatment[];
}

const isActive = (p: Plan) => p.status === "active";

function asFocus(plan: Plan, session: Session): FocusVisit {
  return { plan, session, ...visitPosition(plan, session.id) };
}

function daysApart(a: string, b: string): number {
  return Math.abs(new Date(`${a}T00:00:00`).getTime() - new Date(`${b}T00:00:00`).getTime()) / 86_400_000;
}

export function resolveFocus(plans: Plan[], todayISO: string, chosenId?: string | null): FocusResult {
  const treatments: Treatment[] = plans
    .filter((p) => isActive(p) && liveVisits(p).length > 0)
    .sort((a, b) => a.start_date.localeCompare(b.start_date) || a.created_at.localeCompare(b.created_at))
    .map((plan) => ({
      plan,
      next: nextStep(plan),
      missed: missedVisits(plan, todayISO),
      bookedToday: liveVisits(plan).some((s) => s.status === "planned" && s.scheduled_date === todayISO),
    }));
  const result = (focus: FocusVisit | null, rung: Rung, label: string): FocusResult => ({ focus, rung, label, treatments });

  // 0. The dentist's own choice (?visit=) always wins, even a finished visit.
  if (chosenId) {
    for (const plan of plans) {
      const s = plan.sessions.find((v) => v.id === chosenId && v.status !== "cancelled");
      if (s) return result(asFocus(plan, s), "chosen", "Selected visit");
    }
    // A stale id (visit removed) falls through: resolving beats an error at the top.
  }

  // 1. A treatment with a visit booked today, and that visit.
  for (const t of treatments) {
    const s = liveVisits(t.plan).find((v) => v.status === "planned" && v.scheduled_date === todayISO);
    if (s) return result(asFocus(t.plan, s), "today", "Booked today");
  }

  // 2. The treatment whose next step is closest to today, and that next step.
  const withNext = treatments.filter((t) => t.next);
  if (withNext.length > 0) {
    const best = [...withNext].sort((a, b) =>
      daysApart(a.next!.scheduled_date, todayISO) - daysApart(b.next!.scheduled_date, todayISO)
      || b.plan.start_date.localeCompare(a.plan.start_date))[0];
    const s = best.next!;
    return s.scheduled_date < todayISO
      ? result(asFocus(best.plan, s), "missed", "Missed")
      : result(asFocus(best.plan, s), "next", "Next visit");
  }

  // 3. Nothing still to do: the last visit that happened, so the page opens on this
  //    patient's treatment rather than on an empty state.
  const done = plans
    .flatMap((plan) => plan.sessions.filter((s) => s.status === "done").map((s) => ({ plan, s })))
    .sort((a, b) => b.s.scheduled_date.localeCompare(a.s.scheduled_date));
  if (done[0]) return result(asFocus(done[0].plan, done[0].s), "lastDone", "Most recent visit");

  return result(null, "none", "No treatment in progress");
}

export function useFocusVisit(plans: Plan[], todayISO: string, chosenId?: string | null): FocusResult {
  return useMemo(() => resolveFocus(plans, todayISO, chosenId), [plans, todayISO, chosenId]);
}

/** How late or early a visit is, in the words a clinician would use. */
export function visitTiming(dateISO: string, todayISO: string): { days: number; text: string } {
  const days = Math.round(
    (new Date(`${dateISO}T00:00:00`).getTime() - new Date(`${todayISO}T00:00:00`).getTime()) / 86_400_000,
  );
  if (days === 0) return { days, text: "today" };
  if (days === 1) return { days, text: "tomorrow" };
  if (days === -1) return { days, text: "yesterday" };
  return { days, text: days > 0 ? `in ${days} days` : `${Math.abs(days)} days ago` };
}
