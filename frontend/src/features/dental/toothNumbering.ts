// How this clinic numbers teeth on screen. A tooth is always STORED by its Palmer
// code ("UR6") — on plans, visits, examinations and the simple chart — so nothing
// already recorded changes. A clinic on the anatomical chart reads the same tooth
// by its FDI number ("16") everywhere, so it never sees two numbering systems.
import { useQuery } from "@tanstack/react-query";

import { getDentalSettings, type ChartStyle } from "@/features/dental/api";
import { fdiOf } from "@/features/dental/anatomical/geometry";

const PALMER = /\b(UR|UL|LL|LR)([1-8])\b/g;

/** The clinic's chart style; the simple chart until the setting is known. */
export function useChartStyle(): ChartStyle {
  const q = useQuery({ queryKey: ["dental-settings"], queryFn: getDentalSettings, staleTime: 300_000, retry: 1 });
  return q.data?.chart_style === "anatomical" ? "anatomical" : "simple";
}

/** Text that may name teeth ("UR6, UR7", "UR6 — crown"), in the clinic's numbering.
 *  Anything that is not a Palmer code is left exactly as written. */
export function toothText(text: string | null | undefined, style: ChartStyle): string {
  if (!text) return "";
  if (style !== "anatomical") return text;
  return text.replace(PALMER, (code) => String(fdiOf(code) ?? code));
}

/** toothText bound to this clinic's numbering. */
export function useToothText(): (text: string | null | undefined) => string {
  const style = useChartStyle();
  return (text) => toothText(text, style);
}
