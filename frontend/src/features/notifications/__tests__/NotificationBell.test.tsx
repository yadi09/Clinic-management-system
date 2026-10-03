// The bell in the top bar. What must hold: the badge shows the polled unread count
// (capped at "9+") and follows the poll again once the list is closed; opening it
// lists Unread first, and looking at the list counts as having seen it (so the
// sign-in pop-up does not repeat those); opening a row marks it read and goes to the
// patient even when the mark fails; "Mark all as read" reaches the server; a failed
// load reads as a failure, never as "You're all caught up"; sound can be switched
// per user by the people who get live alerts.
import { act, configure, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

const auth = vi.hoisted(() => ({
  user: { id: "u1", full_name: "Hanna Desta" } as { id: string; full_name: string } | null,
  perms: new Set<string>(),
}));
vi.mock("@/app/auth-context", () => ({
  useAuth: () => ({ user: auth.user, can: (p: string) => auth.perms.has(p), flagOn: (f: string) => f === "dental" }),
}));
const api = vi.hoisted(() => ({
  listNotifications: vi.fn(), notificationCount: vi.fn(), markNotificationRead: vi.fn(), markAllNotificationsRead: vi.fn(),
}));
vi.mock("@/features/notifications/api", async (orig) => ({ ...(await orig<object>()), ...api }));
const snd = vi.hoisted(() => ({ announce: vi.fn(), canSpeak: vi.fn(() => true) }));
vi.mock("@/features/notifications/sound", async (orig) => ({ ...(await orig<object>()), ...snd }));

import { NotificationBell } from "@/features/notifications/NotificationBell";
import { OPEN_NOTIFICATIONS } from "@/features/notifications/LiveAlerts";
import type { AppNotification, NotificationPage } from "@/features/notifications/api";
import { seenUntil } from "@/features/notifications/seen";
import { soundOn } from "@/features/notifications/sound";
import { Toaster } from "@/components/ui/sonner";
import { currentLocation, renderUI } from "@/test/render";

/** created `minAgo` minutes before now, whatever "now" is in this run. */
const N = (id: string, minAgo: number, extra: Partial<AppNotification> = {}): AppNotification => ({
  id, kind: "missed_visit", title: "Missed visit", body: "A visit was missed.",
  data: { patient: `Patient ${id}`, card: `C-${id}`, course: "Root canal", visit: 2 },
  href: `/patients/pat_${id}`, created_at: new Date(Date.now() - minAgo * 60_000).toISOString(), read_at: null, ...extra,
});
const page = (items: AppNotification[], unread = items.filter((n) => !n.read_at).length, next: string | null = null): NotificationPage =>
  ({ items, unread, next });

function bell() {
  return renderUI(<><NotificationBell /><Toaster /></>, { route: "/dashboard" });
}
const bellButton = () => screen.getByRole("button", { name: /^Notifications/ });
const panel = () => screen.getByRole("dialog");

/** Exit animations run on real timers; a loaded machine needs longer than 1 s. */
const SLOW = { timeout: 5000 };
configure({ asyncUtilTimeout: SLOW.timeout });

describe("REG-FE-NOTIF bell", () => {
  beforeEach(() => {
    localStorage.clear();
    auth.user = { id: "u1", full_name: "Hanna Desta" };
    auth.perms = new Set();
    snd.canSpeak.mockReturnValue(true);
    api.notificationCount.mockResolvedValue({ unread: 0, by_kind: {} });
    api.listNotifications.mockResolvedValue(page([]));
    api.markNotificationRead.mockResolvedValue(undefined);
    api.markAllNotificationsRead.mockResolvedValue({ marked: 0 });
  });
  afterEach(() => localStorage.clear());

  test("REG-FE-NOTIF-001 the badge shows the polled unread count; nothing unread shows no number", async () => {
    api.notificationCount.mockResolvedValue({ unread: 3, by_kind: { missed_visit: 3 } });
    bell();
    expect(await screen.findByRole("button", { name: "Notifications, 3 unread" }, SLOW)).toHaveTextContent("3");
    expect(api.listNotifications).not.toHaveBeenCalled(); // the list waits until the bell is opened
  });

  test("REG-FE-NOTIF-002 more than nine unread reads '9+'", async () => {
    api.notificationCount.mockResolvedValue({ unread: 12, by_kind: {} });
    bell();
    expect(await screen.findByRole("button", { name: "Notifications, 12 unread" })).toHaveTextContent("9+");
  });

  test("REG-FE-NOTIF-003 no one signed in: nothing is fetched", async () => {
    auth.user = null;
    bell();
    expect(bellButton()).toHaveAccessibleName("Notifications");
    await new Promise((r) => setTimeout(r, 20));
    expect(api.notificationCount).not.toHaveBeenCalled();
  });

  test("REG-FE-NOTIF-004 opening lists the latest unread, and marks them seen for the sign-in pop-up", async () => {
    const items = [N("a", 5), N("b", 90)];
    api.notificationCount.mockResolvedValue({ unread: 2, by_kind: {} });
    api.listNotifications.mockResolvedValue(page(items));
    const { user } = bell();
    await user.click(await screen.findByRole("button", { name: "Notifications, 2 unread" }));
    expect(await within(panel()).findByRole("button", { name: "Patient a. Missed visit 2 of Root canal. Unread." })).toBeInTheDocument();
    expect(within(panel()).getByText("Card C-b")).toBeInTheDocument();
    expect(api.listNotifications).toHaveBeenCalledWith({ status: "unread", limit: 10 });
    expect(within(panel()).getByRole("tab", { name: /Unread/ })).toHaveAttribute("aria-selected", "true");
    await waitFor(() => expect(seenUntil("u1")).toBe(Date.parse(items[0].created_at)));
    expect(within(panel()).getByRole("button", { name: "Open notifications page" })).toBeInTheDocument();
  });

  test("REG-FE-NOTIF-005 opening a row marks it read, closes the list and goes to the patient", async () => {
    api.notificationCount.mockResolvedValue({ unread: 1, by_kind: {} });
    api.listNotifications.mockResolvedValue(page([N("a", 5)]));
    const { user } = bell();
    await user.click(await screen.findByRole("button", { name: "Notifications, 1 unread" }));
    await user.click(await screen.findByRole("button", { name: /^Patient a\./ }));
    expect(api.markNotificationRead).toHaveBeenCalledWith("a");
    expect(currentLocation()).toBe("/patients/pat_a");
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument(), SLOW);
  });

  test("REG-FE-NOTIF-006 a read row is not marked again; a row without a link stays put", async () => {
    api.listNotifications.mockResolvedValue(page([N("r", 60, { read_at: "2026-01-01T00:00:00Z", href: "" })], 0));
    const { user } = bell();
    await user.click(bellButton());
    await user.click(within(panel()).getByRole("tab", { name: "Earlier" }));
    await user.click(await screen.findByRole("button", { name: "Patient r. Missed visit 2 of Root canal." }));
    expect(api.markNotificationRead).not.toHaveBeenCalled();
    expect(currentLocation()).toBe("/dashboard");
  });

  test("REG-FE-NOTIF-007 a failed mark still opens the patient, and says so quietly", async () => {
    api.notificationCount.mockResolvedValue({ unread: 1, by_kind: {} });
    api.listNotifications.mockResolvedValue(page([N("a", 5)]));
    api.markNotificationRead.mockRejectedValue(new Error("500"));
    const { user } = bell();
    await user.click(await screen.findByRole("button", { name: "Notifications, 1 unread" }));
    await user.click(await screen.findByRole("button", { name: /^Patient a\./ }));
    expect(currentLocation()).toBe("/patients/pat_a");
    expect(await screen.findByText("Could not mark that notification as read")).toBeInTheDocument();
  });

  test("REG-FE-NOTIF-008 after a row is opened, the badge follows the poll, not the closed list's old total", async () => {
    api.notificationCount.mockResolvedValue({ unread: 2, by_kind: {} });
    api.listNotifications.mockResolvedValue(page([N("a", 5), N("b", 9)]));
    const { user } = bell();
    await user.click(await screen.findByRole("button", { name: "Notifications, 2 unread" }));
    api.notificationCount.mockResolvedValue({ unread: 1, by_kind: {} });
    await user.click(await screen.findByRole("button", { name: /^Patient a\./ }));
    expect(await screen.findByRole("button", { name: "Notifications, 1 unread" })).toBeInTheDocument();
  });

  test("REG-FE-NOTIF-009 Mark all as read reaches the server and the badge refreshes", async () => {
    api.notificationCount.mockResolvedValue({ unread: 2, by_kind: {} });
    api.listNotifications.mockResolvedValue(page([N("a", 5), N("b", 9)]));
    const { user } = bell();
    await user.click(await screen.findByRole("button", { name: "Notifications, 2 unread" }));
    api.notificationCount.mockResolvedValue({ unread: 0, by_kind: {} });
    api.listNotifications.mockResolvedValue(page([]));
    await user.click(await within(panel()).findByRole("button", { name: "Mark all as read" }));
    expect(api.markAllNotificationsRead).toHaveBeenCalledTimes(1);
    expect(api.markAllNotificationsRead.mock.calls[0][0]).toBeUndefined();
    expect(await within(panel()).findByText("You're all caught up")).toBeInTheDocument();
    expect(within(panel()).queryByRole("button", { name: "Mark all as read" })).not.toBeInTheDocument();
  });

  test("REG-FE-NOTIF-010 a failed Mark all says so and keeps the list", async () => {
    api.notificationCount.mockResolvedValue({ unread: 1, by_kind: {} });
    api.listNotifications.mockResolvedValue(page([N("a", 5)]));
    api.markAllNotificationsRead.mockRejectedValue(new Error("500"));
    const { user } = bell();
    await user.click(await screen.findByRole("button", { name: "Notifications, 1 unread" }));
    await user.click(await within(panel()).findByRole("button", { name: "Mark all as read" }));
    expect(await screen.findByText("Could not mark notifications as read. Please try again.")).toBeInTheDocument();
    expect(within(panel()).getByRole("button", { name: /^Patient a\./ })).toBeInTheDocument();
  });

  test("REG-FE-NOTIF-011 nothing unread: all caught up, and 'See earlier' switches to the read list", async () => {
    const { user } = bell();
    await user.click(bellButton());
    expect(await within(panel()).findByText("You're all caught up")).toBeInTheDocument();
    await user.click(within(panel()).getByRole("button", { name: "See earlier" }));
    expect(await within(panel()).findByText("Nothing earlier yet")).toBeInTheDocument();
    expect(api.listNotifications).toHaveBeenLastCalledWith({ status: "read", limit: 10 });
    expect(within(panel()).getByRole("tab", { name: "Earlier" })).toHaveAttribute("aria-selected", "true");
  });

  test("REG-FE-NOTIF-012 the bell always reopens on Unread", async () => {
    const { user } = bell();
    await user.click(bellButton());
    await user.click(await within(panel()).findByRole("tab", { name: "Earlier" }));
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument(), SLOW);
    await user.click(bellButton());
    expect(within(panel()).getByRole("tab", { name: /Unread/ })).toHaveAttribute("aria-selected", "true");
  });

  test("REG-FE-NOTIF-013 a failed load reads as a failure, never as all caught up, and Try again refetches", async () => {
    api.listNotifications.mockRejectedValue(new Error("offline"));
    const { user } = bell();
    await user.click(bellButton());
    expect(await within(panel()).findByText("Notifications didn't load")).toBeInTheDocument();
    expect(within(panel()).queryByText("You're all caught up")).not.toBeInTheDocument();
    api.listNotifications.mockResolvedValue(page([N("a", 5)]));
    await user.click(within(panel()).getByRole("button", { name: "Try again" }));
    expect(await within(panel()).findByRole("button", { name: /^Patient a\./ })).toBeInTheDocument();
  });

  test("REG-FE-NOTIF-014 the footer goes to the notifications page on the tab being viewed", async () => {
    api.listNotifications.mockResolvedValue(page([N("a", 5)], 1, "cursor-1"));
    const { user } = bell();
    await user.click(bellButton());
    await user.click(await within(panel()).findByRole("button", { name: "See all notifications" }));
    expect(currentLocation()).toBe("/notifications?status=unread");
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument(), SLOW);
  });

  test("REG-FE-NOTIF-015 people without live alerts get no sound switch", async () => {
    const { user } = bell();
    await user.click(bellButton());
    await within(panel()).findByText("You're all caught up");
    expect(within(panel()).queryByRole("button", { name: /^Sound/ })).not.toBeInTheDocument();
  });

  test("REG-FE-NOTIF-016 no speech on the device: no sound switch even for a dentist", async () => {
    auth.perms = new Set(["dental.manage"]);
    snd.canSpeak.mockReturnValue(false);
    const { user } = bell();
    await user.click(bellButton());
    await within(panel()).findByText("You're all caught up");
    expect(within(panel()).queryByRole("button", { name: /^Sound/ })).not.toBeInTheDocument();
  });

  test("REG-FE-NOTIF-017 a dentist switches sound off and on; it is remembered per user and plays once when on", async () => {
    auth.perms = new Set(["dental.manage"]);
    api.notificationCount.mockResolvedValue({ unread: 1, by_kind: {} });
    api.listNotifications.mockResolvedValue(page([N("a", 5, { kind: "patient_waiting", data: { patient: "Selam" } })]));
    const { user } = bell();
    await user.click(await screen.findByRole("button", { name: "Notifications, 1 unread" }));
    const on = await within(panel()).findByRole("button", { name: "Sound on. Turn off" });
    expect(on).toHaveAttribute("aria-pressed", "true");
    expect(within(panel()).getByRole("button", { name: "Mark all as read" })).toBeInTheDocument();
    await user.click(on);
    expect(within(panel()).getByRole("button", { name: "Sound off. Turn on" })).toHaveAttribute("aria-pressed", "false");
    expect(soundOn("u1")).toBe(false);
    expect(soundOn("u2")).toBe(true);
    expect(snd.announce).not.toHaveBeenCalled();
    await user.click(within(panel()).getByRole("button", { name: "Sound off. Turn on" }));
    expect(soundOn("u1")).toBe(true);
    expect(snd.announce).toHaveBeenCalledWith("Sound is on. You will hear when a patient is waiting.");
  });

  test("REG-FE-NOTIF-018 the sound switch starts from what this user chose before", async () => {
    auth.perms = new Set(["encounter.manage"]);
    localStorage.setItem("clinicos.notifications.sound.u1", "off");
    const { user } = bell();
    await user.click(bellButton());
    expect(await within(panel()).findByRole("button", { name: "Sound off. Turn on" })).toBeInTheDocument();
  });

  test("REG-FE-NOTIF-019 'View all' from a live pop-up opens the bell's list", async () => {
    bell();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    act(() => { window.dispatchEvent(new CustomEvent(OPEN_NOTIFICATIONS)); });
    expect(await screen.findByRole("dialog")).toBeInTheDocument();
    expect(api.listNotifications).toHaveBeenCalled();
  });

  test("REG-FE-NOTIF-020 a rise in the polled count updates the badge and pulses once", async () => {
    api.notificationCount.mockResolvedValue({ unread: 1, by_kind: {} });
    const { qc } = bell();
    await screen.findByRole("button", { name: "Notifications, 1 unread" });
    const ping = () => [...document.querySelectorAll("span")].find((el) => el.className.includes("animate-[ping")) ?? null;
    expect(ping()).toBeNull(); // not on first load
    api.notificationCount.mockResolvedValue({ unread: 3, by_kind: {} });
    await act(() => qc.refetchQueries({ queryKey: ["notifications", "u1", "count"] }));
    expect(await screen.findByRole("button", { name: "Notifications, 3 unread" })).toBeInTheDocument();
    expect(ping()).not.toBeNull();
    // ...and the pulse ends by itself (2.2 s), leaving the number.
    await waitFor(() => expect(ping()).toBeNull(), { timeout: 4000 });
    expect(bellButton()).toHaveTextContent("3");
  });
});
