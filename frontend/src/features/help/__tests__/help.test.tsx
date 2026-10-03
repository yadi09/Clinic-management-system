// Help: one content table keyed by route, read two ways — the "How this works"
// button in the top bar (PageHelp, matched to the current URL, :id segments
// included) and the Help Center at /help (only the pages this role, in this
// clinic, can open — the same filter as the sidebar — plus a glossary).
import { screen, within } from "@testing-library/react";
import { beforeEach, describe, expect, test, vi } from "vitest";

vi.mock("@/app/auth-context", async () => (await import("@/test/frontdesk")).authModule);

import { navSections } from "@/app/nav";
import { GLOSSARY, HELP, helpForPath, helpForRoute } from "@/features/help/content";
import { HelpCenterPage } from "@/features/help/HelpCenterPage";
import { PageHelp } from "@/features/help/PageHelp";
import { DESK_PERMS, DESK_USER, setAuth } from "@/test/frontdesk";
import { currentLocation, renderUI } from "@/test/render";

const OWNER_PERMS = [
  ...DESK_PERMS, "clinic.manage", "dental.manage", "triage.manage", "encounter.manage", "lab.order", "lab.process",
  "lab.manage", "pharmacy.read", "pharmacy.manage", "pharmacy.sell", "pharmacy.stock", "pharmacy.dispense", "bed.assign", "bed.manage",
];

beforeEach(() => setAuth());

describe("REG-FE-HELP the help content", () => {
  test("REG-FE-HELP-001 every entry has a title and a one-line purpose; optional parts are non-empty when present", () => {
    for (const [key, e] of Object.entries(HELP)) {
      expect(e.title, key).toBeTruthy();
      expect(e.purpose, key).toBeTruthy();
      for (const s of e.sections ?? []) expect(s.h && s.body, key).toBeTruthy();
      for (const c of e.columns ?? []) expect(c.name && c.desc, key).toBeTruthy();
      for (const t of e.tips ?? []) expect(t, key).toBeTruthy();
    }
    expect(GLOSSARY.length).toBeGreaterThan(0);
    for (const g of GLOSSARY) expect(g.term && g.def).toBeTruthy();
  });

  test("REG-FE-HELP-002 every key resolves: exact routes as-is, :id routes with any concrete id", () => {
    for (const [key, e] of Object.entries(HELP)) {
      const concrete = key.replace(/:[a-z]+/gi, "abc_123");
      expect(helpForPath(concrete), key).toBe(e);
      expect(helpForRoute(key), key).toBe(e);
    }
    // An exact key beats a pattern that would also match it.
    expect(helpForPath("/patients/new")?.title).toBe("Register patient");
    expect(helpForPath("/patients/pat_9")?.title).toBe("Patient profile");
    expect(helpForPath("/encounter/q_1")?.title).toBe("Consultation");
  });

  test("REG-FE-HELP-003 an unknown path or route has no help, and never throws", () => {
    for (const p of ["/nope", "/patients/pat_1/schedule", "/encounter", "", "/lab/items/1/extra"]) {
      expect(helpForPath(p), p).toBeUndefined();
    }
    expect(helpForRoute("/patients/pat_1")).toBeUndefined();
    expect(helpForRoute("/nope")).toBeUndefined();
  });

  test("REG-FE-HELP-004 every help key is a route in the sidebar or a page reached from one", () => {
    const navRoutes = new Set(navSections.flatMap((s) => s.items.map((i) => i.to)));
    const reachedFrom = ["/patients/new", "/patients/:id", "/encounter/:id", "/lab/items/:id"];
    for (const key of Object.keys(HELP)) expect(navRoutes.has(key) || reachedFrom.includes(key), key).toBe(true);
  });
});

