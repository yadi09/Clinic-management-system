import { LayoutDashboard, Users, UserCog, Settings, CalendarDays, ListChecks, ClipboardCheck, Activity, Stethoscope, Pill, Boxes, BookOpen, ShoppingCart, Gauge, Tags, Truck, ClipboardList, BarChart3, type LucideIcon } from "lucide-react";

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
      { to: "/reception", label: "Reception", icon: ClipboardCheck, perm: ["payment.collect", "queue.manage"] },
      { to: "/triage", label: "Triage", icon: Activity, perm: ["triage.manage"] },
      { to: "/queue", label: "Queue", icon: ListChecks, perm: ["queue.manage"] },
      { to: "/worklist", label: "My worklist", icon: Stethoscope, perm: ["encounter.manage"] },
    ],
  },
  {
    heading: "Pharmacy",
    items: [
      { to: "/pharmacy/queue", label: "Dispense queue", icon: Pill, perm: ["pharmacy.read", "pharmacy.dispense"] },
      { to: "/pharmacy/otc", label: "OTC sale", icon: ShoppingCart, perm: ["pharmacy.sell"] },
      { to: "/pharmacy/catalog", label: "Drug catalog", icon: BookOpen, perm: ["pharmacy.read"] },
      { to: "/pharmacy/batches", label: "Batches & expiry", icon: Boxes, perm: ["pharmacy.read", "pharmacy.stock"] },
      { to: "/pharmacy/dashboard", label: "Pharmacy dashboard", icon: Gauge, perm: ["pharmacy.manage"] },
      { to: "/pharmacy/admin/catalog", label: "Catalog admin", icon: Tags, perm: ["pharmacy.manage"] },
      { to: "/pharmacy/purchasing", label: "Purchasing", icon: Truck, perm: ["pharmacy.manage"] },
      { to: "/pharmacy/stock-control", label: "Stock control", icon: ClipboardList, perm: ["pharmacy.stock"] },
      { to: "/pharmacy/reports", label: "Reports", icon: BarChart3, perm: ["pharmacy.manage"] },
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
