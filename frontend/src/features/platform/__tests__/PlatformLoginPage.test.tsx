// The platform sign-in page: its own token, separate from the clinic app's.
import { screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, test, vi } from "vitest";

const m = vi.hoisted(() => ({ platformLogin: vi.fn() }));
vi.mock("@/features/platform/api", async (orig) => ({ ...(await orig<object>()), ...m }));

import { PlatformLoginPage } from "@/features/platform/pages/PlatformLoginPage";
import { deferred } from "@/test/admin";
import { currentLocation, renderUI } from "@/test/render";

const open = () => renderUI(<PlatformLoginPage />, { route: "/platform/login" });

describe("REG-FE-PLAT the platform sign-in page", () => {
  beforeEach(() => {
    localStorage.clear();
    m.platformLogin.mockReset();
  });

  test("REG-FE-PLAT-010 an operator already signed in goes straight to the console", async () => {
    localStorage.setItem("clinicos_platform_token", "tok");
    open();
    await waitFor(() => expect(currentLocation()).toBe("/platform"));
  });

  test("REG-FE-PLAT-011 Sign in needs both fields, sends the email trimmed, and opens the console", async () => {
    const d = deferred<{ access_token: string; email: string }>();
    m.platformLogin.mockReturnValue(d.promise);
    const { user, container } = open();
    const [email, password] = [container.querySelector('input[type="email"]')!, container.querySelector('input[type="password"]')!];
    const btn = screen.getByRole("button", { name: "Sign in" });
    expect(btn).toBeDisabled();
    await user.type(email, " super@clinicos.local ");
    expect(btn).toBeDisabled();
    await user.type(password, "ChangeMe123!");
    expect(btn).toBeEnabled();
    await user.click(btn);
    expect(m.platformLogin).toHaveBeenCalledWith("super@clinicos.local", "ChangeMe123!");
    expect(currentLocation()).toBe("/platform/login");
    d.resolve({ access_token: "t", email: "super@clinicos.local" });
    await waitFor(() => expect(currentLocation()).toBe("/platform"));
  });

  test("REG-FE-PLAT-012 a refused sign-in shows the server's reason and clears it on the next try", async () => {
    m.platformLogin.mockRejectedValueOnce(new Error("invalid credentials")).mockRejectedValueOnce("x").mockReturnValueOnce(new Promise(() => {}));
    const { user, container } = open();
    await user.type(container.querySelector('input[type="email"]')!, "a@v.test");
    await user.type(container.querySelector('input[type="password"]')!, "wrong");
    await user.click(screen.getByRole("button", { name: "Sign in" }));
    expect(await screen.findByText("invalid credentials")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Sign in" }));
    expect(await screen.findByText("Login failed")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Sign in" }));
    await waitFor(() => expect(screen.queryByText("Login failed")).not.toBeInTheDocument());
    expect(currentLocation()).toBe("/platform/login");
  });
});
