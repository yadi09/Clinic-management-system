// What the desk sees when a list has nobody in it.
//
// An empty list is the moment the receptionist most needs direction: nobody booked
// does not mean nothing to do, it means "the next person walks in". Each screen says
// what an empty list MEANS, and offers the one thing to do next. Loading and failure
// are different screens and never look like these.
import { Link } from "react-router-dom";
import { CalendarCheck, CalendarPlus, CheckCircle2, Hourglass, SearchX, Stethoscope, UserPlus } from "lucide-react";

import { Button } from "@/components/ui/button";
import type { ReceptionPatient, ReceptionToday } from "@/features/scheduling/api";

type Lens = "expected" | "waiting" | "seen" | "settle";

function Frame({ icon, tone = "brand", title, children, actions }: {
  icon: React.ReactNode; tone?: "brand" | "ok"; title: string; children?: React.ReactNode; actions?: React.ReactNode;
}) {
  return (
    <div className="rounded-lg border border-dashed px-4 py-8 text-center">
      <div className={tone === "ok"
        ? "mx-auto mb-2 flex h-11 w-11 items-center justify-center rounded-full bg-emerald-100 text-emerald-700"
        : "mx-auto mb-2 flex h-11 w-11 items-center justify-center rounded-full bg-brand/10 text-brand"}>
        {icon}
      </div>
      <h3 className="text-sm font-semibold">{title}</h3>
      {children && <div className="mx-auto mt-1 max-w-sm text-sm text-muted-foreground">{children}</div>}
      {actions && <div className="mt-4 flex flex-wrap justify-center gap-2">{actions}</div>}
    </div>
  );
}

const weekday = (iso: string) =>
  new Date(iso).toLocaleDateString(undefined, { weekday: "long", day: "numeric", month: "short" });

/** Nobody booked today: the receptionist's day is walk-ins, so say that and offer them. */
function NoBookings({ today, onPick }: { today?: ReceptionToday; onPick: (p: ReceptionPatient) => void }) {
  const recent = today?.recent ?? [];
  const next = today?.next_booking;
  return (
    <div className="space-y-3">
      <Frame
        icon={<CalendarCheck className="h-5 w-5" />}
        title="No one is booked for today"
        actions={<>
          <Button asChild size="sm"><Link to="/patients/new"><UserPlus className="h-4 w-4" /> Register a new patient</Link></Button>
          <Button asChild size="sm" variant="outline"><Link to="/appointments"><CalendarPlus className="h-4 w-4" /> Book an appointment</Link></Button>
        </>}
      >
        <p>Patients who walk in appear here once you receive them. Search for the person in front of you to begin.</p>
        {next && (
          <p className="mt-2">
            Next booking: <b>{weekday(next.starts_at)}</b> · {next.count} booked
          </p>
        )}
      </Frame>
      {recent.length > 0 && (
        <div className="space-y-1.5">
          <p className="text-xs font-semibold text-muted-foreground">Seen before · tap to receive again</p>
          {recent.map((p) => (
            <button key={p.patient_id} type="button" onClick={() => onPick(p)}
              className="flex w-full items-baseline gap-x-2 rounded-lg border p-3 text-left transition-colors hover:border-brand/40 hover:bg-accent/40 max-md:min-h-14">
              <span className="min-w-0 flex-1 truncate font-medium">{p.name}</span>
              <span className="font-mono text-xs text-muted-foreground">{p.mrn}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

/** The empty list for one tab of the day. */
export function EmptyList({ lens, today, onPick }: {
  lens: Lens; today?: ReceptionToday; onPick: (p: ReceptionPatient) => void;
}) {
  if (lens === "expected") return <NoBookings today={today} onPick={onPick} />;
  if (lens === "waiting") {
    return <Frame icon={<Hourglass className="h-5 w-5" />} title="No one is waiting">
      Everyone received has been sent on to a clinician, or has finished.
    </Frame>;
  }
  if (lens === "seen") {
    return <Frame icon={<Stethoscope className="h-5 w-5" />} title="No one has been seen yet">
      Patients appear here once the clinician finishes with them.
    </Frame>;
  }
  return <Frame tone="ok" icon={<CheckCircle2 className="h-5 w-5" />} title="Everything is settled">
    Nobody treated today still owes. Nothing to chase.
  </Frame>;
}

/** A search that found nobody: say so, and offer to register exactly what was typed. */
export function NoMatch({ term }: { term: string }) {
  return (
    <Frame
      icon={<SearchX className="h-5 w-5" />}
      title={`No patient matches “${term}”`}
      actions={
        <Button asChild size="sm">
          <Link to={`/patients/new?name=${encodeURIComponent(term)}`}><UserPlus className="h-4 w-4" /> Register “{term}” as a new patient</Link>
        </Button>
      }
    >
      Check the spelling, or try the phone number or card number.
    </Frame>
  );
}
