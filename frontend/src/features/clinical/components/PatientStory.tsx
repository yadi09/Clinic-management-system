// Who is this patient? — as opposed to when did they come.
//
// The record used to answer the second question: a column of dates, each with the
// diagnosis made that day, and a dialog that dumped the visit back out in fixed
// sections under 10px uppercase labels. It is the shape of a filing cabinet, and it
// makes the doctor rebuild the patient from scratch every time — read six rows, notice
// that three say diabetes, remember what was prescribed in April, hold four blood
// pressures in your head to see which way they are going.
//
// A doctor opens a record to ask three things, and none of them is a date:
//
//   what do they carry        — the problems that keep coming back
//   what are they on          — the medicines still running
//   which way are they going  — the numbers, over time
//
// So that is what this shows, in that order, with the visit archive underneath for
// when the answer is not in the summary. The problem list is derived from the
// diagnoses rather than stored: nobody maintains one by hand, and a hand-maintained
// list drifts from the record it is supposed to summarise within a month.
import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { AlertTriangle, ChevronDown, ChevronRight, FlaskConical, Pill, Stethoscope } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import { useAuth } from "@/app/auth-context";
import { encounterLabs } from "@/features/lab/api";
import { FLAG_CLS, VitalsGrid, hhmm } from "@/features/clinical/components/VitalsStrip";
import {
  getVitalFields, getWorkspace, listHistory, patientStory,
  type HistoryItem, type Medicine, type Problem, type TrendPoint,
} from "@/features/clinical/api";

const day = (iso: string) =>
  new Date(iso).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });
const shortDay = (iso: string) =>
  new Date(iso).toLocaleDateString(undefined, { day: "numeric", month: "short" });

/** "3 weeks ago", "yesterday" — how long ago matters more than the date itself when
 *  you are deciding whether a medicine is still being taken. */
function ago(iso: string): string {
  const d = Math.floor((Date.now() - new Date(iso).getTime()) / 86400000);
  if (d <= 0) return "today";
  if (d === 1) return "yesterday";
  if (d < 30) return `${d} days ago`;
  const m = Math.round(d / 30);
  if (m < 18) return `${m} month${m === 1 ? "" : "s"} ago`;
  return `${Math.round(d / 365)} years ago`;
}

