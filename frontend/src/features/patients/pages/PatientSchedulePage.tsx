// One patient's schedule, as a timeline rather than a calendar.
//
// A calendar grid earns its keep when you are scanning many events for a free slot
// — a clinic-wide problem. A single patient has a handful of dated events a year,
// so a month grid would be 28 empty cells and two dots. The question asked on a
// patient page is "when are they next in, and what have they had?" — a list,
// ordered by time.
//
// Two things this page does that no other screen does: it MERGES the two places a
// visit can live (booked appointments and dental treatment sessions), and it lets
// the person looking at the problem fix it on the spot — every missed or upcoming
// session can be moved without leaving the page.
import { useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate, useParams } from "react-router-dom";
import { AlertTriangle, ArrowLeft, CalendarClock, CalendarPlus, Repeat2, Stethoscope } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { MoveSessionDialog } from "@/features/dental/shared/MoveSessionDialog";
import { cn, ageLabel } from "@/lib/utils";
import { useAuth } from "@/app/auth-context";
import { formatEthiopian } from "@/lib/ethiopian";
import { getPatient } from "@/features/patients/api";
import { listPatientAppointments } from "@/features/scheduling/api";
import { dentalSummary, type Plan, type Session } from "@/features/dental/api";

const num = (s?: string) => Number(s || 0);
const birr = (s?: string | number) => `${Number(s || 0).toLocaleString(undefined, { maximumFractionDigits: 0 })} ETB`;
const isoOf = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
const todayISO = () => isoOf(new Date());
const dayDiff = (iso: string, from = todayISO()) =>
  Math.round((new Date(`${iso}T00:00:00`).getTime() - new Date(`${from}T00:00:00`).getTime()) / 86400000);
const fmtDay = (iso: string) => new Date(`${iso}T00:00:00`).toLocaleDateString(undefined, { weekday: "long", day: "numeric", month: "long", year: "numeric" });
const fmtShort = (iso: string) => new Date(`${iso}T00:00:00`).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });
const fmtTime = (iso: string) => new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
const monthKey = (iso: string) => iso.slice(0, 7);
const fmtMonth = (k: string) => new Date(`${k}-01T00:00:00`).toLocaleDateString(undefined, { month: "long", year: "numeric" });
/** "in 15 days" / "15 days ago" / "today" — relative time is what people reason in. */
const relative = (iso: string) => {
  const d = dayDiff(iso);
  if (d === 0) return "today";
  if (d === 1) return "tomorrow";
  if (d === -1) return "yesterday";
  return d > 0 ? `in ${d} days` : `${Math.abs(d)} days ago`;
};

/** One entry on the timeline, whatever module it came from. */
interface Entry {
  id: string;
  date: string;        // YYYY-MM-DD — the axis both sources share
  time?: string;       // appointments only; sessions are date-only
  kind: "appointment" | "session";
  title: string;
  detail: string;
  status: string;
  tone: "ok" | "warn" | "danger" | "muted";
  amount?: string;
  followup?: boolean;
  missed?: boolean;
  /** Present on session entries — what a reschedule acts on. */
  session?: Session;
  planTitle?: string;
  planCount?: number;
  /** How many treatment sessions share this calendar day (1 = no clash). */
  sameDay?: number;
}

const APPT_TONE: Record<string, Entry["tone"]> = {
  booked: "muted", confirmed: "ok", checked_in: "ok",
  completed: "muted", cancelled: "danger", no_show: "warn",
};

