import { Outlet } from "react-router-dom";
import { Activity } from "lucide-react";

export function AuthLayout() {
  return (
    <div className="flex min-h-screen items-center justify-center bg-gradient-to-b from-background to-secondary/50 p-4">
      <div className="w-full max-w-md space-y-6">
        <div className="flex items-center justify-center gap-2 text-brand">
          <span className="flex h-9 w-9 items-center justify-center rounded-full bg-brand text-brand-foreground">
            <Activity className="h-5 w-5" />
          </span>
          <span className="text-2xl font-bold tracking-tight">ClinicOS</span>
        </div>
        <Outlet />
      </div>
    </div>
  );
}
