import { useMemo, useState, useSyncExternalStore } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import {
  AlertTriangle,
  ArrowLeftRight,
  CalendarClock,
  CalendarPlus,
  ChevronLeft,
  ChevronRight,
  Filter,
  MoreHorizontal,
  Repeat2,
  Stethoscope,
  X,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Segmented } from "@/components/ui/segmented";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { toast } from "@/components/ui/sonner";
import { AppError } from "@/lib/api-client";
import { useAuth } from "@/app/auth-context";
import { listBranches, listProviders } from "@/features/admin/api";
import {
  checkInAppointment,
  listAppointments,
  listFollowups,
  reassignProvider,
  setAppointmentStatus,
  type Appointment,
} from "@/features/scheduling/api";
import { BookingDialog, PatientCombobox } from "@/features/scheduling/components/BookingDialog";
import { getPatient } from "@/features/patients/api";
import { listDentalSessions, type DentalSessionCal } from "@/features/dental/api";
import { ETH_MONTHS, formatEthiopian, formatEthiopianRange, toEthiopian } from "@/lib/ethiopian";

type View = "day" | "week" | "month" | "followups";

function statusVariant(s: string): "default" | "brand" | "success" | "warning" | "destructive" | "outline" {
  return ({ booked: "default", confirmed: "brand", checked_in: "success", completed: "outline", cancelled: "destructive", no_show: "warning" } as const)[s] ?? "default";
}
/** Left border colour for calendar event blocks, by status. */
function eventAccent(s: string) {
  return ({ booked: "border-l-slate-400", confirmed: "border-l-primary", checked_in: "border-l-emerald-500", completed: "border-l-slate-300", cancelled: "border-l-rose-400", no_show: "border-l-amber-500" } as Record<string, string>)[s] ?? "border-l-slate-400";
}
const fmtTime = (iso: string) => new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
const fmtDay = (iso: string) => new Date(iso).toLocaleDateString(undefined, { weekday: "short", day: "numeric", month: "short" });
const fmtShort = (iso: string) => new Date(iso).toLocaleDateString(undefined, { day: "numeric", month: "short" });
const dayKey = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
const startOfDay = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate());
const addDays = (d: Date, n: number) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);
const mondayOf = (d: Date) => addDays(startOfDay(d), -((d.getDay() + 6) % 7));
const WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

/** Group appointments by local calendar day, each day sorted by start time.
 *  The one derivation both the week agenda and the month grid read, so the two
 *  views cannot drift apart on how a day's list is built. */
function groupByDay(items: Appointment[]): Record<string, Appointment[]> {
  const m: Record<string, Appointment[]> = {};
  for (const a of items) (m[dayKey(new Date(a.starts_at))] ??= []).push(a);
  for (const k of Object.keys(m)) m[k].sort((a, b) => a.starts_at.localeCompare(b.starts_at));
  return m;
}

const MD_QUERY = "(min-width: 768px)";
const mdMq = () => window.matchMedia(MD_QUERY);
/** Tracks the md breakpoint, so the week view mounts only its active
 *  representation instead of rendering both and hiding one with CSS. */
function useIsDesktop() {
  return useSyncExternalStore(
    (onChange) => {
      const mq = mdMq();
      mq.addEventListener("change", onChange);
      return () => mq.removeEventListener("change", onChange);
    },
    () => mdMq().matches,
  );
}

// Dental treatment session: a visually distinct layer from appointments, coloured
// by money state so the doctor spots owed/paid at a glance.
//
// "Owes" is the SAME predicate the server uses for `due`: treatment delivered, with
// nothing live at the cashier. It previously painted a session red when the fee was
// already queued for payment, and when the patient had merely promised to pay for a
// visit that had not happened yet — both of which read as "chase this patient".
function sessOwes(s: DentalSessionCal) {
  return s.status === "done" && (s.payment === "unpaid" || s.payment === "refunded");
}
function sessAccent(s: DentalSessionCal) {
  if (s.payment === "paid") return "border-l-emerald-500 bg-emerald-50";
  if (s.payment === "waived") return "border-l-slate-400 bg-slate-50";
  if (sessOwes(s)) return "border-l-rose-500 bg-rose-50";
  if (s.payment === "billed") return "border-l-amber-500 bg-amber-50";
  return "border-l-violet-500 bg-violet-50";
}
/** Compact treatment-session chip for month/week cells. Static (div) in month cells. */
function SessionChip({ s, onOpen }: { s: DentalSessionCal; onOpen?: (pid: string, sessionId?: string) => void }) {
  const inner = (
    <>
      <Stethoscope className="h-2.5 w-2.5 shrink-0 text-violet-600" />
      <span className="truncate font-medium text-brand">{s.patient_name}</span>
      <span className="ml-auto shrink-0 tabular-nums text-muted-foreground">S{s.seq}/{s.session_count}</span>
    </>
  );
  const cls = `flex items-center gap-1 truncate rounded border-l-2 px-1 py-0.5 text-[11px] ${sessAccent(s)}`;
  const title = `${s.title} — session ${s.seq}/${s.session_count} · ${s.patient_name}${sessOwes(s) ? " · owes" : ""}`;
  return onOpen
    ? <button type="button" title={title} className={`${cls} w-full text-left hover:shadow-sm`} onClick={(e) => { e.stopPropagation(); onOpen(s.patient_id, s.session_id); }}>{inner}</button>
    : <div title={title} className={cls}>{inner}</div>;
}

const isActive = (s: string) => s !== "cancelled" && s !== "completed" && s !== "no_show";
/** A handed-off follow-up: the ordering doctor differs from who now attends. */
const handedOff = (a: Appointment) => a.is_followup && !!a.ordered_by && a.ordered_by !== a.provider_id;

/** Pick one patient to narrow the whole calendar to. Reuses the booking dialog's
 *  combobox, so searching for a patient works the same way in both places. */
function PatientFilter({ value, onChange }: { value: string; onChange: (id: string) => void }) {
  const q = useQuery({
    queryKey: ["patient", value],
    queryFn: () => getPatient(value),
    enabled: !!value,
  });
  const name = q.data ? [q.data.first_name, q.data.last_name].filter(Boolean).join(" ") : "";
  if (value) {
    return (
      <Button variant="secondary" size="sm" className="h-9 gap-1.5" onClick={() => onChange("")}>
        <Filter className="h-3.5 w-3.5" />
        <span className="max-w-[10rem] truncate">{name || "Patient"}</span>
        <X className="h-3.5 w-3.5 opacity-70" />
      </Button>
    );
  }
  return (
    <div className="w-[190px] max-md:w-full">
      <PatientCombobox value={null} onSelect={(p) => onChange(p.id)} />
    </div>
  );
}

/** Dental-overlay legend. Two homes — inline under the toolbar on desktop, inside
 *  the phone Filters panel — so the items live once. */
