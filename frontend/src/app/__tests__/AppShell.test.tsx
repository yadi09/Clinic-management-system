// The frame around every signed-in page: the sidebar, the branch switcher, the
// account menu, the phone tab bar with its Menu sheet, and the ⌘K palette.
import { act, screen, waitFor, within } from "@testing-library/react";
import { Route, Routes } from "react-router-dom";
import { beforeEach, describe, expect, test, vi } from "vitest";

// Whole-page flows with many clicks; the shared 5s budget is too tight when the full
// suite runs in parallel (and under scripts/test/time-sweep.sh).
vi.setConfig({ testTimeout: 20_000 });

vi.mock("@/app/auth-context", async () => (await import("@/test/admin")).authModule);
vi.mock("@/components/ui/sonner", async (orig) => ({ ...(await orig<object>()), toast: (await import("@/test/admin")).toastSpy }));
const lab = vi.hoisted(() => ({ inboxCount: vi.fn() }));
vi.mock("@/features/lab/api", () => lab);
const patients = vi.hoisted(() => ({ searchPatients: vi.fn() }));
vi.mock("@/features/patients/api", () => patients);
vi.mock("@/features/help/PageHelp", () => ({ PageHelp: () => <span>help</span> }));
vi.mock("@/features/notifications/NotificationBell", () => ({ NotificationBell: () => <span>bell</span> }));
vi.mock("@/features/notifications/SignInNotifications", () => ({ SignInNotifications: () => null }));
vi.mock("@/features/notifications/LiveAlerts", () => ({ LiveAlerts: () => null }));

import { AppShell } from "@/app/layouts/AppShell";
import { MobileNav } from "@/app/layouts/MobileNav";
import { navSections, visibleNav } from "@/app/nav";
import { authFns, OWNER_PERMS, resetToasts, setAuth, toastSpy } from "@/test/admin";
import { currentLocation, renderUI } from "@/test/render";

const BRANCHES = [{ id: "br_1", name: "Bole", code: "BOLE" }, { id: "br_2", name: "Piassa", code: "PIA" }];

function Shell({ route = "/" }: { route?: string }) {
  return renderUI(
    <Routes>
      <Route element={<AppShell />}>
        <Route path="/" element={<p>Dashboard page</p>} />
        <Route path="*" element={<p>Some page</p>} />
      </Route>
    </Routes>,
    { route },
  );
}

const sidebar = () => screen.getByText("v3 · Tenant").closest("aside")!;
const tabBar = () => screen.getByRole("navigation", { name: "Primary" });

beforeEach(() => {
  setAuth();
  resetToasts();
  lab.inboxCount.mockResolvedValue({ count: 0 });
  patients.searchPatients.mockResolvedValue({ items: [] });
});

