// The tooth chart's logic, with no screen in it.
//
// Everything the chart decides — which teeth a quick select means, what an apply
// actually changes, how a mark is summarised, what letter stands for a condition —
// lives here as plain functions, so each rule can be tested on its own and the
// component stays a drawing of those rules.

export type Chart = Record<string, string>;

export const UPPER_RIGHT = ["UR8", "UR7", "UR6", "UR5", "UR4", "UR3", "UR2", "UR1"];
export const UPPER_LEFT = ["UL1", "UL2", "UL3", "UL4", "UL5", "UL6", "UL7", "UL8"];
export const LOWER_RIGHT = ["LR8", "LR7", "LR6", "LR5", "LR4", "LR3", "LR2", "LR1"];
export const LOWER_LEFT = ["LL1", "LL2", "LL3", "LL4", "LL5", "LL6", "LL7", "LL8"];

/** Chart-reading order: the order arrow keys walk and quick selects return. */
export const ALL_TEETH = [...UPPER_RIGHT, ...UPPER_LEFT, ...LOWER_RIGHT, ...LOWER_LEFT];
export const UPPER_ARCH = [...UPPER_RIGHT, ...UPPER_LEFT];
export const LOWER_ARCH = [...LOWER_RIGHT, ...LOWER_LEFT];

/** What a stroke or a menu pick applies. "" is the eraser: it clears the tooth. */
export const CLEAR = "";

/**
 * The teeth in `codes` whose mark would actually change to `status`.
 *
 * Applying Decayed to a tooth that is already Decayed is not an edit: it must not
 * make a save, an undo step or a toast. So callers apply the result of this, never
 * the raw list.
 */
export function changesFor(teeth: Chart, codes: Iterable<string>, status: string): Chart {
  const out: Chart = {};
  for (const c of codes) {
    if ((teeth[c] ?? "") !== status) out[c] = status;
  }
  return out;
}

export interface QuickSelect {
  key: string;
  label: string;
  codes: string[];
}

/**
 * The shortcuts offered in Select mode. Each is a set of teeth, not an action: it
 * replaces the selection, and the dentist then chooses what to do with it.
 *
 * "Same as" sets exist only for conditions that are on the chart, so the row never
 * offers "All Crown · 0".
 */
export function quickSelects(teeth: Chart, conditions: { code: string; label: string }[]): QuickSelect[] {
  const out: QuickSelect[] = [
    { key: "all", label: "All", codes: ALL_TEETH },
    { key: "upper", label: "Upper", codes: UPPER_ARCH },
    { key: "lower", label: "Lower", codes: LOWER_ARCH },
    { key: "ur", label: "Upper right", codes: UPPER_RIGHT },
    { key: "ul", label: "Upper left", codes: UPPER_LEFT },
    { key: "lr", label: "Lower right", codes: LOWER_RIGHT },
    { key: "ll", label: "Lower left", codes: LOWER_LEFT },
    { key: "unmarked", label: "Not marked", codes: ALL_TEETH.filter((c) => !teeth[c]) },
  ];
  for (const k of conditions) {
    const codes = ALL_TEETH.filter((c) => teeth[c] === k.code);
    if (codes.length > 0) out.push({ key: `is-${k.code}`, label: `All ${k.label.toLowerCase()} · ${codes.length}`, codes });
  }
  return out;
}

export const invert = (selected: ReadonlySet<string>): string[] => ALL_TEETH.filter((c) => !selected.has(c));

export const sameTeeth = (selected: ReadonlySet<string>, codes: string[]) =>
  selected.size === codes.length && codes.every((c) => selected.has(c));

export interface ChartSummary {
  marked: number;
  unmarked: number;
  /** Count per condition, in the order of `order` and then any retired ones. */
  byCondition: { code: string; count: number }[];
}

export function summarize(teeth: Chart, order: string[]): ChartSummary {
  const counts = new Map<string, number>();
  for (const c of ALL_TEETH) {
    const s = teeth[c];
    if (s) counts.set(s, (counts.get(s) ?? 0) + 1);
  }
  const known = order.filter((c) => counts.has(c));
  const retired = [...counts.keys()].filter((c) => !order.includes(c));
  const marked = [...counts.values()].reduce((a, b) => a + b, 0);
  return {
    marked,
    unmarked: ALL_TEETH.length - marked,
    byCondition: [...known, ...retired].map((code) => ({ code, count: counts.get(code)! })),
  };
}

/**
 * A short mark for each condition, so a chart still reads in black and white and to
 * a colour-blind dentist: the first letter, lengthened until it is unique among the
 * clinic's own conditions ("Cr" and "Ca" rather than two Cs). Extracted is a cross,
 * and Healthy carries none: most teeth are healthy and a letter on every one is
 * noise that hides the ones that matter.
 */
export function glyphs(defs: { code: string; label: string }[]): Record<string, string> {
  const out: Record<string, string> = {};
  const used = new Set<string>();
  for (const d of defs) {
    if (d.code === "healthy") { out[d.code] = ""; continue; }
    if (d.code === "extracted") { out[d.code] = "✕"; used.add("✕"); continue; }
    const letters = d.label.replace(/[^A-Za-z]/g, "") || d.code;
    let n = 1;
    while (n < letters.length && used.has(letters.slice(0, n).toUpperCase())) n++;
    const g = letters.slice(0, n);
    out[d.code] = g.charAt(0).toUpperCase() + g.slice(1).toLowerCase();
    used.add(g.toUpperCase());
  }
  return out;
}

/** A clinic may have typed "bridge"; the chart shows "Bridge". */
export const capital = (s: string) => (s ? s.charAt(0).toUpperCase() + s.slice(1) : s);

/** One step of undo/redo: what each tooth was and what it became. */
export interface HistoryEntry {
  label: string;
  before: Chart;
  after: Chart;
}

export const HISTORY_LIMIT = 20;

export function pushEntry(stack: HistoryEntry[], entry: HistoryEntry): HistoryEntry[] {
  return [...stack, entry].slice(-HISTORY_LIMIT);
}

/** The move for an arrow key, in a 2-row chart of 16 teeth each (row-major). */
export function neighbour(code: string, key: "ArrowLeft" | "ArrowRight" | "ArrowUp" | "ArrowDown"): string | null {
  const flat = [...UPPER_ARCH, ...LOWER_ARCH];
  const i = flat.indexOf(code);
  if (i < 0) return null;
  const col = i % 16;
  const row = Math.floor(i / 16);
  if (key === "ArrowLeft") return col > 0 ? flat[i - 1] : null;
  if (key === "ArrowRight") return col < 15 ? flat[i + 1] : null;
  if (key === "ArrowUp") return row === 1 ? flat[i - 16] : null;
  return row === 0 ? flat[i + 16] : null;
}
