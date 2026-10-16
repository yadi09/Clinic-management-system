// The Active sessions list: what each device is, where and when it signed in, naming
// a device, signing one out, and signing out all the others.
import { screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, test, vi } from "vitest";

const api = vi.hoisted(() => ({ listSessionsApi: vi.fn(), revokeSessionApi: vi.fn(), labelSessionApi: vi.fn(), signOutOtherDevicesApi: vi.fn() }));
vi.mock("@/features/auth/api", async (orig) => ({ ...(await orig<object>()), ...api }));
const tst = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }));
vi.mock("@/components/ui/sonner", async (orig) => ({ ...(await orig<object>()), toast: tst }));

import { ActiveSessions } from "@/features/auth/ActiveSessions";
import { countryName, describeDevice, lastActive } from "@/features/auth/device";
import type { Device } from "@/features/auth/api";
import { AppError } from "@/lib/api-client";
import { renderUI } from "@/test/render";

const min = (n: number) => new Date(Date.now() - n * 60_000).toISOString();
const D = (o: Partial<Device>): Device => ({
  id: "ses_x", user_agent: "", ip: "", country: "", label: "", started_at: min(60), last_active: min(0), expires_at: min(-1000), current: false, ...o,
});
const PC = D({ id: "ses_pc", user_agent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/155.0 Safari/537.36", ip: "196.188.10.20", country: "ET", current: true });
const PHONE = D({ id: "ses_ph", user_agent: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) Safari/604.1", ip: "41.77.1.2", country: "KE", last_active: min(90) });

beforeEach(() => {
  Object.values(api).forEach((f) => f.mockReset());
  tst.success.mockReset(); tst.error.mockReset();
  api.listSessionsApi.mockResolvedValue([PC, PHONE]);
});

describe("REG-FE-SESS device list", () => {
  test("REG-FE-SESS-001 each device says what it is, where it signed in from and when; this one is marked", async () => {
    renderUI(<ActiveSessions />);
    const rows = await screen.findAllByRole("listitem");
    expect(rows).toHaveLength(2);
    expect(rows[0]).toHaveTextContent("Chrome on Windows 10/11");
    expect(rows[0]).toHaveTextContent("This device");
    expect(rows[0]).toHaveTextContent("196.188.10.20 · Ethiopia");
    expect(rows[0]).toHaveTextContent("Active now");
    expect(within(rows[0]).queryByRole("button", { name: "Sign out" })).not.toBeInTheDocument();
    expect(rows[1]).toHaveTextContent("Safari on iOS");
    expect(rows[1]).toHaveTextContent("41.77.1.2 · Kenya");
    expect(rows[1]).toHaveTextContent("Active 2 h ago");
    expect(within(rows[1]).getByRole("button", { name: "Sign out" })).toBeInTheDocument();
  });

  test("REG-FE-SESS-007 this device is first, tinted and says 'You are here', however the server ordered the list", async () => {
    api.listSessionsApi.mockResolvedValue([PHONE, PC]); // the server lists the phone first
    renderUI(<ActiveSessions />);
    const rows = await screen.findAllByRole("listitem");
    expect(rows[0]).toHaveTextContent("Chrome on Windows 10/11");
    expect(rows[0]).toHaveTextContent("You are here");
    expect(rows[0]).toHaveAttribute("aria-current", "true");
    expect(rows[0].className).toContain("bg-brand/5");
    expect(rows[1]).toHaveTextContent("Safari on iOS");
    expect(rows[1]).not.toHaveTextContent("You are here");
    expect(rows[1]).not.toHaveAttribute("aria-current");
  });

  test("REG-FE-SESS-002 signing one device out sends only it, says which, and refreshes the list", async () => {
    api.revokeSessionApi.mockResolvedValue(undefined);
    const { user } = renderUI(<ActiveSessions />);
    await user.click(await screen.findByRole("button", { name: "Sign out" }));
    await waitFor(() => expect(api.revokeSessionApi).toHaveBeenCalledWith("ses_ph"));
    expect(tst.success).toHaveBeenCalledWith("Signed out Safari on iOS");
    await waitFor(() => expect(api.listSessionsApi).toHaveBeenCalledTimes(2));
    api.revokeSessionApi.mockRejectedValue(new AppError(404, "NOT_FOUND", "that device is no longer signed in"));
    await user.click(await screen.findByRole("button", { name: "Sign out" }));
    await waitFor(() => expect(tst.error).toHaveBeenCalledWith("that device is no longer signed in"));
    api.revokeSessionApi.mockRejectedValue("x");
    await user.click(await screen.findByRole("button", { name: "Sign out" }));
    await waitFor(() => expect(tst.error).toHaveBeenCalledWith("Could not sign that device out"));
  });

  test("REG-FE-SESS-003 a device can be named, renamed, and the name is shown with what it is", async () => {
    api.labelSessionApi.mockResolvedValue(undefined);
    const { user } = renderUI(<ActiveSessions />);
    const rows = await screen.findAllByRole("listitem");
    await user.click(within(rows[0]).getByRole("button", { name: "Name this device" }));
    await user.type(screen.getByLabelText("Device name"), "Reception PC");
    api.listSessionsApi.mockResolvedValue([{ ...PC, label: "Reception PC" }, PHONE]); // what the server answers after the save
    await user.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(api.labelSessionApi).toHaveBeenCalledWith("ses_pc", "Reception PC"));
    await waitFor(() => expect(screen.getAllByRole("listitem")[0]).toHaveTextContent("Reception PC (Chrome on Windows 10/11)"));
    await user.click(within(screen.getAllByRole("listitem")[0]).getByRole("button", { name: "Rename" }));
    expect(screen.getByLabelText("Device name")).toHaveValue("Reception PC");
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.queryByLabelText("Device name")).not.toBeInTheDocument();
    api.labelSessionApi.mockRejectedValue("x");
    await user.click(within(screen.getAllByRole("listitem")[0]).getByRole("button", { name: "Rename" }));
    await user.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(tst.error).toHaveBeenCalledWith("Could not save the name"));
  });

  test("REG-FE-SESS-004 'Sign out all other devices' counts, and is not offered when this is the only device", async () => {
    api.signOutOtherDevicesApi.mockResolvedValueOnce({ revoked: 1 }).mockResolvedValueOnce({ revoked: 3 }).mockResolvedValueOnce({ revoked: 0 }).mockRejectedValueOnce("x");
    const { user } = renderUI(<ActiveSessions />);
    const go = async () => user.click(await screen.findByRole("button", { name: "Sign out all other devices" }));
    await go(); await waitFor(() => expect(tst.success).toHaveBeenLastCalledWith("Signed out 1 other device"));
    await go(); await waitFor(() => expect(tst.success).toHaveBeenLastCalledWith("Signed out 3 other devices"));
    await go(); await waitFor(() => expect(tst.success).toHaveBeenLastCalledWith("No other devices were signed in"));
    await go(); await waitFor(() => expect(tst.error).toHaveBeenLastCalledWith("Could not sign out other devices"));
  });

  test("REG-FE-SESS-005 alone: says so and offers no sign-out of others", async () => {
    api.listSessionsApi.mockResolvedValue([PC]);
    renderUI(<ActiveSessions />);
    expect(await screen.findByText("You are signed in on this device only.")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Sign out all other devices" })).not.toBeInTheDocument();
  });

  test("REG-FE-SESS-006 while loading it says so; when the list cannot load it says that, with a retry", async () => {
    api.listSessionsApi.mockReset();
    api.listSessionsApi.mockRejectedValue(new Error("down"));
    const { user } = renderUI(<ActiveSessions />);
    expect(screen.getByText("Loading your devices…")).toBeInTheDocument();
    expect(await screen.findByRole("alert", undefined, { timeout: 4000 })).toHaveTextContent("Could not load your devices.");
    api.listSessionsApi.mockResolvedValue([PC]);
    await user.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByText("You are signed in on this device only.")).toBeInTheDocument();
  });
});

