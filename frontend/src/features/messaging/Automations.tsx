// The three messages a clinic sends without being asked, and the wording for each.
//
// Each one is a switch and a sentence, kept together: the decision "should we
// remind people about appointments?" is inseparable from "and what would it say?",
// and splitting them across two screens is how a clinic ends up with an automation
// switched on and nobody sure what it tells patients.
//
// Every automation is off until someone turns it on. It spends the clinic's money
// and writes to its patients, which is not a thing to discover by accident.
import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { CalendarClock, ChevronDown, HandCoins, UserPlus } from "lucide-react";

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
import {
  listRules, listTemplates, messageVariables, saveRule, saveTemplate,
  type MessageRule, type MessageTemplate, type MessagingSettings,
} from "@/features/messaging/api";

const KINDS = [
  {
    kind: "welcome" as const,
    icon: UserPlus,
    title: "Welcome and card number",
    what: "Sent the moment a patient is registered, so they leave with their card number on their phone.",
    timing: "immediate" as const,
  },
  {
    kind: "appointment_reminder" as const,
    icon: CalendarClock,
    title: "Appointment reminder",
    what: "Sent before a booked appointment. This is the one that changes whether people turn up.",
    timing: "before" as const,
  },
  {
    kind: "bill_reminder" as const,
    icon: HandCoins,
    title: "Unpaid bill reminder",
    what: "Sent when a bill has gone unpaid, and again if it stays that way. Stops as soon as the patient pays.",
    timing: "after" as const,
  },
];

export function AutomationsTab({ settings, manage }: { settings?: MessagingSettings; manage: boolean }) {
  const rules = useQuery({ queryKey: ["message-rules"], queryFn: listRules });
  const templates = useQuery({ queryKey: ["message-templates"], queryFn: listTemplates });
  const vars = useQuery({ queryKey: ["message-variables"], queryFn: messageVariables });
  const [open, setOpen] = useState<string | null>(null);

  const lang = settings?.lang ?? "en";

  return (
    <div className="space-y-3">
      {KINDS.map((k) => (
        <AutomationCard
          key={k.kind}
          meta={k}
          rule={rules.data?.find((r) => r.kind === k.kind)}
          template={templates.data?.find((t) => t.kind === k.kind && t.lang === lang)}
          lang={lang}
          variables={vars.data ?? []}
          manage={manage}
          expanded={open === k.kind}
          onToggleOpen={() => setOpen(open === k.kind ? null : k.kind)}
        />
      ))}
      <p className="px-1 text-xs text-muted-foreground">
        Wording is per language. You are editing the <b>{lang === "am" ? "Amharic" : "English"}</b> version
        because that is what this clinic sends — change the language under Sending to edit the other.
      </p>
    </div>
  );
}

