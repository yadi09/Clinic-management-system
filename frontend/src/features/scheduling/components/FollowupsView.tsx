// Follow-ups: everyone the clinic expects back, in one list with four tabs.
//
// It was two stacked lists — treatment visits, then follow-up appointments — each
// with its own Overdue / Due today / Upcoming, so the second list's categories sat
// a long scroll below the first's and nobody reached them. Its "Overdue" also mixed
// three different jobs: visits that never happened, a course's down payment (a row
// nobody attends), and treatment done but unpaid (a billing job, not a follow-up).
//
// Now the categories are tabs across the top, each a single job:
//   Missed      booked in the past, never happened — call and rebook
//   Today       expected today
//   Coming up   the agenda, a day at a time
//   New doctor  the booked doctor has left — reassign (only when there are any)
// Unpaid finished treatment is named once, with a link to where it is billed.
import { useMemo, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { useQueryClient } from "@tanstack/react-query";
import { ArrowLeftRight, ArrowRight, CalendarCheck2, CalendarClock, CalendarX2, Phone, Repeat2, Stethoscope, UserRoundCog } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Segmented } from "@/components/ui/segmented";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import { formatEthiopian } from "@/lib/ethiopian";
import type { Appointment } from "@/features/scheduling/api";
import type { DentalSessionCal } from "@/features/dental/api";
import { MoveSessionDialog } from "@/features/dental/shared/MoveSessionDialog";
import { joinNumbers, payWord, type PayTone } from "@/features/dental/visit/treatment";

type Tab = "missed" | "today" | "upcoming" | "handoff";

export interface FollowupActions {
  onReassign: (a: Appointment) => void;
  onReschedule: (a: Appointment) => void;
  onOpenPatient: (pid: string, sessionId?: string) => void;
}

/** One person to chase: a treatment's missed visits together, or one appointment. */
interface MissedGroup {
  key: string;
  patientId: string;
  name: string;
  phone?: string;
  oldest: string; // YYYY-MM-DD
  visits: DentalSessionCal[];
  appt?: Appointment;
}

/** One expected arrival (today, or on a day ahead). */
interface Arrival {
  key: string;
  date: string;
  patientId: string;
  name: string;
  phone?: string;
  visit?: DentalSessionCal;
  appt?: Appointment;
}

const dayKey = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
const daysBetween = (a: string, b: string) =>
  Math.round((new Date(`${b}T00:00:00`).getTime() - new Date(`${a}T00:00:00`).getTime()) / 86_400_000);
const shortDay = (iso: string) => new Date(`${iso}T00:00:00`).toLocaleDateString(undefined, { weekday: "short", day: "numeric", month: "short" });
const dayMonth = (iso: string) => new Date(`${iso}T00:00:00`).toLocaleDateString(undefined, { day: "numeric", month: "short" });
const clock = (iso: string) => new Date(iso).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
const ago = (days: number) => (days <= 0 ? "today" : days === 1 ? "yesterday" : `${days} days ago`);
const isActive = (s: string) => s !== "cancelled" && s !== "completed" && s !== "no_show";
const isVisit = (s: DentalSessionCal) => (s.kind ? s.kind === "visit" : s.seq > 0);
const owes = (s: DentalSessionCal) => s.status === "done" && (s.payment === "unpaid" || s.payment === "refunded");
const initials = (n: string) => n.split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]!.toUpperCase()).join("") || "?";

const PAY_TONE: Record<PayTone, string> = {
  good: "bg-primary/10 text-primary", wait: "bg-warning/10 text-warning",
  owed: "bg-destructive/10 text-destructive", plain: "bg-muted text-muted-foreground",
};

