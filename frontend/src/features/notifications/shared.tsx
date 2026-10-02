import { useMutation, useQueryClient } from "@tanstack/react-query";
import { ChevronRight } from "lucide-react";
import { useNavigate } from "react-router-dom";

import { DualDate } from "@/components/DualDate";
import { toast } from "@/components/ui/sonner";
import { cn } from "@/lib/utils";
import {
  type AppNotification,
  markAllNotificationsRead,
  markNotificationRead,
  notificationKeys,
  timeAgo,
} from "./api";
import { present } from "./kinds";

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
    mutationFn: (kind?: string) => markAllNotificationsRead(kind),
    onSuccess: () => after?.(),
    onSettled: () => qc.invalidateQueries({ queryKey: notificationKeys.all(userId) }),
    onError: () => toast.error("Could not mark notifications as read. Please try again."),
  });
}

export function NotificationRow({ n, onOpen }: { n: AppNotification; onOpen: (n: AppNotification) => void }) {
  const unread = !n.read_at;
  const p = present(n);
  const Icon = p.icon;
  return (
    <button
      type="button"
      onClick={() => onOpen(n)}
      aria-label={`${p.headline}. ${p.detail}.${unread ? " Unread." : ""}`}
      className="group flex w-full items-start gap-3 px-4 py-3 text-left transition-colors hover:bg-accent focus-visible:bg-accent focus-visible:outline-none"
    >
      <span
        aria-hidden
        className={cn(
          "mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-full",
          unread ? p.tone.unread : p.tone.read,
        )}
      >
        <Icon className="h-[18px] w-[18px]" />
      </span>
      <span className="min-w-0 flex-1">
        <span className="flex items-start gap-2">
          {/* The name wraps rather than truncates: staff act on the whole name,
              and on a phone a cut-off one is a guess. */}
          <span className="flex min-w-0 flex-1 flex-wrap items-center gap-x-2 gap-y-0.5">
            <span className={cn("break-words text-sm", unread ? "font-semibold text-foreground" : "font-medium text-foreground/80")}>
              {p.headline}
            </span>
            {p.tag && (
              <span className="whitespace-nowrap rounded bg-muted px-1.5 py-px text-[11px] font-medium tabular-nums text-muted-foreground">
                {p.tag}
              </span>
            )}
          </span>
          <span className="flex shrink-0 items-center gap-1.5 pt-0.5 text-xs text-muted-foreground">
            {timeAgo(n.created_at)}
            {unread && <span className="h-2 w-2 rounded-full bg-primary" />}
          </span>
        </span>
        <span className={cn("mt-0.5 block text-sm leading-snug", unread ? "text-foreground/80" : "text-muted-foreground")}>
          {p.detail}
        </span>
        {p.date && <DualDate iso={p.date} className="mt-0.5 block text-xs text-muted-foreground" />}
      </span>
      <ChevronRight
        aria-hidden
        className="mt-2.5 h-4 w-4 shrink-0 text-muted-foreground opacity-100 transition-opacity md:opacity-60 md:group-hover:opacity-100 md:group-focus-visible:opacity-100"
      />
    </button>
  );
}
