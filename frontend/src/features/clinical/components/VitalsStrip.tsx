// One set of observations, read the way a clinician reads them.
//
// The old tile rendered SpO2 65% and SpO2 98% identically — same colour, same size,
// separated only by a 10px chip beside the label. A peri-arrest set of vitals looked
// exactly like a well patient's. What matters first is whether anything is wrong at
// all, so that is answered in a sentence before the numbers; then the abnormal tiles
// carry the colour and the normal ones stay quiet, because the contrast is what makes
// one findable among seven.
import { AlertTriangle, Check } from "lucide-react";

import { cn } from "@/lib/utils";
import { vitalFlag, type VitalField, type Vitals } from "@/features/clinical/api";

export const FLAG_CLS: Record<string, string> = {
  normal: "border-emerald-200 bg-emerald-50 text-emerald-700",
  low: "border-sky-300 bg-sky-50 text-sky-700",
  high: "border-amber-300 bg-amber-50 text-amber-700",
  critical: "border-rose-300 bg-rose-50 text-rose-700",
};

export function hhmm(iso?: string) {
  if (!iso) return "";
  return new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

export type Flag = "low" | "normal" | "high" | null;

export function numOr(v: unknown): number | undefined {
  if (v == null || v === "") return undefined;
  const n = Number(v);
  return Number.isNaN(n) ? undefined : n;
}
// Combine two flags into the "most notable" one (abnormal wins over normal).
export function worstFlag(a: Flag, b: Flag): Flag {
  for (const want of ["high", "low", "normal"] as const) {
    if (a === want || b === want) return want;
  }
  return null;
}

// VitalsGrid renders one tile per configured vital, with Low/Normal/High flags
// computed from the clinic's reference ranges (shared by the workspace + history).
// It is data-driven off the clinic's vitals form so any enabled field (resp rate,
// height, …) appears — and any field that has a recorded value still shows even if
// later disabled, so the read-only history view never hides captured data.
export function VitalsGrid({ vitals, fields }: { vitals: Vitals; fields: VitalField[] }) {
  const flagOf = (key: string, v: number | undefined): Flag => {
    const f = fields.find((x) => x.key === key);
    if (!f || v === undefined) return null;
    return vitalFlag(f, v);
  };
  const val = (key: string): string | undefined => {
    const raw = (vitals as unknown as Record<string, unknown>)[key];
    return raw == null || raw === "" ? undefined : String(raw);
  };
  const shown = fields.filter((f) => f.enabled || val(f.key) !== undefined).sort((a, b) => a.order - b.order);
  const hasBP = shown.some((f) => f.key === "systolic") && shown.some((f) => f.key === "diastolic");

  const tiles: { key: string; label: string; value: string; flag: Flag }[] = [];
  let bpDone = false;
  for (const f of shown) {
    if ((f.key === "systolic" || f.key === "diastolic") && hasBP) {
      if (bpDone) continue;
      bpDone = true;
      const s = val("systolic"), d = val("diastolic");
      tiles.push({
        key: "bp", label: "BP",
        value: s && d ? `${s}/${d}` : "—",
        flag: worstFlag(flagOf("systolic", numOr(vitals.systolic)), flagOf("diastolic", numOr(vitals.diastolic))),
      });
      continue;
    }
    const v = val(f.key);
    tiles.push({
      key: f.key, label: f.label,
      value: v ? `${v}${f.unit ? ` ${f.unit}` : ""}` : "—",
      flag: flagOf(f.key, numOr(v)),
    });
  }

  const off = tiles.filter((t) => t.flag && t.flag !== "normal");

  return (
    <div className="space-y-2.5">
      {/* Is anything wrong? — answered before the doctor has to read five chips.
          The old grid rendered 65% SpO2 and 98% SpO2 in the same colour with a 10px
          label beside them, so a peri-arrest set of observations looked like any
          other. The summary answers it in one line; the tiles say which. */}
      {off.length > 0 ? (
        <p className="flex flex-wrap items-center gap-x-1.5 text-sm font-semibold text-destructive">
          <AlertTriangle className="h-4 w-4 shrink-0" />
          {off.length} of {tiles.length} outside the normal range
          <span className="font-normal text-muted-foreground">
            — {off.map((t) => t.label).join(", ")}
          </span>
        </p>
      ) : tiles.length > 0 ? (
        <p className="flex items-center gap-1.5 text-sm text-emerald-700">
          <Check className="h-4 w-4 shrink-0" /> All recorded vitals are within range
        </p>
      ) : null}

      <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-5">
        {tiles.map((t) => <VitalCard key={t.key} label={t.label} value={t.value} flag={t.flag} />)}
      </div>

      <p className="text-xs text-muted-foreground">
        Taken {hhmm(vitals.recorded_at)}
        {vitals.notes ? <> · <span className="text-foreground">{vitals.notes}</span></> : null}
      </p>
    </div>
  );
}

/** Loud when it matters, quiet when it does not — the contrast is what makes an
 *  abnormal observation findable at a glance. */
const VITAL_TONE: Record<string, { tile: string; value: string; chip: string }> = {
  low:      { tile: "border-sky-300 bg-sky-50/70",   value: "text-sky-800",   chip: "bg-sky-600" },
  high:     { tile: "border-amber-300 bg-amber-50",  value: "text-amber-800", chip: "bg-amber-500" },
  critical: { tile: "border-rose-300 bg-rose-50",    value: "text-rose-800",  chip: "bg-rose-600" },
};

export function VitalCard({ label, value, flag }: { label: string; value: string; flag?: Flag }) {
  const tone = flag && flag !== "normal" ? VITAL_TONE[flag] : undefined;
  return (
    <div className={cn("relative overflow-hidden rounded-lg border p-3",
      tone ? tone.tile : "bg-background")}>
      {tone && <span className={cn("absolute inset-y-0 left-0 w-1", tone.chip)} />}
      <div className="flex items-center justify-between gap-1">
        <p className={cn("text-xs", tone ? "font-medium text-foreground/70" : "text-muted-foreground")}>{label}</p>
        {tone && (
          <span className={cn("rounded-full px-1.5 text-[10px] font-bold uppercase tracking-wide text-white", tone.chip)}>
            {flag}
          </span>
        )}
      </div>
      <p className={cn("mt-0.5 font-semibold tabular-nums", tone ? `text-lg ${tone.value}` : "text-brand")}>{value}</p>
    </div>
  );
}

