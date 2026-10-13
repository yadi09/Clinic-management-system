// Whether the server can be reached right now: one small shared fact that every
// request updates and the banner at the top of the app reads.
//
//   ok    requests are being answered
//   down  nothing reaches the server (the browser says it is offline, or a request
//         could not be sent at all)
//   slow  requests are sent but not answered in time
//
// The browser's own "offline" flag only knows about the network cable or Wi-Fi
// switch, not "connected to Wi-Fi with no internet behind it", which is the common
// case. So requests that fail also count, and while the link is not ok a tiny
// check runs until the server answers again.
import { useSyncExternalStore } from "react";

export type Link = "ok" | "down" | "slow";

const listeners = new Set<() => void>();
let state: Link = typeof navigator !== "undefined" && navigator.onLine === false ? "down" : "ok";
let probe: ReturnType<typeof setInterval> | null = null;

const PROBE_EVERY_MS = 8_000;
const PROBE_TIMEOUT_MS = 5_000;

/** The address of the server's own "are you up" answer, next to the API. */
function healthUrl(): string {
  const base = import.meta.env.VITE_API_BASE_URL ?? "/api/v1";
  return `${new URL(base, window.location.href).origin}/healthz`;
}

async function checkServer() {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), PROBE_TIMEOUT_MS);
  try {
    const r = await fetch(healthUrl(), { cache: "no-store", signal: ctl.signal });
    // Any answer at all means the server is reachable.
    if (r) setLink("ok");
  } catch { /* still not reachable: the next tick tries again */ } finally { clearTimeout(t); }
}

export function setLink(next: Link) {
  if (next === state) return;
  state = next;
  if (next === "ok") {
    if (probe) { clearInterval(probe); probe = null; }
  } else if (!probe && typeof window !== "undefined") {
    probe = setInterval(() => { void checkServer(); }, PROBE_EVERY_MS);
  }
  listeners.forEach((f) => f());
}

export const link = {
  get: (): Link => state,
  subscribe(fn: () => void) {
    listeners.add(fn);
    return () => { listeners.delete(fn); };
  },
};

if (typeof window !== "undefined") {
  window.addEventListener("offline", () => setLink("down"));
  // Back on a network is only a hint; the next answer from the server confirms it.
  window.addEventListener("online", () => { void checkServer(); });
  if (state === "down") setLink("down"); // start the check for a page opened offline
}

export function useLink(): Link {
  return useSyncExternalStore(link.subscribe, link.get, link.get);
}
