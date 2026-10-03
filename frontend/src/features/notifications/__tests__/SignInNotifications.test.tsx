// The sign-in pop-up (for a dental front desk: "these visits were missed"). What must
// hold: it appears only when something unread is newer than what this user has seen;
// it lists up to five and says how many more wait in the bell; closing it in any way
// (Got it, Escape, opening a patient, Mark all as read) counts as seen, so it does
// not come back on the next sign-in or reload; it is decided once per sign-in, so a
// newer notice arriving while they work does not pop it up again; and while it is
// open the live alerts know not to stack a second pop-up on top.
import { act, configure, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

const auth = vi.hoisted(() => ({ user: { id: "u1", full_name: "Hanna Desta" } as { id: string; full_name: string } | null }));
vi.mock("@/app/auth-context", () => ({
  useAuth: () => ({ user: auth.user, can: () => false, flagOn: (f: string) => f === "dental" }),
}));
const api = vi.hoisted(() => ({ listNotifications: vi.fn(), markNotificationRead: vi.fn(), markAllNotificationsRead: vi.fn() }));
vi.mock("@/features/notifications/api", async (orig) => ({ ...(await orig<object>()), ...api }));

import { SignInNotifications } from "@/features/notifications/SignInNotifications";
import type { AppNotification, NotificationPage } from "@/features/notifications/api";
import { onscreen } from "@/features/notifications/onscreen";
import { markSeen, seenUntil } from "@/features/notifications/seen";
import { currentLocation, renderUI } from "@/test/render";

const N = (id: string, minAgo: number, extra: Partial<AppNotification> = {}): AppNotification => ({
  id, kind: "missed_visit", title: "Missed visit", body: "A visit was missed.",
  data: { patient: `Patient ${id}`, card: `C-${id}`, course: "Root canal", visit: 2 },
  href: `/patients/pat_${id}`, created_at: new Date(Date.now() - minAgo * 60_000).toISOString(), read_at: null, ...extra,
});
const page = (items: AppNotification[], unread = items.length): NotificationPage => ({ items, unread, next: null });

const popup = () => screen.findByRole("dialog");
/** Lets the unread query settle, so "no pop-up" is checked after the decision. */
const settled = () => waitFor(() => expect(api.listNotifications).toHaveBeenCalled()).then(() => new Promise((r) => setTimeout(r, 30)));

/** Exit animations run on real timers; a loaded machine needs longer than 1 s. */
const SLOW = { timeout: 5000 };
configure({ asyncUtilTimeout: SLOW.timeout });

describe("REG-FE-NOTIFSIGNIN sign-in pop-up", () => {
  beforeEach(() => {
    localStorage.clear();
    auth.user = { id: "u1", full_name: "Hanna Desta" };
    api.markNotificationRead.mockResolvedValue(undefined);
    api.markAllNotificationsRead.mockResolvedValue({ marked: 2 });
  });
  afterEach(() => localStorage.clear());

  test("REG-FE-NOTIFSIGNIN-001 unseen missed visits pop up, listed by patient, asking for the newest five", async () => {
    const items = [N("a", 30), N("b", 600)];
    api.listNotifications.mockResolvedValue(page(items));
    renderUI(<SignInNotifications />);
    const d = await popup();
    expect(within(d).getByRole("heading", { name: "2 visits were missed" })).toBeInTheDocument();
    expect(within(d).getByText("These visits passed without being marked done. Open a patient to rebook.")).toBeInTheDocument();
    expect(within(d).getByRole("button", { name: "Patient a. Missed visit 2 of Root canal. Unread." })).toBeInTheDocument();
    expect(within(d).getByRole("button", { name: "Patient b. Missed visit 2 of Root canal. Unread." })).toBeInTheDocument();
    expect(within(d).queryByText(/more (is|are) in the bell/)).not.toBeInTheDocument();
    expect(api.listNotifications).toHaveBeenCalledWith({ unread: true, limit: 5 });
    expect(onscreen.signInOpen).toBe(true);
  });

  test("REG-FE-NOTIFSIGNIN-002 'Got it' closes it, counts as seen, and the next sign-in does not show it again", async () => {
    const items = [N("a", 30), N("b", 600)];
    api.listNotifications.mockResolvedValue(page(items));
    const first = renderUI(<SignInNotifications />);
    const d = await popup();
    await first.user.click(within(d).getByRole("button", { name: "Got it" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument(), SLOW);
    expect(seenUntil("u1")).toBe(Date.parse(items[0].created_at));
    expect(onscreen.signInOpen).toBe(false);
    first.unmount();

    // Signing in again (a fresh mount), the same unread notices: no pop-up.
    api.listNotifications.mockClear();
    renderUI(<SignInNotifications />);
    await settled();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  test("REG-FE-NOTIFSIGNIN-003 nothing unread: no pop-up", async () => {
    api.listNotifications.mockResolvedValue(page([]));
    renderUI(<SignInNotifications />);
    await settled();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(onscreen.signInOpen).toBe(false);
  });

  test("REG-FE-NOTIFSIGNIN-004 seen already in the bell: no pop-up; something newer since: pop-up", async () => {
    const old = N("a", 600);
    markSeen("u1", [old]);
    api.listNotifications.mockResolvedValue(page([old]));
    const r = renderUI(<SignInNotifications />);
    await settled();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    r.unmount();

    api.listNotifications.mockResolvedValue(page([N("new", 5), old]));
    renderUI(<SignInNotifications />);
    expect(await popup()).toBeInTheDocument();
  });

  test("REG-FE-NOTIFSIGNIN-005 another user's seen point does not hide this user's pop-up", async () => {
    const items = [N("a", 30)];
    markSeen("u_other", items);
    api.listNotifications.mockResolvedValue(page(items));
    renderUI(<SignInNotifications />);
    expect(await popup()).toBeInTheDocument();
  });

  test("REG-FE-NOTIFSIGNIN-006 more unread than shown: the rest are pointed to the bell", async () => {
    api.listNotifications.mockResolvedValue(page([N("a", 1), N("b", 2), N("c", 3), N("d", 4), N("e", 5)], 8));
    renderUI(<SignInNotifications />);
    const d = await popup();
    expect(within(d).getByRole("heading", { name: "You have 8 unread notifications" })).toBeInTheDocument();
    expect(within(d).getByText("3 more are in the bell at the top of the page.")).toBeInTheDocument();
  });

  test("REG-FE-NOTIFSIGNIN-007 exactly one more is said in the singular", async () => {
    api.listNotifications.mockResolvedValue(page([N("a", 1)], 2));
    renderUI(<SignInNotifications />);
    expect(within(await popup()).getByText("1 more is in the bell at the top of the page.")).toBeInTheDocument();
  });

  test("REG-FE-NOTIFSIGNIN-008 a patient waiting is named; mixed kinds get a plain count", async () => {
    api.listNotifications.mockResolvedValue(page([N("w", 1, { kind: "patient_waiting", data: { patient: "Selam Bekele" } })]));
    const r = renderUI(<SignInNotifications />);
    expect(within(await popup()).getByRole("heading", { name: "Selam Bekele is waiting for you" })).toBeInTheDocument();
    r.unmount();
    localStorage.clear();
    api.listNotifications.mockResolvedValue(page([N("w", 1, { kind: "patient_waiting", data: { patient: "Selam" } }), N("m", 2)]));
    renderUI(<SignInNotifications />);
    expect(within(await popup()).getByRole("heading", { name: "You have 2 unread notifications" })).toBeInTheDocument();
  });

  test("REG-FE-NOTIFSIGNIN-009 opening a patient marks that one read, closes, and goes there", async () => {
    const items = [N("a", 30), N("b", 60)];
    api.listNotifications.mockResolvedValue(page(items));
    const { user } = renderUI(<SignInNotifications />, { route: "/dashboard" });
    await user.click(within(await popup()).getByRole("button", { name: /^Patient b\./ }));
    expect(api.markNotificationRead).toHaveBeenCalledWith("b");
    expect(currentLocation()).toBe("/patients/pat_b");
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument(), SLOW);
    expect(seenUntil("u1")).toBe(Date.parse(items[0].created_at));
  });

  test("REG-FE-NOTIFSIGNIN-010 Mark all as read reaches the server, then closes as seen", async () => {
    const items = [N("a", 30)];
    api.listNotifications.mockResolvedValue(page(items));
    const { user } = renderUI(<SignInNotifications />);
    await user.click(within(await popup()).getByRole("button", { name: "Mark all as read" }));
    expect(api.markAllNotificationsRead).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument(), SLOW);
    expect(seenUntil("u1")).toBe(Date.parse(items[0].created_at));
  });

  test("REG-FE-NOTIFSIGNIN-011 Escape closes it and counts as seen", async () => {
    const items = [N("a", 30)];
    api.listNotifications.mockResolvedValue(page(items));
    const { user } = renderUI(<SignInNotifications />);
    await popup();
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument(), SLOW);
    expect(seenUntil("u1")).toBe(Date.parse(items[0].created_at));
  });

  test("REG-FE-NOTIFSIGNIN-012 decided once per sign-in: a newer notice later does not pop it up again", async () => {
    api.listNotifications.mockResolvedValue(page([N("a", 30)]));
    const { user, qc } = renderUI(<SignInNotifications />);
    await user.click(within(await popup()).getByRole("button", { name: "Got it" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument(), SLOW);
    api.listNotifications.mockResolvedValue(page([N("later", 0), N("a", 30)]));
    await act(() => qc.refetchQueries({ queryKey: ["notifications", "u1", "unread"] }));
    await new Promise((r) => setTimeout(r, 30));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  test("REG-FE-NOTIFSIGNIN-013 no one signed in: nothing is fetched and nothing shows", async () => {
    auth.user = null;
    api.listNotifications.mockResolvedValue(page([N("a", 1)]));
    renderUI(<SignInNotifications />);
    await new Promise((r) => setTimeout(r, 30));
    expect(api.listNotifications).not.toHaveBeenCalled();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  test("REG-FE-NOTIFSIGNIN-014 a failed load shows no pop-up and does not throw", async () => {
    api.listNotifications.mockRejectedValue(new Error("offline"));
    renderUI(<SignInNotifications />);
    await settled();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });
});
