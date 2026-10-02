// The home page. What it must get right: the numbers the server sent, links only
// for people who can open them, an all-clear only when there really is nothing, and
// a failed load shown as a failure (it once said "Nothing needs you" on an error).
import { screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, test, vi } from "vitest";

const auth = vi.hoisted(() => ({ perms: new Set<string>(), flags: new Set<string>() }));
vi.mock("@/app/auth-context", () => ({
  useAuth: () => ({
    can: (p: string) => auth.perms.has(p), flagOn: (f: string) => auth.flags.has(f),
    user: { id: "u1", full_name: "Hanna Desta" },
  }),
}));
const api = vi.hoisted(() => ({ dashboardToday: vi.fn(), dashboardTakings: vi.fn() }));
vi.mock("@/features/dashboard/api", async (orig) => ({ ...(await orig<object>()), ...api }));

import { DashboardPage } from "@/features/dashboard/pages/DashboardPage";
import { NeedsYou } from "@/features/dashboard/components/NeedsYou";
import { TodayFlow } from "@/features/dashboard/components/TodayFlow";
import { MoneyTiles } from "@/features/dashboard/components/MoneyTiles";
import { OwedCard, WeekAhead } from "@/features/dashboard/components/OwedAndWeek";
import { useDashLinks } from "@/features/dashboard/links";
import type { DashAlert, DashFlow, DashMoney, DashToday } from "@/features/dashboard/api";
import { renderUI } from "@/test/render";

const OWNER = ["patient.create", "patient.read", "payment.collect", "billing.manage", "appointment.manage",
  "queue.manage", "dental.manage", "payment.charge"];
const ALL_FLAGS = ["dental", "finance_advanced", "debt_ageing"];
const as = (perms: string[], flags: string[] = ALL_FLAGS) => { auth.perms = new Set(perms); auth.flags = new Set(flags); };

const alerts: DashAlert[] = [
  { kind: "unbilled", text: "3 treated visits not sent to the cashier", amount: "6000", count: 3, href: "/dental/unbilled", action: "Bill them", tone: "danger" },
  { kind: "long_wait", text: "Almaz Haile has waited 40 minutes", count: 1, href: "/chairside", action: "Open chairside", patient_id: "pat_a", tone: "warn" },
  { kind: "overdue", text: "2 patients owe for over 60 days", amount: "9000", count: 2, href: "/finance?tab=receivables", action: "See who", tone: "danger" },
  { kind: "no_show", text: "1 no-show today", count: 1, href: "/appointments?date=2026-10-02", action: "Rebook", tone: "warn" },
];
const flow: DashFlow = {
  booked: 8, walk_ins: 2, waiting: 3, in_chair: 1, done: 4, to_come: 2, late: 1, longest_wait: 40, avg_wait: 12,
  avg_visit: 75, first_arrival: "2026-10-02T05:42:00Z",
  upcoming: [{ patient_id: "pat_u", name: "Selam Bekele", what: "Root canal · visit 2", late_min: 75 }],
};
const money: DashMoney = {
  collected_today: "4300", collected_yesterday_by_now: "3000", collected_yesterday: "8000", last_7: "22000", prev_7: "20000",
  series: [{ date: "2026-09-30", amount: "1000", count: 1 }, { date: "2026-10-01", amount: "2000", count: 2 }],
  owed: "15000", owed_at_cashier: "5000", owed_unbilled: "10000", owed_patients: 4, oldest_days: 72,
  aging: [
    { key: "0-30", label: "", amount: "5000", count: 2 }, { key: "31-60", label: "", amount: "0", count: 0 },
    { key: "61-90", label: "", amount: "10000", count: 2 }, { key: "90+", label: "", amount: "0", count: 0 },
  ],
  top_owers: [{ patient_id: "pat_o", name: "Tesfaye Alemu", owed: "7000", oldest_days: 72, why: "root canal" }],
  booked_ahead: "18000", booked_visits: 6,
};
const today = (over: Partial<DashToday> = {}): DashToday => ({
  date: "2026-10-02", hour: 9, attention: alerts, flow, money, clinic_name: "Cure Dental", branch_name: "Bole",
  week: [{ date: "2026-10-03", visits: 3, amount: "6000" }, { date: "2026-10-04", visits: 0 }], patients: 1234, ...over,
});

