// The frame around every signed-in page: the sidebar, the branch switcher, the
// account menu, the phone tab bar with its Menu sheet, and the ⌘K palette.
import { act, screen, waitFor, within } from "@testing-library/react";
import { Route, Routes } from "react-router-dom";
import { beforeEach, describe, expect, test, vi } from "vitest";

// Whole-page flows with many clicks; the shared 5s budget is too tight when the full
// suite runs in parallel (and under scripts/test/time-sweep.sh).
vi.setConfig({ testTimeout: 60_000 });

vi.mock("@/app/auth-context", async () => (await import("@/test/admin")).authModule);
vi.mock("@/components/ui/sonner", async (orig) => ({ ...(await orig<object>()), toast: (await import("@/test/admin")).toastSpy }));
const ws = vi.hoisted(() => ({ listWorkspacesApi: vi.fn(), switchWorkspaceApi: vi.fn() }));
vi.mock("@/features/auth/api", async (orig) => ({ ...(await orig<object>()), ...ws }));
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
import { setLink } from "@/lib/connection";
import { authFns, OWNER_PERMS, resetToasts, setAuth } from "@/test/admin";
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
  ws.listWorkspacesApi.mockReset().mockResolvedValue([]);
  setAuth();
  resetToasts();
  act(() => setLink("ok")); // another test's unanswered request must not leave the banner up
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

  test("REG-FE-SHELL-004 the old branches inside one workspace get no switcher any more: the bar names where you are, nothing to choose", async () => {
    setAuth({ branches: BRANCHES, activeBranchId: "br_1", allBranches: true });
    Shell({});
    expect(screen.getByText(/Bole · /)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Bole/ })).not.toBeInTheDocument();
    expect(screen.queryByText("All branches")).not.toBeInTheDocument();
    expect(authFns.switchBranch).not.toHaveBeenCalled();
  });

  test("REG-FE-SHELL-005 a session left on the old consolidated view is named for what it is, still with nothing to choose", () => {
    setAuth({ branches: BRANCHES, activeBranchId: null, allBranches: true });
    Shell({});
    expect(screen.getByText(/All branches · /)).toBeInTheDocument();
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
  });

  test("REG-FE-SHELL-009 when the server cannot be reached a banner says so on every page, and goes when it can again", () => {
    Shell({});
    expect(screen.queryByText(/No connection to the server/)).not.toBeInTheDocument();
    act(() => setLink("down"));
    expect(screen.getByRole("status", { name: "" })).toHaveTextContent("No connection to the server. Changes you make now may not be saved.");
    expect(screen.getByText("Dashboard page")).toBeInTheDocument(); // the work on screen is not taken away
    act(() => setLink("ok"));
    expect(screen.queryByText(/No connection to the server/)).not.toBeInTheDocument();
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

describe("REG-FE-SHELL-BRWS the clinic's branches in the top bar", () => {
  test("REG-FE-SHELL-BRWS-001 someone who may move between branches sees them in the bar; someone who works in one does not", async () => {
    ws.listWorkspacesApi.mockResolvedValue([
      { id: "ten_main", name: "Cure Dental", slug: "cure-dental", current: true },
      { id: "ten_bole", name: "Cure Dental — Bole", slug: "cure-dental-bole", current: false },
    ]);
    renderUI(<Routes><Route path="/" element={<AppShell />}><Route index element={<div>home</div>} /></Route></Routes>);
    expect(await screen.findByRole("button", { name: "Switch branch" })).toHaveTextContent("Cure Dental");
  });

  test("REG-FE-SHELL-BRWS-002 with no other branch there is no branch switcher", async () => {
    renderUI(<Routes><Route path="/" element={<AppShell />}><Route index element={<div>home</div>} /></Route></Routes>);
    await screen.findByText("home");
    await waitFor(() => expect(ws.listWorkspacesApi).toHaveBeenCalled());
    expect(screen.queryByRole("button", { name: "Switch branch" })).not.toBeInTheDocument();
  });

  test("REG-FE-SHELL-BRWS-003 on a phone the account menu lists the branches too, and choosing one moves there", async () => {
    const { nav } = await import("@/features/auth/WorkspaceSwitcher");
    const reload = vi.spyOn(nav, "reloadHome").mockImplementation(() => undefined);
    ws.listWorkspacesApi.mockResolvedValue([
      { id: "ten_main", name: "Cure Dental", slug: "cure-dental", current: true },
      { id: "ten_bole", name: "Cure Dental — Bole", slug: "cure-dental-bole", current: false },
    ]);
    ws.switchWorkspaceApi.mockResolvedValue({ access_token: "t", token_type: "Bearer", expires_in: 900 });
    const { user } = renderUI(<Routes><Route path="/" element={<AppShell />}><Route index element={<div>home</div>} /></Route></Routes>);
    await screen.findByRole("button", { name: "Switch branch" });
    const avatar = screen.getAllByRole("button").find((b) => b.textContent?.match(/^[A-Z?]{1,2}$/));
    await user.click(avatar!);
    expect(await screen.findByText("Your branches")).toBeInTheDocument();
    await user.click(screen.getAllByRole("menuitem", { name: /Bole/ }).at(-1)!);
    await waitFor(() => expect(reload).toHaveBeenCalled());
    expect(ws.switchWorkspaceApi).toHaveBeenCalledWith("ten_bole");
    reload.mockRestore();
  });
});
