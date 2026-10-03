// Shared harness for the front-desk tests (cashier, reception, appointments,
// patients, notifications): a fake server that stands in for apiFetch/apiList, a
// stand-in for useAuth, and a toast spy.
//
// The fake server answers by "METHOD /path" (":id" segments match anything), records
// every request, and falls back to quietApiFetch for unrouted reads. A test sets the
// day's data with `fake.on(...)`, drives the screen, then asserts on what was SENT
// with `fake.sent(...)` — the real api.ts functions run, so the payload a button
// builds is exactly the payload checked.
//
//   vi.mock("@/lib/api-client", async (orig) => ({ ...(await orig<object>()), ...(await import("@/test/frontdesk")).apiModule }));
//   vi.mock("@/app/auth-context", async () => (await import("@/test/frontdesk")).authModule);
//   vi.mock("@/components/ui/sonner", async (orig) => ({ ...(await orig<object>()), toast: (await import("@/test/frontdesk")).toastSpy }));
import type { ReactNode } from "react";
import { vi } from "vitest";

import { quietApiFetch } from "@/test/render";

export interface Req {
  method: string;
  path: string;
  /** Path without the query string. */
  route: string;
  query: URLSearchParams;
  body: unknown;
}
type Handler = unknown | ((req: Req) => unknown);

const routes: { method: string; re: RegExp; handler: Handler }[] = [];
const log: Req[] = [];

function toRe(pattern: string) {
  const esc = pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/:[a-zA-Z_]+/g, "[^/]+");
  return new RegExp(`^${esc}$`);
}

async function fetchImpl(path: string, opts: { method?: string; body?: unknown } = {}): Promise<unknown> {
  const method = (opts.method ?? "GET").toUpperCase();
  const [route, qs = ""] = path.split("?");
  const req: Req = { method, path, route, query: new URLSearchParams(qs), body: opts.body };
  log.push(req);
  // Newest registration wins, so a test can override a beforeEach default.
  for (let i = routes.length - 1; i >= 0; i--) {
    const r = routes[i];
    if (r.method === method && r.re.test(route)) {
      const h = r.handler;
      const v = typeof h === "function" ? await (h as (q: Req) => unknown)(req) : h;
      return structuredClone(v);
    }
  }
  if (method === "GET") return quietApiFetch(path);
  return {};
}

export const fake = {
  /** Answer METHOD path with a value, or a function of the request (throw to fail). */
  on(method: string, pattern: string, handler: Handler) {
    routes.push({ method: method.toUpperCase(), re: toRe(pattern), handler });
    return fake;
  },
  reset() {
    routes.length = 0;
    log.length = 0;
  },
  /** Every request made to METHOD path (pattern as in `on`). */
  sent(method: string, pattern: string): Req[] {
    const re = toRe(pattern);
    return log.filter((r) => r.method === method.toUpperCase() && re.test(r.route));
  },
  /** The body of the last METHOD path request. */
  lastBody(method: string, pattern: string): unknown {
    const s = fake.sent(method, pattern);
    return s[s.length - 1]?.body;
  },
  get log() {
    return log;
  },
};

/** A handler that fails like the server does. */
export function fail(status: number, message: string, code = "ERROR", body?: unknown) {
  // The real AppError, loaded lazily: this module is imported from inside the
  // "@/lib/api-client" mock factory, so a static import of it would wait on itself.
  return async () => {
    const { AppError } = await vi.importActual<typeof import("@/lib/api-client")>("@/lib/api-client");
    throw new AppError(status, code, message, undefined, undefined, body);
  };
}

/** A request that never answers — for loading states. */
export const hang = () => new Promise<never>(() => {});

/** Drop-in for the apiFetch/apiList exports of "@/lib/api-client". */
export const apiModule = {
  apiFetch: (path: string, opts?: { method?: string; body?: unknown }) => fetchImpl(path, opts),
  apiList: async (path: string, opts?: { method?: string; body?: unknown }) => {
    const d = await fetchImpl(path, opts);
    if (Array.isArray(d)) return { items: d, meta: {} };
    if (d && typeof d === "object" && "items" in (d as object)) {
      const o = d as { items: unknown[]; meta?: unknown };
      return { items: o.items, meta: o.meta ?? {} };
    }
    return { items: [], meta: {} };
  },
};

