// Moving between a clinic's branches: each branch is a workspace of its own, so moving
// signs in to it and starts the app over there — nothing from the branch left behind.
import { act, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, test, vi } from "vitest";

const api = vi.hoisted(() => ({ switchWorkspaceApi: vi.fn() }));
vi.mock("@/features/auth/api", async (orig) => ({ ...(await orig<object>()), ...api }));
const tst = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }));
vi.mock("@/components/ui/sonner", async (orig) => ({ ...(await orig<object>()), toast: tst }));

import { nav, WorkspaceSwitcher } from "@/features/auth/WorkspaceSwitcher";
import type { Workspace } from "@/features/auth/api";
import { tokenStore } from "@/lib/token";
import { renderUI } from "@/test/render";

const WS: Workspace[] = [
  { id: "ten_main", name: "Cure Dental", slug: "cure-dental", current: true },
  { id: "ten_bole", name: "Cure Dental — Bole", slug: "cure-dental-bole", current: false },
];

let reload: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  api.switchWorkspaceApi.mockReset(); tst.error.mockReset(); tokenStore.clear();
  reload = vi.spyOn(nav, "reloadHome").mockImplementation(() => undefined);
});

describe("REG-FE-BRWS switching branch", () => {
  test("REG-FE-BRWS-001 the bar names the branch you are in; the menu lists your branches with their workspace names, this one ticked", async () => {
    renderUI(<WorkspaceSwitcher items={WS} role="tenant owner" />);
    const trigger = screen.getByRole("button", { name: "Switch branch" });
    expect(trigger).toHaveTextContent("Cure Dental");
    await userEvent.click(trigger);
    const items = await screen.findAllByRole("menuitem");
    expect(items).toHaveLength(2);
    expect(items[1]).toHaveTextContent("Cure Dental — Bole");
    expect(items[1]).toHaveTextContent("cure-dental-bole");
    expect(screen.getByLabelText("current branch").closest("[role=menuitem]")).toBe(items[0]);
  });

  test("REG-FE-BRWS-002 choosing another branch signs in there and starts the app over at home", async () => {
    api.switchWorkspaceApi.mockResolvedValue({ access_token: "tok-bole", token_type: "Bearer", expires_in: 900 });
    renderUI(<WorkspaceSwitcher items={WS} role="tenant owner" />);
    await userEvent.click(screen.getByRole("button", { name: "Switch branch" }));
    await userEvent.click(await screen.findByRole("menuitem", { name: /Bole/ }));
    await waitFor(() => expect(reload).toHaveBeenCalledTimes(1));
    expect(api.switchWorkspaceApi).toHaveBeenCalledWith("ten_bole");
    expect(tokenStore.get()).toBe("tok-bole");
  });

  test("REG-FE-BRWS-003 choosing the branch you are in does nothing", async () => {
    renderUI(<WorkspaceSwitcher items={WS} role="tenant owner" />);
    await userEvent.click(screen.getByRole("button", { name: "Switch branch" }));
    await userEvent.click((await screen.findAllByRole("menuitem"))[0]!);
    expect(api.switchWorkspaceApi).not.toHaveBeenCalled();
    expect(reload).not.toHaveBeenCalled();
  });

  test("REG-FE-BRWS-004 a refused switch says why and stays put", async () => {
    api.switchWorkspaceApi.mockRejectedValue(new Error("you don't have access to that branch"));
    renderUI(<WorkspaceSwitcher items={WS} role="tenant owner" />);
    await userEvent.click(screen.getByRole("button", { name: "Switch branch" }));
    await userEvent.click(await screen.findByRole("menuitem", { name: /Bole/ }));
    await waitFor(() => expect(tst.error).toHaveBeenCalledWith("you don't have access to that branch"));
    expect(reload).not.toHaveBeenCalled();
    expect(tokenStore.get()).toBeNull();
  });

  test("REG-FE-BRWS-005 while it opens the bar says so; a failure that is not an Error still says something", async () => {
    let fail!: (e: unknown) => void;
    api.switchWorkspaceApi.mockReturnValue(new Promise((_r, j) => { fail = j; }));
    renderUI(<WorkspaceSwitcher items={WS} role="tenant owner" />);
    await userEvent.click(screen.getByRole("button", { name: "Switch branch" }));
    await userEvent.click(await screen.findByRole("menuitem", { name: /Bole/ }));
    expect(await screen.findByText("Opening…")).toBeInTheDocument();
    fail("boom");
    await waitFor(() => expect(tst.error).toHaveBeenCalledWith("Could not open that branch"));
    expect(screen.queryByText("Opening…")).not.toBeInTheDocument();
  });

  test("REG-FE-BRWS-006 the real reload goes home", () => {
    reload.mockRestore();
    const assign = vi.fn();
    const orig = window.location;
    Object.defineProperty(window, "location", { configurable: true, value: { ...orig, assign } });
    nav.reloadHome();
    expect(assign).toHaveBeenCalledWith("/");
    Object.defineProperty(window, "location", { configurable: true, value: orig });
  });

  test("REG-FE-BRWS-007 with no branch marked current the bar still names itself; a second choice while one opens is ignored", async () => {
    api.switchWorkspaceApi.mockReturnValue(new Promise(() => undefined)); // never answers
    const none = WS.map((w) => ({ ...w, current: false }));
    const { useSwitchWorkspace } = await import("@/features/auth/WorkspaceSwitcher");
    let hook!: ReturnType<typeof useSwitchWorkspace>;
    const Probe = () => { hook = useSwitchWorkspace(); return null; };
    renderUI(<><WorkspaceSwitcher items={none} role="tenant owner" /><Probe /></>);
    expect(screen.getByRole("button", { name: "Switch branch" })).toHaveTextContent("Branch");
    await act(async () => { void hook.go(none[1]!); });
    await act(async () => { void hook.go(none[0]!); });
    expect(api.switchWorkspaceApi).toHaveBeenCalledTimes(1);
  });
});
