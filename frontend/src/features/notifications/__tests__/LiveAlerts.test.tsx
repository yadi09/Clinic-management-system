// Live alerts (a patient waiting for the dentist). What must hold: only people who
// can be sent patients poll for them; what was already there when the page opened is
// left to the sign-in pop-up, only what arrives afterwards pops up; each arrival is
// announced once, by one tab, and only if this user has sound on; one or two get
// their own pop-up with an Open that goes to the patient, three or more one summary
// whose "View all" opens the bell; missed visits never pop up live; and while the
// sign-in pop-up is open no second pop-up is stacked on it (the sound still plays).
// New polls are driven by refetching the query, so no timer is faked.
import { act, configure, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

const auth = vi.hoisted(() => ({ user: { id: "u1", full_name: "Dr Sara" } as { id: string; full_name: string } | null, perms: new Set<string>() }));
vi.mock("@/app/auth-context", () => ({
  useAuth: () => ({ user: auth.user, can: (p: string) => auth.perms.has(p), flagOn: (f: string) => f === "dental" }),
}));
const api = vi.hoisted(() => ({ listNotifications: vi.fn(), markNotificationRead: vi.fn() }));
vi.mock("@/features/notifications/api", async (orig) => ({ ...(await orig<object>()), ...api }));
const snd = vi.hoisted(() => ({ announce: vi.fn() }));
vi.mock("@/features/notifications/sound", async (orig) => ({ ...(await orig<object>()), ...snd }));

import { LiveAlerts, OPEN_NOTIFICATIONS, receivesLiveAlerts } from "@/features/notifications/LiveAlerts";
import type { AppNotification, NotificationPage } from "@/features/notifications/api";
import { onscreen } from "@/features/notifications/onscreen";
import { LiveToaster } from "@/components/ui/sonner";
import { currentLocation, renderUI } from "@/test/render";

let seq = 0;
/** A notice created `secAgo` seconds before now; the server's clock is what counts. */
const W = (id: string, secAgo: number, data: Record<string, unknown> = { patient: `Patient ${id}`, department: "Dental", card: `C-${id}` },
  extra: Partial<AppNotification> = {}): AppNotification => ({
  id, kind: "patient_waiting", title: "Patient waiting", body: "", data, href: `/dental/chairside?patient=pat_${id}`,
  created_at: new Date(Date.now() - secAgo * 1000).toISOString(), read_at: null, ...extra,
});
const page = (items: AppNotification[]): NotificationPage => ({ items, unread: items.length, next: null });

async function start(first: AppNotification[]) {
  api.listNotifications.mockResolvedValue(page(first));
  const r = renderUI(<><LiveAlerts /><LiveToaster /></>, { route: "/dashboard" });
  await waitFor(() => expect(api.listNotifications).toHaveBeenCalledTimes(1));
  await act(() => new Promise((res) => setTimeout(res, 20)));
  /** The next poll answers with `items`. */
  const poll = async (items: AppNotification[]) => {
    api.listNotifications.mockResolvedValue(page(items));
    await act(() => r.qc.refetchQueries({ queryKey: ["notifications", "u1", "live"] }));
  };
  return { ...r, poll };
}
const popups = () => screen.queryAllByRole("status");

/** Exit animations run on real timers; a loaded machine needs longer than 1 s. */
const SLOW = { timeout: 5000 };
configure({ asyncUtilTimeout: SLOW.timeout });

describe("REG-FE-NOTIFLIVE live alerts", () => {
  beforeEach(() => {
    localStorage.clear();
    seq++;
    auth.user = { id: "u1", full_name: "Dr Sara" };
    auth.perms = new Set(["dental.manage"]);
    onscreen.signInOpen = false;
    api.markNotificationRead.mockResolvedValue(undefined);
  });
  afterEach(() => {
    localStorage.clear();
    onscreen.signInOpen = false;
  });

  test("REG-FE-NOTIFLIVE-001 who gets live alerts: doctors and dentists", () => {
    const can = (perms: string[]) => (p: string) => perms.includes(p);
    expect(receivesLiveAlerts(can(["encounter.manage"]))).toBe(true);
    expect(receivesLiveAlerts(can(["dental.manage"]))).toBe(true);
    expect(receivesLiveAlerts(can(["patient.create", "payment.collect"]))).toBe(false);
  });

  test("REG-FE-NOTIFLIVE-002 front desk and cashier never poll for live alerts", async () => {
    auth.perms = new Set(["patient.create", "payment.collect"]);
    renderUI(<LiveAlerts />);
    await new Promise((r) => setTimeout(r, 30));
    expect(api.listNotifications).not.toHaveBeenCalled();
  });

  test("REG-FE-NOTIFLIVE-003 what was there on opening is not announced; a new arrival pops up and is spoken", async () => {
    const old = W(`old${seq}`, 600);
    const { poll } = await start([old]);
    expect(api.listNotifications).toHaveBeenCalledWith({ unread: true, limit: 10 });
    expect(popups()).toHaveLength(0);
    expect(snd.announce).not.toHaveBeenCalled();

    await poll([W(`new${seq}`, 1, { patient: "Selam Bekele", department: "Dental", card: "C-77" }), old]);
    const pop = await screen.findByRole("status");
    expect(within(pop).getByText("Selam Bekele")).toBeInTheDocument();
    expect(within(pop).getByText("is waiting for you in Dental")).toBeInTheDocument();
    expect(within(pop).getByText("Card C-77")).toBeInTheDocument();
    expect(within(pop).getByText("SB")).toBeInTheDocument();
    expect(snd.announce).toHaveBeenCalledTimes(1);
    expect(snd.announce).toHaveBeenCalledWith("Selam Bekele is waiting for you.");
  });

  test("REG-FE-NOTIFLIVE-004 the same arrival on the next poll is not announced again", async () => {
    const { poll } = await start([]);
    const n = W(`a${seq}`, 1);
    await poll([n]);
    await screen.findByRole("status");
    await poll([n]);
    await poll([n]);
    expect(snd.announce).toHaveBeenCalledTimes(1);
    expect(popups()).toHaveLength(1);
  });

  test("REG-FE-NOTIFLIVE-005 Open marks it read, closes the pop-up and goes to the patient", async () => {
    const { poll, user } = await start([]);
    await poll([W(`a${seq}`, 1, { patient: "Selam" })]);
    await user.click(within(await screen.findByRole("status")).getByRole("button", { name: "Open" }));
    expect(api.markNotificationRead).toHaveBeenCalledWith(`a${seq}`);
    expect(currentLocation()).toBe(`/dental/chairside?patient=pat_a${seq}`);
    await waitFor(() => expect(popups()).toHaveLength(0), SLOW);
  });

  test("REG-FE-NOTIFLIVE-006 Dismiss closes the pop-up without marking anything", async () => {
    const { poll, user } = await start([]);
    await poll([W(`a${seq}`, 1, { patient: "Selam" })]);
    expect(within(await screen.findByRole("status")).getByText("is waiting for you")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Dismiss" }));
    await waitFor(() => expect(popups()).toHaveLength(0), SLOW);
    expect(api.markNotificationRead).not.toHaveBeenCalled();
  });

  test("REG-FE-NOTIFLIVE-007 two arrivals: two pop-ups, each spoken", async () => {
    const { poll } = await start([]);
    await poll([W(`a${seq}`, 1, { patient: "Abebe Kebede" }), W(`b${seq}`, 2, { patient: "Tigist" })]);
    await waitFor(() => expect(popups()).toHaveLength(2));
    expect(screen.getByText("T")).toBeInTheDocument(); // one-word name, one initial
    expect(snd.announce.mock.calls).toEqual([["Abebe Kebede is waiting for you."], ["Tigist is waiting for you."]]);
  });

  test("REG-FE-NOTIFLIVE-008 three or more: one summary, one sentence, and View all opens the bell", async () => {
    const { poll, user } = await start([]);
    const opened = vi.fn();
    window.addEventListener(OPEN_NOTIFICATIONS, opened);
    try {
      await poll([W(`a${seq}`, 1), W(`b${seq}`, 2), W(`c${seq}`, 3)]);
      const pop = await screen.findByRole("status");
      expect(popups()).toHaveLength(1);
      expect(within(pop).getByText("3 patients are waiting for you")).toBeInTheDocument();
      expect(snd.announce.mock.calls).toEqual([["3 patients are waiting for you."]]);
      await user.click(within(pop).getByRole("button", { name: "View all" }));
      expect(opened).toHaveBeenCalledTimes(1);
      await waitFor(() => expect(popups()).toHaveLength(0), SLOW);
    } finally {
      window.removeEventListener(OPEN_NOTIFICATIONS, opened);
    }
  });

  test("REG-FE-NOTIFLIVE-009 the summary can be dismissed", async () => {
    const { poll, user } = await start([]);
    await poll([W(`a${seq}`, 1), W(`b${seq}`, 2), W(`c${seq}`, 3)]);
    await screen.findByRole("status");
    await user.click(screen.getByRole("button", { name: "Dismiss" }));
    await waitFor(() => expect(popups()).toHaveLength(0), SLOW);
  });

  test("REG-FE-NOTIFLIVE-010 a missed visit arriving is not a live alert", async () => {
    const { poll } = await start([]);
    await poll([W(`m${seq}`, 1, { patient: "Almaz" }, { kind: "missed_visit" })]);
    await act(() => new Promise((r) => setTimeout(r, 20)));
    expect(popups()).toHaveLength(0);
    expect(snd.announce).not.toHaveBeenCalled();
  });

  test("REG-FE-NOTIFLIVE-011 sound off: the pop-up still shows, nothing is spoken", async () => {
    localStorage.setItem("clinicos.notifications.sound.u1", "off");
    const { poll } = await start([]);
    await poll([W(`a${seq}`, 1)]);
    expect(await screen.findByRole("status")).toBeInTheDocument();
    expect(snd.announce).not.toHaveBeenCalled();
  });

  test("REG-FE-NOTIFLIVE-012 another tab already announced it: this tab shows it but stays quiet", async () => {
    const id = `a${seq}`;
    localStorage.setItem(`clinicos.notifications.announced.${id}`, String(Date.now()));
    const { poll } = await start([]);
    await poll([W(id, 1)]);
    expect(await screen.findByRole("status")).toBeInTheDocument();
    expect(snd.announce).not.toHaveBeenCalled();
  });

  test("REG-FE-NOTIFLIVE-013 sign-in pop-up open: no stacked pop-up, but the sound plays once", async () => {
    const { poll } = await start([]);
    onscreen.signInOpen = true;
    const a = W(`a${seq}`, 1, { patient: "Selam" });
    await poll([a]);
    await act(() => new Promise((r) => setTimeout(r, 20)));
    expect(popups()).toHaveLength(0);
    expect(snd.announce.mock.calls).toEqual([["Selam is waiting for you."]]);
    await poll([W(`b${seq}`, 0), W(`c${seq}`, 0), a]);
    await act(() => new Promise((r) => setTimeout(r, 20)));
    expect(popups()).toHaveLength(0);
    expect(snd.announce).toHaveBeenLastCalledWith("2 patients are waiting for you.");
  });

  test("REG-FE-NOTIFLIVE-014 sign-in pop-up open and sound off: silent", async () => {
    localStorage.setItem("clinicos.notifications.sound.u1", "off");
    const { poll } = await start([]);
    onscreen.signInOpen = true;
    await poll([W(`a${seq}`, 1)]);
    await act(() => new Promise((r) => setTimeout(r, 20)));
    expect(snd.announce).not.toHaveBeenCalled();
  });

  test("REG-FE-NOTIFLIVE-015 an arrival makes the badge and the sign-in list refresh at once", async () => {
    const { poll, qc } = await start([]);
    const spy = vi.spyOn(qc, "invalidateQueries");
    await poll([W(`a${seq}`, 1)]);
    await screen.findByRole("status");
    const keys = spy.mock.calls.map((c) => JSON.stringify(c[0]?.queryKey));
    expect(keys).toContain(JSON.stringify(["notifications", "u1", "count"]));
    expect(keys).toContain(JSON.stringify(["notifications", "u1", "unread"]));
  });

  test("REG-FE-NOTIFLIVE-016 an older item turning up later (already accounted for) is not announced", async () => {
    const latest = W(`new${seq}`, 5);
    const { poll } = await start([latest]);
    await poll([latest, W(`older${seq}`, 600)]);
    await act(() => new Promise((r) => setTimeout(r, 20)));
    expect(popups()).toHaveLength(0);
    expect(snd.announce).not.toHaveBeenCalled();
  });
});
