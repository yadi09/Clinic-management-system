import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Stethoscope, UserCheck } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { toast } from "@/components/ui/sonner";
import { listBranches, listDepartments, listUsers, getSettings } from "@/features/admin/api";
import { listServices, raiseCharge, settleCharge } from "@/features/billing/api";
import { walkIn } from "@/features/scheduling/api";
import { PatientCombobox } from "@/features/scheduling/components/BookingDialog";

export function ReceptionPage() {
  const qc = useQueryClient();

  const branches = useQuery({ queryKey: ["branches"], queryFn: listBranches });
  const departments = useQuery({ queryKey: ["departments"], queryFn: listDepartments });
  const providers = useQuery({ queryKey: ["users"], queryFn: listUsers });
  const settings = useQuery({ queryKey: ["settings"], queryFn: getSettings, retry: false });
  const services = useQuery({ queryKey: ["services-active"], queryFn: () => listServices(true) });

  const [patient, setPatient] = useState<{ id: string; name: string } | null>(null);
  const [dept, setDept] = useState("");
  const [toTriage, setToTriage] = useState(false);
  const [provider, setProvider] = useState("");
  const [picked, setPicked] = useState<Record<string, boolean>>({});

  const branchId = branches.data?.[0]?.id;
  const cashierMode = settings.data?.payment_mode === "cashier";

  // Pre-select the catalog's default services (e.g. a registration / consultation fee).
  useEffect(() => {
    if (services.data && Object.keys(picked).length === 0) {
      const init: Record<string, boolean> = {};
      services.data.forEach((s) => { if (s.is_default) init[s.id] = true; });
      if (Object.keys(init).length) setPicked(init);
    }
  }, [services.data, picked]);

  // Default the routing choice to the clinic's triage setting.
  useEffect(() => {
    setToTriage(!!settings.data?.triage_required);
  }, [settings.data?.triage_required]);

  const chosen = (services.data ?? []).filter((s) => picked[s.id]);
  const total = chosen.reduce((sum, s) => sum + (parseFloat(s.price) || 0), 0);

  const resetForm = () => {
    setPatient(null);
    setDept("");
    setProvider("");
    setPicked({});
  };

  const send = useMutation({
    mutationFn: async () => {
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
      // Raise ALL charges first (so the visit total is complete before any settle),
      // then in reception-collect mode settle them inline. The patient auto-advances
      // server-side once nothing is owed.
      const ids: string[] = [];
      for (const s of chosen) {
        const r = await raiseCharge({
          patient_id: patient!.id,
          service_item_id: s.id,
          source: "consultation",
          description: s.name,
          amount: parseFloat(s.price) || 0,
          ...routing,
        });
        ids.push(r.id);
      }
      if (!cashierMode) {
        for (const cid of ids) await settleCharge(cid, "cash");
      }
    },
    onSuccess: () => {
      const dest = toTriage ? "triage" : "the doctor's queue";
      toast.success(
        chosen.length === 0
          ? `${patient!.name} sent to ${dest}`
          : cashierMode
            ? `${patient!.name} → cashier (ETB ${total.toFixed(2)} to collect)`
            : `${patient!.name}: ETB ${total.toFixed(2)} collected · sent to ${dest}`,
      );
      resetForm();
      qc.invalidateQueries({ queryKey: ["queue"] });
      qc.invalidateQueries({ queryKey: ["pending-charges"] });
    },
    onError: () => toast.error("Could not register the visit"),
  });

  const routeReady = !!patient && !!dept && !!branchId && (toTriage || !!provider);

  return (
    <div className="space-y-6">
      <div>
        <h1>Reception</h1>
        <p className="text-sm text-muted-foreground">
          Register the visit, choose the service(s) the patient is here for, and route them.
        </p>
      </div>

      <div className="grid gap-6 lg:grid-cols-2">
        {/* Patient + services */}
        <Card>
          <CardHeader>
            <CardTitle>Patient & services</CardTitle>
            <CardDescription>
              Find the patient, then pick what they're here for. {cashierMode ? "Payment is taken at the cashier." : "Payment is collected here."}
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="space-y-1.5">
              <Label>Patient</Label>
              <PatientCombobox value={patient} onSelect={setPatient} />
            </div>

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

        {/* Routing */}
        <Card>
          <CardHeader>
            <CardTitle>Route patient</CardTitle>
            <CardDescription>Send to triage, or straight to a doctor.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="space-y-1.5">
              <Label>Department</Label>
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

            <div className="space-y-2">
              <Label>Next step</Label>
              <div className="flex gap-2">
                <Button type="button" variant={toTriage ? "default" : "outline"} className="flex-1" onClick={() => setToTriage(true)}>
                  <Stethoscope /> Triage first
                </Button>
                <Button type="button" variant={!toTriage ? "default" : "outline"} className="flex-1" onClick={() => setToTriage(false)}>
                  <UserCheck /> Straight to doctor
                </Button>
              </div>
            </div>

            {!toTriage && (
              <div className="space-y-1.5">
                <Label>Doctor</Label>
                <Select value={provider} onValueChange={setProvider}>
                  <SelectTrigger>
                    <SelectValue placeholder="Assign a doctor" />
                  </SelectTrigger>
                  <SelectContent>
                    {(providers.data ?? []).filter((u) => u.status === "active").map((u) => (
                      <SelectItem key={u.id} value={u.id}>
                        {u.full_name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            )}

            <Button className="w-full" disabled={!routeReady} loading={send.isPending} onClick={() => send.mutate()}>
              {chosen.length > 0 && cashierMode ? "Send to cashier" : `Send to ${toTriage ? "triage" : "doctor"}`}
            </Button>
            {cashierMode && chosen.length > 0 && (
              <p className="text-center text-xs text-muted-foreground">Raises a pending payment; the patient advances once the cashier settles it.</p>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
