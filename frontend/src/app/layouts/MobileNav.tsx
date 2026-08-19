// Phone navigation: a bottom tab bar and a Menu sheet.
//
// Below md the sidebar is hidden, and until this existed nothing replaced it — on
// a phone the app had no navigation at all. Confirmed on the live product: every
// route at 360/390px rendered zero nav affordances, so whatever page you landed on
// was the page you stayed on.
//
// The shape is a tab bar because clinic staff on a phone are switching between a
// handful of destinations dozens of times a day — the thumb should reach them
// without a menu round-trip. Four slots are earned by priority, the fifth is the
// full menu. Priority is a curated order filtered through exactly the same
// permission/module/clinic-type rules as the sidebar, so a cashier's four tabs are
// not a dentist's four tabs, and nobody is shown a door they cannot open.
import { useState } from "react";
import { NavLink, useLocation } from "react-router-dom";
import { Menu } from "lucide-react";

import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { cn } from "@/lib/utils";
import type { NavSection } from "@/app/nav";

/** The order in which destinations deserve a tab, most-used first. */
const TAB_PRIORITY = [
  "/",           // dashboard: the at-a-glance answer
  "/patients",   // everyone's most common jump
  "/chairside",  // the dentist's working surface (dental clinics only)
  "/appointments",
  "/reception",  // front desk (general clinics; hidden for pure dental desks without the perm)
  "/cashier",
  "/worklist",   // a doctor's day (general clinics)
  "/messages",
];

export function MobileNav({ sections, badgeCount }: {
  sections: NavSection[];
  /** Live alert count for a nav item's badge key (the sidebar's own numbers). */
  badgeCount?: (key?: string) => number;
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  const { pathname } = useLocation();

  const items = sections.flatMap((s) => s.items);
  const tabs = TAB_PRIORITY
    .map((to) => items.find((i) => i.to === to))
    .filter((i): i is NonNullable<typeof i> => !!i)
    .slice(0, 4);
  // The sheet exists for what the bar cannot hold. Repeating the four tab
  // destinations at the top pushed the ones ONLY reachable here (Cashier,
  // Finance, Messages, Settings…) below the fold of a 20-item list.
  const tabSet = new Set(tabs.map((t) => t.to));
  const sheetSections = sections
    .map((s) => ({ ...s, items: s.items.filter((i) => !tabSet.has(i.to)) }))
    .filter((s) => s.items.length > 0);
  // Any live alert on a destination that did not earn a tab surfaces on Menu, so
  // a critical lab result is never invisible just because of tab arithmetic.
  const menuAlert = items.some((i) => !tabSet.has(i.to) && (badgeCount?.(i.badge) ?? 0) > 0);

  // Is the current page reachable from a tab? If not, Menu shows as the active
  // slot, so the bar never claims you are somewhere you are not.
  const onTab = tabs.some((t) => (t.to === "/" ? pathname === "/" : pathname.startsWith(t.to)));

  return (
    <>
      {/* Spacer so page content can scroll clear of the fixed bar. */}
      <nav
        aria-label="Primary"
        className="fixed inset-x-0 bottom-0 z-40 border-t bg-card pb-safe md:hidden"
      >
        {/* Column count follows the earned tabs — a role with two visible
            destinations gets three wide comfortable slots, not five slivers. */}
        <div className="grid h-16" style={{ gridTemplateColumns: `repeat(${tabs.length + 1}, minmax(0, 1fr))` }}>
          {tabs.map((t) => (
            <NavLink
              key={t.to}
              to={t.to}
              end={t.to === "/"}
              className={({ isActive }) =>
                cn(
                  "flex flex-col items-center justify-center gap-0.5 text-[11px] font-medium",
                  isActive ? "text-brand" : "text-muted-foreground",
                )
              }
            >
              {({ isActive }) => (
                <>
                  <span className="relative">
                    <t.icon className={cn("h-5 w-5", isActive && "stroke-[2.25]")} />
                    {(badgeCount?.(t.badge) ?? 0) > 0 && (
                      <span className="absolute -right-2 -top-1 inline-flex h-4 min-w-4 items-center justify-center rounded-full bg-rose-600 px-1 text-[10px] font-semibold text-white">
                        {badgeCount!(t.badge)}
                      </span>
                    )}
                  </span>
                  <span>{t.label === "Patient messages" ? "Messages" : t.label}</span>
                </>
              )}
            </NavLink>
          ))}
          <button
            type="button"
            onClick={() => setMenuOpen(true)}
            aria-label="All destinations"
            className={cn(
              "flex flex-col items-center justify-center gap-0.5 text-[11px] font-medium",
              !onTab ? "text-brand" : "text-muted-foreground",
            )}
          >
            <span className="relative">
              <Menu className={cn("h-5 w-5", !onTab && "stroke-[2.25]")} />
              {menuAlert && (
                <span className="absolute -right-1.5 -top-0.5 h-2 w-2 rounded-full bg-rose-600" />
              )}
            </span>
            <span>Menu</span>
          </button>
        </div>
      </nav>

      {/* The full map, as a sheet. Reuses the sidebar's own filtered sections so
          the two navigations can never disagree about what exists. */}
      <Dialog open={menuOpen} onOpenChange={setMenuOpen}>
        <DialogContent className="gap-3">
          <DialogTitle className="text-base">Go to</DialogTitle>
          <div className="space-y-4">
            {sheetSections.map((section, i) => (
              <div key={i}>
                {section.heading && (
                  <p className="px-1 pb-1.5 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                    {section.heading}
                  </p>
                )}
                <div className="grid grid-cols-2 gap-1.5">
                  {section.items.map((item) => (
                    <NavLink
                      key={item.to}
                      to={item.to}
                      end={item.to === "/"}
                      onClick={() => setMenuOpen(false)}
                      className={({ isActive }) =>
                        cn(
                          "flex min-h-11 items-center gap-2.5 rounded-md px-3 py-2 text-sm font-medium",
                          isActive ? "bg-brand/10 text-brand" : "text-foreground hover:bg-muted",
                        )
                      }
                    >
                      <item.icon className="h-4 w-4 shrink-0 text-muted-foreground" />
                      <span className="min-w-0 truncate">{item.label}</span>
                      {(badgeCount?.(item.badge) ?? 0) > 0 && (
                        <span className="ml-auto inline-flex h-5 min-w-5 items-center justify-center rounded-full bg-rose-600 px-1.5 text-xs font-semibold text-white">
                          {badgeCount!(item.badge)}
                        </span>
                      )}
                    </NavLink>
                  ))}
                </div>
              </div>
            ))}
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}
