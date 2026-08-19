// Odontogram — a Palmer-notation tooth chart. Four quadrants (upper-right,
// upper-left, lower-right, lower-left), 8 teeth each. Tap a tooth to cycle its
// status; colors mirror the clinic's existing paper chart.
import { cn } from "@/lib/utils";

// The status cycle a tap walks through (empty → … → empty).
const CYCLE = ["", "healthy", "decayed", "filled", "extracted", "crown"] as const;

const STATUS_STYLE: Record<string, { background: string; borderColor: string; color: string }> = {
  "": { background: "#ffffff", borderColor: "#dddde8", color: "#c9c9d4" },
  healthy: { background: "#e0f9f0", borderColor: "#0a7c59", color: "#0a7c59" },
  decayed: { background: "#fde8e6", borderColor: "#c0392b", color: "#c0392b" },
  filled: { background: "#eef2ff", borderColor: "#1a4fd8", color: "#1a4fd8" },
  extracted: { background: "#f5f5f5", borderColor: "#cccccc", color: "#b8b8b8" },
  crown: { background: "#fff8e0", borderColor: "#f0c040", color: "#b8860b" },
};

export const TOOTH_STATUSES = ["healthy", "decayed", "filled", "extracted", "crown"] as const;
export const STATUS_LABEL: Record<string, string> = {
  healthy: "Healthy", decayed: "Decayed", filled: "Filled", extracted: "Extracted", crown: "Crown",
};
export function statusStyle(status: string) {
  return STATUS_STYLE[status] ?? STATUS_STYLE[""];
}
export function nextStatus(current: string) {
  const i = CYCLE.indexOf((current || "") as (typeof CYCLE)[number]);
  return CYCLE[(i + 1) % CYCLE.length];
}

const UPPER: [string[], string[]] = [
  ["UR8", "UR7", "UR6", "UR5", "UR4", "UR3", "UR2", "UR1"],
  ["UL1", "UL2", "UL3", "UL4", "UL5", "UL6", "UL7", "UL8"],
];
const LOWER: [string[], string[]] = [
  ["LR8", "LR7", "LR6", "LR5", "LR4", "LR3", "LR2", "LR1"],
  ["LL1", "LL2", "LL3", "LL4", "LL5", "LL6", "LL7", "LL8"],
];

// Every tooth in chart-reading order, grouped by quadrant — for the tooth picker.
export const TOOTH_QUADRANTS: { label: string; codes: string[] }[] = [
  { label: "Upper right", codes: UPPER[0] },
  { label: "Upper left", codes: UPPER[1] },
  { label: "Lower right", codes: LOWER[0] },
  { label: "Lower left", codes: LOWER[1] },
];

function Tooth({ code, status, editable, onToggle }: { code: string; status: string; editable: boolean; onToggle: (c: string) => void }) {
  const st = statusStyle(status);
  return (
    <button
      type="button"
      disabled={!editable}
      onClick={() => onToggle(code)}
      title={`Palmer ${code}${status ? ` · ${STATUS_LABEL[status] ?? status}` : ""}`}
      // title= never surfaces on touch, so the status has to be readable another
      // way — this is also what a screen reader announces per tooth.
      aria-label={`${code}${status ? ` — ${STATUS_LABEL[status] ?? status}` : ""}`}
      style={st}
      className={cn(
        // 28×32px was fine under a cursor; under a thumb it cycles the neighbour.
        // Below md each tooth shares its quadrant row at a 40px floor.
        "flex h-8 w-7 items-center justify-center rounded-md border text-xs font-semibold tabular-nums transition-transform max-md:h-10 max-md:w-full",
        editable ? "cursor-pointer hover:scale-110" : "cursor-default",
      )}
    >
      {code.slice(2)}
    </button>
  );
}

function Quadrant({ label, codes, teeth, editable, onToggle, align }: { label: string; codes: string[]; teeth: Record<string, string>; editable: boolean; onToggle: (c: string) => void; align: "end" | "start" }) {
  return (
    <div>
      {/* Stacked one per row below md, position no longer says which quadrant a
          row is — so the row says it itself. Hidden where layout still speaks. */}
      <p className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground md:hidden">{label}</p>
      <div className={cn(
        // Eight equal columns below md: the flex row with a 40px floor clipped the
        // eighth tooth at 390px; a grid divides whatever width exists exactly.
        "max-md:grid max-md:grid-cols-8 max-md:gap-1 md:flex md:gap-1",
        align === "end" ? "md:justify-end" : "md:justify-start")}>
        {codes.map((c) => (
          <Tooth key={c} code={c} status={teeth[c] ?? ""} editable={editable} onToggle={onToggle} />
        ))}
      </div>
    </div>
  );
}

export function ToothChart({ teeth, editable, onToggle }: { teeth: Record<string, string>; editable: boolean; onToggle: (code: string) => void }) {
  return (
    <div className="space-y-2">
      {/* Side by side the two arches need ~520px; a phone gets one quadrant per
          row so eight teeth fill the width instead of shrinking below a finger. */}
      <div className="grid grid-cols-1 gap-x-4 gap-y-2 border-b pb-3 md:grid-cols-2">
        <Quadrant label="Upper right" codes={UPPER[0]} teeth={teeth} editable={editable} onToggle={onToggle} align="end" />
        <Quadrant label="Upper left" codes={UPPER[1]} teeth={teeth} editable={editable} onToggle={onToggle} align="start" />
      </div>
      <div className="grid grid-cols-1 gap-x-4 gap-y-2 md:grid-cols-2">
        <Quadrant label="Lower right" codes={LOWER[0]} teeth={teeth} editable={editable} onToggle={onToggle} align="end" />
        <Quadrant label="Lower left" codes={LOWER[1]} teeth={teeth} editable={editable} onToggle={onToggle} align="start" />
      </div>
      <div className="flex flex-wrap gap-3 pt-1">
        {TOOTH_STATUSES.map((s) => {
          const st = statusStyle(s);
          return (
            <span key={s} className="flex items-center gap-1.5 text-xs text-muted-foreground">
              <span className="h-3 w-3 rounded-sm border" style={{ background: st.background, borderColor: st.borderColor }} />
              {STATUS_LABEL[s]}
            </span>
          );
        })}
      </div>
    </div>
  );
}
