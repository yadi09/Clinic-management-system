// Everything that happened to this patient, and everything still booked, on one spine.
//
// This replaces a list of plans, each of which had to be expanded to see its visits,
// with one date-ordered sequence across every course. The question a clinician
// actually asks is "what has been done and what is next", not "which container is
// this visit filed under" — and with two concurrent courses the old shape made the
// answer require opening both and mentally interleaving them.
//
// Read-only, deliberately. The cockpit above is where a visit is recorded; this is
// where it is read. Making the reading surface editable is how a clinician reviewing
// history ends up overwriting it.
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { Stethoscope } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Segmented } from "@/components/ui/segmented";
import { cn } from "@/lib/utils";
import { DualDate, dayDiff, relativeDay } from "@/components/DualDate";
import { MONEY, birr, sessionMoneyState } from "@/features/dental/money";
import type { Plan, Session } from "@/features/dental/api";
import { useToothText } from "@/features/dental/toothNumbering";

interface Entry {
  session: Session;
  plan: Plan;
  /** Position within the live sessions of its own course, for "3 of 6". */
  n: number;
  of: number;
}

/** done · today · upcoming · missed — what the dot means, and what to do about it. */
function mark(e: Entry, todayISO: string) {
  const s = e.session;
  if (s.status === "cancelled") return { key: "cancelled", dot: "bg-muted-foreground/40", label: "Cancelled" };
  if (s.status === "done") {
    const settled = s.payment === "paid" || s.payment === "waived";
    return settled
      ? { key: "done", dot: "bg-emerald-500", label: "Done" }
      : { key: "unsettled", dot: "bg-amber-500", label: "Done · not settled" };
  }
  if (s.scheduled_date === todayISO) return { key: "today", dot: "bg-brand", label: "Today" };
  if (s.scheduled_date < todayISO) return { key: "missed", dot: "bg-rose-500", label: "Missed" };
  return { key: "planned", dot: "bg-border", label: "Booked" };
}

/**
 * How far out to look. A course can run two years, so the near-term visits — the
 * only ones anyone acts on this week — end up buried under a long tail.
 *
 * Windows, not frequencies: "every two weeks" describes how a course is scheduled,
 * which is already on the plan; it is not a way to look at a list.
 */
const WINDOWS = [
  { value: "7", label: "Week", days: 7 },
  { value: "30", label: "Month", days: 30 },
  { value: "90", label: "3 months", days: 90 },
  { value: "all", label: "All", days: Infinity },
] as const;
type WindowKey = (typeof WINDOWS)[number]["value"];

