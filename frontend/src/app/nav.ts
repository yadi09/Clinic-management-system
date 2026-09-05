import { LayoutDashboard, Users, UserCog, Settings, Settings2, CalendarDays, ListChecks, ClipboardCheck, Activity, Stethoscope, Pill, Boxes, BookOpen, ShoppingCart, Gauge, Tags, Truck, ClipboardList, BarChart3, FlaskConical, TestTubes, Inbox, LifeBuoy, BadgeDollarSign, Wallet, ReceiptText, Landmark, BedDouble, Armchair, MessageSquare, type LucideIcon } from "lucide-react";

export interface NavItem {
  to: string;
  label: string;
  icon: LucideIcon;
  /** any-of permissions required to see this item (omit = always) */
  perm?: string[];
  /**
   * The feature flag that entitles the clinic to this item (omit = always on).
   *
   * The server guards these routes with RequireFlag, so an item whose module is
   * off does not render an empty page — it renders an error. Declaring the module
   * HERE rather than deriving it from the path in one consumer is the point: the
   * sidebar, the command palette and the help centre all read the same field, and
   * a new route cannot be entitled in one and dead in the others.
   */
  module?: string;
  /** A flag that HIDES this item — a way of working the clinic doesn't use. */
  hideWhen?: string;
  /**
   * Permission that keeps a NOT-entitled item visible, so its page can explain
   * what the feature is and which plan includes it.
   *
   * Reception should never see a link it cannot use — that is a dead end in the
   * middle of a shift. The owner is the person who would buy the thing, so for
   * them the link stays and the page makes the case. Nobody is shown a feature
   * they can neither use nor buy.
   */
  upsell?: string;
  /** live alert badge to render next to the item (count fetched in the shell) */
  badge?: "labInbox";
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
      { to: "/reception", label: "Reception", icon: ClipboardCheck, perm: ["queue.manage"] },
      { to: "/triage", label: "Triage", icon: Activity, perm: ["triage.manage"], hideWhen: "dental" },
      { to: "/queue", label: "Queue", icon: ListChecks, perm: ["queue.manage"], hideWhen: "dental" },
      { to: "/worklist", label: "My day", icon: Stethoscope, perm: ["encounter.manage"], hideWhen: "dental" },
      { to: "/chairside", label: "Chairside", icon: Armchair, perm: ["dental.manage"], module: "dental" },
      { to: "/dental/unbilled", label: "Unbilled treatment", icon: ReceiptText, perm: ["payment.charge", "payment.collect", "dental.manage"], module: "dental" },
      { to: "/lab/inbox", label: "Results inbox", icon: Inbox, perm: ["lab.order"], badge: "labInbox", module: "laboratory" },
    ],
  },
  {
    heading: "Inpatient",
    items: [
      { to: "/inpatient/beds", label: "Beds", icon: BedDouble, perm: ["bed.assign"], module: "inpatient" },
      { to: "/inpatient/config", label: "Bed setup", icon: Settings2, perm: ["bed.manage"], module: "inpatient" },
      { to: "/inpatient/reports", label: "Bed reports", icon: BarChart3, perm: ["bed.manage"], module: "inpatient" },
    ],
  },
  {
    heading: "Pharmacy",
    items: [
      { to: "/pharmacy/queue", label: "Dispense queue", icon: Pill, perm: ["pharmacy.read", "pharmacy.dispense"], module: "pharmacy" },
      { to: "/pharmacy/otc", label: "OTC sale", icon: ShoppingCart, perm: ["pharmacy.sell"], module: "pharmacy" },
      { to: "/pharmacy/catalog", label: "Drug catalog", icon: BookOpen, perm: ["pharmacy.read"], module: "pharmacy" },
      { to: "/pharmacy/batches", label: "Batches & expiry", icon: Boxes, perm: ["pharmacy.read", "pharmacy.stock"], module: "pharmacy" },
      { to: "/pharmacy/dashboard", label: "Pharmacy dashboard", icon: Gauge, perm: ["pharmacy.manage"], module: "pharmacy" },
      { to: "/pharmacy/admin/catalog", label: "Catalog admin", icon: Tags, perm: ["pharmacy.manage"], module: "pharmacy" },
      { to: "/pharmacy/purchasing", label: "Purchasing", icon: Truck, perm: ["pharmacy.manage"], module: "pharmacy" },
      { to: "/pharmacy/stock-control", label: "Stock control", icon: ClipboardList, perm: ["pharmacy.stock"], module: "pharmacy" },
      { to: "/pharmacy/reports", label: "Reports", icon: BarChart3, perm: ["pharmacy.manage"], module: "pharmacy" },
    ],
  },
  {
    heading: "Billing",
    items: [
      { to: "/cashier", label: "Cashier", icon: BadgeDollarSign, perm: ["payment.collect"] },
      { to: "/finance", label: "Finance", icon: Wallet, perm: ["billing.manage"], module: "finance_advanced", upsell: "clinic.manage" },
      { to: "/billing/services", label: "Service catalog", icon: ReceiptText, perm: ["billing.manage"] },
    ],
  },
  {
    heading: "Laboratory",
    items: [
      { to: "/lab", label: "Lab worklist", icon: FlaskConical, perm: ["lab.process", "lab.validate"], module: "laboratory" },
      { to: "/lab/catalog", label: "Test catalog", icon: TestTubes, perm: ["lab.manage"], module: "laboratory" },
    ],
  },
  {
    heading: "Reporting",
    items: [{ to: "/reporting/dhis2", label: "Ministry report", icon: Landmark, perm: ["clinic.manage"], module: "dhis2", upsell: "clinic.manage" }],
  },
  {
    heading: "Administration",
    items: [
      // Sits under Administration rather than Billing: it is how the clinic talks
      // to patients, and the person who decides that is the person who runs the
      // clinic — not whoever reconciles the till.
      { to: "/messages", label: "Patient messages", icon: MessageSquare, perm: ["message.send", "message.manage"], module: "messaging", upsell: "clinic.manage" },
      { to: "/users", label: "Staff", icon: UserCog, perm: ["user.read"] },
      { to: "/settings", label: "Settings", icon: Settings, perm: ["clinic.manage"] },
    ],
  },
  {
    items: [{ to: "/help", label: "Help center", icon: LifeBuoy }],
  },
];

/**
 * The menu this user, in this clinic, is actually entitled to.
 *
 * Previously only the sidebar filtered by module, and it did so from a path-prefix
 * map that had drifted: it knew "/chairside" was dental but not "/dental/unbilled",
 * so every general clinic showed a dental report that could only ever answer
 * "Could not load the report." The command palette and help centre filtered by
 * permission alone, so both offered the whole of Pharmacy and Laboratory to clinics
 * that had neither. One function, read by all three.
 */
export function visibleNav(
  sections: NavSection[],
  can: (perm: string) => boolean,
  flagOn: (flag: string) => boolean,
): NavSection[] {
  return sections
    .map((s) => ({
      ...s,
      items: s.items.filter((i) => {
        if (i.perm && !i.perm.some((p) => can(p))) return false;
        // Not entitled: gone, unless this is the person who could buy it.
        if (i.module && !flagOn(i.module) && !(i.upsell && can(i.upsell))) return false;
        return !(i.hideWhen && flagOn(i.hideWhen));
      }),
    }))
    .filter((s) => s.items.length > 0);
}
