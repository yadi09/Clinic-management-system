import { useEffect, useRef } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Users, X } from "lucide-react";

import { useAuth } from "@/app/auth-context";
import { Button } from "@/components/ui/button";
import { LIVE_TOASTER, toast } from "@/components/ui/sonner";
import { type AppNotification, listNotifications, notificationKeys } from "./api";
import { LIVE_KINDS, present, spoken } from "./kinds";
import { onscreen } from "./onscreen";
import { useOpenNotification } from "./shared";
import { announce, claim, soundOn } from "./sound";

/** Who can be sent patients: those are the people live alerts are for. */
export function receivesLiveAlerts(can: (perm: string) => boolean) {
  return can("encounter.manage") || can("dental.manage");
}

/** Opens the bell's list from anywhere (the summary pop-up's "View all"). */
export const OPEN_NOTIFICATIONS = "open-notifications";

const POLL_MS = 10_000;
const SHOW_MS = 12_000;

/** Watches for notifications that are happening now (a patient waiting) and
 *  announces each one once: a short pop-up, and a chime plus the spoken sentence
 *  if the person has sound on. Whatever was already there when the page opened is
 *  left to the sign-in pop-up; only what arrives afterwards is announced. */
export function LiveAlerts() {
  const { user, can } = useAuth();
  const uid = user?.id ?? "";
  const enabled = !!uid && receivesLiveAlerts(can);
  const qc = useQueryClient();
  const openItem = useOpenNotification(uid);
  // Stable for the effect below: the handler changes every render, the alerts
  // should not re-run because of it.
  const openRef = useRef(openItem);
  openRef.current = openItem;

  const live = useQuery({
    queryKey: [...notificationKeys.all(uid), "live"],
    queryFn: () => listNotifications({ unread: true, limit: 10 }),
    enabled,
    refetchInterval: POLL_MS,
    refetchIntervalInBackground: true,
  });

  // The newest creation time already accounted for, in server time, so the
  // device's own clock never matters. Null until the first answer arrives.
  const baseline = useRef<number | null>(null);
  const announced = useRef(new Set<string>());

  useEffect(() => {
    baseline.current = null;
    announced.current = new Set();
  }, [uid]);

  useEffect(() => {
    const items = live.data?.items;
    if (!items) return;
    const times = items.map((n) => Date.parse(n.created_at)).filter(Number.isFinite);
    const newest = times.length ? Math.max(...times) : 0;
    if (baseline.current === null) {
      baseline.current = newest;
      return;
    }
    const since = baseline.current;
    const fresh = items.filter(
      (n) => LIVE_KINDS.has(n.kind) && Date.parse(n.created_at) > since && !announced.current.has(n.id),
    );
    baseline.current = Math.max(since, newest);
    if (fresh.length === 0) return;
    fresh.forEach((n) => announced.current.add(n.id));
    // The badge, and the sign-in pop-up's list if it is open, should not wait for
    // their own slower polls.
    void qc.invalidateQueries({ queryKey: notificationKeys.count(uid) });
    void qc.invalidateQueries({ queryKey: notificationKeys.unread(uid) });

    const speakIt = soundOn(uid);
    if (onscreen.signInOpen) {
      // The sign-in pop-up is listing these already; just make the sound.
      if (speakIt && fresh.every((n) => claim(n.id))) {
        announce(fresh.length === 1 ? spoken(fresh[0]) : `${fresh.length} patients are waiting for you.`);
      }
      return;
    }
    if (fresh.length <= 2) {
      fresh.forEach((n) => {
        toast.custom((t) => <LiveToast n={n} onOpen={() => { toast.dismiss(t); openRef.current(n); }} onClose={() => toast.dismiss(t)} />, {
          id: `live-${n.id}`,
          toasterId: LIVE_TOASTER,
          duration: SHOW_MS,
        });
        if (speakIt && claim(n.id)) announce(spoken(n));
      });
    } else {
      const title = `${fresh.length} patients are waiting for you`;
      toast.custom((t) => (
        <SummaryToast
          title={title}
          onOpen={() => { toast.dismiss(t); window.dispatchEvent(new CustomEvent(OPEN_NOTIFICATIONS)); }}
          onClose={() => toast.dismiss(t)}
        />
      ), { toasterId: LIVE_TOASTER, duration: SHOW_MS });
      if (speakIt && fresh.every((n) => claim(n.id))) announce(`${fresh.length} patients are waiting for you.`);
    }
  }, [live.data, uid, qc]);

  return null;
}

/** "Almaz Bekele" -> "AB": the patient, recognisable at a glance. */
function initials(name: string) {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  return ((parts[0]?.[0] ?? "") + (parts.length > 1 ? parts[parts.length - 1][0] : "")).toUpperCase() || "?";
}

function Shell({ children, onClose }: { children: React.ReactNode; onClose: () => void }) {
  return (
    <div
      role="status"
      className="group relative w-[min(28rem,calc(100vw-24px))] overflow-hidden rounded-xl border bg-card text-card-foreground shadow-modal"
    >
      <div className="flex items-start gap-3 p-4 pr-11">{children}</div>
      <button
        type="button"
        onClick={onClose}
        aria-label="Dismiss"
        className="absolute right-2.5 top-2.5 rounded-md p-1.5 text-muted-foreground touch-hit hover:bg-accent hover:text-foreground"
      >
        <X className="h-4 w-4" />
      </button>
      {/* How long the pop-up has left. Paused while the pointer is on it, and
          still for people who ask for less motion. */}
      <div
        aria-hidden
        style={{ ["--countdown" as string]: `${SHOW_MS}ms` }}
        className="absolute inset-x-0 bottom-0 h-[3px] origin-left bg-primary/70 motion-safe:animate-countdown group-hover:[animation-play-state:paused]"
      />
    </div>
  );
}

function LiveToast({ n, onOpen, onClose }: { n: AppNotification; onOpen: () => void; onClose: () => void }) {
  const p = present(n);
  const where = p.detail.replace(/^Waiting for you ?/, "");
  return (
    <Shell onClose={onClose}>
      <span
        aria-hidden
        className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-primary text-sm font-semibold tracking-wide text-primary-foreground"
      >
        {initials(p.headline)}
      </span>
      <div className="min-w-0 flex-1">
        <p className="text-[15px] font-semibold leading-snug">{p.headline}</p>
        <p className="text-sm text-muted-foreground">is waiting for you{where ? ` ${where}` : ""}</p>
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <Button size="sm" className="h-8 px-4" onClick={onOpen}>
            Open
          </Button>
          {p.tag && (
            <span className="whitespace-nowrap rounded bg-muted px-1.5 py-px text-[11px] font-medium tabular-nums text-muted-foreground">
              {p.tag}
            </span>
          )}
        </div>
      </div>
    </Shell>
  );
}

function SummaryToast({ title, onOpen, onClose }: { title: string; onOpen: () => void; onClose: () => void }) {
  return (
    <Shell onClose={onClose}>
      <span aria-hidden className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-primary/10 text-primary">
        <Users className="h-5 w-5" />
      </span>
      <div className="min-w-0 flex-1">
        <p className="text-[15px] font-semibold leading-snug">{title}</p>
        <p className="text-sm text-muted-foreground">They're in your queue now.</p>
        <Button size="sm" className="mt-3 h-8 px-4" onClick={onOpen}>
          View all
        </Button>
      </div>
    </Shell>
  );
}