export function TimelinePanel({ patientId, plans, todayISO, onOpenVisit }: {
  patientId: string;
  plans: Plan[];
  todayISO: string;
  onOpenVisit: (sessionId: string) => void;
}) {
  // Remembered per patient, like the shelf panel: someone reviewing a long course
  // should not have to re-widen it on every visit to that patient.
  const winKey = `dental-tl-window:${patientId}`;
  const [win, setWin] = useState<WindowKey>("30");
  useEffect(() => {
    const saved = sessionStorage.getItem(winKey) as WindowKey | null;
    if (saved && WINDOWS.some((w) => w.value === saved)) setWin(saved);
  }, [winKey]);
  const pickWindow = (v: WindowKey) => { setWin(v); sessionStorage.setItem(winKey, v); };
  const { past, today, upcoming } = useMemo(() => {
    const all: Entry[] = [];
    for (const plan of plans) {
      const live = plan.sessions.filter((s) => s.status !== "cancelled");
      live.forEach((session, i) => all.push({ session, plan, n: i + 1, of: live.length }));
      // Cancelled visits still belong to the record — one may carry a charge, a note
      // or an image, and hiding it made that unreachable from anywhere on the page.
      // Shown struck through and out of the numbering, not deleted from history.
      for (const session of plan.sessions.filter((s) => s.status === "cancelled")) {
        all.push({ session, plan, n: 0, of: live.length });
      }
    }
    const byDate = (a: Entry, b: Entry) => a.session.scheduled_date.localeCompare(b.session.scheduled_date);
    // Ordered by DISTANCE FROM NOW, in both directions, so the list reads outwards
    // from today: what is happening now, then what is next, then what came before.
    // It previously put the farthest visit at the top of Upcoming — the reasoning was
    // that the nearest one should sit adjacent to the TODAY rule underneath it, which
    // is not how anyone reads a list.
    return {
      today: all.filter((e) => e.session.scheduled_date === todayISO).sort(byDate),
      upcoming: all.filter((e) => e.session.scheduled_date > todayISO).sort(byDate),
      past: all.filter((e) => e.session.scheduled_date < todayISO).sort((a, b) => byDate(b, a)),
    };
  }, [plans, todayISO]);

  // The window hides distance, never importance. A missed visit and an unsettled fee
  // are work someone still owes the patient — filtering them out of sight is how a
  // debt or a no-show gets forgotten, which is the opposite of the point.
  const days = WINDOWS.find((w) => w.value === win)!.days;
  const mustShow = (e: Entry) =>
    (e.session.status === "planned" && e.session.scheduled_date < todayISO) ||
    (e.session.status === "done" && MONEY[sessionMoneyState(e.session)].countsAsOwed);
  const inWindow = (e: Entry) => Math.abs(dayDiff(e.session.scheduled_date)) <= days;
  const keep = (e: Entry) => inWindow(e) || mustShow(e);

  const shownUpcoming = upcoming.filter(keep);
  // The most recent visit always survives: "what did I do last time" is the question
  // this panel exists to answer, whatever window is selected.
  const shownPast = past.filter((e, i) => i === 0 || keep(e));
  const hidden = (upcoming.length - shownUpcoming.length) + (past.length - shownPast.length);

  if (past.length === 0 && upcoming.length === 0 && today.length === 0) {
    return (
      <div className="rounded-lg border border-dashed p-8 text-center">
        <Stethoscope className="mx-auto h-6 w-6 text-muted-foreground" />
        <p className="mt-2 text-sm font-medium">Nothing on the timeline yet</p>
        <p className="mt-1 text-sm text-muted-foreground">
          Create a treatment plan and its visits appear here, newest first.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-1">
      <div className="flex flex-wrap items-center justify-between gap-2 pb-1">
        <p className="text-xs text-muted-foreground">
          Booked and completed visits, nearest first.
        </p>
        <Segmented
          size="sm"
          ariaLabel="How far ahead and back to show"
          value={win}
          onChange={(v) => pickWindow(v as WindowKey)}
          options={WINDOWS.map((w) => ({ value: w.value, label: w.label }))}
        />
      </div>

      {/* Today leads: it is the only section that is about right now. */}
      {today.length > 0 && (
        <>
          <SectionLabel tone="brand">Today · <DualDate iso={todayISO} /></SectionLabel>
          {today.map((e) => <Row key={e.session.id} e={e} todayISO={todayISO} onOpen={onOpenVisit} />)}
        </>
      )}

      {shownUpcoming.length > 0 && (
        <>
          {/* Nearest first: the next visit is the one a clinician is looking for. */}
          <SectionLabel>Next{shownUpcoming.length > 1 ? ` · ${shownUpcoming.length} booked` : ""}</SectionLabel>
          {shownUpcoming.map((e) => <Row key={e.session.id} e={e} todayISO={todayISO} onOpen={onOpenVisit} />)}
        </>
      )}

      {shownPast.length > 0 && (
        <>
          <SectionLabel>Earlier · most recent first</SectionLabel>
          {shownPast.map((e) => <Row key={e.session.id} e={e} todayISO={todayISO} onOpen={onOpenVisit} />)}
        </>
      )}

      {/* Never let the window hide something silently. */}
      {hidden > 0 && (
        <button type="button" onClick={() => pickWindow("all")}
          className="mt-2 w-full rounded-md border border-dashed py-2 text-xs text-muted-foreground hover:bg-muted">
          {hidden} more visit{hidden === 1 ? "" : "s"} outside this window — show everything
        </button>
      )}
      {past.length === 0 && today.length === 0 && (
        <p className="py-4 text-center text-sm text-muted-foreground">No visits recorded yet.</p>
      )}
    </div>
  );
}

function SectionLabel({ children, tone }: { children: ReactNode; tone?: "brand" }) {
  return (
    <p className={cn("flex items-center gap-2 pt-3 text-[11px] font-semibold uppercase tracking-wide",
      tone === "brand" ? "text-brand" : "text-muted-foreground")}>
      {children}
      <span className={cn("h-px flex-1", tone === "brand" ? "bg-brand/30" : "bg-border")} />
    </p>
  );
}

function Row({ e, todayISO, onOpen }: { e: Entry; todayISO: string; onOpen: (id: string) => void }) {
  const tt = useToothText();
  const s = e.session;
  const m = mark(e, todayISO);
  const money = MONEY[sessionMoneyState(s)];
  const days = dayDiff(s.scheduled_date);
  const said = [s.procedure, tt(s.tooth)].filter(Boolean).join(" · ");

  return (
    <button
      type="button"
      onClick={() => onOpen(s.id)}
      className={cn("flex w-full items-start gap-3 rounded-md px-2 py-2 text-left hover:bg-muted/60",
        m.key === "cancelled" && "opacity-60")}
    >
      <span className={cn("mt-1.5 h-2.5 w-2.5 shrink-0 rounded-full", m.dot)} aria-hidden />
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
          <span className="text-sm font-medium">{e.plan.title}</span>
          {e.n > 0
            ? <span className="text-xs text-muted-foreground">visit {e.n} of {e.of}</span>
            : <Badge variant="outline">Cancelled</Badge>}
          {m.key === "missed" && <Badge variant="destructive">Missed</Badge>}
          {m.key === "unsettled" && <Badge variant={money.countsAsOwed ? "destructive" : "warning"}>{money.label}</Badge>}
        </div>
        <p className="text-xs text-muted-foreground">
          <DualDate iso={s.scheduled_date} />
          {days !== 0 && <span> · {relativeDay(s.scheduled_date)}</span>}
        </p>
        {said && <p className="mt-0.5 text-sm">{said}</p>}
        {/* The note is the point of a clinical timeline; clamped so one long entry
            cannot push the rest of the history off the screen. */}
        {s.notes && <p className="mt-0.5 line-clamp-2 whitespace-pre-wrap text-sm text-muted-foreground">{s.notes}</p>}
        {(s.prescriptions.length > 0 || s.images.length > 0) && (
          <p className="mt-0.5 text-xs text-muted-foreground">
            {s.prescriptions.length > 0 && `${s.prescriptions.length} prescription${s.prescriptions.length > 1 ? "s" : ""}`}
            {s.prescriptions.length > 0 && s.images.length > 0 && " · "}
            {s.images.length > 0 && `${s.images.length} image${s.images.length > 1 ? "s" : ""}`}
          </p>
        )}
      </div>
      <span className="shrink-0 text-right">
        <span className="block text-sm font-medium tabular-nums">{birr(s.amount_due)}</span>
        <span className={cn("text-[11px]", money.countsAsOwed ? "font-medium text-destructive" : "text-muted-foreground")}>
          {money.label}
        </span>
      </span>
    </button>
  );
}

/** Shown on the shelf rail so the count is visible without opening the panel. */
export function timelineCount(plans: Plan[]): number {
  return plans.reduce((n, p) => n + p.sessions.filter((s) => s.status !== "cancelled").length, 0);
}
