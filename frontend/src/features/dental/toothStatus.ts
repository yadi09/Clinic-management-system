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
/** A mark whose condition this page does not know. Deliberately NOT blank: it used
 *  to render exactly like an unmarked tooth, so a chart whose condition list failed
 *  to load read as a healthy mouth (audit D12). */
const UNKNOWN = { background: "#f1f1f4", borderColor: "#6b6b7a", color: "#3d3d4a" };

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
  loading: boolean;
  /** The condition list has loaded and has entries. Until it has, the chart must
   *  not be edited: a tap would compute its next mark from an empty list. */
  ready: boolean;
  failed: boolean;
  retry: () => void;
}

export function useToothStatuses(): ToothStatuses {
  // Retired conditions are fetched too, for display only: a tooth marked "crown"
  // before the clinic retired crowns still shows as a crown. Tapping cycles through
  // the active ones.
  const q = useQuery({ queryKey: ["tooth-statuses", "all"], queryFn: () => listToothStatuses(true), staleTime: 300000 });
  const all = q.data ?? [];
  const list = all.filter((s) => s.is_active);
  const by = new Map(all.map((s) => [s.code, s]));
  const ready = q.isSuccess && list.length > 0;
  return {
    list,
    loading: q.isLoading,
    ready,
    failed: q.isError,
    retry: () => { void q.refetch(); },
    // A code no longer in the list is still shown: a tooth marked "crown" before the
    // clinic retired crowns was marked by a dentist, and the record stands.
    labelOf: (code) => by.get(code)?.label ?? (code ? code.replace(/_/g, " ") : ""),
    styleOf: (code) => {
      if (!code) return BLANK;
      const s = by.get(code);
      if (!s) return UNKNOWN;
      return { background: tint(s.color, 0.14), borderColor: s.color, color: s.color };
    },
  };
}
