// The patient page, for the person who actually opened it.
//
// It used to be one stack of same-sized cards — Demographics, Allergies,
// Conditions, Visit history, Documents, Billing — in that order, for everybody.
// A cashier scrolled past two clinical cards to reach the money. A nurse scrolled
// past an address to reach the observations. A lab scientist had no reason to open
// it at all, because not one laboratory fact was on it. And nobody, whatever their
// job, could tell from the page whether the patient was in the building.
//
// Two ideas fix that. First, a strip of facts that are true right now, above
// everything, filled per role by the server. Second, a lens: the record is one
// record, but the order it is read in belongs to the reader.
import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import {
  Activity, AlertTriangle, BedDouble, CalendarClock, CircleDollarSign,
  FlaskConical, Stethoscope, Timer,
} from "lucide-react";

import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import { getVitalFields } from "@/features/clinical/api";
import { VitalsGrid } from "@/features/clinical/components/VitalsStrip";
import { patientLabs, type PatientOverview } from "@/features/patients/api";

const etb = (s?: string) =>
  s === undefined ? "—" : `ETB ${Number(s).toLocaleString(undefined, { minimumFractionDigits: 2 })}`;
const day = (iso?: string) =>
  iso ? new Date(iso).toLocaleDateString(undefined, { day: "numeric", month: "short" }) : "";
const dayTime = (iso?: string) =>
  iso ? new Date(iso).toLocaleString(undefined, { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }) : "";
const sinceMin = (iso: string) => Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 60000));
const waited = (iso: string) => {
  const m = sinceMin(iso);
  return m < 60 ? `${m} min` : `${Math.floor(m / 60)}h ${m % 60}m`;
};

/** The lenses a person qualifies for, in the order they should be offered. */
export type Lens = "care" | "desk" | "lab";
export function lensesFor(can: (p: string) => boolean): Lens[] {
  const out: Lens[] = [];
  if (can("encounter.manage") || can("triage.manage")) out.push("care");
  if (can("payment.collect") || can("payment.charge") || can("billing.manage") || can("appointment.manage") || can("queue.manage")) out.push("desk");
  if (can("lab.process") || can("lab.validate") || can("lab.manage")) out.push("lab");
  return out;
}
export const LENS_LABEL: Record<Lens, string> = { care: "Care", desk: "Front desk", lab: "Laboratory" };

/* ---------------------------------------------------------------- right now */

/**
 * One line of facts, each of which changes what the reader does next.
 *
 * Deliberately not a dashboard: a tile appears only when it has something to say,
 * so an ordinary patient on an ordinary day shows one or two and the strip stays
 * readable. The alternative — six tiles with five of them saying "none" — is how a
 * summary becomes wallpaper.
 */
