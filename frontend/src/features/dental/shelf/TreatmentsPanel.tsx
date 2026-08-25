// One course at a time — the question the Timeline cannot answer.
//
// The Timeline is a date spine across everything, and it is right for "what is
// happening to this patient". It dissolves courses on purpose, which is exactly why it
// cannot answer "how is THIS course going". Both questions are real; this is the
// second one, and nothing here replaces or moves the first.
//
// What was invisible before this panel, all of it visible on the same page's data:
//
//   * A 20-visit course whose visits were booked 4 → 5 → 3 → 6. On a date spine those
//     are five ordinary rows; in visit order the mistake is the first thing you see.
//   * The terms. 20 × 700 = 14,000 agreed against a 15,000 list price, every two
//     weeks, due by a date — none of that was on any screen in the product.
//   * Whether a course has stalled. An active 20-visit course with nothing booked
//     ahead has quietly stopped, and no surface said so.
//   * Delivery progress as distinct from payment progress. On an instalment course
//     they diverge, and one gets read as the other.
//
// Read-first. The cockpit above is the editor for a visit; rows here open it, so there
// is one place a visit can be changed. Every figure comes from the server's per-plan
// projection and the shared owedOnPlan helper — a second definition of "owed" is how a
// clinic ends up with two answers on one screen.
import { useMemo, useState } from "react";
import { AlertTriangle, ArrowLeft, CalendarClock, ChevronRight, FileText, ImageIcon, Pill, Plus, Stethoscope } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { DualDate, relativeDay } from "@/components/DualDate";
import { MONEY, birr, num, sessionMoneyState } from "@/features/dental/money";
import { DepositCallout, depositOutstanding } from "@/features/dental/shared/Deposit";
import { UnbilledRows, owedOnPlan, owedTotal } from "@/features/dental/shared/UnbilledWork";
import type { Plan } from "@/features/dental/api";

/** The visits that count as part of the course. A cancelled visit is not a step. */
const liveSessions = (plan: Plan) => plan.sessions.filter((s) => s.status !== "cancelled");

/** "every 2 weeks", "monthly", "every 10 days" — how the course was scheduled. */
function cadence(plan: Plan): string {
  const n = plan.interval_count || 1;
  const unit = plan.interval_unit || "week";
  if (n === 1) return unit === "day" ? "daily" : unit === "week" ? "weekly" : "monthly";
  return `every ${n} ${unit}s`;
}

/** What is wrong with this course, in the order a person would want to hear it. */
interface Flag {
  key: string;
  text: string;
  tone: "bad" | "warn";
}

function flagsOf(plan: Plan, todayISO: string): Flag[] {
  if (plan.status === "cancelled") return [];
  const out: Flag[] = [];
  const live = liveSessions(plan);

  // Money already delivered and never billed, plus an unpaid deposit. Same helper the
  // Money tab and the Unbilled treatment report use, so these can never disagree.
  const owed = owedOnPlan(plan, { withDeposit: true });
  if (owed.length > 0) {
    out.push({ key: "unbilled", tone: "bad", text: `${birr(owedTotal(owed))} delivered and never billed` });
  }

  const missed = live.filter((s) => s.status !== "done" && s.scheduled_date < todayISO);
  if (missed.length > 0) {
    out.push({
      key: "missed", tone: "bad",
      text: missed.length === 1
        ? `visit ${missed[0].seq} was missed on ${missed[0].scheduled_date}`
        : `${missed.length} visits missed`,
    });
  }

  // Booked out of sequence: a later-numbered visit sits before an earlier one. The
  // course runs in the wrong order and only a per-course view shows it.
  const booked = live.filter((s) => s.status !== "done").sort((a, b) => a.seq - b.seq);
  for (let i = 1; i < booked.length; i++) {
    if (booked[i].scheduled_date < booked[i - 1].scheduled_date) {
      out.push({
        key: "order", tone: "warn",
        text: `visit ${booked[i].seq} is booked before visit ${booked[i - 1].seq}`,
      });
      break;
    }
  }

  if (plan.status === "active") {
    const ahead = live.filter((s) => s.status !== "done" && s.scheduled_date >= todayISO);
    const remaining = live.filter((s) => s.status !== "done");
    // Stalled: work left to do and nothing booked to do it at.
    if (remaining.length > 0 && ahead.length === 0) {
      out.push({ key: "stalled", tone: "bad", text: `${remaining.length} visits left and nothing booked` });
    }
    if (plan.deadline) {
      if (remaining.length > 0 && plan.deadline < todayISO) {
        out.push({ key: "overdue", tone: "bad", text: `past its ${plan.deadline} deadline with visits outstanding` });
      } else if (ahead.some((s) => s.scheduled_date > plan.deadline!)) {
        out.push({ key: "beyond", tone: "warn", text: `visits booked beyond the ${plan.deadline} deadline` });
      }
    }
  }
  return out;
}

