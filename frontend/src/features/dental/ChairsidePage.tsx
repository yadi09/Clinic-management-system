import { useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { CheckCircle2, HandHelping, Stethoscope } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Segmented } from "@/components/ui/segmented";
import { toast } from "@/components/ui/sonner";
import { AppError } from "@/lib/api-client";
import { useAuth } from "@/app/auth-context";
import { listUsers } from "@/features/admin/api";
import { assignProvider, listUnassigned, listWorklist, transitionQueue } from "@/features/scheduling/api";
import { dentalOutstanding } from "@/features/dental/api";
import { windowFor, type DateWindow } from "@/components/ui/date-range-filter";

function waitMins(iso: string) {
  return Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 60000));
}
const birr = (s: string) => `${Number(s || 0).toLocaleString(undefined, { maximumFractionDigits: 0 })} ETB`;

// Chairside date scopes. "Today" is the default — a dentist opens this page to see
// who is waiting at the chair right now. A patient sent days ago and never checked
// out is still reachable: "All" is one tap away.
type ChairRange = "today" | "3d" | "7d" | "all";
const DAY = 86_400_000;
function chairWindow(r: ChairRange): DateWindow {
  if (r !== "7d") return windowFor(r);
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  return { from: new Date(today.getTime() - 6 * DAY).toISOString(), to: new Date(today.getTime() + DAY).toISOString() };
}

// The dentist's chairside list: patients reception has sent to the chair today.
// Reuses the shared queue (walk-in → worklist → transition) but opens the DENTAL
// workspace instead of a SOAP encounter, and "Check out" dequeues without one.
export function ChairsidePage() {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const { can, user } = useAuth();
  const canPickProvider = can("user.read");

  const [range, setRange] = useState<ChairRange>("today");
  const win = useMemo(() => chairWindow(range), [range]);
  const providers = useQuery({ queryKey: ["users"], queryFn: listUsers, enabled: canPickProvider });
  const [provider, setProvider] = useState(""); // "" = me
  const providerId = provider || undefined;
  const viewingSelf = provider === "" || provider === user?.id;
  const claimProvider = provider || user?.id;

  const waiting = useQuery({
    queryKey: ["chairside-worklist", provider, win.from, win.to],
    queryFn: () => listWorklist(providerId, win.from, win.to),
    refetchInterval: 20000,
  });
  const unassigned = useQuery({
    queryKey: ["chairside-unassigned", win.from, win.to],
    queryFn: () => listUnassigned(win.from, win.to),
    refetchInterval: 20000,
  });
  const outstanding = useQuery({ queryKey: ["dental-outstanding"], queryFn: dentalOutstanding });
  const owes = useMemo(
    () => new Map((outstanding.data ?? []).map((o) => [o.patient_id, o.balance])),
    [outstanding.data],
  );

  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ["chairside-worklist"] });
    qc.invalidateQueries({ queryKey: ["chairside-unassigned"] });
  };

  // Open the chart: mark the patient in-chair, then jump to the dental workspace.
  const open = (queueId: string, patientId: string, state: string) => {
    if (state !== "in_consult") transitionQueue(queueId, "in_consult").catch(() => {});
    navigate(`/patients/${patientId}`);
  };

  const checkOut = useMutation({
    mutationFn: (queueId: string) => transitionQueue(queueId, "done"),
    onSuccess: () => { toast.success("Patient checked out"); invalidate(); },
    onError: (e) => toast.error(e instanceof AppError ? e.message : "Could not check out"),
  });
  const pickUp = useMutation({
    mutationFn: (queueId: string) => {
      if (!claimProvider) throw new Error("no provider");
      return assignProvider(queueId, claimProvider);
    },
    onSuccess: () => { toast.success("Patient picked up"); invalidate(); },
    onError: (e) => toast.error(e instanceof AppError ? e.message : "Could not pick up the patient"),
  });

  const mine = waiting.data ?? [];
  const pool = unassigned.data ?? [];
  const empty = mine.length === 0 && pool.length === 0;

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1>Chairside</h1>
          <p className="text-sm text-muted-foreground">
            {viewingSelf ? "Patients reception has sent to your chair." : "The selected dentist's chairside list."}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Segmented
            ariaLabel="Date range"
            value={range}
            onChange={setRange}
            options={[
              { value: "today", label: "Today" },
              { value: "3d", label: "3 days" },
              { value: "7d", label: "7 days" },
              { value: "all", label: "All" },
            ]}
          />
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

      <div className="space-y-3">
        {mine.map((e) => (
          <Card key={e.id} className="flex flex-wrap items-center justify-between gap-3 p-4">
            <div className="min-w-0">
              <p className="flex items-center gap-2 font-medium text-brand">
                {e.patient_name}
                {owes.has(e.patient_id) && <Badge variant="destructive">Owes {birr(owes.get(e.patient_id)!)}</Badge>}
              </p>
              <p className="font-mono text-xs text-muted-foreground">
                {e.mrn}{e.department_name ? ` · ${e.department_name}` : ""} · waiting {waitMins(e.enqueued_at)}m
              </p>
            </div>
            <div className="flex items-center gap-2">
              <Badge variant="outline">{e.state.replace("_", " ")}</Badge>
              {viewingSelf && (
                <>
                  <Button size="sm" onClick={() => open(e.id, e.patient_id, e.state)}>
                    <Stethoscope className="h-3.5 w-3.5" /> Open chart
                  </Button>
                  <Button size="sm" variant="outline" loading={checkOut.isPending && checkOut.variables === e.id} onClick={() => checkOut.mutate(e.id)}>
                    <CheckCircle2 className="h-3.5 w-3.5" /> Check out
                  </Button>
                </>
              )}
            </div>
          </Card>
        ))}

        {pool.length > 0 && (
          <>
            <p className="px-1 pt-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
              Sent by reception · not yet assigned
            </p>
            {pool.map((e) => (
              <Card key={e.id} className="flex flex-wrap items-center justify-between gap-3 border-dashed p-4">
                <div className="min-w-0">
                  <p className="flex items-center gap-2 font-medium text-brand">
                    {e.patient_name}
                    {owes.has(e.patient_id) && <Badge variant="destructive">Owes {birr(owes.get(e.patient_id)!)}</Badge>}
                  </p>
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

        {empty && <Card className="p-12 text-center text-sm text-muted-foreground">No patients at the chair. Reception sends them here.</Card>}
      </div>
    </div>
  );
}
