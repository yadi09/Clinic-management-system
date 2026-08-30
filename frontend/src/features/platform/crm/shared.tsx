// Pieces the CRM screens share, so a clinic reads the same on the board, in the
// list and in its own record.
import { Phone, MapPin, Clock } from "lucide-react";
import type { Prospect } from "@/features/platform/api";

export const STATUS_LABEL: Record<string, string> = {
  open: "Working",
  signed_up: "Signed up",
  not_yet: "Not yet",
  not_interested: "Not interested",
};
export const STATUS_CLS: Record<string, string> = {
  open: "bg-sky-500/15 text-sky-300 border-sky-500/30",
  signed_up: "bg-emerald-500/15 text-emerald-300 border-emerald-500/30",
  not_yet: "bg-amber-500/15 text-amber-300 border-amber-500/30",
  not_interested: "bg-zinc-500/15 text-zinc-400 border-zinc-500/30",
};

export const TOUCH_LABEL: Record<string, string> = {
  call: "Called", visit: "Visited", message: "Messaged", note: "Noted",
};

export function ago(iso?: string) {
  if (!iso) return "";
  const m = Math.round((Date.now() - new Date(iso).getTime()) / 60000);
  if (m < 1) return "just now";
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.round(h / 24);
  return d === 1 ? "yesterday" : `${d} days ago`;
}

/** Google Maps for whatever we know: the pasted link, or a search on the address. */
export function mapHref(p: Prospect) {
  if (p.map_url) return p.map_url;
  if (p.address) return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(p.address)}`;
  return "";
}

/**
 * The two things a rep does standing outside a building, as links rather than text.
 *
 * A number they have to retype into the dialler is a number they do not ring.
 */
export function ContactActions({ p, size = "sm" }: { p: Prospect; size?: "sm" | "md" }) {
  const cls = size === "sm"
    ? "inline-flex items-center gap-1 rounded-md border border-zinc-700 px-2 py-1 text-xs text-zinc-200 hover:border-zinc-500 hover:bg-zinc-800"
    : "inline-flex items-center gap-1.5 rounded-md border border-zinc-700 px-3 py-1.5 text-sm text-zinc-200 hover:border-zinc-500 hover:bg-zinc-800";
  const map = mapHref(p);
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {p.phone && (
        <a href={`tel:${p.phone.replace(/\s/g, "")}`} className={cls} onClick={(e) => e.stopPropagation()}>
          <Phone className="h-3.5 w-3.5" /> {p.phone}
        </a>
      )}
      {map && (
        <a href={map} target="_blank" rel="noreferrer" className={cls} onClick={(e) => e.stopPropagation()}>
          <MapPin className="h-3.5 w-3.5" /> Directions
        </a>
      )}
    </div>
  );
}

/**
 * When this clinic was last touched, and by whom.
 *
 * The single most important line on the card: it is what stops the second rep
 * phoning a clinic the first rep called yesterday. "Never contacted" is said out
 * loud rather than left blank, because a blank reads as missing data.
 */
export function LastTouch({ p }: { p: Prospect }) {
  if (!p.last_touch_at) {
    return <p className="flex items-center gap-1 text-xs text-amber-400/80"><Clock className="h-3 w-3" /> Never contacted</p>;
  }
  return (
    <p className="flex items-center gap-1 text-xs text-zinc-400">
      <Clock className="h-3 w-3" />
      {TOUCH_LABEL[p.last_touch_kind ?? ""] ?? "Contacted"} {ago(p.last_touch_at)}
      {p.last_touch_by ? ` · ${p.last_touch_by}` : ""}
      {p.touches > 1 ? ` · ${p.touches} in all` : ""}
    </p>
  );
}

export function StatusChip({ status }: { status: string }) {
  return (
    <span className={`rounded-full border px-2 py-0.5 text-[11px] font-medium ${STATUS_CLS[status] ?? STATUS_CLS.open}`}>
      {STATUS_LABEL[status] ?? status}
    </span>
  );
}
