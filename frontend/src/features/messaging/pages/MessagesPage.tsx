// Patient messages — how the clinic talks to people who are not in the building.
//
// Two things had to be true of this screen before anything else could be built on
// it. It must never imply a patient was contacted when they were not: the platform
// can be without credentials, the clinic can have sending switched off, the month's
// allowance can be gone, and each of those looks identical from a patient's side
// (silence) but needs a different action from staff. And it must show what a send
// costs before it happens, because Amharic quietly halves the characters per
// message and a clinic discovers that on its bill rather than on this page.
//
// So: a state banner that says exactly which of those is true, a usage meter in the
// header, and a live segment counter under every box anyone can type into.
import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, CheckCircle2, Clock, MessageSquare, Send, XCircle } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Segmented } from "@/components/ui/segmented";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { toast } from "@/components/ui/sonner";
import { cn } from "@/lib/utils";
import { AppError } from "@/lib/api-client";
import { useAuth } from "@/app/auth-context";
import {
  getMessagingSettings, messageLog, messagingUsage, previewMessage, saveMessagingSettings,
  sendTestMessage, type MessageRow, type MessagingSettings, type MessagingUsage,
} from "@/features/messaging/api";
import { AutomationsTab } from "@/features/messaging/Automations";
import { ComposeTab } from "@/features/messaging/Compose";

export function MessagesPage() {
  const { can } = useAuth();
  const manage = can("message.manage");
  // Automations first: it is what the page is for. Sending is configured once and
  // then rarely touched, so it should not be the thing that greets you every time.
  const [tab, setTab] = useState<"automations" | "compose" | "sending" | "log">("automations");

  const settings = useQuery({ queryKey: ["messaging-settings"], queryFn: getMessagingSettings });
  const usage = useQuery({ queryKey: ["messaging-usage"], queryFn: messagingUsage });

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1>Patient messages</h1>
          <p className="text-sm text-muted-foreground">
            Reminders, bills and greetings, sent by SMS. Every message is recorded here with what it cost.
          </p>
        </div>
        <UsageMeter usage={usage.data} />
      </div>

      <StateBanner settings={settings.data} usage={usage.data} />

      <Segmented
        ariaLabel="Messages"
        value={tab}
        onChange={setTab}
        options={[
          { value: "automations", label: "Automatic messages" },
          { value: "compose", label: "Write to patients" },
          { value: "sending", label: "Sending" },
          { value: "log", label: "Message log" },
        ]}
      />

      {tab === "automations" && <AutomationsTab settings={settings.data} manage={manage} />}
      {tab === "compose" && <ComposeTab settings={settings.data} />}
      {tab === "sending" && <SendingTab settings={settings.data} manage={manage} />}
      {tab === "log" && <LogTab />}
    </div>
  );
}

/**
 * This month's spend against the plan.
 *
 * In segments, not messages, because that is the billed unit — a clinic counting
 * messages against a segment cap would believe it had two or three times the room
 * it really has.
 */
function UsageMeter({ usage }: { usage?: MessagingUsage }) {
  if (!usage) return null;
  const cap = usage.limit;
  const pct = cap && cap > 0 ? Math.min(100, Math.round((usage.used_segments / cap) * 100)) : 0;
  const tone = pct >= 100 ? "bg-destructive" : pct >= 80 ? "bg-amber-500" : "bg-brand";
  return (
    <div className="min-w-56 rounded-lg border bg-card px-4 py-2.5 shadow-sm">
      <div className="flex items-baseline justify-between gap-3 text-sm">
        <span className="whitespace-nowrap font-medium tabular-nums">
          {usage.used_segments.toLocaleString()}
          {cap ? <span className="text-muted-foreground"> / {cap.toLocaleString()}</span> : null}
        </span>
        <span className="text-xs text-muted-foreground">this month</span>
      </div>
      {cap ? (
        <div className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-muted">
          <div className={cn("h-full rounded-full transition-all", tone)} style={{ width: `${pct}%` }} />
        </div>
      ) : (
        <p className="mt-1 text-xs text-muted-foreground">No monthly limit on your plan.</p>
      )}
      <p className="mt-1 text-xs text-muted-foreground">
        {/* Figures hold together; at 360px the line breaks between facts, never inside a number. */}
        <span className="whitespace-nowrap">{usage.sent} sent</span> ·{" "}
        <span className="whitespace-nowrap tabular-nums">{usage.cost} ETB</span>
        {usage.failed > 0 && <span className="whitespace-nowrap text-destructive"> · {usage.failed} failed</span>}
      </p>
    </div>
  );
}

