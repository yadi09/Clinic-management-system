import { useEffect, useMemo } from "react";
import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { useSearchParams } from "react-router-dom";
import { BellOff, CheckCheck } from "lucide-react";

import { useAuth } from "@/app/auth-context";
import { LoadError } from "@/components/LoadError";
import { Button } from "@/components/ui/button";
import { Segmented } from "@/components/ui/segmented";
import { Skeleton } from "@/components/ui/skeleton";
import {
  type AppNotification,
  type NotificationStatus,
  listNotifications,
  notificationCount,
  notificationKeys,
} from "../api";
import { CATEGORIES } from "../kinds";
import { markSeen } from "../seen";
import { NotificationRow, useMarkAllRead, useOpenNotification } from "../shared";

const PAGE = 20;

/** "Today", "Yesterday", or the weekday and date, in the viewer's own day. */
function dayLabel(d: Date, now = new Date()): string {
  const start = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const diff = Math.round((start(now) - start(d)) / 86_400_000);
  if (diff === 0) return "Today";
  if (diff === 1) return "Yesterday";
  return d.toLocaleDateString(undefined, {
    weekday: "long",
    day: "numeric",
    month: "long",
    year: d.getFullYear() === now.getFullYear() ? undefined : "numeric",
  });
}

function byDay(items: AppNotification[]): { label: string; items: AppNotification[] }[] {
  const groups: { label: string; items: AppNotification[] }[] = [];
  for (const n of items) {
    const label = dayLabel(new Date(n.created_at));
    const last = groups[groups.length - 1];
    if (last?.label === label) last.items.push(n);
    else groups.push({ label, items: [n] });
  }
  return groups;
}

/** Every notification the signed-in person has had, filterable by read state and
 *  by kind, newest first, loaded twenty at a time. */
