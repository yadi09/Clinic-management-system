// A patient's money story, written for the person at the desk.
//
// The raw charge ledger is an accounting artifact: it carries cancelled bills,
// negative refund rows and words like "void" that mean nothing to a receptionist.
// This card translates it — four totals that answer the questions actually asked,
// a day-grouped timeline in plain language, cancelled noise folded away, and paper
// (receipt or statement) on demand.
import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { ChevronDown, FileText, Printer, RotateCcw } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import { useAuth } from "@/app/auth-context";
import { getClinic, listBranches } from "@/features/admin/api";
import { getPatient } from "@/features/patients/api";
import { patientCharges, type ChargeRow } from "@/features/billing/api";
import { printReceipt, printStatement } from "@/features/billing/print";

const num = (s?: string) => Number(s || 0);
const money = (v: string | number) => `${Number(v || 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ETB`;
const isRefund = (c: ChargeRow) => c.source === "refund" || num(c.amount) < 0;
const whenOf = (c: ChargeRow) => c.settled_at || c.created_at || "";
const dayOf = (c: ChargeRow) => whenOf(c).slice(0, 10);

/** Clinic language, not ledger language. */
function label(c: ChargeRow): { text: string; variant: "success" | "warning" | "outline" | "destructive"; hint?: string } {
  if (isRefund(c)) return { text: "Refunded", variant: "destructive", hint: "Money returned to the patient" };
  switch (c.status) {
    case "paid": return { text: "Paid", variant: "success" };
    case "pending": return { text: "Awaiting payment", variant: "warning", hint: "Sent to the cashier — not yet paid" };
    case "waived": return { text: "Free of charge", variant: "outline", hint: c.waive_reason || "Waived" };
    case "void": return { text: "Cancelled", variant: "outline", hint: "Bill withdrawn — the patient was never charged" };
    default: return { text: c.status, variant: "outline" };
  }
}