export function RightNow({ o, loading }: { o?: PatientOverview; loading: boolean }) {
  if (loading) return <Skeleton className="h-20 w-full" />;
  if (!o) return null;

  const tiles: React.ReactNode[] = [];

  if (o.here_now) {
    const p = o.here_now;
    tiles.push(
      p.kind === "bed" ? (
        <Tile key="here" tone="brand" icon={BedDouble} label="Admitted"
          value={p.where || "In a bed"}
          note={`${p.nights || 0} night${p.nights === 1 ? "" : "s"} · since ${day(p.since)}`} />
      ) : (
        <Tile key="here" tone="amber" icon={Timer} label="In the clinic now"
          value={p.state === "in_consult" ? "With the doctor" : p.state === "called" ? "Called" : "Waiting"}
          note={[p.where, `${waited(p.since)} so far`, p.provider].filter(Boolean).join(" · ")} />
      ),
    );
  }

  if (o.money && Number(o.money.owed) > 0.005) {
    tiles.push(
      <Tile key="money" tone={o.money.all_agreed ? "slate" : "danger"} icon={CircleDollarSign}
        label={o.money.all_agreed ? "Billed later — agreed" : "Owes"}
        value={etb(o.money.owed)}
        note={o.money.oldest_days > 0 ? `oldest ${o.money.oldest_days} day${o.money.oldest_days === 1 ? "" : "s"}` : "raised today"} />,
    );
  }

  if (o.labs && (o.labs.critical > 0 || o.labs.on_the_bench > 0 || o.labs.to_validate > 0)) {
    const critical = o.labs.critical > 0;
    tiles.push(
      <Tile key="labs" tone={critical ? "danger" : "cyan"} icon={critical ? AlertTriangle : FlaskConical}
        label={critical ? "Critical result" : "Laboratory"}
        value={critical ? `${o.labs.critical} flagged` : `${o.labs.on_the_bench + o.labs.to_validate} outstanding`}
        note={[
          o.labs.on_the_bench ? `${o.labs.on_the_bench} on the bench` : "",
          o.labs.to_validate ? `${o.labs.to_validate} to validate` : "",
        ].filter(Boolean).join(" · ")} />,
    );
  }

  if (o.next_appointment) {
    const a = o.next_appointment;
    tiles.push(
      <Tile key="next" tone="teal" icon={CalendarClock} label={a.is_followup ? "Next — follow-up" : "Next booked"}
        value={dayTime(a.starts_at)}
        note={[a.department, a.provider].filter(Boolean).join(" · ")} />,
    );
  }

  if (o.last_visit) {
    const v = o.last_visit;
    tiles.push(
      <Tile key="last" tone="slate" icon={Stethoscope} label={v.open ? "Visit open now" : "Last seen"}
        value={day(v.at)} note={[v.diagnosis, v.provider].filter(Boolean).join(" · ")} />,
    );
  }

  if (tiles.length === 0) return null;
  return <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">{tiles}</div>;
}

const TONES = {
  brand: "border-l-brand bg-brand/5",
  amber: "border-l-amber-500 bg-amber-50",
  danger: "border-l-destructive bg-destructive/5",
  teal: "border-l-teal-500 bg-teal-50",
  cyan: "border-l-cyan-500 bg-cyan-50",
  slate: "border-l-slate-300 bg-muted/40",
} as const;

function Tile({ tone, icon: Icon, label, value, note }: {
  tone: keyof typeof TONES; icon: typeof Timer; label: string; value: string; note?: string;
}) {
  return (
    <div className={cn("rounded-lg border border-l-4 p-3", TONES[tone])}>
      <div className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
        <Icon className="h-3.5 w-3.5" /> {label}
      </div>
      <p className="mt-0.5 truncate text-base font-semibold">{value}</p>
      {note ? <p className="truncate text-xs text-muted-foreground">{note}</p> : null}
    </div>
  );
}

/* ------------------------------------------------------------------- vitals */

/**
 * The last set of observations, read against this clinic's own thresholds.
 *
 * Triage's whole job is these numbers and they were nowhere on the page: a nurse
 * had to open the consultation to see what they themselves had recorded an hour
 * earlier.
 */
export function LastVitalsCard({ o }: { o?: PatientOverview }) {
  const fields = useQuery({ queryKey: ["vital-fields"], queryFn: getVitalFields, staleTime: 300000 });
  const v = o?.vitals;
  if (!v) {
    return (
      <Card className="p-4">
        <h2 className="text-h3">Observations</h2>
        <p className="mt-2 text-sm text-muted-foreground">Nothing recorded yet.</p>
      </Card>
    );
  }
  const stale = (Date.now() - new Date(v.recorded_at).getTime()) / 3600000 > 24;
  return (
    <Card className="p-4">
      <div className="mb-3 flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="flex items-center gap-2 text-h3">
          <span className="grid h-7 w-7 place-items-center rounded-lg bg-teal-100 text-teal-700"><Activity className="h-4 w-4" /></span>
          Observations
        </h2>
        <span className={cn("text-xs", stale ? "text-muted-foreground" : "font-medium text-teal-700")}>
          {dayTime(v.recorded_at)}{stale ? " · not from today" : ""}
        </span>
      </div>
      <VitalsGrid vitals={v} fields={fields.data ?? []} />
    </Card>
  );
}

/* ---------------------------------------------------------------------- labs */