export function NotificationsPage() {
  const { user } = useAuth();
  const uid = user?.id ?? "";
  const [params, setParams] = useSearchParams();
  const status = (["unread", "read"].includes(params.get("status") ?? "") ? params.get("status") : "all") as NotificationStatus;
  const kind = CATEGORIES.some((c) => c.kind === params.get("kind")) ? (params.get("kind") as string) : "";
  const setFilter = (next: { status?: NotificationStatus; kind?: string }) => {
    const p = new URLSearchParams(params);
    const s = next.status ?? status;
    const k = next.kind ?? kind;
    if (s === "all") p.delete("status");
    else p.set("status", s);
    if (!k) p.delete("kind");
    else p.set("kind", k);
    setParams(p, { replace: true });
  };

  const counts = useQuery({
    queryKey: notificationKeys.count(uid),
    queryFn: notificationCount,
    enabled: !!uid,
  });
  const list = useInfiniteQuery({
    queryKey: notificationKeys.page(uid, status, kind),
    queryFn: ({ pageParam }) => listNotifications({ status, kind: kind || undefined, before: pageParam, limit: PAGE }),
    initialPageParam: null as string | null,
    getNextPageParam: (last) => last.next ?? undefined,
    enabled: !!uid,
  });
  const openItem = useOpenNotification(uid);
  const markAll = useMarkAllRead(uid);

  const items = useMemo(() => list.data?.pages.flatMap((p) => p.items) ?? [], [list.data]);
  const groups = useMemo(() => byDay(items), [items]);

  // Seeing them here counts as seen, so the sign-in pop-up does not repeat them.
  useEffect(() => {
    if (items.length) markSeen(uid, items);
  }, [items, uid]);

  const unreadTotal = counts.data?.unread ?? 0;
  const unreadHere = kind ? (counts.data?.by_kind[kind] ?? 0) : unreadTotal;
  const kindLabel = CATEGORIES.find((c) => c.kind === kind)?.label.toLowerCase();

  return (
    <div className="mx-auto max-w-3xl space-y-5">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1>Notifications</h1>
          <p className="text-sm text-muted-foreground">
            {unreadTotal > 0 ? `${unreadTotal} unread. ` : "You're all caught up. "}
            Open one to go straight to the patient.
          </p>
        </div>
        {unreadHere > 0 && (
          <Button variant="outline" size="sm" loading={markAll.isPending} onClick={() => markAll.mutate(kind || undefined)}>
            <CheckCheck className="mr-1.5 h-4 w-4" />
            {kindLabel ? `Mark ${kindLabel} as read` : "Mark all as read"}
          </Button>
        )}
      </div>

      {/* Read state first, kind underneath: two questions, two rows. Side by side
          they read as one long strip. */}
      <div className="flex flex-col items-start gap-2">
        <Segmented
          ariaLabel="Read state"
          value={status}
          onChange={(v) => setFilter({ status: v })}
          options={[
            { value: "all", label: "All" },
            { value: "unread", label: "Unread", badge: unreadTotal > 0 ? unreadTotal : undefined },
            { value: "read", label: "Earlier" },
          ]}
        />
        <Segmented
          ariaLabel="Category"
          size="sm"
          value={kind || "any"}
          onChange={(v) => setFilter({ kind: v === "any" ? "" : v })}
          options={[
            { value: "any", label: "All types" },
            ...CATEGORIES.map((c) => ({
              value: c.kind,
              label: c.label,
              badge: (counts.data?.by_kind[c.kind] ?? 0) > 0 ? counts.data?.by_kind[c.kind] : undefined,
            })),
          ]}
        />
      </div>

      {list.isLoading ? (
        <div className="space-y-4 rounded-xl border bg-card p-4">
          {[0, 1, 2].map((i) => (
            <div key={i} className="flex gap-3">
              <Skeleton className="h-9 w-9 rounded-full" />
              <div className="flex-1 space-y-2">
                <Skeleton className="h-3.5 w-1/2" />
                <Skeleton className="h-3 w-4/5" />
              </div>
            </div>
          ))}
        </div>
      ) : list.isError ? (
        <LoadError what="notifications" onRetry={() => void list.refetch()} />
      ) : items.length === 0 ? (
        <div className="flex flex-col items-center gap-3 rounded-xl border border-dashed bg-card px-6 py-14 text-center">
          <span className="flex h-12 w-12 items-center justify-center rounded-full bg-muted text-muted-foreground">
            {status === "unread" ? <CheckCheck className="h-5 w-5" /> : <BellOff className="h-5 w-5" />}
          </span>
          <div>
            <p className="font-medium">
              {status === "unread"
                ? kindLabel ? `No unread ${kindLabel}` : "You're all caught up"
                : status === "read"
                  ? "Nothing read yet"
                  : kindLabel ? `No ${kindLabel} yet` : "No notifications yet"}
            </p>
            <p className="mt-1 text-sm text-muted-foreground">
              {status === "unread" ? "New ones appear here and in the bell." : "When something needs you, it will show up here."}
            </p>
          </div>
          {(status !== "all" || kind) && (
            <Button variant="ghost" size="sm" onClick={() => setFilter({ status: "all", kind: "" })}>
              Show all notifications
            </Button>
          )}
        </div>
      ) : (
        <div className="space-y-4">
          {groups.map((g) => (
            <section key={g.label} aria-label={g.label}>
              <h2 className="mb-1.5 px-1 text-sm font-medium text-muted-foreground">{g.label}</h2>
              <div className="divide-y overflow-hidden rounded-xl border bg-card">
                {g.items.map((n) => (
                  <NotificationRow key={n.id} n={n} onOpen={openItem} />
                ))}
              </div>
            </section>
          ))}
          <div className="flex justify-center pb-2">
            {list.hasNextPage ? (
              <Button variant="outline" loading={list.isFetchingNextPage} onClick={() => void list.fetchNextPage()}>
                Show more
              </Button>
            ) : (
              <p className="text-sm text-muted-foreground">
                {items.length === 1 ? "That's the only one." : `That's all ${items.length}.`}
              </p>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