/**
 * Why nothing is going out — stated plainly, with the one thing to do about it.
 *
 * Three different causes produce the same silence, so guessing between them is
 * exactly the work this saves.
 */
function StateBanner({ settings, usage }: { settings?: MessagingSettings; usage?: MessagingUsage }) {
  if (!settings) return null;

  if (!settings.gateway_live) {
    return (
      <Banner tone="danger" icon={XCircle} title="Messaging is not connected">
        This clinic has no SMS account yet, so nothing is being delivered. Queued messages are recorded as
        <b> not sent</b> rather than counted as sent — the log will never claim a patient was contacted when
        they were not. Add the clinic's API key below to connect it.
      </Banner>
    );
  }
  if (!settings.has_own_key) {
    // Live, but on the platform's shared account — which is a Default campaign,
    // reaching only numbers verified in the SMS console and showing a shared
    // number as the sender. Fine for a demo, wrong for patients, and the
    // difference is invisible unless it is said.
    return (
      <Banner tone="warn" icon={AlertTriangle} title="Sending on the shared platform account">
        This clinic has no SMS account of its own, so messages go out under a shared number and only reach
        phone numbers that have been verified in the SMS console. Add the clinic's own API key below before
        messaging real patients.
      </Banner>
    );
  }
  if (settings.sender_status === "pending") {
    return (
      <Banner tone="warn" icon={Clock} title="Waiting for Ethio Telecom to approve the sender name">
        Messages will be refused until <b>{settings.sender_id || settings.sender_name}</b> is approved,
        usually within 1–2 working days. Nothing is broken — this is the approval, not a fault. In the
        meantime patients see the clinic's name written into the message instead.
      </Banner>
    );
  }
  if (settings.sender_status === "rejected") {
    return (
      <Banner tone="danger" icon={XCircle} title="Ethio Telecom rejected the sender name">
        Messages still send, but patients see a shared number with the clinic's name written into the text.
        Register a different sender name in the SMS console to try again.
      </Banner>
    );
  }
  if (!settings.enabled) {
    return (
      <Banner tone="warn" icon={AlertTriangle} title="Sending is switched off">
        Messages can be written and queued, but none will leave the clinic until you turn sending on below.
      </Banner>
    );
  }
  if (usage?.limit && usage.used_segments >= usage.limit) {
    return (
      <Banner tone="danger" icon={XCircle} title="This month's allowance is used up">
        Further messages will be held rather than sent. The allowance resets on the 1st, or your plan can be
        upgraded for more.
      </Banner>
    );
  }
  if (usage?.limit && usage.used_segments >= usage.limit * 0.8) {
    return (
      <Banner tone="warn" icon={AlertTriangle} title="You are near this month's limit">
        {(usage.limit - usage.used_segments).toLocaleString()} messages left of {usage.limit.toLocaleString()}.
      </Banner>
    );
  }
  return (
    <Banner tone="ok" icon={CheckCircle2} title="Sending is on">
      {settings.sender_status === "approved"
        ? <>Patients see <b>{settings.sender_id}</b> on their phone. </>
        : <>Patients see a shared number, so “<b>{settings.sender_name}:</b>” leads every message. </>}
      Quiet between {settings.quiet_from} and {settings.quiet_to}.
    </Banner>
  );
}

