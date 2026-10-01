import type { AppNotification } from "./api";

/** "Seen" is a point in time, per user on this device: the creation time of the
 *  newest notification the user has been shown, in the pop-up or the bell. The
 *  sign-in pop-up appears only for unread notifications newer than that. A
 *  single remembered id was not enough: reading the newest one made the next
 *  unread look new, and the pop-up came back on every reload.
 *
 *  Storage can be unavailable (private window, blocked site data). Then nothing
 *  is remembered and the pop-up shows whenever something is unread. */
function key(userId: string) {
  return `clinicos.notifications.seen.${userId}`;
}

export function seenUntil(userId: string): number {
  try {
    const v = Number(window.localStorage.getItem(key(userId)));
    return Number.isFinite(v) ? v : 0;
  } catch {
    return 0;
  }
}

/** Moves the seen point forward to the newest of `items`; never backward. */
export function markSeen(userId: string, items: AppNotification[] | undefined) {
  if (!userId || !items?.length) return;
  const newest = Math.max(...items.map((n) => Date.parse(n.created_at)).filter(Number.isFinite));
  if (!Number.isFinite(newest) || newest <= seenUntil(userId)) return;
  try {
    window.localStorage.setItem(key(userId), String(newest));
  } catch {
    /* nothing to remember with */
  }
}

/** True when at least one of these notifications is newer than the seen point. */
export function hasUnseen(userId: string, items: AppNotification[] | undefined): boolean {
  const since = seenUntil(userId);
  return !!items?.some((n) => Date.parse(n.created_at) > since);
}
