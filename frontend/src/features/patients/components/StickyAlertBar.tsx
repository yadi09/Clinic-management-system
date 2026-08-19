// Clinical alerts that never scroll away.
//
// Allergies and treatment-affecting conditions are shown in the patient banner,
// which is fine until someone scrolls down to write a prescription — at which
// point the one thing that could prevent harm has left the screen. This watches
// the banner and, once it scrolls out of view, pins a compact bar in its place.
//
// It renders nothing when there is nothing to warn about: a bar that is always
// present is a bar people stop reading.
import { useEffect, useRef, useState, type RefObject } from "react";
import { AlertTriangle } from "lucide-react";

import { cn } from "@/lib/utils";

export interface ClinicalAlert {
  key: string;
  /** danger = change the plan before treating; warn = proceed with care. */
  level: "danger" | "warn";
  text: string;
}

/**
 * Watches `bannerRef`; reports whether it has scrolled out of view.
 * Kept as a hook so a page can also use it for other sticky affordances.
 */
export function useScrolledPast(bannerRef: RefObject<HTMLElement | null>) {
  const [past, setPast] = useState(false);
  useEffect(() => {
    const el = bannerRef.current;
    if (!el || typeof IntersectionObserver === "undefined") return;
    const io = new IntersectionObserver(
      ([e]) => setPast(!e.isIntersecting && e.boundingClientRect.top < 0),
      { threshold: 0 },
    );
    io.observe(el);
    return () => io.disconnect();
  }, [bannerRef]);
  return past;
}

export function StickyAlertBar({ alerts, show, patientName }: {
  alerts: ClinicalAlert[];
  show: boolean;
  patientName?: string;
}) {
  const [dismissedFor, setDismissed] = useState<string | null>(null);
  // Re-arm whenever the alert set changes: dismissing "penicillin" must not also
  // silence a newly added anticoagulant warning.
  const signature = alerts.map((a) => a.key).join("|");
  const prev = useRef(signature);
  useEffect(() => {
    if (prev.current !== signature) { prev.current = signature; setDismissed(null); }
  }, [signature]);

  if (alerts.length === 0 || !show || dismissedFor === signature) return null;
  const danger = alerts.some((a) => a.level === "danger");

  return (
    <div
      role="status"
      aria-live="polite"
      className={cn(
        "sticky top-16 z-30 -mx-2 mb-3 flex flex-wrap items-center gap-x-3 gap-y-1.5 rounded-b-lg border-b px-4 py-2 shadow-sm backdrop-blur",
        danger ? "border-rose-300 bg-rose-50/95 text-rose-900" : "border-amber-300 bg-amber-50/95 text-amber-900",
      )}
    >
      <AlertTriangle className={cn("h-4 w-4 shrink-0", danger ? "text-rose-600" : "text-amber-600")} />
      {patientName && <span className="text-sm font-semibold">{patientName}</span>}
      <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-sm">
        {alerts.map((a, i) => (
          <span key={a.key} className="flex items-center gap-2">
            {i > 0 && <span className="text-current/40">·</span>}
            <span className={cn(a.level === "danger" && "font-semibold")}>{a.text}</span>
          </span>
        ))}
      </div>
      <button
        type="button"
        onClick={() => setDismissed(signature)}
        className="ml-auto shrink-0 rounded px-2 py-0.5 text-xs font-medium underline-offset-2 hover:underline"
      >
        Hide
      </button>
    </div>
  );
}