function LegendItems() {
  return (
    <>
      <span className="flex items-center gap-1"><span className="h-2.5 w-2.5 rounded border-l-2 border-l-primary bg-secondary/70" /> Appointment</span>
      <span className="flex items-center gap-1"><Repeat2 className="h-3 w-3 text-primary" /> Follow-up visit</span>
      <span className="flex items-center gap-1"><Stethoscope className="h-3 w-3 text-violet-600" /> Treatment session</span>
      <span className="flex items-center gap-1"><span className="h-2.5 w-2.5 rounded border-l-2 border-l-rose-500 bg-rose-50" /> owes</span>
      <span className="flex items-center gap-1"><span className="h-2.5 w-2.5 rounded border-l-2 border-l-emerald-500 bg-emerald-50" /> paid</span>
    </>
  );
}

export function AppointmentsPage() {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const { can, flagOn, activeBranchId } = useAuth();
  // The filters live in the URL. That is what lets the patient page link straight
  // to "this patient, on the calendar", and it means a filtered view survives a
  // refresh instead of silently resetting to everybody.
  const [params, setParams] = useSearchParams();
  const setParam = (patch: Record<string, string>) => {
    const next = new URLSearchParams(params);
    for (const [k, v] of Object.entries(patch)) {
      if (v) next.set(k, v); else next.delete(k);
    }
    setParams(next, { replace: true });
  };
  const patientFilter = params.get("patient") ?? "";
  const providerFilter = params.get("provider") ?? "all";
  // Seeded once, never forced per render — the user can still switch views. On a
  // phone the week grid leaves each day ~41px after the hour gutter, so "day" is
  // the only arrival view that is readable there. A patient deep-link keeps
  // "month" everywhere: it answers "when are they next in", which one day cannot.
  const [view, setView] = useState<View>(() =>
    params.get("patient") ? "month" : mdMq().matches ? "week" : "day",
  );
  const isDesktop = useIsDesktop();
  const [anchor, setAnchor] = useState(() => startOfDay(new Date()));
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editing, setEditing] = useState<Appointment | null>(null);
  const [reassign, setReassign] = useState<Appointment | null>(null);
  // Phones: patient filter + provider select + legend fold behind one disclosure
  // row — inline they stacked the toolbar ~450px tall before the calendar started.
  const [filtersOpen, setFiltersOpen] = useState(false);

  const filteredPatient = useQuery({
    queryKey: ["patient", patientFilter],
    queryFn: () => getPatient(patientFilter),
    enabled: !!patientFilter,
  });
  const patientLabel = filteredPatient.data
    ? [filteredPatient.data.first_name, filteredPatient.data.last_name].filter(Boolean).join(" ")
    : "";

  const branches = useQuery({ queryKey: ["branches"], queryFn: listBranches });
  const branchId = activeBranchId ?? branches.data?.[0]?.id ?? "";
  const providers = useQuery({ queryKey: ["providers"], queryFn: listProviders });

  const { from, to, weekDays, monthDays } = useMemo(() => {
    if (view === "day") {
      const f = startOfDay(anchor);
      return { from: f, to: addDays(f, 1), weekDays: [], monthDays: [] };
    }
    if (view === "week") {
      const start = mondayOf(anchor);
      return { from: start, to: addDays(start, 7), weekDays: Array.from({ length: 7 }, (_, i) => addDays(start, i)), monthDays: [] };
    }
    // month — 6-week grid starting on the Monday of the week containing the 1st
    const first = new Date(anchor.getFullYear(), anchor.getMonth(), 1);
    const gridStart = mondayOf(first);
    const md = Array.from({ length: 42 }, (_, i) => addDays(gridStart, i));
    return { from: gridStart, to: addDays(gridStart, 42), weekDays: [], monthDays: md };
  }, [view, anchor]);

  const appts = useQuery({
    queryKey: ["appointments", branchId, from.toISOString(), to.toISOString()],
    queryFn: () => listAppointments(branchId, from.toISOString(), to.toISOString()),
    enabled: !!branchId && view !== "followups",
  });
  const followups = useQuery({
    queryKey: ["followups", branchId],
    queryFn: () => listFollowups(branchId),
    enabled: !!branchId && view === "followups",
  });

  const items = useMemo(() => {
    let list = appts.data ?? [];
    if (providerFilter !== "all") list = list.filter((a) => a.provider_id === providerFilter);
    // A patient filter has to reach the sessions too, or filtering to one patient
    // still shows every other patient's treatment visits beside them.
    if (patientFilter) list = list.filter((a) => a.patient_id === patientFilter);
    return list;
  }, [appts.data, providerFilter, patientFilter]);

  // Dental treatment sessions overlaid on the calendar (clinic-wide, follow-up visits).
  const dentalOn = flagOn("dental") && (can("dental.manage") || can("appointment.manage"));
  const calSessions = useQuery({
    queryKey: ["dental-cal", from.toISOString(), to.toISOString()],
    queryFn: () => listDentalSessions(dayKey(from), dayKey(addDays(to, -1))),
    enabled: dentalOn && view !== "followups",
  });
  const fuFrom = dayKey(addDays(startOfDay(new Date()), -30));
  const fuTo = dayKey(addDays(startOfDay(new Date()), 120));
  const fuSessions = useQuery({
    queryKey: ["dental-fu", fuFrom, fuTo],
    queryFn: () => listDentalSessions(fuFrom, fuTo),
    enabled: dentalOn && view === "followups",
  });
  const sessByDay = useMemo(() => {
    const m: Record<string, DentalSessionCal[]> = {};
    for (const s of calSessions.data ?? []) {
      if (patientFilter && s.patient_id !== patientFilter) continue;
      (m[s.scheduled_date] ??= []).push(s);
    }
    return m;
  }, [calSessions.data, patientFilter]);

  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ["appointments"] });
    qc.invalidateQueries({ queryKey: ["followups"] });
  };
  const checkIn = useMutation({
    mutationFn: (id: string) => checkInAppointment(id),
    onSuccess: (r) => { toast.success(r.gated ? "Checked in — billed; joins the queue once payment is collected." : "Checked in — added to queue."); invalidate(); },
    onError: (e) => toast.error(e instanceof AppError ? e.message : "Check-in failed"),
  });
  const status = useMutation({
    mutationFn: ({ id, s }: { id: string; s: string }) => setAppointmentStatus(id, s),
    onSuccess: (_r, v) => { toast.success(({ cancelled: "Appointment cancelled", completed: "Marked completed", no_show: "Marked no-show", confirmed: "Confirmed" } as Record<string, string>)[v.s] ?? "Updated"); invalidate(); },
    onError: (e) => toast.error(e instanceof AppError ? e.message : "Could not update"),
  });

  const shift = (n: number) => {
    if (view === "month") setAnchor(startOfDay(new Date(anchor.getFullYear(), anchor.getMonth() + n, 1)));
    else setAnchor(addDays(anchor, n * (view === "week" ? 7 : 1)));
  };

  const label =
    view === "week"
      ? `${weekDays[0]?.toLocaleDateString(undefined, { month: "short", day: "numeric" })} – ${weekDays[6]?.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" })} · ${formatEthiopianRange(from, to)}`
      : view === "month"
        ? `${anchor.toLocaleDateString(undefined, { month: "long", year: "numeric" })} · ${formatEthiopianRange(new Date(anchor.getFullYear(), anchor.getMonth(), 1), new Date(anchor.getFullYear(), anchor.getMonth() + 1, 1))}`
        : view === "followups"
          ? "Follow-ups needing attention and coming up"
          : `${anchor.toLocaleDateString(undefined, { weekday: "long", month: "long", day: "numeric" })} · ${formatEthiopian(anchor)}`;

  const dayItems = useMemo(() => items.filter((a) => dayKey(new Date(a.starts_at)) === dayKey(anchor)), [items, anchor]);

  const actions: Actions = {
    onCheckIn: (id) => checkIn.mutate(id),
    onReassign: (a) => setReassign(a),
    onReschedule: (a) => { setEditing(a); setDialogOpen(true); },
    onStatus: (id, s) => status.mutate({ id, s }),
    // Clicking a treatment session opens the patient page focused on THAT visit
    // rather than on whatever the page would resolve to on its own. Without the
    // session id, booking a follow-up from the calendar and then clicking it landed
    // the dentist on a different session of the same course.
    onOpenPatient: (pid, visit) => navigate(`/patients/${pid}${visit ? `?visit=${visit}` : ""}`),
    onOpenDay: (d) => { setAnchor(startOfDay(d)); setView("day"); },
    canQueue: can("queue.manage"),
  };

  const activeFilters = (patientFilter ? 1 : 0) + (providerFilter !== "all" ? 1 : 0);
  // Rendered in two homes (inline on desktop, inside the phone Filters panel), so
  // built once to keep the two in lockstep.
  const providerSelect = (triggerCls: string) => (
    <Select value={providerFilter} onValueChange={(v) => setParam({ provider: v === "all" ? "" : v })}>
      <SelectTrigger className={triggerCls}><SelectValue /></SelectTrigger>
      <SelectContent>
        <SelectItem value="all">All providers</SelectItem>
        {(providers.data ?? []).map((p) => (
          <SelectItem key={p.id} value={p.id}>{p.full_name}</SelectItem>
        ))}
      </SelectContent>
    </Select>
  );

  // The viewport-height frame lets the week/month grids own their scroll on
  // desktop. Below md the bottom tab bar (4rem + safe area) eats into 100dvh and
  // the views are lists anyway — natural page scroll, no scroller-in-a-letterbox.
  return (
    <div className="flex h-[calc(100dvh-8rem)] min-h-[560px] flex-col gap-5 max-md:h-auto max-md:min-h-0">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1>Appointments</h1>
          <p className="text-sm text-muted-foreground">{label}</p>
        </div>
        <div className="flex flex-wrap items-center gap-2 max-md:w-full">
          {/* The shared Segmented tablist: real aria-selected/arrow-key semantics
              and the same white selected pill as every other view switcher. On
              phones it scrolls in place, so all four tabs stay reachable at 360px
              while Today and Book hold the same line. */}
          <Segmented
            value={view}
            onChange={setView}
            ariaLabel="Calendar view"
            className="max-md:min-w-0 max-md:flex-1"
            options={[
              { value: "day", label: "Day" },
              { value: "week", label: "Week" },
              { value: "month", label: "Month" },
              { value: "followups", label: "Follow-ups" },
            ]}
          />
          {/* Filter to one patient. A doctor with forty appointments a week cannot
              answer "when is Yaz T next in" by reading the grid; this is that
              question. The name is fetched rather than taken from the visible
              items, so the banner still reads properly in a month the patient has
              nothing booked in — which is exactly when it is asked.
              On phones both filters live behind the Filters disclosure below;
              md:contents keeps the desktop row's flex layout untouched. */}
          <div className="hidden md:contents">
            <PatientFilter
              value={patientFilter}
              onChange={(id) => setParam({ patient: id })}
            />
            {view !== "followups" && (providers.data?.length ?? 0) > 1 && providerSelect("w-[170px]")}
          </div>
          {view !== "followups" && (
            <>
              <Button variant="outline" size="icon" className="max-md:hidden" aria-label={`Previous ${view}`} onClick={() => shift(-1)}><ChevronLeft /></Button>
              <Button variant="outline" size="sm" className="max-md:min-h-9" onClick={() => setAnchor(startOfDay(new Date()))}>Today</Button>
              <Button variant="outline" size="icon" className="max-md:hidden" aria-label={`Next ${view}`} onClick={() => shift(1)}><ChevronRight /></Button>
            </>
          )}
          {can("appointment.manage") && branchId && (
            <Button onClick={() => { setEditing(null); setDialogOpen(true); }}><CalendarPlus /> Book</Button>
          )}
        </div>
        {/* Phone-only second row: period nav plus the filter disclosure. */}
        <div className="flex w-full items-center gap-2 md:hidden">
          {view !== "followups" && (
            <>
              <Button variant="outline" size="icon" aria-label={`Previous ${view}`} onClick={() => shift(-1)}><ChevronLeft /></Button>
              <Button variant="outline" size="icon" aria-label={`Next ${view}`} onClick={() => shift(1)}><ChevronRight /></Button>
            </>
          )}
          <Button variant="outline" size="sm" className="ml-auto min-h-9 gap-1.5" aria-expanded={filtersOpen} onClick={() => setFiltersOpen((v) => !v)}>
            <Filter className="h-3.5 w-3.5" /> Filters{activeFilters > 0 ? ` (${activeFilters})` : ""}
          </Button>
        </div>
        {filtersOpen && (
          <div className="w-full space-y-3 rounded-md border bg-card p-3 md:hidden">
            <PatientFilter value={patientFilter} onChange={(id) => setParam({ patient: id })} />
            {view !== "followups" && (providers.data?.length ?? 0) > 1 && providerSelect("w-full")}
            {dentalOn && view !== "followups" && (
              <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground"><LegendItems /></div>
            )}
          </div>
        )}
      </div>

      {dentalOn && view !== "followups" && (
        <div className="-mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground max-md:hidden">
          <LegendItems />
        </div>
      )}

      {patientFilter && (
        // Without this, filtering to a patient with nothing this month looks like a
        // broken calendar rather than an answered question.
        <div className="flex flex-wrap items-center gap-2 rounded-md border border-brand/30 bg-brand/5 px-3 py-2 text-sm">
          <Filter className="h-4 w-4 shrink-0 text-brand" />
          <span className="text-brand">
            Showing <b>{patientLabel || "this patient"}</b> only — appointments and treatment visits.
          </span>
          <Link to={`/patients/${patientFilter}`} className="text-xs font-medium text-brand underline-offset-2 hover:underline">
            Open their record
          </Link>
          <Button variant="ghost" size="sm" className="ml-auto h-7 px-2 text-xs max-md:min-h-9"
            onClick={() => setParam({ patient: "" })}>
            <X className="h-3.5 w-3.5" /> Show everyone
          </Button>
        </div>
      )}

      <div className="min-h-0 flex-1 max-md:flex-none">
        {!branchId && !branches.isLoading ? (
          <Card className="flex h-full items-center justify-center p-10 text-center text-sm text-muted-foreground">Add a branch in Settings to start booking.</Card>
        ) : view === "followups" ? (
          <div className="h-full space-y-8 overflow-y-auto pr-1">
            {dentalOn && <DentalSessionsLens q={fuSessions} actions={actions} />}
            <FollowupsLens q={followups} actions={actions} />
          </div>
        ) : appts.isLoading ? (
          <Card className="flex h-full flex-col gap-2 p-4">{Array.from({ length: 8 }).map((_, i) => <Skeleton key={i} className="h-10 w-full" />)}</Card>
        ) : view === "day" ? (
          <DayLanes items={dayItems} sessions={sessByDay[dayKey(anchor)] ?? []} providers={providers.data ?? []} filter={providerFilter} actions={actions} onWeek={() => setView("week")} />
        ) : view === "week" ? (
          // At 390px the 7-column paint gives each day ~41px — events become
          // ~20px chips nobody can read or tap. Phones get the week as a stacked
          // agenda; the time grid is untouched from md up. Only the active
          // representation mounts (the breakpoint classes stay as a guard for the
          // instant between a resize and the media-query re-render).
          isDesktop ? (
            <div className="hidden h-full md:block">
              <WeekTimeGrid days={weekDays} items={items} sessByDay={sessByDay} actions={actions} />
            </div>
          ) : (
            <div className="md:hidden">
              <WeekAgenda days={weekDays} items={items} sessByDay={sessByDay} actions={actions} />
            </div>
          )
        ) : (
          <MonthGrid days={monthDays} monthIndex={anchor.getMonth()} items={items} sessByDay={sessByDay} actions={actions} />
        )}
      </div>

      {branchId && (
        <BookingDialog open={dialogOpen} onOpenChange={setDialogOpen} branchId={branchId} defaultDate={dayKey(anchor)} existing={editing} onSaved={invalidate} />
      )}
      <ReassignDialog appt={reassign} onOpenChange={(o) => !o && setReassign(null)} providers={providers.data ?? []} onDone={invalidate} />
    </div>
  );
}

