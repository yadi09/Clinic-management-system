// What else got done at this visit.
//
// A course is agreed in advance — six sessions, this much each. Real dentistry then
// happens: at session three the tooth needs an X-ray, or the patient mentions the
// molar on the other side. Until now the only place to put that was the visit's fee,
// typed over. That loses two things the clinic needs. The X-ray stops being an
// X-ray, so no report can count how many were taken; and the change to the fee looks
// like a repricing of the root canal, which it is not.
//
// So an extra is its own row, priced from the clinic's list, sitting under the visit
// it happened at. A price of 0 is a real answer — "included in the course" — and it
// says so, because a blank and a decision must not look the same.
import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Plus, Sparkles, X } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { toast } from "@/components/ui/sonner";
import { AppError } from "@/lib/api-client";
import { addExtra, removeExtra, type Session } from "@/features/dental/api";
import { invalidateDental } from "@/features/dental/invalidate";
import { birr, num } from "@/features/dental/money";
import { RecordSection } from "@/features/dental/shared/RecordSection";
import { ServicePicker } from "@/features/dental/shared/ServicePicker";

const PAY_LABEL: Record<string, { text: string; variant: "success" | "warning" | "outline" }> = {
  paid: { text: "Paid", variant: "success" },
  billed: { text: "At cashier", variant: "warning" },
  waived: { text: "Written off", variant: "outline" },
};

/** Total of a visit's extras. Exported because the fee strip has to add them in. */
export function extrasTotal(session: Session) {
  return (session.extras ?? []).reduce((a, e) => a + num(e.amount_due), 0);
}

export function ExtrasSection({ patientId, session, editable }: {
  patientId: string;
  session: Session;
  /** Read-only on a finished visit that is being reviewed rather than recorded. */
  editable?: boolean;
}) {
  const qc = useQueryClient();
  const [adding, setAdding] = useState(false);
  const [picked, setPicked] = useState<{ id: string; name: string; price: string } | null>(null);
  const [price, setPrice] = useState("");

  const extras = session.extras ?? [];

  const add = useMutation({
    mutationFn: () => addExtra(patientId, session.id, {
      service_id: picked!.id,
      // Sent only when the dentist changed it, so the server prices from its own
      // list rather than trusting a number the browser worked out.
      amount: price.trim() === "" ? undefined : price.trim(),
    }),
    onSuccess: () => {
      toast.success(`${picked?.name} added to this visit`);
      setAdding(false); setPicked(null); setPrice("");
      invalidateDental(qc, patientId);
    },
    onError: (e) => toast.error(e instanceof AppError ? e.message : "Could not add it"),
  });

  const drop = useMutation({
    mutationFn: (id: string) => removeExtra(patientId, id),
    onSuccess: () => invalidateDental(qc, patientId),
    onError: (e) => toast.error(e instanceof AppError ? e.message : "Could not remove it"),
  });

  if (!editable && extras.length === 0) return null;

  return (
    <RecordSection
      icon={Sparkles} tone="media" title="Also done at this visit"
      hint="Anything the course did not plan for — an X-ray, a filling on another tooth."
      count={extras.length || undefined}
      action={editable && !adding ? (
        <Button variant="ghost" size="sm" className="h-7 px-2 text-xs" onClick={() => setAdding(true)}>
          <Plus className="h-3.5 w-3.5" /> Add
        </Button>
      ) : undefined}
    >
      <div className="space-y-2">
        {extras.map((ex) => {
          const free = num(ex.amount_due) < 0.005;
          const pay = PAY_LABEL[ex.payment];
          return (
            <div key={ex.id} className="flex flex-wrap items-center gap-2 rounded-md border bg-background px-3 py-2 text-sm">
              <span className="min-w-0 flex-1 truncate font-medium">{ex.service_name || "Procedure"}</span>
              {free
                ? <span className="text-xs text-muted-foreground">Included in the course</span>
                : <span className="tabular-nums font-semibold">{birr(ex.amount_due)}</span>}
              {pay && <Badge variant={pay.variant}>{pay.text}</Badge>}
              {editable && ex.payment === "unpaid" && (
                <button
                  onClick={() => drop.mutate(ex.id)}
                  disabled={drop.isPending}
                  title="Remove this extra"
                  className="rounded p-1 text-muted-foreground hover:bg-muted hover:text-destructive"
                >
                  <X className="h-3.5 w-3.5" />
                </button>
              )}
            </div>
          );
        })}

        {extras.length === 0 && !adding && (
          <p className="py-1 text-xs text-muted-foreground">Nothing extra — this visit is what the course planned.</p>
        )}

        {adding && (
          <div className="space-y-2 rounded-md border border-dashed p-3">
            <div className="space-y-1.5">
              <Label>Procedure</Label>
              <ServicePicker
                value={picked?.name ?? ""}
                selectedId={picked?.id}
                onPick={(s) => { setPicked(s); setPrice(s ? s.price : ""); }}
                // An extra has to be on the list — that is the whole point of it being
                // countable. The picker can still create one on the spot.
                onFreeText={() => toast.error("Pick it from the clinic's list, or add it to the list first")}
                placeholder="Choose a procedure"
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="extra-price">Charge (ETB)</Label>
              <Input id="extra-price" type="number" min={0} step="0.01" value={price}
                onChange={(e) => setPrice(e.target.value)} placeholder="0" />
              <p className="text-xs text-muted-foreground">
                {picked && num(price) < 0.005
                  ? <>Zero means <b className="text-foreground">included in the course</b> — recorded, not billed.</>
                  : picked && Math.abs(num(price) - num(picked.price)) > 0.5
                    ? <>The list says {birr(picked.price)}.</>
                    : <>Priced from the clinic's list. Change it if this patient's case is different.</>}
              </p>
            </div>
            <div className="flex justify-end gap-2">
              <Button variant="outline" size="sm" onClick={() => { setAdding(false); setPicked(null); setPrice(""); }}>
                Cancel
              </Button>
              <Button size="sm" disabled={!picked} loading={add.isPending} onClick={() => add.mutate()}>
                Add to this visit
              </Button>
            </div>
          </div>
        )}
      </div>
    </RecordSection>
  );
}