/** Render a component with links built for the current user, as the page does. */
function WithLinks({ children }: { children: (l: ReturnType<typeof useDashLinks>) => React.ReactNode }) {
  return <>{children(useDashLinks())}</>;
}

describe("REG-FE-DASH dashboard", () => {
  beforeEach(() => {
    as(OWNER);
    api.dashboardToday.mockReset();
    api.dashboardTakings.mockReset();
    api.dashboardTakings.mockResolvedValue(null);
  });

  // --- NeedsYou ---------------------------------------------------------------

  test("REG-FE-DASH-001 Needs you: three at most, then 'N more' shows the rest", async () => {
    const { user } = renderUI(<WithLinks>{(l) => <NeedsYou items={alerts} links={l} canSeeMoney />}</WithLinks>);
    expect(screen.getByRole("heading", { name: "Needs you" })).toBeInTheDocument();
    expect(screen.queryByText("1 no-show today")).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "1 more" }));
    expect(screen.getByText("1 no-show today")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Show fewer" })).toBeInTheDocument();
    expect(screen.getByText("6,000 ETB")).toBeInTheDocument();
  });

  test("REG-FE-DASH-002 Needs you: each item's button opens its page, and a name opens the patient", () => {
    renderUI(<WithLinks>{(l) => <NeedsYou items={alerts.slice(0, 2)} links={l} canSeeMoney />}</WithLinks>);
    expect(screen.getByRole("link", { name: "Bill them" })).toHaveAttribute("href", "/dental/unbilled");
    expect(screen.getByRole("link", { name: "Open chairside" })).toHaveAttribute("href", "/chairside");
    expect(screen.getByRole("link", { name: "Almaz Haile" })).toHaveAttribute("href", "/patients/pat_a");
  });

  test("REG-FE-DASH-003 Needs you: no link for a page this person cannot open", () => {
    as(["patient.read"], ["dental"]); // a viewer: no finance, no appointments, no chair
    renderUI(<WithLinks>{(l) => <NeedsYou items={[alerts[2], alerts[3]]} links={l} canSeeMoney={false} />}</WithLinks>);
    expect(screen.getByText("2 patients owe for over 60 days")).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "See who" })).not.toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "Rebook" })).not.toBeInTheDocument();
  });

  test("REG-FE-DASH-004 Needs you: an empty list is an all-clear, worded for who is looking", () => {
    const { unmount } = renderUI(<WithLinks>{(l) => <NeedsYou items={[]} links={l} canSeeMoney />}</WithLinks>);
    expect(screen.getByText(/Nothing needs you right now. Every treated visit is billed/)).toBeInTheDocument();
    unmount();
    renderUI(<WithLinks>{(l) => <NeedsYou items={[]} links={l} canSeeMoney={false} />}</WithLinks>);
    expect(screen.getByText("Nothing needs you right now.")).toBeInTheDocument();
  });

  // --- TodayFlow ---------------------------------------------------------------

  test("REG-FE-DASH-005 Today: booked, waiting, in the chair, done, with their numbers", () => {
    renderUI(<WithLinks>{(l) => <TodayFlow f={flow} date="2026-10-02" links={l} />}</WithLinks>);
    // For the owner every stage opens its page, so each stage is one link.
    const stage = (label: string) => screen.getByRole("link", { name: new RegExp(`^${label}`) });
    expect(stage("Booked today")).toHaveTextContent("8");
    expect(stage("Booked today")).toHaveTextContent("plus 2 walk-ins");
    expect(stage("Waiting")).toHaveTextContent("longest 40 min");
    expect(stage("Done")).toHaveTextContent("2 still to come, 1 late");
    expect(screen.getByRole("img")).toHaveAccessibleName("4 done, 1 being seen, 3 waiting, 2 still to come");
    expect(screen.getByText("1 h 15 min")).toBeInTheDocument(); // average visit
    expect(screen.getByText("1 h late")).toBeInTheDocument();
  });

  test("REG-FE-DASH-006 Today: stages and names link only where permitted", () => {
    const { unmount } = renderUI(<WithLinks>{(l) => <TodayFlow f={flow} date="2026-10-02" links={l} />}</WithLinks>);
    expect(screen.getByRole("link", { name: /Booked today/ })).toHaveAttribute("href", "/appointments?date=2026-10-02");
    expect(screen.getByRole("link", { name: /In the chair/ })).toHaveAttribute("href", "/chairside");
    expect(screen.getByRole("link", { name: /Selam Bekele/ })).toHaveAttribute("href", "/patients/pat_u");
    expect(screen.getByRole("link", { name: /Open chairside/ })).toBeInTheDocument();
    unmount();
    as([], ["dental"]);
    renderUI(<WithLinks>{(l) => <TodayFlow f={flow} date="2026-10-02" links={l} />}</WithLinks>);
    expect(screen.queryAllByRole("link")).toHaveLength(0);
    expect(screen.getByText("Selam Bekele")).toBeInTheDocument();
  });

  test("REG-FE-DASH-007 Today: nobody left to come says so", () => {
    renderUI(<WithLinks>{(l) => <TodayFlow f={{ ...flow, to_come: 0, upcoming: [], waiting: 0, late: 0 }} date="2026-10-02" links={l} />}</WithLinks>);
    expect(screen.getByText("everyone is here")).toBeInTheDocument();
    expect(screen.getByText("Nobody else is booked for today.")).toBeInTheDocument();
    expect(screen.getByText("nobody waiting")).toBeInTheDocument();
  });

  // --- MoneyTiles ---------------------------------------------------------------

  test("REG-FE-DASH-008 Money: today against yesterday by now, the week, what is owed, booked ahead", () => {
    renderUI(<WithLinks>{(l) => <MoneyTiles m={money} links={l} />}</WithLinks>);
    const tile = (label: string) => screen.getByText(label).closest("a,div")!;
    expect(tile("Collected today")).toHaveTextContent("4,300");
    expect(tile("Collected today")).toHaveTextContent("↑ 1,300 ETB more than yesterday by now");
    expect(tile("Last 7 days")).toHaveTextContent("↑ 10% on the week before");
    expect(tile("Owed to you")).toHaveTextContent("4 patients · oldest 72 days");
    expect(tile("Owed to you")).toHaveTextContent("5,000 at the cashier");
    expect(tile("Owed to you")).toHaveTextContent("10,000 not sent");
    expect(tile("Booked ahead")).toHaveTextContent("6 treatment visits still to come");
  });

  test("REG-FE-DASH-009 Money: tiles open finance for an owner, and are plain for someone without finance", () => {
    const { unmount } = renderUI(<WithLinks>{(l) => <MoneyTiles m={money} links={l} />}</WithLinks>);
    expect(screen.getByRole("link", { name: /Collected today/ })).toHaveAttribute("href", "/finance?period=today");
    expect(screen.getByRole("link", { name: /Owed to you/ })).toHaveAttribute("href", "/finance?tab=receivables");
    unmount();
    as(["payment.collect"], ["dental"]); // a cashier
    renderUI(<WithLinks>{(l) => <MoneyTiles m={money} links={l} />}</WithLinks>);
    expect(screen.getByRole("link", { name: /Collected today/ })).toHaveAttribute("href", "/cashier");
    expect(screen.queryByRole("link", { name: /Owed to you/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("link", { name: /Open finance/ })).not.toBeInTheDocument();
  });

  test("REG-FE-DASH-010 Money: a quiet morning reads as nothing yet, not as a drop", () => {
    renderUI(<WithLinks>{(l) => <MoneyTiles m={{ ...money, collected_today: "0", collected_yesterday_by_now: "0", owed: "0", prev_7: "0", booked_visits: 0 }} links={l} />}</WithLinks>);
    expect(screen.getByText("Nothing collected yet today")).toBeInTheDocument();
    expect(screen.getByText("Nothing to compare with yet")).toBeInTheDocument();
    expect(screen.getByText("Nobody owes you")).toBeInTheDocument();
    expect(screen.getByText("No visits booked ahead")).toBeInTheDocument();
  });

  // --- OwedCard / WeekAhead -------------------------------------------------------

  test("REG-FE-DASH-011 Who owes you: buckets with counts, owers open the patient's money", () => {
    renderUI(<WithLinks>{(l) => <OwedCard aging={money.aging} owers={money.top_owers} links={l} />}</WithLinks>);
    expect(screen.getByRole("link", { name: /Under 30 days/ })).toHaveAttribute("href", "/finance?tab=receivables&bucket=0-30");
    // An empty bucket is not a link to nothing.
    expect(screen.queryByRole("link", { name: /30 to 60/ })).not.toBeInTheDocument();
    expect(screen.getByRole("link", { name: /Tesfaye Alemu/ })).toHaveAttribute("href", "/patients/pat_o?panel=money");
    expect(screen.getByText("72 days")).toBeInTheDocument();
  });

  test("REG-FE-DASH-012 Who owes you: nothing owed says so", () => {
    renderUI(<WithLinks>{(l) => <OwedCard aging={money.aging.map((b) => ({ ...b, amount: "0", count: 0 }))} owers={[]} links={l} />}</WithLinks>);
    expect(screen.getByText("Nobody owes you anything.")).toBeInTheDocument();
  });

  test("REG-FE-DASH-013 The week ahead: visits per day, the total, money only when allowed", () => {
    const week = [{ date: "2026-10-03", visits: 3, amount: "6000" }, { date: "2026-10-05", visits: 2, amount: "3000" }];
    const { unmount } = renderUI(<WithLinks>{(l) => <WeekAhead week={week} links={l} showMoney />}</WithLinks>);
    expect(screen.getByText(/booked in the next 7 days/)).toHaveTextContent("5 visits booked in the next 7 days");
    expect(screen.getByText(/Worth about/)).toHaveTextContent("9,000 ETB");
    expect(screen.getAllByRole("link").map((a) => a.getAttribute("href"))).toContain("/appointments?date=2026-10-05");
    unmount();
    as([]);
    renderUI(<WithLinks>{(l) => <WeekAhead week={week} links={l} showMoney={false} />}</WithLinks>);
    expect(screen.queryByText(/Worth about/)).not.toBeInTheDocument();
    expect(screen.queryAllByRole("link")).toHaveLength(0);
  });

  // --- the page --------------------------------------------------------------------

  test("REG-FE-DASH-014 the page: greeting, clinic and branch, every section, the patient count", async () => {
    api.dashboardToday.mockResolvedValue(today());
    renderUI(<DashboardPage />);
    expect(await screen.findByRole("heading", { name: "Good morning, Hanna" })).toBeInTheDocument();
    expect(screen.getByText(/Cure Dental/)).toHaveTextContent("Cure Dental, Bole");
    expect(screen.getByRole("heading", { name: "Needs you" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Today in the clinic" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Money" })).toBeInTheDocument();
    expect(screen.getByText("Who owes you, by how long")).toBeInTheDocument();
    expect(screen.getByText("The week ahead")).toBeInTheDocument();
    expect(screen.getByText(/1,234 patients registered · numbers for Bole/)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /Register a patient/ })).toHaveAttribute("href", "/reception");
    expect(screen.getByRole("link", { name: /Take a payment/ })).toHaveAttribute("href", "/cashier");
  });

  test("REG-FE-DASH-015 the page: a failed load is an error with Retry, never an all-clear", async () => {
    api.dashboardToday.mockRejectedValue(new Error("down"));
    const { user } = renderUI(<DashboardPage />);
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("Could not load the dashboard");
    expect(screen.queryByText(/Nothing needs you/)).not.toBeInTheDocument();
    api.dashboardToday.mockResolvedValue(today({ attention: [] }));
    await user.click(within(alert).getByRole("button", { name: /Retry/ }));
    expect(await screen.findByText(/Nothing needs you right now/)).toBeInTheDocument();
  });

  test("REG-FE-DASH-016 the page: sections the server leaves out are not drawn", async () => {
    as(["queue.manage", "patient.read"], ["dental"]); // a receptionist
    api.dashboardToday.mockResolvedValue(today({ money: undefined, week: undefined, attention: [] }));
    renderUI(<DashboardPage />);
    expect(await screen.findByRole("heading", { name: "Today in the clinic" })).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Money" })).not.toBeInTheDocument();
    expect(screen.getByText("Nothing needs you right now.")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /Find a patient/ })).toHaveAttribute("href", "/patients");
    expect(screen.queryByRole("link", { name: /Take a payment/ })).not.toBeInTheDocument();
    await waitFor(() => expect(api.dashboardTakings).not.toHaveBeenCalled());
  });

  test("REG-FE-DASH-017 the page: while loading, a busy placeholder rather than zeros", () => {
    api.dashboardToday.mockReturnValue(new Promise(() => {}));
    renderUI(<DashboardPage />);
    expect(screen.getByLabelText("Loading the dashboard")).toHaveAttribute("aria-busy", "true");
    expect(screen.queryByText(/Nothing needs you/)).not.toBeInTheDocument();
  });
});
