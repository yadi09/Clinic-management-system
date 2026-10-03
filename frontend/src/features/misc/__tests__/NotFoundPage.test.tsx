// A URL the app does not know lands on the 404 page — through the real route
// table, outside the signed-in shell — and the page offers the one way out.
import { screen } from "@testing-library/react";
import { Outlet } from "react-router-dom";
import { describe, expect, test, vi } from "vitest";

vi.mock("@/app/auth-context", async () => (await import("@/test/frontdesk")).authModule);
vi.mock("@/app/layouts/AppShell", () => ({ AppShell: () => <div data-testid="shell"><Outlet /></div> }));
vi.mock("@/features/dashboard/pages/DashboardPage", () => ({ DashboardPage: () => <h1>DashboardPage</h1> }));

import { AppRoutes } from "@/app/router";
import { NotFoundPage } from "@/features/misc/NotFoundPage";
import { currentLocation, renderUI } from "@/test/render";

describe("REG-FE-404 an unknown page", () => {
  test("REG-FE-404-001 an unknown URL shows 404 / Page not found, without the app shell", () => {
    renderUI(<AppRoutes />, { route: "/no/such/page?x=1" });
    expect(screen.getByRole("heading", { level: 1, name: "404" })).toBeInTheDocument();
    expect(screen.getByText("Page not found")).toBeInTheDocument();
    expect(screen.queryByTestId("shell")).not.toBeInTheDocument();
  });

  test("REG-FE-404-002 'Go home' leads to the dashboard", async () => {
    const { user } = renderUI(<AppRoutes />, { route: "/dentl/typo" });
    const home = screen.getByRole("link", { name: "Go home" });
    expect(home).toHaveAttribute("href", "/");
    await user.click(home);
    expect(currentLocation()).toBe("/");
    expect(await screen.findByRole("heading", { name: "DashboardPage" })).toBeInTheDocument();
  });

  test("REG-FE-404-003 the page on its own needs nothing but a router", () => {
    renderUI(<NotFoundPage />);
    expect(screen.getByRole("link", { name: "Go home" })).toHaveAttribute("href", "/");
  });
});
