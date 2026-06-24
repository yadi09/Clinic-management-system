import { useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { CalendarDays, CheckCircle2, FlaskConical, HandHelping, Stethoscope } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { toast } from "@/components/ui/sonner";
import { useAuth } from "@/app/auth-context";
import { listBranches, listUsers } from "@/features/admin/api";
import { assignProvider, listAppointments, listUnassigned, listWorklist, transitionQueue } from "@/features/scheduling/api";
import { myBoard, type BoardActive } from "@/features/clinical/api";
import { DateRangeFilter, windowFor, type DateWindow } from "@/components/ui/date-range-filter";

function waitMins(iso: string) {
  return Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 60000));
}
function hhmm(iso: string) {
  return new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function reasonOf(e: BoardActive): { label: string; cls: string } {
  if (e.status === "awaiting_results") {
    return e.pending_labs > 0
      ? { label: `Awaiting lab (${e.pending_labs})`, cls: "border-amber-300 bg-amber-50 text-amber-700" }
      : { label: "Awaiting results", cls: "border-amber-300 bg-amber-50 text-amber-700" };
  }
  return { label: "In consultation", cls: "border-sky-300 bg-sky-50 text-sky-700" };
}

type TabKey = "waiting" | "progress" | "appointments" | "done";
export function WorklistPage() {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const { can, user } = useAuth();
  const canPickProvider = can("user.read");

  const providers = useQuery({ queryKey: ["users"], queryFn: listUsers, enabled: canPickProvider });
  const [provider, setProvider] = useState(""); // "" = me
  const [tab, setTab] = useState<TabKey>("waiting");
  const [win, setWin] = useState<DateWindow>(() => windowFor("today"));
  const providerId = provider || undefined;
  const viewingSelf = provider === "" || provider === user?.id;
  const claimProvider = provider || user?.id; // who "Pick up" assigns to

  const waiting = useQuery({
    queryKey: ["worklist", provider, win.from, win.to],
    queryFn: () => listWorklist(providerId, win.from, win.to),
    refetchInterval: 20000,
  });
  // Unassigned pick-up pool — patients past triage not yet claimed by any doctor.
  const unassigned = useQuery({
    queryKey: ["unassigned", win.from, win.to],
    queryFn: () => listUnassigned(win.from, win.to),
    refetchInterval: 20000,
  });
  const board = useQuery({
    queryKey: ["board", provider, win.from, win.to],
    queryFn: () => myBoard(providerId, win.from, win.to),
    refetchInterval: 20000,
  });

  const pickUp = useMutation({
    mutationFn: (queueId: string) => {
      if (!claimProvider) throw new Error("no provider");
      return assignProvider(queueId, claimProvider);
    },
    onSuccess: (_d, queueId) => {
      toast.success("Patient picked up");
      qc.invalidateQueries({ queryKey: ["unassigned"] });
      qc.invalidateQueries({ queryKey: ["worklist"] });
      navigate(`/encounter/${queueId}`);
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : "Could not pick up the patient"),
  });

  // Appointments are scoped by branch; load the doctor's branches best-effort and
  // merge a [window-start → +14d] range for the selected provider.
  const branches = useQuery({ queryKey: ["branches"], queryFn: listBranches, retry: false });
  const apptProvider = provider || user?.id;
  const appts = useQuery({
    queryKey: ["board-appts", provider, win.from, (branches.data ?? []).map((b) => b.id).join(",")],
    enabled: tab === "appointments" && !!apptProvider && (branches.data?.length ?? 0) > 0,
    queryFn: async () => {
      const startToday = new Date(); startToday.setHours(0, 0, 0, 0);
      const to = new Date(startToday.getTime() + 14 * 86_400_000);
      const from = win.from ?? startToday.toISOString();
      const lists = await Promise.all(
        (branches.data ?? []).map((b) => listAppointments(b.id, from, to.toISOString(), apptProvider).catch(() => [])),
      );
      const open = new Set(["booked", "confirmed", "checked_in"]);
      return lists.flat().filter((a) => open.has(a.status)).sort((x, y) => x.starts_at.localeCompare(y.starts_at));
    },
  });

  const counts = useMemo(
    () => ({
      waiting: (waiting.data?.length ?? 0) + (unassigned.data?.length ?? 0),
      progress: board.data?.active.length ?? 0,
      appointments: appts.data?.length ?? 0,
      done: board.data?.done.length ?? 0,
    }),
    [waiting.data, unassigned.data, board.data, appts.data],
  );

  const TABS: { key: TabKey; label: string }[] = [
    { key: "waiting", label: "Waiting" },
    { key: "progress", label: "In progress" },
    { key: "appointments", label: "Appointments" },
    { key: "done", label: "Done" },
  ];

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1>My day</h1>
          <p className="text-sm text-muted-foreground">
            {viewingSelf ? "Your patients — waiting, in progress, scheduled and done." : "The selected doctor's patients."}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <DateRangeFilter onChange={setWin} />
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

      <div className="flex flex-wrap gap-1 border-b">
        {TABS.map((t) => (
          <button
            key={t.key}
            onClick={() => setTab(t.key)}
            className={`-mb-px border-b-2 px-4 py-2 text-sm font-medium ${
              tab === t.key ? "border-primary text-primary" : "border-transparent text-muted-foreground hover:text-foreground"
            }`}
          >
            {t.label}
            <span className="ml-2 rounded-full bg-muted px-2 py-0.5 text-xs">{counts[t.key]}</span>
          </button>
        ))}
      </div>

      {tab === "waiting" && (
        <div className="space-y-3">
          {(waiting.data ?? []).map((e) => (
            <Card key={e.id} className="flex flex-wrap items-center justify-between gap-3 p-4">
              <div className="min-w-0">
                <p className="font-medium text-brand">{e.patient_name}</p>
                <p className="font-mono text-xs text-muted-foreground">
                  {e.mrn}{e.department_name ? ` · ${e.department_name}` : ""} · waiting {waitMins(e.enqueued_at)}m
                </p>
              </div>
              <div className="flex items-center gap-2">
                <Badge variant="outline">{e.state.replace("_", " ")}</Badge>
                {viewingSelf && (
                  <Button
                    size="sm"
                    onClick={() => {
                      if (e.state !== "in_consult") transitionQueue(e.id, "in_consult").catch(() => {});
                      navigate(`/encounter/${e.id}`);
                    }}
                  >
                    <Stethoscope className="h-3.5 w-3.5" /> Open consult
                  </Button>
                )}
              </div>
            </Card>
          ))}

          {/* Unassigned pick-up pool — patients past triage not yet claimed by a doctor. */}
          {(unassigned.data?.length ?? 0) > 0 && (
            <>
              <p className="px-1 pt-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
                Unassigned · available to pick up
              </p>
              {(unassigned.data ?? []).map((e) => (
                <Card key={e.id} className="flex flex-wrap items-center justify-between gap-3 border-dashed p-4">
                  <div className="min-w-0">
                    <p className="font-medium text-brand">{e.patient_name}</p>
                    <p className="font-mono text-xs text-muted-foreground">
                      {e.mrn}{e.department_name ? ` · ${e.department_name}` : ""} · waiting {waitMins(e.enqueued_at)}m
                    </p>
                  </div>
                  <div className="flex items-center gap-2">
                    <Badge variant="warning">Unassigned</Badge>
                    {claimProvider && (
                      <Button size="sm" variant="outline" loading={pickUp.isPending && pickUp.variables === e.id} onClick={() => pickUp.mutate(e.id)}>
                        <HandHelping className="h-3.5 w-3.5" /> Pick up
                      </Button>
                    )}
                  </div>
                </Card>
              ))}
            </>
          )}

          {counts.waiting === 0 && <Card className="p-12 text-center text-sm text-muted-foreground">No patients waiting.</Card>}
        </div>
      )}

      {tab === "progress" && (
        <div className="space-y-3">
          {(board.data?.active ?? []).map((e) => {
            const r = reasonOf(e);
            return (
              <Card key={e.encounter_id} className="flex flex-wrap items-center justify-between gap-3 p-4">
                <div className="min-w-0">
                  <p className="font-medium text-brand">{e.patient_name}</p>
                  <p className="font-mono text-xs text-muted-foreground">{e.mrn} · started {hhmm(e.started_at)}</p>
                </div>
                <div className="flex items-center gap-2">
                  <Badge variant="outline" className={r.cls}>
                    {e.status === "awaiting_results" && <FlaskConical className="mr-1 h-3.5 w-3.5" />}
                    {r.label}
                  </Badge>
                  {viewingSelf && e.queue_entry_id && (
                    <Button size="sm" onClick={() => navigate(`/encounter/${e.queue_entry_id}`)}>
                      <Stethoscope className="h-3.5 w-3.5" /> Resume
                    </Button>
                  )}
                </div>
              </Card>
            );
          })}
          {counts.progress === 0 && <Card className="p-12 text-center text-sm text-muted-foreground">No in-progress encounters.</Card>}
        </div>
      )}

      {tab === "appointments" && (
        <div className="space-y-3">
          {(branches.data?.length ?? 0) === 0 ? (
            <Card className="p-12 text-center text-sm text-muted-foreground">
              Appointments are on the <a href="/appointments" className="text-primary underline">Appointments</a> page.
            </Card>
          ) : (
            <>
              {(appts.data ?? []).map((a) => (
                <Card key={a.id} className="flex flex-wrap items-center justify-between gap-3 p-4">
                  <div className="min-w-0">
                    <p className="font-medium text-brand">{a.patient_name}</p>
                    <p className="font-mono text-xs text-muted-foreground">
                      {a.mrn}{a.department_name ? ` · ${a.department_name}` : ""}{a.reason ? ` · ${a.reason}` : ""}
                    </p>
                  </div>
                  <div className="flex items-center gap-2 text-sm">
                    <CalendarDays className="h-4 w-4 text-muted-foreground" />
                    {new Date(a.starts_at).toLocaleString([], { month: "short", day: "2-digit", hour: "2-digit", minute: "2-digit" })}
                    <Badge variant="outline">{a.status.replace("_", " ")}</Badge>
                  </div>
                </Card>
              ))}
              {counts.appointments === 0 && <Card className="p-12 text-center text-sm text-muted-foreground">No upcoming appointments.</Card>}
            </>
          )}
        </div>
      )}

      {tab === "done" && (
        <div className="space-y-3">
          {(board.data?.done ?? []).map((e) => (
            <Card key={e.encounter_id} className="flex flex-wrap items-center justify-between gap-3 p-4">
              <div className="min-w-0">
                <p className="font-medium text-brand">{e.patient_name}</p>
                <p className="font-mono text-xs text-muted-foreground">{e.mrn}</p>
              </div>
              <div className="flex items-center gap-2 text-sm text-muted-foreground">
                <CheckCircle2 className="h-4 w-4 text-emerald-600" />
                Closed {e.closed_at ? hhmm(e.closed_at) : ""}
              </div>
            </Card>
          ))}
          {counts.done === 0 && <Card className="p-12 text-center text-sm text-muted-foreground">Nothing closed in this range.</Card>}
        </div>
      )}
    </div>
  );
}
