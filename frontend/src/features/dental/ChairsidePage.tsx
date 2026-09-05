// The chair.
//
// This was the generic queue with a dental label on it: a name, a card number, a
// wait time, and two buttons. Everything that decides what happens next — is this
// patient allergic to anything, has the work been billed, was anything written down
// at all — lived on other screens, and "Check out" was a single unguarded click
// that ended the visit and removed the patient from view. A dentist who pressed it
// by accident, or before recording, had no way back and nothing telling them what
// had just been lost.
//
// Three ideas fix that.
//
// The card carries the facts. Allergies in red because that is a safety fact, not an
// administrative one; what they owe and what has been delivered but never billed;
// where they are in their course. The dentist decides from the card.
//
// Nothing dangerous happens on one click. Check-out asks, and names what it is
// about to end — an unrecorded visit, unbilled treatment, money owed. When there is
// nothing to warn about it says so plainly and gets out of the way.
//
// A finished visit moves aside rather than vanishing. Seen today is on the same
// page, collapsed, with the check-out time and an Undo — because the correct
// response to a mis-click is to put it back, not to re-register the patient.
import { useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  AlertTriangle, ArmchairIcon, CheckCircle2, ChevronDown, Clock, FileWarning,
  HandHelping, Receipt, RotateCcw, Stethoscope,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Segmented } from "@/components/ui/segmented";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { toast } from "@/components/ui/sonner";
import { cn } from "@/lib/utils";
import { AppError } from "@/lib/api-client";
import { useAuth } from "@/app/auth-context";
import { listUsers } from "@/features/admin/api";
import { assignProvider, transitionQueue } from "@/features/scheduling/api";
import { chairside, type ChairPatient } from "@/features/dental/api";
import { windowFor, type DateWindow } from "@/components/ui/date-range-filter";

const num = (s?: string) => Number(s || 0);
const birr = (s?: string) => `${num(s).toLocaleString(undefined, { maximumFractionDigits: 0 })} ETB`;
const mins = (iso: string) => Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 60000));
/** Elapsed time a person can read. "1537h 45m" is arithmetic, not a duration —
 *  a patient left in the chair since July needs "64 days", which is also the number
 *  that tells the dentist something is wrong with the record rather than the clock. */