function Banner({ tone, icon: Icon, title, children }: {
  tone: "ok" | "warn" | "danger";
  icon: typeof AlertTriangle;
  title: string;
  children: React.ReactNode;
}) {
  const style = {
    ok: "border-emerald-200 bg-emerald-50 text-emerald-900",
    warn: "border-amber-200 bg-amber-50 text-amber-900",
    danger: "border-destructive/30 bg-destructive/5 text-destructive",
  }[tone];
  return (
    <div className={cn("flex items-start gap-3 rounded-lg border px-4 py-3", style)}>
      <Icon className="mt-0.5 h-4 w-4 shrink-0" />
      <div className="min-w-0 text-sm">
        <p className="font-semibold">{title}</p>
        <p className="opacity-90">{children}</p>
      </div>
    </div>
  );
}

// --- Sending -------------------------------------------------------------------

function SendingTab({ settings, manage }: { settings?: MessagingSettings; manage: boolean }) {
  const qc = useQueryClient();
  const [form, setForm] = useState({
    enabled: false, lang: "en", quiet_from: "21:00", quiet_to: "07:00",
    sender_name: "", sender_id: "", sender_status: "none",
  });
  // Held apart from the rest of the form: a blank field must never be read as
  // "delete the stored credential", so it is only sent when someone types one.
  const [apiKey, setApiKey] = useState("");

  useEffect(() => {
    if (!settings) return;
    setForm({
      enabled: settings.enabled, lang: settings.lang, quiet_from: settings.quiet_from,
      quiet_to: settings.quiet_to, sender_name: settings.sender_name,
      sender_id: settings.sender_id ?? "", sender_status: settings.sender_status,
    });
    setApiKey("");
  }, [settings]);

  const save = useMutation({
    mutationFn: () => saveMessagingSettings({ ...form, api_key: apiKey.trim() || undefined }),
    onSuccess: () => {
      toast.success("Sending settings saved");
      setApiKey("");
      qc.invalidateQueries({ queryKey: ["messaging-settings"] });
      qc.invalidateQueries({ queryKey: ["messaging-usage"] });
    },
    onError: (e) => toast.error(e instanceof AppError ? e.message : "Could not save"),
  });

  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <Card className="lg:col-span-2">
        <CardHeader className="pb-3">
          <CardTitle className="text-sm">This clinic's SMS account</CardTitle>
          <CardDescription>
            Each clinic sends through its own account, so patients see this clinic's name on their phone
            rather than a shared number — and each clinic's credit is its own.
          </CardDescription>
        </CardHeader>
        <CardContent className="grid gap-4 md:grid-cols-3">
          <div className="space-y-1.5">
            <Label htmlFor="api-key">API key</Label>
            <Input id="api-key" type="password" autoComplete="off" value={apiKey} disabled={!manage}
              onChange={(e) => setApiKey(e.target.value)}
              placeholder={settings?.has_own_key ? "•••••••• stored — type to replace" : "Paste the 40-character key"} />
            <p className="text-xs text-muted-foreground">
              {settings?.has_own_key
                ? "Stored and encrypted. Leave blank to keep it."
                : "From the SMS console: Console → API Keys."}
            </p>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="sender-id">Sender name patients see</Label>
            <Input id="sender-id" value={form.sender_id} disabled={!manage}
              onChange={(e) => setForm({ ...form, sender_id: e.target.value })} placeholder="CureDental" />
            <p className="text-xs text-muted-foreground">As approved by Ethio Telecom.</p>
          </div>
          <div className="space-y-1.5">
            <Label>Approval</Label>
            <Select value={form.sender_status} onValueChange={(v) => setForm({ ...form, sender_status: v })} disabled={!manage}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="none">Not registered</SelectItem>
                <SelectItem value="pending">Waiting for approval</SelectItem>
                <SelectItem value="approved">Approved</SelectItem>
                <SelectItem value="rejected">Rejected</SelectItem>
              </SelectContent>
            </Select>
            {/* There is no API to ask, so this is recorded by whoever watched the
                console. It exists to answer one question: when everything fails
                with "sender not approved", is this clinic broken or just waiting? */}
            <p className="text-xs text-muted-foreground">Set this from the SMS console — there is no way to check automatically.</p>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-sm">How this clinic sends</CardTitle>
          <CardDescription>
            {settings?.sender_status === "approved"
              ? "Patients see this clinic's own name on their phone, so the message is just the message."
              : "Until the sender name is approved, patients get a shared number — so the clinic's name has to lead the text."}
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <label className="flex cursor-pointer items-start gap-3 rounded-md border p-3">
            <input
              type="checkbox"
              className="mt-0.5"
              checked={form.enabled}
              disabled={!manage}
              onChange={(e) => setForm({ ...form, enabled: e.target.checked })}
            />
            <span className="text-sm">
              <span className="block font-medium">Send messages to patients</span>
              <span className="block text-xs text-muted-foreground">
                The master switch. Off means nothing leaves the clinic, whatever else is configured.
              </span>
            </span>
          </label>

          <div className="space-y-1.5">
            <Label htmlFor="sender">Name inside the message</Label>
            <Input
              id="sender"
              value={form.sender_name}
              maxLength={20}
              disabled={!manage}
              onChange={(e) => setForm({ ...form, sender_name: e.target.value })}
              placeholder="Cure Dental"
            />
            <p className="text-xs text-muted-foreground">
              {settings?.sender_status === "approved"
                ? <>Not used — the phone already shows <b className="text-foreground">{settings.sender_id}</b>, so nothing is added and nothing is charged for it.</>
                : <>Added to the front of every message, and paid for on every message, so keep it short.
                  {form.sender_name && <> Patients see “<b className="text-foreground">{form.sender_name}: …</b>”.</>}</>}
            </p>
          </div>

          <div className="grid gap-3 sm:grid-cols-3">
            <div className="space-y-1.5">
              <Label>Language</Label>
              <Select value={form.lang} onValueChange={(v) => setForm({ ...form, lang: v })} disabled={!manage}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="en">English</SelectItem>
                  <SelectItem value="am">አማርኛ (Amharic)</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="qf">Quiet from</Label>
              <Input id="qf" type="time" value={form.quiet_from} disabled={!manage}
                onChange={(e) => setForm({ ...form, quiet_from: e.target.value })} />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="qt">Quiet until</Label>
              <Input id="qt" type="time" value={form.quiet_to} disabled={!manage}
                onChange={(e) => setForm({ ...form, quiet_to: e.target.value })} />
            </div>
          </div>
          <p className="text-xs text-muted-foreground">
            Reminders and written messages are held during quiet hours until they end — never cancelled.
            A <b>welcome</b> or a <b>test</b> goes straight away whatever the hour: the patient is at the
            desk, or you are watching your own phone for it.
          </p>

          {form.lang === "am" && (
            <p className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-900">
              Amharic fits <b>70 characters</b> per message instead of 160, so the same sentence usually
              costs two or three times as much. The counter below always shows the real number.
            </p>
          )}

          {manage && (
            <Button loading={save.isPending} onClick={() => save.mutate()}>Save settings</Button>
          )}
        </CardContent>
      </Card>

      <TestCard settings={settings} />
    </div>
  );
}

