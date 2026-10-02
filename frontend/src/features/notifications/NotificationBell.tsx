import { useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useNavigate } from "react-router-dom";
import { AlertTriangle, ArrowRight, Bell, BellRing, CheckCheck, Volume2, VolumeX } from "lucide-react";

import { useAuth } from "@/app/auth-context";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Segmented } from "@/components/ui/segmented";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import { listNotifications, notificationCount, notificationKeys } from "./api";
import { OPEN_NOTIFICATIONS, receivesLiveAlerts } from "./LiveAlerts";
import { markSeen } from "./seen";
import { announce, canSpeak, setSoundOn, soundOn } from "./sound";
import { NotificationRow, useMarkAllRead, useOpenNotification } from "./shared";

const BELL_LIMIT = 10;

/** The bell in the top bar: an unread count, and the latest notifications when
 *  opened. The count is polled once a minute, a cheap request, so new items
 *  appear without a refresh and without holding a database connection open. */
export function NotificationBell() {
  const { user, can } = useAuth();
  const uid = user?.id ?? "";
  const [open, setOpen] = useState(false);
  // Doctors and dentists hear about waiting patients, so their badge keeps pace.
  const live = receivesLiveAlerts(can);
  const [sound, setSound] = useState(() => soundOn(uid));
  useEffect(() => setSound(soundOn(uid)), [uid]);
  const toggleSound = () => {
    const next = !sound;
    setSound(next);
    setSoundOn(uid, next);
    // Turning it on plays it once: proof it works, and the click is what lets
    // the browser play sound at all.
    if (next) announce("Sound is on. You will hear when a patient is waiting.");
  };

  useEffect(() => {
    const show = () => setOpen(true);
    window.addEventListener(OPEN_NOTIFICATIONS, show);
    return () => window.removeEventListener(OPEN_NOTIFICATIONS, show);
  }, []);

  const count = useQuery({
    queryKey: notificationKeys.count(uid),
    queryFn: notificationCount,
    enabled: !!uid,
    refetchInterval: live ? 10_000 : 60_000,
  });
  // Unread and Earlier are two views, switched, not two stacked lists: with many
  // unread, a list underneath would never be seen. It always opens on Unread, the
  // question people open the bell to answer; Earlier is one tap away.
  const [tab, setTab] = useState<"unread" | "read">("unread");
  const onOpenChange = (o: boolean) => {
    if (o) setTab("unread");
    setOpen(o);
  };
  const list = useQuery({
    queryKey: notificationKeys.list(uid, tab),
    queryFn: () => listNotifications({ status: tab, limit: BELL_LIMIT }),
    enabled: !!uid && open,
  });
  const openItem = useOpenNotification(uid, () => setOpen(false));
  const markAll = useMarkAllRead(uid);
  const navigate = useNavigate();
  const seeAll = () => {
    setOpen(false);
    navigate(`/notifications?status=${tab}`);
  };

  // While the list is open its own total is the freshest. Once it closes it is
  // no longer refetched, so the poll is the source again: reading the list's
  // last total kept a stale badge after a notification was opened.
  const unread = (open ? list.data?.unread : undefined) ?? count.data?.unread ?? 0;

  // Looking at the list counts as having seen what is in it, so the sign-in
  // pop-up does not show these again.
  useEffect(() => {
    if (open && list.data) markSeen(uid, list.data.items);
  }, [open, list.data, uid]);

  // One small pulse when something new arrives while the user is here, so a
  // badge that changed is noticed. Not on first load, and not for people who
  // ask for less motion (motion-safe).
  const [pulse, setPulse] = useState(false);
  const prev = useRef<number | null>(null);
  useEffect(() => {
    const n = count.data?.unread;
    if (n === undefined) return;
    if (prev.current !== null && n > prev.current) {
      setPulse(true);
      const t = setTimeout(() => setPulse(false), 2200);
      prev.current = n;
      return () => clearTimeout(t);
    }
    prev.current = n;
  }, [count.data?.unread]);

  const label = unread > 0 ? `Notifications, ${unread} unread` : "Notifications";
  const items = list.data?.items ?? [];
  const more = !!list.data?.next;
  const BellIcon = unread > 0 ? BellRing : Bell;

  return (
    <Popover open={open} onOpenChange={onOpenChange}>
      <PopoverTrigger asChild>
        <button className="relative rounded-md p-2 touch-hit hover:bg-white/10" aria-label={label}>
          <BellIcon className="h-5 w-5" />
          {unread > 0 && (
            <span className="absolute right-0.5 top-0.5 flex h-[18px] min-w-[18px] items-center justify-center rounded-full bg-destructive px-1 text-[10px] font-bold leading-none text-destructive-foreground ring-2 ring-brand">
              {pulse && (
                <span
                  aria-hidden
                  className="absolute inset-0 rounded-full bg-destructive motion-safe:animate-[ping_1s_cubic-bezier(0,0,0.2,1)_2]"
                />
              )}
              <span className="relative">{unread > 9 ? "9+" : unread}</span>
            </span>
          )}
        </button>
      </PopoverTrigger>
      <PopoverContent align="end" className="flex w-[min(25rem,calc(100vw-16px))] flex-col overflow-hidden p-0">
        <div className="flex items-center gap-2 px-4 pb-2 pt-3">
          <span className="text-sm font-semibold">Notifications</span>
          {live && canSpeak() && (
            <button
              type="button"
              onClick={toggleSound}
              aria-pressed={sound}
              aria-label={sound ? "Sound on. Turn off" : "Sound off. Turn on"}
              title={sound ? "Sound on" : "Sound off"}
              className={cn(
                "ml-auto rounded-md p-1.5 touch-hit hover:bg-accent",
                sound ? "text-primary" : "text-muted-foreground",
              )}
            >
              {sound ? <Volume2 className="h-4 w-4" /> : <VolumeX className="h-4 w-4" />}
            </button>
          )}
          {tab === "unread" && unread > 0 && (
            <Button
              variant="ghost"
              size="sm"
              className={cn("h-8 px-2 text-xs", !(live && canSpeak()) && "ml-auto")}
              loading={markAll.isPending}
              onClick={() => markAll.mutate(undefined)}
            >
              <CheckCheck className="mr-1 h-3.5 w-3.5" /> Mark all as read
            </Button>
          )}
        </div>
        <div className="border-b px-4 pb-3">
          <Segmented
            ariaLabel="Show"
            size="sm"
            value={tab}
            onChange={setTab}
            options={[
              { value: "unread", label: "Unread", badge: unread > 0 ? unread : undefined },
              { value: "read", label: "Earlier" },
            ]}
          />
        </div>
        <div className="max-h-[min(26rem,55dvh)] overflow-y-auto overscroll-contain">
          {list.isLoading ? (
            <div className="space-y-4 p-4">
              {[0, 1].map((i) => (
                <div key={i} className="flex gap-3">
                  <Skeleton className="h-9 w-9 rounded-full" />
                  <div className="flex-1 space-y-2">
                    <Skeleton className="h-3.5 w-2/3" />
                    <Skeleton className="h-3 w-full" />
                  </div>
                </div>
              ))}
            </div>
          ) : list.isError ? (
            // A failed load must never look like an empty inbox.
            <div className="flex flex-col items-center gap-3 px-6 py-8 text-center">
              <span className="flex h-11 w-11 items-center justify-center rounded-full bg-destructive/10 text-destructive">
                <AlertTriangle className="h-5 w-5" />
              </span>
              <div>
                <p className="text-sm font-medium">Notifications didn't load</p>
                <p className="mt-0.5 text-sm text-muted-foreground">Check the connection and try again.</p>
              </div>
              <Button variant="outline" size="sm" onClick={() => void list.refetch()}>
                Try again
              </Button>
            </div>
          ) : items.length === 0 ? (
            <div className="flex flex-col items-center gap-3 px-6 py-10 text-center">
              <span className="flex h-11 w-11 items-center justify-center rounded-full bg-primary/10 text-primary">
                <CheckCheck className="h-5 w-5" />
              </span>
              {tab === "unread" ? (
                <>
                  <div>
                    <p className="text-sm font-medium">You're all caught up</p>
                    <p className="mt-0.5 text-sm text-muted-foreground">New notifications will show up here.</p>
                  </div>
                  <Button variant="ghost" size="sm" onClick={() => setTab("read")}>
                    See earlier
                  </Button>
                </>
              ) : (
                <div>
                  <p className="text-sm font-medium">Nothing earlier yet</p>
                  <p className="mt-0.5 text-sm text-muted-foreground">Notifications you've read are kept here.</p>
                </div>
              )}
            </div>
          ) : (
            <div className="divide-y">
              {items.map((n) => (
                <NotificationRow key={n.id} n={n} onOpen={openItem} />
              ))}
            </div>
          )}
        </div>
        <button
          type="button"
          onClick={seeAll}
          className="flex items-center justify-center gap-1.5 border-t px-4 py-3 text-sm font-medium text-primary hover:bg-accent focus-visible:bg-accent focus-visible:outline-none"
        >
          {more ? "See all notifications" : "Open notifications page"}
          <ArrowRight className="h-4 w-4" aria-hidden />
        </button>
      </PopoverContent>
    </Popover>
  );
}