// ---- auth ----

export interface FrontUser { id: string; full_name: string; email?: string; roles: string[]; tenant_id?: string }

export const DESK_USER: FrontUser = { id: "usr_desk", full_name: "Selam Desk", email: "desk@cure.et", roles: ["receptionist"], tenant_id: "ten_1" };

/** What a dental clinic's front desk holds. */
export const DESK_PERMS = [
  "patient.read", "patient.search", "patient.create", "patient.update", "appointment.manage", "queue.manage",
  "payment.collect", "payment.charge", "billing.manage", "payment.waive", "user.read", "message.send",
];

export const authState = {
  perms: new Set<string>(DESK_PERMS),
  flags: new Set<string>(["dental"]),
  user: DESK_USER as FrontUser | null,
  activeBranchId: "br_main" as string | null,
  branches: [{ id: "br_main", name: "Main" }] as { id: string; name: string }[],
};

export function setAuth(over: Partial<{ perms: string[]; flags: string[]; user: FrontUser | null; activeBranchId: string | null }> = {}) {
  authState.perms = new Set(over.perms ?? DESK_PERMS);
  authState.flags = new Set(over.flags ?? ["dental"]);
  authState.user = over.user === undefined ? DESK_USER : over.user;
  authState.activeBranchId = over.activeBranchId === undefined ? "br_main" : over.activeBranchId;
}

function useAuth() {
  const s = authState;
  return {
    status: "authenticated",
    user: s.user,
    permissions: [...s.perms],
    flags: Object.fromEntries([...s.flags].map((f) => [f, true])),
    branches: s.branches,
    activeBranchId: s.activeBranchId,
    activeBranch: s.branches.find((b) => b.id === s.activeBranchId) ?? null,
    allBranches: false,
    can: (p: string) => s.perms.has(p),
    hasRole: (r: string) => !!s.user?.roles.includes(r),
    flagOn: (f: string) => s.flags.has(f),
    signIn: async () => {}, signOut: async () => {}, refresh: async () => {}, switchBranch: async () => {},
  };
}

/** Drop-in replacement for "@/app/auth-context". */
export const authModule = {
  useAuth,
  AuthProvider: ({ children }: { children: ReactNode }) => <>{children}</>,
};

// ---- toasts ----

/** Drop-in for sonner's `toast`: callable, with the methods the app uses. Because
 *  vitest's restoreMocks wipes vi.fn implementations between tests, these are plain
 *  recorders, cleared with resetToasts(). */
type Rec = ((...a: unknown[]) => string) & { calls: unknown[][] };
function recorder(): Rec {
  const f = ((...a: unknown[]) => { f.calls.push(a); return "t"; }) as Rec;
  f.calls = [];
  return f;
}
export const toastSpy = Object.assign(recorder(), {
  success: recorder(), error: recorder(), info: recorder(), warning: recorder(), message: recorder(),
  dismiss: recorder(), custom: recorder(), loading: recorder(),
});
export function resetToasts() {
  toastSpy.calls = [];
  for (const k of ["success", "error", "info", "warning", "message", "dismiss", "custom", "loading"] as const) toastSpy[k].calls = [];
}
/** The first argument of every call to toast.<kind>, as text. */
export const toasts = (kind: "success" | "error" | "info" | "warning" | "message" | "custom" | "loading") =>
  toastSpy[kind].calls.map((c) => String(c[0]));

// ---- print ----

/** Captures what window.open + document.write would have printed. */
export function capturePrints() {
  const docs: string[] = [];
  vi.spyOn(window, "open").mockImplementation(() => {
    let html = "";
    return { document: { write: (s: string) => { html += s; }, close: () => { docs.push(html); } } } as unknown as Window;
  });
  return docs;
}

/** Today as YYYY-MM-DD in the local zone (what freezeToday set). */
export function localISO(d = new Date()) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
