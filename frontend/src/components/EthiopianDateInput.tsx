import { useState } from "react";

import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import {
  ETH_MONTHS,
  ethiopianDaysInMonth,
  ethiopianToGregorianISO,
  formatEthiopian,
  toEthiopian,
} from "@/lib/ethiopian";

/** Whole-years age from a Gregorian "YYYY-MM-DD" (null if invalid/future). */
function ageFromISO(iso: string): number | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
  if (!m) return null;
  const b = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  const now = new Date();
  let a = now.getFullYear() - b.getFullYear();
  if (now.getMonth() < b.getMonth() || (now.getMonth() === b.getMonth() && now.getDate() < b.getDate())) a--;
  return a >= 0 && a < 200 ? a : null;
}

const partsFromValue = (v: string) => {
  if (!v) return { y: "", m: "", d: "" };
  const e = toEthiopian(v);
  return { y: String(e.year), m: String(e.month), d: String(e.day) };
};

/**
 * Date-of-birth (or any date) entry that defaults to the Ethiopian calendar —
 * how patients in Ethiopia know their birthdate — while storing a Gregorian
 * "YYYY-MM-DD" value. Shows the converted date and the computed age. A toggle
 * switches to a plain Gregorian picker for Gregorian sources (e.g. an ID card).
 *
 * The three Ethiopian fields are the source of truth while editing; the stored
 * value is never pushed back into them mid-typing (that would clobber input).
 * They only re-sync from `value` when switching Gregorian → Ethiopian.
 */
export function EthiopianDateInput({ value, onChange, id, showAge = true }: { value: string; onChange: (v: string) => void; id?: string; showAge?: boolean }) {
  const [mode, setMode] = useState<"ethiopian" | "gregorian">("ethiopian");
  const [parts, setParts] = useState(() => partsFromValue(value));

  const commit = (next: { y: string; m: string; d: string }) => {
    setParts(next);
    const yi = Number(next.y), mi = Number(next.m), di = Number(next.d);
    const valid = next.y !== "" && next.m !== "" && next.d !== "" && yi >= 1 && yi <= 3000 && mi >= 1 && mi <= 13 && di >= 1 && di <= ethiopianDaysInMonth(yi, mi);
    onChange(valid ? ethiopianToGregorianISO(yi, mi, di) : "");
  };

  const switchMode = (mo: "ethiopian" | "gregorian") => {
    if (mo === "ethiopian") setParts(partsFromValue(value)); // reflect anything entered in Gregorian mode
    setMode(mo);
  };

  const maxDay = parts.m ? ethiopianDaysInMonth(Number(parts.y) || 2000, Number(parts.m)) : 30;
  const age = showAge && value ? ageFromISO(value) : null;
  const gregLong = value ? new Date(value + "T00:00:00").toLocaleDateString(undefined, { day: "numeric", month: "long", year: "numeric" }) : null;

  return (
    <div className="space-y-2">
      <div className="flex w-fit rounded-md border bg-card p-0.5 text-xs">
        {(["ethiopian", "gregorian"] as const).map((mo) => (
          <button
            key={mo}
            type="button"
            onClick={() => switchMode(mo)}
            className={`rounded px-2.5 py-1 font-medium max-md:min-h-9 max-md:px-3 ${mode === mo ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:text-foreground"}`}
          >
            {mo === "ethiopian" ? "Ethiopian" : "Gregorian"}
          </button>
        ))}
      </div>

      {mode === "ethiopian" ? (
        <div className="flex flex-wrap items-end gap-2">
          <div className="space-y-1">
            <span className="block text-xs text-muted-foreground">Month</span>
            <Select value={parts.m} onValueChange={(nm) => commit({ ...parts, m: nm })}>
              <SelectTrigger id={id} className="min-w-[10rem]"><SelectValue placeholder="Month" /></SelectTrigger>
              <SelectContent>
                {ETH_MONTHS.map((name, i) => <SelectItem key={name} value={String(i + 1)}>{name}</SelectItem>)}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1">
            <span className="block text-xs text-muted-foreground">Day</span>
            <Input className="w-20" type="number" min={1} max={maxDay} placeholder="Day" value={parts.d} onChange={(e) => commit({ ...parts, d: e.target.value })} />
          </div>
          <div className="space-y-1">
            <span className="block text-xs text-muted-foreground">Year (ዓ.ም)</span>
            <Input className="w-24" type="number" min={1} max={3000} placeholder="Year" value={parts.y} onChange={(e) => commit({ ...parts, y: e.target.value })} />
          </div>
        </div>
      ) : (
        <div className="space-y-1">
          <span className="block text-xs text-muted-foreground">Gregorian date</span>
          <Input id={id} className="w-52" type="date" value={value} onChange={(e) => onChange(e.target.value)} />
        </div>
      )}

      <p className="text-xs text-muted-foreground">
        {value ? (
          <>
            {mode === "ethiopian" ? `Gregorian: ${gregLong}` : `Ethiopian: ${formatEthiopian(value)} EC`}
            {age != null && <span className="ml-1 font-medium text-foreground">· Age {age}</span>}
          </>
        ) : mode === "ethiopian" ? (
          "Enter the Ethiopian birthdate (ዓ.ም)."
        ) : (
          "Enter the Gregorian date."
        )}
      </p>
    </div>
  );
}