export function FollowupsView({ sessions, appts, dentalOn, patientFilter, actions }: {
  sessions: { data?: DentalSessionCal[]; isLoading: boolean };
  appts: { data?: Appointment[]; isLoading: boolean };
  dentalOn: boolean;
  patientFilter: string;
  actions: FollowupActions;
}) {
  const [params, setParams] = useSearchParams();
  const qc = useQueryClient();
  const [rebooking, setRebooking] = useState<DentalSessionCal | null>(null);
  const today = dayKey(new Date());

  const g = useMemo(() => {
    const missed = new Map<string, MissedGroup>();
    const todayList: Arrival[] = [], upcoming: Arrival[] = [], handoff: Appointment[] = [];
    let unpaidDone = 0;
    const want = (pid: string) => !patientFilter || pid === patientFilter;

    for (const s of sessions.data ?? []) {
      if (!isVisit(s) || !want(s.patient_id)) continue;
      if (s.scheduled_date < today) {
        if (owes(s)) unpaidDone++;
        if (s.status !== "planned") continue;
        const k = `plan:${s.plan_id}`;
        const m = missed.get(k) ?? { key: k, patientId: s.patient_id, name: s.patient_name, phone: s.phone, oldest: s.scheduled_date, visits: [] };
        m.visits.push(s);
        if (s.scheduled_date < m.oldest) m.oldest = s.scheduled_date;
        missed.set(k, m);
      } else if (s.scheduled_date === today) {
        todayList.push({ key: s.session_id, date: today, patientId: s.patient_id, name: s.patient_name, phone: s.phone, visit: s });
      } else if (s.status === "planned") {
        upcoming.push({ key: s.session_id, date: s.scheduled_date, patientId: s.patient_id, name: s.patient_name, phone: s.phone, visit: s });
      }
    }
    for (const a of appts.data ?? []) {
      if (!isActive(a.status) || !want(a.patient_id)) continue;
      const d = dayKey(new Date(a.starts_at));
      if (!a.provider_active) handoff.push(a);
      else if (d < today && a.status !== "checked_in") {
        missed.set(`appt:${a.id}`, { key: `appt:${a.id}`, patientId: a.patient_id, name: a.patient_name, oldest: d, visits: [], appt: a });
      } else if (d === today) todayList.push({ key: a.id, date: d, patientId: a.patient_id, name: a.patient_name, appt: a });
      else upcoming.push({ key: a.id, date: d, patientId: a.patient_id, name: a.patient_name, appt: a });
    }
    const missedList = [...missed.values()]
      .map((m) => ({ ...m, visits: m.visits.sort((x, y) => x.scheduled_date.localeCompare(y.scheduled_date)) }))
      // Longest missed first: the treatment most at risk of being abandoned.
      .sort((x, y) => x.oldest.localeCompare(y.oldest));
    const byTime = (x: Arrival, y: Arrival) =>
      x.date.localeCompare(y.date) || (x.appt?.starts_at ?? "~").localeCompare(y.appt?.starts_at ?? "~") || x.name.localeCompare(y.name);
    return { missed: missedList, today: todayList.sort(byTime), upcoming: upcoming.sort(byTime), handoff, unpaidDone };
  }, [sessions.data, appts.data, patientFilter, today]);

  const counts: Record<Tab, number> = { missed: g.missed.length, today: g.today.length, upcoming: g.upcoming.length, handoff: g.handoff.length };
  const asked = params.get("tab") as Tab | null;
  const fallback: Tab = counts.missed ? "missed" : counts.today ? "today" : "upcoming";
  const tab: Tab = asked && (asked !== "handoff" || counts.handoff > 0) && asked in counts ? asked : fallback;
  const setTab = (t: Tab) => { const p = new URLSearchParams(params); p.set("tab", t); setParams(p, { replace: true }); };

  if ((sessions.isLoading && dentalOn) || appts.isLoading) {
    return <div className="space-y-3">{Array.from({ length: 5 }).map((_, i) => <Skeleton key={i} className="h-16 w-full" />)}</div>;
  }

  const options = [
    { value: "missed" as Tab, label: <TabLabel icon={CalendarX2} text="Missed" />, badge: counts.missed || undefined },
    { value: "today" as Tab, label: <TabLabel icon={CalendarCheck2} text="Today" />, badge: counts.today || undefined },
    { value: "upcoming" as Tab, label: <TabLabel icon={CalendarClock} text="Coming up" />, badge: counts.upcoming || undefined },
    ...(counts.handoff > 0 ? [{ value: "handoff" as Tab, label: <TabLabel icon={UserRoundCog} text="Needs a new doctor" />, badge: counts.handoff }] : []),
  ];

  return (
    <div className="space-y-4">
      <div className="sticky top-0 z-10 -mx-1 space-y-2 bg-background/95 px-1 pb-2 pt-0.5 backdrop-blur supports-[backdrop-filter]:bg-background/80">
        <Segmented ariaLabel="Follow-ups" value={tab} onChange={setTab} options={options} />
        <p className="text-sm text-muted-foreground">{HINT[tab]}</p>
      </div>

      {dentalOn && g.unpaidDone > 0 && tab === "missed" && (
        <Link to="/dental/unbilled"
          className="flex items-center gap-2 rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm hover:bg-destructive/10">
          <span className="min-w-0 flex-1">
            <b className="font-semibold text-destructive">{g.unpaidDone} treated {g.unpaidDone === 1 ? "visit is" : "visits are"} done but not paid.</b>{" "}
            <span className="text-muted-foreground">That is billing, not a follow-up.</span>
          </span>
          <span className="inline-flex shrink-0 items-center gap-1 font-medium text-primary">Unbilled treatment <ArrowRight className="h-3.5 w-3.5" /></span>
        </Link>
      )}

      {tab === "missed" && (
        g.missed.length === 0 ? <Empty text="Nobody has missed a visit. Every booked visit in the past either happened or was moved." /> : (
          <Card className="divide-y overflow-hidden">
            {g.missed.map((m) => <MissedRow key={m.key} m={m} today={today} actions={actions} onRebook={setRebooking} />)}
          </Card>
        )
      )}

      {tab === "today" && (
        g.today.length === 0 ? <Empty text="Nobody is booked to come back today." /> : (
          <Card className="divide-y overflow-hidden">
            {g.today.map((a) => <ArrivalRow key={a.key} a={a} actions={actions} />)}
          </Card>
        )
      )}

      {tab === "upcoming" && (
        g.upcoming.length === 0 ? <Empty text="Nothing booked ahead yet. Visits appear here as treatments are planned." /> : (
          <div className="space-y-4">
            {groupDays(g.upcoming).map(([d, list]) => (
              <section key={d} aria-label={shortDay(d)}>
                <h3 className="mb-1.5 flex flex-wrap items-baseline gap-x-2 px-1 text-sm">
                  <span className="font-semibold text-foreground">{relDay(d, today)}</span>
                  <span className="text-muted-foreground">{shortDay(d)} · {formatEthiopian(d, { dayFirst: true })}</span>
                  <span className="ml-auto text-xs text-muted-foreground">{list.length === 1 ? "1 patient" : `${list.length} patients`}</span>
                </h3>
                <Card className="divide-y overflow-hidden">
                  {list.map((a) => <ArrivalRow key={a.key} a={a} actions={actions} compact />)}
                </Card>
              </section>
            ))}
          </div>
        )
      )}

      {tab === "handoff" && (
        <Card className="divide-y overflow-hidden">
          {g.handoff.map((a) => (
            <Row key={a.id} name={a.patient_name} onOpen={() => actions.onOpenPatient(a.patient_id)}
              line={<>Booked with <b className="font-medium text-foreground">{a.provider_name}</b>, who no longer works here · {shortDay(dayKey(new Date(a.starts_at)))} {clock(a.starts_at)}</>}
              tag={<Badge variant="warning">needs a new doctor</Badge>}
              buttons={<Button size="sm" className="touch-hit" onClick={() => actions.onReassign(a)}><ArrowLeftRight className="h-3.5 w-3.5" /> Reassign</Button>} />
          ))}
        </Card>
      )}

      {rebooking && (
        <MoveSessionDialog
          patientId={rebooking.patient_id} sessionId={rebooking.session_id} planTitle={rebooking.title}
          currentDate={rebooking.scheduled_date} detail={`Visit ${rebooking.seq} of ${rebooking.session_count} · ${rebooking.patient_name}`}
          missed={rebooking.scheduled_date < today}
          onClose={() => setRebooking(null)}
          onMoved={() => {
            setRebooking(null);
            void qc.invalidateQueries({ queryKey: ["dental-fu"] });
            void qc.invalidateQueries({ queryKey: ["dental-cal"] });
          }} />
      )}
    </div>
  );
}

