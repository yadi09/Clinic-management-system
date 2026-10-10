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
import { invalidateDental } from "@/features/dental/invalidate";
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
  deferVisit, getRegistrationStatus, listServices, settleVisit, waiveCharge, waiverReasons,
  type RegistrationStatus, type ServiceItem,
} from "@/features/billing/api";
import { statusLine } from "@/features/billing/registration";
import {
  EMPTY_PAYMENT, PaymentRailPicker, PaymentRefused, paymentBlocked, paymentIncomplete,
  usePaymentRails, type PaymentChoice,
} from "@/features/billing/PaymentRail";
import {
  checkInAppointment, getReceptionCard, receptionToday, walkIn, type ReceptionPatient,
} from "@/features/scheduling/api";
import { ArrivalRow, clock, coveredNow, day } from "@/features/scheduling/reception/ArrivalList";
import {
  CardSkeleton, TodaySection, UnpaidBills, VisitsSection,
} from "@/features/scheduling/reception/PatientCard";

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
  // Unbilled dental treatment counts too: it is not at the cashier yet, so "owed"
  // alone let a patient leave with it unbilled (audit D10).
  const settling = (lists?.seen ?? []).filter((r) => Number(r.owed || 0) > 0 || Number(r.unbilled || 0) > 0.005);
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
    // In-progress first: what they are doing now beats what they were booked for,
    // and a finished visit beats nothing at all — it still carries what they owe.
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
  // Still in the clinic, as opposed to seen and gone. A finished visit is not an
  // arrival to be received again, but it is not a reason to refuse a patient who
  // genuinely has to go back — after a lab result, say — so the panel stays usable.
  const received = !!p.waiting_since && !p.finished;
  const seenToday = !!p.waiting_since && !!p.finished;
  const covered = coveredNow(p);

  const settings = useQuery({ queryKey: ["settings"], queryFn: getSettings, retry: false });
  const departments = useQuery({ queryKey: ["departments"], queryFn: listDepartments });
  const providers = useQuery({ queryKey: ["providers"], queryFn: listProviders });
  const services = useQuery({ queryKey: ["services"], queryFn: () => listServices() });
  // Whether THIS patient owes registration at this arrival, by the clinic's rule
  // (once / again after a period): the server decides the same way when it charges.
  const registration = useQuery({
    queryKey: ["registration-status", p.patient_id],
    queryFn: () => getRegistrationStatus(p.patient_id),
    retry: false,
  });
  const reasons = useQuery({ queryKey: ["waiver-reasons"], queryFn: waiverReasons, enabled: canCollect });
  const rails = usePaymentRails();
  // One request for everything about this patient: today, missed, next, itemised bills.
  const card = useQuery({
    queryKey: ["reception-card", p.patient_id],
    queryFn: () => getReceptionCard(p.patient_id),
    retry: false,
  });
  // The earlier bills the patient agreed to pay now. Empty by default: ticking is the
  // patient's decision, never the desk's.
  const [picked, setPicked] = useState<ReadonlySet<string>>(new Set());
  const bills = useMemo(() => card.data?.bills ?? [], [card.data]);
  const toggleBill = (id: string) => setPicked((cur) => {
    const next = new Set(cur);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  });
  const pickAll = (all: boolean) => setPicked(all ? new Set(bills.map((b) => b.id)) : new Set());
  // A bill that was paid or voided while the panel was open must not stay ticked.
  const live = useMemo(() => bills.filter((b) => picked.has(b.id)), [bills, picked]);
  const selectedIds = live.map((b) => b.id);
  const billsTotal = live.reduce((a, b) => a + (parseFloat(b.amount) || 0), 0);

  const triageRequired = !!settings.data?.triage_required;
  const [dept, setDept] = useState(p.department_id ?? "");
  const [provider, setProvider] = useState(p.provider_id ?? "");
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
  const reg = registration.data;
  const regFree = !!reg?.service_id && !reg.due;
  const feeDue = covered ? 0 : defaults
    .filter((s) => !(regFree && s.id === reg?.service_id))
    .reduce((a, s) => a + (parseFloat(s.price) || 0), 0);
  // Only the clinic's arrival fee is raised at reception. Choosing extra services
  // here was removed (2026-10-10): no clinic uses it, and raising them was a separate
  // request that a failed payment left behind to be raised again (APT-3).
  const total = feeDue + billsTotal;
  const routeReady = !!dept && (triageRequired || !!provider || booked);
  const mustPay = total > 0.005;
  // A desk that may not collect cannot be offered "Collect": it sends to the cashier.
  const cashierOnly = mustPay && !canCollect;
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
    // Say what was actually taken, not what the row showed when it loaded.
    onSuccess: (r) => {
      toast.success(`${p.name}: ${etb(Number(r.total))} collected`);
      qc.invalidateQueries({ queryKey: ["reception-today"] });
      invalidateDental(qc, p.patient_id);
      onDone();
    },
    onError: (e) => toast.error(e instanceof AppError ? e.message : "Could not take the payment"),
  });
  const canOverride = can("payment.waive");

  // Checks this patient in and raises this arrival's charges, returning their ids.
  // Shared by Collect and Waive, so both act on exactly what THIS visit raised —
  // waiving used to sweep every pending charge the patient had, a deposit at the
  // cashier included, and never checked them in (audit D6).
  const arrive = async (withBills = true): Promise<string[]> => {
    const routing = {
      to_triage: triageRequired,
      provider_id: !triageRequired && provider ? provider : undefined,
      // Carried for appointments booked before a department was required: the
      // server uses it only when the appointment has none, so it can never
      // reroute a patient away from where they were actually booked.
      department_id: dept || undefined,
      // Earlier bills the patient agreed to pay (never on Waive: waiving is about
      // today's fee, and sweeping the ticked bills into it would write them off):
      // they hold the patient at the cashier
      // and the patient goes to the chosen clinician once they are cleared.
      select_charge_ids: withBills && selectedIds.length > 0 ? selectedIds : undefined,
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
    return mine;
  };
  const receive = useMutation({
    mutationFn: async ({ mode, force }: { mode: "collect" | "cashier"; force?: boolean }) => {
      const mine = await arrive();
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
      qc.invalidateQueries({ queryKey: ["registration-status", p.patient_id] });
      qc.invalidateQueries({ queryKey: ["reception-card", p.patient_id] });
      onDone();
    },
    onError: (e) => {
      // A ticked bill that was paid in the meantime is the one failure with a fix the
      // desk can see: reload the card so it disappears from the list.
      qc.invalidateQueries({ queryKey: ["reception-card", p.patient_id] });
      toast.error(e instanceof AppError ? e.message : "Could not receive this patient");
    },
  });

  // Taking what they still owe on the way out (seen and gone, or waiting and owing).
  const settleBlock = outstanding > 0.005 && canCollect && (
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
  );

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

      {/* The card: today, missed, next. Skeleton while it loads, nothing if it fails —
          the desk can always still receive the patient from what the list knew. */}
      {card.isLoading && <CardSkeleton />}
      {card.data && (
        <>
          <TodaySection card={card.data} />
          <VisitsSection card={card.data} phone={p.phone} />
        </>
      )}
      {card.isError && (
        <p className="text-xs text-muted-foreground">
          Could not load this patient's history. You can still receive them.{" "}
          <button type="button" className="underline" onClick={() => card.refetch()}>Try again</button>
        </p>
      )}

      {seenToday && (
        <div className="rounded-md border border-sky-200 bg-sky-50 px-3 py-2 text-sm text-sky-900">
          {/* waiting_since is when they came in, which is the only time the desk
              has here — saying "closed at" would be inventing a fact. */}
          Seen today — came in at {clock(p.waiting_since!)} and the visit is closed.{" "}
          {outstanding > 0.005
            ? <>They still owe <b>{etb(outstanding)}</b>: take it below, or start a new visit.</>
            : "Sending them through again starts a new visit."}
        </div>
      )}

      {Number(p.unbilled || 0) > 0.005 && (
        <div className="flex flex-wrap items-center gap-2 rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2 text-sm">
          <span className="min-w-0 flex-1">
            <b>{etb(p.unbilled!)}</b> of treatment has not been sent to the cashier yet.
          </span>
          <Button asChild size="sm" variant="outline">
            <Link to={`/patients/${p.patient_id}`}>Open to bill it</Link>
          </Button>
        </div>
      )}

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
          {settleBlock}
        </div>
      ) : (
        <>
          {/* A treated patient who still owes is a settlement first, not a new visit. */}
          {seenToday && settleBlock}
          {seenToday && outstanding > 0.005 && (
            <p className="border-t pt-3 text-xs font-semibold text-muted-foreground">Or start a new visit</p>
          )}

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
            <FeeBlock defaults={defaults} total={feeDue} registration={reg} />
          ) : null}

          {/* Earlier unpaid bills, itemised and tickable. Until the card arrives (or if it
              cannot, or lists nothing the row says is owed) the single-line summary below
              still tells the desk they owe: a debt must never disappear from the screen. */}
          {card.data && bills.length > 0 && (
            <UnpaidBills bills={bills} selected={picked} onToggle={toggleBill} onAll={pickAll} />
          )}

          {/* Old debt: surfaced, never folded into today's payment. Money the clinic
              AGREED to be owed is not the same fact as a charge nobody collected —
              one is a plan, the other is a surprise — so they do not look alike. */}
          {!(card.data && bills.length > 0) && Number(p.owed || 0) > 0 && (
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

          {/* What will be taken, in one line, when earlier bills are ticked. */}
          {live.length > 0 && (
            <div className="flex items-baseline justify-between gap-2 rounded-md border bg-muted/30 px-3 py-2 text-sm">
              <span className="text-muted-foreground">
                Today {etb(feeDue)} + {live.length} earlier bill{live.length === 1 ? "" : "s"} {etb(billsTotal)}
              </span>
              <span className="font-mono font-semibold">{etb(total)}</span>
            </div>
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
            ) : cashierOnly ? (
              // No collect permission: the one honest exit is the cashier.
              <Button className="w-full" disabled={!routeReady} loading={receive.isPending}
                onClick={() => receive.mutate({ mode: "cashier" })}>
                Send to cashier{live.length > 0 ? ` · ${etb(total)}` : ""}
              </Button>
            ) : (
              <Button className="w-full" disabled={!routeReady || blocked} loading={receive.isPending}
                onClick={() => receive.mutate({ mode: "collect" })}>
                {mustPay ? <><HandCoins className="h-4 w-4" /> Collect {etb(total)} & send through</>
                  : <><CheckCircle2 className="h-4 w-4" /> Check in</>}
              </Button>
            )}
            {mustPay && !cashierOnly && (
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
                  <Button variant="ghost" disabled={!routeReady} onClick={() => setWaiveOpen(true)}>Waive…</Button>
                )}
              </div>
            )}
          </div>
        </>
      )}

      <DeferDialog open={deferOpen} onClose={() => setDeferOpen(false)} patient={p} total={feeDue} arrive={() => arrive(false)}
        onDone={() => { setDeferOpen(false); onDone(); }} />
      <WaiveDialog open={waiveOpen} onClose={() => setWaiveOpen(false)} reasons={reasons.data ?? []}
        value={waiveReason} onChange={setWaiveReason} patient={p} onDone={onDone} arrive={() => arrive(false)} />
    </div>
  );

  if (bare) return body;
  return <Card><CardContent className="p-4">{body}</CardContent></Card>;
}

