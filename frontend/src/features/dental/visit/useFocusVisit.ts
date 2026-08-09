// Which visit is this page about?
//
// The old page answered that by FILTERING: a date scope defaulting to "today" plus
// three plan tabs, applied in that order. For any patient not booked today — which
// is every patient on every day between their appointments — the filter emptied the
// "in progress" tab, the auto-picker fell through to "history", and the dentist
// landed on last year's finished scaling with the escape control hidden on that very
// tab. The running root canal was two clicks and a guess away, and nothing on screen
// said the page was being filtered at all.
//
// This RESOLVES instead. It walks a ladder of candidates and always reports which
// rung it landed on, so the answer can be read and argued with rather than guessed.
// A resolver that picks wrong but says so is recoverable; a filter that silently
// hides everything is not.
import { useMemo } from "react";

import type { Plan, Session } from "@/features/dental/api";

export type Rung = "chosen" | "today" | "overdue" | "next" | "lastDone" | "none";

export interface FocusVisit {
  session: Session;
  plan: Plan;
  /** 1-based position within the plan, for "session 4 of 6". */
  seq: number;
  count: number;
}

export interface FocusResult {
  focus: FocusVisit | null;
  rung: Rung;
  /** Why this one — shown on the cockpit so the choice is never silent. */
  label: string;
  /** The other live courses, so a demoted candidate is named rather than hidden. */
  others: FocusVisit[];
}

const isLive = (p: Plan) => p.status === "active";

/** One entry per other course — its next open visit, not all of them. */
function dedupeByPlan(list: FocusVisit[]): FocusVisit[] {
  const seen = new Set<string>();
  return list.filter((v) => (seen.has(v.plan.id) ? false : (seen.add(v.plan.id), true)));
}
const isOpen = (s: Session) => s.status === "planned";

/** Every still-open session across every active plan, earliest first. */
function openVisits(plans: Plan[]): FocusVisit[] {
  const out: FocusVisit[] = [];
  for (const plan of plans) {
    if (!isLive(plan)) continue;
    for (const session of plan.sessions) {
      if (!isOpen(session)) continue;
      out.push({ session, plan, seq: session.seq, count: plan.session_count });
    }
  }
  return out.sort((a, b) => a.session.scheduled_date.localeCompare(b.session.scheduled_date));
}

/**
 * Resolve the visit this page is about.
 *
 * The ladder, in order:
 *   0. an explicit ?visit= override — the dentist's own choice always wins
 *   1. a session booked for today
 *   2. the most overdue open session (the patient who came back late)
 *   3. the next open session (the patient who came early, or is just being reviewed)
 *   4. the most recent completed session (a finished course, or a walk-in)
 *   5. nothing at all — a patient with no treatment yet
 */
export function resolveFocus(plans: Plan[], todayISO: string, chosenId?: string | null): FocusResult {
  const open = openVisits(plans);

  // "Others" means the patient's OTHER courses. Siblings within the focused plan are
  // already drawn on the course rail, and listing them again pushed a genuinely
  // separate open treatment out of the visible slice.
  const pick = (f: FocusVisit | undefined, rung: Rung, label: string): FocusResult | null =>
    f ? { focus: f, rung, label, others: dedupeByPlan(open.filter((o) => o.plan.id !== f.plan.id)) } : null;

  if (chosenId) {
    const chosen = open.find((v) => v.session.id === chosenId)
      // An explicit choice may point at an already-done session — honour it anyway.
      ?? plans.flatMap((plan) => plan.sessions.map((session) => ({ session, plan, seq: session.seq, count: plan.session_count })))
        .find((v) => v.session.id === chosenId);
    const r = pick(chosen, "chosen", "Selected visit");
    if (r) return r;
    // Falls through when the id is stale (session deleted or moved to another
    // patient); resolving normally beats rendering an error at the top of the page.
  }

  const today = pick(open.find((v) => v.session.scheduled_date === todayISO), "today", "Booked today");
  if (today) return today;

  const overdue = open.filter((v) => v.session.scheduled_date < todayISO);
  if (overdue.length > 0) {
    // The MOST RECENT overdue one, not the oldest. A course abandoned six months ago
    // still has an open session; picking the longest-waiting visit would let it
    // capture the page ahead of the treatment the patient is actually here for.
    const r = pick(overdue[overdue.length - 1], "overdue", "Overdue");
    if (r) return r;
  }

  const next = pick(open.find((v) => v.session.scheduled_date > todayISO), "next", "Next scheduled");
  if (next) return next;

  // Nothing open. Show the last thing that actually happened, so the page still
  // opens on this patient's treatment rather than on an empty state.
  const done = plans
    .flatMap((plan) => plan.sessions.map((session) => ({ session, plan, seq: session.seq, count: plan.session_count })))
    .filter((v) => v.session.status === "done")
    .sort((a, b) => b.session.scheduled_date.localeCompare(a.session.scheduled_date));
  const last = pick(done[0], "lastDone", "Most recent visit");
  if (last) return last;

  return { focus: null, rung: "none", label: "No treatment scheduled", others: [] };
}

export function useFocusVisit(plans: Plan[], todayISO: string, chosenId?: string | null): FocusResult {
  return useMemo(() => resolveFocus(plans, todayISO, chosenId), [plans, todayISO, chosenId]);
}

/** How late or early this visit is, in the words a clinician would use. */
export function visitTiming(dateISO: string, todayISO: string): { days: number; text: string } {
  const days = Math.round(
    (new Date(`${dateISO}T00:00:00`).getTime() - new Date(`${todayISO}T00:00:00`).getTime()) / 86_400_000,
  );
  if (days === 0) return { days, text: "today" };
  if (days === 1) return { days, text: "tomorrow" };
  if (days === -1) return { days, text: "yesterday" };
  return { days, text: days > 0 ? `in ${days} days` : `${Math.abs(days)} days ago` };
}