const HINT: Record<Tab, string> = {
  missed: "Booked for a day that has passed, and the patient never came. Call them and rebook, longest missed first.",
  today: "Patients booked to come back today.",
  upcoming: "Everyone booked to come back, a day at a time.",
  handoff: "The doctor these patients are booked with has left. Give each a doctor who is here.",
};

function TabLabel({ icon: Icon, text }: { icon: typeof Phone; text: string }) {
  return <span className="inline-flex items-center gap-1.5"><Icon className="h-3.5 w-3.5" />{text}</span>;
}

function relDay(d: string, today: string) {
  const n = daysBetween(today, d);
  return n === 1 ? "Tomorrow" : n < 7 ? new Date(`${d}T00:00:00`).toLocaleDateString(undefined, { weekday: "long" }) : `In ${n} days`;
}

function groupDays(list: Arrival[]): [string, Arrival[]][] {
  const m = new Map<string, Arrival[]>();
  for (const a of list) m.set(a.date, [...(m.get(a.date) ?? []), a]);
  return [...m.entries()];
}

function Empty({ text }: { text: string }) {
  return <Card className="p-10 text-center text-sm text-muted-foreground">{text}</Card>;
}

/** One row: who, what, and the one or two things to do. Stacks on a phone. */
function Row({ name, line, sub, tag, buttons, onOpen }: {
  name: string; line: React.ReactNode; sub?: React.ReactNode; tag?: React.ReactNode; buttons?: React.ReactNode; onOpen: () => void;
}) {
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-2 px-3 py-3 sm:px-4">
      <button type="button" onClick={onOpen} className="flex min-w-0 flex-1 basis-64 items-center gap-3 text-left">
        <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-brand/10 text-xs font-bold text-brand">{initials(name)}</span>
        <span className="min-w-0">
          <span className="block truncate font-semibold text-brand hover:underline">{name}</span>
          <span className="block text-[13px] leading-snug text-muted-foreground">{line}</span>
          {sub && <span className="mt-0.5 block text-[12.5px] text-muted-foreground">{sub}</span>}
        </span>
      </button>
      {tag && <div className="flex shrink-0 items-center gap-1.5 max-sm:ml-12">{tag}</div>}
      {buttons && <div className="flex shrink-0 flex-wrap items-center gap-1.5 max-sm:ml-12 max-sm:w-[calc(100%-3rem)]">{buttons}</div>}
    </div>
  );
}