function dayHeading(iso: string) {
  if (!iso) return "Undated";
  const today = new Date();
  const t = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}-${String(today.getDate()).padStart(2, "0")}`;
  const y = new Date(today.getTime() - 86400000);
  const yStr = `${y.getFullYear()}-${String(y.getMonth() + 1).padStart(2, "0")}-${String(y.getDate()).padStart(2, "0")}`;
  if (iso === t) return "Today";
  if (iso === yStr) return "Yesterday";
  return new Date(`${iso}T00:00:00`).toLocaleDateString(undefined, { weekday: "short", day: "numeric", month: "short", year: "numeric" });
}

export function PaymentHistoryCard({ patientId }: { patientId: string }) {
  const { user } = useAuth();
  const q = useQuery({ queryKey: ["patient-charges", patientId], queryFn: () => patientCharges(patientId) });
  const patient = useQuery({ queryKey: ["patient", patientId], queryFn: () => getPatient(patientId) });
  const clinic = useQuery({ queryKey: ["clinic"], queryFn: getClinic, retry: false });
  const branches = useQuery({ queryKey: ["branches"], queryFn: listBranches });
  const [showCancelled, setShowCancelled] = useState(false);

  const all = q.data ?? [];

  // Money maths, stated once so the tiles, the list and the printed statement can
  // never disagree. Cancelled and waived bills are excluded from "charged": no
  // money was ever expected for them.
  const totals = useMemo(() => {
    let charged = 0, paidGross = 0, refunded = 0, awaiting = 0;
    for (const c of all) {
      if (isRefund(c)) { if (c.status === "paid") refunded += Math.abs(num(c.amount)); continue; }
      if (c.status === "paid") { charged += num(c.amount); paidGross += num(c.amount); }
      else if (c.status === "pending") { charged += num(c.amount); awaiting += num(c.amount); }
    }
    return { charged, paid: paidGross - refunded, refunded, awaiting };
  }, [all]);

  const cancelled = all.filter((c) => c.status === "void");
  const visible = showCancelled ? all : all.filter((c) => c.status !== "void");

  // Newest first, grouped by the day the money moved.
  const days = useMemo(() => {
    const m = new Map<string, ChargeRow[]>();
    for (const c of [...visible].sort((a, b) => whenOf(b).localeCompare(whenOf(a)))) {
      const k = dayOf(c);
      (m.get(k) ?? m.set(k, []).get(k)!).push(c);
    }
    return [...m.entries()];
  }, [visible]);

  const p = patient.data;
  const patientName = p ? [p.first_name, p.middle_name, p.last_name].filter(Boolean).join(" ") : "Patient";
  const clinicName = clinic.data?.name || "Clinic";
  const branch = (branches.data ?? [])[0];

  const receipt = (c: ChargeRow) =>
    printReceipt({
      clinic: clinicName, receiptNo: c.receipt_no, patient: patientName, mrn: p?.mrn,
      description: c.description, amount: c.amount, currency: c.currency,
      method: c.payment_method, cashier: user?.full_name, when: whenOf(c), refund: isRefund(c),
    });

  const statement = () =>
    printStatement({
      clinic: clinicName,
      clinicContact: branch ? [branch.address, branch.phone].filter(Boolean).join(" · ") || undefined : undefined,
      patient: patientName, mrn: p?.mrn, phone: p?.phone,
      currency: all[0]?.currency || "ETB",
      // A statement shows real money only — cancelled bills would overstate the account.
      lines: all
        .filter((c) => c.status !== "void")
        .sort((a, b) => whenOf(a).localeCompare(whenOf(b)))
        .map((c) => ({ date: dayOf(c), description: c.description, status: label(c).text, amount: c.amount })),
      charged: String(totals.charged), paid: String(totals.paid),
      refunded: String(totals.refunded), outstanding: String(totals.awaiting),
      issuedBy: user?.full_name,
    });

  return (
    <Card>
      <CardHeader className="flex-row flex-wrap items-center justify-between gap-2 space-y-0">
        <CardTitle>Payment history</CardTitle>
        {all.length > 0 && (
          <Button size="sm" variant="outline" onClick={statement}>
            <FileText className="h-4 w-4" /> Print statement
          </Button>
        )}
      </CardHeader>
      <CardContent className="space-y-4">
        {q.isLoading ? (
          <p className="text-sm text-muted-foreground">Loading…</p>
        ) : all.length === 0 ? (
          <p className="text-sm text-muted-foreground">Nothing has been billed to this patient yet.</p>
        ) : (
          <>
            {/* The four numbers the desk is asked for. */}
            <div className="grid gap-3 sm:grid-cols-4">
              <Tile label="Charged" value={totals.charged} hint="Billed in total" />
              <Tile label="Paid" value={totals.paid} tone="ok" hint={totals.refunded > 0 ? "After refunds" : "Received"} />
              <Tile label="Refunded" value={totals.refunded} tone={totals.refunded > 0 ? "danger" : "muted"} hint="Returned to patient" />
              <Tile label="Awaiting payment" value={totals.awaiting} tone={totals.awaiting > 0 ? "warn" : "muted"} hint="With the cashier" />
            </div>

            <div className="space-y-4">
              {days.map(([day, rows]) => (
                <div key={day}>
                  <div className="mb-1 flex items-baseline gap-2">
                    <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">{dayHeading(day)}</span>
                    <span className="h-px flex-1 bg-border" />
                  </div>
                  <div className="divide-y">
                    {rows.map((c) => {
                      const l = label(c);
                      const refund = isRefund(c);
                      const void_ = c.status === "void";
                      return (
                        <div key={c.id} className={cn("flex flex-wrap items-center gap-3 py-2 text-sm", void_ && "opacity-60")}>
                          {refund && <RotateCcw className="h-3.5 w-3.5 shrink-0 text-rose-500" />}
                          <div className="min-w-0 flex-1">
                            <div className={cn("truncate", void_ && "line-through")}>{c.description}</div>
                            <div className="text-xs text-muted-foreground">
                              {l.hint ? <span>{l.hint}</span> : <span className="capitalize">{c.source}</span>}
                              {c.payment_method ? ` · ${c.payment_method}` : ""}
                              {c.receipt_no ? ` · receipt RCP-${String(c.receipt_no).padStart(6, "0")}` : ""}
                            </div>
                          </div>
                          <Badge variant={l.variant}>{l.text}</Badge>
                          <span className={cn("w-28 text-right font-mono tabular-nums", refund ? "text-rose-600" : void_ ? "line-through" : "")}>
                            {money(c.amount)}
                          </span>
                          {c.status === "paid" ? (
                            <Button size="sm" variant="ghost" onClick={() => receipt(c)} title="Reprint this receipt">
                              <Printer className="h-3.5 w-3.5" /> Receipt
                            </Button>
                          ) : (
                            <span className="w-[5.6rem]" /> /* keep the money column aligned */
                          )}
                        </div>
                      );
                    })}
                  </div>
                </div>
              ))}
            </div>

            {cancelled.length > 0 && (
              <button type="button" onClick={() => setShowCancelled((s) => !s)}
                className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground hover:text-foreground">
                <ChevronDown className={cn("h-3.5 w-3.5 transition-transform", !showCancelled && "-rotate-90")} />
                {showCancelled ? "Hide" : "Show"} {cancelled.length} cancelled bill{cancelled.length === 1 ? "" : "s"}
                <span className="font-normal">· withdrawn before payment, nothing was charged</span>
              </button>
            )}
          </>
        )}
      </CardContent>
    </Card>
  );
}

function Tile({ label, value, tone = "muted", hint }: { label: string; value: number; tone?: "ok" | "warn" | "danger" | "muted"; hint: string }) {
  const colour = { ok: "text-emerald-600", warn: "text-amber-600", danger: "text-rose-600", muted: "text-brand" }[tone];
  return (
    <div className="rounded-lg border p-3">
      <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">{label}</p>
      <p className={cn("mt-0.5 text-lg font-bold tabular-nums", value === 0 ? "text-muted-foreground" : colour)}>{money(value)}</p>
      <p className="text-xs text-muted-foreground">{hint}</p>
    </div>
  );
}
