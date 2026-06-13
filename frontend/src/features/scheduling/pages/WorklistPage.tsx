import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Stethoscope } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { toast } from "@/components/ui/sonner";
import { useAuth } from "@/app/auth-context";
import { listUsers } from "@/features/admin/api";
import { listWorklist, transitionQueue } from "@/features/scheduling/api";

function waitMins(iso: string) {
  return Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 60000));
}

const NEXT: Record<string, { state: string; label: string }> = {
  waiting: { state: "called", label: "Call" },
  called: { state: "in_consult", label: "Start" },
  in_consult: { state: "done", label: "Complete" },
};

export function WorklistPage() {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const { can, user } = useAuth();
  const canPickProvider = can("user.read");
  const canConsult = can("encounter.manage");

  // Admins/reception can view another doctor's list; doctors see their own.
  const providers = useQuery({ queryKey: ["users"], queryFn: listUsers, enabled: canPickProvider });
  const [provider, setProvider] = useState(""); // "" = me

  const worklist = useQuery({
    queryKey: ["worklist", provider],
    queryFn: () => listWorklist(provider || undefined),
    refetchInterval: 20000,
  });

  const transition = useMutation({
    mutationFn: ({ id, state }: { id: string; state: string }) => transitionQueue(id, state),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["worklist", provider] }),
    onError: () => toast.error("Could not update"),
  });

  const viewingSelf = provider === "" || provider === user?.id;

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1>My worklist</h1>
          <p className="text-sm text-muted-foreground">
            {viewingSelf ? "Patients waiting for you." : "Patients waiting for the selected doctor."}
          </p>
        </div>
        {canPickProvider && (
          <div className="w-56">
            <Select value={provider || "me"} onValueChange={(v) => setProvider(v === "me" ? "" : v)}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="me">My patients</SelectItem>
                {(providers.data ?? []).filter((u) => u.status === "active").map((u) => (
                  <SelectItem key={u.id} value={u.id}>
                    {u.full_name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        )}
      </div>

      <div className="space-y-3">
        {(worklist.data ?? []).map((e) => {
          const next = NEXT[e.state];
          return (
            <Card key={e.id} className="flex flex-wrap items-center justify-between gap-3 p-4">
              <div className="min-w-0">
                <p className="font-medium text-brand">{e.patient_name}</p>
                <p className="font-mono text-xs text-muted-foreground">
                  {e.mrn}
                  {e.department_name ? ` · ${e.department_name}` : ""} · waiting {waitMins(e.enqueued_at)}m
                </p>
              </div>
              <div className="flex items-center gap-2">
                <Badge variant="outline">{e.state.replace("_", " ")}</Badge>
                {next && next.state !== "in_consult" && (
                  <Button
                    size="sm"
                    variant="outline"
                    loading={transition.isPending}
                    onClick={() => transition.mutate({ id: e.id, state: next.state })}
                  >
                    {next.label}
                  </Button>
                )}
                {canConsult && viewingSelf && (
                  <Button
                    size="sm"
                    onClick={() => {
                      // Reflect "in consultation" on the live queue board, then open the room.
                      if (e.state !== "in_consult") transitionQueue(e.id, "in_consult").catch(() => {});
                      navigate(`/encounter/${e.id}`);
                    }}
                  >
                    <Stethoscope className="h-3.5 w-3.5" /> Open consult
                  </Button>
                )}
              </div>
            </Card>
          );
        })}
        {(worklist.data?.length ?? 0) === 0 && (
          <Card className="p-12 text-center text-sm text-muted-foreground">No patients waiting.</Card>
        )}
      </div>
    </div>
  );
}
