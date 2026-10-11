// A browser tab can outlive a deploy.
//
// The app is split into pieces that load on demand, and every build gives those
// pieces new file names. A tab opened before an update still asks for the old names;
// the server no longer has them, and the page used to fall over with "Failed to fetch
// dynamically imported module" — on the first update day of every clinic that keeps a
// tab open (FE-6). The remedy is not an error screen: it is to fetch the new version.
//
// So: when a piece fails to load for that reason, reload the page ONCE. If the same
// thing happens again within a minute it is a real fault, not a new version, and the
// error is shown as before — a broken network must never become a reload loop.
import { lazy, type ComponentType } from "react";

const KEY = "clinicos.chunk-reload-at";
const ONCE_PER_MS = 60_000;
let reloadedInThisPage = false;

/** Whether an error is "a piece of the page could not be loaded" (Chrome, Firefox, Safari, webpack). */
export function isChunkError(e: unknown): boolean {
  const text = e instanceof Error ? `${e.name} ${e.message}` : String(e ?? "");
  return /dynamically imported module|importing a module script failed|ChunkLoadError|loading (css )?chunk .* failed/i.test(text);
}

/** Reloads for a new version. False means it already did a moment ago: show the error. */
export function reloadForNewVersion(): boolean {
  try {
    const last = Number(sessionStorage.getItem(KEY) || 0);
    if (Date.now() - last < ONCE_PER_MS) return false;
    sessionStorage.setItem(KEY, String(Date.now()));
  } catch {
    // Storage blocked: fall back to once for the life of this page.
    if (reloadedInThisPage) return false;
    reloadedInThisPage = true;
  }
  window.location.reload();
  return true;
}

/**
 * React.lazy for pieces of the app. A failed load for a new version reloads the page
 * and keeps the spinner on screen meanwhile, so the menu and the rest of the page
 * stay standing instead of being replaced by the error screen.
 */
export function lazyWithReload<T extends ComponentType<any>>(load: () => Promise<{ default: T }>) {
  return lazy(() =>
    load().catch((e: unknown) => {
      if (isChunkError(e) && reloadForNewVersion()) return new Promise<never>(() => {});
      throw e;
    }),
  );
}

/** Pre-load failures (Vite raises this event before the import itself rejects). */
export function installChunkRecovery(): void {
  window.addEventListener("vite:preloadError", (event) => {
    if (reloadForNewVersion()) event.preventDefault();
  });
}