/** Delivered / total, and the soonest thing still to happen. */
function progressOf(plan: Plan, todayISO: string) {
  const live = liveSessions(plan);
  const done = live.filter((s) => s.status === "done").length;
  const next = live
    .filter((s) => s.status !== "done" && s.scheduled_date >= todayISO)
    .sort((a, b) => a.scheduled_date.localeCompare(b.scheduled_date))[0];
  return { done, total: live.length, next };
}

const STATUS: Record<Plan["status"], { label: string; variant: "success" | "brand" | "outline" }> = {
  active: { label: "Active", variant: "brand" },
  completed: { label: "Completed", variant: "success" },
  cancelled: { label: "Cancelled", variant: "outline" },
};

export function TreatmentsPanel({ patientId, plans, todayISO, canCollect, onOpenVisit, onNewPlan }: {
  patientId: string;
  plans: Plan[];
  todayISO: string;
  canCollect: boolean;
  /** Opens a visit in the cockpit above — the one editor. Same contract as the
   *  Timeline's, so both reading surfaces hand off the same way. */
  onOpenVisit: (sessionId: string) => void;
  onNewPlan?: () => void;
}) {
  // Remembered for the session, like the shelf panel itself: coming back from the
  // cashier should not lose your place.
  const storeKey = `dental-course:${patientId}`;
  const [openId, setOpenId] = useState<string | null>(() => sessionStorage.getItem(storeKey));
  const pick = (id: string | null) => {
    setOpenId(id);
    if (id) sessionStorage.setItem(storeKey, id);
    else sessionStorage.removeItem(storeKey);
  };

  // Active first — a finished course is reference, a live one is work. Within active,
  // the one that needs attention soonest.
  const ordered = useMemo(() => {
    const rank = { active: 0, completed: 1, cancelled: 2 } as const;
    return [...plans].sort((a, b) => {
      if (rank[a.status] !== rank[b.status]) return rank[a.status] - rank[b.status];
      const fa = flagsOf(a, todayISO).length, fb = flagsOf(b, todayISO).length;
      if (fa !== fb) return fb - fa;
      const na = progressOf(a, todayISO).next?.scheduled_date ?? "9999";
      const nb = progressOf(b, todayISO).next?.scheduled_date ?? "9999";
      return na.localeCompare(nb);
    });
  }, [plans, todayISO]);

  const open = openId ? plans.find((p) => p.id === openId) : undefined;

  if (plans.length === 0) {
    return (
      <div className="rounded-lg border border-dashed p-6 text-center">
        <Stethoscope className="mx-auto h-5 w-5 text-muted-foreground" />
        <p className="mt-2 text-sm font-medium">No treatment courses yet</p>
        <p className="mt-0.5 text-xs text-muted-foreground">
          A course is what turns agreed treatment into visits and instalments.
        </p>
        {onNewPlan && (
          <Button size="sm" variant="outline" className="mt-3" onClick={onNewPlan}>
            <Plus className="h-4 w-4" /> New treatment
          </Button>
        )}
      </div>
    );
  }

  if (open) {
    return (
      <CourseDetail patientId={patientId} plan={open} todayISO={todayISO} canCollect={canCollect}
        onBack={() => pick(null)} onOpenVisit={onOpenVisit} />
    );
  }

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <p className="text-xs text-muted-foreground">
          Everything about one course — its terms, its visits and its money. Tap one to open it.
        </p>
        {onNewPlan && (
          <Button size="sm" variant="outline" className="touch-hit" onClick={onNewPlan}>
            <Plus className="h-4 w-4" /> New
          </Button>
        )}
      </div>
      {ordered.map((pl) => (
        <CourseCard key={pl.id} plan={pl} todayISO={todayISO} onOpen={() => pick(pl.id)} />
      ))}
    </div>
  );
}