/**
 * Send one to yourself first.
 *
 * The point is not the message, it is the proof: this goes down the same queue,
 * through the same gates, to the same gateway as a real one. If it arrives, the
 * path works — including whether Amharic renders on an actual handset, which is
 * not something anyone should first find out on six hundred patients.
 */
function TestCard({ settings }: { settings?: MessagingSettings }) {
  const qc = useQueryClient();
  const [phone, setPhone] = useState("");
  const [body, setBody] = useState("This is a test message.");

  const preview = useQuery({
    queryKey: ["messaging-preview", body],
    queryFn: () => previewMessage(body),
    enabled: body.trim().length > 0,
  });

  const send = useMutation({
    mutationFn: () => sendTestMessage(phone, body),
    onSuccess: () => {
      toast.success("Queued — it should arrive within a minute");
      qc.invalidateQueries({ queryKey: ["messaging-usage"] });
      qc.invalidateQueries({ queryKey: ["message-log"] });
    },
    onError: (e) => toast.error(e instanceof AppError ? e.message : "Could not queue it"),
  });

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-sm">Send a test</CardTitle>
        <CardDescription>
          Goes down the same path as a real message, and costs the same. Try it in both languages before
          switching anything on.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="space-y-1.5">
          <Label htmlFor="test-phone">Phone number</Label>
          <Input id="test-phone" value={phone} onChange={(e) => setPhone(e.target.value)} placeholder="0911 22 33 44" />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="test-body">Message</Label>
          <Textarea id="test-body" rows={3} value={body} onChange={(e) => setBody(e.target.value)} />
          <SegmentCounter preview={preview.data} cost={settings?.cost_per_segment} />
        </div>
        {preview.data && (
          <div className="rounded-md border bg-muted/40 p-3">
            <p className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
              What the patient sees
            </p>
            <p className="whitespace-pre-wrap text-sm">{preview.data.body}</p>
          </div>
        )}
        <Button
          disabled={!phone.trim() || !body.trim() || !settings?.enabled}
          loading={send.isPending}
          onClick={() => send.mutate()}
        >
          <Send className="h-4 w-4" /> Send test
        </Button>
        {!settings?.enabled && (
          <p className="text-xs text-muted-foreground">Turn sending on first — a test is a real message.</p>
        )}
      </CardContent>
    </Card>
  );
}

