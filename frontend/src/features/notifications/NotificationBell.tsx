import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Bell, CheckCheck } from "lucide-react";

import { useAuth } from "@/app/auth-context";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Skeleton } from "@/components/ui/skeleton";
import { listNotifications, notificationCount, notificationKeys } from "./api";
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
  const label = unread > 0 ? `Notifications, ${unread} unread` : "Notifications";

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button className="relative rounded-md p-2 touch-hit hover:bg-white/10" aria-label={label}>
          <Bell className="h-5 w-5" />
          {unread > 0 && (
            <span className="absolute right-0.5 top-0.5 flex h-[18px] min-w-[18px] items-center justify-center rounded-full bg-destructive px-1 text-[10px] font-bold leading-none text-destructive-foreground ring-2 ring-brand">
              {unread > 9 ? "9+" : unread}
            </span>
          )}
        </button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-[min(24rem,calc(100vw-16px))] p-0">
        <div className="flex items-center justify-between gap-2 border-b px-4 py-3">
          <span className="text-sm font-semibold">Notifications</span>
          {unread > 0 && (
            <Button
              variant="ghost"
              size="sm"
              className="h-8 px-2 text-xs"
              loading={markAll.isPending}
              onClick={() => markAll.mutate()}
            >
              <CheckCheck className="mr-1 h-3.5 w-3.5" /> Mark all as read
            </Button>
          )}
        </div>
        <div className="max-h-[min(28rem,60dvh)] overflow-y-auto">
          {list.isLoading ? (
            <div className="space-y-3 p-4">
              <Skeleton className="h-10 w-full" />
              <Skeleton className="h-10 w-full" />
            </div>
          ) : list.isError ? (
            // A failed load must never look like an empty inbox.
            <div className="space-y-2 p-4 text-sm">
              <p className="text-destructive">Couldn't load notifications.</p>
              <Button variant="outline" size="sm" onClick={() => void list.refetch()}>
                Try again
              </Button>
            </div>
          ) : (list.data?.items.length ?? 0) === 0 ? (
            <p className="p-6 text-center text-sm text-muted-foreground">You're all caught up.</p>
          ) : (
            <div className="divide-y">
              {list.data!.items.map((n) => (
                <NotificationRow key={n.id} n={n} onOpen={openItem} />
              ))}
            </div>
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
}
