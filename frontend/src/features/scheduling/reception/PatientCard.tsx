// What the desk needs to know about one patient before deciding anything.
//
// The right-hand side used to say "Owes 2,000" and send the receptionist to the
// cashier to find out why. These sections answer, on the one screen: is a visit
// booked today, is a treatment session planned, were visits missed, when is the next
// one, and which unpaid bills make up the debt — itemised, and tickable, because the
// patient standing at the desk is often willing to pay them there and then.
import { CalendarClock, CalendarX2, Stethoscope } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import { formatEthiopian } from "@/lib/ethiopian";
import type { CardBill, CardVisit, ReceptionCard } from "@/features/scheduling/api";

const etb = (n: number | string) => `ETB ${Number(n).toFixed(2)}`;

/** A date with its Ethiopian equivalent beside it (the clinic's own calendar). */
export function dateWords(iso: string) {
  const d = new Date(iso.length === 10 ? `${iso}T00:00:00` : iso);
  const g = d.toLocaleDateString(undefined, { weekday: "short", day: "numeric", month: "short" });
  return `${g} · ${formatEthiopian(d)}`;
}

function Section({ title, aside, children }: { title: string; aside?: React.ReactNode; children: React.ReactNode }) {
  return (
    <section className="space-y-1.5 border-t pt-3">
      <div className="flex items-baseline justify-between gap-2">
        <h3 className="text-xs font-semibold text-muted-foreground">{title}</h3>
        {aside}
      </div>
      {children}
    </section>
  );
}

/** Loading, so the panel does not jump when the sections arrive. */
export function CardSkeleton() {
  return <div className="space-y-2" aria-label="Loading patient card"><Skeleton className="h-10 w-full" /><Skeleton className="h-16 w-full" /></div>;
}

/** Today: the booking, and the treatment session planned for today. */
export function TodaySection({ card }: { card: ReceptionCard }) {
  const { appointment, session } = card;
  if (!appointment && !session) {
    return <Section title="Today"><p className="text-sm text-muted-foreground">No booking or treatment visit today — a walk-in.</p></Section>;
  }
  return (
    <Section title="Today">
      {appointment && (
        <p className="flex items-start gap-2 text-sm">
          <CalendarClock className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
          <span>
            Booked {new Date(appointment.when).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })}
            {appointment.provider_name && <> with <b>{appointment.provider_name}</b></>}
            {appointment.title && <span className="text-muted-foreground"> · {appointment.title}</span>}
            {appointment.status === "checked_in" && <span className="text-emerald-700"> · already received</span>}
          </span>
        </p>
      )}
      {session && (
        <p className="flex items-start gap-2 text-sm">
          <Stethoscope className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
          <span>Treatment planned today: <b>{session.title}</b></span>
        </p>
      )}
    </Section>
  );
}

/**
 * Missed visits and the next one. Missed is the last 90 days, newest first; a missed
 * visit has a phone number beside it because the usual reaction is to call.
 */
export function VisitsSection({ card, phone }: { card: ReceptionCard; phone?: string }) {
  const missed = card.missed ?? [];
  const next = card.next;
  return (
    <Section title="Visits">
      {missed.length === 0 ? (
        <p className="text-sm text-muted-foreground">No missed visits in the last 90 days.</p>
      ) : (
        <ul className="space-y-1">
          {missed.map((m, i) => <MissedRow key={`${m.kind}-${m.when}-${i}`} v={m} phone={phone} />)}
        </ul>
      )}
      <p className="flex items-start gap-2 text-sm">
        <CalendarClock className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
        {next ? (
          <span>
            Next: <b>{dateWords(next.when)}</b>
            {next.kind === "appointment" && new Date(next.when).getHours() !== 0 &&
              ` · ${new Date(next.when).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })}`}
            {next.title && <span className="text-muted-foreground"> · {next.title}</span>}
            {next.provider_name && <span className="text-muted-foreground"> · {next.provider_name}</span>}
          </span>
        ) : (
          <span className="text-muted-foreground">No next visit booked.</span>
        )}
      </p>
    </Section>
  );
}

function MissedRow({ v, phone }: { v: CardVisit; phone?: string }) {
  return (
    <li className="flex flex-wrap items-baseline gap-x-2 rounded-md bg-amber-50 px-2 py-1 text-sm text-amber-900">
      <CalendarX2 className="h-3.5 w-3.5 shrink-0 self-center" />
      <span>Missed <b>{dateWords(v.when)}</b>{v.title && ` · ${v.title}`}{v.provider_name && ` · ${v.provider_name}`}</span>
      {phone && <a href={`tel:${phone}`} className="ml-auto text-xs font-medium underline">Call</a>}
    </li>
  );
}

/**
 * Earlier unpaid bills, one per line, with a tick box each. Nothing is ticked by
 * default: ticking is the patient agreeing to pay, and the desk must not decide that
 * for them. Today's own fee is not in this list — the fee block shows it.
 */
export function UnpaidBills({ bills, selected, onToggle, onAll }: {
  bills: CardBill[];
  selected: ReadonlySet<string>;
  onToggle: (id: string) => void;
  onAll: (all: boolean) => void;
}) {
  const total = bills.reduce((a, b) => a + Number(b.amount), 0);
  const oldest = Math.max(0, ...bills.map((b) => b.age_days));
  const allOn = bills.every((b) => selected.has(b.id));
  return (
    <Section
      title={`Earlier unpaid bills · ${bills.length} · ${etb(total)}${oldest > 0 ? ` · oldest ${oldest} days` : ""}`}
      aside={(
        <Button type="button" size="sm" variant="ghost" className="h-7 px-2 text-xs" onClick={() => onAll(!allOn)}>
          {allOn ? "Clear" : "Select all"}
        </Button>
      )}
    >
      <ul className="space-y-1.5 rounded-md border border-amber-200 bg-amber-50/50 p-1.5">
        {bills.map((b) => {
          const on = selected.has(b.id);
          return (
            <li key={b.id}>
              <label className={cn(
                "flex min-h-11 cursor-pointer items-center gap-3 rounded-md px-2 py-1.5 text-sm transition-colors",
                on ? "bg-brand/10" : "hover:bg-accent/50")}>
                <input type="checkbox" className="h-4 w-4 shrink-0 accent-[hsl(var(--brand))]"
                  checked={on} onChange={() => onToggle(b.id)}
                  aria-label={`${b.description}, ${etb(b.amount)}`} />
                <span className="min-w-0 flex-1">
                  <span className="block truncate">{b.description}</span>
                  <span className="block text-xs text-muted-foreground">
                    {dateWords(b.created_at)}
                    {b.at_cashier && " · at the cashier"}
                    {b.agreed && ` · agreed to pay later${b.agreed_why ? ` (${b.agreed_why})` : ""}`}
                  </span>
                </span>
                <span className="shrink-0 font-mono">{b.amount}</span>
              </label>
            </li>
          );
        })}
      </ul>
      {selected.size === 0 && (
        <p className="text-xs text-muted-foreground">
          Tick the bills the patient agrees to pay now. They go to the cashier with today's visit.
        </p>
      )}
    </Section>
  );
}
