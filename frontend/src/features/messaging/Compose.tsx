// A message written once, to the patients somebody chose.
//
// Holiday greetings, a closure notice, "the dentist is away next week". The
// deliberate design choice is that there is no "send to everyone" button: you
// filter, and then the people who will actually be messaged are listed in front of
// you with their numbers, and you can untick any of them. Nothing goes out because
// a checkbox somewhere defaulted to on.
//
// Unreachable patients are shown, not hidden. A clinic asking for "everyone seen
// this year" and quietly getting 138 of 143 has been misled; being told which five
// have no usable number is both honest and fixable.
import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Send, Users } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { toast } from "@/components/ui/sonner";
import { cn } from "@/lib/utils";
import { AppError } from "@/lib/api-client";
import { useConfirmDialog } from "@/components/ConfirmDialog";
import {
  messageAudience, previewMessage, sendCampaign,
  type AudienceRow, type MessagingSettings,
} from "@/features/messaging/api";

const SEEN = [
  { value: "0", label: "Any time" },
  { value: "90", label: "Last 3 months" },
  { value: "180", label: "Last 6 months" },
  { value: "365", label: "Last year" },
];

// Why a patient cannot be reached, in words a receptionist can act on.
const ISSUE: Record<string, string> = {
  missing: "no phone number",
  invalid: "number is not valid",
  unsupported: "not an Ethio Telecom number",
};