describe("REG-FE-SHELL app shell", () => {
  test("REG-FE-SHELL-001 the sidebar is the dental owner's menu and the page renders inside", async () => {
    Shell({});
    expect(screen.getByText("Dashboard page")).toBeInTheDocument();
    const side = within(sidebar());
    expect(side.getByRole("link", { name: "Chairside" })).toHaveAttribute("href", "/chairside");
    expect(side.getByRole("link", { name: "Settings" })).toHaveAttribute("href", "/settings");
    expect(side.queryByRole("link", { name: "Triage" })).not.toBeInTheDocument();
    expect(side.getByRole("link", { name: "Dashboard" })).toHaveClass("bg-primary");
    // One branch: no switcher, just where you are and who you are.
    expect(screen.getByText(/Main Branch · clinic admin/)).toBeInTheDocument();
    expect(lab.inboxCount).not.toHaveBeenCalled(); // no lab.order → no polling
  });

  test("REG-FE-SHELL-002 a critical lab result shows a count on the sidebar and on Menu", async () => {
    setAuth({ perms: [...OWNER_PERMS, "lab.order"], flags: ["laboratory"] });
    lab.inboxCount.mockResolvedValue({ count: 3 });
    Shell({});
    const link = within(sidebar()).getByRole("link", { name: /Results inbox/ });
    await waitFor(() => expect(link).toHaveTextContent("3"));
  });

  test("REG-FE-SHELL-003 the account menu shows who is signed in, opens Settings, and signs out", async () => {
    const { user } = Shell({});
    await user.click(screen.getByRole("button", { name: /^HD/ }));
    const menu = await screen.findByRole("menu");
    expect(within(menu).getByText("Hanna Desta")).toBeInTheDocument();
    expect(within(menu).getByText("owner@cure.et")).toBeInTheDocument();
    await user.click(within(menu).getByRole("menuitem", { name: "Settings" }));
    expect(currentLocation()).toBe("/settings");

    await user.click(screen.getByRole("button", { name: /^HD/ }));
    await user.click(await screen.findByRole("menuitem", { name: /Sign out/ }));
    expect(authFns.signOut).toHaveBeenCalled();
  });

  test("REG-FE-SHELL-004 two branches: the switcher lists them, ticks the active one, and switches", async () => {
    setAuth({ branches: BRANCHES, activeBranchId: "br_1", allBranches: true });
    const { user, qc } = Shell({});
    const inv = vi.spyOn(qc, "invalidateQueries");
    await user.click(screen.getByRole("button", { name: /Bole/ }));
    const menu = await screen.findByRole("menu");
    expect(within(menu).getByText("Switch branch")).toBeInTheDocument();
    expect(within(menu).getAllByRole("menuitem").map((m) => m.textContent)).toEqual(["Bole", "Piassa", "All branches"]);
    await user.click(within(menu).getByRole("menuitem", { name: "Piassa" }));
    await waitFor(() => expect(authFns.switchBranch).toHaveBeenCalledWith("br_2"));
    await waitFor(() => expect(inv).toHaveBeenCalled());
  });

  test("REG-FE-SHELL-005 the consolidated view is labelled All branches and can be chosen", async () => {
    setAuth({ branches: BRANCHES, activeBranchId: null, allBranches: true });
    const { user } = Shell({});
    await user.click(screen.getByRole("button", { name: /All branches/ }));
    await user.click(within(await screen.findByRole("menu")).getByRole("menuitem", { name: "All branches" }));
    await waitFor(() => expect(authFns.switchBranch).toHaveBeenCalledWith("all"));
  });

  test("REG-FE-SHELL-006 a refused branch switch is said out loud", async () => {
    setAuth({ branches: BRANCHES, activeBranchId: "br_1" });
    authFns.switchBranch.mockRejectedValueOnce(new Error("You do not work at Piassa"));
    const { user } = Shell({});
    await user.click(screen.getByRole("button", { name: /Bole/ }));
    await user.click(within(await screen.findByRole("menu")).getByRole("menuitem", { name: "Piassa" }));
    await waitFor(() => expect(toastSpy.error).toHaveBeenCalledWith("You do not work at Piassa"));
    authFns.switchBranch.mockRejectedValueOnce("weird");
    await user.click(screen.getByRole("button", { name: /Bole/ }));
    await user.click(within(await screen.findByRole("menu")).getByRole("menuitem", { name: "Piassa" }));
    await waitFor(() => expect(toastSpy.error).toHaveBeenCalledWith("Could not switch branch"));
  });

  test("REG-FE-SHELL-007 on a phone the branch list lives in the account menu", async () => {
    setAuth({ branches: BRANCHES, activeBranchId: "br_2", allBranches: true });
    const { user } = Shell({});
    await user.click(screen.getByRole("button", { name: /^HD/ }));
    const menu = await screen.findByRole("menu");
    expect(within(menu).getByText("Branch · Piassa")).toBeInTheDocument();
    await user.click(within(menu).getByRole("menuitem", { name: "Bole" }));
    await waitFor(() => expect(authFns.switchBranch).toHaveBeenCalledWith("br_1"));
    await user.click(screen.getByRole("button", { name: /^HD/ }));
    await user.click(within(await screen.findByRole("menu")).getByRole("menuitem", { name: "All branches" }));
    await waitFor(() => expect(authFns.switchBranch).toHaveBeenCalledWith("all"));
  });

  test("REG-FE-SHELL-008 a user with no name or role still gets a sensible header", () => {
    setAuth({ user: null, perms: [] });
    Shell({});
    expect(screen.getByRole("button", { name: /^\?/ })).toBeInTheDocument();
    expect(screen.getByText(/Main Branch · staff/)).toBeInTheDocument();
  });
});