const LAB_STATE: Record<string, { label: string; cls: string }> = {
  ordered: { label: "ordered", cls: "bg-slate-100 text-slate-700" },
  collected: { label: "sample taken", cls: "bg-indigo-100 text-indigo-700" },
  in_process: { label: "on the bench", cls: "bg-amber-100 text-amber-800" },
  resulted: { label: "awaiting validation", cls: "bg-cyan-100 text-cyan-800" },
  validated: { label: "validated", cls: "bg-emerald-100 text-emerald-700" },
  cancelled: { label: "cancelled", cls: "bg-slate-100 text-slate-500" },
};

/**
 * Everything this patient has ever had done.
 *
 * The lab could only be asked what a given encounter ordered, so the scientist at
 * the bench could not tell a repeat from a first test, and the doctor could not see
 * last month's result without opening last month's consultation.
 */
export function LabHistoryPanel({ patientId }: { patientId: string }) {
  const q = useQuery({ queryKey: ["patient-labs", patientId], queryFn: () => patientLabs(patientId) });
  const orders = useMemo(() => q.data ?? [], [q.data]);
  const outstanding = useMemo(
    () => orders.flatMap((o) => o.items).filter((i) => i.status !== "validated" && i.status !== "cancelled").length,
    [orders],
  );

  return (
    <Card className="p-4">
      <div className="mb-3 flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="flex items-center gap-2 text-h3">
          <span className="grid h-7 w-7 place-items-center rounded-lg bg-cyan-100 text-cyan-700"><FlaskConical className="h-4 w-4" /></span>
          Laboratory
        </h2>
        {outstanding > 0 && <Badge variant="warning">{outstanding} outstanding</Badge>}
      </div>

      {q.isLoading ? (
        <Skeleton className="h-24" />
      ) : orders.length === 0 ? (
        <p className="text-sm text-muted-foreground">No tests have ever been ordered for this patient.</p>
      ) : (
        <div className="space-y-4">
          {orders.slice(0, 12).map((o) => (
            <div key={o.order_no} className="rounded-md border p-3">
              <div className="mb-2 flex flex-wrap items-baseline justify-between gap-2">
                <span className="text-sm font-medium">Order #{o.order_no}</span>
                <span className="text-xs text-muted-foreground">
                  {dayTime(o.created_at)}{o.priority && o.priority !== "routine" ? ` · ${o.priority}` : ""}
                </span>
              </div>
              <div className="space-y-2">
                {o.items.map((it) => {
                  const st = LAB_STATE[it.status] ?? { label: it.status, cls: "bg-slate-100 text-slate-700" };
                  return (
                    <div key={it.sample_no}>
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="text-sm font-medium">{it.test_name}</span>
                        <span className={cn("rounded-full px-2 py-0.5 text-[11px] font-medium", st.cls)}>{st.label}</span>
                        <span className="text-xs text-muted-foreground tabular-nums">#{it.sample_no}</span>
                      </div>
                      {it.results.length > 0 && (
                        <div className="mt-1 overflow-x-auto">
                          <table className="w-full min-w-[22rem] text-sm">
                            <tbody>
                              {it.results.map((r) => (
                                <tr key={r.name} className="border-b last:border-0">
                                  <td className="py-1 pr-3 text-muted-foreground">{r.name}</td>
                                  <td className={cn("py-1 pr-3 text-right font-medium tabular-nums",
                                    r.flag === "critical" ? "text-destructive"
                                      : r.flag === "high" || r.flag === "low" ? "text-amber-700" : "")}>
                                    {r.value || "—"}{r.unit ? ` ${r.unit}` : ""}
                                  </td>
                                  <td className="w-24 py-1 text-right text-xs text-muted-foreground">
                                    {r.flag && r.flag !== "normal"
                                      ? <span className="font-semibold uppercase">{r.flag}</span>
                                      : r.ref_low || r.ref_high ? `${r.ref_low ?? ""}–${r.ref_high ?? ""}` : ""}
                                  </td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          ))}
          {orders.length > 12 && (
            <p className="text-xs text-muted-foreground">
              Showing the 12 most recent orders. <Link to="/lab" className="underline">Lab worklist</Link>
            </p>
          )}
        </div>
      )}
    </Card>
  );
}
