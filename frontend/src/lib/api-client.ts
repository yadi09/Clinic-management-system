import { tokenStore } from "./token";
import { setLink } from "./connection";

const BASE = import.meta.env.VITE_API_BASE_URL ?? "/api/v1";

/** Typed error mirroring the backend error envelope (Part 4 §10.7). */
export class AppError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    public requestId?: string,
    public details?: Record<string, string>,
    public body?: unknown, // full parsed error body (e.g. duplicate matches)
  ) {
    super(message);
    this.name = "AppError";
  }
}

export interface Meta {
  page?: number;
  page_size?: number;
  total?: number;
  next_cursor?: string;
}

interface RequestOptions {
  method?: string;
  body?: unknown;
  auth?: boolean; // attach access token (default true)
  retry?: boolean; // attempt one refresh on 401 (default true)
  /** Extra request headers. Used by the public campaign page, whose caller is a
   *  dental clinic with no account and its own one-off token. */
  headers?: Record<string, string>;
  /** Let the request outlive the page (a save fired as the tab closes). */
  keepalive?: boolean;
  /** How long to wait for an answer before giving up. Default: see `waitFor`. */
  timeoutMs?: number;
}

// How long a request may go unanswered. Without a limit a connection that is up but
// carries nothing leaves "Saving…" on screen for ever, and the person cannot tell
// whether their work reached the server.
const WAIT_MS = 30_000;
// Work that is slow by nature: the Ministry's server, a whole register, the AI.
const SLOW_MS = 120_000;
const SLOW_PATHS = [
  /^\/reporting\/dhis2/,
  /^\/patients\/import/,
  /^\/history-import/,
  /^\/lab\/catalog\/import/,
  /^\/encounters\/[^/]+\/assist/,
];
export const waitFor = (path: string) => (SLOW_PATHS.some((re) => re.test(path)) ? SLOW_MS : WAIT_MS);

/** What to tell the person when the server could not be reached or did not answer. */
function unreachable(code: "NETWORK" | "TIMEOUT", write: boolean): AppError {
  if (code === "TIMEOUT") {
    return new AppError(0, code, write
      ? "The server did not answer in time. Your change may not have been saved — check before doing it again."
      : "The server took too long to answer. Please try again.");
  }
  return new AppError(0, code, write
    ? "Could not reach the server, so this was not confirmed as saved. Check your connection, and check whether it saved before doing it again."
    : "Could not reach the server. Check your connection and try again.");
}

/** fetch with a time limit that covers reading the answer too, and the link signal. */
async function send(url: string, init: RequestInit, ms: number, write: boolean): Promise<{ res: Response; text: string | null }> {
  const ctl = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; ctl.abort(); }, ms);
  try {
    const res = await fetch(url, { ...init, signal: ctl.signal });
    // 204 has no body to wait for.
    const text = res.status === 204 ? null : await res.text();
    clearTimeout(timer);
    setLink("ok");
    return { res, text };
  } catch {
    clearTimeout(timer);
    if (timedOut) { setLink("slow"); throw unreachable("TIMEOUT", write); }
    // Anything else the browser could not send or finish (offline, DNS, a dropped
    // connection) is the same to the person: it did not get through.
    setLink("down");
    throw unreachable("NETWORK", write);
  }
}

// When the server ends a session mid-use (the account was locked out, the clinic
// suspended, or the sign-in could not be renewed), the app must sign out and say
// why, not leave every screen failing one request at a time (SEC-2, SEC-10).
export type SessionEnd = "expired" | "clinic-suspended";
export const SESSION_END_KEY = "clinicos.session_end";
let onSessionEnded: ((why: SessionEnd) => void) | null = null;
export function setSessionEndedHandler(fn: ((why: SessionEnd) => void) | null) {
  onSessionEnded = fn;
}

// Coalesce concurrent refreshes so a burst of 401s triggers a single refresh.
let refreshing: Promise<boolean> | null = null;

