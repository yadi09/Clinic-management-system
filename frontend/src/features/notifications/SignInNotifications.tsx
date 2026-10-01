import { useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { BellRing, CalendarX2, CheckCheck } from "lucide-react";

import { useAuth } from "@/app/auth-context";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { cn } from "@/lib/utils";
import { listNotifications, notificationKeys } from "./api";
import { summarize } from "./kinds";
import { hasUnseen, markSeen } from "./seen";
import { NotificationRow, useMarkAllRead, useOpenNotification } from "./shared";

const SHOWN = 5;

/** On opening the app, if the user has unread notifications newer than the ones
 *  they have already seen (here or in the bell), list them. Nothing unread, or
 *  nothing new since last time: no pop-up. Decided once per sign-in, so it never
 *  reappears while they work. */
export function SignInNotifications() {
  const { user } = useAuth();
  const uid = user?.id ?? "";
  const [open, setOpen] = useState(false);
  const decidedFor = useRef<string | null>(null);

  const unread = useQuery({
    queryKey: notificationKeys.unread(uid),
    queryFn: () => listNotifications({ unread: true, limit: SHOWN }),
    enabled: !!uid,
    // Always fetch at sign-in. A fresh cache from a quick sign-out and back in
    // would otherwise skip the fetch, and the pop-up would never be decided.
    refetchOnMount: "always",
  });

  useEffect(() => {
    // Only on data fetched for this sign-in: a cache left from an earlier session
    // in this tab could list notifications that have since been read.
    if (!uid || decidedFor.current === uid || !unread.data || !unread.isFetchedAfterMount) return;
    decidedFor.current = uid;
    if (hasUnseen(uid, unread.data.items)) setOpen(true);
  }, [uid, unread.data, unread.isFetchedAfterMount]);

  const close = () => {
    markSeen(uid, unread.data?.items);
    setOpen(false);
  };
  const openItem = useOpenNotification(uid, close);
  const markAll = useMarkAllRead(uid, close);

  const items = unread.data?.items ?? [];
  const total = unread.data?.unread ?? items.length;
  const more = total - items.length;
  const { title, lead } = summarize(items, total);
  const missedOnly = items.length > 0 && items.every((n) => n.kind === "missed_visit");
  const Icon = missedOnly ? CalendarX2 : BellRing;

  return (
    <Dialog open={open} onOpenChange={(o) => (o ? setOpen(true) : close())}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader className="flex-row items-start gap-3 space-y-0">
          <span
            aria-hidden
            className={cn(
              "flex h-10 w-10 shrink-0 items-center justify-center rounded-full",
              missedOnly ? "bg-amber-100 text-amber-700" : "bg-primary/10 text-primary",
            )}
          >
            <Icon className="h-5 w-5" />
          </span>
          <div className="min-w-0 space-y-1 pr-6">
            <DialogTitle>{title}</DialogTitle>
            <DialogDescription>{lead}</DialogDescription>
          </div>
        </DialogHeader>
        {/* Full-bleed rows, edge to edge like the bell's list. */}
        <div className="-mx-6 max-h-[50dvh] divide-y overflow-y-auto overscroll-contain border-y">
          {items.map((n) => (
            <NotificationRow key={n.id} n={n} onOpen={openItem} />
          ))}
        </div>
        {more > 0 && (
          <p className="text-sm text-muted-foreground">
            {more === 1 ? "1 more is" : `${more} more are`} in the bell at the top of the page.
          </p>
        )}
        <DialogFooter className="sm:justify-between">
          <Button variant="ghost" loading={markAll.isPending} onClick={() => markAll.mutate()}>
            <CheckCheck className="mr-1.5 h-4 w-4" /> Mark all as read
          </Button>
          <Button onClick={close}>Got it</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