/** Length and price, from the server, so the figure shown is the figure charged. */
function SegmentCounter({ preview, cost }: { preview?: { segments: number; unicode: boolean; chars: number; per_segment: number; cost: string }; cost?: number }) {
  if (!preview) return null;
  const many = preview.segments > 1;
  return (
    <p className={cn("text-xs", many ? "font-medium text-amber-700" : "text-muted-foreground")}>
      {preview.chars} characters ·{" "}
      <b>{preview.segments} message{preview.segments === 1 ? "" : "s"}</b>{" "}
      ({preview.per_segment} characters each{preview.unicode ? ", Amharic" : ""})
      {cost ? <> · {preview.cost} ETB</> : null}
    </p>
  );
}

// --- Log -----------------------------------------------------------------------

// What occasion a message was for. Shown in the log because "did the reminders go
// out?" is a different question from "did anything go out?".
const KIND_LABEL: Record<string, string> = {
  welcome: "Welcome",
  appointment_reminder: "Reminder",
  bill_reminder: "Bill",
  custom: "Written",
};

const STATUS: Record<string, { label: string; variant: "success" | "warning" | "destructive" | "outline" }> = {
  // Two words on purpose. "Sent" is all the gateway promises on acceptance;
  // "Delivered" is a handset confirming, which arrives later or not at all.
  delivered: { label: "Delivered", variant: "success" },
  sent: { label: "Sent", variant: "warning" },
  scheduled: { label: "Queued", variant: "warning" },
  sending: { label: "Sending", variant: "warning" },
  failed: { label: "Failed", variant: "destructive" },
  skipped: { label: "Not sent", variant: "outline" },
  cancelled: { label: "Cancelled", variant: "outline" },
};

// Why a message never went. Written as the sentence a receptionist needs, not as
// the enum the database stores.
const SKIP_REASON: Record<string, string> = {
  not_configured: "no SMS account is connected",
  unsupported_network: "this gateway only reaches Ethio Telecom numbers (09…)",
  sending_off: "sending was switched off",
  quota: "the monthly allowance was used up",
  no_phone: "no phone number on file",
  bad_phone: "the number on file is not a mobile",
  no_consent: "this patient asked not to be messaged",
  duplicate: "already sent",
};

