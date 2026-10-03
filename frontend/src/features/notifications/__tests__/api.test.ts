// The notifications API wrappers and the relative-time label. What must hold: each
// call reaches the path and method the server expects (status "all" sends nothing,
// ids and kinds are URL-encoded), query keys carry the user so one person's inbox is
// never served to the next person on a shared terminal, and the "5 min ago" label is
// worked out from the `now` it is given, not from the machine's clock.
import { afterEach, describe, expect, test, vi } from "vitest";

const http = vi.hoisted(() => ({ apiFetch: vi.fn() }));
vi.mock("@/lib/api-client", async (orig) => ({ ...(await orig<object>()), ...http }));

import {
  listNotifications,
  markAllNotificationsRead,
  markNotificationRead,
  notificationCount,
  notificationKeys,
  timeAgo,
} from "@/features/notifications/api";

/** A local wall-clock moment, the same on any machine in any time zone. */
const local = (y: number, mo: number, d: number, h: number, mi = 0) => new Date(y, mo - 1, d, h, mi);

describe("REG-FE-NOTIFAPI notifications API", () => {
  afterEach(() => http.apiFetch.mockReset());

  test("REG-FE-NOTIFAPI-001 list: no filters asks for the plain inbox", async () => {
    http.apiFetch.mockResolvedValue({ items: [], unread: 0 });
    await listNotifications();
    await listNotifications({ status: "all" });
    expect(http.apiFetch.mock.calls).toEqual([["/notifications"], ["/notifications"]]);
  });

  test("REG-FE-NOTIFAPI-002 list: status, kind, cursor and limit all reach the query string", async () => {
    http.apiFetch.mockResolvedValue({ items: [], unread: 0 });
    await listNotifications({ status: "read", kind: "missed_visit", before: "cur 1", limit: 20 });
    const url = new URL(http.apiFetch.mock.calls[0][0] as string, "http://x");
    expect(url.pathname).toBe("/notifications");
    expect(Object.fromEntries(url.searchParams)).toEqual({ status: "read", kind: "missed_visit", before: "cur 1", limit: "20" });
  });

  test("REG-FE-NOTIFAPI-003 list: the older `unread: true` means status=unread and wins over status", async () => {
    http.apiFetch.mockResolvedValue({ items: [], unread: 0 });
    await listNotifications({ unread: true, status: "read", limit: 5 });
    expect(http.apiFetch).toHaveBeenCalledWith("/notifications?status=unread&limit=5");
  });

  test("REG-FE-NOTIFAPI-004 count, mark one read (encoded id), mark all read (optionally one kind)", async () => {
    http.apiFetch.mockResolvedValue(undefined);
    await notificationCount();
    await markNotificationRead("ntf/1 2");
    await markAllNotificationsRead();
    await markAllNotificationsRead("missed visit");
    expect(http.apiFetch.mock.calls).toEqual([
      ["/notifications/count"],
      ["/notifications/ntf%2F1%202/read", { method: "POST" }],
      ["/notifications/read-all", { method: "POST" }],
      ["/notifications/read-all?kind=missed%20visit", { method: "POST" }],
    ]);
  });

  test("REG-FE-NOTIFAPI-005 every query key starts with the user, so two users never share a cache entry", () => {
    const keys = (u: string) => [
      notificationKeys.all(u), notificationKeys.count(u), notificationKeys.list(u), notificationKeys.list(u, "read"),
      notificationKeys.page(u, "unread", "missed_visit"), notificationKeys.unread(u),
    ];
    for (const k of keys("usr_a")) expect(k.slice(0, 2)).toEqual(["notifications", "usr_a"]);
    expect(notificationKeys.list("usr_a")).toEqual(["notifications", "usr_a", "list", "all"]);
    const a = keys("usr_a").map((k) => JSON.stringify(k));
    for (const k of keys("usr_b")) expect(a).not.toContain(JSON.stringify(k));
  });

  test("REG-FE-NOTIFAPI-006 timeAgo: seconds, minutes, hours, from the given now", () => {
    const now = local(2026, 10, 3, 13, 0).getTime();
    const ago = (ms: number) => timeAgo(new Date(now - ms).toISOString(), now);
    expect(ago(0)).toBe("just now");
    expect(ago(59_000)).toBe("just now");
    expect(ago(-5 * 60_000)).toBe("just now"); // a server clock slightly ahead never reads "in the future"
    expect(ago(5 * 60_000)).toBe("5 min ago");
    expect(ago(59 * 60_000)).toBe("59 min ago");
    expect(ago(3 * 3_600_000)).toBe("3 h ago");
    expect(ago(30 * 3_600_000)).toBe("yesterday");
  });

  test("REG-FE-NOTIFAPI-007 timeAgo: older than two days is a short date; garbage is blank", () => {
    const now = local(2026, 10, 3, 13, 0).getTime();
    const iso = local(2026, 9, 28, 12, 0).toISOString();
    const expected = local(2026, 9, 28, 12, 0).toLocaleDateString(undefined, { day: "numeric", month: "short" });
    expect(timeAgo(iso, now)).toBe(expected);
    expect(timeAgo(iso, now)).toMatch(/28/);
    expect(timeAgo("not a date", now)).toBe("");
  });

  test("REG-FE-NOTIFAPI-008 timeAgo defaults to the current time", () => {
    expect(timeAgo(new Date(Date.now() - 10 * 60_000).toISOString())).toBe("10 min ago");
  });

  // "yesterday" is decided by elapsed hours, not by the calendar. Late in the day a
  // notice from this morning reads "yesterday", while the notifications page puts the
  // same row under the "Today" heading (it groups by the viewer's calendar day).
  test.fails("REG-FE-NOTIFAPI-009 KNOWN BUG NEW-NOTIF-2 a notice from earlier today never reads 'yesterday'", () => {
    const now = local(2026, 10, 3, 23, 50).getTime();
    const thisMorning = local(2026, 10, 3, 0, 10).toISOString(); // 23 h 40 min earlier, same day
    expect(timeAgo(thisMorning, now)).not.toBe("yesterday");
  });

  test.fails("REG-FE-NOTIFAPI-010 KNOWN BUG NEW-NOTIF-2 a notice from two calendar days ago never reads 'yesterday'", () => {
    const now = local(2026, 10, 3, 0, 20).getTime();
    const twoDaysAgo = local(2026, 10, 1, 23, 30).toISOString(); // 24 h 50 min earlier, but 1 October
    expect(timeAgo(twoDaysAgo, now)).not.toBe("yesterday");
  });
});
