import { useEffect, useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Radio, LayoutGrid, List as ListIcon, FlaskConical, Clock } from "lucide-react";

import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { listDepartments } from "@/features/admin/api";
import { listQueue, queueStreamUrl, type QueueEntry } from "@/features/scheduling/api";

type BadgeVariant = "default" | "brand" | "success" | "warning" | "destructive" | "outline";
type Lane = "waiting" | "in_consult" | "in_lab" | "done";

// A read-only monitor: the queue board only reflects where each patient is, it
// never moves them. Transitions are driven by the people doing the work — the
// doctor opening a patient (→ in consult), ordering a lab (→ in lab) and signing
// off (→ done). Reception adds patients from the Reception page, not here.

// Which lane a patient sits in. "called" folds into Waiting (still waiting to be
// seen); the In-lab lane is the in_consult state split out by the derived flag.
function laneOf(e: QueueEntry): Lane {
  if (e.state === "done" || e.state === "no_show") return "done";
  if (e.state === "in_consult") return e.in_lab ? "in_lab" : "in_consult";
  return "waiting";
}

const LANES: { key: Lane; label: string; lab?: boolean }[] = [
  { key: "waiting", label: "Waiting" },
  { key: "in_consult", label: "In consult" },
  { key: "in_lab", label: "In lab", lab: true },
  { key: "done", label: "Done" },
];

const LANE_BADGE: Record<Lane, { label: string; variant: BadgeVariant }> = {
  waiting: { label: "Waiting", variant: "outline" },
  in_consult: { label: "In consult", variant: "brand" },
  in_lab: { label: "In lab", variant: "warning" },
  done: { label: "Done", variant: "success" },
};

function statusBadge(e: QueueEntry): { label: string; variant: BadgeVariant } {
  if (e.state === "no_show") return { label: "No-show", variant: "destructive" };
  return LANE_BADGE[laneOf(e)];
}

function waitMins(iso: string) {
  return Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 60000));
}

type RangeKind = "today" | "yesterday" | "3d";

// Local-day boundaries → ISO, so "today" means the staff's calendar day.
function rangeWindow(kind: RangeKind): { from: string; to: string } {
  const now = new Date();
  const startToday = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const day = 86_400_000;
  if (kind === "yesterday") {
    return { from: new Date(startToday.getTime() - day).toISOString(), to: startToday.toISOString() };
  }
  if (kind === "3d") {
    return { from: new Date(startToday.getTime() - 2 * day).toISOString(), to: new Date(startToday.getTime() + day).toISOString() };
  }
  return { from: startToday.toISOString(), to: new Date(startToday.getTime() + day).toISOString() };
}

const RANGE_LABEL: Record<RangeKind, string> = { today: "Today", yesterday: "Yesterday", "3d": "Last 3 days" };

