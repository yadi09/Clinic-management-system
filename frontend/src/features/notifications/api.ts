import { apiFetch } from "@/lib/api-client";

/** One item in the signed-in user's inbox. `href` is where opening it goes,
 *  decided by the server per kind, so a new kind needs no change here. */
export interface AppNotification {
  id: string;
  kind: string;
  title: string;
  /** The readable sentence; the fallback when a kind's fields are missing. */
  body: string;
  /** The same facts as fields, by kind (missed visit: patient, card, course,
   *  visit, date). */
  data?: Record<string, unknown>;
  href: string;
  created_at: string;
  read_at: string | null;
}

export interface NotificationPage {
  items: AppNotification[];
  /** Unread total, which can be larger than the page. */
  unread: number;
}

export function listNotifications(opts: { unread?: boolean; limit?: number } = {}) {
  const q = new URLSearchParams();
  if (opts.unread) q.set("unread", "1");
  if (opts.limit) q.set("limit", String(opts.limit));
  const qs = q.toString();
  return apiFetch<NotificationPage>(`/notifications${qs ? `?${qs}` : ""}`);
}

export function notificationCount() {
  return apiFetch<{ unread: number }>("/notifications/count");
}

export function markNotificationRead(id: string) {
  return apiFetch<void>(`/notifications/${encodeURIComponent(id)}/read`, { method: "POST" });
}

export function markAllNotificationsRead() {
  return apiFetch<{ marked: number }>("/notifications/read-all", { method: "POST" });
}

/** Query keys carry the user, so a shared reception terminal never shows the
 *  previous person's inbox to the next one, even for a moment. */
export const notificationKeys = {
  all: (userId: string) => ["notifications", userId] as const,
  count: (userId: string) => ["notifications", userId, "count"] as const,
  list: (userId: string) => ["notifications", userId, "list"] as const,
  unread: (userId: string) => ["notifications", userId, "unread"] as const,
};

/** "5 min ago", "3 h ago", "yesterday", "28 Sep". */
export function timeAgo(iso: string, now = Date.now()): string {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return "";
  const s = Math.max(0, Math.round((now - then) / 1000));
  if (s < 60) return "just now";
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} h ago`;
  if (h < 48) return "yesterday";
  return new Date(iso).toLocaleDateString(undefined, { day: "numeric", month: "short" });
}