async function refreshOnce(): Promise<boolean> {
  if (!refreshing) {
    refreshing = (async () => {
      try {
        const { res, text } = await send(`${BASE}/auth/refresh`, { method: "POST", credentials: "include" }, WAIT_MS, true);
        if (!res.ok) return false;
        const json = text ? JSON.parse(text) : {};
        const token = json?.data?.access_token as string | undefined;
        if (!token) return false;
        tokenStore.set(token);
        return true;
      } catch {
        return false;
      } finally {
        setTimeout(() => (refreshing = null), 0);
      }
    })();
  }
  return refreshing;
}

async function request<T>(path: string, opts: RequestOptions = {}): Promise<{ data: T; meta?: Meta }> {
  const { method = "GET", body, auth = true, retry = true } = opts;
  const headers: Record<string, string> = { "Content-Type": "application/json", ...(opts.headers ?? {}) };
  const token = tokenStore.get();
  if (auth && token) headers.Authorization = `Bearer ${token}`;

  const { res, text } = await send(`${BASE}${path}`, {
    method,
    headers,
    credentials: "include",
    body: body !== undefined ? JSON.stringify(body) : undefined,
    keepalive: opts.keepalive,
  }, opts.timeoutMs ?? waitFor(path), method !== "GET");

  if (res.status === 401 && auth && retry) {
    const ok = await refreshOnce();
    if (ok) return request<T>(path, { ...opts, retry: false });
  }

  if (res.status === 204 || text === null) return { data: undefined as T };
  let json: { error?: { code?: string; message?: string; request_id?: string; details?: Record<string, string> }; data?: unknown; meta?: Meta } = {};
  if (text) {
    try {
      json = JSON.parse(text);
    } catch {
      // Body isn't JSON — almost always a proxy/gateway error page (HTML) on a
      // 5xx. Surface a clean message instead of a raw "Unexpected token '<'".
      const msg =
        res.status >= 500
          ? "The server had trouble with that request. Please try again in a moment."
          : "The server returned an unexpected response.";
      throw new AppError(res.status || 502, "UPSTREAM_ERROR", msg);
    }
  }
  if (!res.ok) {
    const e = json?.error ?? {};
    if (auth && token) {
      if (res.status === 401) onSessionEnded?.("expired");
      else if (res.status === 403 && e.code === "TENANT_INACTIVE") onSessionEnded?.("clinic-suspended");
    }
    throw new AppError(res.status, e.code ?? "ERROR", e.message ?? "Request failed", e.request_id, e.details, json);
  }
  return { data: (json?.data ?? json) as T, meta: json?.meta };
}

/** Returns the response `data` payload. */
export async function apiFetch<T>(path: string, opts: RequestOptions = {}): Promise<T> {
  return (await request<T>(path, opts)).data;
}

/** Returns a list payload with its pagination metadata. */
export async function apiList<T>(path: string, opts: RequestOptions = {}): Promise<{ items: T[]; meta: Meta }> {
  const { data, meta } = await request<T[]>(path, opts);
  return { items: data ?? [], meta: meta ?? {} };
}

// A file going straight to the storage provider rather than through our server. It
// gets a time limit and plain words too, but says nothing about whether OUR server
// can be reached, so the banner is left alone.
const UPLOAD_MS = 120_000;
export async function sendFile(url: string, init: RequestInit): Promise<Response> {
  const ctl = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; ctl.abort(); }, UPLOAD_MS);
  try {
    const res = await fetch(url, { ...init, signal: ctl.signal });
    clearTimeout(timer);
    return res;
  } catch {
    clearTimeout(timer);
    if (timedOut) throw new AppError(0, "TIMEOUT", "The upload took too long. Check your connection and try again.");
    throw new AppError(0, "NETWORK", "Could not upload the file. Check your connection and try again.");
  }
}

/** Attempt a silent refresh (used on app boot to restore a session). */
export function trySilentRefresh(): Promise<boolean> {
  return refreshOnce();
}
