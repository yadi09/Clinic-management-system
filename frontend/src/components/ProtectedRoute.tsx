import { Navigate, Outlet, useLocation } from "react-router-dom";
import { useAuth } from "@/app/auth-context";

/**
 * Authentication guard. Role/scope and feature-flag guards (RequireRole /
 * RequireFlag) compose on top of this from Phase 1 onward (Part 2 §6.7).
 */
export function ProtectedRoute() {
  const { status } = useAuth();
  const location = useLocation();

  if (status === "loading") {
    return (
      <div className="flex min-h-screen items-center justify-center text-muted-foreground">Loading…</div>
    );
  }
  if (status === "unauthenticated") {
    return <Navigate to="/login" replace state={{ from: location }} />;
  }
  return <Outlet />;
}