export function PatientStoryPanel({ patientId }: { patientId: string }) {
  const story = useQuery({ queryKey: ["story", patientId], queryFn: () => patientStory(patientId) });
  const history = useQuery({ queryKey: ["history", patientId], queryFn: () => listHistory(patientId) });
  const [openVisit, setOpenVisit] = useState<HistoryItem | null>(null);
  const [showVisits, setShowVisits] = useState(false);

  const s = story.data;
  const visits = history.data ?? [];
  const recurring = (s?.problems ?? []).filter((p) => p.recurring);
  const once = (s?.problems ?? []).filter((p) => !p.recurring);

  if (story.isLoading) {
    return <Card className="p-4"><Skeleton className="h-40 w-full" /></Card>;
  }
  const empty = !s || (s.problems.length === 0 && s.medicines.length === 0 && visits.length === 0);
  if (empty) {
    return (
      <Card className="p-4">
        <h3 className="text-h3">This patient's story</h3>
        <p className="mt-2 text-sm text-muted-foreground">
          Nothing recorded yet — this is their first visit with you.
        </p>
      </Card>
    );
  }

  return (
    <>
      <Card className="space-y-4 p-4">
        {/* WHAT THEY CARRY */}
        {(recurring.length > 0 || once.length > 0) && (
          <section>
            <SubHead icon={Stethoscope} label="Carries" />
            <ul className="mt-2 space-y-1.5">
              {recurring.map((p) => <ProblemRow key={p.description} p={p} />)}
              {once.length > 0 && recurring.length > 0 && (
                <li className="pt-1 text-[11px] uppercase tracking-wide text-muted-foreground">Seen once</li>
              )}
              {once.slice(0, 4).map((p) => <ProblemRow key={p.description} p={p} />)}
            </ul>
          </section>
        )}

        {/* WHAT THEY ARE ON */}
        {(s?.medicines.length ?? 0) > 0 && (
          <section className="border-t pt-3">
            <SubHead icon={Pill} label="On these medicines" />
            <ul className="mt-2 space-y-2">
              {s!.medicines.slice(0, 6).map((m) => <MedicineRow key={m.drug_name} m={m} />)}
            </ul>
          </section>
        )}

        {/* WHICH WAY THEY ARE GOING */}
        {(s?.trend.length ?? 0) > 1 && (
          <section className="border-t pt-3">
            <SubHead icon={undefined} label="Over time" />
            <div className="mt-2 space-y-3">
              <Spark points={s!.trend} pick={(t) => t.systolic} label="Systolic BP" unit="" band={[90, 140]} />
              <Spark points={s!.trend} pick={(t) => t.weight_kg} label="Weight" unit="kg" />
            </div>
          </section>
        )}

        {/* THE ARCHIVE — there when the summary does not answer it */}
        {visits.length > 0 && (
          <section className="border-t pt-3">
            <button type="button" onClick={() => setShowVisits((v) => !v)}
              className="touch-hit flex w-full items-center gap-1.5 text-left text-[11px] font-semibold uppercase tracking-wide text-muted-foreground hover:text-foreground">
              {showVisits ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
              {visits.length} past visit{visits.length === 1 ? "" : "s"}
            </button>
            {showVisits && (
              <ol className="mt-2 space-y-1">
                {visits.map((h) => (
                  <li key={h.id}>
                    <button onClick={() => setOpenVisit(h)}
                      className="w-full rounded-md px-2 py-1.5 text-left transition-colors hover:bg-muted">
                      <p className="flex items-baseline justify-between gap-2">
                        <span className="text-xs font-semibold text-brand">{day(h.started_at)}</span>
                        <span className="shrink-0 text-[10px] text-muted-foreground">{ago(h.started_at)}</span>
                      </p>
                      <p className="truncate text-xs text-muted-foreground">
                        {h.primary_dx || h.type}{h.provider_name ? ` · ${h.provider_name}` : ""}
                      </p>
                    </button>
                  </li>
                ))}
              </ol>
            )}
          </section>
        )}
      </Card>

      {openVisit && <VisitDetailDialog item={openVisit} onClose={() => setOpenVisit(null)} />}
    </>
  );
}

function SubHead({ icon: Icon, label }: { icon?: typeof Pill; label: string }) {
  return (
    <p className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
      {Icon && <Icon className="h-3.5 w-3.5" />} {label}
    </p>
  );
}

/** A problem carries its weight: how many times, and how recently. A condition seen
 *  four times reads differently from one seen once, and the dot says which. */
function ProblemRow({ p }: { p: Problem }) {
  return (
    <li className="flex items-baseline gap-2">
      <span className={cn("mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full",
        p.recurring ? "bg-brand" : "bg-muted-foreground/40")} />
      <span className="min-w-0 flex-1">
        <span className={cn("text-sm", p.recurring ? "font-medium" : "")}>{p.description}</span>
        {p.recurring && <span className="ml-1.5 text-xs font-semibold text-brand">×{p.times}</span>}
        <span className="block text-[11px] text-muted-foreground">last {ago(p.last_seen)}</span>
      </span>
    </li>
  );
}

function MedicineRow({ m }: { m: Medicine }) {
  const detail = [m.dose, m.frequency, m.duration].filter(Boolean).join(" · ");
  return (
    <li className="text-sm">
      <p className="font-medium leading-tight">{m.drug_name}</p>
      {detail && <p className="text-xs text-muted-foreground">{detail}</p>}
      <p className="text-[11px] text-muted-foreground">prescribed {ago(m.last_prescribed)}</p>
    </li>
  );
}

/**
 * A number's direction, in the space of one line.
 *
 * Four blood pressures across four visits is a trend the doctor currently has to
 * assemble by opening four records. Drawn instead: the shape, the last value, and —
 * where there is one — the band it is supposed to stay inside, so "drifting up out of
 * range" is a picture rather than an arithmetic exercise.
 */
function Spark({ points, pick, label, unit, band }: {
  points: TrendPoint[];
  pick: (t: TrendPoint) => number | undefined;
  label: string;
  unit: string;
  band?: [number, number];
}) {
  const data = useMemo(
    () => points.map((t) => ({ at: t.at, v: pick(t) })).filter((d): d is { at: string; v: number } => d.v != null),
    [points, pick],
  );
  if (data.length < 2) return null;

  const W = 240, H = 40, PAD = 2;
  const vs = data.map((d) => d.v);
  const lo = Math.min(...vs, band ? band[0] : Infinity);
  const hi = Math.max(...vs, band ? band[1] : -Infinity);
  const span = hi - lo || 1;
  const x = (i: number) => PAD + (i * (W - PAD * 2)) / (data.length - 1);
  const y = (v: number) => H - PAD - ((v - lo) / span) * (H - PAD * 2);
  const path = data.map((d, i) => `${i ? "L" : "M"}${x(i).toFixed(1)},${y(d.v).toFixed(1)}`).join(" ");
  const last = data[data.length - 1];
  const first = data[0];
  const delta = last.v - first.v;
  const outOfBand = band && (last.v < band[0] || last.v > band[1]);

  return (
    <div>
      <div className="flex items-baseline justify-between gap-2">
        <span className="text-xs text-muted-foreground">{label}</span>
        <span className={cn("text-sm font-semibold tabular-nums", outOfBand ? "text-destructive" : "text-brand")}>
          {last.v}{unit && ` ${unit}`}
          {Math.abs(delta) > 0.05 && (
            <span className="ml-1 text-[11px] font-normal text-muted-foreground">
              {delta > 0 ? "↑" : "↓"}{Math.abs(Math.round(delta * 10) / 10)} since {shortDay(first.at)}
            </span>
          )}
        </span>
      </div>
      <svg viewBox={`0 0 ${W} ${H}`} className="mt-1 h-10 w-full" preserveAspectRatio="none" aria-hidden>
        {band && (
          <rect x={0} y={y(band[1])} width={W} height={Math.max(1, y(band[0]) - y(band[1]))}
            className="fill-emerald-500/10" />
        )}
        <path d={path} fill="none" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round"
          className={cn(outOfBand ? "stroke-destructive" : "stroke-brand")} />
        <circle cx={x(data.length - 1)} cy={y(last.v)} r={3}
          className={cn(outOfBand ? "fill-destructive" : "fill-brand")} />
      </svg>
    </div>
  );
}

const STATUS_LABEL: Record<string, string> = {
  closed: "Signed", open: "In progress", awaiting_results: "Awaiting results",
};

/**
 * One past visit, told rather than filed.
 *
 * It used to be the visit's tables in a fixed order — allergies, vitals, note,
 * diagnoses, prescription, labs — each under a small grey label, whether or not there
 * was anything in it. What a doctor wants from a past visit is the story of it: what
 * was concluded (the headline, because that is what you came to find out), then what
 * the patient said, what was found, and what was done about it. Empty parts are simply
 * absent instead of announcing that they are empty.
 */
export function VisitDetailDialog({ item, onClose }: { item: HistoryItem; onClose: () => void }) {
  const { flagOn } = useAuth();
  const ws = useQuery({ queryKey: ["history-ws", item.id], queryFn: () => getWorkspace(item.id) });
  const vfields = useQuery({ queryKey: ["vital-fields"], queryFn: getVitalFields });
  const labs = useQuery({
    queryKey: ["history-labs", item.id],
    queryFn: () => encounterLabs(item.id),
    enabled: flagOn("laboratory"),
  });

  const d = ws.data;
  const note = d?.note;
  const critical = (labs.data ?? []).flatMap((o) =>
    (o.items ?? []).flatMap((i) => (i.results ?? []).filter((r) => r.flag === "critical")));

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent fullOnMobile className="flex max-h-[88vh] max-w-2xl flex-col gap-0 p-0">
        <DialogHeader className="shrink-0 border-b px-5 py-4">
          <DialogTitle className="text-base">
            {new Date(item.started_at).toLocaleDateString(undefined, { weekday: "long", day: "numeric", month: "long", year: "numeric" })}
          </DialogTitle>
          <p className="mt-0.5 flex flex-wrap items-center gap-x-2 text-xs text-muted-foreground">
            <span>{hhmm(item.started_at)}</span>
            {item.provider_name && <span>· {item.provider_name}</span>}
            <span>· {ago(item.started_at)}</span>
            {d && <Badge variant={d.status === "closed" ? "success" : "outline"} className="text-[10px]">
              {STATUS_LABEL[d.status] ?? d.status}
            </Badge>}
          </p>
        </DialogHeader>

        <div className="min-h-0 flex-1 space-y-5 overflow-y-auto px-5 py-4">
          {ws.isLoading && <Skeleton className="h-48 w-full" />}
          {ws.isError && <p className="py-6 text-center text-sm text-destructive">Could not load this visit.</p>}

          {d && (
            <>
              {/* THE HEADLINE — what this visit concluded, which is what you opened it for. */}
              {d.diagnoses.length > 0 ? (
                <div>
                  <p className="text-xl font-semibold leading-tight text-brand">
                    {d.diagnoses.find((x) => x.is_primary)?.description ?? d.diagnoses[0].description}
                  </p>
                  {d.diagnoses.length > 1 && (
                    <div className="mt-1.5 flex flex-wrap gap-1.5">
                      {d.diagnoses.filter((x) => !x.is_primary).map((dx) => (
                        <Badge key={dx.id} variant="outline" className="text-[11px]">{dx.description}</Badge>
                      ))}
                    </div>
                  )}
                </div>
              ) : (
                <p className="text-sm italic text-muted-foreground">No diagnosis was recorded at this visit.</p>
              )}

              {critical.length > 0 && (
                <p className="flex items-center gap-2 rounded-md border border-rose-300 bg-rose-50 px-3 py-2 text-sm font-semibold text-rose-800">
                  <AlertTriangle className="h-4 w-4 shrink-0" />
                  {critical.length} critical lab result{critical.length === 1 ? "" : "s"} at this visit
                </p>
              )}

              {d.allergies.length > 0 && (
                <div className="flex flex-wrap gap-1.5">
                  {d.allergies.map((a, i) => (
                    <span key={`${a.substance}-${i}`}
                      className="flex items-center gap-1 rounded-full bg-rose-600 px-2.5 py-1 text-xs font-semibold text-white">
                      <AlertTriangle className="h-3.5 w-3.5" /> {a.substance}{a.severity ? ` · ${a.severity}` : ""}
                    </span>
                  ))}
                </div>
              )}

              <Told label="They said" text={note?.subjective} />

              {(d.vitals.length > 0 || note?.objective?.trim()) && (
                <div>
                  <TellLabel>What was found</TellLabel>
                  {d.vitals.map((v, i) => (
                    <div key={v.recorded_at ?? i} className="mb-2">
                      <VitalsGrid vitals={v} fields={vfields.data ?? []} />
                    </div>
                  ))}
                  {note?.objective?.trim() && <p className="whitespace-pre-wrap text-sm">{note.objective}</p>}
                </div>
              )}

              <Told label="The thinking" text={note?.assessment} />
              <Told label="The plan" text={note?.plan} />

              {d.prescription.length > 0 && (
                <div>
                  <TellLabel>What was given</TellLabel>
                  <ul className="space-y-1.5">
                    {d.prescription.map((m) => (
                      <li key={m.id} className="text-sm">
                        <span className="font-medium">{m.drug_name}</span>
                        {[m.dose, m.frequency, m.duration].filter(Boolean).length > 0 && (
                          <span className="text-muted-foreground"> · {[m.dose, m.frequency, m.duration].filter(Boolean).join(" · ")}</span>
                        )}
                        {m.instructions && <p className="text-xs text-muted-foreground">{m.instructions}</p>}
                        {m.allergy_override && (
                          <p className="mt-0.5 flex items-center gap-1 text-xs font-medium text-amber-700">
                            <AlertTriangle className="h-3 w-3" /> Prescribed despite an allergy — {m.allergy_override}
                          </p>
                        )}
                      </li>
                    ))}
                  </ul>
                </div>
              )}

              {(labs.data ?? []).length > 0 && (
                <div>
                  <TellLabel>What was ordered</TellLabel>
                  <div className="space-y-2">
                    {(labs.data ?? []).map((o) => (
                      <div key={o.order_no} className="overflow-hidden rounded-md border">
                        <div className="flex items-center justify-between gap-2 border-b bg-muted/40 px-3 py-1.5">
                          <span className="flex items-center gap-1.5 text-xs font-medium">
                            <FlaskConical className="h-3.5 w-3.5" /> Order {o.order_no}
                          </span>
                          {o.priority && o.priority !== "routine" && (
                            <Badge variant="warning" className="text-[10px] capitalize">{o.priority}</Badge>
                          )}
                        </div>
                        {(o.items ?? []).map((i) => (
                          <div key={i.sample_no} className="px-3 py-2">
                            <p className="flex items-center justify-between gap-2 text-sm font-medium">
                              {i.test_name}
                              <Badge variant={i.status === "validated" ? "success" : "outline"} className="text-[10px]">{i.status}</Badge>
                            </p>
                            {(i.results ?? []).map((r) => (
                              <p key={r.analyte_id} className="mt-0.5 flex items-center justify-between gap-2 text-xs">
                                <span className="text-muted-foreground">{r.name}</span>
                                <span className="flex items-center gap-1.5">
                                  <span className="tabular-nums">{r.value}{r.unit ? ` ${r.unit}` : ""}</span>
                                  {r.flag && r.flag !== "normal" && (
                                    <Badge variant="outline" className={cn("text-[10px]", FLAG_CLS[r.flag] ?? "")}>{r.flag}</Badge>
                                  )}
                                </span>
                              </p>
                            ))}
                          </div>
                        ))}
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {note?.signed_at && (
                <p className="border-t pt-3 text-xs text-muted-foreground">
                  Signed {new Date(note.signed_at).toLocaleString(undefined, { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" })}
                </p>
              )}
            </>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}

function TellLabel({ children }: { children: React.ReactNode }) {
  return <p className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">{children}</p>;
}

/** A part of the note, shown only when there is something in it. An empty section
 *  announcing its own emptiness is noise in a record you are scanning. */
function Told({ label, text }: { label: string; text?: string }) {
  if (!text?.trim()) return null;
  return (
    <div>
      <TellLabel>{label}</TellLabel>
      <p className="whitespace-pre-wrap text-sm">{text}</p>
    </div>
  );
}