/** How the course is going, without opening it. */
function CourseCard({ plan, todayISO, onOpen }: { plan: Plan; todayISO: string; onOpen: () => void }) {
  const { done, total, next } = progressOf(plan, todayISO);
  const flags = flagsOf(plan, todayISO);
  const st = STATUS[plan.status];
  const owedNow = num(plan.money.due);
  const atCashier = num(plan.money.at_cashier);

  return (
    <button type="button" onClick={onOpen}
      className={cn("block w-full rounded-lg border bg-card p-3 text-left shadow-sm transition-colors hover:bg-accent/40",
        plan.status === "cancelled" && "opacity-60")}>
      <div className="flex items-start gap-2">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
            <span className="min-w-0 truncate font-semibold">{plan.title}</span>
            {plan.tooth && <span className="font-mono text-xs text-muted-foreground">#{plan.tooth}</span>}
            <Badge variant={st.variant} className="text-[10px]">{st.label}</Badge>
          </div>
          {plan.service_name && (
            <p className="mt-0.5 truncate text-xs text-muted-foreground">{plan.service_name}</p>
          )}
        </div>
        <ChevronRight className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
      </div>

      {/* Delivery, as segments. Deliberately NOT the money bar: on an instalment
          course "7 of 20 done" and "35% paid" are different fractions, and showing
          only one of them is how they get confused for each other. */}
      <div className="mt-2 flex items-center gap-2">
        <div className="flex flex-1 gap-0.5">
          {liveSessions(plan).sort((a, b) => a.seq - b.seq).map((s) => (
            <span key={s.id} className={cn("h-1.5 flex-1 rounded-full",
              s.status === "done" ? "bg-emerald-500"
                : s.scheduled_date < todayISO ? "bg-rose-400"
                  : s.scheduled_date === todayISO ? "bg-brand" : "bg-muted")} />
          ))}
        </div>
        <span className="shrink-0 text-[11px] tabular-nums text-muted-foreground">{done} of {total} done</span>
      </div>

      <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs">
        <span className="tabular-nums">
          <b className="text-emerald-700">{birr(plan.money.collected)}</b>
          <span className="text-muted-foreground"> of {birr(plan.money.planned)}</span>
        </span>
        {owedNow > 0.005 && <span className="font-semibold text-destructive">{birr(plan.money.due)} owed now</span>}
        {atCashier > 0.005 && <span className="font-medium text-amber-700">{birr(plan.money.at_cashier)} with the cashier</span>}
        {next && (
          <span className="flex items-center gap-1 text-muted-foreground">
            <CalendarClock className="h-3 w-3" /> next {relativeDay(next.scheduled_date)}
          </span>
        )}
      </div>

      {flags.length > 0 && (
        <div className="mt-2 space-y-1 border-t pt-2">
          {flags.map((f) => (
            <p key={f.key} className={cn("flex items-start gap-1.5 text-xs",
              f.tone === "bad" ? "font-medium text-destructive" : "text-amber-700")}>
              <AlertTriangle className="mt-0.5 h-3 w-3 shrink-0" /> {f.text}
            </p>
          ))}
        </div>
      )}
    </button>
  );
}

/** Everything about one course. */
function CourseDetail({ patientId, plan, todayISO, canCollect, onBack, onOpenVisit }: {
  patientId: string; plan: Plan; todayISO: string; canCollect: boolean;
  onBack: () => void;
  onOpenVisit: (sessionId: string) => void;
}) {
  const live = liveSessions(plan).sort((a, b) => a.seq - b.seq);
  const flags = flagsOf(plan, todayISO);
  const st = STATUS[plan.status];
  // Instalments are not always equal — splitRounded puts the rounding difference on
  // the last visit — so "700 × 20" would be a quietly wrong statement of the terms.
  // Show the range when there is one.
  const amounts = live.map((s) => num(s.amount_due));
  const lo = amounts.length ? Math.min(...amounts) : num(plan.total_amount);
  const hi = amounts.length ? Math.max(...amounts) : lo;
  const stillToPay = Math.max(0, num(plan.money.planned) - num(plan.money.collected) - num(plan.money.at_cashier));
  // The list price beside the agreed total: a course agreed at 14,000 against a 15,000
  // list price is a 1,000 discount that no screen showed.
  const discount = plan.list_price ? num(plan.list_price) - num(plan.total_amount) : 0;
  const images = live.flatMap((s) => s.images);
  const scripts = live.flatMap((s) => s.prescriptions);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <button type="button" onClick={onBack}
            className="touch-hit -ml-1 flex items-center gap-1 rounded px-1 text-xs text-muted-foreground hover:text-foreground">
            <ArrowLeft className="h-3.5 w-3.5" /> All treatments
          </button>
          <div className="mt-1 flex flex-wrap items-baseline gap-x-2 gap-y-1">
            <h3 className="text-base font-semibold">{plan.title}</h3>
            {plan.tooth && <span className="font-mono text-xs text-muted-foreground">#{plan.tooth}</span>}
            <Badge variant={st.variant} className="text-[10px]">{st.label}</Badge>
          </div>
        </div>
      </div>

      {flags.length > 0 && (
        <div className="space-y-1 rounded-lg border border-l-4 border-l-destructive bg-destructive/5 px-3 py-2">
          {flags.map((f) => (
            <p key={f.key} className={cn("flex items-start gap-1.5 text-xs",
              f.tone === "bad" ? "font-semibold text-destructive" : "text-amber-700")}>
              <AlertTriangle className="mt-0.5 h-3 w-3 shrink-0" /> {f.text}
            </p>
          ))}
        </div>
      )}

      {/* THE TERMS. What was agreed — which the product has never shown anywhere. */}
      <section>
        <h4 className="text-[10px] font-bold uppercase tracking-wide text-muted-foreground">What was agreed</h4>
        <dl className="mt-1.5 grid gap-x-6 gap-y-2 rounded-lg border bg-card p-3 text-sm sm:grid-cols-2">
          <Term label="Total agreed">
            <span className="font-semibold tabular-nums">{birr(plan.total_amount)}</span>
            {discount > 0.005 && (
              <span className="ml-1.5 text-xs text-emerald-700">{birr(String(discount))} off the list price</span>
            )}
          </Term>
          <Term label="Started"><DualDate iso={plan.start_date} /></Term>
          <Term label="Per visit">
            <span className="tabular-nums">
              {hi - lo > 0.005 ? `${birr(lo)} – ${birr(hi)}` : birr(lo)}
            </span>
            <span className="text-muted-foreground"> × {plan.session_count}</span>
          </Term>
          <Term label="Scheduled">{cadence(plan)}</Term>
          {plan.service_name && (
            <Term label="From the list">
              {plan.service_name}
              {plan.list_price && <span className="text-xs text-muted-foreground"> · listed at {birr(plan.list_price)}</span>}
            </Term>
          )}
          {plan.deadline && <Term label="Due by"><DualDate iso={plan.deadline} /></Term>}
          {plan.note && <div className="sm:col-span-2"><Term label="Note">{plan.note}</Term></div>}
        </dl>
      </section>

      {/* THE MONEY, for this course only. Shared components, shared definitions. */}
      <section>
        <h4 className="text-[10px] font-bold uppercase tracking-wide text-muted-foreground">Money on this course</h4>
        <div className="mt-1.5 rounded-lg border bg-card p-3">
          <div className="grid grid-cols-2 gap-x-4 gap-y-2 sm:grid-cols-4">
            {[
              { k: "Planned", v: plan.money.planned, tone: "" },
              { k: "Collected", v: plan.money.collected, tone: "text-emerald-700" },
              { k: "Still to pay", v: String(stillToPay), tone: "" },
              { k: "Owed now", v: plan.money.due, tone: num(plan.money.due) > 0.005 ? "text-destructive" : "" },
            ].map((c) => (
              <div key={c.k}>
                <div className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">{c.k}</div>
                <div className={cn("text-sm font-bold tabular-nums", c.tone)}>{birr(c.v)}</div>
              </div>
            ))}
          </div>
          {(num(plan.money.at_cashier) > 0.005 || num(plan.money.waived) > 0.005) && (
            <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 border-t pt-2 text-xs">
              {num(plan.money.at_cashier) > 0.005 && (
                <span className="font-medium text-amber-700">
                  {birr(plan.money.at_cashier)} with the cashier — deliberately not counted as owed
                </span>
              )}
              {num(plan.money.waived) > 0.005 && (
                <span className="text-muted-foreground">{birr(plan.money.waived)} written off</span>
              )}
            </div>
          )}
          {depositOutstanding(plan) && (
            <div className="mt-2"><DepositCallout patientId={patientId} plan={plan} canCollect={canCollect} compact /></div>
          )}
          <UnbilledRows patientId={patientId} canCollect={canCollect} items={owedOnPlan(plan)} />
        </div>
      </section>

      {/* THE VISITS, in visit order — which is what makes a mis-booked course obvious. */}
      <section>
        <div className="flex items-baseline justify-between gap-2">
          <h4 className="text-[10px] font-bold uppercase tracking-wide text-muted-foreground">
            Visits · in course order
          </h4>
          <span className="text-[11px] text-muted-foreground">tap one to open it above</span>
        </div>
        <div className="mt-1.5 max-h-[28rem] divide-y overflow-y-auto rounded-lg border bg-card">
          {live.map((s, i) => {
            const state = sessionMoneyState(s);
            const meta = MONEY[state];
            const earlier = i > 0 && s.scheduled_date < live[i - 1].scheduled_date;
            const missed = s.status !== "done" && s.scheduled_date < todayISO;
            return (
              <button key={s.id} type="button" onClick={() => onOpenVisit(s.id)}
                className="flex w-full items-start gap-2.5 px-3 py-2.5 text-left transition-colors hover:bg-accent/40">
                <span className={cn("mt-1.5 h-2 w-2 shrink-0 rounded-full",
                  s.status === "done" ? "bg-emerald-500"
                    : missed ? "bg-rose-500"
                      : s.scheduled_date === todayISO ? "bg-brand" : "bg-border")} />
                <span className="w-6 shrink-0 pt-0.5 text-xs font-semibold tabular-nums text-muted-foreground">
                  {s.seq}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5 text-sm">
                    <DualDate iso={s.scheduled_date} />
                    {/* The dual date is whitespace-nowrap and cannot shrink, so on a
                        390px screen it painted straight over a right-aligned amount
                        column. Below sm the amount joins this wrapping line instead. */}
                    <span className="font-semibold tabular-nums sm:hidden">{birr(s.amount_due)}</span>
                    <Badge variant={meta.variant} className="text-[10px]">{meta.label}</Badge>
                  </span>
                  {(s.procedure || s.service_name || s.tooth) && (
                    <span className="mt-0.5 block truncate text-xs text-muted-foreground">
                      {s.procedure || s.service_name}
                      {s.tooth && <span className="font-mono"> · #{s.tooth}</span>}
                    </span>
                  )}
                  {/* What is attached, so nobody opens five visits to find the X-ray. */}
                  <span className="mt-0.5 flex flex-wrap items-center gap-x-2.5 gap-y-1 text-[11px] text-muted-foreground">
                    {s.images.length > 0 && (
                      <span className="flex items-center gap-1"><ImageIcon className="h-3 w-3" />{s.images.length}</span>
                    )}
                    {s.prescriptions.length > 0 && (
                      <span className="flex items-center gap-1"><Pill className="h-3 w-3" />{s.prescriptions.length}</span>
                    )}
                    {s.notes && <span className="flex items-center gap-1"><FileText className="h-3 w-3" />note</span>}
                    {(s.extras ?? []).length > 0 && (
                      <span className="text-foreground">+ {(s.extras ?? []).length} extra</span>
                    )}
                    {earlier && (
                      <span className="font-medium text-amber-700">booked before visit {live[i - 1].seq}</span>
                    )}
                  </span>
                </span>
                <span className="hidden shrink-0 pt-0.5 text-sm font-semibold tabular-nums sm:block">
                  {birr(s.amount_due)}
                </span>
              </button>
            );
          })}
        </div>
      </section>

      {(images.length > 0 || scripts.length > 0) && (
        <section>
          <h4 className="text-[10px] font-bold uppercase tracking-wide text-muted-foreground">On this course</h4>
          <p className="mt-1.5 rounded-lg border bg-card px-3 py-2 text-sm text-muted-foreground">
            {images.length > 0 && <span>{images.length} image{images.length === 1 ? "" : "s"}</span>}
            {images.length > 0 && scripts.length > 0 && <span> · </span>}
            {scripts.length > 0 && <span>{scripts.length} prescription{scripts.length === 1 ? "" : "s"}</span>}
            <span> — open the visit to see them.</span>
          </p>
        </section>
      )}
    </div>
  );
}

function Term({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <dt className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">{label}</dt>
      <dd className="mt-0.5">{children}</dd>
    </div>
  );
}
