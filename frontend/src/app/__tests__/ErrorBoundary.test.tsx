// A crash must never be a white screen. And the providers every page sits inside
// mount together: router, query cache, tooltips, session, both toast stacks.
import { lazy, Suspense } from "react";
import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { toast } from "sonner";

import { ErrorBoundary } from "@/app/ErrorBoundary";
import { lazyWithReload } from "@/app/chunkRecovery";
import { Providers } from "@/app/providers";
import { LIVE_TOASTER } from "@/components/ui/sonner";

function Boom({ msg = "Cannot read properties of undefined (reading 'map')" }: { msg?: string }): JSX.Element {
  throw new Error(msg);
}

let errSpy: ReturnType<typeof vi.spyOn>;
beforeEach(() => { errSpy = vi.spyOn(console, "error").mockImplementation(() => {}); });

describe("REG-FE-CRASH error boundary", () => {
  test("REG-FE-CRASH-001 a render error becomes a stated failure with the message and a way out", async () => {
    render(<ErrorBoundary><Boom /></ErrorBoundary>);
    expect(screen.getByRole("heading", { name: "This page could not be displayed" })).toBeInTheDocument();
    expect(screen.getByText("Cannot read properties of undefined (reading 'map')")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Reload the page" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Go to the dashboard" })).toBeInTheDocument();
    // The component stack goes to the console, where a developer will look.
    expect(errSpy).toHaveBeenCalledWith("Unhandled render error:", expect.any(Error), expect.any(String));
  });

  test("REG-FE-CRASH-002 the two buttons reload, and go home", async () => {
    const loc = { reload: vi.fn(), href: "/chairside" };
    vi.stubGlobal("location", loc);
    try {
      render(<ErrorBoundary><Boom /></ErrorBoundary>);
      await userEvent.click(screen.getByRole("button", { name: "Reload the page" }));
      expect(loc.reload).toHaveBeenCalled();
      await userEvent.click(screen.getByRole("button", { name: "Go to the dashboard" }));
      expect(loc.href).toBe("/");
    } finally {
      vi.unstubAllGlobals();
    }
  });

  test("REG-FE-CRASH-003 children render untouched when nothing throws", () => {
    render(<ErrorBoundary><p>fine</p></ErrorBoundary>);
    expect(screen.getByText("fine")).toBeInTheDocument();
  });

  // FE-11. The crash can come after a save went through or while a form held typed
  // input that is now gone. "Nothing was saved or changed" is a promise this screen
  // cannot know to be true, and it tells a dentist not to check.
  test.fails("REG-FE-CRASH-004 KNOWN BUG FE-11 the crash screen does not promise that nothing was lost", () => {
    render(<ErrorBoundary><Boom /></ErrorBoundary>);
    expect(screen.queryByText(/nothing was saved or changed/i)).not.toBeInTheDocument();
  });

  // FE-6. main.tsx has ONE boundary, above the router and the shell. A lazy chunk
  // that no longer exists after a deploy (the dashboard's chart is one) rejects with
  // "Failed to fetch dynamically imported module" and takes the sidebar, the tab bar
  // and every other page down with it, instead of failing in its own card.
  test("REG-FE-CRASH-005 a missing lazy chunk leaves the app's navigation standing and fetches the new version (FE-6)", async () => {
    const loc = { reload: vi.fn(), href: "/" };
    vi.stubGlobal("location", loc);
    sessionStorage.clear();
    try {
      const Chart = lazyWithReload(() => Promise.reject(new TypeError("Failed to fetch dynamically imported module: /assets/TakingsChart-abc.js")));
      render(
        <ErrorBoundary>
          <nav aria-label="Sidebar"><a href="/patients">Patients</a></nav>
          <main><Suspense fallback={<p>Loading chart…</p>}><Chart /></Suspense></main>
        </ErrorBoundary>,
      );
      await waitFor(() => expect(loc.reload).toHaveBeenCalledTimes(1));
      // No error screen: the page is on its way to the new version and the menu stays.
      expect(screen.getByRole("navigation", { name: "Sidebar" })).toBeInTheDocument();
      expect(screen.queryByRole("heading", { name: "This page could not be displayed" })).not.toBeInTheDocument();
      expect(screen.getByText("Loading chart…")).toBeInTheDocument();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  test("REG-FE-CRASH-006 today a missing chunk is at least reported, with the module named", async () => {
    const Chart = lazy(() => Promise.reject(new TypeError("Failed to fetch dynamically imported module: /assets/X.js")));
    render(<ErrorBoundary><Suspense fallback={null}><Chart /></Suspense></ErrorBoundary>);
    expect(await screen.findByText(/Failed to fetch dynamically imported module/, undefined, { timeout: 4000 })).toBeInTheDocument();
  });
});

describe("REG-FE-PROVIDERS app providers and toasters", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 401 })));
  });
  afterEach(() => vi.unstubAllGlobals());

  test("REG-FE-PROVIDERS-001 children render inside every provider, with both toast stacks mounted", async () => {
    render(<Providers><p>inside</p></Providers>);
    expect(screen.getByText("inside")).toBeInTheDocument();
    expect(screen.getByLabelText(/Notifications/)).toBeInTheDocument();
    expect(screen.getByLabelText(/Patients waiting/)).toBeInTheDocument();
    // The boot refresh ran against the cookie.
    await waitFor(() => expect(fetch).toHaveBeenCalledWith(expect.stringMatching(/\/auth\/refresh$/), expect.anything()));
  });

  test("REG-FE-PROVIDERS-002 an ordinary toast lands in the bottom stack; a live one in the top stack", async () => {
    render(<Providers><p>x</p></Providers>);
    act(() => { toast.success("Clinic profile saved"); });
    expect(await screen.findByText("Clinic profile saved")).toBeInTheDocument();
    act(() => { toast("Almaz is waiting", { toasterId: LIVE_TOASTER } as never); });
    const live = await screen.findByText("Almaz is waiting");
    expect(live.closest("section")?.getAttribute("aria-label")).toMatch(/^Patients waiting/);
    expect(screen.getByText("Clinic profile saved").closest("section")?.getAttribute("aria-label")).toMatch(/^Notifications/);
  });
});
