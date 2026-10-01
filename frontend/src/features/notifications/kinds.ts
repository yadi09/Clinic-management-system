import { Bell, CalendarX2, type LucideIcon } from "lucide-react";

import type { AppNotification } from "./api";

/** How one notification reads on screen. Each kind lays out its own facts; a kind
 *  this screen does not know yet still shows, from its title and body. */
export interface Presented {
  icon: LucideIcon;
  /** Icon colours: [unread tint, read tint]. */
  tone: { unread: string; read: string };
  /** What staff scan for first, e.g. the patient's name. */
  headline: string;
  /** A short identifier beside the headline, e.g. the card number. */
  tag?: string;
  /** What happened, in a few words. */
  detail: string;
  /** The day it is about, shown in both calendars. */
  date?: string;
}

const str = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : undefined);

export function present(n: AppNotification): Presented {
  const d = n.data ?? {};
  if (n.kind === "missed_visit") {
    const patient = str(d.patient);
    const course = str(d.course);
    const visit = typeof d.visit === "number" ? d.visit : undefined;
    // Older notices may predate the fields; their sentence still says it all.
    if (patient) {
      return {
        icon: CalendarX2,
        tone: { unread: "bg-amber-100 text-amber-700", read: "bg-muted text-muted-foreground" },
        headline: patient,
        tag: str(d.card) ? `Card ${str(d.card)}` : undefined,
        detail: course ? `Missed visit ${visit ?? ""} of ${course}`.replace("  ", " ") : "Missed a visit",
        date: str(d.date),
      };
    }
  }
  return {
    icon: Bell,
    tone: { unread: "bg-primary/10 text-primary", read: "bg-muted text-muted-foreground" },
    headline: n.title,
    detail: n.body,
  };
}

/** The pop-up's title and lead, in the words of what is waiting. */
export function summarize(items: AppNotification[], total: number): { title: string; lead: string } {
  const allMissed = items.length > 0 && items.every((n) => n.kind === "missed_visit");
  if (allMissed && total === items.length) {
    return {
      title: total === 1 ? "A visit was missed" : `${total} visits were missed`,
      lead: "These visits passed without being marked done. Open a patient to rebook.",
    };
  }
  return {
    title: total === 1 ? "You have 1 unread notification" : `You have ${total} unread notifications`,
    lead: "Here's what needs your attention.",
  };
}
