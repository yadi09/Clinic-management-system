import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "react-router-dom";

import { toast } from "@/components/ui/sonner";
import { cn } from "@/lib/utils";
import {
  type AppNotification,
  markAllNotificationsRead,
  markNotificationRead,
  notificationKeys,
  timeAgo,
} from "./api";

/** Opening a notification marks it read and goes where it points. Navigation does
 *  not wait for the mark: the user asked to see the patient, and a slow or failed
 *  write must not stand between them and that. A failed mark only means the dot
 *  stays, so it is said quietly rather than blocking. */
export function useOpenNotification(userId: string, after?: () => void) {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const mark = useMutation({
    mutationFn: (id: string) => markNotificationRead(id),
    onSettled: () => qc.invalidateQueries({ queryKey: notificationKeys.all(userId) }),
    onError: () => toast.error("Could not mark that notification as read"),
  });
  return (n: AppNotification) => {
    if (!n.read_at) mark.mutate(n.id);
    after?.();
    if (n.href) navigate(n.href);
  };
}

export function useMarkAllRead(userId: string, after?: () => void) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: markAllNotificationsRead,
    onSuccess: () => after?.(),
    onSettled: () => qc.invalidateQueries({ queryKey: notificationKeys.all(userId) }),
    onError: () => toast.error("Could not mark notifications as read. Please try again."),
  });
}

export function NotificationRow({ n, onOpen }: { n: AppNotification; onOpen: (n: AppNotification) => void }) {
  const unread = !n.read_at;
  return (
    <button
      type="button"
      onClick={() => onOpen(n)}
      className={cn(
        "flex w-full gap-3 px-4 py-3 text-left transition-colors hover:bg-accent focus-visible:bg-accent focus-visible:outline-none",
        unread && "bg-primary/5",
      )}
    >
      <span
        aria-hidden
        className={cn("mt-1.5 h-2 w-2 shrink-0 rounded-full", unread ? "bg-primary" : "bg-transparent")}
      />
      <span className="min-w-0 flex-1">
        <span className="flex items-baseline justify-between gap-2">
          <span className={cn("truncate text-sm", unread ? "font-semibold" : "font-medium text-muted-foreground")}>
            {n.title}
          </span>
          <span className="shrink-0 text-xs text-muted-foreground">{timeAgo(n.created_at)}</span>
        </span>
        <span className="mt-0.5 block text-sm leading-snug text-muted-foreground">{n.body}</span>
      </span>
      <span className="sr-only">{unread ? "Unread" : "Read"}</span>
    </button>
  );
}
