// A date, said the way this clinic says dates.
//
// Cure Dental's staff think in the Ethiopian calendar; the records, the lab slips
// and the insurance forms are Gregorian. Showing one without the other means
// somebody converts in their head, and people convert wrong. So both, always,
// wherever a date is user-facing.
//
// The relative chip ("in 14 days", "5 days ago") is the third thing people
// actually reason in, and it is the one that makes a missed appointment obvious
// at a glance rather than after subtracting two dates.
//
// This replaces the raw `2026-08-13` that several surfaces still print.
import { cn } from "@/lib/utils";
import { formatEthiopian } from "@/lib/ethiopian";

/** Whole days from today to `iso`, negative for the past. Local midnight both ends. */
export function dayDiff(iso: string): number {
  const then = new Date(`${iso}T00:00:00`);
  const now = new Date();
  now.setHours(0, 0, 0, 0);
  then.setHours(0, 0, 0, 0);
  return Math.round((then.getTime() - now.getTime()) / 86_400_000);
}

/** "today" / "tomorrow" / "in 14 days" / "5 days ago" — how people actually reason. */
export function relativeDay(iso: string): string {
  const d = dayDiff(iso);
  if (d === 0) return "today";
  if (d === 1) return "tomorrow";
  if (d === -1) return "yesterday";
  return d > 0 ? `in ${d} days` : `${Math.abs(d)} days ago`;
}

const gregorian = (iso: string, long: boolean) =>
  new Date(`${iso}T00:00:00`).toLocaleDateString(undefined, {
    weekday: long ? "short" : undefined,
    day: "numeric",
    month: long ? "long" : "short",
    year: "numeric",
  });

export function DualDate({ iso, long = false, relative = false, className }: {
  iso: string;
  /** Long form spells the month and prefixes the weekday. */
  long?: boolean;
  /** Append the relative chip. Worth it on anything scheduled; noise on a receipt. */
  relative?: boolean;
  className?: string;
}) {
  if (!iso) return null;
  let ec = "";
  try {
    ec = formatEthiopian(iso, { dayFirst: true });
  } catch {
    // A malformed date should render as itself, not crash the row it sits in.
    return <span className={className}>{iso}</span>;
  }
  const d = relative ? dayDiff(iso) : 0;
  return (
    <span className={cn("whitespace-nowrap", className)}>
      {gregorian(iso, long)}
      <span className="text-muted-foreground"> · {ec}</span>
      {relative && (
        <span className={cn("ml-1.5 text-muted-foreground", d === 0 && "font-medium text-foreground")}>
          {relativeDay(iso)}
        </span>
      )}
    </span>
  );
}
