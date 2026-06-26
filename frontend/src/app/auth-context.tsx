import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { tokenStore } from "@/lib/token";
import { trySilentRefresh } from "@/lib/api-client";
import { logoutApi, meApi, type UserDTO } from "@/features/auth/api";
import { can as canPerm, hasRole as hasRoleFn, isFlagOn } from "@/lib/rbac";

type Status = "loading" | "authenticated" | "unauthenticated";

interface AuthState {
  status: Status;
  user: UserDTO | null;
  permissions: string[];
  flags: Record<string, boolean>;
  can: (permission: string) => boolean;
  hasRole: (role: string) => boolean;
  flagOn: (flag: string) => boolean;
  signIn: (accessToken: string, user: UserDTO) => Promise<void>;
  signOut: () => Promise<void>;
}

const AuthContext = createContext<AuthState | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<Status>("loading");
  const [user, setUser] = useState<UserDTO | null>(null);
  const [permissions, setPermissions] = useState<string[]>([]);
  const [flags, setFlags] = useState<Record<string, boolean>>({});

  const loadMe = async () => {
    const me = await meApi();
    setUser(me.user);
    setPermissions(me.permissions ?? []);
    setFlags(me.flags ?? {});
    setStatus("authenticated");
  };

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
      setStatus("unauthenticated");
    }
  };

  const value: AuthState = {
    status,
    user,
    permissions,
    flags,
    can: (p) => canPerm(permissions, p),
    hasRole: (r) => hasRoleFn(user?.roles, r),
    flagOn: (f) => isFlagOn(flags, f),
    signIn,
    signOut,
  };
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthState {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used within AuthProvider");
  return ctx;
}
