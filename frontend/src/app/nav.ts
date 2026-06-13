import { LayoutDashboard, Users, UserCog, Settings, CalendarDays, ListChecks, type LucideIcon } from "lucide-react";

export interface NavItem {
  to: string;
  label: string;
  icon: LucideIcon;
  /** any-of permissions required to see this item (omit = always) */
  perm?: string[];
}

export interface NavSection {
  heading?: string;
  items: NavItem[];
}

export const navSections: NavSection[] = [
  { items: [{ to: "/", label: "Dashboard", icon: LayoutDashboard }] },
  {
    heading: "Clinical",
    items: [
      { to: "/patients", label: "Patients", icon: Users, perm: ["patient.read", "patient.search"] },
      { to: "/appointments", label: "Appointments", icon: CalendarDays, perm: ["appointment.manage"] },
      { to: "/queue", label: "Queue", icon: ListChecks, perm: ["queue.manage"] },
    ],
  },
  {
    heading: "Administration",
    items: [
      { to: "/users", label: "Staff", icon: UserCog, perm: ["user.read"] },
      { to: "/settings", label: "Settings", icon: Settings, perm: ["clinic.manage"] },
    ],
  },
];
