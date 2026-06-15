import { NavLink, Outlet, useNavigate } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { Activity, Bell, Search, LogOut, ChevronsUpDown } from "lucide-react";

import { useAuth } from "@/app/auth-context";
import { navSections } from "@/app/nav";
import { inboxCount } from "@/features/lab/api";
import { CommandPalette } from "@/app/command-palette";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";

function initials(name?: string) {
  if (!name) return "?";
  return name.split(" ").map((p) => p[0]).slice(0, 2).join("").toUpperCase();
}

export function AppShell() {
  const { user, signOut, can } = useAuth();
  const navigate = useNavigate();
  const primaryRole = user?.roles?.[0]?.replace(/_/g, " ") ?? "staff";

  const sections = navSections
    .map((s) => ({ ...s, items: s.items.filter((i) => !i.perm || i.perm.some((p) => can(p))) }))
    .filter((s) => s.items.length > 0);

  // Live alert badge for the doctor's results inbox (unacknowledged criticals).
  const labInbox = useQuery({
    queryKey: ["lab-inbox-count"],
    queryFn: inboxCount,
    enabled: can("lab.order"),
    refetchInterval: 30000,
  });
  const badgeCount = (key?: string) => (key === "labInbox" ? labInbox.data?.count ?? 0 : 0);

  return (
    <div className="min-h-screen bg-background">
      {/* Top bar (brand-blue, full width) */}
      <header className="sticky top-0 z-40 flex h-16 items-stretch bg-brand text-brand-foreground">
        <div className="flex w-60 items-center gap-2 px-5">
          <span className="flex h-8 w-8 items-center justify-center rounded-full bg-white/15">
            <Activity className="h-5 w-5" />
          </span>
          <span className="text-lg font-bold tracking-tight">ClinicOS</span>
        </div>
        <div className="flex flex-1 items-center gap-3 px-5">
          <span className="hidden rounded-md bg-white/10 px-3 py-1.5 text-sm font-medium capitalize md:inline">
            Main Branch · {primaryRole}
          </span>
          <div className="flex-1" />
          <button
            onClick={() => window.dispatchEvent(new CustomEvent("open-command"))}
            className="hidden h-9 w-72 items-center gap-2 rounded-md bg-white/10 px-3 text-sm text-brand-foreground/70 transition-colors hover:bg-white/15 sm:flex"
          >
            <Search className="h-4 w-4" />
            <span>Search…</span>
            <kbd className="ml-auto rounded bg-white/15 px-1.5 py-0.5 text-[10px] font-semibold">⌘K</kbd>
          </button>
          <button className="relative rounded-md p-2 hover:bg-white/10" aria-label="Notifications">
            <Bell className="h-5 w-5" />
          </button>
          <DropdownMenu>
            <DropdownMenuTrigger className="flex items-center gap-2 rounded-md p-1 hover:bg-white/10 focus:outline-none">
              <Avatar className="h-8 w-8">
                <AvatarFallback>{initials(user?.full_name)}</AvatarFallback>
              </Avatar>
              <ChevronsUpDown className="hidden h-4 w-4 opacity-70 md:block" />
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-56">
              <DropdownMenuLabel>
                <div className="flex flex-col">
                  <span className="truncate font-semibold">{user?.full_name}</span>
                  <span className="truncate text-xs font-normal text-muted-foreground">{user?.email}</span>
                </div>
              </DropdownMenuLabel>
              <DropdownMenuSeparator />
              <DropdownMenuItem onSelect={() => navigate("/settings")}>Settings</DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem className="text-destructive focus:text-destructive" onSelect={() => void signOut()}>
                <LogOut className="h-4 w-4" /> Sign out
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </header>

      <div className="flex">
        {/* Left nav rail (brand-blue) */}
        <aside className="sticky top-16 hidden h-[calc(100vh-4rem)] w-60 shrink-0 flex-col bg-brand px-3 py-4 text-brand-foreground md:flex">
          <nav className="min-h-0 flex-1 space-y-6 overflow-y-auto pr-1">
            {sections.map((section, i) => (
              <div key={i}>
                {section.heading && (
                  <p className="px-3 pb-2 text-label uppercase text-brand-foreground/50">{section.heading}</p>
                )}
                <div className="space-y-1">
                  {section.items.map((item) => (
                    <NavLink
                      key={item.to}
                      to={item.to}
                      end={item.to === "/"}
                      className={({ isActive }) =>
                        cn(
                          "flex items-center gap-3 rounded-md px-3 py-2 text-sm font-medium transition-colors",
                          isActive
                            ? "bg-primary text-primary-foreground"
                            : "text-brand-foreground/75 hover:bg-white/10 hover:text-brand-foreground",
                        )
                      }
                    >
                      <item.icon className="h-4 w-4" />
                      <span className="flex-1">{item.label}</span>
                      {badgeCount(item.badge) > 0 && (
                        <span className="ml-auto inline-flex h-5 min-w-5 items-center justify-center rounded-full bg-rose-600 px-1.5 text-xs font-semibold text-white">
                          {badgeCount(item.badge)}
                        </span>
                      )}
                    </NavLink>
                  ))}
                </div>
              </div>
            ))}
          </nav>
          <p className="px-3 text-xs text-brand-foreground/40">v3 · Tenant</p>
        </aside>

        <main className="min-w-0 flex-1 p-6 lg:p-8">
          <Outlet />
        </main>
      </div>

      <CommandPalette />
    </div>
  );
}
