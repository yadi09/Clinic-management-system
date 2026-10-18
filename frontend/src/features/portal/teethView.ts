// The three separate pictures of a patient's mouth. They are never mixed on one chart:
// colour alone is a poor way to tell "what I have" from "what is planned" from "what is
// done", so each is its own view and shows only its own work.
import type { ChartItem } from "@/features/dental/api";

export type Look = "now" | "planned" | "done";

/** A tooth that is gone stays gone in every view, so a planned implant has somewhere to go
 *  and an extraction that is done does not grow back in the "planned" picture. */
const structural = (i: ChartItem) => i.kind === "missing";

export function itemsFor(rows: ChartItem[], look: Look): ChartItem[] {
  switch (look) {
    case "now": // everything that is physically in the mouth today
      return rows.filter((i) => i.status !== "planned");
    case "planned": // only what is still to be done
      return rows.filter((i) => i.status === "planned" || structural(i));
    case "done": // only what the clinic has finished
      return rows.filter((i) => i.status === "done" || structural(i));
  }
}

/** How many things each view holds, for the numbers on its buttons. Missing teeth are the
 *  backdrop, not "work", so they do not count. */
export function countFor(rows: ChartItem[], look: Look): number {
  return itemsFor(rows, look).filter((i) => !structural(i)).length;
}

/** The teeth that have something in this view, in mouth order (upper right to lower left). */
export function teethWith(rows: ChartItem[]): number[] {
  return [...new Set(rows.map((i) => i.tooth))].sort((a, b) => a - b);
}
