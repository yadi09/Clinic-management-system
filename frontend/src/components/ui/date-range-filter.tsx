import { useState } from "react";

// Shared date-range filter used across the windowed list pages (Queue, Triage,
// My day, Finance, Cashier). Emits a { from, to } ISO window; "All" drops the
// lower bound (everything since the clinic started).
export type RangePreset = "today" | "yesterday" | "3d" | "custom" | "all";
export interface DateWindow {
  from?: string;
  to?: string;
}

const DAY = 86_400_000;
function startOfDay(d: Date) {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}

/** Compute the {from, to} window for a preset (local-day boundaries). */
export function windowFor(preset: RangePreset, customFrom?: string, customTo?: string): DateWindow {
  const today = startOfDay(new Date());
  const tomorrow = new Date(today.getTime() + DAY);
  switch (preset) {
    case "yesterday":
      return { from: new Date(today.getTime() - DAY).toISOString(), to: today.toISOString() };
    case "3d":
      return { from: new Date(today.getTime() - 2 * DAY).toISOString(), to: tomorrow.toISOString() };
    case "custom": {
      const f = customFrom ? startOfDay(new Date(`${customFrom}T00:00:00`)) : today;
      const t = customTo ? new Date(startOfDay(new Date(`${customTo}T00:00:00`)).getTime() + DAY) : tomorrow;
      return { from: f.toISOString(), to: t.toISOString() };
    }
    case "all":
      return { from: "2000-01-01T00:00:00.000Z" }; // no upper bound
    case "today":
    default:
      return { from: today.toISOString(), to: tomorrow.toISOString() };
  }
}

const PRESETS: { key: RangePreset; label: string }[] = [
  { key: "today", label: "Today" },
  { key: "yesterday", label: "Yesterday" },
  { key: "3d", label: "Last 3 days" },
  { key: "custom", label: "Custom" },
  { key: "all", label: "All" },
];

export function DateRangeFilter({ onChange, initial = "today" }: { onChange: (w: DateWindow) => void; initial?: RangePreset }) {
  const [preset, setPreset] = useState<RangePreset>(initial);
  const [cf, setCf] = useState("");
  const [ct, setCt] = useState("");

  const choose = (p: RangePreset) => {
    setPreset(p);
    onChange(windowFor(p, cf, ct));
  };
  const setCustom = (f: string, t: string) => {
    setCf(f);
    setCt(t);
    onChange(windowFor("custom", f, t));
  };

  return (
    <div className="flex flex-wrap items-center gap-2">
      <div className="inline-flex rounded-lg border p-0.5">
        {PRESETS.map((p) => (
          <button
            key={p.key}
            onClick={() => choose(p.key)}
            className={`rounded-md px-3 py-1.5 text-sm font-medium ${preset === p.key ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:text-foreground"}`}
          >
            {p.label}
          </button>
        ))}
      </div>
      {preset === "custom" && (
        <div className="flex items-center gap-1.5 text-sm">
          <input type="date" value={cf} max={ct || undefined} onChange={(e) => setCustom(e.target.value, ct)} className="rounded-md border bg-background px-2 py-1.5" />
          <span className="text-muted-foreground">→</span>
          <input type="date" value={ct} min={cf || undefined} onChange={(e) => setCustom(cf, e.target.value)} className="rounded-md border bg-background px-2 py-1.5" />
        </div>
      )}
    </div>
  );
}