export function QueuePage() {
  const qc = useQueryClient();

  const departments = useQuery({ queryKey: ["departments"], queryFn: listDepartments });
  const [dept, setDept] = useState("");
  useEffect(() => {
    if (!dept && departments.data?.length) setDept(departments.data[0].id);
  }, [departments.data, dept]);

  const [range, setRange] = useState<RangeKind>("today");
  const [view, setView] = useState<"board" | "list">(() => (localStorage.getItem("clinicos_queue_view") === "list" ? "list" : "board"));
  useEffect(() => localStorage.setItem("clinicos_queue_view", view), [view]);

  const win = useMemo(() => rangeWindow(range), [range]);
  const queue = useQuery({
    queryKey: ["queue", dept, range],
    queryFn: () => listQueue(dept, undefined, win),
    enabled: !!dept,
    refetchInterval: 60000, // safety net; SSE drives most updates
  });

  // Live updates via SSE (Postgres LISTEN/NOTIFY). Only "today" is actively changing.
  useEffect(() => {
    if (!dept || range !== "today") return;
    const es = new EventSource(queueStreamUrl(dept));
    es.addEventListener("queue", () => qc.invalidateQueries({ queryKey: ["queue", dept] }));
    return () => es.close();
  }, [dept, range, qc]);

  const entries = queue.data ?? [];
  const grouped = useMemo(() => {
    const m: Record<Lane, QueueEntry[]> = { waiting: [], in_consult: [], in_lab: [], done: [] };
    for (const e of entries) m[laneOf(e)].push(e);
    return m;
  }, [entries]);

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="flex items-center gap-2">
            Queue {range === "today" && <Radio className="h-4 w-4 text-primary" aria-label="live" />}
          </h1>
          <p className="text-sm text-muted-foreground">
            {range === "today" ? "Live department board — view only" : `Showing ${RANGE_LABEL[range].toLowerCase()}`}
          </p>
        </div>
        <div className="w-52">
          <Select value={dept} onValueChange={setDept}>
            <SelectTrigger>
              <SelectValue placeholder="Select department" />
            </SelectTrigger>
            <SelectContent>
              {(departments.data ?? []).map((d) => (
                <SelectItem key={d.id} value={d.id}>
                  {d.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>

      {/* Toolbar: date filter + view toggle */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="inline-flex rounded-lg border p-0.5">
          {(Object.keys(RANGE_LABEL) as RangeKind[]).map((k) => (
            <button
              key={k}
              onClick={() => setRange(k)}
              className={`rounded-md px-3 py-1.5 text-sm font-medium ${range === k ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:text-foreground"}`}
            >
              {RANGE_LABEL[k]}
            </button>
          ))}
        </div>
        <div className="inline-flex rounded-lg border p-0.5">
          <ViewBtn active={view === "board"} onClick={() => setView("board")} icon={<LayoutGrid className="h-4 w-4" />} label="Board" />
          <ViewBtn active={view === "list"} onClick={() => setView("list")} icon={<ListIcon className="h-4 w-4" />} label="List" />
        </div>
      </div>

      {!dept ? (
        <Card className="p-12 text-center text-sm text-muted-foreground">
          Create a department in Settings to use the queue.
        </Card>
      ) : entries.length === 0 ? (
        <Card className="p-12 text-center text-sm text-muted-foreground">
          No patients {RANGE_LABEL[range].toLowerCase()}.
        </Card>
      ) : view === "board" ? (
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-4">
          {LANES.map((lane) => (
            <div key={lane.key} className="flex min-h-0 flex-col gap-2 rounded-lg bg-muted/30 p-2">
              <div className="flex items-center justify-between px-1">
                <h2 className="flex items-center gap-1.5 text-sm font-semibold">
                  {lane.lab && <FlaskConical className="h-3.5 w-3.5 text-warning" />}
                  {lane.label}
                </h2>
                <Badge variant="outline">{grouped[lane.key].length}</Badge>
              </div>
              <div className="max-h-[62vh] space-y-2 overflow-y-auto pr-0.5">
                {grouped[lane.key].map((e) => (
                  <Card key={e.id} className="p-3">
                    <div className="flex items-start justify-between gap-2">
                      <div className="min-w-0">
                        <p className="truncate font-medium text-brand">{e.patient_name}</p>
                        <p className="font-mono text-xs text-muted-foreground">{e.mrn}</p>
                      </div>
                      {lane.key !== "done" && (
                        <span className="inline-flex shrink-0 items-center gap-1 text-xs text-muted-foreground">
                          <Clock className="h-3 w-3" />
                          {waitMins(e.enqueued_at)}m
                        </span>
                      )}
                    </div>
                    {lane.key === "in_lab" ? (
                      <p className="mt-1 text-xs text-warning">Awaiting lab results</p>
                    ) : (
                      e.provider_name && <p className="mt-1 truncate text-xs text-muted-foreground">{e.provider_name}</p>
                    )}
                  </Card>
                ))}
                {grouped[lane.key].length === 0 && (
                  <p className="rounded-md border border-dashed p-3 text-center text-xs text-muted-foreground">Empty</p>
                )}
              </div>
            </div>
          ))}
        </div>
      ) : (
        <QueueList entries={entries} grouped={grouped} />
      )}
    </div>
  );
}

function ViewBtn({ active, onClick, icon, label }: { active: boolean; onClick: () => void; icon: React.ReactNode; label: string }) {
  return (
    <button
      onClick={onClick}
      className={`inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-sm font-medium ${active ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:text-foreground"}`}
    >
      {icon} {label}
    </button>
  );
}

function QueueList({ entries, grouped }: { entries: QueueEntry[]; grouped: Record<Lane, QueueEntry[]> }) {
  const [filter, setFilter] = useState<Lane | "all">("all");
  const rows = filter === "all" ? entries : grouped[filter];

  const chips: { key: Lane | "all"; label: string; count: number }[] = [
    { key: "all", label: "All", count: entries.length },
    ...LANES.map((l) => ({ key: l.key, label: l.label, count: grouped[l.key].length })),
  ];

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap gap-1.5">
        {chips.map((c) => (
          <button
            key={c.key}
            onClick={() => setFilter(c.key)}
            className={`inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-sm font-medium ${
              filter === c.key ? "border-primary bg-primary text-primary-foreground" : "text-muted-foreground hover:text-foreground"
            }`}
          >
            {c.label}
            <span className={`rounded-full px-1.5 text-xs ${filter === c.key ? "bg-background/20" : "bg-muted"}`}>{c.count}</span>
          </button>
        ))}
      </div>

      <Card className="overflow-hidden p-0">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="border-b bg-muted/40 text-left text-xs uppercase tracking-wide text-muted-foreground">
              <tr>
                <th className="px-4 py-2.5 font-medium">Patient</th>
                <th className="px-4 py-2.5 font-medium">Status</th>
                <th className="px-4 py-2.5 font-medium">Doctor</th>
                <th className="px-4 py-2.5 font-medium">Waiting</th>
              </tr>
            </thead>
            <tbody className="divide-y">
              {rows.map((e) => {
                const st = statusBadge(e);
                const active = laneOf(e) !== "done";
                return (
                  <tr key={e.id} className="hover:bg-muted/20">
                    <td className="px-4 py-2.5">
                      <p className="font-medium text-brand">{e.patient_name}</p>
                      <p className="font-mono text-xs text-muted-foreground">{e.mrn}</p>
                    </td>
                    <td className="px-4 py-2.5">
                      <Badge variant={st.variant} className="gap-1">
                        {laneOf(e) === "in_lab" && <FlaskConical className="h-3 w-3" />}
                        {st.label}
                      </Badge>
                    </td>
                    <td className="px-4 py-2.5 text-muted-foreground">{e.provider_name || "—"}</td>
                    <td className="px-4 py-2.5 text-muted-foreground">{active ? `${waitMins(e.enqueued_at)}m` : "—"}</td>
                  </tr>
                );
              })}
              {rows.length === 0 && (
                <tr>
                  <td colSpan={4} className="px-4 py-10 text-center text-sm text-muted-foreground">
                    No patients in this status.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </Card>
    </div>
  );
}
