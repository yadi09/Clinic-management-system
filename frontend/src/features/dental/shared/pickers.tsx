// The two pickers the dental surfaces share: what was done, and to which tooth.
//
// Hoisted out of DentalWorkspace so the visit cockpit can use the same controls.
// Both are deliberately multi-select — a single appointment routinely treats two
// teeth, and the old single-value fields meant the second one went unrecorded.
import { useState } from "react";
import { Check, ChevronDown, Plus } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from "@/components/ui/command";
import { cn } from "@/lib/utils";
import { STATUS_LABEL, statusStyle, TOOTH_QUADRANTS, TOOTH_STATUSES } from "@/features/dental/ToothChart";

/** Palmer codes in chart order, so a selection always reads UR6, UR7 — never UR7, UR6. */
export const FLAT_TEETH = TOOTH_QUADRANTS.flatMap((q) => q.codes);

/** Comma-separated storage <-> array. The server stores "UR6, UR7" verbatim. */
export const parseCsv = (s?: string) => (s ? s.split(",").map((t) => t.trim()).filter(Boolean) : []);

export const DENTAL_PROCEDURES = [
  "Consultation", "X-Ray", "Teeth Cleaning", "Scaling & Polishing", "Tooth Extraction",
  "Filling (Composite)", "Filling (Amalgam)", "Root Canal Treatment", "Crown Placement",
  "Bridge", "Partial Denture", "Full Denture", "Teeth Whitening", "Orthodontic Consultation",
  "Braces Fitting", "Emergency Treatment", "Other",
];


export function ProcedureMultiSelect({ value, onChange }: { value: string[]; onChange: (v: string[]) => void }) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const q = query.trim();
  const toggle = (p: string) => onChange(value.includes(p) ? value.filter((x) => x !== p) : [...value, p]);
  // Built-in list plus any custom values already selected, so ticks always show.
  const options = [...DENTAL_PROCEDURES, ...value.filter((v) => !DENTAL_PROCEDURES.includes(v))];
  const exact = options.some((p) => p.toLowerCase() === q.toLowerCase());
  return (
    <Popover open={open} onOpenChange={(o) => { setOpen(o); if (!o) setQuery(""); }}>
      <PopoverTrigger asChild>
        <Button variant="outline" role="combobox" className="w-full justify-between font-normal">
          <span className={cn("truncate", value.length === 0 && "text-muted-foreground")}>
            {value.length === 0 ? "Select procedures" : `${value.length} selected · ${value.join(", ")}`}
          </span>
          <ChevronDown className="h-4 w-4 shrink-0 opacity-60" />
        </Button>
      </PopoverTrigger>
      <PopoverContent align="start" className="p-0" style={{ width: "var(--radix-popover-trigger-width)" }}>
        <Command>
          <CommandInput placeholder="Search procedures…" value={query} onValueChange={setQuery} />
          <CommandList>
            <CommandEmpty>No procedure found.</CommandEmpty>
            <CommandGroup>
              {options.map((p) => (
                <CommandItem key={p} value={p} onSelect={() => toggle(p)}>
                  <Check className={cn("mr-2 h-4 w-4", value.includes(p) ? "opacity-100" : "opacity-0")} />
                  {p}
                </CommandItem>
              ))}
              {q && !exact && (
                <CommandItem value={q} onSelect={() => { toggle(q); setQuery(""); }}>
                  <Plus className="mr-2 h-4 w-4" /> Add "{q}"
                </CommandItem>
              )}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}

// Multi-tooth picker (Palmer), grouped by quadrant, showing each tooth's charted
// condition. Value is the selected codes; stored joined as "UR6, UR7".
export function ToothMultiSelect({ teeth, value, onChange, placeholder }: { teeth: Record<string, string>; value: string[]; onChange: (codes: string[]) => void; placeholder?: string }) {
  const ordered = FLAT_TEETH.filter((c) => value.includes(c));
  const toggle = (c: string) => onChange(value.includes(c) ? value.filter((x) => x !== c) : [...value, c]);
  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button variant="outline" role="combobox" className="w-full justify-between font-normal">
          <span className={cn("truncate", value.length === 0 && "text-muted-foreground")}>
            {value.length === 0 ? (placeholder ?? "No specific tooth") : `${value.length} selected · ${ordered.join(", ")}`}
          </span>
          <ChevronDown className="h-4 w-4 shrink-0 opacity-60" />
        </Button>
      </PopoverTrigger>
      <PopoverContent align="start" className="max-h-72 overflow-auto p-1" style={{ width: "var(--radix-popover-trigger-width)" }}>
        {TOOTH_QUADRANTS.map((quad) => (
          <div key={quad.label} className="py-0.5">
            <div className="px-2 py-1 text-xs font-semibold text-muted-foreground">{quad.label}</div>
            {quad.codes.map((code) => {
              const cond = teeth[code] ?? "";
              const st = statusStyle(cond);
              const checked = value.includes(code);
              return (
                <button key={code} type="button" onClick={() => toggle(code)}
                  className="flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left text-sm hover:bg-accent">
                  <span className={cn("flex h-4 w-4 shrink-0 items-center justify-center rounded border", checked ? "border-brand bg-brand text-brand-foreground" : "border-input")}>
                    {checked && <Check className="h-3 w-3" />}
                  </span>
                  <span className="h-2.5 w-2.5 shrink-0 rounded-sm border" style={{ background: st.background, borderColor: st.borderColor }} />
                  <span className="font-medium tabular-nums">{code}</span>
                  {cond && <span className="text-xs text-muted-foreground">· {STATUS_LABEL[cond] ?? cond}</span>}
                </button>
              );
            })}
          </div>
        ))}
      </PopoverContent>
    </Popover>
  );
}