function CallButton({ phone }: { phone?: string }) {
  if (!phone) return null;
  return (
    <Button asChild size="sm" variant="outline" className="touch-hit">
      <a href={`tel:${phone.replace(/\s+/g, "")}`} aria-label={`Call ${phone}`}><Phone className="h-3.5 w-3.5" /> {phone}</a>
    </Button>
  );
}

function MissedRow({ m, today, actions, onRebook }: {
  m: MissedGroup; today: string; actions: FollowupActions; onRebook: (s: DentalSessionCal) => void;
}) {
  const days = daysBetween(m.oldest, today);
  const late = <Badge variant={days > 14 ? "destructive" : "warning"}>missed {ago(days)}</Badge>;
  if (m.appt) {
    const a = m.appt;
    return (
      <Row name={m.name} onOpen={() => actions.onOpenPatient(a.patient_id)}
        line={<><Repeat2 className="mr-1 inline h-3.5 w-3.5 align-[-2px]" />Follow-up with {a.provider_name} · was {shortDay(m.oldest)} {clock(a.starts_at)}{a.reason ? ` · ${a.reason}` : ""}</>}
        tag={late}
        buttons={<Button size="sm" className="touch-hit" onClick={() => actions.onReschedule(a)}><CalendarClock className="h-3.5 w-3.5" /> Rebook</Button>} />
    );
  }
  const first = m.visits[0];
  const nums = m.visits.map((v) => v.seq);
  const ahead = m.visits.filter((v) => v.payment === "paid").length;
  return (
    <Row name={m.name} onOpen={() => actions.onOpenPatient(first.patient_id, first.session_id)}
      line={<>
        <Stethoscope className="mr-1 inline h-3.5 w-3.5 align-[-2px] text-violet-600" />
        {first.title} · {m.visits.length === 1 ? `visit ${nums[0]} of ${first.session_count}` : `visits ${joinNumbers(nums)} of ${first.session_count}`}
        {" "}· was {m.visits.map((v) => dayMonth(v.scheduled_date)).join(", ")}
      </>}
      sub={ahead > 0 ? <span className="font-medium text-primary">{ahead === 1 ? "Already paid for" : `${ahead} already paid for`}, so the patient is owed this treatment.</span> : undefined}
      tag={late}
      buttons={<>
        <CallButton phone={m.phone} />
        <Button size="sm" className="touch-hit" onClick={() => onRebook(first)}>
          <CalendarClock className="h-3.5 w-3.5" /> Rebook visit {first.seq}
        </Button>
      </>} />
  );
}

function ArrivalRow({ a, actions, compact }: { a: Arrival; actions: FollowupActions; compact?: boolean }) {
  if (a.appt) {
    const ap = a.appt;
    return (
      <Row name={a.name} onOpen={() => actions.onOpenPatient(ap.patient_id)}
        line={<><Repeat2 className="mr-1 inline h-3.5 w-3.5 align-[-2px]" />{clock(ap.starts_at)} · follow-up with {ap.provider_name}{ap.reason ? ` · ${ap.reason}` : ""}</>}
        tag={ap.status === "checked_in" ? <Badge variant="success">arrived</Badge> : undefined}
        buttons={compact ? undefined : <>
          <Button size="sm" variant="outline" className="touch-hit" onClick={() => actions.onReassign(ap)}><ArrowLeftRight className="h-3.5 w-3.5" /> Reassign</Button>
          <Button size="sm" variant="ghost" className="touch-hit" onClick={() => actions.onReschedule(ap)}><CalendarClock className="h-3.5 w-3.5" /> Rebook</Button>
        </>} />
    );
  }
  const v = a.visit!;
  const pay = payWord(v);
  return (
    <Row name={a.name} onOpen={() => actions.onOpenPatient(v.patient_id, v.session_id)}
      line={<><Stethoscope className="mr-1 inline h-3.5 w-3.5 align-[-2px] text-violet-600" />{v.title} · visit {v.seq} of {v.session_count}</>}
      tag={<>
        {v.status === "done" && <Badge variant="success">done</Badge>}
        <span className={cn("whitespace-nowrap rounded-full px-2 py-0.5 text-xs font-medium", PAY_TONE[pay.tone])}>{pay.label}</span>
      </>}
      buttons={compact ? undefined : <CallButton phone={a.phone} />} />
  );
}
