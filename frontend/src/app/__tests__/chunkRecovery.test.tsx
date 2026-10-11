// A tab that outlives a deploy asks for pieces of the app that no longer exist. The
// page must fetch the new version, once, and never loop; a real fault still shows.
import { Suspense } from "react";
import { render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { ErrorBoundary } from "@/app/ErrorBoundary";
import { installChunkRecovery, isChunkError, lazyWithReload, reloadForNewVersion } from "@/app/chunkRecovery";

const CHROME = "Failed to fetch dynamically imported module: https://app.clinicos.cc/assets/TakingsChart-Dnx8Je-j.js";

let loc: { reload: ReturnType<typeof vi.fn>; href: string };
beforeEach(() => {
  loc = { reload: vi.fn(), href: "/" };
  vi.stubGlobal("location", loc);
  sessionStorage.clear();
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

describe("REG-FE-CHUNK a tab opened before an update", () => {
  test("REG-FE-CHUNK-001 it recognises a missing piece in every browser's words, and nothing else", () => {
    for (const m of [
      CHROME,
      "error loading dynamically imported module: https://x/assets/a.js",
      "Importing a module script failed.",
      "Loading chunk 12 failed.",
      "Loading CSS chunk 7 failed.",
    ]) expect(isChunkError(new TypeError(m)), m).toBe(true);
    const named = new Error("boom"); named.name = "ChunkLoadError";
    expect(isChunkError(named)).toBe(true);
    for (const m of ["Cannot read properties of undefined (reading 'map')", "Network request failed", "Unexpected token <"]) {
      expect(isChunkError(new Error(m)), m).toBe(false);
    }
    expect(isChunkError(undefined)).toBe(false);
  });

  test("REG-FE-CHUNK-002 it reloads once, then refuses to loop for a minute", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-11T12:00:00Z"));
    expect(reloadForNewVersion()).toBe(true);
    expect(loc.reload).toHaveBeenCalledTimes(1);
    expect(reloadForNewVersion()).toBe(false);
    vi.setSystemTime(new Date("2026-10-11T12:00:59Z"));
    expect(reloadForNewVersion()).toBe(false);
    expect(loc.reload).toHaveBeenCalledTimes(1);
    vi.setSystemTime(new Date("2026-10-11T12:01:01Z"));
    expect(reloadForNewVersion()).toBe(true);
    expect(loc.reload).toHaveBeenCalledTimes(2);
  });

  test("REG-FE-CHUNK-003 a lazy piece that is gone reloads the page and keeps the spinner, not an error screen", async () => {
    const Chart = lazyWithReload(() => Promise.reject(new TypeError(CHROME)));
    render(<ErrorBoundary><nav aria-label="Menu" /><Suspense fallback={<p>Loading…</p>}><Chart /></Suspense></ErrorBoundary>);
    await waitFor(() => expect(loc.reload).toHaveBeenCalledTimes(1));
    expect(screen.getByText("Loading…")).toBeInTheDocument();
    expect(screen.getByRole("navigation", { name: "Menu" })).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "This page could not be displayed" })).not.toBeInTheDocument();
  });

  test("REG-FE-CHUNK-004 the second failure inside the minute is a real fault: the error shows, no second reload", async () => {
    reloadForNewVersion(); // the page already reloaded for this once
    loc.reload.mockClear();
    const Chart = lazyWithReload(() => Promise.reject(new TypeError(CHROME)));
    render(<ErrorBoundary><Suspense fallback={null}><Chart /></Suspense></ErrorBoundary>);
    expect(await screen.findByRole("heading", { name: "This page could not be displayed" })).toBeInTheDocument();
    expect(screen.getByText(/Failed to fetch dynamically imported module/)).toBeInTheDocument();
    expect(loc.reload).not.toHaveBeenCalled();
  });

  test("REG-FE-CHUNK-005 an ordinary load error is shown at once and does not reload", async () => {
    const Chart = lazyWithReload(() => Promise.reject(new Error("Cannot read properties of undefined")));
    render(<ErrorBoundary><Suspense fallback={null}><Chart /></Suspense></ErrorBoundary>);
    expect(await screen.findByRole("heading", { name: "This page could not be displayed" })).toBeInTheDocument();
    expect(loc.reload).not.toHaveBeenCalled();
  });

  test("REG-FE-CHUNK-006 the page-level boundary also fetches the new version when a piece it did not wrap fails", async () => {
    const Bad = (): JSX.Element => { throw new TypeError(CHROME); };
    render(<ErrorBoundary><Bad /></ErrorBoundary>);
    await waitFor(() => expect(loc.reload).toHaveBeenCalledTimes(1));
    // The screen still states what happened, for the case where the reload does not help.
    expect(screen.getByRole("heading", { name: "This page could not be displayed" })).toBeInTheDocument();
  });

  test("REG-FE-CHUNK-007 the build tool's preload-failure event reloads once and suppresses its own error", () => {
    installChunkRecovery();
    const ev = new Event("vite:preloadError", { cancelable: true });
    window.dispatchEvent(ev);
    expect(loc.reload).toHaveBeenCalledTimes(1);
    expect(ev.defaultPrevented).toBe(true);
    // A second event inside the minute is left alone, so the real error surfaces.
    const again = new Event("vite:preloadError", { cancelable: true });
    window.dispatchEvent(again);
    expect(loc.reload).toHaveBeenCalledTimes(1);
    expect(again.defaultPrevented).toBe(false);
  });

  test("REG-FE-CHUNK-008 with browser storage blocked it still reloads once and no more", () => {
    const getItem = vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => { throw new Error("blocked"); });
    try {
      expect(reloadForNewVersion()).toBe(true);
      expect(reloadForNewVersion()).toBe(false);
      expect(loc.reload).toHaveBeenCalledTimes(1);
    } finally {
      getItem.mockRestore();
    }
  });
});
