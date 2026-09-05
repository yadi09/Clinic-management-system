// The front desk.
//
// This page used to be a form you filled from nothing: to receive a patient you had
// to know their name and type it, choose a department from memory, choose a clinician
// from memory, and tick a fee. It never mentioned the appointment the clinic had
// booked weeks earlier — so an expected patient was processed as a walk-in, their
// booking stayed "booked" and counted as a no-show that evening, and the clinic's own
// rule that a doctor-booked follow-up is free inside its window could not fire,
// because that rule needs the appointment and this page never had one.
//
// So the page is inverted. The day is the surface: who is expected, who is waiting,
// who has been seen. Search is the fallback for everyone not on it. Each row carries
// the three things the desk could not previously see — how late, what they owe, and
// whether this visit is already covered — because each of those changes what happens
// next, and all three were invisible at the exact moment they mattered.
import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { CheckCircle2, HandCoins, Search, UserPlus, Users } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Segmented } from "@/components/ui/segmented";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Skeleton } from "@/components/ui/skeleton";
import { toast } from "@/components/ui/sonner";
import { cn } from "@/lib/utils";
import { AppError } from "@/lib/api-client";
import { useAuth } from "@/app/auth-context";
import { useDebounce } from "@/hooks/useDebounce";
import { useIsLargeScreen } from "@/hooks/useMediaQuery";
import { searchPatients, type PatientSummary } from "@/features/patients/api";
import { listDepartments, listProviders, getSettings } from "@/features/admin/api";
import {
  deferVisit, listServices, patientCharges, raiseCharge, settleVisit, waiveCharge, waiverReasons,
  type ServiceItem,
} from "@/features/billing/api";
import {
  EMPTY_PAYMENT, PaymentRailPicker, PaymentRefused, paymentBlocked, paymentIncomplete,
  usePaymentRails, type PaymentChoice,
} from "@/features/billing/PaymentRail";
import {
  checkInAppointment, receptionToday, walkIn, type ReceptionPatient,
} from "@/features/scheduling/api";
import { ArrivalRow, clock, coveredNow, day } from "@/features/scheduling/reception/ArrivalList";

type Lens = "expected" | "waiting" | "seen" | "settle";
const etb = (n: number | string) => `ETB ${Number(n || 0).toFixed(2)}`;

