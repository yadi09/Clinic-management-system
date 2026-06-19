import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "react-router-dom";
import { CalendarPlus, ChevronLeft, ChevronRight, MoreHorizontal } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { toast } from "@/components/ui/sonner";
import { useAuth } from "@/app/auth-context";
import { listBranches } from "@/features/admin/api";
import {
  checkInAppointment,
  listAppointments,
  setAppointmentStatus,
  type Appointment,
} from "@/features/scheduling/api";
import { BookingDialog } from "@/features/scheduling/components/BookingDialog";

function statusVariant(s: string): "default" | "brand" | "success" | "warning" | "destructive" | "outline" {
  return ({ booked: "default", confirmed: "brand", checked_in: "success", completed: "outline", cancelled: "destructive", no_show: "warning" } as const)[s] ?? "default";
}
const fmtTime = (iso: string) => new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
const dayKey = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
const startOfDay = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate());

export function AppointmentsPage() {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const { can } = useAuth();
  const [view, setView] = useState<"day" | "week">("day");
  const [anchor, setAnchor] = useState(() => startOfDay(new Date()));
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editing, setEditing] = useState<Appointment | null>(null);

  const branches = useQuery({ queryKey: ["branches"], queryFn: listBranches });
  const branchId = branches.data?.[0]?.id ?? "";

  const { from, to, days } = useMemo(() => {
    if (view === "day") {
      const f = startOfDay(anchor);
      const t = new Date(f.getTime() + 86400000);
      return { from: f, to: t, days: [f] };
    }
    const start = startOfDay(anchor);
    start.setDate(start.getDate() - ((start.getDay() + 6) % 7)); // Monday
    const ds = Array.from({ length: 7 }, (_, i) => new Date(start.getTime() + i * 86400000));
    return { from: start, to: new Date(start.getTime() + 7 * 86400000), days: ds };
  }, [view, anchor]);

  const appts = useQuery({
    queryKey: ["appointments", branchId, from.toISOString(), to.toISOString()],
    queryFn: () => listAppointments(branchId, from.toISOString(), to.toISOString()),
    enabled: !!branchId,
  });

  const byDay = useMemo(() => {
    const m: Record<string, Appointment[]> = {};
    for (const a of appts.data ?? []) (m[dayKey(new Date(a.starts_at))] ??= []).push(a);
    return m;
  }, [appts.data]);

  const checkIn = useMutation({
    mutationFn: (id: string) => checkInAppointment(id),
    onSuccess: (r) => {
      toast.success(r.gated ? "Checked in — billed; patient joins the queue once payment is collected." : "Checked in — added to queue");
      qc.invalidateQueries({ queryKey: ["appointments"] });
    },
    onError: () => toast.error("Check-in failed"),
  });
  const cancel = useMutation({
    mutationFn: (id: string) => setAppointmentStatus(id, "cancelled"),
    onSuccess: () => {
      toast.success("Appointment cancelled");
      qc.invalidateQueries({ queryKey: ["appointments"] });
    },
  });

  const shift = (n: number) => {
    const d = new Date(anchor);
    d.setDate(d.getDate() + n * (view === "day" ? 1 : 7));
    setAnchor(startOfDay(d));
  };

  const label =
    view === "day"
      ? anchor.toLocaleDateString(undefined, { weekday: "long", month: "long", day: "numeric" })
      : `${days[0].toLocaleDateString(undefined, { month: "short", day: "numeric" })} – ${days[6].toLocaleDateString(undefined, { month: "short", day: "numeric" })}`;

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1>Appointments</h1>
          <p className="text-sm text-muted-foreground">{label}</p>
        </div>
        <div className="flex items-center gap-2">
          <div className="flex rounded-md border bg-card p-0.5">
            {(["day", "week"] as const).map((v) => (
              <button
                key={v}
                onClick={() => setView(v)}
                className={`rounded px-3 py-1 text-sm font-medium capitalize ${view === v ? "bg-primary text-primary-foreground" : "text-muted-foreground"}`}
              >
                {v}
              </button>
            ))}
          </div>
          <Button variant="outline" size="icon" onClick={() => shift(-1)}><ChevronLeft /></Button>
          <Button variant="outline" size="sm" onClick={() => setAnchor(startOfDay(new Date()))}>Today</Button>
          <Button variant="outline" size="icon" onClick={() => shift(1)}><ChevronRight /></Button>
          {can("appointment.manage") && branchId && (
            <Button onClick={() => { setEditing(null); setDialogOpen(true); }}>
              <CalendarPlus /> Book
            </Button>
          )}
        </div>
      </div>

      {!branchId && !branches.isLoading ? (
        <Card className="p-10 text-center text-sm text-muted-foreground">Add a branch in Settings to start booking.</Card>
      ) : appts.isLoading ? (
        <div className="space-y-3">{Array.from({ length: 5 }).map((_, i) => <Skeleton key={i} className="h-14 w-full" />)}</div>
      ) : view === "day" ? (
        <DayAgenda
          items={byDay[dayKey(anchor)] ?? []}
          onCheckIn={(id) => checkIn.mutate(id)}
          onCancel={(id) => cancel.mutate(id)}
          onReschedule={(a) => { setEditing(a); setDialogOpen(true); }}
          onOpenPatient={(pid) => navigate(`/patients/${pid}`)}
        />
      ) : (
        <div className="grid grid-cols-1 gap-3 md:grid-cols-7">
          {days.map((d) => (
            <Card key={dayKey(d)} className="min-h-[120px] p-3">
              <p className="mb-2 text-xs font-semibold text-muted-foreground">
                {d.toLocaleDateString(undefined, { weekday: "short" })} {d.getDate()}
              </p>
              <div className="space-y-1.5">
                {(byDay[dayKey(d)] ?? []).map((a) => (
                  <div key={a.id} className="rounded-md bg-secondary px-2 py-1 text-xs">
                    <span className="font-semibold text-brand">{fmtTime(a.starts_at)}</span> {a.patient_name}
                  </div>
                ))}
                {!(byDay[dayKey(d)] ?? []).length && <p className="text-xs text-muted-foreground">—</p>}
              </div>
            </Card>
          ))}
        </div>
      )}

      {branchId && (
        <BookingDialog
          open={dialogOpen}
          onOpenChange={setDialogOpen}
          branchId={branchId}
          defaultDate={dayKey(anchor)}
          existing={editing}
          onSaved={() => qc.invalidateQueries({ queryKey: ["appointments"] })}
        />
      )}
    </div>
  );
}

