// Reminding patients about treatment they were given and never billed for.
//
// The unbilled page knows exactly who owes, for which course, which visit, and how
// much — this dialog turns that knowledge into the SMS. The wording is editable,
// but every number in it is filled by the server from the ledger at that moment:
// the desk approves the actual rendered messages, per patient, with the total cost
// in front of them, before anything is spent.
//
// Two guard rails matter more than the happy path. A patient whose rows were
// selected twice still gets ONE message (the server groups by patient). And a
// patient who was already chased recently is flagged with "reminded N days ago" —
// the feature exists to recover money, not to train patients to ignore the clinic.
import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, Send } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { toast } from "@/components/ui/sonner";
import { cn } from "@/lib/utils";
import { AppError } from "@/lib/api-client";
import { useDebounce } from "@/hooks/useDebounce";
import {
  getMessagingSettings, unbilledReminders, type UnbilledRemindRow,
} from "@/features/messaging/api";

// The wording every clinic starts from — the four facts the reminder exists to
// carry: which treatment, which visit, what was paid, what remains. The Amharic
// version is written to the 70-character segment budget, not translated word for
// word from the comfortable English sentence.
const DEFAULT_BODY: Record<string, string> = {
  en: "Dear {{name}}, for your {{treatment}} (visit {{visit}}) you have paid {{paid}} ETB — {{amount}} ETB is still due. Please settle it at your next visit.",
  am: "ውድ {{name}}፣ ለ{{treatment}} ({{visit}}) የከፈሉት {{paid}} ብር ነው፤ ቀሪ {{amount}} ብር አለ። እባክዎ ይክፈሉ።",
};

const CHIPS = ["name", "treatment", "visit", "paid", "amount", "card", "days", "clinic"];

const SKIP_LABEL: Record<string, string> = {
  no_phone: "no phone number on file",
  bad_phone: "number is not a valid mobile",
  unsupported_network: "not an Ethio Telecom number",
  no_consent: "asked not to be messaged",
};