describe("REG-FE-HELP the Help Center (/help)", () => {
  test("REG-FE-HELP-005 a dental receptionist: their pages only, under their headings, with the glossary", () => {
    renderUI(<HelpCenterPage />);
    expect(screen.getByRole("heading", { level: 1, name: "Help Center" })).toBeInTheDocument();
    expect(screen.getByText("receptionist")).toBeInTheDocument();
    const titles = screen.getAllByRole("heading", { level: 3 }).map((h) => h.textContent);
    expect(titles).toEqual(["Dashboard", "Patients", "Appointments", "Reception", "Cashier", "Service catalog", "Staff"]);
    const headings = screen.getAllByRole("heading", { level: 2 }).map((h) => h.textContent);
    expect(headings).toEqual(["Clinical", "Billing", "Administration", "Glossary"]);
    // Pages a dental clinic hides, or a desk cannot open, are not taught.
    expect(screen.queryByText("Triage")).not.toBeInTheDocument();
    expect(screen.queryByText("Dispense queue")).not.toBeInTheDocument();
    expect(screen.queryByText("Settings")).not.toBeInTheDocument();
    for (const g of GLOSSARY) expect(screen.getByText(g.term)).toBeInTheDocument();
  });

  test("REG-FE-HELP-006 an entry's sections, columns and tips are all shown", () => {
    setAuth({ perms: OWNER_PERMS, flags: ["pharmacy", "laboratory", "finance_advanced"] });
    renderUI(<HelpCenterPage />);
    const pharmacy = screen.getByRole("heading", { name: "Dispense queue" }).closest("div.space-y-3") as HTMLElement;
    expect(within(pharmacy).getByText("Prescription number (R-####).")).toBeInTheDocument();
    expect(within(pharmacy).getByText("The 4 cards at the top:")).toBeInTheDocument();
    const cashier = screen.getByRole("heading", { name: "Cashier" }).closest("div.space-y-3") as HTMLElement;
    expect(within(cashier).getAllByRole("listitem")).toHaveLength(HELP["/cashier"].tips!.length);
    // A general clinic is taught triage and the doctor's day.
    expect(screen.getByRole("heading", { name: "Triage" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "My day" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Finance" })).toBeInTheDocument();
  });

  test("REG-FE-HELP-007 no signed-in role: 'your role'; multi-word roles read with spaces", () => {
    setAuth({ user: null });
    const { unmount } = renderUI(<HelpCenterPage />);
    expect(screen.getByText("your role")).toBeInTheDocument();
    unmount();
    setAuth({ user: { ...DESK_USER, roles: ["clinic_owner"] } });
    renderUI(<HelpCenterPage />);
    expect(screen.getByText("clinic owner")).toBeInTheDocument();
  });

  // NEW-HELPUI-1: the page's own rule is "help for a module the clinic doesn't have
  // is worse than no help: it teaches a workflow the staff cannot follow". A dental
  // clinic has no triage (the sidebar hides it), yet its Help Center tells
  // reception to "route the patient to triage or straight to a doctor", says
  // check-in drops patients "into the queue for triage", and that settling a card
  // "sends the patient on to triage / the doctor".
  test.fails("REG-FE-HELP-008 a dental clinic's Help Center never sends anyone to triage (NEW-HELPUI-1)", () => {
    setAuth({ perms: OWNER_PERMS, flags: ["dental"] });
    const { container } = renderUI(<HelpCenterPage />);
    expect(container.textContent).not.toMatch(/triage/i);
  });
});

describe("REG-FE-HELP the 'How this works' button (PageHelp)", () => {
  test("REG-FE-HELP-009 a page with help: the button opens its title, purpose and sections", async () => {
    const { user } = renderUI(<PageHelp />, { route: "/patients/pat_1" });
    await user.click(screen.getByRole("button", { name: "How this page works" }));
    const d = screen.getByRole("dialog", { name: "Patient profile" });
    expect(within(d).getByText(HELP["/patients/:id"].purpose)).toBeInTheDocument();
    expect(within(d).getByText("Allergies & conditions")).toBeInTheDocument();
    expect(within(d).queryByText("What the columns mean")).not.toBeInTheDocument();
  });

  test("REG-FE-HELP-010 columns and tips are shown when the entry has them", async () => {
    const { user, unmount } = renderUI(<PageHelp />, { route: "/pharmacy/queue" });
    await user.click(screen.getByRole("button", { name: "How this page works" }));
    let d = screen.getByRole("dialog", { name: "Dispense queue" });
    expect(within(d).getByText("What the columns mean")).toBeInTheDocument();
    expect(within(d).getByText("RX")).toBeInTheDocument();
    unmount();
    const r = renderUI(<PageHelp />, { route: "/cashier" });
    await r.user.click(screen.getByRole("button", { name: "How this page works" }));
    d = screen.getByRole("dialog", { name: "Cashier" });
    expect(within(d).getAllByRole("listitem")).toHaveLength(HELP["/cashier"].tips!.length);
  });

  test("REG-FE-HELP-011 a page with no sections/columns/tips shows just the purpose", async () => {
    const { user } = renderUI(<PageHelp />, { route: "/" });
    await user.click(screen.getByRole("button", { name: "How this page works" }));
    const d = screen.getByRole("dialog", { name: "Dashboard" });
    expect(within(d).getByText(HELP["/"].purpose)).toBeInTheDocument();
    expect(within(d).queryByRole("listitem")).not.toBeInTheDocument();
  });

  test("REG-FE-HELP-012 'Open the Help Center' goes to /help and closes the panel", async () => {
    const { user } = renderUI(<PageHelp />, { route: "/appointments" });
    await user.click(screen.getByRole("button", { name: "How this page works" }));
    await user.click(screen.getByRole("link", { name: "Open the Help Center →" }));
    expect(currentLocation()).toBe("/help");
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  test("REG-FE-HELP-013 a page with no help (or an unknown URL) renders no button", () => {
    const { unmount } = renderUI(<PageHelp />, { route: "/nope/at/all" });
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
    unmount();
    renderUI(<PageHelp />, { route: "/help" });
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
  });

  // NEW-HELPUI-2: the Help Center promises "Every page also has a 'How this works'
  // button in the top bar", but there is no help entry for a dental clinic's own
  // pages — Chairside (where the dentist spends the day) and Unbilled treatment —
  // so the button is absent there and the Help Center lists neither.
  test.fails("REG-FE-HELP-014 a dental clinic's Chairside page has a 'How this works' button (NEW-HELPUI-2)", () => {
    renderUI(<PageHelp />, { route: "/chairside" });
    expect(screen.getByRole("button", { name: "How this page works" })).toBeInTheDocument();
  });
});