const wait = (iso: string) => {
  const m = mins(iso);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ${m % 60}m`;
  const d = Math.floor(h / 24);
  return d === 1 ? `1 day` : `${d} days`;
};
const clock = (iso?: string) =>
  iso ? new Date(iso).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" }) : "";

type ChairRange = "today" | "3d" | "7d" | "all";
const DAY = 86_400_000;
function chairWindow(r: ChairRange): DateWindow {
  if (r !== "7d") return windowFor(r);
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  return { from: new Date(today.getTime() - 6 * DAY).toISOString(), to: new Date(today.getTime() + DAY).toISOString() };
}

/**
 * What a check-out would end. Each one is a sentence the dentist has to read.
 *
 * `onCard` drops the empty-record warning for somebody who has not been treated
 * yet: a patient who arrived eighteen minutes ago obviously has nothing written
 * down, and a warning that fires on every card is one nobody reads by Wednesday.
 * At the point of check-out it always applies — that is the moment it matters.
 */
function risks(p: ChairPatient, onCard = false) {
  const out: { icon: typeof AlertTriangle; text: string; hard: boolean }[] = [];
  const expectRecord = !onCard || p.state === "in_consult";
  if (p.recorded_this_visit === 0 && expectRecord) {
    out.push({ icon: FileWarning, hard: true,
      text: "Nothing has been recorded at this visit — no treatment, no examination." });
  }
  if (num(p.unbilled) > 0.005) {
    out.push({ icon: Receipt, hard: true,
      text: `${birr(p.unbilled)} of treatment has been given and never billed.` });
  }
  if (num(p.owed) > 0.005) {
    out.push({ icon: Receipt, hard: false,
      text: `${birr(p.owed)} is still owed and waiting at the cashier.` });
  }
  return out;
}

export function ChairsidePage() {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const { can, user } = useAuth();
  const canPickProvider = can("user.read");

  const [range, setRange] = useState<ChairRange>("today");
  const win = useMemo(() => chairWindow(range), [range]);
  const providers = useQuery({ queryKey: ["users"], queryFn: listUsers, enabled: canPickProvider });
  const [provider, setProvider] = useState(""); // "" = me
  const claimProvider = provider || user?.id;
  const [checkingOut, setCheckingOut] = useState<ChairPatient | null>(null);
  const [showSeen, setShowSeen] = useState(false);

  const list = useQuery({
    queryKey: ["chairside", provider || user?.id, win.from, win.to],
    queryFn: () => chairside(provider || user?.id, win.from, win.to),
    refetchInterval: 20000,
  });
  const invalidate = () => qc.invalidateQueries({ queryKey: ["chairside"] });

  const rows = useMemo(() => list.data ?? [], [list.data]);
  const inChair = rows.filter((r) => r.state === "in_consult");
  const waiting = rows.filter((r) => (r.state === "waiting" || r.state === "called") && r.provider_id);
  const pool = rows.filter((r) => r.state !== "done" && !r.provider_id);
  const seen = rows.filter((r) => r.state === "done");

  // Opening the chart puts the patient in the chair. The failure used to be
  // swallowed, so a dentist could be treating someone the board still showed as
  // waiting — and the next person to look would think nobody had started.
  const openChart = async (p: ChairPatient) => {
    if (p.state !== "in_consult") {
      try {
        await transitionQueue(p.queue_id, "in_consult");
        invalidate();
      } catch (e) {
        toast.error(e instanceof AppError ? e.message : "Could not mark them in the chair — opening anyway");
      }
    }
    navigate(`/patients/${p.patient_id}`);
  };

  const checkOut = useMutation({
    mutationFn: (p: ChairPatient) => transitionQueue(p.queue_id, "done"),
    onSuccess: (_d, p) => {
      setCheckingOut(null);
      invalidate();
      // The way back is offered at the moment of the mistake, not buried in a list.
      toast.success(`${p.patient_name} checked out`, {
        action: {
          label: "Undo",
          onClick: () => transitionQueue(p.queue_id, "waiting").then(invalidate)
            .catch(() => toast.error("Could not undo the check-out")),
        },
      });
    },
    onError: (e) => toast.error(e instanceof AppError ? e.message : "Could not check out"),
  });

  const undo = useMutation({
    mutationFn: (p: ChairPatient) => transitionQueue(p.queue_id, "waiting"),
    onSuccess: (_d, p) => { toast.success(`${p.patient_name} is back at the chair`); invalidate(); },
    onError: (e) => toast.error(e instanceof AppError ? e.message : "Could not put them back"),
  });

  const pickUp = useMutation({
    mutationFn: (p: ChairPatient) => {
      if (!claimProvider) throw new Error("no provider");
      return assignProvider(p.queue_id, claimProvider);
    },
    onSuccess: (_d, p) => { toast.success(`${p.patient_name} picked up`); invalidate(); },
    onError: (e) => toast.error(e instanceof AppError ? e.message : "Could not pick up the patient"),
  });

  const live = inChair.length + waiting.length + pool.length;

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1>Chairside</h1>
          <p className="text-sm text-muted-foreground">
            {list.isLoading ? "Loading…" : live === 0
              ? "Nobody at the chair. Reception sends them here."
              : `${inChair.length} in the chair · ${waiting.length + pool.length} waiting${seen.length ? ` · ${seen.length} seen` : ""}`}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Segmented ariaLabel="Date range" value={range} onChange={setRange}
            options={[
              { value: "today", label: "Today" },
              { value: "3d", label: "3 days" },
              { value: "7d", label: "7 days" },
              { value: "all", label: "All" },
            ]} />
          {canPickProvider && (
            <div className="w-52">
              <Select value={provider || "me"} onValueChange={(v) => setProvider(v === "me" ? "" : v)}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="me">My patients</SelectItem>
                  {(providers.data ?? []).filter((u) => u.status === "active").map((u) => (
                    <SelectItem key={u.id} value={u.id}>{u.full_name}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          )}
        </div>
      </div>

      {inChair.length > 0 && (
        <Group title="In the chair" note="being treated now">
          {inChair.map((p) => (
            <ChairCard key={p.queue_id} p={p} tone="amber"
              onOpen={() => openChart(p)} onCheckOut={() => setCheckingOut(p)} />
          ))}
        </Group>
      )}

      {waiting.length > 0 && (
        <Group title="Waiting for you" note="sent through by reception">
          {waiting.map((p) => (
            <ChairCard key={p.queue_id} p={p} tone="brand"
              onOpen={() => openChart(p)} onCheckOut={() => setCheckingOut(p)} />
          ))}
        </Group>
      )}

      {pool.length > 0 && (
        <Group title="Not yet claimed" note="nobody has taken these — the ones most easily forgotten">
          {pool.map((p) => (
            <ChairCard key={p.queue_id} p={p} tone="slate" dashed
              onPickUp={claimProvider ? () => pickUp.mutate(p) : undefined}
              picking={pickUp.isPending && pickUp.variables?.queue_id === p.queue_id} />
          ))}
        </Group>
      )}

      {live === 0 && !list.isLoading && (
        <Card className="p-12 text-center text-sm text-muted-foreground">
          <ArmchairIcon className="mx-auto mb-2 h-6 w-6 opacity-40" />
          No patients at the chair. Reception sends them here.
        </Card>
      )}

      {/* Finished, kept to one side rather than thrown away. */}
      {seen.length > 0 && (
        <div>
          <button onClick={() => setShowSeen((s) => !s)}
            className="flex w-full items-center gap-2 rounded-md px-1 py-2 text-left text-xs font-semibold uppercase tracking-wide text-muted-foreground hover:text-foreground">
            <ChevronDown className={cn("h-4 w-4 transition-transform", !showSeen && "-rotate-90")} />
            Seen {range === "today" ? "today" : "in this period"} · {seen.length}
            {seen.some((p) => p.recorded_this_visit === 0) && (
              <span className="ml-1 rounded-full bg-amber-100 px-2 py-0.5 text-[11px] font-medium normal-case text-amber-800">
                {seen.filter((p) => p.recorded_this_visit === 0).length} with nothing recorded
              </span>
            )}
          </button>
          {showSeen && (
            <div className="space-y-2">
              {seen.map((p) => (
                <Card key={p.queue_id} className="flex flex-wrap items-center gap-x-4 gap-y-2 border-l-4 border-l-emerald-500/40 p-3">
                  <div className="min-w-[12rem] flex-1">
                    <p className="flex flex-wrap items-center gap-2 font-medium">
                      {p.patient_name}
                      {p.recorded_this_visit === 0 && (
                        <span className="inline-flex items-center gap-1 rounded-full bg-amber-100 px-2 py-0.5 text-[11px] font-medium text-amber-800">
                          <FileWarning className="h-3 w-3" /> nothing recorded
                        </span>
                      )}
                      {num(p.unbilled) > 0.005 && (
                        <span className="rounded-full bg-destructive/10 px-2 py-0.5 text-[11px] font-medium text-destructive">
                          {birr(p.unbilled)} unbilled
                        </span>
                      )}
                    </p>
                    <p className="font-mono text-xs text-muted-foreground">
                      {p.mrn} · seen {clock(p.ended_at ?? p.enqueued_at)}
                      {p.provider_name ? ` · ${p.provider_name}` : ""}
                    </p>
                  </div>
                  <Button size="sm" variant="ghost" onClick={() => navigate(`/patients/${p.patient_id}`)}>
                    <Stethoscope className="h-3.5 w-3.5" /> Open chart
                  </Button>
                  <Button size="sm" variant="outline"
                    loading={undo.isPending && undo.variables?.queue_id === p.queue_id}
                    onClick={() => undo.mutate(p)}>
                    <RotateCcw className="h-3.5 w-3.5" /> Put back
                  </Button>
                </Card>
              ))}
            </div>
          )}
        </div>
      )}

      {checkingOut && (
        <CheckOutDialog p={checkingOut} onClose={() => setCheckingOut(null)}
          pending={checkOut.isPending}
          onConfirm={() => checkOut.mutate(checkingOut)} />
      )}
    </div>
  );
}

function Group({ title, note, children }: { title: string; note: string; children: React.ReactNode }) {
  return (
    <section className="space-y-2">
      <div className="px-1">
        <h2 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">{title}</h2>
        <p className="text-[11px] text-muted-foreground/80">{note}</p>
      </div>
      {children}
    </section>
  );
}

const TONE = {
  amber: "border-l-amber-500",
  brand: "border-l-brand",
  slate: "border-l-slate-300",
} as const;

function ChairCard({ p, tone, dashed, onOpen, onCheckOut, onPickUp, picking }: {
  p: ChairPatient; tone: keyof typeof TONE; dashed?: boolean;
  onOpen?: () => void; onCheckOut?: () => void; onPickUp?: () => void; picking?: boolean;
}) {
  const r = risks(p, true);
  return (
    <Card className={cn("border-l-4 p-4", TONE[tone], dashed && "border-dashed")}>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <p className="flex flex-wrap items-center gap-2">
            <span className="font-semibold text-brand">{p.patient_name}</span>
            {/* Safety first and in red, because it is the one fact on this card that
                can hurt somebody. */}
            {p.allergies && (
              <span className="inline-flex items-center gap-1 rounded-full bg-destructive px-2 py-0.5 text-[11px] font-semibold text-destructive-foreground">
                <AlertTriangle className="h-3 w-3" /> {p.allergies}
              </span>
            )}
          </p>
          <p className="mt-0.5 font-mono text-xs text-muted-foreground">
            {p.mrn}
            {p.age > 0 ? ` · ${p.age}y` : ""}{p.sex ? ` ${p.sex}` : ""}
            {p.department_name ? ` · ${p.department_name}` : ""}
          </p>
          <p className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs">
            <span className="inline-flex items-center gap-1 text-muted-foreground">
              <Clock className="h-3 w-3" />
              {p.state === "in_consult" && p.started_at
                ? `in the chair ${wait(p.started_at)}`
                : `waiting ${wait(p.enqueued_at)}`}
            </span>
            {p.plan_title && (
              <span className="text-muted-foreground">
                {p.plan_title} · {p.plan_done} of {p.plan_total} done
              </span>
            )}
            {num(p.unbilled) > 0.005 && (
              <span className="font-medium text-destructive">{birr(p.unbilled)} unbilled</span>
            )}
            {num(p.owed) > 0.005 && (
              <span className="text-amber-700">{birr(p.owed)} at the cashier</span>
            )}
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          {onPickUp ? (
            <>
              <Badge variant="warning">Unassigned</Badge>
              <Button size="sm" variant="outline" loading={picking} onClick={onPickUp}>
                <HandHelping className="h-3.5 w-3.5" /> Pick up
              </Button>
            </>
          ) : (
            <>
              {onOpen && (
                <Button size="sm" onClick={onOpen}>
                  <Stethoscope className="h-3.5 w-3.5" />
                  {p.state === "in_consult" ? "Continue" : "Open chart"}
                </Button>
              )}
              {onCheckOut && (
                <Button size="sm" variant="outline" onClick={onCheckOut}>
                  <CheckCircle2 className="h-3.5 w-3.5" /> Check out
                </Button>
              )}
            </>
          )}
        </div>
      </div>

      {/* What a check-out would end, said on the card too — so the dentist sees it
          before they reach for the button, not only after. */}
      {r.some((x) => x.hard) && !onPickUp && (
        <div className="mt-3 space-y-1 rounded-md border border-l-4 border-l-amber-500 bg-amber-50 px-3 py-2">
          {r.filter((x) => x.hard).map((x) => (
            <p key={x.text} className="flex items-start gap-1.5 text-xs text-amber-900">
              <x.icon className="mt-0.5 h-3.5 w-3.5 shrink-0" /> {x.text}
            </p>
          ))}
        </div>
      )}
    </Card>
  );
}

/**
 * Check-out, which ends a visit.
 *
 * It was one click with no question asked. It now states what it is about to end,
 * and the confirm button says what will happen rather than "OK" — a dentist reading
 * "End the visit anyway" has been told the thing they need to know.
 */
function CheckOutDialog({ p, pending, onConfirm, onClose }: {
  p: ChairPatient; pending: boolean; onConfirm: () => void; onClose: () => void;
}) {
  const r = risks(p);
  const hard = r.filter((x) => x.hard);
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent fullOnMobile>
        <DialogHeader><DialogTitle>Check out {p.patient_name}?</DialogTitle></DialogHeader>
        <div className="space-y-3">
          {r.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              The visit is recorded and nothing is outstanding. Checking out ends it and
              frees the chair.
            </p>
          ) : (
            <div className="space-y-2">
              {r.map((x) => (
                <p key={x.text}
                  className={cn("flex items-start gap-2 rounded-md border px-3 py-2 text-sm",
                    x.hard ? "border-amber-300 bg-amber-50 text-amber-900"
                           : "border-border bg-muted/40 text-muted-foreground")}>
                  <x.icon className="mt-0.5 h-4 w-4 shrink-0" /> {x.text}
                </p>
              ))}
            </div>
          )}
          <p className="text-xs text-muted-foreground">
            This ends the visit. If it was a mistake you can put them back from
            “Seen today” — nothing is deleted.
          </p>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>Cancel</Button>
          <Button loading={pending} onClick={onConfirm}
            variant={hard.length > 0 ? "destructive" : "default"}>
            {hard.length > 0 ? "End the visit anyway" : "Check out"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
