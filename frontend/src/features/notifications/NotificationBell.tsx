import { useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { AlertTriangle, Bell, BellRing, CheckCheck } from "lucide-react";

import { useAuth } from "@/app/auth-context";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import { type AppNotification, listNotifications, notificationCount, notificationKeys } from "./api";
import { markSeen } from "./seen";
import { NotificationRow, useMarkAllRead, useOpenNotification } from "./shared";

/** The bell in the top bar: an unread count, and the latest notifications when
 *  opened. The count is polled once a minute, a cheap request, so new items
 *  appear without a refresh and without holding a database connection open. */
export function NotificationBell() {
  const { user } = useAuth();
  const uid = user?.id ?? "";
  const [open, setOpen] = useState(false);

  const count = useQuery({
    queryKey: notificationKeys.count(uid),
    queryFn: notificationCount,
    enabled: !!uid,
    refetchInterval: 60_000,
  });
  const list = useQuery({
    queryKey: notificationKeys.list(uid),
    queryFn: () => listNotifications({ limit: 20 }),
    enabled: !!uid && open,
  });
  const openItem = useOpenNotification(uid, () => setOpen(false));
  const markAll = useMarkAllRead(uid);

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
  const fresh = items.filter((n) => !n.read_at);
  const earlier = items.filter((n) => n.read_at);
  const BellIcon = unread > 0 ? BellRing : Bell;

  return (
    <Popover open={open} onOpenChange={setOpen}>
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
      <PopoverContent align="end" className="w-[min(25rem,calc(100vw-16px))] overflow-hidden p-0">
        <div className="flex items-center gap-2 border-b px-4 py-3">
          <span className="text-sm font-semibold">Notifications</span>
          {unread > 0 && (
            <span className="rounded-full bg-primary/10 px-2 py-0.5 text-xs font-semibold tabular-nums text-primary">
              {unread} unread
            </span>
          )}
          {unread > 0 && (
            <Button
              variant="ghost"
              size="sm"
              className="ml-auto h-8 px-2 text-xs"
              loading={markAll.isPending}
              onClick={() => markAll.mutate()}
            >
              <CheckCheck className="mr-1 h-3.5 w-3.5" /> Mark all as read
            </Button>
          )}
        </div>
        <div className="max-h-[min(30rem,65dvh)] overflow-y-auto overscroll-contain">
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
              <div>
                <p className="text-sm font-medium">You're all caught up</p>
                <p className="mt-0.5 text-sm text-muted-foreground">When a patient misses a visit, you'll see it here.</p>
              </div>
            </div>
          ) : (
            <>
              <Section title="Unread" items={fresh} onOpen={openItem} />
              <Section title="Earlier" items={earlier} onOpen={openItem} muted />
            </>
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
}

function Section({ title, items, onOpen, muted }: {
  title: string;
  items: AppNotification[];
  onOpen: (n: AppNotification) => void;
  muted?: boolean;
}) {
  if (items.length === 0) return null;
  return (
    <section aria-label={title}>
      <h3 className={cn("bg-muted/40 px-4 py-1.5 text-xs font-medium", muted ? "text-muted-foreground" : "text-foreground")}>
        {title}
      </h3>
      <div className="divide-y">
        {items.map((n) => (
          <NotificationRow key={n.id} n={n} onOpen={onOpen} />
        ))}
      </div>
    </section>
  );
}
