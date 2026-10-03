// The session: restored from the refresh cookie on boot, filled in from /auth/me,
// switched between branches, and cleared on sign-out even when the server is not
// there to hear it. can()/flagOn() are what every menu and page gate reads.
import { act, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, test, vi } from "vitest";

const api = vi.hoisted(() => ({ meApi: vi.fn(), logoutApi: vi.fn(), switchBranchApi: vi.fn() }));
vi.mock("@/features/auth/api", async (orig) => ({ ...(await orig<object>()), ...api }));
const client = vi.hoisted(() => ({ trySilentRefresh: vi.fn() }));
vi.mock("@/lib/api-client", async (orig) => ({ ...(await orig<object>()), ...client }));

import { AuthProvider, useAuth } from "@/app/auth-context";
import { tokenStore } from "@/lib/token";
import { deferred } from "@/test/admin";

const ME = {
  user: { id: "u1", tenant_id: "t1", email: "dr@cure.et", full_name: "Dr Selam", roles: ["dentist"] },
  permissions: ["dental.manage", "patient.read"],
  flags: { dental: true, laboratory: false },
  branches: [{ id: "br_1", name: "Bole", code: "BOLE" }, { id: "br_2", name: "Piassa", code: "PIA" }],
  active_branch_id: "br_1",
  all_branches: true,
};

let ctx: ReturnType<typeof useAuth>;
function Probe() {
  ctx = useAuth();
  return (
    <div>
      <span data-testid="status">{ctx.status}</span>
      <span data-testid="branch">{ctx.activeBranch?.name ?? "none"}</span>
      <span data-testid="name">{ctx.user?.full_name ?? "nobody"}</span>
    </div>
  );
}
const status = () => screen.getByTestId("status").textContent;
const mount = () => render(<AuthProvider><Probe /></AuthProvider>);

beforeEach(() => {
  tokenStore.clear();
  api.meApi.mockResolvedValue(ME);
  api.logoutApi.mockResolvedValue(undefined);
  client.trySilentRefresh.mockResolvedValue(true);
});

