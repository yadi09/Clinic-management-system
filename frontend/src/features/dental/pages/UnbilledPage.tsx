// Treatment given, never billed.
//
// This page is the other half of a decision. The dental workspace used to refuse to
// record a clinical visit until money had moved; that gate was removed because the
// clinic's rule is that a patient may be treated on a promise to pay, and because a
// control defeated by typing one character into a note is not a control.
//
// What makes the removal safe is that nothing is quietly forgotten instead. So this
// exists, and it is deliberately blunt: one list, oldest first, with the phone number
// right there — because the useful version of this report is the one someone can act
// on between patients, not one that needs a spreadsheet afterwards.
//
// Three lanes, never summed into a single headline, because they need three
// different actions:
//   never billed    nobody raised a charge      -> send it to the cashier
//   bill withdrawn  the cashier voided it       -> send it again
//   refunded        paid, then given back       -> bill again, or write it off
import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "react-router-dom";
import { AlertTriangle, HandCoins, Phone, Receipt, Undo2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Segmented } from "@/components/ui/segmented";
import { toast } from "@/components/ui/sonner";
import { cn } from "@/lib/utils";
import { AppError } from "@/lib/api-client";
import { useAuth } from "@/app/auth-context";
import { DualDate } from "@/components/DualDate";
import { birr } from "@/features/dental/money";
import { collectSession, unbilledTreatment, type UnbilledLane, type UnbilledRow } from "@/features/dental/api";

const LANE: Record<UnbilledLane, { label: string; hint: string; tone: string }> = {
  never_billed: {
    label: "Never billed",
    hint: "Treatment was recorded and no charge was ever raised.",
    tone: "border-l-destructive",
  },
  bill_withdrawn: {
    label: "Bill withdrawn",
    hint: "A charge existed and was voided at the cashier. The treatment still stands.",
    tone: "border-l-amber-500",
  },
  refunded: {
    label: "Refunded",
    hint: "Paid, then given back. The treatment was still delivered, so it is owed again.",
    tone: "border-l-amber-500",
  },
};

type Lens = "all" | UnbilledLane;

/** Ageing is the whole point of the report, so it is stated, not implied by a date. */
function ageTone(days: number) {
  if (days >= 30) return "bg-destructive text-destructive-foreground";
  if (days >= 7) return "bg-amber-500 text-white";
  return "bg-muted text-muted-foreground";
}

