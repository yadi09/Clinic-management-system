// The corrections a visit needs after the fact.
//
// These lived on the deleted plan list's session row and had no replacement, which
// meant a dentist could record a visit but could not undo any of it: a fee typed
// wrong stayed wrong, a charge sent to the cashier by mistake could not be pulled
// back, a visit marked done in error stayed done, and a patient who was going to pay
// later had no way to be billed later.
//
// Kept behind a disclosure rather than on the face of the cockpit: these are repairs,
// not the everyday path, and putting them next to "Record today's work" is how the
// wrong one gets clicked.
import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { HandCoins, Settings2, Undo2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { toast } from "@/components/ui/sonner";
import { AppError } from "@/lib/api-client";
import { EthiopianDateInput } from "@/components/EthiopianDateInput";
import { useConfirmDialog } from "@/components/ConfirmDialog";
import { birr, isBillable } from "@/features/dental/money";
import { collectSession, setPayLater, uncollectSession, updateSession, type Session } from "@/features/dental/api";

const todayISO = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};

const STATUS: { value: string; label: string }[] = [
  { value: "planned", label: "Planned" },
  { value: "done", label: "Done" },
  { value: "cancelled", label: "Cancelled" },
];

export function VisitActions({ patientId, session, canCollect, editable, onChanged }: {
  patientId: string;
  session: Session;
  canCollect: boolean;
  editable: boolean;
  onChanged: () => void;
}) {
  const [open, setOpen] = useState(false);
  const { ask, dialog } = useConfirmDialog();
  const [amount, setAmount] = useState(session.amount_due);
  const [date, setDate] = useState(session.scheduled_date);
  const [promise, setPromise] = useState(session.pay_later_note ?? "");

  const run = (fn: () => Promise<unknown>, ok: string) => ({
    mutationFn: fn,
    onSuccess: () => { toast.success(ok); onChanged(); },
    onError: (e: unknown) => toast.error(e instanceof AppError ? e.message : "Could not do that"),
  });

  const setStatus = useMutation({
    mutationFn: (v: string) => updateSession(patientId, session.id, { status: v }),
    onSuccess: () => { toast.success("Visit updated"); onChanged(); },
    onError: (e) => toast.error(e instanceof AppError ? e.message : "Could not update the visit"),
  });
  const saveFee = useMutation(run(() => updateSession(patientId, session.id, { amount_due: amount }), "Fee updated"));
  const saveDate = useMutation(run(() => updateSession(patientId, session.id, { scheduled_date: date }), "Date updated"));
  const undo = useMutation(run(() => uncollectSession(patientId, session.id), "Pulled back from the cashier"));
  const bill = useMutation(run(() => collectSession(patientId, session.id), "Sent to the cashier"));
  const later = useMutation(run(() => setPayLater(patientId, session.id, { on: true, note: promise.trim() }), "Recorded as pay later"));
  const clearLater = useMutation(run(() => setPayLater(patientId, session.id, { on: false }), "Promise cleared"));

  if (!editable && !canCollect) return null;

  return (
    <div className="border-t pt-2">
      {dialog}
      <Button size="sm" variant="ghost" className="text-muted-foreground" onClick={() => setOpen((v) => !v)}>
        <Settings2 className="h-3.5 w-3.5" /> {open ? "Hide corrections" : "Correct this visit"}
      </Button>

      {open && (
        <div className="mt-2 space-y-3 rounded-md border bg-muted/30 p-3">
          {/* Money first: the two that cost real birr if they cannot be undone. */}
          <div className="flex flex-wrap items-center gap-2">
            {canCollect && session.payment === "billed" && (
              <Button size="sm" variant="outline" loading={undo.isPending} onClick={() => undo.mutate()}
                title="Pull this charge back from the cashier">
                <Undo2 className="h-3.5 w-3.5" /> Undo — pull back from the cashier
              </Button>
            )}
            {canCollect && isBillable(session) && (
              <Button size="sm" variant="outline" loading={bill.isPending} onClick={() => bill.mutate()}>
                <HandCoins className="h-3.5 w-3.5" /> Send {birr(session.amount_due)} to the cashier
              </Button>
            )}
            {session.pay_later && (
              <Button size="sm" variant="ghost" loading={clearLater.isPending} onClick={() => clearLater.mutate()}>
                Clear the pay-later promise
              </Button>
            )}
          </div>

          {editable && (
            <>
              <div className="grid gap-3 sm:grid-cols-2">
                <div className="space-y-1.5">
                  <Label className="text-xs">Status</Label>
                  <Select value={session.status} onValueChange={(v) => {
                    // Marking a not-yet-due visit done makes its fee owed immediately.
                    // Recording the visit is the intended path; this is the blunt one,
                    // so it asks rather than silently inventing a debt.
                    if (v === "done" && session.scheduled_date > todayISO()) {
                      ask({
                        title: "Mark a future visit as done?",
                        description: (
                          <>
                            This visit is booked for <b>{session.scheduled_date}</b>, not today. Marking it
                            done makes its {birr(session.amount_due)} fee owed straight away.
                          </>
                        ),
                        confirmLabel: "Mark it done",
                        destructive: true,
                      }, () => setStatus.mutateAsync(v));
                      return;
                    }
                    setStatus.mutate(v);
                  }}>
                    <SelectTrigger><SelectValue /></SelectTrigger>
                    <SelectContent>{STATUS.map((s) => <SelectItem key={s.value} value={s.value}>{s.label}</SelectItem>)}</SelectContent>
                  </Select>
                  <p className="text-xs text-muted-foreground">Marking a visit cancelled leaves its record intact.</p>
                </div>
                <div className="space-y-1.5">
                  <Label className="text-xs" htmlFor="vf-fee">Fee (ETB)</Label>
                  <div className="flex gap-2">
                    <Input id="vf-fee" type="number" min={0} value={amount} onChange={(e) => setAmount(e.target.value)} />
                    <Button size="sm" variant="outline" loading={saveFee.isPending}
                      disabled={amount === session.amount_due} onClick={() => saveFee.mutate()}>Save</Button>
                  </div>
                  {/* The server refuses this once a charge is live, and says why. */}
                  <p className="text-xs text-muted-foreground">Locked once the fee has been billed or paid.</p>
                </div>
              </div>

              <div className="space-y-1.5">
                <Label className="text-xs">Visit date</Label>
                <div className="flex flex-wrap items-end gap-2">
                  <div className="min-w-[14rem] flex-1"><EthiopianDateInput value={date} onChange={setDate} showAge={false} /></div>
                  <Button size="sm" variant="outline" loading={saveDate.isPending}
                    disabled={date === session.scheduled_date} onClick={() => saveDate.mutate()}>Save date</Button>
                </div>
              </div>

              {!session.pay_later && session.payment === "unpaid" && (
                <div className="space-y-1.5">
                  <Label className="text-xs" htmlFor="vf-promise">Patient will pay later</Label>
                  <div className="flex flex-wrap items-end gap-2">
                    <Input id="vf-promise" className="min-w-[14rem] flex-1" value={promise}
                      onChange={(e) => setPromise(e.target.value)} placeholder="Next visit · end of the month" />
                    <Button size="sm" variant="outline" loading={later.isPending} onClick={() => later.mutate()}>
                      Record the promise
                    </Button>
                  </div>
                </div>
              )}
              {session.pay_later && session.pay_later_note && (
                <p className="text-xs italic text-amber-800">Promised: “{session.pay_later_note}”</p>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}
