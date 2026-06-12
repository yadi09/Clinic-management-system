import { tokenStore } from "./token";

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
}

// Coalesce concurrent refreshes so a burst of 401s triggers a single refresh.
let refreshing: Promise<boolean> | null = null;

async function refreshOnce(): Promise<boolean> {
  if (!refreshing) {
    refreshing = (async () => {
      try {
        const res = await fetch(`${BASE}/auth/refresh`, { method: "POST", credentials: "include" });
        if (!res.ok) return false;
        const json = await res.json();
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
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  const token = tokenStore.get();
  if (auth && token) headers.Authorization = `Bearer ${token}`;

  const res = await fetch(`${BASE}${path}`, {
    method,
    headers,
    credentials: "include",
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });

  if (res.status === 401 && auth && retry) {
    const ok = await refreshOnce();
    if (ok) return request<T>(path, { ...opts, retry: false });
  }

  if (res.status === 204) return { data: undefined as T };
  const text = await res.text();
  const json = text ? JSON.parse(text) : {};
  if (!res.ok) {
    const e = json?.error ?? {};
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

/** Attempt a silent refresh (used on app boot to restore a session). */
export function trySilentRefresh(): Promise<boolean> {
  return refreshOnce();
}
