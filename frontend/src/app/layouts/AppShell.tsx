import { NavLink, Outlet, useNavigate } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Activity, Search, LogOut, ChevronsUpDown, Building2, Check } from "lucide-react";

import { useAuth } from "@/app/auth-context";
import { navSections, visibleNav } from "@/app/nav";
import { inboxCount } from "@/features/lab/api";
import { PageHelp } from "@/features/help/PageHelp";
import { NotificationBell } from "@/features/notifications/NotificationBell";
import { SignInNotifications } from "@/features/notifications/SignInNotifications";
import { LiveAlerts } from "@/features/notifications/LiveAlerts";
import { CommandPalette } from "@/app/command-palette";
import { MobileNav } from "@/app/layouts/MobileNav";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { toast } from "@/components/ui/sonner";
import { cn } from "@/lib/utils";

function initials(name?: string) {
  if (!name) return "?";
  return name.split(" ").map((p) => p[0]).slice(0, 2).join("").toUpperCase();
}

export function AppShell() {
  const { user, signOut, can, flagOn, branches, activeBranch, allBranches, switchBranch } = useAuth();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const primaryRole = user?.roles?.[0]?.replace(/_/g, " ") ?? "staff";

  // The branch switcher only appears once a clinic has more than one branch, so
  // single-location clinics see no extra chrome. "All branches" is a consolidated
  // view offered to clinic-wide (tenant-scoped) users.
  const showSwitcher = branches.length > 1;
  const branchLabel = allBranches && !activeBranch ? "All branches" : activeBranch?.name ?? "Main Branch";
  const doSwitch = async (id: string) => {
    try {
      await switchBranch(id);
      await qc.invalidateQueries();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not switch branch");
    }
  };

  const sections = visibleNav(navSections, can, flagOn);

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
        <div className="flex items-center gap-2 px-4 md:w-60 md:px-5">
          <span className="flex h-8 w-8 items-center justify-center rounded-full bg-white/15">
            <Activity className="h-5 w-5" />
          </span>
          <span className="text-base font-bold tracking-tight sm:text-lg">ClinicOS</span>
        </div>
        <div className="flex min-w-0 flex-1 items-center gap-1.5 px-2 sm:gap-3 sm:px-5">
          {showSwitcher ? (
            <DropdownMenu>
              <DropdownMenuTrigger className="hidden items-center gap-2 rounded-md bg-white/10 px-3 py-1.5 text-sm font-medium hover:bg-white/15 focus:outline-none md:flex">
                <Building2 className="h-4 w-4" />
                <span>{branchLabel}</span>
                <ChevronsUpDown className="h-3.5 w-3.5 opacity-70" />
              </DropdownMenuTrigger>
              <DropdownMenuContent align="start" className="w-60">
                <DropdownMenuLabel>Switch branch</DropdownMenuLabel>
                <DropdownMenuSeparator />
                {branches.map((b) => (
                  <DropdownMenuItem key={b.id} onSelect={() => void doSwitch(b.id)}>
                    <span className="flex-1 truncate">{b.name}</span>
                    {activeBranch?.id === b.id && <Check className="h-4 w-4" />}
                  </DropdownMenuItem>
                ))}
                {allBranches && (
                  <>
                    <DropdownMenuSeparator />
                    <DropdownMenuItem onSelect={() => void doSwitch("all")}>
                      <span className="flex-1">All branches</span>
                      {!activeBranch && <Check className="h-4 w-4" />}
                    </DropdownMenuItem>
                  </>
                )}
              </DropdownMenuContent>
            </DropdownMenu>
          ) : (
            <span className="hidden rounded-md bg-white/10 px-3 py-1.5 text-sm font-medium capitalize md:inline">
              {branchLabel} · {primaryRole}
            </span>
          )}
          <div className="flex-1" />
          <button
            onClick={() => window.dispatchEvent(new CustomEvent("open-command"))}
            className="hidden h-9 w-72 items-center gap-2 rounded-md bg-white/10 px-3 text-sm text-brand-foreground/70 transition-colors hover:bg-white/15 sm:flex"
          >
            <Search className="h-4 w-4" />
            <span>Search…</span>
            <kbd className="ml-auto rounded bg-white/15 px-1.5 py-0.5 text-[10px] font-semibold">⌘K</kbd>
          </button>
          {/* The same palette, reachable by thumb. Without this, phones had no
              search anywhere — the box above is hidden below sm. */}
          <button
            onClick={() => window.dispatchEvent(new CustomEvent("open-command"))}
            aria-label="Search"
            className="rounded-md p-2 touch-hit hover:bg-white/10 sm:hidden"
          >
            <Search className="h-5 w-5" />
          </button>
          <PageHelp />
          <NotificationBell />
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
              {/* On phones the header switcher is hidden, so this menu is the one
                  place a multi-branch user can still change branch. */}
              {showSwitcher && (
                <div className="md:hidden">
                  <DropdownMenuLabel className="text-xs font-normal text-muted-foreground">
                    Branch · {branchLabel}
                  </DropdownMenuLabel>
                  {branches.map((b) => (
                    <DropdownMenuItem key={b.id} onSelect={() => void doSwitch(b.id)}>
                      <span className="flex-1 truncate">{b.name}</span>
                      {activeBranch?.id === b.id && <Check className="h-4 w-4" />}
                    </DropdownMenuItem>
                  ))}
                  {allBranches && (
                    <DropdownMenuItem onSelect={() => void doSwitch("all")}>
                      <span className="flex-1">All branches</span>
                      {!activeBranch && <Check className="h-4 w-4" />}
                    </DropdownMenuItem>
                  )}
                  <DropdownMenuSeparator />
                </div>
              )}
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
          <nav className="min-h-0 flex-1 space-y-6 overflow-y-auto pr-1 [scrollbar-width:thin]">
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

        <main className="min-w-0 flex-1 p-4 pb-24 sm:p-6 sm:pb-24 md:pb-6 lg:p-8 lg:pb-8">
          <Outlet />
        </main>
      </div>

      <MobileNav sections={sections} badgeCount={badgeCount} />
      <CommandPalette />
      <SignInNotifications />
      <LiveAlerts />
    </div>
  );
}
