// One menu definition, filtered one way, read by the sidebar, the phone tab bar and
// the command palette. A dental clinic must see its chair and not a triage desk; an
// owner sees what they could buy, reception never sees a dead link.
import { describe, expect, test } from "vitest";

import { navSections, visibleNav } from "@/app/nav";
import { OWNER_PERMS } from "@/test/admin";

const paths = (perms: string[], flags: string[]) =>
  visibleNav(navSections, (p) => perms.includes(p), (f) => flags.includes(f)).flatMap((s) => s.items.map((i) => i.to));

const ALL_PERMS = [...new Set(navSections.flatMap((s) => s.items.flatMap((i) => i.perm ?? [])).concat(OWNER_PERMS))];

describe("REG-FE-NAV menu filtering", () => {
  test("REG-FE-NAV-001 a dental owner: chair and unbilled, no triage/queue/my day, no ministry report", () => {
    const p = paths(OWNER_PERMS, ["dental", "finance_advanced", "messaging"]);
    expect(p).toEqual(expect.arrayContaining(["/", "/patients", "/appointments", "/reception", "/chairside", "/dental/unbilled",
      "/cashier", "/finance", "/billing/services", "/messages", "/users", "/settings", "/help"]));
    for (const gone of ["/triage", "/queue", "/worklist", "/reporting/dhis2", "/lab/inbox", "/pharmacy/queue", "/inpatient/beds"]) {
      expect(p).not.toContain(gone);
    }
  });

  test("REG-FE-NAV-002 a general clinic never sees the dental-only pages", () => {
    const p = paths(ALL_PERMS, ["laboratory", "pharmacy"]);
    expect(p).not.toContain("/chairside");
    expect(p).not.toContain("/dental/unbilled");
    expect(p).toEqual(expect.arrayContaining(["/triage", "/queue", "/worklist", "/lab", "/pharmacy/queue"]));
  });

  test("REG-FE-NAV-003 not entitled: the owner keeps an upsell link, staff lose it", () => {
    const owner = paths(OWNER_PERMS, ["dental"]);
    expect(owner).toContain("/finance");
    expect(owner).toContain("/messages");
    const bookkeeper = paths(["billing.manage", "message.send"], ["dental"]);
    expect(bookkeeper).not.toContain("/finance");
    expect(bookkeeper).not.toContain("/messages");
    expect(bookkeeper).toContain("/billing/services");
  });

  test("REG-FE-NAV-004 permissions are any-of, and a section with nothing left disappears", () => {
    const sections = visibleNav(navSections, (p) => p === "payment.charge", (f) => f === "dental");
    expect(sections.flatMap((s) => s.items.map((i) => i.to))).toEqual(["/", "/dental/unbilled", "/help"]);
    expect(sections.map((s) => s.heading)).toEqual([undefined, "Clinical", undefined]);
  });

  test("REG-FE-NAV-005 every item names a route, and every module item says which flag gates it", () => {
    const items = navSections.flatMap((s) => s.items);
    expect(new Set(items.map((i) => i.to)).size).toBe(items.length);
    for (const i of items.filter((x) => x.to.startsWith("/pharmacy") || x.to.startsWith("/lab") || x.to.startsWith("/inpatient"))) {
      expect(i.module).toBeTruthy();
    }
  });
});
