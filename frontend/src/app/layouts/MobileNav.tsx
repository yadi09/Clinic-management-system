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

export function MobileNav({ sections }: { sections: NavSection[] }) {
  const [menuOpen, setMenuOpen] = useState(false);
  const { pathname } = useLocation();

  const items = sections.flatMap((s) => s.items);
  const tabs = TAB_PRIORITY
    .map((to) => items.find((i) => i.to === to))
    .filter((i): i is NonNullable<typeof i> => !!i)
    .slice(0, 4);

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
        <div className="grid h-16 grid-cols-5">
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
                  <t.icon className={cn("h-5 w-5", isActive && "stroke-[2.25]")} />
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
            <Menu className={cn("h-5 w-5", !onTab && "stroke-[2.25]")} />
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
            {sections.map((section, i) => (
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