type Actions = {
  onCheckIn: (id: string) => void;
  onReassign: (a: Appointment) => void;
  onReschedule: (a: Appointment) => void;
  onStatus: (id: string, s: string) => void;
  onOpenPatient: (pid: string, sessionId?: string) => void;
  onOpenDay: (d: Date) => void;
  canQueue: boolean;
};

/** Coverage chip for a follow-up: attended / covered until date / cover expired. */
function CoverageBadge({ a }: { a: Appointment }) {
  if (!a.is_followup) return null;
  if (a.status === "completed") return <Badge variant="outline">attended</Badge>;
  if (a.free_until && new Date(a.free_until) < new Date()) return <Badge variant="warning">cover expired</Badge>;
  if (a.free_until) return <Badge variant="success">covered → {fmtShort(a.free_until)}</Badge>;
  return <Badge variant="success">covered</Badge>;
}

function ApptMenu({ a, actions }: { a: Appointment; actions: Actions }) {
  const active = isActive(a.status);
  return (
    <DropdownMenu>
      {/* The only route to check-in/reassign/reschedule, yet p-1.5 leaves a ~28px
          target. touch-hit grows the hit area to ~44px without touching row height. */}
      <DropdownMenuTrigger aria-label="Appointment actions" className="touch-hit rounded-md p-1.5 hover:bg-accent" onClick={(e) => e.stopPropagation()}><MoreHorizontal className="h-4 w-4" /></DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        {active && a.status !== "checked_in" && actions.canQueue && <DropdownMenuItem onSelect={() => actions.onCheckIn(a.id)}>Check in</DropdownMenuItem>}
        {active && <DropdownMenuItem onSelect={() => actions.onReassign(a)}>Reassign doctor</DropdownMenuItem>}
        {active && <DropdownMenuItem onSelect={() => actions.onReschedule(a)}>Reschedule</DropdownMenuItem>}
        {active && a.status !== "confirmed" && a.status !== "checked_in" && <DropdownMenuItem onSelect={() => actions.onStatus(a.id, "confirmed")}>Confirm</DropdownMenuItem>}
        {active && <DropdownMenuSeparator />}
        {active && <DropdownMenuItem onSelect={() => actions.onStatus(a.id, "completed")}>Mark completed</DropdownMenuItem>}
        {active && <DropdownMenuItem onSelect={() => actions.onStatus(a.id, "no_show")}>Mark no-show</DropdownMenuItem>}
        {active && <DropdownMenuItem className="text-destructive focus:text-destructive" onSelect={() => actions.onStatus(a.id, "cancelled")}>Cancel</DropdownMenuItem>}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function ApptCard({ a, actions }: { a: Appointment; actions: Actions }) {
  return (
    <div className={`rounded-lg border border-l-4 bg-background p-3 shadow-sm ${eventAccent(a.status)}`}>
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="text-sm font-semibold tabular-nums text-brand">{fmtTime(a.starts_at)}<span className="font-normal text-muted-foreground"> – {fmtTime(a.ends_at)}</span></div>
          <button className="touch-hit mt-0.5 block truncate font-medium text-brand hover:underline" onClick={() => actions.onOpenPatient(a.patient_id)}>{a.patient_name}</button>
          <div className="truncate text-xs text-muted-foreground">{a.mrn}{a.reason ? ` · ${a.reason}` : ""}</div>
        </div>
        <ApptMenu a={a} actions={actions} />
      </div>
      <div className="mt-2 flex flex-wrap items-center gap-1.5">
        <Badge variant={statusVariant(a.status)}>{a.status.replace(/_/g, " ")}</Badge>
        {a.is_followup && <Badge variant="brand"><Repeat2 className="mr-1 h-3 w-3" /> follow-up</Badge>}
        <CoverageBadge a={a} />
        {!a.provider_active && <Badge variant="warning"><AlertTriangle className="mr-1 h-3 w-3" /> needs handoff</Badge>}
      </div>
      {handedOff(a) && a.ordered_by_name && <p className="mt-1.5 text-xs text-muted-foreground">Ordered by {a.ordered_by_name} · handled by {a.provider_name}</p>}
    </div>
  );
}

function DayLanes({ items, sessions, providers, filter, actions, onWeek }: { items: Appointment[]; sessions: DentalSessionCal[]; providers: { id: string; full_name: string }[]; filter: string; actions: Actions; onWeek: () => void }) {
  const lanes = useMemo(() => {
    const byProvider = new Map<string, Appointment[]>();
    for (const a of items) (byProvider.get(a.provider_id) ?? byProvider.set(a.provider_id, []).get(a.provider_id)!).push(a);
    const nameOf = (id: string) => providers.find((p) => p.id === id)?.full_name ?? items.find((a) => a.provider_id === id)?.provider_name ?? "Provider";
    return [...byProvider.entries()]
      .map(([id, list]) => ({ id, name: nameOf(id), list: list.sort((a, b) => a.starts_at.localeCompare(b.starts_at)), inactive: list.some((a) => !a.provider_active) }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }, [items, providers]);

  if (items.length === 0 && sessions.length === 0) {
    // Day view fetches exactly one day, so "the next booked day" is not in the
    // data already on hand — the honest escape from an empty day is the week.
    // Phone-only: on desktop the week grid is one click away in the switcher.
    return (
      <Card className="flex h-full items-center justify-center p-12 text-center text-sm text-muted-foreground max-md:flex-col max-md:gap-3">
        <span>{filter === "all" ? "No appointments or treatment sessions for this day." : "No appointments for this provider today."}</span>
        <Button variant="outline" size="sm" className="min-h-9 md:hidden" onClick={onWeek}>Look at the week</Button>
      </Card>
    );
  }
  // Below md the 300px lane rack panned sideways with no cue — lanes stack
  // vertically instead (provider header + that provider's cards). The horizontal
  // rack is untouched from md up.
  return (
    <div className="flex h-full gap-4 overflow-x-auto pb-2 max-md:flex-col max-md:overflow-x-visible">
      {sessions.length > 0 && (
        <Card className="flex w-[300px] shrink-0 flex-col border-l-4 border-l-violet-500 p-3 max-md:w-full">
          <div className="mb-2 flex items-center justify-between gap-2 border-b pb-2">
            <div className="flex min-w-0 items-center gap-2">
              <Stethoscope className="h-4 w-4 shrink-0 text-violet-600" />
              <span className="truncate font-semibold text-brand">Treatment sessions</span>
            </div>
            <span className="shrink-0 text-xs text-muted-foreground">{sessions.length}</span>
          </div>
          <div className="min-h-0 flex-1 space-y-2 overflow-y-auto pr-1">
            {sessions.map((s) => <SessionDayCard key={s.session_id} s={s} onOpen={actions.onOpenPatient} />)}
          </div>
        </Card>
      )}
      {lanes.map((lane) => (
        <Card key={lane.id} className="flex w-[300px] shrink-0 flex-col p-3 max-md:w-full">
          <div className="mb-2 flex items-center justify-between gap-2 border-b pb-2">
            <div className="flex min-w-0 items-center gap-2">
              <span className="truncate font-semibold text-brand">{lane.name}</span>
              {lane.inactive && <AlertTriangle className="h-4 w-4 shrink-0 text-amber-500" />}
            </div>
            <span className="shrink-0 text-xs text-muted-foreground">{lane.list.length}</span>
          </div>
          <div className="min-h-0 flex-1 space-y-2 overflow-y-auto pr-1">
            {lane.list.map((a) => <ApptCard key={a.id} a={a} actions={actions} />)}
          </div>
        </Card>
      ))}
    </div>
  );
}

/** Week as a stacked agenda for phones. At 390px the 7-column paint leaves each
 *  day ~41px after the 56px hour gutter, so events shrink to ~20px chips —
 *  unreadable and untappable. A list gives every event a full-width ≥44px card.
 *  Rendered only below md; the time grid keeps md and up. */
function WeekAgenda({ days, items, sessByDay, actions }: { days: Date[]; items: Appointment[]; sessByDay: Record<string, DentalSessionCal[]>; actions: Actions }) {
  const byDay = useMemo(() => groupByDay(items), [items]);
  const todayKey = dayKey(new Date());
  const total = items.length + days.reduce((n, d) => n + (sessByDay[dayKey(d)] ?? []).length, 0);
  if (total === 0) {
    return <Card className="p-10 text-center text-sm text-muted-foreground">No appointments or treatment sessions this week.</Card>;
  }
  return (
    <div className="space-y-4">
      {days.map((d) => {
        const k = dayKey(d);
        const list = byDay[k] ?? [];
        const sess = sessByDay[k] ?? [];
        if (list.length === 0 && sess.length === 0) return null;
        const today = k === todayKey;
        const e = toEthiopian(d);
        return (
          <section key={k}>
            <button
              type="button"
              onClick={() => actions.onOpenDay(d)}
              aria-label={`Open ${d.toLocaleDateString(undefined, { weekday: "long", month: "long", day: "numeric" })}`}
              className={`flex min-h-9 w-full items-baseline gap-2 px-1 text-left ${today ? "text-primary" : "text-brand"}`}
            >
              <span className="text-sm font-semibold">{d.toLocaleDateString(undefined, { weekday: "short", day: "numeric", month: "short" })}</span>
              <span className="text-[11px] text-muted-foreground">{e.day} {ETH_MONTHS[e.month - 1]}</span>
              <span className="ml-auto text-xs tabular-nums text-muted-foreground">{list.length + sess.length}</span>
            </button>
            <div className="mt-1 space-y-1.5">
              {list.map((a) => (
                <button
                  key={a.id}
                  type="button"
                  onClick={() => actions.onOpenPatient(a.patient_id)}
                  className={`flex min-h-11 w-full items-center gap-2 rounded-md border border-l-4 bg-card px-3 py-2 text-left text-sm shadow-sm ${eventAccent(a.status)}`}
                >
                  <span className="shrink-0 font-semibold tabular-nums text-brand">{fmtTime(a.starts_at)}</span>
                  {a.is_followup && <Repeat2 className="h-3.5 w-3.5 shrink-0 text-primary" />}
                  <span className="min-w-0 flex-1 truncate font-medium text-brand">{a.patient_name}</span>
                  <span className="shrink-0 whitespace-nowrap text-xs capitalize text-muted-foreground">{a.status.replace(/_/g, " ")}</span>
                </button>
              ))}
              {sess.map((s) => (
                <button
                  key={s.session_id}
                  type="button"
                  onClick={() => actions.onOpenPatient(s.patient_id, s.session_id)}
                  className={`flex min-h-11 w-full items-center gap-2 rounded-md border border-l-4 px-3 py-2 text-left text-sm shadow-sm ${sessAccent(s)}`}
                >
                  <Stethoscope className="h-3.5 w-3.5 shrink-0 text-violet-600" />
                  <span className="min-w-0 flex-1 truncate font-medium text-brand">{s.patient_name}</span>
                  <span className="shrink-0 whitespace-nowrap text-xs tabular-nums text-muted-foreground">S{s.seq}/{s.session_count}{sessOwes(s) ? " · owes" : s.payment === "paid" ? " · paid" : ""}</span>
                </button>
              ))}
            </div>
          </section>
        );
      })}
    </div>
  );
}

const HOUR_PX = 52;
/** Assigns overlapping events to side-by-side sub-columns (interval partitioning). */
function packColumns(list: Appointment[]): Map<string, { col: number; cols: number }> {
  const sorted = [...list].sort((a, b) => a.starts_at.localeCompare(b.starts_at) || a.ends_at.localeCompare(b.ends_at));
  const res = new Map<string, { col: number; cols: number }>();
  let cluster: Appointment[] = [];
  let clusterEnd = "";
  const flush = () => {
    const colEnds: string[] = [];
    for (const ev of cluster) {
      let placed = -1;
      for (let c = 0; c < colEnds.length; c++) if (colEnds[c] <= ev.starts_at) { colEnds[c] = ev.ends_at; placed = c; break; }
      if (placed < 0) { colEnds.push(ev.ends_at); placed = colEnds.length - 1; }
      res.set(ev.id, { col: placed, cols: 0 });
    }
    for (const ev of cluster) res.get(ev.id)!.cols = colEnds.length;
    cluster = []; clusterEnd = "";
  };
  for (const ev of sorted) {
    if (cluster.length && ev.starts_at >= clusterEnd) flush();
    cluster.push(ev);
    if (ev.ends_at > clusterEnd) clusterEnd = ev.ends_at;
  }
  if (cluster.length) flush();
  return res;
}

function WeekTimeGrid({ days, items, sessByDay, actions }: { days: Date[]; items: Appointment[]; sessByDay: Record<string, DentalSessionCal[]>; actions: Actions }) {
  const hasSessions = days.some((d) => (sessByDay[dayKey(d)] ?? []).length > 0);
  const { startHour, endHour, byDay } = useMemo(() => {
    let min = 8, max = 18;
    const map: Record<string, Appointment[]> = {};
    for (const a of items) {
      (map[dayKey(new Date(a.starts_at))] ??= []).push(a);
      min = Math.min(min, new Date(a.starts_at).getHours());
      const e = new Date(a.ends_at);
      max = Math.max(max, e.getMinutes() > 0 ? e.getHours() + 1 : e.getHours());
    }
    return { startHour: Math.max(0, min), endHour: Math.min(24, Math.max(max, min + 4)), byDay: map };
  }, [items]);
  const hours = Array.from({ length: endHour - startHour }, (_, i) => startHour + i);
  const gridH = hours.length * HOUR_PX;
  const todayKey = dayKey(new Date());
  const minsFromStart = (iso: string) => { const d = new Date(iso); return (d.getHours() - startHour) * 60 + d.getMinutes(); };

  return (
    <Card className="flex h-full flex-col overflow-hidden">
      {/* day headers */}
      <div className="grid shrink-0 border-b" style={{ gridTemplateColumns: "56px repeat(7, 1fr)" }}>
        <div className="border-r" />
        {days.map((d) => {
          const today = dayKey(d) === todayKey;
          const e = toEthiopian(d);
          return (
            <button key={dayKey(d)} onClick={() => actions.onOpenDay(d)} className={`border-r py-2 text-center last:border-r-0 hover:bg-accent ${today ? "bg-primary/5" : ""}`}>
              <div className="text-xs text-muted-foreground">{d.toLocaleDateString(undefined, { weekday: "short" })}</div>
              <div className={`text-lg font-semibold leading-tight tabular-nums ${today ? "text-primary" : "text-brand"}`}>{d.getDate()}</div>
              <div className="text-[10px] leading-tight text-muted-foreground">{e.day} {ETH_MONTHS[e.month - 1]}</div>
            </button>
          );
        })}
      </div>
      {/* all-day treatment sessions (no time-of-day) */}
      {hasSessions && (
        <div className="grid shrink-0 border-b bg-muted/20" style={{ gridTemplateColumns: "56px repeat(7, 1fr)" }}>
          <div className="flex items-center justify-end border-r px-1 py-1 text-right text-[10px] uppercase tracking-wide text-muted-foreground">Sessions</div>
          {days.map((d) => (
            <div key={dayKey(d)} className="space-y-0.5 border-r p-1 last:border-r-0">
              {(sessByDay[dayKey(d)] ?? []).map((s) => <SessionChip key={s.session_id} s={s} onOpen={actions.onOpenPatient} />)}
            </div>
          ))}
        </div>
      )}
      {/* scrollable time grid */}
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="grid" style={{ gridTemplateColumns: "56px repeat(7, 1fr)", height: gridH }}>
          {/* hour gutter */}
          <div className="relative border-r">
            {hours.map((h, i) => (
              <div key={h} className="absolute right-1 -translate-y-1/2 text-[11px] tabular-nums text-muted-foreground" style={{ top: i * HOUR_PX }}>
                {i === 0 ? "" : `${String(h).padStart(2, "0")}:00`}
              </div>
            ))}
          </div>
          {/* day columns */}
          {days.map((d) => {
            const list = byDay[dayKey(d)] ?? [];
            const packed = packColumns(list);
            const today = dayKey(d) === todayKey;
            return (
              <div key={dayKey(d)} className={`relative border-r last:border-r-0 ${today ? "bg-primary/[0.03]" : ""}`}>
                {hours.map((_, i) => <div key={i} className="absolute inset-x-0 border-t border-border/60" style={{ top: i * HOUR_PX }} />)}
                {list.map((a) => {
                  const p = packed.get(a.id)!;
                  const top = (minsFromStart(a.starts_at) / 60) * HOUR_PX;
                  const dur = (new Date(a.ends_at).getTime() - new Date(a.starts_at).getTime()) / 60000;
                  const h = Math.max((dur / 60) * HOUR_PX, 22);
                  const gap = 2;
                  return (
                    <button
                      key={a.id}
                      onClick={() => actions.onOpenPatient(a.patient_id)}
                      title={`${fmtTime(a.starts_at)} ${a.patient_name}${a.reason ? " · " + a.reason : ""}`}
                      className={`absolute overflow-hidden rounded-md border border-l-[3px] bg-card px-1.5 py-1 text-left text-xs shadow-sm hover:z-10 hover:shadow ${eventAccent(a.status)}`}
                      style={{ top: top + 1, height: h - 2, left: `calc(${(p.col / p.cols) * 100}% + ${gap}px)`, width: `calc(${100 / p.cols}% - ${gap * 2}px)` }}
                    >
                      <div className="flex items-center gap-0.5 font-semibold text-brand">
                        {a.is_followup && <Repeat2 className="h-3 w-3 shrink-0 text-primary" />}
                        <span className="truncate">{a.patient_name}</span>
                      </div>
                      <div className="tabular-nums text-muted-foreground">{fmtTime(a.starts_at)}</div>
                    </button>
                  );
                })}
              </div>
            );
          })}
        </div>
      </div>
    </Card>
  );
}

function MonthGrid({ days, monthIndex, items, sessByDay, actions }: { days: Date[]; monthIndex: number; items: Appointment[]; sessByDay: Record<string, DentalSessionCal[]>; actions: Actions }) {
  const byDay = useMemo(() => groupByDay(items), [items]);
  const todayKey = dayKey(new Date());

  return (
    <Card className="flex h-full flex-col overflow-hidden">
      <div className="grid shrink-0 grid-cols-7 border-b">
        {WEEKDAYS.map((w) => <div key={w} className="py-2 text-center text-xs font-semibold text-muted-foreground">{w}</div>)}
      </div>
      <div className="grid min-h-0 flex-1 grid-cols-7 grid-rows-6">
        {days.map((d) => {
          const list = byDay[dayKey(d)] ?? [];
          const sess = sessByDay[dayKey(d)] ?? [];
          const inMonth = d.getMonth() === monthIndex;
          const today = dayKey(d) === todayKey;
          const e = toEthiopian(d);
          const apptShown = Math.min(list.length, sess.length ? 2 : 4);
          const sessShown = Math.min(sess.length, 2);
          const more = (list.length - apptShown) + (sess.length - sessShown);
          // Phones scroll the page naturally, so month rows no longer stretch to a
          // fixed frame: the min-height floor keeps each day a real tap target, and
          // the label speaks for a cell too small to read.
          return (
            <button
              key={dayKey(d)}
              onClick={() => actions.onOpenDay(d)}
              aria-label={`${d.toLocaleDateString(undefined, { weekday: "long", month: "long", day: "numeric" })}${list.length + sess.length > 0 ? `, ${list.length + sess.length} booked` : ""}`}
              className={`flex min-h-0 flex-col border-b border-r p-1.5 text-left transition-colors hover:bg-accent max-md:min-h-14 [&:nth-child(7n)]:border-r-0 ${inMonth ? "" : "bg-muted/30"}`}
            >
              <div className="mb-1 flex items-center justify-between gap-1">
                <span className={`flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-xs font-semibold tabular-nums ${today ? "bg-primary text-primary-foreground" : inMonth ? "text-brand" : "text-muted-foreground"}`}>{d.getDate()}</span>
                <span className={`truncate text-[10px] font-medium ${e.day === 1 ? "text-primary" : "text-muted-foreground"}`}>{e.day === 1 ? ETH_MONTHS[e.month - 1] : e.day}</span>
              </div>
              <div className="min-h-0 flex-1 space-y-0.5 overflow-hidden">
                {list.slice(0, apptShown).map((a) => (
                  <div key={a.id} className={`flex items-center gap-1 truncate rounded border-l-2 bg-secondary/70 px-1 py-0.5 text-[11px] ${eventAccent(a.status)}`}>
                    {a.is_followup && <Repeat2 className="h-2.5 w-2.5 shrink-0 text-primary" />}
                    <span className="font-semibold tabular-nums text-brand">{fmtTime(a.starts_at)}</span>
                    <span className="truncate text-muted-foreground">{a.patient_name}</span>
                  </div>
                ))}
                {sess.slice(0, sessShown).map((s) => <SessionChip key={s.session_id} s={s} />)}
                {more > 0 && <div className="px-1 text-[10px] font-medium text-primary">+{more} more</div>}
              </div>
            </button>
          );
        })}
      </div>
    </Card>
  );
}

function FollowupsLens({ q, actions }: { q: { data?: Appointment[]; isLoading: boolean }; actions: Actions }) {
  const groups = useMemo(() => {
    const now = new Date();
    const endToday = startOfDay(addDays(now, 1));
    const startToday = startOfDay(now);
    const needsHandoff: Appointment[] = [], overdue: Appointment[] = [], dueToday: Appointment[] = [], upcoming: Appointment[] = [];
    for (const a of q.data ?? []) {
      if (!isActive(a.status)) continue;
      const s = new Date(a.starts_at);
      if (!a.provider_active) needsHandoff.push(a);
      else if (s < startToday && a.status !== "checked_in") overdue.push(a);
      else if (s < endToday) dueToday.push(a);
      else upcoming.push(a);
    }
    return { needsHandoff, overdue, dueToday, upcoming };
  }, [q.data]);

  if (q.isLoading) return <div className="space-y-3">{Array.from({ length: 4 }).map((_, i) => <Skeleton key={i} className="h-16 w-full" />)}</div>;
  const total = groups.needsHandoff.length + groups.overdue.length + groups.dueToday.length + groups.upcoming.length;
  if (total === 0) return <Card className="flex h-full items-center justify-center p-12 text-center text-sm text-muted-foreground">No follow-ups on the books. When a doctor books one, it shows up here.</Card>;

  return (
    <div className="space-y-6">
      <LensSection title="Needs handoff" hint="The booked doctor is no longer active — reassign to a covering doctor." tone="warning" items={groups.needsHandoff} actions={actions} />
      <LensSection title="Overdue" hint="The follow-up date has passed and the patient hasn't checked in." tone="danger" items={groups.overdue} actions={actions} />
      <LensSection title="Due today" tone="brand" items={groups.dueToday} actions={actions} />
      <LensSection title="Upcoming" tone="muted" items={groups.upcoming} actions={actions} />
    </div>
  );
}

function LensSection({ title, hint, tone, items, actions }: { title: string; hint?: string; tone: "warning" | "danger" | "brand" | "muted"; items: Appointment[]; actions: Actions }) {
  if (items.length === 0) return null;
  const dot = { warning: "bg-amber-500", danger: "bg-destructive", brand: "bg-primary", muted: "bg-muted-foreground" }[tone];
  return (
    <section>
      <div className="mb-2 flex items-baseline gap-2">
        <span className={`h-2 w-2 rounded-full ${dot}`} />
        <h2 className="text-h3">{title}</h2>
        <span className="text-sm text-muted-foreground">{items.length}</span>
        {hint && <span className="hidden text-xs text-muted-foreground sm:inline">· {hint}</span>}
      </div>
      <Card className="divide-y">
        {items.map((a) => (
          <div key={a.id} className="flex flex-wrap items-center gap-3 p-3">
            <div className="w-24 shrink-0">
              <div className="text-sm font-semibold text-brand">{fmtDay(a.starts_at)}</div>
              <div className="text-xs tabular-nums text-muted-foreground">{fmtTime(a.starts_at)}</div>
            </div>
            <div className="min-w-0 flex-1">
              <button className="touch-hit block truncate font-medium text-brand hover:underline" onClick={() => actions.onOpenPatient(a.patient_id)}>{a.patient_name}</button>
              <div className="truncate text-xs text-muted-foreground">{handedOff(a) && a.ordered_by_name ? `Ordered by ${a.ordered_by_name} · ` : ""}{a.provider_name}{a.reason ? ` · ${a.reason}` : ""}</div>
            </div>
            <div className="flex items-center gap-1.5"><CoverageBadge a={a} />{!a.provider_active && <Badge variant="warning">handoff</Badge>}</div>
            <div className="flex gap-1.5">
              <Button size="sm" variant="outline" className="max-md:min-h-9" onClick={() => actions.onReassign(a)}><ArrowLeftRight className="h-3.5 w-3.5" /> Reassign</Button>
              <Button size="sm" variant="ghost" className="max-md:min-h-9" onClick={() => actions.onReschedule(a)}><CalendarClock className="h-3.5 w-3.5" /> Rebook</Button>
            </div>
          </div>
        ))}
      </Card>
    </section>
  );
}

const etb = (v: string) => `${Number(v).toLocaleString(undefined, { maximumFractionDigits: 2 })} ETB`;
function sessPayBadge(s: DentalSessionCal) {
  if (sessOwes(s)) return <Badge variant="destructive">owes</Badge>;
  if (s.payment === "paid") return <Badge variant="success">paid</Badge>;
  if (s.payment === "billed") return <Badge variant="warning">at cashier</Badge>;
  return <Badge variant="outline">unpaid</Badge>;
}

/** Day-view treatment-session card (mirrors ApptCard). */
function SessionDayCard({ s, onOpen }: { s: DentalSessionCal; onOpen: (pid: string, sessionId?: string) => void }) {
  return (
    <div className={`rounded-lg border border-l-4 bg-background p-3 shadow-sm ${sessAccent(s).split(" ")[0]}`}>
      <button className="touch-hit block truncate font-medium text-brand hover:underline" onClick={() => onOpen(s.patient_id, s.session_id)}>{s.patient_name}</button>
      <div className="truncate text-xs text-muted-foreground">{s.title} · session {s.seq}/{s.session_count}{s.procedure ? ` · ${s.procedure}` : ""}{s.tooth ? ` (${s.tooth})` : ""}</div>
      <div className="mt-2 flex flex-wrap items-center gap-1.5">
        <Badge variant="outline" className="capitalize">{s.status}</Badge>
        {sessPayBadge(s)}
        <span className="whitespace-nowrap text-xs tabular-nums text-muted-foreground">{etb(s.amount_due)}</span>
      </div>
    </div>
  );
}

/** Follow-ups view: treatment sessions bucketed overdue / due today / upcoming. */
function DentalSessionsLens({ q, actions }: { q: { data?: DentalSessionCal[]; isLoading: boolean }; actions: Actions }) {
  const groups = useMemo(() => {
    const today = dayKey(new Date());
    const overdue: DentalSessionCal[] = [], dueToday: DentalSessionCal[] = [], upcoming: DentalSessionCal[] = [];
    for (const s of q.data ?? []) {
      if (s.scheduled_date < today) { if (!(s.status === "done" && s.payment === "paid")) overdue.push(s); }
      else if (s.scheduled_date === today) dueToday.push(s);
      else upcoming.push(s);
    }
    return { overdue, dueToday, upcoming };
  }, [q.data]);
  if (q.isLoading) return <div className="space-y-3">{Array.from({ length: 3 }).map((_, i) => <Skeleton key={i} className="h-16 w-full" />)}</div>;
  const total = groups.overdue.length + groups.dueToday.length + groups.upcoming.length;
  if (total === 0) return null;
  return (
    <div className="space-y-6">
      <div className="flex items-baseline gap-2"><Stethoscope className="h-4 w-4 shrink-0 text-violet-600" /><h2 className="text-h3">Treatment sessions</h2><span className="text-sm text-muted-foreground">{total}</span></div>
      <SessionLensSection title="Overdue" tone="danger" items={groups.overdue} onOpen={actions.onOpenPatient} />
      <SessionLensSection title="Due today" tone="brand" items={groups.dueToday} onOpen={actions.onOpenPatient} />
      <SessionLensSection title="Upcoming" tone="muted" items={groups.upcoming} onOpen={actions.onOpenPatient} />
    </div>
  );
}
function SessionLensSection({ title, tone, items, onOpen }: { title: string; tone: "danger" | "brand" | "muted"; items: DentalSessionCal[]; onOpen: (pid: string, sessionId?: string) => void }) {
  if (items.length === 0) return null;
  const dot = { danger: "bg-destructive", brand: "bg-primary", muted: "bg-muted-foreground" }[tone];
  return (
    <section>
      <div className="mb-2 flex items-baseline gap-2"><span className={`h-2 w-2 rounded-full ${dot}`} /><h3 className="font-semibold">{title}</h3><span className="text-sm text-muted-foreground">{items.length}</span></div>
      <Card className="divide-y">
        {items.map((s) => (
          <div key={s.session_id} className="flex flex-wrap items-center gap-3 p-3">
            <div className="w-24 shrink-0">
              <div className="text-sm font-semibold tabular-nums text-brand">{s.scheduled_date}</div>
              <div className="text-xs tabular-nums text-muted-foreground">S{s.seq}/{s.session_count}</div>
            </div>
            <div className="min-w-0 flex-1">
              <button className="touch-hit block truncate font-medium text-brand hover:underline" onClick={() => onOpen(s.patient_id, s.session_id)}>{s.patient_name}</button>
              <div className="truncate text-xs text-muted-foreground">{s.title}{s.procedure ? ` · ${s.procedure}` : ""}{s.tooth ? ` (${s.tooth})` : ""}</div>
            </div>
            <div className="flex items-center gap-1.5"><Badge variant="outline" className="capitalize">{s.status}</Badge>{sessPayBadge(s)}<span className="whitespace-nowrap text-xs tabular-nums text-muted-foreground">{etb(s.amount_due)}</span></div>
          </div>
        ))}
      </Card>
    </section>
  );
}

function ReassignDialog({ appt, onOpenChange, providers, onDone }: { appt: Appointment | null; onOpenChange: (o: boolean) => void; providers: { id: string; full_name: string }[]; onDone: () => void }) {
  const [provider, setProvider] = useState("");
  const [note, setNote] = useState("");
  const mut = useMutation({
    mutationFn: () => reassignProvider(appt!.id, provider, note || undefined),
    onSuccess: () => { toast.success("Follow-up handed off"); onOpenChange(false); setProvider(""); setNote(""); onDone(); },
    onError: (e) => toast.error(e instanceof AppError ? e.message : "Could not reassign"),
  });
  return (
    <Dialog open={!!appt} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader><DialogTitle>Reassign to another doctor</DialogTitle></DialogHeader>
        {appt && (
          <div className="space-y-4">
            <p className="text-sm text-muted-foreground">
              {appt.patient_name} · {fmtDay(appt.starts_at)} {fmtTime(appt.starts_at)}. Currently with {appt.provider_name}
              {appt.is_followup && appt.ordered_by_name ? `, ordered by ${appt.ordered_by_name}` : ""}. The order stays credited to whoever booked it.
            </p>
            <div className="space-y-1.5">
              <Label>Hand to</Label>
              <Select value={provider} onValueChange={setProvider}>
                <SelectTrigger><SelectValue placeholder="Choose a doctor…" /></SelectTrigger>
                <SelectContent>
                  {providers.filter((p) => p.id !== appt.provider_id).map((p) => <SelectItem key={p.id} value={p.id}>{p.full_name}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label>Note <span className="text-muted-foreground">(optional)</span></Label>
              <Textarea rows={2} placeholder="e.g. Dr. Alem is on leave this week" value={note} onChange={(e) => setNote(e.target.value)} />
            </div>
          </div>
        )}
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button disabled={!provider} loading={mut.isPending} onClick={() => mut.mutate()}>Reassign</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
