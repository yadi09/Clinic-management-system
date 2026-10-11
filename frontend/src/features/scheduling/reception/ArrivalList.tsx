// Who is here, who is coming, who has been seen.
//
// Reception used to begin with an empty search box: to receive a patient you had to
// know their name and type it, even though the clinic booked them weeks ago and knows
// exactly who is due. This is the inversion — the day is the page, and search is the
// fallback for everyone who is not on it.
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import type { ReceptionPatient } from "@/features/scheduling/api";

const etb = (s?: string) => `${Number(s || 0).toLocaleString(undefined, { maximumFractionDigits: 0 })} ETB`;

/** Is this follow-up still inside the window the doctor set? */
export function coveredNow(p: ReceptionPatient): boolean {
  return !!p.is_followup && !!p.free_until && new Date(p.free_until) >= new Date();
}

export function ArrivalRow({ p, selected, onPick, lens }: {
  p: ReceptionPatient;
  selected: boolean;
  onPick: () => void;
  lens: "expected" | "waiting" | "seen" | "settle";
}) {
  const covered = coveredNow(p);
  const owes = Number(p.owed || 0) > 0;
  const unbilled = Number(p.unbilled || 0) > 0.005;
  const late = p.late_minutes > 0;

  return (
    <button
      type="button"
      onClick={onPick}
      aria-current={selected ? "true" : undefined}
      className={cn(
        "w-full rounded-lg border p-3 text-left transition-colors max-md:min-h-16",
        "hover:border-brand/40 hover:bg-accent/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand",
        selected && "border-brand bg-brand/5",
      )}
    >
      <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
        {/* Time first, tabular: a desk reads down a clock. */}
        {lens === "expected" && p.starts_at && (
          <span className={cn("shrink-0 font-semibold tabular-nums", late ? "text-amber-700" : "text-foreground")}>
            {clock(p.starts_at)}
          </span>
        )}
        {lens !== "expected" && p.waiting_since && (
          <span className="shrink-0 text-xs font-medium tabular-nums text-muted-foreground">{clock(p.waiting_since)}</span>
        )}
        <span className="min-w-0 flex-1 truncate font-medium">{p.name}</span>
        {/* Not a booking: a visit of a treatment course that is due today. */}
        {p.treatment_visit && (
          <Badge variant="outline" className="shrink-0 border-violet-300 bg-violet-50 text-violet-700">Treatment visit</Badge>
        )}
        <span className="shrink-0 font-mono text-xs text-muted-foreground">{p.mrn}</span>
      </div>

      <p className="mt-0.5 text-xs text-muted-foreground">
        {p.age > 0 && `${p.age}y`}{p.sex ? ` ${p.sex.charAt(0).toUpperCase()}` : ""}
        {p.provider_name && ` · ${p.provider_name}`}
        {lens === "expected" && late && <span className="font-medium text-amber-700"> · {p.late_minutes} min late</span>}
        {lens === "waiting" && p.waiting_since && <span> · waiting {minutesSince(p.waiting_since)} min</span>}
        {p.reason && ` · ${p.reason}`}
      </p>

      {/* The two facts that change what happens next, and that the old page hid. */}
      {(covered || owes || unbilled) && (
        <div className="mt-1.5 flex flex-wrap gap-1.5">
          {covered && <Badge variant="success">Free follow-up · until {day(p.free_until!)}</Badge>}
          {owes && (
            // Agreed credit is a plan; an uncollected charge is a surprise. On the
            // settle lens what matters is only that it is still to be taken.
            <Badge variant={p.owed_agreed && lens !== "settle" ? "outline" : "destructive"}>
              {lens === "settle" ? "To collect " : p.owed_agreed ? "Billed later · " : "Owes "}
              {etb(p.owed)}
              {lens !== "settle" && p.owed_oldest_days ? ` · ${p.owed_oldest_days}d` : ""}
            </Badge>
          )}
          {/* Treatment given but never sent to the cashier: invisible to "Owes",
              so a patient could walk out with it unbilled (audit D10). */}
          {unbilled && <Badge variant="destructive">Not yet billed {etb(p.unbilled!)}</Badge>}
        </div>
      )}
    </button>
  );
}

export function clock(iso: string) {
  return new Date(iso).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
}
export function day(iso: string) {
  return new Date(iso).toLocaleDateString(undefined, { day: "numeric", month: "short" });
}
export function minutesSince(iso: string) {
  return Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 60000));
}