export function ReceptionPage() {
  const qc = useQueryClient();
  const { can } = useAuth();
  const canCollect = can("payment.collect");
  const [lens, setLens] = useState<Lens>("expected");
  const [search, setSearch] = useState("");
  const [picked, setPicked] = useState<ReceptionPatient | null>(null);
  // One of the two, never both: a Dialog portals its overlay to the body, so a sheet
  // hidden with `lg:hidden` still dimmed the desktop page behind the panel that was
  // already open beside the list.
  const wide = useIsLargeScreen();

  // The day, refetched while the desk watches it: a booking made on another screen,
  // or a patient the nurse just finished with, should appear without a reload.
  const today = useQuery({ queryKey: ["reception-today"], queryFn: receptionToday, refetchInterval: 30_000 });

  const debounced = useDebounce(search, 300);
  const found = useQuery({
    queryKey: ["reception-search", debounced],
    queryFn: () => searchPatients(debounced, 1, 12),
    enabled: debounced.trim().length >= 2,
  });

  const lists = today.data;
  // Treated, and still owing — the people about to walk out of the door.
  //
  // Letting a patient be seen before paying is the whole point of "pay later", but
  // it only works if somebody catches them on the way out. Without this the desk had
  // no list of who had been treated and not yet settled: the patient simply left, and
  // the charge became a debt nobody had decided to carry. "Seen" answers who was
  // treated; this answers who still owes for it.
  const settling = (lists?.seen ?? []).filter((r) => Number(r.owed || 0) > 0);
  const rows = (lens === "settle" ? settling : (lists?.[lens] ?? [])) as ReceptionPatient[];
  const searching = debounced.trim().length >= 2;

  // Someone found by search may already be in today's clinic.
  //
  // The reconciliation below only fires when the lists CHANGE, so a patient picked
  // out of search was shown as a fresh arrival even while she was sitting at the
  // chair — with the fee and the Collect button live. Pressing it took the money
  // again, and again: one patient was charged the registration fee seven times in a
  // day. The desk was not being careless; the screen said she had not arrived.
  const alreadyHere = (patientId: string): ReceptionPatient | undefined => {
    if (!lists) return undefined;
    // Waiting and Seen first: what she is doing now beats what she was booked for.
    return [...lists.waiting, ...lists.seen, ...lists.expected]
      .find((r) => r.patient_id === patientId);
  };

  // Keep the selected person in step with fresh data (their owed figure may change,
  // and once received they move from Expected to Waiting).
  useEffect(() => {
    if (!picked || !lists) return;
    const all = [...lists.expected, ...lists.waiting, ...lists.seen];
    const still = all.find((r) =>
      (picked.appointment_id && r.appointment_id === picked.appointment_id) ||
      (!picked.appointment_id && r.patient_id === picked.patient_id && !r.appointment_id));
    if (still) setPicked(still);
  }, [lists]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-h1">Reception</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Everyone booked today, everyone waiting. Search for anyone who is not on the list.
        </p>
      </div>

      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,26rem)] xl:grid-cols-[minmax(0,1fr)_minmax(0,30rem)]">
        {/* ---------------- the day ---------------- */}
        <Card>
          <CardContent className="space-y-3 p-4">
            <div className="flex flex-wrap items-center gap-2">
              <Segmented
                ariaLabel="Which patients"
                value={lens}
                onChange={(v) => setLens(v as Lens)}
                options={[
                  { value: "expected", label: "Expected", badge: lists?.expected.length ?? 0 },
                  { value: "waiting", label: "Waiting", badge: lists?.waiting.length ?? 0 },
                  { value: "seen", label: "Seen", badge: lists?.seen.length ?? 0 },
                  { value: "settle", label: "To settle", badge: settling.length },
                ]}
              />
            </div>

            <div className="flex gap-2">
              <div className="relative min-w-0 flex-1">
                <Search className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                <Input
                  className="pl-8"
                  placeholder="Search any patient — name, card number…"
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                />
              </div>
              <Button asChild variant="outline"><Link to="/patients?new=1"><UserPlus className="h-4 w-4" /> New</Link></Button>
            </div>

            {/* Search takes over the list while it has a term: the desk is looking for
                someone specific and the day is not the answer. */}
            {searching ? (
              <div className="space-y-2">
                <p className="text-xs text-muted-foreground">
                  {found.isFetching ? "Searching…" : `${found.data?.items.length ?? 0} matching`}
                </p>
                {(found.data?.items ?? []).map((p) => (
                  <button key={p.id} type="button"
                    onClick={() => { setPicked(alreadyHere(p.id) ?? asWalkIn(p)); setSearch(""); }}
                    className="w-full rounded-lg border p-3 text-left transition-colors hover:border-brand/40 hover:bg-accent/40 max-md:min-h-14">
                    <div className="flex flex-wrap items-baseline gap-x-2">
                      <span className="min-w-0 flex-1 truncate font-medium">{fullName(p)}</span>
                      <span className="font-mono text-xs text-muted-foreground">{p.mrn}</span>
                    </div>
                    <p className="mt-0.5 text-xs text-muted-foreground">
                      {p.gender}{p.dob ? ` · ${p.dob}` : ""}{p.phone ? ` · ${p.phone}` : ""}
                    </p>
                  </button>
                ))}
                {!found.isFetching && (found.data?.items.length ?? 0) === 0 && (
                  <p className="py-6 text-center text-sm text-muted-foreground">
                    Nobody matches. <Link to="/patients?new=1" className="font-medium text-brand underline">Register them</Link>.
                  </p>
                )}
              </div>
            ) : today.isLoading ? (
              <div className="space-y-2">{[0, 1, 2].map((i) => <Skeleton key={i} className="h-20 w-full" />)}</div>
            ) : rows.length === 0 ? (
              <p className="py-10 text-center text-sm text-muted-foreground">
                {lens === "expected" ? "Nobody booked today — search for a walk-in."
                  : lens === "settle" ? "Everyone treated today has paid."
                  : lens === "waiting" ? "Nobody is waiting."
                    : "Nobody has been seen yet today."}
              </p>
            ) : (
              <div className="space-y-2">
                {rows.map((p) => (
                  <ArrivalRow key={p.appointment_id || p.patient_id} p={p} lens={lens}
                    selected={picked?.patient_id === p.patient_id && picked?.appointment_id === p.appointment_id}
                    onPick={() => setPicked(p)} />
                ))}
              </div>
            )}
          </CardContent>
        </Card>

        {/* ---------------- the one person ---------------- */}
        {/* Desktop keeps the panel beside the list; below lg it becomes a sheet, so a
            phone is never scrolling a form to find the list it came from. */}
        <div className="max-lg:hidden">
          {wide && picked ? (
            <ReceivePanel key={panelKey(picked)} p={picked} canCollect={canCollect}
              onDone={() => { setPicked(null); qc.invalidateQueries({ queryKey: ["reception-today"] }); }} />
          ) : (
            <Card className="h-full border-dashed">
              <CardContent className="flex h-full min-h-[18rem] flex-col items-center justify-center gap-2 p-6 text-center">
                <Users className="h-8 w-8 text-muted-foreground/50" />
                <p className="text-sm font-medium">Pick someone from today's list</p>
                <p className="max-w-xs text-xs text-muted-foreground">
                  Or search for a walk-in. Everything you need to receive them appears here.
                </p>
              </CardContent>
            </Card>
          )}
        </div>
      </div>

      <Dialog open={!wide && !!picked} onOpenChange={(o) => !o && setPicked(null)}>
        <DialogContent fullOnMobile>
          <DialogHeader><DialogTitle>Receive patient</DialogTitle></DialogHeader>
          {!wide && picked && (
            <ReceivePanel key={panelKey(picked)} p={picked} canCollect={canCollect} bare
              onDone={() => { setPicked(null); qc.invalidateQueries({ queryKey: ["reception-today"] }); }} />
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}

/**
 * Receiving one patient: what it costs, where they go, and the one button that does it.
 *
 * A booked patient goes through the appointment's own check-in, which is what marks
 * the booking arrived, links the visit to it, and lets the covered-follow-up rule
 * fire. A walk-in keeps the path it always had.
 */
function ReceivePanel({ p, canCollect, onDone, bare }: {
  p: ReceptionPatient; canCollect: boolean; onDone: () => void; bare?: boolean;
}) {
  const qc = useQueryClient();
  const { can } = useAuth();
  const booked = !!p.appointment_id;
  const received = !!p.waiting_since;
  const covered = coveredNow(p);

  const settings = useQuery({ queryKey: ["settings"], queryFn: getSettings, retry: false });
  const departments = useQuery({ queryKey: ["departments"], queryFn: listDepartments });
  const providers = useQuery({ queryKey: ["providers"], queryFn: listProviders });
  const services = useQuery({ queryKey: ["services"], queryFn: () => listServices() });
  const reasons = useQuery({ queryKey: ["waiver-reasons"], queryFn: waiverReasons, enabled: canCollect });
  const rails = usePaymentRails();

  const triageRequired = !!settings.data?.triage_required;
  const [dept, setDept] = useState(p.department_id ?? "");
  const [provider, setProvider] = useState(p.provider_id ?? "");
  const [extras, setExtras] = useState<Record<string, boolean>>({});
  const [pay, setPay] = useState<PaymentChoice>(EMPTY_PAYMENT);
  const [waiveOpen, setWaiveOpen] = useState(false);
  const [deferOpen, setDeferOpen] = useState(false);
  const [waiveReason, setWaiveReason] = useState("");

  useEffect(() => {
    const first = rails.data?.[0];
    if (first && !pay.railId) setPay({ railId: first.id, method: first.key, reference: "" });
  }, [rails.data, pay.railId]);

  // What this visit costs is what the server will actually raise: the clinic's
  // DEFAULT services. (The card fee is a separate, older concept — reading it here
  // showed "ETB 0.00" for a patient who owes the 100 ETB registration fee.) Coverage
  // waives exactly those, which is the rule RaiseIntakeChargesTx applies.
  const defaults = useMemo(
    () => (services.data ?? []).filter((s: ServiceItem) => s.is_default),
    [services.data],
  );
  const chosenExtras = useMemo(
    () => (services.data ?? []).filter((s: ServiceItem) => extras[s.id] && !s.is_default),
    [services.data, extras],
  );
  const extrasTotal = chosenExtras.reduce((a, s) => a + (parseFloat(s.price) || 0), 0);
  const feeDue = covered ? 0 : defaults.reduce((a, s) => a + (parseFloat(s.price) || 0), 0);
  const total = feeDue + extrasTotal;
  const routeReady = !!dept && (triageRequired || !!provider || booked);
  const mustPay = total > 0.005;
  const blocked = mustPay && canCollect && paymentIncomplete(rails.data, pay);
  // The bank contradicts this transfer — most often because it reached somebody
  // else's account. The desk must not be able to press on: the server refuses it, and
  // finding that out after telling the patient they are done is worse than not
  // offering it. Overriding is a manager's decision, recorded against their name.
  const refused = mustPay && canCollect && paymentBlocked(pay);
  // Everything this patient still owes — what the desk collects on the way out.
  const outstanding = Number(p.owed || 0);
  const settleOwed = useMutation({
    mutationFn: (force: boolean) => settleVisit(p.patient_id, {
      rail_id: pay.railId || undefined, method: pay.method, reference: pay.reference, force,
    }),
    onSuccess: () => {
      toast.success(`${p.name}: ${etb(outstanding)} collected`);
      qc.invalidateQueries({ queryKey: ["reception-today"] });
      qc.invalidateQueries({ queryKey: ["pending-charges"] });
      onDone();
    },
    onError: (e) => toast.error(e instanceof AppError ? e.message : "Could not take the payment"),
  });
  const canOverride = can("payment.waive");

  const receive = useMutation({
    mutationFn: async ({ mode, force }: { mode: "collect" | "cashier"; force?: boolean }) => {
      const routing = {
        to_triage: triageRequired,
        provider_id: !triageRequired && provider ? provider : undefined,
        // Carried for appointments booked before a department was required: the
        // server uses it only when the appointment has none, so it can never
        // reroute a patient away from where they were actually booked.
        department_id: dept || undefined,
      };
      // Only what THIS arrival raised gets collected. A patient who also owes 1,200
      // from last month must not have it swept into a receipt for a 300 ETB visit.
      const mine: string[] = [];
      if (booked) {
        // The appointment's own door: marks it arrived and applies the
        // covered-follow-up rule that reception could never reach.
        const res = await checkInAppointment(p.appointment_id!, routing);
        mine.push(...res.charge_ids);
      } else {
        // The other door, and it is taken UNCONDITIONALLY. It used to be skipped
        // whenever a fee was due, because it reported no charge ids to collect
        // against — so a patient found by search who owed the registration fee was
        // neither charged nor queued. The desk pressed Collect, nothing happened, and
        // they never appeared at the cashier.
        const res = await walkIn({ patient_id: p.patient_id, ...routing, department_id: dept });
        mine.push(...res.charge_ids);
      }
      for (const s of chosenExtras) {
        const { id: cid } = await raiseCharge({
          patient_id: p.patient_id, service_item_id: s.id, source: "consultation",
          description: s.name, amount: parseFloat(s.price) || 0,
          ...routing, department_id: dept || undefined,
        });
        mine.push(cid);
      }
      if (mode === "collect" && mine.length > 0) {
        await settleVisit(p.patient_id, {
          rail_id: pay.railId || undefined, method: pay.method, reference: pay.reference,
          charge_ids: mine, force,
        });
      }
    },
    onSuccess: (_d, { mode }) => {
      toast.success(mode === "collect" && mustPay
        ? `${p.name}: ${etb(total)} collected · sent through`
        : mustPay ? `${p.name} sent to the cashier` : `${p.name} checked in`);
      qc.invalidateQueries({ queryKey: ["reception-today"] });
      qc.invalidateQueries({ queryKey: ["pending-charges"] });
      qc.invalidateQueries({ queryKey: ["queue"] });
      onDone();
    },
    onError: (e) => toast.error(e instanceof AppError ? e.message : "Could not receive this patient"),
  });

  const body = (
    <div className="space-y-4">
      {/* who */}
      <div>
        <div className="flex flex-wrap items-baseline gap-x-2">
          <h2 className="text-lg font-semibold">{p.name}</h2>
          <span className="font-mono text-xs text-muted-foreground">{p.mrn}</span>
        </div>
        <p className="mt-0.5 text-sm text-muted-foreground">
          {p.age > 0 && `${p.age}y`}{p.sex ? ` · ${p.sex}` : ""}
          {p.phone && <> · <a href={`tel:${p.phone}`} className="hover:underline">{p.phone}</a></>}
        </p>
        {booked && p.starts_at && (
          <p className="mt-1 text-sm">
            Booked <b>{clock(p.starts_at)}</b>
            {p.provider_name && <> with <b>{p.provider_name}</b></>}
            {p.reason && <span className="text-muted-foreground"> · {p.reason}</span>}
          </p>
        )}
      </div>

      {received ? (
        <div className="space-y-3">
          <div className="rounded-md border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-900">
            Already received — waiting since {clock(p.waiting_since!)}
            {p.department_name && ` for ${p.department_name}`}.
          </div>

          {/* Settling on the way out.
              A patient treated on "pay later" has to be caught before they leave, and
              this panel used to end at the green box — the desk could see they owed
              money and had no way to take it without going to the cashier page and
              finding them again. */}
          {outstanding > 0.005 && canCollect && (
            <div className="space-y-2 rounded-lg border border-l-4 border-l-destructive bg-destructive/5 p-3">
              <p className="text-sm font-semibold text-destructive">
                {etb(outstanding)} still to pay
              </p>
              <p className="text-xs text-muted-foreground">
                {p.owed_agreed
                  ? "Agreed to be billed later — take it now if they can settle before leaving."
                  : "Not yet collected. Take it before they leave."}
              </p>
              <PaymentRailPicker rails={rails.data} value={pay} onChange={setPay}
                expected={outstanding.toFixed(2)} patientId={p.patient_id} compact />
              {paymentBlocked(pay) ? (
                <PaymentRefused canOverride={canOverride} pending={settleOwed.isPending}
                  onForce={() => settleOwed.mutate(true)} />
              ) : (
                <Button className="w-full" loading={settleOwed.isPending}
                  disabled={paymentIncomplete(rails.data, pay)}
                  onClick={() => settleOwed.mutate(false)}>
                  <HandCoins className="h-4 w-4" /> Collect {etb(outstanding)}
                </Button>
              )}
            </div>
          )}
        </div>
      ) : (
        <>
          {/* what it costs */}
          {covered ? (
            <div className="rounded-md border border-emerald-200 bg-emerald-50 px-3 py-2.5">
              <p className="flex items-center gap-1.5 text-sm font-semibold text-emerald-900">
                <CheckCircle2 className="h-4 w-4" /> No fee — covered follow-up
              </p>
              <p className="mt-0.5 text-xs text-emerald-800">
                The doctor booked this follow-up; it is free until {day(p.free_until!)}. Nothing to take.
              </p>
            </div>
          ) : canCollect ? (
            <FeeBlock defaults={defaults} extrasTotal={extrasTotal} total={total} />
          ) : null}

          {/* anything extra done at the desk */}
          {canCollect && (services.data?.length ?? 0) > 0 && (
            <details className="rounded-md border px-3 py-2">
              <summary className="cursor-pointer text-sm font-medium">
                Add a service{chosenExtras.length > 0 && ` · ${chosenExtras.length} added`}
              </summary>
              <div className="mt-2 space-y-1">
                {(services.data ?? []).map((s: ServiceItem) => (
                  <label key={s.id} className="flex cursor-pointer items-center gap-2 rounded px-1 py-1.5 text-sm hover:bg-muted/50 max-md:min-h-10">
                    <input type="checkbox" checked={!!extras[s.id]}
                      onChange={(e) => setExtras((x) => ({ ...x, [s.id]: e.target.checked }))} />
                    <span className="min-w-0 flex-1 truncate">{s.name}</span>
                    <span className="shrink-0 font-mono text-xs">{etb(s.price)}</span>
                  </label>
                ))}
              </div>
            </details>
          )}

          {/* Old debt: surfaced, never folded into today's payment. Money the clinic
              AGREED to be owed is not the same fact as a charge nobody collected —
              one is a plan, the other is a surprise — so they do not look alike. */}
          {Number(p.owed || 0) > 0 && (
            <div className={cn("flex flex-wrap items-center gap-2 rounded-md border px-3 py-2 text-sm",
              p.owed_agreed ? "border-sky-200 bg-sky-50 text-sky-900" : "border-amber-200 bg-amber-50 text-amber-900")}>
              <span className="min-w-0 flex-1">
                {p.owed_agreed ? <>Being billed later — <b>{etb(p.owed!)}</b> agreed</>
                  : <>Owes <b>{etb(p.owed!)}</b> from earlier visits</>}
                {p.owed_oldest_days ? ` · oldest ${p.owed_oldest_days} days` : ""}
              </span>
              <Button asChild size="sm" variant="outline"><Link to="/cashier">See it</Link></Button>
            </div>
          )}

          {/* where they go */}
          <div className="grid gap-2 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label className="text-xs text-muted-foreground">Department</Label>
              <Select value={dept} onValueChange={setDept}>
                <SelectTrigger><SelectValue placeholder="Choose" /></SelectTrigger>
                <SelectContent>
                  {(departments.data ?? []).map((d) => <SelectItem key={d.id} value={d.id}>{d.name}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
            {!triageRequired && (
              <div className="space-y-1.5">
                <Label className="text-xs text-muted-foreground">Clinician</Label>
                <Select value={provider} onValueChange={setProvider}>
                  <SelectTrigger><SelectValue placeholder={booked ? p.provider_name || "Choose" : "Choose"} /></SelectTrigger>
                  <SelectContent>
                    {(providers.data ?? []).map((u) => <SelectItem key={u.id} value={u.id}>{u.full_name}</SelectItem>)}
                  </SelectContent>
                </Select>
              </div>
            )}
          </div>
          {triageRequired && (
            <p className="text-xs text-muted-foreground">This clinic sends every patient through triage first.</p>
          )}

          {/* how they pay */}
          {mustPay && canCollect && (
            <div className="space-y-1.5">
              <Label className="text-xs text-muted-foreground">Payment</Label>
              <PaymentRailPicker rails={rails.data} value={pay} onChange={setPay}
                expected={total.toFixed(2)} patientId={p.patient_id} compact />
            </div>
          )}

          {/* the exits, named for what they do */}
          <div className="space-y-2">
            {refused ? (
              <PaymentRefused canOverride={canOverride} pending={receive.isPending}
                onForce={() => receive.mutate({ mode: "collect", force: true })} />
            ) : (
              <Button className="w-full" disabled={!routeReady || blocked} loading={receive.isPending}
                onClick={() => receive.mutate({ mode: "collect" })}>
                {mustPay ? <><HandCoins className="h-4 w-4" /> Collect {etb(total)} & send through</>
                  : <><CheckCircle2 className="h-4 w-4" /> Check in</>}
              </Button>
            )}
            {mustPay && (
              <div className="flex gap-2">
                {/* Always available: a contradicted transfer is a reason to send the
                    patient to the cashier with the charge standing, not to turn them
                    away. Nothing is marked paid on this path. */}
                <Button variant="outline" className="flex-1" disabled={!routeReady} loading={receive.isPending}
                  onClick={() => receive.mutate({ mode: "cashier" })}>Send to cashier</Button>
                {canOverride && (
                  <Button variant="ghost" onClick={() => setDeferOpen(true)}
                    title="Let them be seen now and settle later — the debt stays on the record">
                    Pay later…
                  </Button>
                )}
                {canCollect && (
                  <Button variant="ghost" onClick={() => setWaiveOpen(true)}>Waive…</Button>
                )}
              </div>
            )}
          </div>
        </>
      )}

      <DeferDialog open={deferOpen} onClose={() => setDeferOpen(false)} patient={p} total={total}
        onDone={() => { setDeferOpen(false); onDone(); }} />
      <WaiveDialog open={waiveOpen} onClose={() => setWaiveOpen(false)} reasons={reasons.data ?? []}
        value={waiveReason} onChange={setWaiveReason} patient={p} onDone={onDone} />
    </div>
  );

  if (bare) return body;
  return <Card><CardContent className="p-4">{body}</CardContent></Card>;
}

/** What this visit costs, line by line — the same services the server will raise. */
function FeeBlock({ defaults, extrasTotal, total }: { defaults: ServiceItem[]; extrasTotal: number; total: number }) {
  if (defaults.length === 0 && extrasTotal <= 0) {
    return (
      <div className="rounded-md border bg-muted/40 px-3 py-2 text-sm">
        <p className="font-medium">No fee for this visit</p>
        <p className="mt-0.5 text-xs text-muted-foreground">This clinic charges nothing to be seen.</p>
      </div>
    );
  }
  return (
    <div className="rounded-md border px-3 py-2">
      {defaults.map((s) => (
        <div key={s.id} className="flex items-baseline justify-between gap-2 text-sm">
          <span className="min-w-0 truncate text-muted-foreground">{s.name}</span>
          <span className="shrink-0 font-mono">{etb(s.price)}</span>
        </div>
      ))}
      {extrasTotal > 0 && (
        <div className="mt-1 flex items-baseline justify-between gap-2 text-sm">
          <span className="text-muted-foreground">Added services</span>
          <span className="font-mono">{etb(extrasTotal)}</span>
        </div>
      )}
      <div className="mt-1.5 flex items-baseline justify-between gap-2 border-t pt-1.5 text-sm font-semibold">
        <span>Total</span><span className="font-mono">{etb(total)}</span>
      </div>
    </div>
  );
}

/** Free, on purpose, with a reason — the only way a visit costs nothing without payment. */
/** Treat now, bill later.
 *
 *  Deliberately not the waiver dialog with different words. Waiving says the money is
 *  gone; this says it is still owed and the clinic has agreed to wait — so the reason
 *  is compulsory, it is kept against the charges, and the copy is explicit that the
 *  patient still owes it. A clinic treating a staff member's child or someone brought
 *  in bleeding was previously forced to choose between writing the money off and
 *  turning them away. */
function DeferDialog({ open, onClose, patient, total, onDone }: {
  open: boolean; onClose: () => void; patient: ReceptionPatient; total: number; onDone: () => void;
}) {
  const [reason, setReason] = useState("");
  const REASONS = ["Emergency — treat first", "Staff or dependent", "Known patient — settles monthly",
    "Insurance / company account", "Cannot pay today", "Other"];
  const defer = useMutation({
    mutationFn: () => deferVisit(patient.patient_id, { reason }),
    onSuccess: (r) => {
      toast.success(`${patient.name} can be seen now — ${r.deferred} charge${r.deferred === 1 ? "" : "s"} still owed`);
      onDone();
    },
    onError: (e) => toast.error(e instanceof AppError ? e.message : "Could not defer this visit"),
  });
  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent fullOnMobile className="max-w-md">
        <DialogHeader><DialogTitle>Treat now, pay later</DialogTitle></DialogHeader>
        <p className="text-sm text-muted-foreground">
          {patient.name} will be sent through without paying. The <b>{etb(total)}</b> stays owed,
          stays at the cashier and appears in the debt report — it is not written off.
        </p>
        <div className="space-y-1.5">
          <Label className="text-xs text-muted-foreground">Why? (kept on the record)</Label>
          <Select value={reason} onValueChange={setReason}>
            <SelectTrigger><SelectValue placeholder="Choose a reason" /></SelectTrigger>
            <SelectContent>
              {REASONS.map((r) => <SelectItem key={r} value={r}>{r}</SelectItem>)}
            </SelectContent>
          </Select>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>Cancel</Button>
          <Button disabled={!reason} loading={defer.isPending} onClick={() => defer.mutate()}>
            Send through, bill later
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function WaiveDialog({ open, onClose, reasons, value, onChange, patient, onDone }: {
  open: boolean; onClose: () => void; reasons: string[]; value: string;
  onChange: (s: string) => void; patient: ReceptionPatient; onDone: () => void;
}) {
  const qc = useQueryClient();
  const waive = useMutation({
    mutationFn: async () => {
      const ledger = await patientCharges(patient.patient_id);
      const open = ledger.rows.filter((c) => c.status === "pending");
      for (const c of open) await waiveCharge(c.id, value);
    },
    onSuccess: () => {
      toast.success(`${patient.name}: fee waived`);
      qc.invalidateQueries({ queryKey: ["reception-today"] });
      onClose(); onDone();
    },
    onError: (e) => toast.error(e instanceof AppError ? e.message : "Could not waive it"),
  });
  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader><DialogTitle>Waive the fee for {patient.name}?</DialogTitle></DialogHeader>
        <p className="text-sm text-muted-foreground">
          Recorded as a decision, with your name and the reason — not as a bill nobody raised.
        </p>
        <div className="space-y-1.5">
          <Label htmlFor="waive-why">Reason</Label>
          <Select value={value} onValueChange={onChange}>
            <SelectTrigger id="waive-why"><SelectValue placeholder="Why is this free?" /></SelectTrigger>
            <SelectContent>
              {reasons.map((r) => <SelectItem key={r} value={r}>{r}</SelectItem>)}
            </SelectContent>
          </Select>
        </div>
        <div className="flex justify-end gap-2">
          <Button variant="outline" onClick={onClose}>Cancel</Button>
          <Button disabled={!value} loading={waive.isPending} onClick={() => waive.mutate()}>Waive the fee</Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

/** A patient found by search has no booking — they are a walk-in until told otherwise. */
function asWalkIn(p: PatientSummary): ReceptionPatient {
  return {
    patient_id: p.id, name: fullName(p), mrn: p.mrn, age: ageOf(p.dob), sex: p.gender, phone: p.phone,
    is_followup: false, late_minutes: 0,
  };
}

const fullName = (p: PatientSummary) => [p.first_name, p.last_name].filter(Boolean).join(" ");
function ageOf(dob?: string) {
  if (!dob) return 0;
  const d = new Date(dob);
  return Math.max(0, Math.floor((Date.now() - d.getTime()) / (365.25 * 864e5)));
}

const panelKey = (p: ReceptionPatient) => `${p.patient_id}:${p.appointment_id ?? "walkin"}`;
