// One segmented control, because the dental page had grown five.
//
// Plan tabs, date scope, session-image tabs, patient-image tabs and the reception
// view each hand-rolled their own "pick one of these" strip, in four different
// sizes and three different selected-state treatments. Users learn a control by its
// shape; five shapes for one behaviour is five things to learn. None of the five was
// keyboard-operable either — they were plain buttons in a div, so arrow keys did
// nothing and a screen reader announced no grouping.
//
// This is a real tablist: roving tabindex, arrow/Home/End keys, aria-selected.
import { useEffect, useRef, type ReactNode } from "react";

import { cn } from "@/lib/utils";

export interface SegmentedOption<T extends string> {
  value: T;
  label: ReactNode;
  /** Shown after the label, dimmed — e.g. a count. Omit rather than pass 0. */
  badge?: ReactNode;
  disabled?: boolean;
}

export function Segmented<T extends string>({
  value, onChange, options, size = "md", className, ariaLabel,
}: {
  value: T;
  onChange: (v: T) => void;
  options: SegmentedOption<T>[];
  size?: "sm" | "md";
  className?: string;
  ariaLabel: string;
}) {
  const ref = useRef<HTMLDivElement>(null);

  // Where the strip scrolls (phones), keep the selected segment in view: opened on
  // the third of three tabs, it sat off the right edge with nothing to say so.
  // scrollLeft on the strip itself, so the page never jumps.
  useEffect(() => {
    const strip = ref.current;
    const on = strip?.querySelector<HTMLElement>("[role=tab][aria-selected=true]");
    if (!strip || !on || strip.scrollWidth <= strip.clientWidth) return;
    const left = on.offsetLeft - strip.offsetLeft;
    if (left < strip.scrollLeft || left + on.offsetWidth > strip.scrollLeft + strip.clientWidth) {
      strip.scrollLeft = Math.max(0, left - (strip.clientWidth - on.offsetWidth) / 2);
    }
  }, [value]);

  // Arrow keys move between segments and select as they go, which is what a
  // tablist is expected to do; Home/End jump to the ends.
  const onKeyDown = (e: React.KeyboardEvent) => {
    const enabled = options.filter((o) => !o.disabled);
    const i = enabled.findIndex((o) => o.value === value);
    if (i < 0) return;
    let next = i;
    if (e.key === "ArrowRight" || e.key === "ArrowDown") next = (i + 1) % enabled.length;
    else if (e.key === "ArrowLeft" || e.key === "ArrowUp") next = (i - 1 + enabled.length) % enabled.length;
    else if (e.key === "Home") next = 0;
    else if (e.key === "End") next = enabled.length - 1;
    else return;
    e.preventDefault();
    onChange(enabled[next].value);
    // Move focus with the selection so the next arrow press continues from here.
    ref.current?.querySelectorAll<HTMLButtonElement>("[role=tab]")[
      options.findIndex((o) => o.value === enabled[next].value)
    ]?.focus();
  };

  return (
    <div
      ref={ref}
      role="tablist"
      aria-label={ariaLabel}
      onKeyDown={onKeyDown}
      // max-w-full + overflow-x-auto: at phone widths a long tab set scrolls in place
      // instead of wrapping each label into a 3-line slab — measured on five screens
      // (finance, chairside, unbilled, messages, cashier) from this one file.
      className={cn("scrollbar-none flex max-w-full items-center gap-0.5 overflow-x-auto rounded-lg bg-muted p-0.5 sm:inline-flex sm:overflow-visible", className)}
    >
      {options.map((o) => {
        const on = o.value === value;
        return (
          <button
            key={o.value}
            type="button"
            role="tab"
            aria-selected={on}
            disabled={o.disabled}
            tabIndex={on ? 0 : -1}
            onClick={() => onChange(o.value)}
            className={cn(
              "shrink-0 whitespace-nowrap rounded-md font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-40 max-md:min-h-9",
              size === "sm" ? "px-2.5 py-1.5 text-xs sm:py-1" : "px-3 py-2 text-sm sm:py-1.5",
              on ? "bg-background text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground",
            )}
          >
            {o.label}
            {o.badge != null && <span className={cn("ml-1.5", on ? "text-muted-foreground" : "opacity-70")}>{o.badge}</span>}
          </button>
        );
      })}
    </div>
  );
}
