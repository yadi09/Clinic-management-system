import { useEffect, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { useMutation, useQuery } from "@tanstack/react-query";
import { AlertTriangle, Check, HandCoins, Hourglass, Printer } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { toast } from "@/components/ui/sonner";
import { AppError } from "@/lib/api-client";
import { completeDispense, dispenseDetail, prepareDispense, type Batch } from "@/features/pharmacy/api";

function availableBatches(bs: Batch[]) {
  return bs.filter((b) => b.qty_on_hand > 0 && !b.quarantined && b.status !== "expired");
}

export function DispensePage() {
  const { rxId = "" } = useParams();
  const navigate = useNavigate();
  const q = useQuery({ queryKey: ["dispense", rxId], queryFn: () => dispenseDetail(rxId), enabled: !!rxId });

  const [sel, setSel] = useState<Record<string, { batchId: string; qty: number }>>({});
  const [notes, setNotes] = useState("");

  useEffect(() => {
    if (!q.data) return;
    const init: Record<string, { batchId: string; qty: number }> = {};
    for (const it of q.data.items) {
      const av = availableBatches(it.batches);
      init[it.id] = { batchId: av[0]?.id ?? "", qty: 1 };
    }
    setSel(init);
  }, [q.data]);

  if (q.isLoading) return <div className="p-8 text-sm text-muted-foreground">Loading…</div>;
  if (q.isError || !q.data) return <div className="p-8 text-sm text-destructive">Could not load this prescription.</div>;
  const d = q.data;

  const blocked = d.items.some((it) => it.allergy_conflict);
  const dispensableLines = d.items
    .filter((it) => it.matched_drug_id && sel[it.id]?.batchId && (sel[it.id]?.qty ?? 0) > 0 && !it.allergy_conflict)
    .map((it) => ({ drug_id: it.matched_drug_id as string, batch_id: sel[it.id].batchId, qty: sel[it.id].qty }));

  return (
    <DispenseInner
      d={d} sel={sel} setSel={setSel} notes={notes} setNotes={setNotes}
      blocked={blocked} lines={dispensableLines} rxId={rxId} navigate={navigate} refetch={q.refetch}
    />
  );
}

function DispenseInner({ d, sel, setSel, notes, setNotes, blocked, lines, rxId, navigate, refetch }: any) {
  const prepare = useMutation({
    mutationFn: () => prepareDispense(rxId, { counselling_notes: notes, lines }),
    onSuccess: (r: { total: string }) => { toast.success(`Billed ETB ${r.total} — sent to the cashier`); refetch(); },
    onError: (e: unknown) => toast.error(e instanceof AppError ? e.message : "Could not prepare"),
  });
  const complete = useMutation({
    mutationFn: () => completeDispense(rxId),
    onSuccess: () => { toast.success("Dispensed — stock decremented, handed over"); navigate("/pharmacy/queue"); },
    onError: (e: unknown) => toast.error(e instanceof AppError ? e.message : "Could not complete"),
  });

  const selecting = !d.dispensed && !d.prepared;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-4 rounded-xl bg-brand px-5 py-4 text-white">
        <div>
          <p className="text-lg font-semibold">Dispense — R-{d.rx_no}</p>
          <p className="text-xs text-white/70">
            {d.patient_name} · MRN {d.mrn}
            {d.prescriber ? ` · ${d.prescriber}` : ""}
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          {d.allergies.map((a: string) => (
            <span key={a} className="flex items-center gap-1 rounded-full bg-rose-600 px-3 py-1 text-xs font-semibold">
              <AlertTriangle className="h-3.5 w-3.5" /> Allergy: {a}
            </span>
          ))}
        </div>
        {d.dispensed && <span className="ml-auto rounded-full bg-white/15 px-3 py-1 text-xs">Already dispensed</span>}
      </div>

      {/* Pre-pay status banner */}
      {d.prepared && !d.dispensed && (
        d.charge_settled ? (
          <div className="flex items-center gap-2 rounded-md border border-emerald-300 bg-emerald-50 px-3 py-2 text-sm text-emerald-800">
            <Check className="h-4 w-4" /> Payment collected (ETB {d.prepared_total}). Ready to hand over.
          </div>
        ) : (
          <div className="flex items-center gap-2 rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-800">
            <Hourglass className="h-4 w-4" /> Awaiting payment — ETB {d.prepared_total} due at the cashier. Hand-over unlocks once the cashier settles.
          </div>
        )
      )}

      <Card className="p-4">
        <h2 className="mb-3 text-h3">Items</h2>
        <div className="space-y-3">
          {d.items.map((it: any) => {
            const av = availableBatches(it.batches);
            const conflict = !!it.allergy_conflict;
            const outOfStock = !it.matched_drug_id || av.length === 0;
            return (
              <div key={it.id} className={`rounded-md border p-3 ${conflict ? "border-rose-300 bg-rose-50" : ""}`}>
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div className="min-w-0">
                    <p className="font-medium">
                      {it.drug_name}
                      {conflict ? <span className="text-rose-700"> — BLOCKED ({it.allergy_conflict})</span> : null}
                    </p>
                    <p className="text-xs text-muted-foreground">{it.sig}</p>
                  </div>
                  {selecting && !conflict && !outOfStock && (
                    <div className="flex items-end gap-2">
                      <label className="text-xs text-muted-foreground">
                        Batch (FEFO)
                        <select
                          className="mt-1 block rounded-md border bg-background px-2 py-1.5 text-sm"
                          value={sel[it.id]?.batchId ?? ""}
                          onChange={(e) => setSel({ ...sel, [it.id]: { ...sel[it.id], batchId: e.target.value } })}
                        >
                          {av.map((b: Batch) => (
                            <option key={b.id} value={b.id}>
                              {b.batch_no} · exp {b.expiry_date?.slice(0, 7) ?? "—"} · {b.qty_on_hand} on hand
                            </option>
                          ))}
                        </select>
                      </label>
                      <label className="text-xs text-muted-foreground">
                        Qty
                        <Input
                          type="number"
                          min={1}
                          className="mt-1 w-20"
                          value={sel[it.id]?.qty ?? 1}
                          onChange={(e) => setSel({ ...sel, [it.id]: { ...sel[it.id], qty: Number(e.target.value) } })}
                        />
                      </label>
                    </div>
                  )}
                  {selecting && !conflict && outOfStock && <span className="text-xs font-medium text-amber-700">Not in stock — print &amp; buy outside</span>}
                </div>
              </div>
            );
          })}
        </div>
      </Card>

      <Card className="p-4">
        <h2 className="mb-2 text-h3">Counselling &amp; checks</h2>
        {d.allergies.length > 0 && (
          <div className="mb-3 flex items-center gap-2 rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-800">
            <AlertTriangle className="h-4 w-4" /> Verify no {d.allergies.join(", ")}-related drugs are dispensed.
          </div>
        )}
        <Textarea rows={2} placeholder="Counselling notes…" value={notes} onChange={(e) => setNotes(e.target.value)} disabled={!selecting} />
        <p className="mt-2 text-xs text-muted-foreground">
          Step 1 — send to the cashier to bill the patient. Step 2 — once paid, hand over (this decrements FEFO stock).
        </p>
        <div className="mt-3 flex items-center justify-end gap-2">
          <Button variant="outline" onClick={() => window.print()}>
            <Printer className="h-4 w-4" /> Print
          </Button>
          {selecting && (
            <Button className="bg-primary" disabled={blocked || lines.length === 0} loading={prepare.isPending} onClick={() => prepare.mutate()}>
              <HandCoins className="h-4 w-4" /> Send to cashier
            </Button>
          )}
          {d.prepared && !d.dispensed && (
            <Button className="bg-primary" disabled={!d.charge_settled} loading={complete.isPending} onClick={() => complete.mutate()}>
              <Check className="h-4 w-4" /> Complete dispense
            </Button>
          )}
        </div>
        {selecting && blocked && <p className="mt-2 text-right text-xs font-medium text-rose-700">Resolve the allergy conflict before dispensing.</p>}
        {d.prepared && !d.charge_settled && !d.dispensed && (
          <p className="mt-2 text-right text-xs text-muted-foreground">Waiting for the cashier to collect payment…</p>
        )}
      </Card>
    </div>
  );
}
