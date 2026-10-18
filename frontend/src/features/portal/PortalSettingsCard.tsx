// The clinic's switches for its patient portal: on or off, and what patients may see.
import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Copy } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Textarea } from "@/components/ui/textarea";
import { toast } from "@/components/ui/sonner";
import { useAuth } from "@/app/auth-context";
import { confirmHomePayment, getPortalSettings, listHomePayments, rejectHomePayment, savePortalSettings, type HomePayment, type PortalSettings } from "@/features/portal/api";

const OPTIONS: { key: keyof Pick<PortalSettings, "show_money" | "show_unbilled" | "show_teeth" | "show_3d">; label: string; help: string }[] = [
  { key: "show_money", label: "Payments", help: "What the patient has paid, what is waiting for payment, and their receipts." },
  { key: "show_unbilled", label: "Treatment not billed yet", help: "Work that is done but has no bill. Some clinics prefer not to show this." },
  { key: "show_teeth", label: "Tooth chart", help: "The patient's own teeth, with what is done and what is planned." },
  { key: "show_3d", label: "3D model of the teeth", help: "The patient can turn their own teeth around. Needs the tooth chart." },
];

export function PortalSettingsCard({ manage }: { manage: boolean }) {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ["portal-settings"], queryFn: getPortalSettings });
  const [draft, setDraft] = useState<PortalSettings | null>(null);
  useEffect(() => { if (q.data) setDraft(q.data); }, [q.data]);

  const save = useMutation({
    mutationFn: savePortalSettings,
    onSuccess: (s) => { toast.success("Patient portal saved"); qc.setQueryData(["portal-settings"], s); },
    onError: (e) => toast.error(e instanceof Error ? e.message : "Could not save the portal settings"),
  });

  if (q.isError) return <p role="alert" className="text-sm text-destructive">Could not load the portal settings.</p>;
  if (!draft) return <p className="text-sm text-muted-foreground">Loading…</p>;
  const link = `${window.location.origin}/p/${draft.slug ?? ""}`;
  const set = (patch: Partial<PortalSettings>) => setDraft({ ...draft, ...patch });
  const dirty = JSON.stringify(draft) !== JSON.stringify(q.data);

  return (
    <Card>
      <CardHeader>
        <CardTitle>Patient portal</CardTitle>
        <CardDescription>A page with your clinic's name where patients sign in with the card number on their patient card, and see their own treatment, payments and teeth. They can only read; nothing can be changed from it.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <label className="flex items-start gap-3 rounded-lg border p-3">
          <input type="checkbox" className="mt-1 h-4 w-4" checked={draft.enabled} disabled={!manage} onChange={(e) => set({ enabled: e.target.checked })} />
          <span><span className="block text-sm font-medium">Turn on the patient portal</span>
            <span className="block text-xs text-muted-foreground">Until you turn it on, the link below shows nothing.</span></span>
        </label>
        {draft.enabled && (
          <div className="flex flex-wrap items-center gap-2 rounded-lg bg-muted/50 p-3 text-sm">
            <span className="min-w-0 flex-1 break-all font-medium">{link}</span>
            <Button type="button" variant="outline" size="sm" onClick={() => { void navigator.clipboard?.writeText(link).then(() => toast.success("Link copied")); }}>
              <Copy className="mr-1.5 h-3.5 w-3.5" />Copy link
            </Button>
          </div>
        )}
        <fieldset className="space-y-2" disabled={!manage}>
          <legend className="mb-1 text-sm font-medium">What patients can see</legend>
          {OPTIONS.map((o) => (
            <label key={o.key} className="flex items-start gap-3 text-sm">
              <input type="checkbox" className="mt-1 h-4 w-4" checked={draft[o.key]} onChange={(e) => set({ [o.key]: e.target.checked })} />
              <span><span className="block font-medium">{o.label}</span><span className="block text-xs text-muted-foreground">{o.help}</span></span>
            </label>
          ))}
        </fieldset>
        <label className="flex items-start gap-3 rounded-lg border p-3">
          <input type="checkbox" className="mt-1 h-4 w-4" checked={draft.allow_pay && draft.show_money} disabled={!manage || !draft.show_money} onChange={(e) => set({ allow_pay: e.target.checked })} />
          <span><span className="block text-sm font-medium">Let patients pay from home</span>
            <span className="block text-xs text-muted-foreground">They pay what is already billed, or the next visit ahead of time, from their own phone using your Telebirr or bank account, then type the transaction number. The bank check confirms it; if it cannot, the payment waits here for the cashier. Needs "Payments" above and at least one wallet or bank method with an account number under Payment methods.</span></span>
        </label>
        <div className="space-y-1">
          <label htmlFor="portal-note" className="text-sm font-medium">A message on their home page</label>
          <Textarea id="portal-note" rows={2} maxLength={300} disabled={!manage} value={draft.welcome_note}
            placeholder="e.g. Please brush gently around a new crown for the first two days." onChange={(e) => set({ welcome_note: e.target.value })} />
        </div>
        <p className="text-xs text-muted-foreground">For now a patient signs in with the card number only. A card number is printed on the card, so anyone holding the card can open the page — a second step will be added before it is used widely.</p>
        {manage && <Button type="button" disabled={!dirty || save.isPending} onClick={() => save.mutate(draft)}>{save.isPending ? "Saving…" : "Save"}</Button>}
      </CardContent>
    </Card>
  );
}