describe("REG-FE-SESS words", () => {
  test("REG-FE-SESS-010 browsers, systems and kinds of device from the user-agent", () => {
    expect(describeDevice("Mozilla/5.0 (Windows NT 10.0) Chrome/155 Safari/537 Edg/155")).toMatchObject({ browser: "Edge", os: "Windows 10/11", kind: "computer" });
    expect(describeDevice("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15) Safari/605")).toMatchObject({ browser: "Safari", os: "macOS", kind: "computer" });
    expect(describeDevice("Mozilla/5.0 (Linux; Android 14; SM-S911B) Chrome/130 Mobile Safari/537")).toMatchObject({ browser: "Chrome", os: "Android", kind: "phone" });
    expect(describeDevice("Mozilla/5.0 (Linux; Android 14; SM-X900) Chrome/130 Safari/537")).toMatchObject({ os: "Android", kind: "tablet" });
    expect(describeDevice("Mozilla/5.0 (iPad; CPU OS 18_0 like Mac OS X) Safari/604")).toMatchObject({ os: "iOS", kind: "tablet" });
    expect(describeDevice("Mozilla/5.0 (X11; Linux x86_64; rv:130.0) Gecko/20100101 Firefox/130.0")).toMatchObject({ browser: "Firefox", os: "Linux" });
    expect(describeDevice("Mozilla/5.0 (Windows NT 6.1) Opera/9")).toMatchObject({ browser: "Opera", os: "Windows" });
    expect(describeDevice("Mozilla/5.0 (Linux; Android 13) SamsungBrowser/24.0 Mobile")).toMatchObject({ browser: "Samsung Internet" });
    expect(describeDevice("Mozilla/5.0 (X11; CrOS x86_64) Chrome/130")).toMatchObject({ os: "ChromeOS" });
    expect(describeDevice("curl/8")).toMatchObject({ browser: "Unknown browser", os: "Unknown system", kind: "computer" });
  });

  test("REG-FE-SESS-011 country names and how long ago, in plain words", () => {
    expect(countryName("ET")).toBe("Ethiopia");
    expect(countryName("")).toBe("");
    expect(countryName("1!")).toBe("1!"); // a code the browser cannot name is shown as it is
    const now = Date.parse("2026-10-16T12:00:00Z");
    const ago = (m: number) => lastActive(new Date(now - m * 60000).toISOString(), now);
    expect([ago(0), ago(4), ago(12), ago(180), ago(1500), ago(2880 + 60)]).toEqual(["Active now", "Active now", "Active 12 min ago", "Active 3 h ago", "Active 1 day ago", "Active 2 days ago"]);
  });
});
