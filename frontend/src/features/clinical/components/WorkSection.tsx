// Six sections that all looked like one thing.
//
// Subjective, Objective, Assessment, Plan, Orders and Prescription were rendered as
// the same white card with the same black heading — and two of them were not even
// cards, just a heading floating on the page background. Scrolling through them, the
// eye had nothing to catch on: the doctor had to read a heading to know where they
// were, which is exactly the work a layout is supposed to do for them.
//
// Each section now has an identity — its own colour and its own mark — carried in the
// rail, in the heading and in a spine down the left edge of the card. You navigate by
// recognising a colour, not by reading.
import type { ReactNode } from "react";
import { Activity, ClipboardList, FlaskConical, ListChecks, MessageSquareText, Pill, Stethoscope } from "lucide-react";

import { Card } from "@/components/ui/card";
import { cn } from "@/lib/utils";

export type SectionId = "subjective" | "objective" | "assessment" | "plan" | "lab" | "prescription";

interface Tone {
  id: SectionId;
  label: string;
  short: string;
  Icon: typeof Pill;
  /** The spine down the card and the dot in the rail. */
  bar: string;
  /** The icon chip. */
  chip: string;
  /** The rail row when this section is the one on screen. */
  active: string;
}

export const SECTION_TONES: Tone[] = [
  { id: "subjective",   label: "Subjective",            short: "Subjective",   Icon: MessageSquareText, bar: "bg-indigo-400",  chip: "bg-indigo-100 text-indigo-700",  active: "bg-indigo-50 text-indigo-900" },
  { id: "objective",    label: "Objective / Vitals",    short: "Objective",    Icon: Activity,          bar: "bg-teal-400",    chip: "bg-teal-100 text-teal-700",      active: "bg-teal-50 text-teal-900" },
  { id: "assessment",   label: "Assessment / Diagnosis", short: "Assessment",  Icon: Stethoscope,       bar: "bg-brand",       chip: "bg-brand/10 text-brand",         active: "bg-brand/5 text-brand" },
  { id: "plan",         label: "Plan",                  short: "Plan",         Icon: ListChecks,        bar: "bg-violet-400",  chip: "bg-violet-100 text-violet-700",  active: "bg-violet-50 text-violet-900" },
  { id: "lab",          label: "Orders / Lab",          short: "Orders / Lab", Icon: FlaskConical,      bar: "bg-cyan-400",    chip: "bg-cyan-100 text-cyan-700",      active: "bg-cyan-50 text-cyan-900" },
  { id: "prescription", label: "Prescription",          short: "Prescription", Icon: Pill,              bar: "bg-amber-400",   chip: "bg-amber-100 text-amber-700",    active: "bg-amber-50 text-amber-900" },
];

export const toneOf = (id: SectionId) => SECTION_TONES.find((t) => t.id === id)!;

export { ClipboardList };

/**
 * One section of the consultation.
 *
 * `scroll-mt-32` is not decoration: the page header is sticky, so an anchor jump used
 * to land the heading underneath it and the doctor arrived at a section whose title
 * they could not see.
 */
export function WorkSection({ id, done, count, action, children }: {
  id: SectionId;
  /** Ticked in the heading and in the rail once there is something in it. */
  done?: boolean;
  /** e.g. "2 orders" — what is in here, without opening it. */
  count?: ReactNode;
  action?: ReactNode;
  children: ReactNode;
}) {
  const t = toneOf(id);
  return (
    <Card id={id} className="relative scroll-mt-32 overflow-hidden p-4 pl-5">
      <span className={cn("absolute inset-y-0 left-0 w-1.5", t.bar)} aria-hidden />
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <h2 className="flex items-center gap-2 text-h3">
          <span className={cn("grid h-7 w-7 shrink-0 place-items-center rounded-lg", t.chip)}>
            <t.Icon className="h-4 w-4" />
          </span>
          {t.label}
          {done && <span className="h-1.5 w-1.5 rounded-full bg-emerald-500" title="Recorded" />}
          {count ? <span className="text-xs font-normal text-muted-foreground">{count}</span> : null}
        </h2>
        {action}
      </div>
      {children}
    </Card>
  );
}