const money = (s: string) => Number(s).toLocaleString("en-US", { maximumFractionDigits: 2 });

/** Payments a patient sent from home that the bank check could not settle on its own. The
 *  cashier looks at the patient's SMS, then confirms or turns it down. */
export function HomePaymentsCard() {
  const { can } = useAuth();
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ["home-payments"], queryFn: listHomePayments, refetchInterval: 30_000, enabled: can("payment.collect") });
  const [rejecting, setRejecting] = useState<{ id: string; reason: string } | null>(null);
  const refresh = () => qc.invalidateQueries({ queryKey: ["home-payments"] });
  const say = (e: unknown, f: string) => (e instanceof Error ? e.message : f);
  const confirm = useMutation({
    mutationFn: (p: HomePayment) => confirmHomePayment(p.id),
    onSuccess: (r) => { toast.success(r.receipt_no ? `Payment booked — receipt ${r.receipt_no}` : "Payment booked"); refresh(); },
    onError: (e) => { toast.error(say(e, "Could not book this payment")); refresh(); },
  });
  const reject = useMutation({
    mutationFn: (v: { id: string; reason: string }) => rejectHomePayment(v.id, v.reason),
    onSuccess: () => { setRejecting(null); toast.success("Payment turned down — the patient is told"); refresh(); },
    onError: (e) => { toast.error(say(e, "Could not turn this payment down")); refresh(); },
  });
  if (!can("payment.collect")) return null;
  const rows = q.data ?? [];
  return (
    <Card>
      <CardHeader>
        <CardTitle>Payments from home waiting for you</CardTitle>
        <CardDescription>The bank check could not settle these on its own. Look at the patient's SMS, then confirm to book the payment (it gets the clinic's usual receipt) or turn it down.</CardDescription>
      </CardHeader>
      <CardContent>
        {q.isError && <p role="alert" className="text-sm text-destructive">Could not load these payments.</p>}
        {!q.isError && rows.length === 0 && <p className="text-sm text-muted-foreground">Nothing is waiting.</p>}
        <ul className="divide-y rounded-lg border empty:hidden">
          {rows.map((p) => {
            const open = rejecting?.id === p.id ? rejecting : null;
            return (
              <li key={p.id} className="space-y-2 p-3 text-sm">
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                  <span><b>{p.patient}</b> <span className="text-muted-foreground">({p.mrn})</span></span>
                  <b>{money(p.amount)} ETB</b>
                </div>
                <div className="text-muted-foreground">{p.items}</div>
                <div className="text-xs text-muted-foreground">{p.rail} · transaction {p.reference.toUpperCase()}{p.verify_reason ? ` · Bank check: ${p.verify_reason}` : ""}</div>
                {open ? (
                  <div className="flex flex-wrap items-center gap-2">
                    <input aria-label="Why" className="min-w-0 flex-1 rounded-md border px-2 py-1.5 text-sm" placeholder="Why? (only you see this)" value={open.reason} onChange={(e) => setRejecting({ id: p.id, reason: e.target.value })} />
                    <Button size="sm" variant="destructive" disabled={reject.isPending} onClick={() => reject.mutate(open)}>Turn down</Button>
                    <Button size="sm" variant="outline" onClick={() => setRejecting(null)}>Cancel</Button>
                  </div>
                ) : (
                  <div className="flex gap-2">
                    <Button size="sm" disabled={confirm.isPending} onClick={() => confirm.mutate(p)}>Confirm payment</Button>
                    <Button size="sm" variant="outline" onClick={() => setRejecting({ id: p.id, reason: "" })}>Turn down</Button>
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      </CardContent>
    </Card>
  );
}
