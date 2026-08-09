import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { HandCoins, Stethoscope, UserCheck, AlertTriangle } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { toast } from "@/components/ui/sonner";
import { AppError } from "@/lib/api-client";
import { useAuth } from "@/app/auth-context";
import { listBranches, listDepartments, getSettings, listProviders } from "@/features/admin/api";
import { listServices, providersForServices, raiseChargeBatch, settleCharge, waiveCharge, waiverReasons, patientCharges } from "@/features/billing/api";
import { walkIn } from "@/features/scheduling/api";
import { PatientCombobox } from "@/features/scheduling/components/BookingDialog";

const METHODS = ["cash", "card", "mobile", "transfer"];

type SendOpts = { action: "cashier" | "collect" | "waive"; method?: string; reason?: string };

export function ReceptionPage() {
  const qc = useQueryClient();
  const { can, activeBranchId, flagOn } = useAuth();
  // A dental clinic doesn't triage or bill a per-visit consultation: reception just
  // identifies the patient and sends them to a dentist (no charge, or an optional
  // registration/visit fee). Billing happens later via the treatment plan.
  const isDental = flagOn("dental");
  // Whether this user can collect cash themselves (Cashier capability). If they
  // can, reception collects inline; if not, charges hand off to the cashier.
  const canCollect = can("payment.collect");

  const branches = useQuery({ queryKey: ["branches"], queryFn: listBranches });
  const departments = useQuery({ queryKey: ["departments"], queryFn: listDepartments });
  const settings = useQuery({ queryKey: ["settings"], queryFn: getSettings, retry: false });
  const services = useQuery({ queryKey: ["services-active"], queryFn: () => listServices(true) });
  const reasons = useQuery({ queryKey: ["waiver-reasons"], queryFn: waiverReasons, enabled: canCollect });

  const [patient, setPatient] = useState<{ id: string; name: string } | null>(null);
  const [dept, setDept] = useState("");
  const [toTriage, setToTriage] = useState(false);
  const [provider, setProvider] = useState("");
  const [picked, setPicked] = useState<Record<string, boolean>>({});
  const [method, setMethod] = useState("cash");
  const [waiveOpen, setWaiveOpen] = useState(false);
  const [waiveReason, setWaiveReason] = useState("");

  const branchId = activeBranchId ?? branches.data?.[0]?.id;
  // Hand off to a separate cashier when this user can't collect cash themselves.
  const cashierMode = !canCollect;
  // When the clinic requires triage (Settings → Patient flow), reception cannot send
  // a patient straight to a doctor — every visit goes through triage first.
  const triageRequired = !!settings.data?.triage_required;

  useEffect(() => {
    if (services.data && Object.keys(picked).length === 0) {
      const init: Record<string, boolean> = {};
      services.data.forEach((s) => { if (s.is_default) init[s.id] = true; });
      if (Object.keys(init).length) setPicked(init);
    }
  }, [services.data, picked]);

  useEffect(() => {
    // Dental never triages — always straight to the dentist.
    setToTriage(isDental ? false : !!settings.data?.triage_required);
  }, [settings.data?.triage_required, isDental]);

  const chosen = (services.data ?? []).filter((s) => picked[s.id]);
  const total = chosen.reduce((sum, s) => sum + (parseFloat(s.price) || 0), 0);
  const chosenIds = chosen.map((s) => s.id);

  // The assign dropdown lists only staff who provide the selected service(s). For a
  // dental clinic there may be no service at all, so list the assignable clinicians
  // (dentists) instead — via /providers, which reception can read (queue.manage),
  // unlike the full staff directory (user.read, which a receptionist/cashier lacks).
  const dentists = useQuery({ queryKey: ["providers"], queryFn: listProviders, enabled: isDental });
  const provQ = useQuery({
    queryKey: ["service-providers", [...chosenIds].sort().join(",")],
    queryFn: () => providersForServices(chosenIds),
    enabled: !isDental && !toTriage && chosenIds.length > 0,
  });
  const providerList = isDental ? (dentists.data ?? []) : (provQ.data ?? []);

  // Drop a stale provider selection when it's no longer offered for the chosen services.
  useEffect(() => {
    if (provider && !providerList.some((p) => p.id === provider)) setProvider("");
  }, [providerList, provider]);

  // Duplicate-registration guard: surface what the selected patient is already
  // waiting to pay at the cashier, so reception doesn't send them through twice.
  const patientPending = useQuery({
    queryKey: ["patient-pending", patient?.id],
    queryFn: () => patientCharges(patient!.id),
    enabled: !!patient,
    select: (rows) => rows.filter((r) => r.status === "pending"),
  });
  const pendingList = patientPending.data ?? [];
  const hasPending = pendingList.length > 0;
  const pendingTotal = pendingList.reduce((sum, r) => sum + (parseFloat(r.amount) || 0), 0);

  const resetForm = () => {
    setPatient(null);
    setDept("");
    setProvider("");
    setPicked({});
    setWaiveReason("");
  };

  const send = useMutation({
    mutationFn: async (opts: SendOpts) => {
      const routing = {
        branch_id: branchId!,
        department_id: dept,
        to_triage: toTriage,
        provider_id: !toTriage && provider ? provider : undefined,
      };
      // No services chosen → straight into the queue, nothing to pay.
      if (chosen.length === 0) {
        await walkIn({ patient_id: patient!.id, ...routing });
        return;
      }
      // Raise ALL charges in one atomic batch: the server rejects a duplicate
      // registration (pending charges / active visit) before writing any line,
      // so the same patient can't be sent to the cashier twice. The patient
      // auto-advances server-side once nothing is owed.
      const { ids } = await raiseChargeBatch({
        patient_id: patient!.id,
        branch_id: routing.branch_id,
        department_id: routing.department_id,
        to_triage: routing.to_triage,
        provider_id: routing.provider_id,
        items: chosen.map((s) => ({ service_item_id: s.id, source: "consultation", description: s.name, amount: parseFloat(s.price) || 0 })),
      });
      if (opts.action === "collect") {
        for (const cid of ids) await settleCharge(cid, opts.method || "cash");
      } else if (opts.action === "waive") {
        for (const cid of ids) await waiveCharge(cid, opts.reason!);
      }
      // action === "cashier" → leave the charges pending for the cashier.
    },
    onSuccess: (_d, opts) => {
      const dest = isDental ? "the dentist" : toTriage ? "triage" : "the doctor's queue";
      let msg: string;
      if (chosen.length === 0) msg = `${patient!.name} sent to ${dest}`;
      else if (opts.action === "cashier") msg = `${patient!.name} → cashier (ETB ${total.toFixed(2)} to collect)`;
      else if (opts.action === "waive") msg = `${patient!.name}: fee waived · sent to ${dest}`;
      else msg = `${patient!.name}: ETB ${total.toFixed(2)} collected (${opts.method}) · sent to ${dest}`;
      toast.success(msg);
      setWaiveOpen(false);
      resetForm();
      qc.invalidateQueries({ queryKey: ["queue"] });
      qc.invalidateQueries({ queryKey: ["pending-charges"] });
      qc.invalidateQueries({ queryKey: ["patient-pending"] });
    },
    onError: (e) => toast.error(e instanceof AppError ? e.message : "Could not register the visit"),
  });

  const routeReady = !!patient && !!dept && !!branchId && (toTriage || !!provider);
  const hasFee = chosen.length > 0;
  const destWord = isDental ? "dentist" : toTriage ? "triage" : "doctor";

  return (
    <div className="space-y-6">
      <div>
        <h1>Reception</h1>
        <p className="text-sm text-muted-foreground">
          {isDental
            ? "Find the patient and send them to a dentist. Add a registration/visit fee only if you take one — treatment is billed later from the plan."
            : "Register the visit, choose the service(s) the patient is here for, and route them."}
        </p>
      </div>

      <div className="grid gap-6 lg:grid-cols-2">
        {/* Patient + services */}
        <Card>
          <CardHeader>
            <CardTitle>Patient & services</CardTitle>
            <CardDescription>
              Find the patient, then pick what they're here for. {cashierMode ? "Payment is taken at the cashier." : "You collect the payment here."}
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="space-y-1.5">
              <Label>Patient</Label>
              <PatientCombobox value={patient} onSelect={setPatient} />
            </div>

            {hasPending && (
              <div className="space-y-2 rounded-md border border-warning/40 bg-warning/10 p-3">
                <div className="flex items-center gap-2 text-sm font-medium text-warning">
                  <AlertTriangle className="h-4 w-4" />
                  Already at the cashier
                </div>
                <p className="text-xs text-muted-foreground">
                  {patient?.name} already has {pendingList.length} unpaid charge{pendingList.length > 1 ? "s" : ""} waiting to be paid. Don't register the visit again — settle or void {pendingList.length > 1 ? "them" : "it"} at the cashier first.
                </p>
                <ul className="space-y-1 rounded border bg-background/60 p-2 text-xs">
                  {pendingList.map((r) => (
                    <li key={r.id} className="flex items-center justify-between gap-2">
                      <span className="truncate">{r.description}</span>
                      <span className="font-mono text-muted-foreground">{r.currency} {r.amount}</span>
                    </li>
                  ))}
                  <li className="flex items-center justify-between gap-2 border-t pt-1 font-semibold">
                    <span>Pending total</span>
                    <span className="font-mono">ETB {pendingTotal.toFixed(2)}</span>
                  </li>
                </ul>
              </div>
            )}

            <div className="space-y-2">
              <Label>Services</Label>
              <div className="max-h-56 space-y-1 overflow-auto rounded-md border p-1">
                {(services.data ?? []).map((s) => (
                  <label key={s.id} className="flex cursor-pointer items-center gap-2 rounded px-2 py-1.5 text-sm hover:bg-muted">
                    <input
                      type="checkbox"
                      checked={!!picked[s.id]}
                      onChange={(e) => setPicked({ ...picked, [s.id]: e.target.checked })}
                    />
                    <span className="flex-1">{s.name}{s.is_default ? <span className="ml-1.5 text-xs text-primary">· default</span> : null}</span>
                    <span className="font-mono text-xs text-muted-foreground">{s.currency} {s.price}</span>
                  </label>
                ))}
                {(services.data?.length ?? 0) === 0 && (
                  <p className="px-2 py-3 text-xs text-muted-foreground">No services in the catalog — add them in Billing → Service catalog.</p>
                )}
              </div>
              <div className="flex items-center justify-between px-1 text-sm">
                <span className="text-muted-foreground">{chosen.length} selected</span>
                <span className="font-semibold">Total: ETB {total.toFixed(2)}</span>
              </div>
              {chosen.length === 0 && (
                <p className="px-1 text-xs text-muted-foreground">No service selected — the patient goes straight to the queue with no charge.</p>
              )}
            </div>
          </CardContent>
        </Card>

        {/* Routing + payment */}
        <Card>
          <CardHeader>
            <CardTitle>Route patient</CardTitle>
            <CardDescription>{isDental ? "Send the patient to a dentist." : "Send to triage, or straight to a doctor."}</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="space-y-1.5">
              <Label>Department</Label>
              <Select value={dept} onValueChange={setDept}>
                {/* @branch-scoped: only the active branch's departments */}
                <SelectTrigger>
                  <SelectValue placeholder="Select department" />
                </SelectTrigger>
                <SelectContent>
                  {(departments.data ?? []).filter((d) => !activeBranchId || d.branch_id === activeBranchId).map((d) => (
                    <SelectItem key={d.id} value={d.id}>
                      {d.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            {!isDental && (
              <div className="space-y-2">
                <Label>Next step</Label>
                {triageRequired ? (
                  <div className="flex items-center gap-2 rounded-md border bg-muted/40 px-3 py-2 text-sm">
                    <Stethoscope className="h-4 w-4 text-brand" />
                    <span>Triage first <span className="text-muted-foreground">— required by clinic settings</span></span>
                  </div>
                ) : (
                  <div className="flex gap-2">
                    <Button type="button" variant={toTriage ? "default" : "outline"} className="flex-1" onClick={() => setToTriage(true)}>
                      <Stethoscope /> Triage first
                    </Button>
                    <Button type="button" variant={!toTriage ? "default" : "outline"} className="flex-1" onClick={() => setToTriage(false)}>
                      <UserCheck /> Straight to doctor
                    </Button>
                  </div>
                )}
              </div>
            )}

            {!toTriage && (
              <div className="space-y-1.5">
                <Label>{isDental ? "Dentist" : "Provider"}</Label>
                <Select value={provider} onValueChange={setProvider} disabled={providerList.length === 0}>
                  <SelectTrigger>
                    <SelectValue placeholder={isDental ? "Assign a dentist" : chosenIds.length === 0 ? "Pick a service first" : "Assign a provider"} />
                  </SelectTrigger>
                  <SelectContent>
                    {providerList.map((p) => (
                      <SelectItem key={p.id} value={p.id}>
                        {p.full_name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                {!isDental && !toTriage && chosenIds.length > 0 && providerList.length === 0 && !provQ.isFetching && (
                  <p className="text-xs text-warning">No staff are assigned to the selected service(s). Assign providers in Billing → Service catalog, or send to triage.</p>
                )}
              </div>
            )}

            {/* --- payment / send --- */}
            {cashierMode ? (
              <>
                <Button className="w-full" disabled={!routeReady || hasPending} loading={send.isPending} onClick={() => send.mutate({ action: "cashier" })}>
                  {hasFee ? "Send to cashier" : `Send to ${destWord}`}
                </Button>
                {hasFee && (
                  <p className="text-center text-xs text-muted-foreground">Raises a pending payment; the patient advances once the cashier settles it.</p>
                )}
              </>
            ) : hasFee ? (
              <div className="space-y-2 rounded-md border bg-muted/30 p-3">
                <div className="flex items-center justify-between">
                  <Label className="text-xs">Collect payment</Label>
                  <span className="font-mono text-sm font-semibold">ETB {total.toFixed(2)}</span>
                </div>
                <div className="flex items-end gap-2">
                  <div className="flex-1 space-y-1">
                    <Label className="text-xs text-muted-foreground">Method</Label>
                    <Select value={method} onValueChange={setMethod}>
                      <SelectTrigger className="capitalize"><SelectValue /></SelectTrigger>
                      <SelectContent>
                        {METHODS.map((m) => <SelectItem key={m} value={m} className="capitalize">{m}</SelectItem>)}
                      </SelectContent>
                    </Select>
                  </div>
                  <Button variant="outline" disabled={!routeReady || hasPending} onClick={() => setWaiveOpen(true)}>Waive…</Button>
                </div>
                <Button className="w-full" disabled={!routeReady || hasPending} loading={send.isPending} onClick={() => send.mutate({ action: "collect", method })}>
                  <HandCoins className="h-4 w-4" /> Collect ETB {total.toFixed(2)} &amp; send to {destWord}
                </Button>
              </div>
            ) : (
              <Button className="w-full" disabled={!routeReady || hasPending} loading={send.isPending} onClick={() => send.mutate({ action: "cashier" })}>
                Send to {destWord}
              </Button>
            )}
          </CardContent>
        </Card>
      </div>

      {/* Waive dialog (reception-collect mode) */}
      <Dialog open={waiveOpen} onOpenChange={setWaiveOpen}>
        <DialogContent>
          <DialogHeader><DialogTitle>Waive the fee</DialogTitle></DialogHeader>
          <p className="text-sm text-muted-foreground">Sending {patient?.name} through without charging ETB {total.toFixed(2)} — record why.</p>
          <div className="space-y-1.5">
            <Label>Reason (required)</Label>
            <Select value={waiveReason} onValueChange={setWaiveReason}>
              <SelectTrigger><SelectValue placeholder="Why is this waived?" /></SelectTrigger>
              <SelectContent>
                {(reasons.data ?? []).map((r) => <SelectItem key={r} value={r}>{r}</SelectItem>)}
              </SelectContent>
            </Select>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setWaiveOpen(false)}>Cancel</Button>
            <Button disabled={!waiveReason || hasPending} loading={send.isPending} onClick={() => send.mutate({ action: "waive", reason: waiveReason })}>
              Waive &amp; send
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
