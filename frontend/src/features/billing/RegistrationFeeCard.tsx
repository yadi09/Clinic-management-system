// Settings → Visit flow → Registration fee (FEAT-REG-1).
//
// How often a patient pays this clinic's registration fee: on every visit, one time
// only, or again after a period the clinic chooses (a week, 30 days, two months…).
// The rule applies to every patient of the clinic, at every arrival.
import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { toast } from "@/components/ui/sonner";
import { AppError } from "@/lib/api-client";
import { cn } from "@/lib/utils";
import {
  getRegistrationPolicy, listServices, saveRegistrationPolicy,
  type RegistrationPolicy, type RegistrationRule, type RegistrationUnit, type ServiceItem,
} from "@/features/billing/api";
import { describeRule, period } from "@/features/billing/registration";

const RULES: { value: RegistrationRule; label: string; hint: string }[] = [
  { value: "every_visit", label: "Every visit", hint: "Charged each day the patient comes." },
  { value: "once", label: "One time only", hint: "Charged at the first visit, never again." },
  { value: "every", label: "Again after a period", hint: "Charged again once the period you choose has passed." },
];

const PRESETS: { count: number; unit: RegistrationUnit }[] = [
  { count: 7, unit: "day" }, { count: 30, unit: "day" }, { count: 2, unit: "month" },
  { count: 6, unit: "month" }, { count: 12, unit: "month" },
];