export function UnbilledPage() {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const { can } = useAuth();
  const canCollect = can("payment.charge") || can("dental.manage");
  const [lens, setLens] = useState<Lens>("all");

  const q = useQuery({ queryKey: ["dental-unbilled"], queryFn: () => unbilledTreatment({ limit: 200 }) });
  const data = q.data;
  const rows = (data?.rows ?? []).filter((r) => lens === "all" || r.lane === lens);

  const collect = useMutation({
    mutationFn: (r: UnbilledRow) => collectSession(r.patient_id, r.session_id),
    onSuccess: () => {
      toast.success("Sent to the cashier");
      qc.invalidateQueries({ queryKey: ["dental-unbilled"] });
      qc.invalidateQueries({ queryKey: ["dental-outstanding"] });
      qc.invalidateQueries({ queryKey: ["pending-charges"] });
    },
    onError: (e) => toast.error(e instanceof AppError ? e.message : "Could not send it to the cashier"),
  });

  const count = (l: UnbilledLane) => (data?.rows ?? []).filter((r) => r.lane === l).length;
  // When a lane is selected the headline must describe THAT lane, not the whole
  // report — a header reading 11,500 over rows totalling 4,000 is a number nobody
  // can reconcile. Unfiltered, the server's total is authoritative because it covers
  // rows beyond this page.
  const filtered = lens !== "all";
  const shownTotal = filtered ? rows.reduce((a, r) => a + Number(r.amount || 0), 0) : Number(data?.total ?? 0);
  const shownCount = filtered ? rows.length : (data?.count ?? 0);
  const oldest = rows.length > 0 ? Math.max(...rows.map((r) => r.days_unbilled)) : 0;

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-h1">Unbilled treatment</h1>
        <p className="mt-1 max-w-2xl text-sm text-muted-foreground">
          Treatment that was delivered and never paid for. A patient can be treated on a promise to
          pay — this is what makes sure the promise is not forgotten.
        </p>
      </div>

      {q.isLoading ? (
        <Skeleton className="h-40 w-full" />
      ) : q.isError ? (
        <Card><CardContent className="p-6 text-sm text-destructive">Could not load the report.</CardContent></Card>
      ) : (
        <>
          <div className="grid gap-4 sm:grid-cols-3">
            <Card className={cn(shownTotal > 0 && "border-destructive")}>
              <CardContent className="p-4">
                <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Owed for treatment given</p>
                <p className="mt-1 text-3xl font-bold tabular-nums text-destructive">{birr(shownTotal)}</p>
                <p className="mt-1 text-xs text-muted-foreground">
                  across {shownCount} visit{shownCount === 1 ? "" : "s"}
                  {filtered && <span> · {LANE[lens as UnbilledLane].label.toLowerCase()} only</span>}
                </p>
              </CardContent>
            </Card>
            <Card>
              <CardContent className="p-4">
                <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Oldest</p>
                <p className="mt-1 text-3xl font-bold tabular-nums">
                  {oldest}
                  <span className="ml-1 text-base font-normal text-muted-foreground">days</span>
                </p>
                <p className="mt-1 text-xs text-muted-foreground">since the treatment was given</p>
              </CardContent>
            </Card>
            <Card>
              <CardContent className="p-4">
                <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Promised, not yet given</p>
                <p className="mt-1 text-3xl font-bold tabular-nums text-muted-foreground">{birr(data?.promised_total)}</p>
                {/* Kept out of the headline on purpose: billing these would charge a
                    patient for a visit that has not happened. */}
                <p className="mt-1 text-xs text-muted-foreground">
                  {data?.promised_count ?? 0} booked with a pay-later note — not billable yet
                </p>
              </CardContent>
            </Card>
          </div>

          <Card>
            <CardHeader className="flex-row flex-wrap items-center justify-between gap-2 space-y-0">
              <CardTitle>What is owed</CardTitle>
              <Segmented
                ariaLabel="Filter by why it is unbilled"
                value={lens}
                onChange={(v) => setLens(v as Lens)}
                options={[
                  { value: "all", label: "All", badge: data?.rows.length ?? 0 },
                  { value: "never_billed", label: "Never billed", badge: count("never_billed") },
                  { value: "bill_withdrawn", label: "Bill withdrawn", badge: count("bill_withdrawn") },
                  { value: "refunded", label: "Refunded", badge: count("refunded") },
                ]}
              />
            </CardHeader>
            <CardContent className="space-y-2">
              {rows.length === 0 ? (
                <p className="py-10 text-center text-sm text-muted-foreground">
                  {lens === "all"
                    ? "Nothing outstanding — every treatment given has been billed."
                    : "Nothing in this category."}
                </p>
              ) : (
                rows.map((r) => (
                  <div key={r.session_id} className={cn("rounded-lg border border-l-4 p-3", LANE[r.lane].tone)}>
                    <div className="flex flex-wrap items-start gap-x-3 gap-y-1">
                      <div className="min-w-0 flex-1">
                        <div className="flex flex-wrap items-center gap-2">
                          <button
                            type="button"
                            onClick={() => navigate(`/patients/${r.patient_id}?visit=${r.session_id}`)}
                            className="font-medium text-brand hover:underline"
                          >
                            {r.patient_name}
                          </button>
                          <span className="text-xs text-muted-foreground tabular-nums">{r.mrn}</span>
                          <Badge variant="outline">{LANE[r.lane].label}</Badge>
                          <span className={cn("rounded-full px-2 py-0.5 text-[11px] font-semibold tabular-nums", ageTone(r.days_unbilled))}>
                            {r.days_unbilled} days
                          </span>
                        </div>
                        <p className="mt-0.5 text-sm">
                          {r.plan_title} · session {r.seq} of {r.session_count}
                          {r.procedure && <span className="text-muted-foreground"> · {r.procedure}</span>}
                          {r.tooth && <span className="text-muted-foreground"> · {r.tooth}</span>}
                        </p>
                        <p className="mt-0.5 text-xs text-muted-foreground">
                          <DualDate iso={r.treatment_date} />
                          {r.clinician && ` · ${r.clinician}`}
                          {r.branch && ` · ${r.branch}`}
                        </p>
                        {r.pay_later_note && (
                          <p className="mt-1 text-xs italic text-amber-800">“{r.pay_later_note}”</p>
                        )}
                      </div>
                      <div className="flex shrink-0 flex-col items-end gap-1.5">
                        <span className="text-lg font-bold tabular-nums">{birr(r.amount)}</span>
                        <div className="flex flex-wrap justify-end gap-1.5">
                          {r.phone && (
                            <a href={`tel:${r.phone}`} className="inline-flex items-center gap-1 rounded-md border px-2 py-1 text-xs font-medium hover:bg-accent">
                              <Phone className="h-3 w-3" /> {r.phone}
                            </a>
                          )}
                          {canCollect && (
                            <Button size="sm" loading={collect.isPending && collect.variables?.session_id === r.session_id}
                              onClick={() => collect.mutate(r)}>
                              {r.lane === "refunded"
                                ? <><Undo2 className="h-3.5 w-3.5" /> Bill again</>
                                : <><HandCoins className="h-3.5 w-3.5" /> Send to cashier</>}
                            </Button>
                          )}
                        </div>
                      </div>
                    </div>
                  </div>
                ))
              )}
              {data?.has_more && (
                <p className="pt-2 text-center text-xs text-muted-foreground">
                  Showing the oldest {data.rows.length} of {data.count}. Narrow the dates to see the rest.
                </p>
              )}
            </CardContent>
          </Card>

          <p className="flex items-start gap-2 text-xs text-muted-foreground">
            <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            Sending a visit to the cashier raises a charge against the patient. It does not take
            payment — the desk still settles it. <Receipt className="h-3.5 w-3.5" />
          </p>
        </>
      )}
    </div>
  );
}