function AutomationCard({ meta, rule, template, lang, variables, manage, expanded, onToggleOpen }: {
  meta: typeof KINDS[number];
  rule?: MessageRule;
  template?: MessageTemplate;
  lang: string;
  variables: { name: string; describes: string }[];
  manage: boolean;
  expanded: boolean;
  onToggleOpen: () => void;
}) {
  const qc = useQueryClient();
  const Icon = meta.icon;
  const [body, setBody] = useState("");
  const [form, setForm] = useState({ offset: 24, send_at: "", repeat_days: 7, max_repeats: 1 });

  useEffect(() => { setBody(template?.body ?? ""); }, [template?.body]);
  useEffect(() => {
    if (!rule) return;
    setForm({
      // Stored signed (negative = before), shown as a plain number of hours with
      // the direction carried by the label — nobody thinks in negative hours.
      offset: Math.abs(rule.offset_hours),
      send_at: rule.send_at ?? "",
      repeat_days: rule.repeat_days || 7,
      max_repeats: rule.max_repeats,
    });
  }, [rule]);

  const persistRule = useMutation({
    mutationFn: (over: Partial<{ enabled: boolean }>) => saveRule({
      kind: meta.kind,
      enabled: over.enabled ?? rule?.enabled ?? false,
      offset_hours: meta.timing === "immediate" ? 0
        : meta.timing === "before" ? -Math.abs(form.offset) : Math.abs(form.offset),
      send_at: meta.timing === "immediate" ? "" : form.send_at,
      repeat_days: meta.timing === "after" ? form.repeat_days : 0,
      max_repeats: meta.timing === "after" ? form.max_repeats : 0,
    }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["message-rules"] });
      qc.invalidateQueries({ queryKey: ["messaging-usage"] });
    },
    onError: (e) => toast.error(e instanceof AppError ? e.message : "Could not save"),
  });

  const persistBody = useMutation({
    mutationFn: () => saveTemplate({ kind: meta.kind, lang, body }),
    onSuccess: () => {
      toast.success("Wording saved");
      qc.invalidateQueries({ queryKey: ["message-templates"] });
    },
    onError: (e) => toast.error(e instanceof AppError ? e.message : "Could not save the wording"),
  });

  const on = rule?.enabled ?? false;
  const dirty = body.trim() !== (template?.body ?? "").trim();

  return (
    <Card className={cn(on && "border-brand/40")}>
      <CardHeader className="pb-3">
        <div className="flex flex-wrap items-start gap-3">
          <span className={cn("mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-full",
            on ? "bg-brand/10 text-brand" : "bg-muted text-muted-foreground")}>
            <Icon className="h-4 w-4" />
          </span>
          <div className="min-w-0 flex-1">
            <CardTitle className="flex flex-wrap items-center gap-2 text-sm">
              {meta.title}
              {on
                ? <Badge variant="success">On</Badge>
                : <Badge variant="outline">Off</Badge>}
              {rule && rule.sent > 0 && (
                <span className="text-xs font-normal text-muted-foreground">{rule.sent} sent this month</span>
              )}
            </CardTitle>
            <CardDescription>{meta.what}</CardDescription>
            <p className="mt-1 text-xs text-muted-foreground">{whenLabel(meta.timing, rule)}</p>
          </div>
          <div className="flex items-center gap-2">
            {manage && (
              <Button
                size="sm"
                variant={on ? "outline" : "default"}
                loading={persistRule.isPending}
                onClick={() => persistRule.mutate({ enabled: !on })}
              >
                {on ? "Turn off" : "Turn on"}
              </Button>
            )}
            <Button size="sm" variant="ghost" onClick={onToggleOpen} aria-expanded={expanded}>
              <ChevronDown className={cn("h-4 w-4 transition-transform", expanded && "rotate-180")} />
              {expanded ? "Hide" : "Edit"}
            </Button>
          </div>
        </div>
      </CardHeader>

      {expanded && (
        <CardContent className="space-y-4 border-t pt-4">
          {meta.timing !== "immediate" && (
            <div className="grid gap-3 sm:grid-cols-4">
              <div className="space-y-1.5">
                <Label htmlFor={`off-${meta.kind}`}>
                  {meta.timing === "before" ? "Hours before" : "Hours after the bill"}
                </Label>
                <Input id={`off-${meta.kind}`} type="number" min={1} max={336} value={form.offset}
                  disabled={!manage}
                  onChange={(e) => setForm({ ...form, offset: Number(e.target.value) || 1 })} />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor={`at-${meta.kind}`}>Send at</Label>
                <Input id={`at-${meta.kind}`} type="time" value={form.send_at} disabled={!manage}
                  onChange={(e) => setForm({ ...form, send_at: e.target.value })} />
              </div>
              {meta.timing === "after" && (
                <>
                  <div className="space-y-1.5">
                    <Label htmlFor={`rd-${meta.kind}`}>Repeat every (days)</Label>
                    <Input id={`rd-${meta.kind}`} type="number" min={1} max={90} value={form.repeat_days}
                      disabled={!manage}
                      onChange={(e) => setForm({ ...form, repeat_days: Number(e.target.value) || 1 })} />
                  </div>
                  <div className="space-y-1.5">
                    <Label>Repeat how many times</Label>
                    <Select value={String(form.max_repeats)} disabled={!manage}
                      onValueChange={(v) => setForm({ ...form, max_repeats: Number(v) })}>
                      <SelectTrigger><SelectValue /></SelectTrigger>
                      <SelectContent>
                        {[0, 1, 2, 3].map((n) => (
                          <SelectItem key={n} value={String(n)}>{n === 0 ? "Once only" : `${n} more`}</SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                </>
              )}
            </div>
          )}

          <div className="space-y-1.5">
            <Label htmlFor={`body-${meta.kind}`}>
              What it says {lang === "am" ? "(Amharic)" : "(English)"}
            </Label>
            <Textarea id={`body-${meta.kind}`} rows={3} value={body} disabled={!manage}
              onChange={(e) => setBody(e.target.value)} />
            {manage && (
              <div className="flex flex-wrap gap-1.5 pt-0.5">
                {variables.map((v) => (
                  <button key={v.name} type="button" title={v.describes}
                    onClick={() => setBody((b) => `${b}{{${v.name}}}`)}
                    className="rounded-full border px-2 py-0.5 text-[11px] font-medium hover:bg-muted">
                    {`{{${v.name}}}`}
                  </button>
                ))}
              </div>
            )}
          </div>

          {template && (
            <div className="rounded-md border bg-muted/40 p-3">
              <p className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                What a patient sees
              </p>
              <p className="whitespace-pre-wrap text-sm">{template.preview}</p>
              <p className={cn("mt-1.5 text-xs", template.segments > 1 ? "font-medium text-amber-700" : "text-muted-foreground")}>
                {template.segments} message{template.segments === 1 ? "" : "s"}
                {template.unicode ? " (Amharic, 70 characters each)" : " (160 characters each)"} · {template.cost} ETB each time
              </p>
            </div>
          )}

          {manage && (
            <div className="flex flex-wrap gap-2">
              <Button size="sm" disabled={!dirty} loading={persistBody.isPending}
                onClick={() => persistBody.mutate()}>
                Save wording
              </Button>
              {meta.timing !== "immediate" && (
                <Button size="sm" variant="outline" loading={persistRule.isPending}
                  onClick={() => persistRule.mutate({})}>
                  Save timing
                </Button>
              )}
              {dirty && <span className="self-center text-xs text-amber-700">Unsaved changes to the wording.</span>}
            </div>
          )}
        </CardContent>
      )}
    </Card>
  );
}

/** The timing, in a sentence — "24 hours before, at 18:00" beats "-24 / 18:00". */
function whenLabel(timing: "immediate" | "before" | "after", rule?: MessageRule) {
  if (!rule) return "";
  if (timing === "immediate") return "Sent straight away, when the patient is registered.";
  const h = Math.abs(rule.offset_hours);
  const when = h % 24 === 0 ? `${h / 24} day${h === 24 ? "" : "s"}` : `${h} hours`;
  const at = rule.send_at ? `, at ${rule.send_at}` : "";
  if (timing === "before") return `Sent ${when} before the appointment${at}.`;
  const rep = rule.max_repeats > 0
    ? `, then every ${rule.repeat_days} days up to ${rule.max_repeats} more time${rule.max_repeats === 1 ? "" : "s"}`
    : ", once only";
  return `Sent ${when} after the bill appears${at}${rep}.`;
}
