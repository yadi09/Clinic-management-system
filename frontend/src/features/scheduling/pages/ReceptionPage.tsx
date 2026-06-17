import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { CheckCircle2, CircleDollarSign, Stethoscope, UserCheck } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Badge } from "@/components/ui/badge";
import { toast } from "@/components/ui/sonner";
import { listBranches, listDepartments, listUsers, getSettings } from "@/features/admin/api";
import { assessCard, collectCard, listServices, raiseCharge } from "@/features/billing/api";
import { walkIn } from "@/features/scheduling/api";
import { PatientCombobox } from "@/features/scheduling/components/BookingDialog";

export function ReceptionPage() {
  const qc = useQueryClient();

  const branches = useQuery({ queryKey: ["branches"], queryFn: listBranches });
  const departments = useQuery({ queryKey: ["departments"], queryFn: listDepartments });
  const providers = useQuery({ queryKey: ["users"], queryFn: listUsers });
  const settings = useQuery({ queryKey: ["settings"], queryFn: getSettings, retry: false });

  const [patient, setPatient] = useState<{ id: string; name: string } | null>(null);
  const [dept, setDept] = useState("");
  const [toTriage, setToTriage] = useState(false);
  const [provider, setProvider] = useState("");
  const [waiveReason, setWaiveReason] = useState("");

  const branchId = branches.data?.[0]?.id;
  const cashierMode = settings.data?.payment_mode === "cashier";

  // In cashier mode, payment is taken at the cashier — reception raises a
  // consultation charge priced from the CONSULT service (fallback: card fee).
  const services = useQuery({ queryKey: ["services-active"], queryFn: () => listServices(true), enabled: cashierMode });
  const consultSvc = (services.data ?? []).find((s) => s.code.toUpperCase() === "CONSULT");
  const consultAmount = consultSvc ? parseFloat(consultSvc.price) : parseFloat(settings.data?.card_fee_amount ?? "0");

  // Default the routing choice to the clinic's triage setting.
  useEffect(() => {
    setToTriage(!!settings.data?.triage_required);
  }, [settings.data?.triage_required]);

  const assess = useQuery({
    queryKey: ["card-assess", patient?.id],
    queryFn: () => assessCard(patient!.id),
    enabled: !!patient,
  });

  const collect = useMutation({
    mutationFn: (waived: boolean) =>
      collectCard({ patient_id: patient!.id, branch_id: branchId!, waived, waive_reason: waived ? waiveReason : undefined }),
    onSuccess: (_d, waived) => {
      toast.success(waived ? "Card fee waived" : "Card fee collected");
      setWaiveReason("");
      qc.invalidateQueries({ queryKey: ["card-assess", patient?.id] });
    },
    onError: () => toast.error("Could not record the payment"),
  });

  const send = useMutation({
    mutationFn: async () => {
      if (cashierMode) {
        // Raise a pending consultation charge with the routing; the cashier's
        // settlement enqueues the patient (auto-advance after payment).
        await raiseCharge({
          patient_id: patient!.id,
          source: "consultation",
          description: "Consultation",
          amount: consultAmount || 0,
          branch_id: branchId!,
          department_id: dept,
          to_triage: toTriage,
          provider_id: !toTriage && provider ? provider : undefined,
        });
        return;
      }
      await walkIn({
        branch_id: branchId!,
        department_id: dept,
        patient_id: patient!.id,
        to_triage: toTriage,
        provider_id: !toTriage && provider ? provider : undefined,
      });
    },
    onSuccess: () => {
      toast.success(cashierMode ? `${patient!.name} sent to the cashier — awaiting payment` : `${patient!.name} sent to ${toTriage ? "triage" : "the doctor's queue"}`);
      setPatient(null);
      setDept("");
      setProvider("");
      qc.invalidateQueries({ queryKey: ["queue"] });
      qc.invalidateQueries({ queryKey: ["pending-charges"] });
    },
    onError: () => toast.error("Could not route the patient"),
  });

  const a = assess.data;
  const mustPay = !!a?.requires_payment;
  const routeReady = !!patient && !!dept && !!branchId && (toTriage || !!provider) && (cashierMode || !mustPay);

  return (
    <div className="space-y-6">
      <div>
        <h1>Reception</h1>
        <p className="text-sm text-muted-foreground">Register the visit, take the card fee, and route the patient.</p>
      </div>

      <div className="grid gap-6 lg:grid-cols-2">
        {/* Patient + card fee */}
        <Card>
          <CardHeader>
            <CardTitle>Patient & card</CardTitle>
            <CardDescription>Find the patient, then settle the card / consultation fee.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="space-y-1.5">
              <Label>Patient</Label>
              <PatientCombobox value={patient} onSelect={setPatient} />
            </div>

            {patient && cashierMode && (
              <div className="rounded-md border border-primary/30 bg-primary/5 p-3 text-sm text-muted-foreground">
                Payment is taken at the <span className="font-medium text-foreground">cashier</span>. Routing this patient raises a
                pending charge (<span className="font-mono">ETB {consultAmount.toFixed(2)}</span>) they settle there; they advance automatically once paid.
              </div>
            )}
            {patient && !cashierMode && (
              <CardStatus
                loading={assess.isLoading}
                a={a}
                onCollect={() => collect.mutate(false)}
                onWaive={() => collect.mutate(true)}
                collecting={collect.isPending}
                waiveReason={waiveReason}
                setWaiveReason={setWaiveReason}
              />
            )}
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
                <Button
                  type="button"
                  variant={toTriage ? "default" : "outline"}
                  className="flex-1"
                  onClick={() => setToTriage(true)}
                >
                  <Stethoscope /> Triage first
                </Button>
                <Button
                  type="button"
                  variant={!toTriage ? "default" : "outline"}
                  className="flex-1"
                  onClick={() => setToTriage(false)}
                >
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

            {!cashierMode && mustPay && <p className="text-sm text-warning">Collect the card fee before routing.</p>}
            <Button className="w-full" disabled={!routeReady} loading={send.isPending} onClick={() => send.mutate()}>
              {cashierMode ? "Send to cashier" : `Send to ${toTriage ? "triage" : "doctor"}`}
            </Button>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}

function CardStatus({
  loading,
  a,
  onCollect,
  onWaive,
  collecting,
  waiveReason,
  setWaiveReason,
}: {
  loading: boolean;
  a?: { requires_payment: boolean; card_enabled: boolean; amount: string; currency: string; reason: string };
  onCollect: () => void;
  onWaive: () => void;
  collecting: boolean;
  waiveReason: string;
  setWaiveReason: (s: string) => void;
}) {
  if (loading || !a) return <div className="rounded-md border p-3 text-sm text-muted-foreground">Checking card status…</div>;

  if (!a.requires_payment) {
    return (
      <div className="flex items-center gap-2 rounded-md border border-primary/40 bg-primary/10 p-3 text-sm">
        <CheckCircle2 className="h-4 w-4 text-primary" />
        <span className="font-medium capitalize">{a.reason}</span>
        <Badge variant="success" className="ml-auto">No charge</Badge>
      </div>
    );
  }
  return (
    <div className="space-y-3 rounded-md border border-warning/40 bg-warning/10 p-3">
      <div className="flex items-center gap-2 text-sm">
        <CircleDollarSign className="h-4 w-4 text-warning" />
        <span className="font-medium">Card fee due</span>
        <span className="ml-auto font-mono font-semibold">
          {a.currency} {a.amount}
        </span>
      </div>
      <div className="flex items-end gap-2">
        <div className="flex-1 space-y-1">
          <Label className="text-xs">Waive reason (optional)</Label>
          <Input value={waiveReason} onChange={(e) => setWaiveReason(e.target.value)} placeholder="e.g. staff / exempt" />
        </div>
        <Button variant="outline" disabled={collecting} onClick={onWaive}>
          Waive
        </Button>
        <Button disabled={collecting} loading={collecting} onClick={onCollect}>
          Collect
        </Button>
      </div>
    </div>
  );
}