export function ComposeTab({ settings }: { settings?: MessagingSettings }) {
  const qc = useQueryClient();
  const { ask, dialog } = useConfirmDialog();
  const [seen, setSeen] = useState("180");
  const [owing, setOwing] = useState(false);
  const [q, setQ] = useState("");
  const [dropped, setDropped] = useState<Record<string, boolean>>({});
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [when, setWhen] = useState("");

  const audience = useQuery({
    queryKey: ["message-audience", seen, owing, q],
    queryFn: () => messageAudience({
      q: q.trim() || undefined,
      seen_days: Number(seen) || undefined,
      owing: owing || undefined,
    }),
  });

  // Memoised so the derived lists below have a stable dependency; without it the
  // fallback array is a new object every render and the memos never hold.
  const rows = useMemo(() => audience.data ?? [], [audience.data]);
  // Opted-out patients are excluded here as well as on the server. Someone who
  // asked not to be messaged should not even appear as a tickable choice.
  const selectable = useMemo(() => rows.filter((r) => r.reachable && !r.opted_out), [rows]);
  const chosen = useMemo(() => selectable.filter((r) => !dropped[r.id]), [selectable, dropped]);
  const unreachable = rows.filter((r) => !r.reachable);
  const optedOut = rows.filter((r) => r.opted_out && r.reachable);

  const preview = useQuery({
    queryKey: ["messaging-preview", body],
    queryFn: () => previewMessage(body),
    enabled: body.trim().length > 0,
  });

  const send = useMutation({
    mutationFn: () => sendCampaign({
      title: title.trim() || "Message to patients",
      body,
      patient_ids: chosen.map((r) => r.id),
      scheduled_for: when ? new Date(when).toISOString() : undefined,
    }),
    onSuccess: (res) => {
      toast.success(`${res.queued} message${res.queued === 1 ? "" : "s"} queued · ${res.cost} ETB`);
      setBody(""); setTitle(""); setDropped({});
      qc.invalidateQueries({ queryKey: ["messaging-usage"] });
      qc.invalidateQueries({ queryKey: ["message-log"] });
    },
    onError: (e) => toast.error(e instanceof AppError ? e.message : "Could not send it"),
  });

  const segs = preview.data?.segments ?? 1;
  const cost = (chosen.length * segs * (settings?.cost_per_segment ?? 0)).toFixed(2);

  return (
    <div className="space-y-4">
      {dialog}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-sm">Who gets it</CardTitle>
          <CardDescription>
            Filter, then untick anyone you do not want. Only the people listed below are messaged.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="grid gap-3 sm:grid-cols-3">
            <div className="space-y-1.5">
              <Label>Seen</Label>
              <Select value={seen} onValueChange={(v) => { setSeen(v); setDropped({}); }}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  {SEEN.map((s) => <SelectItem key={s.value} value={s.value}>{s.label}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="aud-q">Name or card number</Label>
              <Input id="aud-q" value={q} onChange={(e) => { setQ(e.target.value); setDropped({}); }}
                placeholder="Search…" />
            </div>
            <label className="flex cursor-pointer items-end gap-2 pb-2 text-sm">
              <input type="checkbox" checked={owing} onChange={(e) => { setOwing(e.target.checked); setDropped({}); }} />
              <span>Only patients who owe money</span>
            </label>
          </div>

          <div className="flex flex-wrap items-center gap-2 rounded-md border bg-muted/40 px-3 py-2 text-sm">
            <Users className="h-4 w-4 text-muted-foreground" />
            <span><b>{chosen.length}</b> will be messaged</span>
            {unreachable.length > 0 && (
              <span className="text-amber-700">· {unreachable.length} cannot be reached</span>
            )}
            {optedOut.length > 0 && (
              <span className="text-muted-foreground">· {optedOut.length} asked not to be messaged</span>
            )}
            <div className="ml-auto flex gap-2">
              <Button size="sm" variant="ghost" className="h-7 px-2 text-xs" onClick={() => setDropped({})}>
                Select all
              </Button>
              <Button size="sm" variant="ghost" className="h-7 px-2 text-xs"
                onClick={() => setDropped(Object.fromEntries(selectable.map((r) => [r.id, true])))}>
                Clear
              </Button>
            </div>
          </div>

          <div className="max-h-64 divide-y overflow-auto rounded-md border">
            {rows.length === 0 && (
              <p className="px-3 py-6 text-center text-sm text-muted-foreground">
                No patients match that filter.
              </p>
            )}
            {rows.map((r) => <AudienceLine key={r.id} row={r}
              checked={r.reachable && !r.opted_out && !dropped[r.id]}
              onToggle={() => setDropped((d) => ({ ...d, [r.id]: !d[r.id] }))} />)}
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-sm">What it says</CardTitle>
          <CardDescription>
            {`Use {{name}} for the patient's first name — everything else is the same for everyone.`}
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="camp-title">What this is (for your records)</Label>
              <Input id="camp-title" value={title} onChange={(e) => setTitle(e.target.value)}
                placeholder="New Year greeting" />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="camp-when">Send</Label>
              <Input id="camp-when" type="datetime-local" value={when}
                onChange={(e) => setWhen(e.target.value)} />
              <p className="text-xs text-muted-foreground">Leave empty to send now. Quiet hours still apply.</p>
            </div>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="camp-body">Message</Label>
            <Textarea id="camp-body" rows={3} value={body} onChange={(e) => setBody(e.target.value)}
              placeholder="Dear {{name}}, the clinic is closed on Monday for the holiday." />
            <div className="flex flex-wrap gap-1.5">
              <button type="button" onClick={() => setBody((b) => b + "{{name}}")}
                className="rounded-full border px-2 py-0.5 text-[11px] font-medium hover:bg-muted">
                {"{{name}}"}
              </button>
            </div>
            {preview.data && (
              <p className={cn("text-xs", segs > 1 ? "font-medium text-amber-700" : "text-muted-foreground")}>
                {preview.data.chars} characters · <b>{segs} message{segs === 1 ? "" : "s"}</b>{" "}
                ({preview.data.per_segment} characters each{preview.data.unicode ? ", Amharic" : ""})
                {" · "}
                {chosen.length} recipient{chosen.length === 1 ? "" : "s"} ≈ <b>{cost} ETB</b>
              </p>
            )}
          </div>

          {preview.data && (
            <div className="rounded-md border bg-muted/40 p-3">
              <p className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                What a patient sees
              </p>
              <p className="whitespace-pre-wrap text-sm">{preview.data.body}</p>
            </div>
          )}

          <Button
            disabled={!body.trim() || chosen.length === 0 || !settings?.enabled}
            loading={send.isPending}
            onClick={() => ask({
              title: `Send to ${chosen.length} patient${chosen.length === 1 ? "" : "s"}?`,
              // The cost is in the confirmation because this is the one action here
              // that can spend a lot at once, and it cannot be recalled afterwards.
              description: `About ${cost} ETB, ${segs} message${segs === 1 ? "" : "s"} each. Messages cannot be recalled once sent.`,
              confirmLabel: "Send",
            }, () => send.mutateAsync())}
          >
            <Send className="h-4 w-4" /> Review and send
          </Button>
          {!settings?.enabled && (
            <p className="text-xs text-muted-foreground">Turn sending on under Sending first.</p>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

function AudienceLine({ row, checked, onToggle }: {
  row: AudienceRow; checked: boolean; onToggle: () => void;
}) {
  const blocked = !row.reachable || row.opted_out;
  return (
    <label className={cn("flex flex-wrap items-center gap-2 px-3 py-2 text-sm",
      blocked ? "bg-muted/30" : "cursor-pointer hover:bg-muted/40")}>
      <input type="checkbox" checked={checked} disabled={blocked} onChange={onToggle} />
      <span className={cn("min-w-0 flex-1 truncate", blocked && "text-muted-foreground")}>
        {row.name || "Unnamed"}
        {row.mrn && <span className="ml-2 text-xs text-muted-foreground">{row.mrn}</span>}
      </span>
      {row.owes && Number(row.owes) > 0 && (
        <span className="text-xs tabular-nums text-amber-700">owes {Math.round(Number(row.owes))} ETB</span>
      )}
      {row.opted_out
        ? <Badge variant="outline">Asked not to be messaged</Badge>
        : row.reachable
          ? <span className="text-xs tabular-nums text-muted-foreground">{row.phone}</span>
          : <Badge variant="warning">{ISSUE[row.phone_issue ?? ""] ?? "cannot be reached"}</Badge>}
    </label>
  );
}
