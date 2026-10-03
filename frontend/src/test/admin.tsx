// Shared harness for the admin / app-shell tests: a stand-in for useAuth whose
// permissions, flags and branches a test sets per case, and a toast spy so a test
// can assert "the user was told" without rendering the toaster.
//
// Use from a test file (vi.mock factories are hoisted, so they import lazily):
//
//   vi.mock("@/app/auth-context", async () => (await import("@/test/admin")).authModule);
//   vi.mock("@/components/ui/sonner", async (orig) => ({ ...(await orig<object>()), toast: (await import("@/test/admin")).toastSpy }));
//   import { setAuth, toastSpy } from "@/test/admin";
import type { ReactNode } from "react";
import { vi } from "vitest";

import type { BranchRef, UserDTO } from "@/features/auth/api";

/** The person every admin test signs in as, unless it says otherwise. */
export const OWNER_USER: UserDTO = {
  id: "usr_owner", tenant_id: "ten_1", email: "owner@cure.et", full_name: "Hanna Desta", roles: ["clinic_admin"],
};

/** Everything a dental clinic owner holds. */
export const OWNER_PERMS = [
  "clinic.manage", "user.read", "user.invite", "user.update", "role.assign", "billing.manage",
  "payment.collect", "payment.charge", "patient.read", "patient.search", "patient.create",
  "appointment.manage", "queue.manage", "dental.manage", "message.send", "message.manage",
];

interface AuthState {
  perms: Set<string>;
  flags: Set<string>;
  user: UserDTO | null;
  branches: BranchRef[];
  activeBranchId: string | null;
  allBranches: boolean;
  status: "loading" | "authenticated" | "unauthenticated";
}

export const authState: AuthState = {
  perms: new Set(OWNER_PERMS), flags: new Set(["dental"]), user: OWNER_USER,
  branches: [], activeBranchId: null, allBranches: false, status: "authenticated",
};

export const authFns = {
  signIn: vi.fn(async () => {}),
  signOut: vi.fn(async () => {}),
  refresh: vi.fn(async () => {}),
  switchBranch: vi.fn(async () => {}),
};

export function setAuth(over: Partial<{ perms: string[]; flags: string[]; user: UserDTO | null; branches: BranchRef[];
  activeBranchId: string | null; allBranches: boolean; status: AuthState["status"] }> = {}) {
  authState.perms = new Set(over.perms ?? OWNER_PERMS);
  authState.flags = new Set(over.flags ?? ["dental"]);
  authState.user = over.user === undefined ? OWNER_USER : over.user;
  authState.branches = over.branches ?? [];
  authState.activeBranchId = over.activeBranchId ?? null;
  authState.allBranches = over.allBranches ?? false;
  authState.status = over.status ?? "authenticated";
  for (const f of Object.values(authFns)) f.mockReset().mockResolvedValue(undefined);
}

function useAuth() {
  const s = authState;
  return {
    status: s.status,
    user: s.user,
    permissions: [...s.perms],
    flags: Object.fromEntries([...s.flags].map((f) => [f, true])),
    branches: s.branches,
    activeBranchId: s.activeBranchId,
    activeBranch: s.branches.find((b) => b.id === s.activeBranchId) ?? null,
    allBranches: s.allBranches,
    can: (p: string) => s.perms.has(p),
    hasRole: (r: string) => !!s.user?.roles.includes(r),
    flagOn: (f: string) => s.flags.has(f),
    ...authFns,
  };
}

/** Drop-in replacement for "@/app/auth-context". */
export const authModule = {
  useAuth,
  AuthProvider: ({ children }: { children: ReactNode }) => <>{children}</>,
};

/** Drop-in for sonner's `toast`: callable, with the methods the app uses. */
export const toastSpy = Object.assign(vi.fn(), {
  success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn(), message: vi.fn(), dismiss: vi.fn(),
});

export function resetToasts() {
  toastSpy.mockReset();
  for (const k of ["success", "error", "info", "warning", "message", "dismiss"] as const) toastSpy[k].mockReset();
}

/** A deferred promise, for holding a request open while a test looks at the pending state. */
export function deferred<T = unknown>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}