function DayAgenda({
  items,
  onCheckIn,
  onCancel,
  onReschedule,
  onOpenPatient,
}: {
  items: Appointment[];
  onCheckIn: (id: string) => void;
  onCancel: (id: string) => void;
  onReschedule: (a: Appointment) => void;
  onOpenPatient: (pid: string) => void;
}) {
  if (items.length === 0) {
    return <Card className="p-12 text-center text-sm text-muted-foreground">No appointments scheduled.</Card>;
  }
  return (
    <Card className="divide-y">
      {items.map((a) => {
        const active = a.status !== "cancelled" && a.status !== "completed" && a.status !== "no_show";
        return (
          <div key={a.id} className="flex items-center gap-4 p-4">
            <div className="w-28 shrink-0 tabular-nums">
              <div className="font-semibold text-brand">{fmtTime(a.starts_at)}</div>
              <div className="text-xs text-muted-foreground">{fmtTime(a.ends_at)}</div>
            </div>
            <div className="min-w-0 flex-1">
              <button className="font-medium text-brand hover:underline" onClick={() => onOpenPatient(a.patient_id)}>
                {a.patient_name}
              </button>
              <div className="text-sm text-muted-foreground">
                {a.provider_name}
                {a.department_name ? ` · ${a.department_name}` : ""}
                {a.reason ? ` · ${a.reason}` : ""}
              </div>
            </div>
            <Badge variant={statusVariant(a.status)}>{a.status.replace(/_/g, " ")}</Badge>
            <DropdownMenu>
              <DropdownMenuTrigger className="rounded-md p-2 hover:bg-accent">
                <MoreHorizontal className="h-4 w-4" />
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                {active && a.status !== "checked_in" && (
                  <DropdownMenuItem onSelect={() => onCheckIn(a.id)}>Check in</DropdownMenuItem>
                )}
                {active && <DropdownMenuItem onSelect={() => onReschedule(a)}>Reschedule</DropdownMenuItem>}
                {active && <DropdownMenuSeparator />}
                {active && (
                  <DropdownMenuItem className="text-destructive focus:text-destructive" onSelect={() => onCancel(a.id)}>
                    Cancel
                  </DropdownMenuItem>
                )}
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        );
      })}
    </Card>
  );
}