export function RegistrationFeeCard({ manage }: { manage: boolean }) {
  const qc = useQueryClient();
  const policy = useQuery({ queryKey: ["registration-policy"], queryFn: getRegistrationPolicy });
  const services = useQuery({ queryKey: ["services"], queryFn: () => listServices() });
  const arrivalFees = useMemo(
    () => (services.data ?? []).filter((s: ServiceItem) => s.is_default && s.is_active),
    [services.data],
  );

  const [form, setForm] = useState<RegistrationPolicy | null>(null);
  useEffect(() => {
    if (policy.data) setForm(policy.data);
  }, [policy.data]);

  const save = useMutation({
    mutationFn: (p: RegistrationPolicy) => saveRegistrationPolicy(p),
    onSuccess: (p) => {
      toast.success("Registration fee rule saved");
      qc.setQueryData(["registration-policy"], p);
    },
    onError: (e) => toast.error(e instanceof AppError ? e.message : "Could not save the registration fee rule"),
  });

  if (!form || services.isLoading) {
    return (
      <Card>
        <CardHeader><CardTitle>Registration fee</CardTitle></CardHeader>
        <CardContent>
          <p className="text-sm text-muted-foreground">
            {policy.isError || services.isError ? "Couldn't load the registration fee rule." : "Loading…"}
          </p>
        </CardContent>
      </Card>
    );
  }

  const set = (patch: Partial<RegistrationPolicy>) => setForm((f) => (f ? { ...f, ...patch } : f));
  const fee = arrivalFees.find((s) => s.id === form.service_id);
  const feeName = fee ? `${fee.name} (${Number(fee.price).toLocaleString()} birr)` : "the registration fee";
  const needsFee = form.rule !== "every_visit" && !fee;
  const needsPeriod = form.rule === "every" && !(form.every_count && form.every_count >= 1 && form.every_unit);
  const disabled = !manage;

  return (
    <Card>
      <CardHeader>
        <CardTitle>Registration fee</CardTitle>
        <CardDescription>
          How often a patient pays registration. The rule applies to every patient of this clinic. Other fees charged
          on arrival, such as a consultation, are charged every visit as before.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-5">
        {arrivalFees.length === 0 ? (
          <p className="rounded-md border border-dashed px-3 py-2 text-sm text-muted-foreground">
            No fee is charged when a patient arrives yet. In <span className="font-medium text-foreground">Billing → Service catalog</span>,
            add your registration fee and mark it <span className="font-medium text-foreground">Default</span>, then come back here.
          </p>
        ) : (
          <div className="space-y-1.5">
            <Label htmlFor="reg-fee">Which fee is the registration fee?</Label>
            <Select value={form.service_id ?? ""} onValueChange={(v) => set({ service_id: v })} disabled={disabled}>
              <SelectTrigger id="reg-fee" aria-label="Registration fee"><SelectValue placeholder="Choose the registration fee" /></SelectTrigger>
              <SelectContent>
                {arrivalFees.map((s) => (
                  <SelectItem key={s.id} value={s.id}>{s.name} · {Number(s.price).toLocaleString()} birr</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        )}

        <fieldset className="space-y-2" disabled={disabled}>
          <legend className="mb-1 text-sm font-medium">How often does a patient pay it?</legend>
          <div className="grid gap-2 sm:grid-cols-3">
            {RULES.map((r) => (
              <label key={r.value}
                className={cn("flex cursor-pointer flex-col rounded-md border px-3 py-2 text-sm",
                  form.rule === r.value ? "border-primary bg-primary/5" : "hover:bg-muted/50")}>
                <span className="flex items-center gap-2 font-medium">
                  <input type="radio" name="reg-rule" value={r.value} checked={form.rule === r.value}
                    onChange={() => set(r.value === "every"
                      ? { rule: r.value, every_count: form.every_count ?? 30, every_unit: form.every_unit || "day" }
                      : { rule: r.value, every_count: null, every_unit: "" })} />
                  {r.label}
                </span>
                <span className="mt-0.5 text-xs text-muted-foreground">{r.hint}</span>
              </label>
            ))}
          </div>
        </fieldset>

        {form.rule === "every" && (
          <div className="space-y-2">
            <Label htmlFor="reg-count">Pay again after</Label>
            <div className="flex flex-wrap items-center gap-2">
              <Input id="reg-count" type="number" min={1} max={3650} className="w-24" disabled={disabled}
                value={form.every_count ?? ""}
                onChange={(e) => set({ every_count: e.target.value === "" ? null : Math.floor(Number(e.target.value)) })} />
              <Select value={form.every_unit || "day"} onValueChange={(v) => set({ every_unit: v as RegistrationUnit })} disabled={disabled}>
                <SelectTrigger className="w-32" aria-label="Period unit"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="day">days</SelectItem>
                  <SelectItem value="week">weeks</SelectItem>
                  <SelectItem value="month">months</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="flex flex-wrap gap-1.5">
              {PRESETS.map((p) => (
                <button key={`${p.count}${p.unit}`} type="button" disabled={disabled}
                  onClick={() => set({ every_count: p.count, every_unit: p.unit })}
                  className={cn("rounded-full border px-2.5 py-0.5 text-xs",
                    form.every_count === p.count && form.every_unit === p.unit ? "border-primary bg-primary/10 text-primary" : "hover:bg-muted")}>
                  {period(p.count, p.unit)}
                </button>
              ))}
            </div>
          </div>
        )}

        {form.rule !== "every_visit" && (
          <label className="flex items-start gap-2 text-sm">
            <input type="checkbox" className="mt-1" checked={form.paper_patients_registered} disabled={disabled}
              onChange={(e) => set({ paper_patients_registered: e.target.checked })} />
            <span>
              Patients brought over from the paper register are already registered
              <span className="block text-xs text-muted-foreground">They registered on paper, so they do not pay registration again just for moving to ClinicOS.</span>
            </span>
          </label>
        )}

        <p className="rounded-md bg-muted/40 px-3 py-2 text-sm" aria-live="polite">{describeRule(form, feeName)}</p>

        {manage && (
          <div className="border-t pt-4">
            <Button onClick={() => save.mutate(form)} loading={save.isPending} disabled={needsFee || needsPeriod}>
              Save registration rule
            </Button>
            {needsFee && <p className="mt-1.5 text-xs text-destructive">Choose which fee is the registration fee.</p>}
            {needsPeriod && <p className="mt-1.5 text-xs text-destructive">Say how long registration lasts.</p>}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
