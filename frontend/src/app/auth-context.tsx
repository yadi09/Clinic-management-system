import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { tokenStore } from "@/lib/token";
import { SESSION_END_KEY, setSessionEndedHandler, trySilentRefresh } from "@/lib/api-client";
import { logoutApi, meApi, switchBranchApi, type BranchRef, type UserDTO } from "@/features/auth/api";
import { can as canPerm, hasRole as hasRoleFn, isFlagOn } from "@/lib/rbac";

type Status = "loading" | "authenticated" | "unauthenticated";

interface AuthState {
  status: Status;
  user: UserDTO | null;
  permissions: string[];
  flags: Record<string, boolean>;
  branches: BranchRef[];
  activeBranchId: string | null;
  activeBranch: BranchRef | null;
  allBranches: boolean;
  can: (permission: string) => boolean;
  hasRole: (role: string) => boolean;
  flagOn: (flag: string) => boolean;
  signIn: (accessToken: string, user: UserDTO) => Promise<void>;
  signOut: () => Promise<void>;
  refresh: () => Promise<void>;
  switchBranch: (branchId: string) => Promise<void>;
}

const AuthContext = createContext<AuthState | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<Status>("loading");
  const [user, setUser] = useState<UserDTO | null>(null);
  const [permissions, setPermissions] = useState<string[]>([]);
  const [flags, setFlags] = useState<Record<string, boolean>>({});
  const [branches, setBranches] = useState<BranchRef[]>([]);
  const [activeBranchId, setActiveBranchId] = useState<string | null>(null);
  const [allBranches, setAllBranches] = useState(false);

  const loadMe = async () => {
    const me = await meApi();
    setUser(me.user);
    setPermissions(me.permissions ?? []);
    setFlags(me.flags ?? {});
    setBranches(me.branches ?? []);
    setActiveBranchId(me.active_branch_id ?? null);
    setAllBranches(me.all_branches ?? false);
    setStatus("authenticated");
  };

  // Switch the session to a different branch ("all" = consolidated view). The
  // server re-issues an access token scoped to that branch; then we reload /me
  // so permissions, flags, and the active branch reflect the new scope.
  const switchBranch = async (branchId: string) => {
    const res = await switchBranchApi(branchId);
    tokenStore.set(res.access_token);
    await loadMe();
  };

  // A session the server ended mid-use signs the app out; the sign-in page reads
  // the reason and says it (SEC-2, SEC-10).
  useEffect(() => {
    setSessionEndedHandler((why) => {
      tokenStore.clear();
      setUser(null);
      setPermissions([]);
      setFlags({});
      setBranches([]);
      setActiveBranchId(null);
      setAllBranches(false);
      setStatus("unauthenticated");
      try {
        sessionStorage.setItem(SESSION_END_KEY, why);
      } catch {
        /* the message is a courtesy; signing out is what matters */
      }
    });
    return () => setSessionEndedHandler(null);
  }, []);

  // On boot, restore the session from the refresh cookie.
  useEffect(() => {
    let active = true;
    (async () => {
      const ok = await trySilentRefresh();
      if (!active) return;
      if (!ok) {
        setStatus("unauthenticated");
        return;
      }
      try {
        await loadMe();
      } catch {
        if (active) setStatus("unauthenticated");
      }
    })();
    return () => {
      active = false;
    };
  }, []);

  // Re-check entitlements when the user returns to the tab, so a super-admin
  // module change (e.g. disabling Laboratory) propagates to an open session
  // without a manual reload.
  useEffect(() => {
    const refresh = () => {
      if (document.visibilityState === "visible" && tokenStore.get()) loadMe().catch(() => {});
    };
    window.addEventListener("focus", refresh);
    document.addEventListener("visibilitychange", refresh);
    return () => {
      window.removeEventListener("focus", refresh);
      document.removeEventListener("visibilitychange", refresh);
    };
  }, []);

  const signIn = async (accessToken: string, u: UserDTO) => {
    tokenStore.set(accessToken);
    setUser(u);
    setStatus("authenticated");
    try {
      await loadMe(); // populate permissions + flags
    } catch {
      /* user is set; perms load lazily next request */
    }
  };

  const signOut = async () => {
    try {
      await logoutApi();
    } finally {
      tokenStore.clear();
      setUser(null);
      setPermissions([]);
      setFlags({});
      setBranches([]);
      setActiveBranchId(null);
      setAllBranches(false);
      setStatus("unauthenticated");
    }
  };

  const value: AuthState = {
    status,
    user,
    permissions,
    flags,
    branches,
    activeBranchId,
    activeBranch: branches.find((b) => b.id === activeBranchId) ?? null,
    allBranches,
    can: (p) => canPerm(permissions, p),
    hasRole: (r) => hasRoleFn(user?.roles, r),
    flagOn: (f) => isFlagOn(flags, f),
    signIn,
    signOut,
    refresh: loadMe,
    switchBranch,
  };
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthState {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used within AuthProvider");
  return ctx;
}
