// The conditions this clinic marks on a tooth, and how they look.
//
// These used to be five constants compiled into the chart. They are now the clinic's
// own list, so everything that draws a tooth — the chart, the legend, the picker,
// the toast after a tap — reads them from one place rather than from five copies of
// the same hard-coded map.
import { useQuery } from "@tanstack/react-query";

import { listToothStatuses, type ToothStatusDef } from "@/features/dental/api";

/** An unmarked tooth. Not a condition, so it is never in the clinic's list. */
const BLANK = { background: "#ffffff", borderColor: "#dddde8", color: "#c9c9d4" };

/** The pale fill behind a tooth, derived from the one colour a clinic picked. */
function tint(hex: string, alpha: number) {
  const h = hex.replace("#", "");
  const n = parseInt(h.length === 3 ? h.split("").map((c) => c + c).join("") : h, 16);
  const [r, g, b] = [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  // Mixed against white rather than left translucent: a tooth sits on cards of
  // several shades, and a translucent fill would read differently on each.
  const mix = (c: number) => Math.round(c * alpha + 255 * (1 - alpha));
  return `rgb(${mix(r)}, ${mix(g)}, ${mix(b)})`;
}

export interface ToothStatuses {
  list: ToothStatusDef[];
  labelOf: (code: string) => string;
  styleOf: (code: string) => { background: string; borderColor: string; color: string };
  /** Tapping a tooth walks the clinic's own conditions, then back to unmarked. */
  next: (current: string) => string;
  loading: boolean;
}

export function useToothStatuses(): ToothStatuses {
  const q = useQuery({ queryKey: ["tooth-statuses"], queryFn: () => listToothStatuses(), staleTime: 300000 });
  const list = q.data ?? [];
  const by = new Map(list.map((s) => [s.code, s]));
  return {
    list,
    loading: q.isLoading,
    // A code no longer in the list is still shown: a tooth marked "crown" before the
    // clinic retired crowns was marked by a dentist, and the record stands.
    labelOf: (code) => by.get(code)?.label ?? (code ? code.replace(/_/g, " ") : ""),
    styleOf: (code) => {
      const s = by.get(code);
      if (!s) return BLANK;
      return { background: tint(s.color, 0.14), borderColor: s.color, color: s.color };
    },
    next: (current) => {
      const codes = ["", ...list.map((s) => s.code)];
      const i = codes.indexOf(current || "");
      return codes[(i + 1) % codes.length];
    },
  };
}
