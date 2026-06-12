import { NavLink, Outlet } from "react-router-dom";
import { LayoutDashboard, Users, UserCog, Settings } from "lucide-react";
import { useAuth } from "@/app/auth-context";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

interface NavItem {
  to: string;
  label: string;
  icon: typeof Users;
  show: boolean;
}

export function AppShell() {
  const { user, signOut, can } = useAuth();

  const nav: NavItem[] = [
    { to: "/", label: "Dashboard", icon: LayoutDashboard, show: true },
    { to: "/patients", label: "Patients", icon: Users, show: can("patient.read") || can("patient.search") },
    { to: "/users", label: "Staff", icon: UserCog, show: can("user.read") },
    { to: "/settings", label: "Settings", icon: Settings, show: can("clinic.manage") },
  ];

  return (
    <div className="flex min-h-screen">
      <aside className="hidden w-60 shrink-0 border-r bg-muted/20 p-4 md:block">
        <div className="mb-6 px-2 text-lg font-semibold">Clinic SaaS</div>
        <nav className="space-y-1">
          {nav
            .filter((n) => n.show)
            .map((n) => (
              <NavLink
                key={n.to}
                to={n.to}
                end={n.to === "/"}
                className={({ isActive }) =>
                  cn(
                    "flex items-center gap-3 rounded-md px-3 py-2 text-sm font-medium",
                    isActive ? "bg-primary/10 text-primary" : "text-muted-foreground hover:bg-accent hover:text-foreground",
                  )
                }
              >
                <n.icon className="h-4 w-4" />
                {n.label}
              </NavLink>
            ))}
        </nav>
      </aside>

      <div className="flex min-h-screen flex-1 flex-col">
        <header className="flex h-14 items-center justify-between border-b px-6">
          <span className="text-sm text-muted-foreground md:hidden">Clinic SaaS</span>
          <div className="ml-auto flex items-center gap-3">
            <span className="text-sm text-muted-foreground">{user?.email}</span>
            <Button variant="outline" size="sm" onClick={() => void signOut()}>
              Sign out
            </Button>
          </div>
        </header>
        <main className="flex-1 p-6">
          <Outlet />
        </main>
      </div>
    </div>
  );
}