describe("REG-FE-MOBILE phone navigation", () => {
  test("REG-FE-MOBILE-001 a dentist's four tabs, then Menu", () => {
    Shell({});
    const tabs = within(tabBar()).getAllByRole("link").map((a) => a.textContent);
    expect(tabs).toEqual(["Dashboard", "Patients", "Chairside", "Appointments"]);
    expect(within(tabBar()).getByRole("button", { name: "All destinations" })).toBeInTheDocument();
  });

  test("REG-FE-MOBILE-002 Menu holds only what the bar cannot, and closes when you pick one", async () => {
    const { user } = Shell({});
    await user.click(screen.getByRole("button", { name: "All destinations" }));
    const sheet = await screen.findByRole("dialog");
    expect(within(sheet).getByText("Go to")).toBeInTheDocument();
    expect(within(sheet).queryByRole("link", { name: "Patients" })).not.toBeInTheDocument();
    expect(within(sheet).getByText("Administration")).toBeInTheDocument();
    await user.click(within(sheet).getByRole("link", { name: "Settings" }));
    expect(currentLocation()).toBe("/settings");
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
  });

  test("REG-FE-MOBILE-003 off a tab's page, Menu is the active slot; on one, it is not", () => {
    const r = Shell({ route: "/settings" });
    expect(within(tabBar()).getByRole("button", { name: "All destinations" })).toHaveClass("text-brand");
    r.unmount();
    Shell({ route: "/patients/pat_1" });
    expect(within(tabBar()).getByRole("button", { name: "All destinations" })).toHaveClass("text-muted-foreground");
    expect(within(tabBar()).getByRole("link", { name: "Patients" })).toHaveClass("text-brand");
  });

  test("REG-FE-MOBILE-004 badges: on a tab, on the sheet, and a dot on Menu when the alert has no tab", async () => {
    const sections = visibleNav(navSections, (p) => ["lab.order", "patient.read"].includes(p), (f) => f === "laboratory");
    const count = (k?: string) => (k === "labInbox" ? 4 : 0);
    const { user, container } = renderUI(<MobileNav sections={sections} badgeCount={count} />);
    // Results inbox earns no tab, so Menu carries the dot.
    expect(within(tabBar()).queryByText("4")).not.toBeInTheDocument();
    expect(container.querySelector(".h-2.w-2.rounded-full.bg-rose-600")).not.toBeNull();
    await user.click(screen.getByRole("button", { name: "All destinations" }));
    expect(within(await screen.findByRole("dialog")).getByRole("link", { name: /Results inbox/ })).toHaveTextContent("4");
  });

  test("REG-FE-MOBILE-005 a badged destination that earns a tab shows its count on the tab", () => {
    const item = { to: "/patients", label: "Patients", icon: navSections[0].items[0].icon, badge: "labInbox" as const };
    renderUI(<MobileNav sections={[{ items: [item, { ...navSections[0].items[0], to: "/messages", label: "Patient messages" }] }]} badgeCount={() => 2} />);
    expect(within(tabBar()).getByRole("link", { name: /Patients/ })).toHaveTextContent("2");
    // The long label is shortened to fit a tab.
    expect(within(tabBar()).getByText("Messages")).toBeInTheDocument();
  });

  test("REG-FE-MOBILE-006 with no badge function nothing is badged", () => {
    renderUI(<MobileNav sections={visibleNav(navSections, () => true, () => false)} />);
    expect(within(tabBar()).getAllByRole("link")).toHaveLength(4);
  });
});