export function PatientSchedulePage() {
  const { id = "" } = useParams();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const { can, flagOn } = useAuth();
  // Moving a session is a scheduling act, so whoever books appointments can do it.
  const canReschedule = can("appointment.manage") || can("dental.manage");
  const [lens, setLens] = useState<"upcoming" | "past" | "all">("upcoming");
  const [moving, setMoving] = useState<Entry | null>(null);

  const patient = useQuery({ queryKey: ["patient", id], queryFn: () => getPatient(id) });
  // Two years back, two forward: wide enough never to hide something, small enough
  // to stay a single quick query.
  const range = useMemo(() => {
    const now = new Date();
    return {
      from: new Date(now.getFullYear() - 2, 0, 1).toISOString(),
      to: new Date(now.getFullYear() + 2, 0, 1).toISOString(),
    };
  }, []);
  const appts = useQuery({
    queryKey: ["patient-appointments", id],
    queryFn: () => listPatientAppointments(id, range.from, range.to),
  });
  const dental = flagOn("dental");
  const summary = useQuery({ queryKey: ["dental-summary", id], queryFn: () => dentalSummary(id), enabled: dental });

  const today = todayISO();

  const entries: Entry[] = useMemo(() => {
    const out: Entry[] = [];
    for (const a of appts.data ?? []) {
      const iso = isoOf(new Date(a.starts_at));
      out.push({
        id: a.id, date: iso, time: a.starts_at, kind: "appointment",
        title: a.is_followup ? "Follow-up appointment" : "Appointment",
        detail: [a.provider_name, a.reason].filter(Boolean).join(" · "),
        status: a.status.replace(/_/g, " "), tone: APPT_TONE[a.status] ?? "muted",
        followup: a.is_followup,
      });
    }
    for (const plan of (summary.data?.plans ?? []) as Plan[]) {
      for (const s of plan.sessions as Session[]) {
        if (s.status === "cancelled") continue;
        const paid = s.payment === "paid";
        const owes = (s.status === "done" || s.pay_later) && !paid;
        const missed = s.status === "planned" && s.scheduled_date < today;
        out.push({
          id: s.id, date: s.scheduled_date, kind: "session",
          title: plan.title, detail: `Session ${s.seq} of ${plan.session_count}`,
          status: missed ? "missed" : s.status === "done" ? "done" : "planned",
          tone: missed ? "danger" : owes ? "warn" : s.status === "done" ? "ok" : "muted",
          amount: s.amount_due, missed,
          session: s, planTitle: plan.title, planCount: plan.session_count,
        });
      }
    }
    return out.sort((a, b) => a.date.localeCompare(b.date) || (a.time ?? "").localeCompare(b.time ?? ""));
  }, [appts.data, summary.data, today]);

  // Two treatment sessions on one day is legal — a patient may want a root canal
  // and a filling in the same visit — but it is far more often a scheduling slip.
  // Flag it, never block it. Only days with something still changeable are worth
  // raising, so a day where both sessions are already done stays quiet.
  const sessionsByDay = useMemo(() => {
    const m = new Map<string, Entry[]>();
    for (const e of entries) {
      if (e.kind !== "session") continue;
      (m.get(e.date) ?? m.set(e.date, []).get(e.date)!).push(e);
    }
    return m;
  }, [entries]);
  const clashDays = useMemo(
    () => [...sessionsByDay.entries()]
      .filter(([, list]) => list.length > 1 && list.some((e) => e.session?.status === "planned"))
      .sort((a, b) => a[0].localeCompare(b[0])),
    [sessionsByDay],
  );
  /** Other sessions already on a given day, ignoring the one being moved. */
  const sameDayOthers = (iso: string, exceptId: string) =>
    (sessionsByDay.get(iso) ?? []).filter((e) => e.id !== exceptId);

  const upcoming = entries.filter((e) => e.date >= today);
  const past = entries.filter((e) => e.date < today).reverse();
  const nextUp = upcoming.find((e) => e.status !== "cancelled");
  const missed = entries.filter((e) => e.missed);

  const withClash = (e: Entry): Entry =>
    e.kind === "session" ? { ...e, sameDay: (sessionsByDay.get(e.date) ?? []).length } : e;
  const shown = (lens === "upcoming" ? upcoming : lens === "past" ? past : [...upcoming, ...past]).map(withClash);
  const groups = useMemo(() => {
    const m = new Map<string, Entry[]>();
    for (const e of shown) (m.get(monthKey(e.date)) ?? m.set(monthKey(e.date), []).get(monthKey(e.date))!).push(e);
    return [...m.entries()];
  }, [shown]);

  const afterMove = () => {
    qc.invalidateQueries({ queryKey: ["dental-summary", id] });
    qc.invalidateQueries({ queryKey: ["patient-appointments", id] });
    qc.invalidateQueries({ queryKey: ["dental-cal"] }); // clinic calendar overlay
  };

  if (patient.isLoading) {
    return <div className="space-y-4"><Skeleton className="h-24 w-full rounded-lg" /><Skeleton className="h-64 w-full" /></div>;
  }
  if (patient.isError || !patient.data) {
    return (
      <div className="space-y-4">
        <p className="text-sm text-destructive">Could not load this patient.</p>
        <Button variant="outline" onClick={() => navigate("/patients")}><ArrowLeft /> Patients</Button>
      </div>
    );
  }
  const p = patient.data;
  const fullName = [p.first_name, p.middle_name, p.last_name].filter(Boolean).join(" ");
  const loading = appts.isLoading || (dental && summary.isLoading);

  return (
    <div className="mx-auto max-w-4xl space-y-6">
      <button onClick={() => navigate(`/patients/${id}`)} className="flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground">
        <ArrowLeft className="h-4 w-4" /> {fullName}
      </button>

      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1>Schedule</h1>
          <p className="text-sm text-muted-foreground">{fullName} · MRN {p.mrn} · {ageLabel(p.dob)}</p>
        </div>
        {can("appointment.manage") && (
          <Button onClick={() => navigate("/appointments")}><CalendarPlus /> Book appointment</Button>
        )}
      </div>

      {/* The question this page exists to answer, answered before anything else. */}
      <Card className={cn("border-l-4", nextUp ? "border-l-brand" : "border-l-muted")}>
        <CardContent className="flex flex-wrap items-center gap-x-6 gap-y-3 p-5">
          <div className="min-w-0">
            <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Next visit</p>
            {loading ? <Skeleton className="mt-2 h-7 w-56" /> : nextUp ? (
              <>
                <p className="mt-1 text-xl font-bold tracking-tight">
                  {fmtDay(nextUp.date)}{nextUp.time ? ` · ${fmtTime(nextUp.time)}` : ""}
                </p>
                <p className="text-sm text-muted-foreground">
                  {formatEthiopian(nextUp.date)} EC · {nextUp.title}{nextUp.detail ? ` · ${nextUp.detail}` : ""}
                </p>
              </>
            ) : (
              <p className="mt-1 text-lg font-semibold text-muted-foreground">Nothing booked</p>
            )}
          </div>
          {nextUp && (
            <div className="ml-auto flex items-center gap-4">
              <div className="text-right">
                <p className="text-xs uppercase tracking-wide text-muted-foreground">In</p>
                <p className="text-2xl font-bold tabular-nums text-brand">
                  {Math.max(0, dayDiff(nextUp.date))}<span className="ml-1 text-sm font-medium text-muted-foreground">days</span>
                </p>
              </div>
              {canReschedule && nextUp.session && nextUp.session.status === "planned" && (
                <Button size="sm" variant="outline" onClick={() => setMoving(nextUp)}>
                  <CalendarClock className="h-3.5 w-3.5" /> Move
                </Button>
              )}
            </div>
          )}
        </CardContent>
      </Card>

      {/* An alert you cannot act on is noise. Name the problem, and fix it here. */}
      {(missed.length > 0 || clashDays.length > 0) && (
        <Card className="overflow-hidden border-amber-300">
          <div className="flex items-center gap-2 border-b border-amber-200 bg-amber-50 px-4 py-2.5">
            <AlertTriangle className="h-4 w-4 shrink-0 text-amber-600" />
            <span className="text-sm font-semibold text-amber-900">Needs attention</span>
            <span className="text-xs text-amber-800">
              {[missed.length && `${missed.length} missed`, clashDays.length && `${clashDays.length} double-booked ${clashDays.length === 1 ? "day" : "days"}`]
                .filter(Boolean).join(" · ")}
            </span>
          </div>
          <div className="divide-y">
            {missed.map((e) => (
              <div key={"m" + e.id} className="flex flex-wrap items-center gap-3 px-4 py-3">
                <Badge variant="destructive" className="shrink-0">Missed</Badge>
                <div className="min-w-0 flex-1">
                  <div className="font-medium">{e.title} <span className="font-normal text-muted-foreground">· {e.detail}</span></div>
                  <div className="text-xs text-muted-foreground">
                    Was due {fmtShort(e.date)} · {formatEthiopian(e.date)} EC · <span className="font-medium text-rose-600">{relative(e.date)}</span>
                  </div>
                </div>
                {canReschedule
                  ? <Button size="sm" onClick={() => setMoving(e)}><CalendarClock className="h-3.5 w-3.5" /> Reschedule</Button>
                  : <Badge variant="warning">needs rebooking</Badge>}
              </div>
            ))}

            {clashDays.map(([day, list]) => (
              <div key={"c" + day} className="px-4 py-3">
                <div className="flex flex-wrap items-baseline gap-2">
                  <Badge variant="warning" className="shrink-0">{list.length} on one day</Badge>
                  <span className="text-sm font-medium">{fmtShort(day)}</span>
                  <span className="text-xs text-muted-foreground">{formatEthiopian(day)} EC · {relative(day)}</span>
                </div>
                <p className="mt-1 text-xs text-muted-foreground">
                  Fine if the patient is having both in one visit — otherwise move one.
                </p>
                <div className="mt-2 space-y-1.5">
                  {list.map((e) => (
                    <div key={e.id} className="flex flex-wrap items-center gap-3 rounded-md bg-muted/50 px-3 py-2">
                      <div className="min-w-0 flex-1 text-sm">
                        <span className="font-medium">{e.title}</span>
                        <span className="text-muted-foreground"> · {e.detail}</span>
                        {e.session?.status === "done" && <span className="ml-2 text-xs text-emerald-600">already done</span>}
                      </div>
                      {canReschedule && e.session?.status === "planned" && (
                        <Button size="sm" variant="outline" onClick={() => setMoving(e)}>
                          <CalendarClock className="h-3.5 w-3.5" /> Move this one
                        </Button>
                      )}
                    </div>
                  ))}
                </div>
              </div>
            ))}
          </div>
        </Card>
      )}

      <div className="flex flex-wrap items-center gap-1 rounded-lg bg-muted p-1">
        {([["upcoming", "Upcoming", upcoming.length], ["past", "Past", past.length], ["all", "All", entries.length]] as const).map(([k, label, n]) => (
          <button key={k} onClick={() => setLens(k)}
            className={cn("flex items-center gap-1.5 rounded-md px-3 py-1.5 text-sm font-medium transition-colors",
              lens === k ? "bg-card text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground")}>
            {label}<span className="rounded-full bg-foreground/10 px-1.5 text-xs tabular-nums">{n}</span>
          </button>
        ))}
      </div>

      {loading ? (
        <Card className="p-6"><Skeleton className="h-40 w-full" /></Card>
      ) : shown.length === 0 ? (
        <Card className="p-12 text-center text-sm text-muted-foreground">
          {lens === "upcoming" ? "No upcoming visits for this patient." : lens === "past" ? "No past visits on record." : "Nothing scheduled yet."}
        </Card>
      ) : (
        <div className="space-y-6">
          {groups.map(([mk, list]) => (
            <div key={mk}>
              <div className="mb-2 flex items-baseline gap-3">
                <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">{fmtMonth(mk)}</span>
                <span className="h-px flex-1 bg-border" />
              </div>
              <Card className="divide-y overflow-hidden">
                {list.map((e) => (
                  <Row key={e.kind + e.id} e={e} today={today}
                    onMove={canReschedule && e.session?.status === "planned" ? () => setMoving(e) : undefined} />
                ))}
              </Card>
            </div>
          ))}
        </div>
      )}

      {moving && (
        <MoveSessionDialog
          patientId={id} sessionId={moving.id} planTitle={moving.planTitle ?? moving.title}
          currentDate={moving.date} detail={moving.detail} missed={moving.missed}
          clashes={(iso) => sameDayOthers(iso, moving.id).map((e) => ({
            id: e.id, label: `${e.planTitle ?? e.title} · ${e.detail}`, done: e.session?.status === "done",
          }))}
          onClose={() => setMoving(null)} onMoved={afterMove} />
      )}
    </div>
  );
}