/**
 * The teeth you just picked, on the chart a dentist already reads.
 *
 * The picker collapses to "3 selected · UR7, UR4, UR1", which is a list of codes to
 * be decoded one at a time — and by the third tooth nobody remembers which three
 * they chose. Dentists do not think in lists, they think in quadrants, so the
 * selection is shown where it means something: Palmer notation, upper row above
 * lower, right quadrant on the left as the patient faces you.
 *
 * It is also the fastest way to fix a mistake, so the teeth are clickable — this is
 * a second way in, not a read-out of the first.
 */
export function ToothPalmerPicker({ value, onChange, teeth }: {
  value: string[];
  onChange: (codes: string[]) => void;
  /** The patient's charted status, so a decayed or crowned tooth still reads as one. */
  teeth: Record<string, string>;
}) {
  const toggle = (code: string) =>
    onChange(value.includes(code) ? value.filter((c) => c !== code) : [...value, code]);

  const row = (q: { label: string; codes: string[] }, align: "end" | "start") => (
    <div className={cn("flex gap-1.5", align === "end" ? "justify-end" : "justify-start")}>
      {q.codes.map((code) => {
        const on = value.includes(code);
        const charted = teeth[code];
        const st = statusStyle(charted ?? "");
        return (
          <button
            key={code}
            type="button"
            onClick={() => toggle(code)}
            aria-pressed={on}
            title={`Palmer ${code} · ${STATUS_LABEL[charted] ?? "Not charted"}${on ? " · selected" : ""}`}
            // The STATUS keeps the tooth's own colour whether it is selected or not.
            // Filling a selected tooth solid was hiding the very thing the chart is
            // for: a decayed tooth stopped looking decayed the moment you picked it.
            style={st}
            className={cn(
              "relative flex h-7 w-6 items-center justify-center rounded border text-[10px] font-semibold tabular-nums transition-all",
              on
                // Selection is an outline, not a fill — it sits outside the swatch
                // and leaves the colour underneath legible.
                ? "outline outline-2 outline-offset-[2px] outline-brand"
                : "hover:outline hover:outline-2 hover:outline-offset-[2px] hover:outline-brand/40",
            )}
          >
            {code.slice(2)}
            {on && (
              // A ring alone is ambiguous on a small square; the tick says "chosen"
              // in a way that survives being printed or read at arm's length.
              <span className="absolute -right-1 -top-1 flex h-3 w-3 items-center justify-center rounded-full bg-brand text-brand-foreground">
                <Check className="h-2 w-2" strokeWidth={4} />
              </span>
            )}
          </button>
        );
      })}
    </div>
  );

  return (
    <div className="rounded-md border bg-muted/30 p-2.5">
      {/* Palmer's cross. Without the two lines this is just 32 buttons in two rows;
          with them it is the chart every dentist was taught to read, and the
          quadrant a tooth belongs to can be seen rather than worked out. Held to a
          fixed width so the quadrants meet at the midline instead of drifting to
          opposite ends of a wide panel. */}
      <div className="mx-auto max-w-[26rem]">
        <div className="grid grid-cols-2 border-b border-foreground/25">
          <div className="border-r border-foreground/25 pb-1.5 pr-2">{row(TOOTH_QUADRANTS[0], "end")}</div>
          <div className="pb-1.5 pl-2">{row(TOOTH_QUADRANTS[1], "start")}</div>
        </div>
        <div className="grid grid-cols-2">
          <div className="border-r border-foreground/25 pr-2 pt-1.5">{row(TOOTH_QUADRANTS[2], "end")}</div>
          <div className="pl-2 pt-1.5">{row(TOOTH_QUADRANTS[3], "start")}</div>
        </div>
      </div>
      {/* The key. The colours mean something clinically and a dentist should not have
          to hover each tooth to find out what — a paper chart has always carried its
          legend, and so should this one. */}
      <div className="mt-2.5 flex flex-wrap items-center justify-center gap-x-3 gap-y-1 border-t pt-2">
        {TOOTH_STATUSES.map((k) => {
          const st = statusStyle(k);
          return (
            <span key={k} className="flex items-center gap-1 text-[10px] text-muted-foreground">
              <span className="h-2.5 w-2.5 rounded-sm border"
                style={{ background: st.background, borderColor: st.borderColor }} />
              {STATUS_LABEL[k]}
            </span>
          );
        })}
        <span className="flex items-center gap-1 text-[10px] font-medium text-foreground">
          <span className="h-2.5 w-2.5 rounded-sm border bg-card outline outline-2 outline-offset-[1px] outline-brand" />
          Treated today
        </span>
      </div>
      <p className="mt-1.5 text-center text-[10px] text-muted-foreground">
        {value.length === 0
          ? "Tap a tooth to add it to this visit"
          : `${value.length} treated today — ${FLAT_TEETH.filter((c) => value.includes(c)).join(", ")}`}
      </p>
    </div>
  );
}
