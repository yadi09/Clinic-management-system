// What this clinic has said to this patient.
//
// Built after a real incident: a patient was registered at 9:38pm, the welcome SMS
// was correctly queued and correctly held until quiet hours ended, and nobody could
// see any of that. The patient said "I got nothing", the clinic looked at the
// patient's page, found no mention of messages at all, and concluded the feature
// was broken. It was working — it just had no window.
//
// The clinic-wide log answers "did anything go out?". This answers the question
// actually asked at the desk, which is "did *she* get hers?" — and, when the answer
// is no, says which of the several possible reasons applies.
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Clock, MessageSquare, RotateCw, Send } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { toast } from "@/components/ui/sonner";
import { AppError } from "@/lib/api-client";
import { useAuth } from "@/app/auth-context";
import {
  messageLog, resendMessage, sendMessageNow, type MessageRow,
} from "@/features/messaging/api";

const KIND: Record<string, string> = {
  welcome: "Welcome",
  appointment_reminder: "Appointment reminder",
  bill_reminder: "Unpaid bill",
  custom: "Written by staff",
};

const STATUS: Record<string, { label: string; variant: "success" | "warning" | "destructive" | "outline" }> = {
  delivered: { label: "Delivered", variant: "success" },
  sent: { label: "Sent", variant: "warning" },
  scheduled: { label: "Waiting", variant: "warning" },
  sending: { label: "Sending", variant: "warning" },
  failed: { label: "Failed", variant: "destructive" },
  skipped: { label: "Not sent", variant: "outline" },
  cancelled: { label: "Cancelled", variant: "outline" },
};

// The reasons, written as the sentence the person at the desk needs to hear —
// each one implies a different next action.
const WHY: Record<string, string> = {
  not_configured: "this clinic has no SMS account connected",
  sending_off: "messaging was switched off at the time",
  quota: "the month's message allowance was used up",
  no_phone: "there is no phone number on this patient's record",
  bad_phone: "the number on file is not a valid mobile",
  unsupported_network: "the number is not an Ethio Telecom number, which is all this gateway reaches",
  no_consent: "this patient asked not to be messaged",
  duplicate: "it had already been sent",
};

export function PatientMessages({ patientId }: { patientId: string }) {
  const { can } = useAuth();
  const qc = useQueryClient();
  const canSend = can("message.send") || can("message.manage");
  const refresh = () => {
    qc.invalidateQueries({ queryKey: ["message-log"] });
    qc.invalidateQueries({ queryKey: ["messaging-usage"] });
  };

  const log = useQuery({
    queryKey: ["message-log", "patient", patientId],
    queryFn: () => messageLog({ patient: patientId }),
    // Something queued minutes ago becomes sent while the page is open.
    refetchInterval: 20_000,
  });

  const rows = log.data ?? [];
  if (log.isLoading) {
    return <p className="py-6 text-center text-sm text-muted-foreground">Loading…</p>;
  }
  if (rows.length === 0) {
    return (
      <div className="py-10 text-center">
        <MessageSquare className="mx-auto h-7 w-7 text-muted-foreground/40" />
        <p className="mt-2 text-sm text-muted-foreground">
          Nothing has been sent to this patient.
        </p>
        <p className="text-xs text-muted-foreground">
          Automatic messages are set up under Patient messages.
        </p>
      </div>
    );
  }

  const stuck = rows.filter((r) => r.status === "failed" || r.status === "skipped").length;

  return (
    <div className="space-y-2">
      {/* Said once at the top rather than repeated on every row: the common case
          is several messages failing for the same reason, and the useful summary
          is how many people were not reached. */}
      {stuck > 0 && (
        <p className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-900">
          {stuck} message{stuck === 1 ? "" : "s"} never reached this patient. Fix what each one names below,
          then send it again — a retry re-reads the phone number from their record.
        </p>
      )}
      {rows.map((r) => <Row key={r.id} row={r} canSend={canSend} onDone={refresh} />)}
    </div>
  );
}

function Row({ row, canSend, onDone }: {
  row: MessageRow; canSend: boolean; onDone: () => void;
}) {
  const meta = STATUS[row.status] ?? { label: row.status, variant: "outline" as const };
  const when = row.delivered_at ?? row.sent_at ?? row.created_at;

  const resend = useMutation({
    mutationFn: () => resendMessage(row.id),
    onSuccess: () => { toast.success("Queued to send again"); onDone(); },
    onError: (e) => toast.error(e instanceof AppError ? e.message : "Could not send it again"),
  });
  const now = useMutation({
    mutationFn: () => sendMessageNow(row.id),
    onSuccess: () => { toast.success("Sending now"); onDone(); },
    onError: (e) => toast.error(e instanceof AppError ? e.message : "Could not send it now"),
  });
  return (
    <div className="rounded-md border bg-background px-3 py-2.5 text-sm">
      <div className="flex flex-wrap items-center gap-2">
        <Badge variant={meta.variant}>{meta.label}</Badge>
        <span className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
          {KIND[row.kind] ?? row.kind}
        </span>
        <span className="ml-auto text-xs text-muted-foreground">
          {new Date(when).toLocaleString()}
        </span>
      </div>
      <p className="mt-1.5 whitespace-pre-wrap">{row.body}</p>
      <p className="mt-1 text-xs text-muted-foreground">
        {row.msisdn || "no number"} · {row.segments} message{row.segments === 1 ? "" : "s"} · {row.cost} ETB
      </p>

      {/* The status alone is not an answer. Each of these is a different thing to
          do next, and guessing between them is the work this saves. */}
      {row.status === "scheduled" && (
        <p className="mt-1 flex items-center gap-1 text-xs text-amber-700">
          <Clock className="h-3 w-3" />
          Waiting until {new Date(row.scheduled_for).toLocaleString()} — outside the clinic's quiet hours.
        </p>
      )}
      {row.status === "sent" && (
        <p className="mt-1 text-xs text-muted-foreground">
          The network accepted it; waiting for the handset to confirm.
        </p>
      )}
      {row.status === "skipped" && row.skip_reason && (
        <p className="mt-1 text-xs text-amber-700">
          Not sent — {WHY[row.skip_reason] ?? row.skip_reason}.
        </p>
      )}
      {row.status === "failed" && row.last_error && (
        <p className="mt-1 text-xs text-destructive">Failed — {row.last_error}</p>
      )}

      {canSend && (row.can_resend || row.can_send_now) && (
        <div className="mt-2 flex flex-wrap items-center gap-2">
          {row.can_send_now && (
            <Button size="sm" variant="outline" className="h-7 px-2 text-xs"
              loading={now.isPending} onClick={() => now.mutate()}>
              <Send className="h-3.5 w-3.5" /> Send now
            </Button>
          )}
          {row.can_resend && !row.retried && (
            <Button size="sm" variant="outline" className="h-7 px-2 text-xs"
              loading={resend.isPending} onClick={() => resend.mutate()}>
              <RotateCw className="h-3.5 w-3.5" />
              {row.status === "delivered" || row.status === "sent" ? "Send again" : "Try again"}
            </Button>
          )}
          {/* A message that has already been retried keeps the record but stops
              offering a button somebody has pressed — the newer attempt is the
              row above, with its own outcome. */}
          {row.retried && (
            <span className="text-xs text-muted-foreground">Tried again — see the newer attempt above.</span>
          )}
          {row.can_resend && !row.retried && (
            <span className="text-xs text-muted-foreground">
              Costs {row.cost} ETB and re-reads the number from this patient&apos;s record.
            </span>
          )}
        </div>
      )}
    </div>
  );
}