export function UnbilledRemindDialog({ sessionIds, onClose, onSent }: {
  /** The selected unbilled rows (tss_… ids). The server regroups them by patient. */
  sessionIds: string[];
  onClose: () => void;
  onSent: () => void;
}) {
  const qc = useQueryClient();
  const settings = useQuery({ queryKey: ["messaging-settings"], queryFn: getMessagingSettings });
  const [body, setBody] = useState("");

  // Seed the wording once the clinic's language is known; never stomp an edit.
  useEffect(() => {
    if (settings.data && body === "") {
      setBody(DEFAULT_BODY[settings.data.lang] ?? DEFAULT_BODY.en);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [settings.data]);

  const debounced = useDebounce(body, 400);
  const preview = useQuery({
    queryKey: ["unbilled-remind-preview", sessionIds.join(","), debounced],
    queryFn: () => unbilledReminders({ session_ids: sessionIds, body: debounced, preview: true }),
    enabled: debounced.trim().length > 0 && sessionIds.length > 0,
  });

  const send = useMutation({
    mutationFn: () => unbilledReminders({ session_ids: sessionIds, body }),
    onSuccess: (res) => {
      toast.success(`${res.queued} reminder${res.queued === 1 ? "" : "s"} queued · ${res.cost} ETB`);
      qc.invalidateQueries({ queryKey: ["messaging-usage"] });
      qc.invalidateQueries({ queryKey: ["message-log"] });
      onSent();
    },
    onError: (e) => toast.error(e instanceof AppError ? e.message : "Could not send the reminders"),
  });

  const rows = useMemo(() => preview.data?.rows ?? [], [preview.data]);
  const reachable = useMemo(() => rows.filter((r) => !r.skip_reason), [rows]);
  const recentlyReminded = useMemo(
    () => reachable.filter((r) => r.last_reminded_at && daysAgo(r.last_reminded_at) <= 7),
    [reachable],
  );
  const sendingOff = settings.data && !settings.data.enabled;

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent fullOnMobile className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>Remind about unpaid treatment</DialogTitle>
        </DialogHeader>

        {sendingOff && (
          <p className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900">
            Sending is switched off under Patient messages — you can preview here, but nothing will go out
            until it is turned on.
          </p>
        )}

        <div className="space-y-1.5">
          <Label htmlFor="remind-body">Message</Label>
          <Textarea id="remind-body" rows={3} value={body} onChange={(e) => setBody(e.target.value)} />
          <div className="flex flex-wrap gap-1.5">
            {CHIPS.map((v) => (
              <button key={v} type="button" onClick={() => setBody((b) => `${b}{{${v}}}`)}
                className="rounded-full border px-2 py-0.5 text-[11px] font-medium hover:bg-muted">
                {`{{${v}}}`}
              </button>
            ))}
          </div>
          <p className="text-xs text-muted-foreground">
            The blanks are filled per patient from the ledger — treatment, visit, paid and owed are theirs,
            not an average.
          </p>
        </div>

        {/* What will actually be sent, patient by patient. Approving a template
            with the blanks still in it is not approving anything. */}
        <div className="space-y-1.5">
          <Label>
            Each patient receives
            {rows.length > 0 && (
              <span className="ml-2 font-normal text-muted-foreground">
                {reachable.length} of {rows.length} reachable
              </span>
            )}
          </Label>
          <div className="max-h-64 space-y-2 overflow-y-auto rounded-md border p-2">
            {preview.isLoading && <p className="py-4 text-center text-sm text-muted-foreground">Working it out…</p>}
            {!preview.isLoading && rows.length === 0 && (
              <p className="py-4 text-center text-sm text-muted-foreground">Nothing to preview.</p>
            )}
            {rows.map((r) => <PreviewRow key={r.patient_id} row={r} />)}
          </div>
          {recentlyReminded.length > 0 && (
            <p className="flex items-start gap-1.5 text-xs text-amber-700">
              <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
              {recentlyReminded.length === 1
                ? `${recentlyReminded[0].patient_name || "One patient"} was already reminded this week — they will be messaged again.`
                : `${recentlyReminded.length} of these patients were already reminded this week — they will be messaged again.`}
            </p>
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={onClose}>Cancel</Button>
          <Button
            disabled={reachable.length === 0 || !!sendingOff || send.isPending}
            loading={send.isPending}
            onClick={() => send.mutate()}
          >
            <Send className="h-4 w-4" />
            Send {reachable.length} reminder{reachable.length === 1 ? "" : "s"}
            {preview.data ? ` · ${preview.data.cost} ETB` : ""}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function PreviewRow({ row }: { row: UnbilledRemindRow }) {
  const skipped = !!row.skip_reason;
  return (
    <div className={cn("rounded-md border px-2.5 py-2 text-sm", skipped && "bg-muted/40")}>
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-medium">{row.patient_name || "Patient"}</span>
        <span className="text-xs text-muted-foreground">{row.mrn}</span>
        {skipped ? (
          <Badge variant="warning">{SKIP_LABEL[row.skip_reason!] ?? "cannot be reached"}</Badge>
        ) : (
          <span className="ml-auto text-xs tabular-nums text-muted-foreground">
            {row.segments} msg{row.segments === 1 ? "" : "s"} · {row.cost} ETB
          </span>
        )}
        {row.last_reminded_at && !skipped && (
          <Badge variant="outline">reminded {daysAgo(row.last_reminded_at)}d ago</Badge>
        )}
      </div>
      {!skipped && <p className="mt-1 whitespace-pre-wrap text-xs text-muted-foreground">{row.body}</p>}
    </div>
  );
}

function daysAgo(iso: string) {
  return Math.max(0, Math.floor((Date.now() - new Date(iso).getTime()) / 86_400_000));
}