function Row({ e, today, onMove }: { e: Entry; today: string; onMove?: () => void }) {
  const isToday = e.date === today;
  const tone = { ok: "text-emerald-600", warn: "text-amber-600", danger: "text-rose-600", muted: "text-muted-foreground" }[e.tone];
  return (
    <div className={cn("group flex flex-wrap items-center gap-3 p-4", isToday && "bg-brand/[0.04]", e.missed && "bg-rose-50/40")}>
      {/* Date rail — the spine of the timeline. */}
      <div className="w-[4.5rem] shrink-0 text-center">
        <div className="text-[11px] uppercase tracking-wide text-muted-foreground">
          {new Date(`${e.date}T00:00:00`).toLocaleDateString(undefined, { month: "short" })}
        </div>
        <div className={cn("text-xl font-bold tabular-nums leading-tight", isToday && "text-brand", e.missed && "text-rose-600")}>
          {new Date(`${e.date}T00:00:00`).getDate()}
        </div>
        <div className="text-[11px] tabular-nums text-muted-foreground">{e.time ? fmtTime(e.time) : "all day"}</div>
      </div>

      <span className={cn("grid h-8 w-8 shrink-0 place-items-center rounded-full",
        e.kind === "session" ? "bg-violet-100 text-violet-700" : "bg-secondary text-brand")}>
        {e.kind === "session" ? <Stethoscope className="h-4 w-4" />
          : e.followup ? <Repeat2 className="h-4 w-4" /> : <CalendarClock className="h-4 w-4" />}
      </span>

      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <span className="font-medium">{e.title}</span>
          {isToday && <Badge variant="default">Today</Badge>}
          {e.missed && <Badge variant="destructive">Missed</Badge>}
          {(e.sameDay ?? 1) > 1 && <Badge variant="warning">{e.sameDay} sessions this day</Badge>}
        </div>
        {e.detail && <div className="truncate text-xs text-muted-foreground">{e.detail}</div>}
        <div className="text-[11px] text-muted-foreground">
          {formatEthiopian(e.date)} EC · {relative(e.date)}
        </div>
      </div>

      {e.amount && num(e.amount) > 0 && (
        <span className="whitespace-nowrap font-mono text-sm tabular-nums text-muted-foreground">{birr(e.amount)}</span>
      )}
      <span className={cn("w-20 text-right text-sm font-medium capitalize", tone)}>{e.status}</span>

      {/* Actions stay quiet until the row is hovered — but only where hover exists.
          Touch has none, so phones always show the button, at a thumb-sized height. */}
      <div className="w-[7.5rem] text-right">
        {onMove && (
          <Button size="sm" variant="ghost" onClick={onMove}
            className={cn("opacity-100 transition-opacity focus-visible:opacity-100 max-md:min-h-9 md:opacity-0 md:group-hover:opacity-100", e.missed && "md:opacity-100")}>
            <CalendarClock className="h-3.5 w-3.5" /> Reschedule
          </Button>
        )}
      </div>
    </div>
  );
}