describe("REG-FE-AUTHCTX session", () => {
  test("REG-FE-AUTHCTX-001 boot: loading, then the cookie restores the session and /me fills it", async () => {
    const d = deferred<boolean>();
    client.trySilentRefresh.mockReturnValueOnce(d.promise);
    mount();
    expect(status()).toBe("loading");
    d.resolve(true);
    await waitFor(() => expect(status()).toBe("authenticated"));
    expect(screen.getByTestId("branch")).toHaveTextContent("Bole");
    expect(ctx.permissions).toEqual(ME.permissions);
    expect(ctx.allBranches).toBe(true);
    expect(ctx.branches).toHaveLength(2);
  });

  test("REG-FE-AUTHCTX-002 boot without a cookie, or with /me failing, is signed out", async () => {
    client.trySilentRefresh.mockResolvedValueOnce(false);
    const a = mount();
    await waitFor(() => expect(status()).toBe("unauthenticated"));
    expect(api.meApi).not.toHaveBeenCalled();
    a.unmount();

    api.meApi.mockRejectedValueOnce(new Error("500"));
    mount();
    await waitFor(() => expect(status()).toBe("unauthenticated"));
  });

  test("REG-FE-AUTHCTX-003 a /me with missing lists defaults them to empty", async () => {
    api.meApi.mockResolvedValue({ user: ME.user });
    mount();
    await waitFor(() => expect(status()).toBe("authenticated"));
    expect(ctx.permissions).toEqual([]);
    expect(ctx.flags).toEqual({});
    expect(ctx.branches).toEqual([]);
    expect(ctx.activeBranchId).toBeNull();
    expect(ctx.allBranches).toBe(false);
    expect(ctx.activeBranch).toBeNull();
  });

  test("REG-FE-AUTHCTX-004 can / hasRole / flagOn read the loaded session", async () => {
    mount();
    await waitFor(() => expect(status()).toBe("authenticated"));
    expect(ctx.can("dental.manage")).toBe(true);
    expect(ctx.can("billing.manage")).toBe(false);
    expect(ctx.hasRole("dentist")).toBe(true);
    expect(ctx.hasRole("clinic_admin")).toBe(false);
    expect(ctx.flagOn("dental")).toBe(true);
    expect(ctx.flagOn("laboratory")).toBe(false);
    expect(ctx.flagOn("pharmacy")).toBe(false);
  });

  test("REG-FE-AUTHCTX-005 sign-in stores the token, shows the user at once, then loads permissions", async () => {
    client.trySilentRefresh.mockResolvedValueOnce(false);
    mount();
    await waitFor(() => expect(status()).toBe("unauthenticated"));
    const d = deferred<typeof ME>();
    api.meApi.mockReturnValueOnce(d.promise);
    let p!: Promise<void>;
    act(() => { p = ctx.signIn("tok-1", ME.user); });
    expect(tokenStore.get()).toBe("tok-1");
    expect(status()).toBe("authenticated");
    expect(screen.getByTestId("name")).toHaveTextContent("Dr Selam");
    d.resolve(ME);
    await act(() => p);
    expect(ctx.can("dental.manage")).toBe(true);
  });

  test("REG-FE-AUTHCTX-006 sign-in survives /me failing: the user stays signed in", async () => {
    client.trySilentRefresh.mockResolvedValueOnce(false);
    mount();
    await waitFor(() => expect(status()).toBe("unauthenticated"));
    api.meApi.mockRejectedValueOnce(new Error("down"));
    await act(() => ctx.signIn("tok-1", ME.user));
    expect(status()).toBe("authenticated");
    expect(ctx.permissions).toEqual([]);
  });

  test("REG-FE-AUTHCTX-007 sign-out clears everything, even when the logout request fails", async () => {
    tokenStore.set("tok");
    mount();
    await waitFor(() => expect(status()).toBe("authenticated"));
    api.logoutApi.mockRejectedValueOnce(new Error("offline"));
    await act(async () => { await ctx.signOut().catch(() => {}); });
    expect(status()).toBe("unauthenticated");
    expect(tokenStore.get()).toBeNull();
    expect(ctx.user).toBeNull();
    expect(ctx.permissions).toEqual([]);
    expect(ctx.flags).toEqual({});
    expect(ctx.branches).toEqual([]);
    expect(ctx.activeBranch).toBeNull();
    expect(ctx.allBranches).toBe(false);
  });

  test("REG-FE-AUTHCTX-008 switching branch takes the re-scoped token and reloads /me", async () => {
    mount();
    await waitFor(() => expect(screen.getByTestId("branch")).toHaveTextContent("Bole"));
    api.switchBranchApi.mockResolvedValueOnce({ access_token: "tok-pia" });
    api.meApi.mockResolvedValueOnce({ ...ME, active_branch_id: "br_2" });
    await act(() => ctx.switchBranch("br_2"));
    expect(api.switchBranchApi).toHaveBeenCalledWith("br_2");
    expect(tokenStore.get()).toBe("tok-pia");
    expect(screen.getByTestId("branch")).toHaveTextContent("Piassa");
  });

  test("REG-FE-AUTHCTX-009 a failed branch switch is the caller's error and keeps the old branch", async () => {
    tokenStore.set("tok-bole");
    mount();
    await waitFor(() => expect(screen.getByTestId("branch")).toHaveTextContent("Bole"));
    api.switchBranchApi.mockRejectedValueOnce(new Error("Not your branch"));
    await expect(act(() => ctx.switchBranch("br_x"))).rejects.toThrow("Not your branch");
    expect(tokenStore.get()).toBe("tok-bole");
    expect(screen.getByTestId("branch")).toHaveTextContent("Bole");
  });

  test("REG-FE-AUTHCTX-010 returning to the tab re-reads entitlements (only while signed in)", async () => {
    mount();
    await waitFor(() => expect(status()).toBe("authenticated"));
    const calls = api.meApi.mock.calls.length;
    // No token in memory: nothing to re-check.
    act(() => { window.dispatchEvent(new Event("focus")); });
    expect(api.meApi).toHaveBeenCalledTimes(calls);

    tokenStore.set("tok");
    api.meApi.mockResolvedValueOnce({ ...ME, flags: { dental: true, laboratory: true } });
    act(() => { document.dispatchEvent(new Event("visibilitychange")); });
    await waitFor(() => expect(ctx.flagOn("laboratory")).toBe(true));

    // A failed re-check is silent and keeps the session.
    api.meApi.mockRejectedValueOnce(new Error("blip"));
    act(() => { window.dispatchEvent(new Event("focus")); });
    await waitFor(() => expect(api.meApi.mock.calls.length).toBe(calls + 2));
    expect(status()).toBe("authenticated");
  });

  test("REG-FE-AUTHCTX-011 a boot that finishes after unmount does not touch state", async () => {
    const d = deferred<boolean>();
    client.trySilentRefresh.mockReturnValueOnce(d.promise);
    const r = mount();
    r.unmount();
    d.resolve(false);
    await d.promise;
    expect(api.meApi).not.toHaveBeenCalled();
  });

  test("REG-FE-AUTHCTX-012 useAuth outside the provider is a programming error", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    expect(() => render(<Probe />)).toThrow("useAuth must be used within AuthProvider");
  });
});