/** What this visit costs, line by line — the same services the server will raise. */
function FeeBlock({ defaults, total, registration }: {
  defaults: ServiceItem[]; total: number; registration?: RegistrationStatus;
}) {
  if (defaults.length === 0) {
    return (
      <div className="rounded-md border bg-muted/40 px-3 py-2 text-sm">
        <p className="font-medium">No fee for this visit</p>
        <p className="mt-0.5 text-xs text-muted-foreground">This clinic charges nothing to be seen.</p>
      </div>
    );
  }
  return (
    <div className="rounded-md border px-3 py-2">
      {defaults.map((s) => {
        // The registration fee says why it is (or is not) charged today.
        const isReg = !!registration?.service_id && registration.service_id === s.id;
        const free = isReg && !registration!.due;
        const why = isReg ? statusLine(registration!) : "";
        return (
          <div key={s.id} className="text-sm">
            <div className="flex items-baseline justify-between gap-2">
              <span className="min-w-0 truncate text-muted-foreground">{s.name}</span>
              <span className={cn("shrink-0 font-mono", free && "text-muted-foreground line-through")}>{etb(s.price)}</span>
            </div>
            {why && <p className={cn("text-xs", free ? "text-emerald-700" : "text-muted-foreground")}>{free ? `No charge. ${why}` : why}</p>}
          </div>
        );
      })}
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
function DeferDialog({ open, onClose, patient, total, onDone, arrive }: {
  open: boolean; onClose: () => void; patient: ReceptionPatient; total: number; onDone: () => void;
  arrive: () => Promise<string[]>;
}) {
  const [reason, setReason] = useState("");
  const REASONS = ["Emergency — treat first", "Staff or dependent", "Known patient — settles monthly",
    "Insurance / company account", "Cannot pay today", "Other"];
  const defer = useMutation({
    // The arrival comes first, so the booking is marked arrived and today's fee is
    // raised; then ONLY what that arrival raised is deferred. Deferring "everything
    // pending" also agreed to wait for older debts nobody had discussed.
    mutationFn: async () => {
      const mine = await arrive();
      if (mine.length === 0) return { deferred: 0 };
      return deferVisit(patient.patient_id, { reason, charge_ids: mine });
    },
    onSuccess: (r) => {
      toast.success(r.deferred === 0
        ? `${patient.name} checked in`
        : `${patient.name} can be seen now — ${r.deferred} charge${r.deferred === 1 ? "" : "s"} still owed`);
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

function WaiveDialog({ open, onClose, reasons, value, onChange, patient, onDone, arrive }: {
  open: boolean; onClose: () => void; reasons: string[]; value: string;
  onChange: (s: string) => void; patient: ReceptionPatient; onDone: () => void;
  arrive: () => Promise<string[]>;
}) {
  const qc = useQueryClient();
  const waive = useMutation({
    // Check in, then waive only what this arrival raised. Waiving the waived routed
    // fee is what releases the patient into the queue, as paying it would.
    mutationFn: async () => {
      const mine = await arrive();
      for (const id of mine) await waiveCharge(id, value);
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