function LogTab() {
  const [status, setStatus] = useState("");
  const log = useQuery({
    queryKey: ["message-log", status],
    queryFn: () => messageLog({ status: status || undefined }),
    refetchInterval: 15_000, // queued rows turn into sent ones while you watch
  });

  const rows = log.data ?? [];
  return (
    <Card className="overflow-hidden">
      <CardHeader className="flex flex-row flex-wrap items-center justify-between gap-3 pb-3">
        <div>
          <CardTitle className="text-sm">Message log</CardTitle>
          <CardDescription>Everything sent, held or refused — newest first.</CardDescription>
        </div>
        <Select value={status || "all"} onValueChange={(v) => setStatus(v === "all" ? "" : v)}>
          <SelectTrigger className="w-44"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All messages</SelectItem>
            <SelectItem value="delivered">Delivered</SelectItem>
            <SelectItem value="sent">Sent, not yet confirmed</SelectItem>
            <SelectItem value="scheduled">Queued</SelectItem>
            <SelectItem value="failed">Failed</SelectItem>
            <SelectItem value="skipped">Not sent</SelectItem>
          </SelectContent>
        </Select>
      </CardHeader>
      <CardContent className="p-0">
        {rows.length === 0 ? (
          <div className="py-14 text-center">
            <MessageSquare className="mx-auto h-8 w-8 text-muted-foreground/40" />
            <p className="mt-2 text-sm text-muted-foreground">
              Nothing sent yet. Send a test from the Sending tab to check it works.
            </p>
          </div>
        ) : (
          <div className="divide-y">
            {rows.map((r) => <LogRow key={r.id} row={r} />)}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function LogRow({ row }: { row: MessageRow }) {
  const meta = STATUS[row.status] ?? { label: row.status, variant: "outline" as const };
  const when = row.delivered_at ?? row.sent_at ?? row.scheduled_for ?? row.created_at;
  return (
    <div className="flex flex-wrap items-start gap-x-3 gap-y-1.5 px-4 py-3 text-sm hover:bg-muted/30">
      <Badge variant={meta.variant}>{meta.label}</Badge>
      <div className="min-w-0 flex-1">
        <p className="truncate">
          <span className="mr-2 rounded bg-muted px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-muted-foreground">
            {KIND_LABEL[row.kind] ?? row.kind}
          </span>
          {row.body}
        </p>
        <p className="text-xs text-muted-foreground">
          {/* No patient means a test or an ad-hoc send; the number identifies it,
              so say nothing rather than guessing which one it was. */}
          {row.patient_name && <span className="font-medium text-foreground">{row.patient_name}</span>}
          {row.mrn && <> · {row.mrn}</>}
          {row.msisdn && <>{row.patient_name ? " · " : ""}{row.msisdn}</>}
          {" · "}
          {/* Timestamps and money never wrap mid-figure — the row breaks between facts instead. */}
          <span className="whitespace-nowrap">{new Date(when).toLocaleString()}</span>
          {" · "}
          <span className="whitespace-nowrap tabular-nums">
            {row.segments} msg{row.segments === 1 ? "" : "s"}, {row.cost} ETB
          </span>
        </p>
        {row.status === "skipped" && row.skip_reason && (
          <p className="mt-0.5 text-xs text-amber-700">
            Not sent — {SKIP_REASON[row.skip_reason] ?? row.skip_reason}.
          </p>
        )}
        {row.status === "failed" && row.last_error && (
          <p className="mt-0.5 text-xs text-destructive">Failed — {row.last_error}</p>
        )}
        {row.status === "sent" && (
          <p className="mt-0.5 text-xs text-muted-foreground">
            The network accepted it. Waiting for the handset to confirm.
          </p>
        )}
        {row.status === "scheduled" && (
          <p className="mt-0.5 flex items-center gap-1 text-xs text-muted-foreground">
            <Clock className="h-3 w-3" /> Waiting to send at {new Date(row.scheduled_for).toLocaleString()}
          </p>
        )}
      </div>
    </div>
  );
}
