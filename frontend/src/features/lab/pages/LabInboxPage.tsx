import { useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, BellRing, Check, ChevronRight, Inbox } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { toast } from "@/components/ui/sonner";
import { AppError } from "@/lib/api-client";
import { markNotified, resultsInbox, type InboxItem } from "@/features/lab/api";

function when(iso?: string) {
  if (!iso) return "";
  return new Date(iso).toLocaleString([], { month: "short", day: "2-digit", hour: "2-digit", minute: "2-digit" });
}

const TABS = [
  { key: "criticals", label: "Criticals" },
  { key: "all", label: "All results" },
] as const;

export function LabInboxPage() {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const [tab, setTab] = useState<(typeof TABS)[number]["key"]>("criticals");
  const q = useQuery({ queryKey: ["lab-inbox"], queryFn: () => resultsInbox(), refetchInterval: 30000 });

  const notify = useMutation({
    mutationFn: (id: string) => markNotified(id),
    onSuccess: () => {
      toast.success("Marked as notified");
      qc.invalidateQueries({ queryKey: ["lab-inbox"] });
      qc.invalidateQueries({ queryKey: ["lab-inbox-count"] });
    },
    onError: (e) => toast.error(e instanceof AppError ? e.message : "Could not acknowledge"),
  });

  const { criticals, all, unacked } = useMemo(() => {
    const items = q.data ?? [];
    return {
      all: items,
      criticals: items.filter((i) => i.critical),
      unacked: items.filter((i) => i.critical && !i.notified_at).length,
    };
  }, [q.data]);

  const rows = tab === "criticals" ? criticals : all;

  return (
    <div className="space-y-6">
      <div>
        <h1>Results inbox</h1>
        <p className="text-sm text-muted-foreground">
          Lab results returned for your patients. Critical values need acknowledgement.
        </p>
      </div>

      {unacked > 0 && (
        <div className="flex items-center gap-2 rounded-md border border-rose-300 bg-rose-50 px-4 py-2.5 text-sm font-medium text-rose-800">
          <BellRing className="h-4 w-4" /> {unacked} unacknowledged critical result{unacked === 1 ? "" : "s"} — review and mark notified.
        </div>
      )}

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
            <span className="ml-2 rounded-full bg-muted px-2 py-0.5 text-xs">{t.key === "criticals" ? criticals.length : all.length}</span>
          </button>
        ))}
      </div>

      <div className="space-y-2">
        {rows.map((it) => (
          <InboxRow key={it.id} it={it} onOpen={() => navigate(`/lab/items/${it.id}`)} onNotify={() => notify.mutate(it.id)} notifying={notify.isPending} />
        ))}
        {rows.length === 0 && (
          <Card className="flex items-center justify-center gap-2 p-12 text-sm text-muted-foreground">
            <Inbox className="h-4 w-4" /> {tab === "criticals" ? "No critical results." : "No results yet."}
          </Card>
        )}
      </div>
    </div>
  );
}

function InboxRow({ it, onOpen, onNotify, notifying }: { it: InboxItem; onOpen: () => void; onNotify: () => void; notifying: boolean }) {
  const needsAck = it.critical && !it.notified_at;
  return (
    <Card className={`flex flex-wrap items-center justify-between gap-3 p-4 ${needsAck ? "border-rose-300 bg-rose-50/60" : ""}`}>
      <button className="flex min-w-0 items-center gap-3 text-left" onClick={onOpen}>
        <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground" />
        <div className="min-w-0">
          <p className="font-medium text-brand">
            {it.patient_name} <span className="font-mono text-xs text-muted-foreground">{it.mrn}</span>
          </p>
          <p className="text-xs text-muted-foreground">
            {it.test_name} · S-{it.sample_no} · validated {when(it.validated_at)}
          </p>
        </div>
      </button>
      <div className="flex items-center gap-2">
        {it.critical ? (
          <Badge variant="outline" className="border-rose-300 bg-rose-50 text-rose-700">
            <AlertTriangle className="mr-1 h-3.5 w-3.5" /> Critical{it.critical_count > 1 ? ` ×${it.critical_count}` : ""}
          </Badge>
        ) : it.abnormal_count > 0 ? (
          <Badge variant="outline" className="border-amber-300 bg-amber-50 text-amber-700">{it.abnormal_count} abnormal</Badge>
        ) : (
          <Badge variant="outline" className="border-emerald-200 bg-emerald-50 text-emerald-700">Normal</Badge>
        )}
        {it.critical &&
          (it.notified_at ? (
            <span className="flex items-center gap-1 text-xs text-emerald-700">
              <Check className="h-3.5 w-3.5" /> Notified {when(it.notified_at)}
            </span>
          ) : (
            <Button size="sm" loading={notifying} onClick={onNotify}>
              <BellRing className="h-3.5 w-3.5" /> Mark notified
            </Button>
          ))}
      </div>
    </Card>
  );
}