describe("REG-FE-PALETTE command palette", () => {
  test("REG-FE-PALETTE-001 the Search button opens it; jump to a page from the same menu", async () => {
    const { user } = Shell({});
    await user.click(screen.getAllByRole("button", { name: /Search/ })[0]);
    const dlg = await screen.findByRole("dialog");
    expect(within(dlg).getByRole("option", { name: /Register patient/ })).toBeInTheDocument();
    expect(within(dlg).queryByRole("option", { name: /Triage/ })).not.toBeInTheDocument();
    await user.click(within(dlg).getByRole("option", { name: /Chairside/ }));
    expect(currentLocation()).toBe("/chairside");
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
  });

  test("REG-FE-PALETTE-002 typing two letters asks the server for matching patients", async () => {
    const { user } = Shell({});
    act(() => { window.dispatchEvent(new CustomEvent("open-command")); });
    const dlg = await screen.findByRole("dialog");
    await user.type(within(dlg).getByPlaceholderText(/Search patients/), "al");
    await waitFor(() => expect(patients.searchPatients).toHaveBeenCalledWith("al", 1, 6), { timeout: 2000 });
  });

  // NEW-PALETTE-1. The server's matches are rendered as cmdk items whose value is
  // "patient-<id>", and cmdk then filters them AGAIN, client-side, against what was
  // typed. "al" does not fuzzy-match "patient-pat_9" (no "l"), so Almaz Haile —
  // whom the server found — is hidden and the palette says "No results." Searching
  // a patient by name from ⌘K only works when the letters happen to be in the id.
  test.fails("REG-FE-PALETTE-005 KNOWN BUG NEW-PALETTE-1 a patient the server found is listed and opens", async () => {
    patients.searchPatients.mockResolvedValue({ items: [{ id: "pat_9", first_name: "Almaz", last_name: "Haile", mrn: "CD-0009" }] });
    const { user } = Shell({});
    act(() => { window.dispatchEvent(new CustomEvent("open-command")); });
    const dlg = await screen.findByRole("dialog");
    await user.type(within(dlg).getByPlaceholderText(/Search patients/), "al");
    await waitFor(() => expect(patients.searchPatients).toHaveBeenCalledWith("al", 1, 6), { timeout: 2000 });
    const hit = await within(dlg).findByRole("option", { name: /Almaz Haile/ }, { timeout: 1000 });
    await user.click(hit);
    expect(currentLocation()).toBe("/patients/pat_9");
  });

  test("REG-FE-PALETTE-006 a server match whose id happens to fuzzy-match is listed and opens", async () => {
    // Pins the rendering path (name + card number) that NEW-PALETTE-1 usually hides.
    patients.searchPatients.mockResolvedValue({ items: [{ id: "pat_9", first_name: "Petros", last_name: "", mrn: "CD-0009" }] });
    const { user } = Shell({});
    act(() => { window.dispatchEvent(new CustomEvent("open-command")); });
    const dlg = await screen.findByRole("dialog");
    await user.type(within(dlg).getByPlaceholderText(/Search patients/), "pat");
    const hit = await within(dlg).findByRole("option", { name: /Petros/ }, { timeout: 2000 });
    expect(hit).toHaveTextContent("CD-0009");
    await user.click(hit);
    expect(currentLocation()).toBe("/patients/pat_9");
  });

  test("REG-FE-PALETTE-003 ⌘K / Ctrl+K toggles it; no patient search without the permission", async () => {
    setAuth({ perms: ["dental.manage"] });
    const { user } = Shell({});
    await user.keyboard("{Control>}k{/Control}");
    const dlg = await screen.findByRole("dialog");
    expect(within(dlg).queryByRole("option", { name: /Register patient/ })).not.toBeInTheDocument();
    await user.type(within(dlg).getByPlaceholderText(/Search patients/), "zzzz");
    await new Promise((r) => setTimeout(r, 300));
    expect(patients.searchPatients).not.toHaveBeenCalled();
    expect(within(dlg).getByText("No results.")).toBeInTheDocument();
    await user.keyboard("{Meta>}k{/Meta}");
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
  });

  test("REG-FE-PALETTE-004 Register patient goes to the registration form", async () => {
    const { user } = Shell({});
    act(() => { window.dispatchEvent(new CustomEvent("open-command")); });
    await user.click(within(await screen.findByRole("dialog")).getByRole("option", { name: /Register patient/ }));
    expect(currentLocation()).toBe("/patients/new");
  });
});
