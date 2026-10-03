// The notifications page. What must hold: everything is listed newest first under
// the viewer's own calendar day ("Today", "Yesterday", then the date); the filters
// live in the URL and reach the server; "Mark ... as read" marks only the kind on
// screen; "Show more" continues from the server's cursor; each empty state says what
// is empty and offers the way back; a failed load reads as a failure, never as "no
// notifications"; and what is listed counts as seen for the sign-in pop-up.
// Fixture times are built from "now" in local time, so any clock or zone works.
import { configure, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

const auth = vi.hoisted(() => ({ user: { id: "u1", full_name: "Hanna Desta" } as { id: string; full_name: string } | null }));
vi.mock("@/app/auth-context", () => ({
  useAuth: () => ({ user: auth.user, can: () => true, flagOn: (f: string) => f === "dental" }),
}));
const api = vi.hoisted(() => ({
  listNotifications: vi.fn(), notificationCount: vi.fn(), markNotificationRead: vi.fn(), markAllNotificationsRead: vi.fn(),
}));
vi.mock("@/features/notifications/api", async (orig) => ({ ...(await orig<object>()), ...api }));

import { NotificationsPage } from "@/features/notifications/pages/NotificationsPage";
import type { AppNotification, NotificationPage } from "@/features/notifications/api";
import { seenUntil } from "@/features/notifications/seen";
import { currentLocation, renderUI } from "@/test/render";

/** Noon, `daysAgo` local calendar days before today. */
const noon = (daysAgo: number) => {
  const now = new Date();
  return new Date(now.getFullYear(), now.getMonth(), now.getDate() - daysAgo, 12);
};
const N = (id: string, at: Date, extra: Partial<AppNotification> = {}): AppNotification => ({
  id, kind: "missed_visit", title: "Missed visit", body: "A visit was missed.",
  data: { patient: `Patient ${id}`, card: `C-${id}`, course: "Root canal", visit: 1 },
  href: `/patients/pat_${id}`, created_at: at.toISOString(), read_at: null, ...extra,
});
const page = (items: AppNotification[], next: string | null = null): NotificationPage =>
  ({ items, unread: items.filter((n) => !n.read_at).length, next });
const counts = (unread: number, by_kind: Record<string, number> = {}) => ({ unread, by_kind });

const view = (route = "/notifications") => renderUI(<NotificationsPage />, { route });
const readTab = (name: RegExp | string) => within(screen.getByRole("tablist", { name: "Read state" })).getByRole("tab", { name });
const kindTab = (name: RegExp | string) => within(screen.getByRole("tablist", { name: "Category" })).getByRole("tab", { name });

// Polls and exit animations run on real timers; a loaded machine needs longer than 1 s.
configure({ asyncUtilTimeout: 5000 });

describe("REG-FE-NOTIFPAGE notifications page", () => {
  beforeEach(() => {
    localStorage.clear();
    auth.user = { id: "u1", full_name: "Hanna Desta" };
    api.notificationCount.mockResolvedValue(counts(0));
    api.listNotifications.mockResolvedValue(page([]));
    api.markNotificationRead.mockResolvedValue(undefined);
    api.markAllNotificationsRead.mockResolvedValue({ marked: 1 });
  });
  afterEach(() => localStorage.clear());

  test("REG-FE-NOTIFPAGE-001 grouped by the viewer's day, newest first, with the unread total", async () => {
    const lastYear = noon(400);
    const items = [
      N("t", noon(0)), N("y", noon(1)), N("w", noon(5), { read_at: noon(4).toISOString() }), N("o", lastYear, { read_at: lastYear.toISOString() }),
    ];
    api.notificationCount.mockResolvedValue(counts(2, { missed_visit: 2 }));
    api.listNotifications.mockResolvedValue(page(items));
    view();
    const regions = await screen.findAllByRole("region");
    const fmt = (d: Date, year: boolean) => d.toLocaleDateString(undefined, { weekday: "long", day: "numeric", month: "long", year: year ? "numeric" : undefined });
    const fiveAgo = noon(5);
    expect(regions.map((r) => r.getAttribute("aria-label"))).toEqual([
      "Today", "Yesterday", fmt(fiveAgo, fiveAgo.getFullYear() !== new Date().getFullYear()), fmt(lastYear, true),
    ]);
    expect(within(regions[0]).getByRole("button", { name: /^Patient t\./ })).toBeInTheDocument();
    expect(within(regions[2]).getByRole("button", { name: "Patient w. Missed visit 1 of Root canal." })).toBeInTheDocument();
    expect(screen.getByText(/^2 unread\./)).toBeInTheDocument();
    expect(readTab(/Unread/)).toHaveTextContent("Unread2");
    expect(kindTab(/Missed visits/)).toHaveTextContent("Missed visits2");
    expect(screen.getByText("That's all 4.")).toBeInTheDocument();
    expect(api.listNotifications).toHaveBeenCalledWith({ status: "all", kind: undefined, before: null, limit: 20 });
  });

  test("REG-FE-NOTIFPAGE-002 what is listed counts as seen, so the sign-in pop-up does not repeat it", async () => {
    const items = [N("t", noon(0)), N("y", noon(1))];
    api.listNotifications.mockResolvedValue(page(items));
    view();
    await screen.findByRole("button", { name: /^Patient t\./ });
    await waitFor(() => expect(seenUntil("u1")).toBe(noon(0).getTime()));
  });

  test("REG-FE-NOTIFPAGE-003 Show more continues from the server's cursor", async () => {
    api.listNotifications.mockImplementation(async ({ before }: { before: string | null }) =>
      before ? page([N("b", noon(3))]) : page([N("a", noon(2))], "cur-1"));
    const { user } = view();
    await user.click(await screen.findByRole("button", { name: "Show more" }));
    expect(await screen.findByRole("button", { name: /^Patient b\./ })).toBeInTheDocument();
    expect(api.listNotifications).toHaveBeenLastCalledWith({ status: "all", kind: undefined, before: "cur-1", limit: 20 });
    expect(screen.getByText("That's all 2.")).toBeInTheDocument();
  });

  test("REG-FE-NOTIFPAGE-004 one notification: 'That's the only one.'", async () => {
    api.listNotifications.mockResolvedValue(page([N("a", noon(0))]));
    view();
    expect(await screen.findByText("That's the only one.")).toBeInTheDocument();
  });

  test("REG-FE-NOTIFPAGE-005 filters live in the URL and reach the server; All clears them", async () => {
    api.notificationCount.mockResolvedValue(counts(3, { missed_visit: 2, patient_waiting: 1 }));
    api.listNotifications.mockResolvedValue(page([N("a", noon(0))]));
    const { user } = view();
    await screen.findByRole("button", { name: /^Patient a\./ });
    await user.click(readTab(/Unread/));
    expect(currentLocation()).toBe("/notifications?status=unread");
    await user.click(kindTab(/Missed visits/));
    expect(currentLocation()).toBe("/notifications?status=unread&kind=missed_visit");
    await waitFor(() => expect(api.listNotifications).toHaveBeenLastCalledWith({ status: "unread", kind: "missed_visit", before: null, limit: 20 }));
    expect(kindTab(/Missed visits/)).toHaveAttribute("aria-selected", "true");
    await user.click(readTab("All"));
    await user.click(kindTab("All types"));
    expect(currentLocation()).toBe("/notifications");
  });

  test("REG-FE-NOTIFPAGE-006 with a kind chosen, the button marks only that kind", async () => {
    api.notificationCount.mockResolvedValue(counts(3, { missed_visit: 2, patient_waiting: 1 }));
    api.listNotifications.mockResolvedValue(page([N("a", noon(0))]));
    const { user } = view("/notifications?kind=missed_visit");
    await user.click(await screen.findByRole("button", { name: "Mark missed visits as read" }));
    expect(api.markAllNotificationsRead).toHaveBeenCalledWith("missed_visit");
  });

  test("REG-FE-NOTIFPAGE-007 with no kind chosen, Mark all as read marks everything", async () => {
    api.notificationCount.mockResolvedValue(counts(1, { missed_visit: 1 }));
    api.listNotifications.mockResolvedValue(page([N("a", noon(0))]));
    const { user } = view();
    await user.click(await screen.findByRole("button", { name: "Mark all as read" }));
    expect(api.markAllNotificationsRead).toHaveBeenCalledTimes(1);
    expect(api.markAllNotificationsRead.mock.calls[0][0]).toBeUndefined();
  });

  test("REG-FE-NOTIFPAGE-008 a kind with nothing unread has no mark button, even if others do", async () => {
    api.notificationCount.mockResolvedValue(counts(1, { patient_waiting: 1 }));
    api.listNotifications.mockResolvedValue(page([N("a", noon(0), { read_at: noon(0).toISOString() })]));
    view("/notifications?kind=missed_visit");
    await screen.findByRole("button", { name: /^Patient a\./ });
    expect(screen.queryByRole("button", { name: /^Mark/ })).not.toBeInTheDocument();
  });

  test("REG-FE-NOTIFPAGE-009 opening a row marks it read and goes to the patient", async () => {
    api.listNotifications.mockResolvedValue(page([N("a", noon(0))]));
    const { user } = view();
    await user.click(await screen.findByRole("button", { name: /^Patient a\./ }));
    expect(api.markNotificationRead).toHaveBeenCalledWith("a");
    expect(currentLocation()).toBe("/patients/pat_a");
  });

  test("REG-FE-NOTIFPAGE-010 nothing at all: 'No notifications yet', all caught up, no way-back button", async () => {
    view();
    expect(await screen.findByText("No notifications yet")).toBeInTheDocument();
    expect(screen.getByText(/^You're all caught up\./)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Show all notifications" })).not.toBeInTheDocument();
  });

  test("REG-FE-NOTIFPAGE-011 empty filtered views say what is empty, and 'Show all' clears the filters", async () => {
    const { user } = view("/notifications?status=unread&kind=missed_visit");
    expect(await screen.findByText("No unread missed visits")).toBeInTheDocument();
    expect(screen.getByText("New ones appear here and in the bell.")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Show all notifications" }));
    expect(currentLocation()).toBe("/notifications");
    expect(await screen.findByText("No notifications yet")).toBeInTheDocument();
  });

  test.each([
    ["/notifications?status=unread", "You're all caught up"],
    ["/notifications?status=read", "Nothing read yet"],
    ["/notifications?kind=patient_waiting", "No patients waiting yet"],
  ])("REG-FE-NOTIFPAGE-012 empty state for %s", async (route, text) => {
    view(route);
    expect(await screen.findByText(text)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Show all notifications" })).toBeInTheDocument();
  });

  test("REG-FE-NOTIFPAGE-013 unknown filters in the URL fall back to everything", async () => {
    view("/notifications?status=bogus&kind=nonsense");
    expect(await screen.findByText("No notifications yet")).toBeInTheDocument();
    expect(api.listNotifications).toHaveBeenCalledWith({ status: "all", kind: undefined, before: null, limit: 20 });
    expect(readTab("All")).toHaveAttribute("aria-selected", "true");
  });

  test("REG-FE-NOTIFPAGE-014 a failed load reads as a failure, not as 'No notifications yet', and Retry refetches", async () => {
    api.listNotifications.mockRejectedValue(new Error("offline"));
    const { user } = view();
    expect(await screen.findByRole("alert")).toHaveTextContent("Could not load notifications");
    expect(screen.queryByText("No notifications yet")).not.toBeInTheDocument();
    api.listNotifications.mockResolvedValue(page([N("a", noon(0))]));
    await user.click(screen.getByRole("button", { name: /Retry/ }));
    expect(await screen.findByRole("button", { name: /^Patient a\./ })).toBeInTheDocument();
  });

  test("REG-FE-NOTIFPAGE-015 no one signed in: nothing is fetched", async () => {
    auth.user = null;
    view();
    await new Promise((r) => setTimeout(r, 30));
    expect(api.listNotifications).not.toHaveBeenCalled();
    expect(api.notificationCount).not.toHaveBeenCalled();
  });

  // The heading's count comes from /notifications/count. When that call fails the
  // page treats the missing number as zero and announces "You're all caught up."
  // above a list of unread notices (UX-1: a failed load shown as an all-clear).
  test.fails("REG-FE-NOTIFPAGE-016 KNOWN BUG NEW-NOTIF-1 a failed unread count never reads as 'You're all caught up'", async () => {
    api.notificationCount.mockRejectedValue(new Error("offline"));
    api.listNotifications.mockResolvedValue(page([N("a", noon(0)), N("b", noon(0))]));
    view();
    await screen.findByRole("button", { name: /^Patient a\..*Unread\./ });
    await waitFor(() => expect(api.notificationCount).toHaveBeenCalled());
    await new Promise((r) => setTimeout(r, 30));
    expect(screen.queryByText(/You're all caught up/)).not.toBeInTheDocument();
  });
});
