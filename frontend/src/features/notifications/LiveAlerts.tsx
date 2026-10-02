import { useEffect, useRef } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { X } from "lucide-react";

import { useAuth } from "@/app/auth-context";
import { Button } from "@/components/ui/button";
import { toast } from "@/components/ui/sonner";
import { cn } from "@/lib/utils";
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
      ), { duration: SHOW_MS });
      if (speakIt && fresh.every((n) => claim(n.id))) announce(`${fresh.length} patients are waiting for you.`);
    }
  }, [live.data, uid, qc]);

  return null;
}

function Shell({ children, onClose }: { children: React.ReactNode; onClose: () => void }) {
  return (
    <div className="relative flex w-[min(24rem,calc(100vw-32px))] gap-3 rounded-lg border border-primary/25 bg-card p-4 pr-10 text-card-foreground shadow-popover">
      {children}
      <button
        type="button"
        onClick={onClose}
        aria-label="Dismiss"
        className="absolute right-2 top-2 rounded-md p-1.5 text-muted-foreground touch-hit hover:bg-accent hover:text-foreground"
      >
        <X className="h-4 w-4" />
      </button>
    </div>
  );
}

function LiveToast({ n, onOpen, onClose }: { n: AppNotification; onOpen: () => void; onClose: () => void }) {
  const p = present(n);
  const Icon = p.icon;
  return (
    <Shell onClose={onClose}>
      <span aria-hidden className={cn("flex h-10 w-10 shrink-0 items-center justify-center rounded-full", p.tone.unread)}>
        <Icon className="h-5 w-5" />
      </span>
      <div className="min-w-0 flex-1">
        <p className="text-sm font-semibold leading-snug">{spoken(n).replace(/\.$/, "")}</p>
        <p className="mt-0.5 flex flex-wrap items-center gap-x-2 text-sm text-muted-foreground">
          {p.tag && (
            <span className="whitespace-nowrap rounded bg-muted px-1.5 py-px text-[11px] font-medium tabular-nums">{p.tag}</span>
          )}
          <span>{p.detail.replace(/^Waiting for you ?/, "") || "Just now"}</span>
        </p>
        <Button size="sm" className="mt-3 h-8" onClick={onOpen}>
          Open
        </Button>
      </div>
    </Shell>
  );
}

function SummaryToast({ title, onOpen, onClose }: { title: string; onOpen: () => void; onClose: () => void }) {
  return (
    <Shell onClose={onClose}>
      <div className="min-w-0 flex-1">
        <p className="text-sm font-semibold">{title}</p>
        <Button size="sm" className="mt-3 h-8" onClick={onOpen}>
          View all
        </Button>
      </div>
    </Shell>
  );
}
