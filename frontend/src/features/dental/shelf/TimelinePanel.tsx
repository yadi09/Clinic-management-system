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
import { useMemo, type ReactNode } from "react";
import { Stethoscope } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import { DualDate, dayDiff } from "@/components/DualDate";
import { MONEY, birr, sessionMoneyState } from "@/features/dental/money";
import type { Plan, Session } from "@/features/dental/api";

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

export function TimelinePanel({ plans, todayISO, onOpenVisit }: {
  plans: Plan[];
  todayISO: string;
  onOpenVisit: (sessionId: string) => void;
}) {
  const { past, upcoming } = useMemo(() => {
    const all: Entry[] = [];
    for (const plan of plans) {
      const live = plan.sessions.filter((s) => s.status !== "cancelled");
      live.forEach((session, i) => all.push({ session, plan, n: i + 1, of: live.length }));
    }
    const byDate = (a: Entry, b: Entry) => a.session.scheduled_date.localeCompare(b.session.scheduled_date);
    return {
      // Upcoming reads forwards (what is next); past reads backwards (what just happened).
      upcoming: all.filter((e) => e.session.scheduled_date > todayISO).sort(byDate),
      past: all.filter((e) => e.session.scheduled_date <= todayISO).sort((a, b) => byDate(b, a)),
    };
  }, [plans, todayISO]);

  if (past.length === 0 && upcoming.length === 0) {
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
      {upcoming.length > 0 && (
        <>
          <SectionLabel>Upcoming</SectionLabel>
          {/* Nearest first, so the next appointment is the one adjacent to today. */}
          {[...upcoming].reverse().map((e) => (
            <Row key={e.session.id} e={e} todayISO={todayISO} onOpen={onOpenVisit} />
          ))}
        </>
      )}

      <div className="my-2 flex items-center gap-3">
        <span className="text-[11px] font-bold uppercase tracking-widest text-brand">Today</span>
        <span className="text-xs text-muted-foreground"><DualDate iso={todayISO} /></span>
        <span className="h-px flex-1 bg-brand/30" />
      </div>

      {past.length === 0 ? (
        <p className="py-4 text-center text-sm text-muted-foreground">No visits yet.</p>
      ) : (
        past.map((e) => <Row key={e.session.id} e={e} todayISO={todayISO} onOpen={onOpenVisit} />)
      )}
    </div>
  );
}

function SectionLabel({ children }: { children: ReactNode }) {
  return <p className="pt-1 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">{children}</p>;
}

function Row({ e, todayISO, onOpen }: { e: Entry; todayISO: string; onOpen: (id: string) => void }) {
  const s = e.session;
  const m = mark(e, todayISO);
  const money = MONEY[sessionMoneyState(s)];
  const days = dayDiff(s.scheduled_date);
  const said = [s.procedure, s.tooth].filter(Boolean).join(" · ");

  return (
    <button
      type="button"
      onClick={() => onOpen(s.id)}
      className="flex w-full items-start gap-3 rounded-md px-2 py-2 text-left hover:bg-muted/60"
    >
      <span className={cn("mt-1.5 h-2.5 w-2.5 shrink-0 rounded-full", m.dot)} aria-hidden />
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
          <span className="text-sm font-medium">{e.plan.title}</span>
          <span className="text-xs text-muted-foreground">visit {e.n} of {e.of}</span>
          {m.key === "missed" && <Badge variant="destructive">Missed</Badge>}
          {m.key === "unsettled" && <Badge variant="warning">{money.label}</Badge>}
        </div>
        <p className="text-xs text-muted-foreground">
          <DualDate iso={s.scheduled_date} />
          {days !== 0 && <span> · {days > 0 ? `in ${days} days` : `${Math.abs(days)} days ago`}</span>}
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
