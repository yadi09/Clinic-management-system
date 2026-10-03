// Finance: the owner's five questions, one shared period and branch filter that
// lives in the URL. "Today" is frozen (Saturday 2026-10-03) so every period's
// window is a known pair of days whatever the clock or zone the suite runs in.
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

// Whole-page flows with many clicks; the shared 5s budget is too tight when the full
// suite runs in parallel (and under scripts/test/time-sweep.sh).
vi.setConfig({ testTimeout: 60_000 });

vi.mock("@/app/auth-context", async () => (await import("@/test/admin")).authModule);
const admin = vi.hoisted(() => ({ listBranches: vi.fn() }));
vi.mock("@/features/admin/api", async (orig) => ({ ...(await orig<object>()), ...admin }));
const fin = vi.hoisted(() => ({
  financeOverview: vi.fn(), financeCash: vi.fn(), financeServices: vi.fn(), financeBook: vi.fn(), financeReceivables: vi.fn(),
}));
vi.mock("@/features/billing/api", async (orig) => ({ ...(await orig<object>()), ...fin }));

import { FinancePage } from "@/features/billing/pages/FinancePage";
import { RevenueChart } from "@/features/billing/pages/RevenueChart";
import type { FinCash, FinDayPoint, FinOverview, FinReceivables } from "@/features/billing/api";
import { setAuth } from "@/test/admin";
import { currentLocation, freezeToday, renderUI } from "@/test/render";

const days = (from: string, n: number, amt: (i: number) => number): FinDayPoint[] =>
  Array.from({ length: n }, (_, i) => {
    const d = new Date(`${from}T00:00:00`); d.setDate(d.getDate() + i);
    const iso = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
    return { date: iso, amount: String(amt(i)) };
  });

const OVERVIEW: FinOverview = {
  collected: "12000", collected_count: 9, collected_prev: "10000", refunded: "500", waived: "250",
  outstanding: "9000", outstanding_patients: 3, oldest_days: 72, booked_ahead: "18000", booked_visits: 6,
  series: days("2026-09-27", 7, (i) => (i === 3 ? 5000 : 1000)), series_prev: days("2026-09-20", 7, () => 800),
  by_source: [{ key: "dental", label: "Dental", amount: "11000", count: 8 }, { key: "card", label: "Card", amount: "1500", count: 1 }],
  attention: [{ kind: "unbilled", text: "2 treated visits not billed", amount: "3000", count: 2, href: "/dental/unbilled" },
    { kind: "drawer", text: "A drawer is open", count: 1, href: "/cashier" }],
};
const RECV: FinReceivables = {
  total: "9000", count: 3,
  buckets: [
    { key: "0-30", label: "0–30 days", amount: "3000", count: 1 }, { key: "31-60", label: "31–60 days", amount: "1000", count: 1 },
    { key: "61-90", label: "61–90 days", amount: "5000", count: 1 }, { key: "90+", label: "Over 90 days", amount: "0", count: 0 },
  ],
  rows: [
    { id: "pat_1", mrn: "CD-1", name: "Almaz Haile", phone: "0911000001", owed: "3000", oldest_days: 12, bucket: "0-30", last_paid: "2026-09-30", why: "crown" },
    { id: "pat_2", mrn: "CD-2", name: "Tesfaye Alemu", owed: "1000", oldest_days: 45, bucket: "31-60", why: "filling" },
    { id: "pat_3", mrn: "CD-3", name: "Selam Bekele", owed: "5000", oldest_days: 72, bucket: "61-90", why: "root canal" },
  ],
};
const CASH: FinCash = {
  shifts: [
    { date: "2026-10-02", cashier: "Meron", expected: "4000", counted: "3900", variance: "-100", note: "short" },
    { date: "2026-10-01", cashier: "Meron", expected: "2000", counted: "2050", variance: "50" },
    { date: "2026-09-30", cashier: "Abel", expected: "1000", counted: "1000", variance: "0" },
  ],
  by_method: [{ key: "cash", label: "cash", amount: "5000", count: 5 }, { key: "", label: "", amount: "200", count: 1 }],
  by_cashier: [{ key: "u1", label: "Meron", amount: "5200", count: 6 }], by_branch: [],
  open_drawers: [{ key: "u2", label: "Abel", amount: "700", count: 2 }], variance: "-50",
};

const page = (q = "") => renderUI(<FinancePage />, { route: `/finance${q}` });
const tab = (name: string) => screen.getByRole("tab", { name: new RegExp(`^${name}`) });
const lastRange = () => fin.financeOverview.mock.calls.at(-1)![0];

beforeEach(() => {
  freezeToday("2026-10-03", 10);
  setAuth({ flags: ["dental", "finance_advanced"] });
  admin.listBranches.mockResolvedValue([]);
  fin.financeOverview.mockResolvedValue(OVERVIEW);
  fin.financeReceivables.mockResolvedValue(RECV);
  fin.financeCash.mockResolvedValue(CASH);
  fin.financeServices.mockResolvedValue([]);
  fin.financeBook.mockResolvedValue({ total: "0", visits: 0, by_month: [], at_risk: [] });
});
afterEach(() => vi.useRealTimers());

describe("REG-FE-FIN finance page", () => {
  test("REG-FE-FIN-001 without billing.manage: no figures at all", () => {
    setAuth({ perms: ["payment.collect"] });
    page();
    expect(screen.getByText("You do not have access to the finance figures.")).toBeInTheDocument();
  });

  test("REG-FE-FIN-002 overview: collected with its change, owed (from Receivables), leakage, booked ahead", async () => {
    page();
    expect(await screen.findByText("12,000 ETB")).toBeInTheDocument();
    expect(screen.getByText("20%")).toBeInTheDocument();
    expect(screen.getByText(/9 payment\(s\) · vs 10,000 ETB before/)).toBeInTheDocument();
    expect(screen.getByText("9,000 ETB")).toBeInTheDocument();
    expect(screen.getByText("3 patient(s) · oldest 72 days")).toBeInTheDocument();
    expect(screen.getByText("750 ETB")).toBeInTheDocument();
    expect(screen.getByText("refunded 500 ETB · waived 250 ETB")).toBeInTheDocument();
    expect(screen.getByText("6 visit(s) scheduled — intent, not revenue")).toBeInTheDocument();
    // Default period is 7 days ending today.
    expect(lastRange()).toEqual({ from: "2026-09-27", to: "2026-10-03", branch: undefined });
    // Attention rows link to where the work is.
    expect(screen.getByRole("link", { name: /2 treated visits not billed/ })).toHaveAttribute("href", "/dental/unbilled");
    expect(screen.getByRole("link", { name: /2 treated visits not billed/ })).toHaveTextContent("3,000 ETB");
    // The mix is a share of gross: 11,000 / 12,500 = 88%.
    expect(screen.getByText("88%")).toBeInTheDocument();
    expect(screen.getByText(/500 ETB was refunded/)).toBeInTheDocument();
    // The chart is drawn.
    expect(screen.getByRole("img", { name: /Collected per day/ })).toBeInTheDocument();
  });

  test("REG-FE-FIN-003 a general clinic sees a payment count instead of booked ahead, and no treatment book tab", async () => {
    setAuth({ flags: ["finance_advanced"] });
    fin.financeOverview.mockResolvedValue({ ...OVERVIEW, collected: "8000", collected_prev: "10000", refunded: "0", waived: "0", attention: [] });
    page();
    expect(await screen.findByText("settled in this period")).toBeInTheDocument();
    expect(screen.getByText("20%")).toBeInTheDocument(); // down 20%
    expect(screen.queryByRole("tab", { name: "Treatment book" })).not.toBeInTheDocument();
    expect(screen.getByText("Billed before refunds.")).toBeInTheDocument();
  });

  test("REG-FE-FIN-004 an empty period says so instead of drawing an empty frame", async () => {
    fin.financeOverview.mockResolvedValue({ ...OVERVIEW, collected: "0", collected_prev: "0", by_source: [], attention: [] });
    fin.financeReceivables.mockResolvedValue({ ...RECV, total: "0", count: 0 });
    page();
    expect(await screen.findByText("Nothing collected in this period")).toBeInTheDocument();
    expect(screen.getByText("No revenue in this period.")).toBeInTheDocument();
  });

  test("REG-FE-FIN-005 'Owed to you' opens Receivables", async () => {
    const { user } = page();
    await user.click(await screen.findByRole("button", { name: /Owed to you/ }));
    expect(currentLocation()).toBe("/finance?tab=receivables");
    expect(await screen.findByText("Everyone who owes")).toBeInTheDocument();
  });

  test("REG-FE-FIN-006 owed falls back to the overview figure while receivables load", async () => {
    fin.financeReceivables.mockReturnValue(new Promise(() => {}));
    page();
    expect(await screen.findByText("3 patient(s)")).toBeInTheDocument();
  });

  test("REG-FE-FIN-007 quick periods, the More menu, and the URL", async () => {
    const { user } = page();
    await screen.findByText("12,000 ETB");
    await user.click(screen.getByRole("tab", { name: "Today" }));
    expect(currentLocation()).toBe("/finance?period=today");
    await waitFor(() => expect(lastRange()).toMatchObject({ from: "2026-10-03", to: "2026-10-03" }));
    await user.click(screen.getByRole("tab", { name: "30 days" }));
    await waitFor(() => expect(lastRange()).toMatchObject({ from: "2026-09-04", to: "2026-10-03" }));
    await user.click(screen.getByRole("tab", { name: "90 days" }));
    await waitFor(() => expect(lastRange()).toMatchObject({ from: "2026-07-06", to: "2026-10-03" }));

    const pick = async (label: string) => {
      await user.click(screen.getByRole("button", { name: /More|This|Last|Yesterday|7 days/ }));
      await user.click(await screen.findByRole("button", { name: label }));
    };
    await pick("Last week");
    await waitFor(() => expect(lastRange()).toMatchObject({ from: "2026-09-21", to: "2026-09-27" }));
    expect(screen.getByRole("button", { name: /Last week/ })).toBeInTheDocument();
    await pick("This week");
    await waitFor(() => expect(lastRange()).toMatchObject({ from: "2026-09-28", to: "2026-10-03" }));
    await pick("Last month");
    await waitFor(() => expect(lastRange()).toMatchObject({ from: "2026-09-01", to: "2026-09-30" }));
    await pick("This month");
    await waitFor(() => expect(lastRange()).toMatchObject({ from: "2026-10-01", to: "2026-10-03" }));
    await pick("This year");
    await waitFor(() => expect(lastRange()).toMatchObject({ from: "2026-01-01", to: "2026-10-03" }));
    await pick("Yesterday");
    await waitFor(() => expect(lastRange()).toMatchObject({ from: "2026-10-02", to: "2026-10-02" }));
    expect(currentLocation()).toBe("/finance?period=yesterday");
  });

  test("REG-FE-FIN-008 a single-day key (from a dashboard bar) is that one day, compared with the day before", async () => {
    page("?period=2026-09-30");
    await screen.findByText("12,000 ETB");
    expect(lastRange()).toEqual({ from: "2026-09-30", to: "2026-09-30", branch: undefined });
    expect(screen.getByRole("button", { name: /^(Wed, 30 Sep|Wed, Sep 30)$/ })).toBeInTheDocument();
    expect(screen.getByText(/the day before/)).toBeInTheDocument();
  });

  test("REG-FE-FIN-009 an unknown period falls back to 7 days; an unknown tab to Overview", async () => {
    page("?period=fortnight&tab=nonsense");
    await waitFor(() => expect(currentLocation()).toBe("/finance?period=fortnight&tab=overview"));
    expect(lastRange()).toMatchObject({ from: "2026-09-27", to: "2026-10-03" });
    expect(await screen.findByText(/previous period/)).toBeInTheDocument();
  });

  test("REG-FE-FIN-010 the branch filter appears with two branches and narrows every figure", async () => {
    admin.listBranches.mockResolvedValue([{ id: "br_1", name: "Bole", code: "B", is_active: true }, { id: "br_2", name: "Piassa", code: "P", is_active: true }]);
    const { user } = page();
    await screen.findByText("12,000 ETB");
    await user.click(await screen.findByRole("combobox"));
    await user.click(await screen.findByRole("option", { name: "Piassa" }));
    expect(currentLocation()).toBe("/finance?branch=br_2");
    await waitFor(() => expect(lastRange()).toMatchObject({ branch: "br_2" }));
    expect(fin.financeReceivables).toHaveBeenLastCalledWith({ branch: "br_2" });
    await user.click(screen.getByRole("combobox"));
    await user.click(await screen.findByRole("option", { name: "All branches" }));
    expect(currentLocation()).toBe("/finance");
  });

  test("REG-FE-FIN-011 receivables: ageing buckets, the rows, and a phone to call", async () => {
    page("?tab=receivables");
    expect(await screen.findByText("Everyone who owes")).toBeInTheDocument();
    expect(tab("Receivables")).toHaveTextContent("3");
    const almaz = screen.getByRole("link", { name: "Almaz Haile" }).closest("tr")!;
    expect(within(almaz).getByRole("link", { name: /0911000001/ })).toHaveAttribute("href", "tel:0911000001");
    expect(within(almaz).getByText("12 days")).toHaveClass("text-muted-foreground");
    const tesfaye = screen.getByRole("link", { name: "Tesfaye Alemu" }).closest("tr")!;
    expect(within(tesfaye).getByText("never")).toBeInTheDocument();
    expect(within(tesfaye).getByText("no phone")).toBeInTheDocument();
    expect(within(tesfaye).getByText("45 days")).toHaveClass("text-amber-700");
    expect(within(screen.getByRole("link", { name: "Selam Bekele" }).closest("tr")!).getByText("72 days")).toHaveClass("text-destructive");
  });

  test("REG-FE-FIN-012 a bucket filters the list, toggles off, and 60+ is both of the oldest", async () => {
    const { user } = page("?tab=receivables");
    await screen.findByText("Everyone who owes");
    await user.click(screen.getByRole("button", { name: /31–60 days/ }));
    expect(currentLocation()).toBe("/finance?tab=receivables&bucket=31-60");
    expect(screen.getByText("Owing 31–60 days")).toBeInTheDocument();
    expect(screen.getAllByRole("row")).toHaveLength(2);
    await user.click(screen.getByRole("button", { name: /31–60 days/ }));
    expect(currentLocation()).toBe("/finance?tab=receivables");
    await user.click(screen.getByRole("button", { name: /Over 90 days/ }));
    expect(screen.getByText("Nobody owes anything here")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Show all" }));
    expect(currentLocation()).toBe("/finance?tab=receivables");
  });

  test("REG-FE-FIN-013 '60+' from the dashboard shows 61–90 and 90+ together", async () => {
    page("?tab=receivables&bucket=60%2B");
    expect(await screen.findByRole("link", { name: "Selam Bekele" })).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "Almaz Haile" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /61–90 days/ })).toHaveClass("ring-1");
    expect(screen.getByRole("button", { name: /Over 90 days/ })).toHaveClass("ring-1");
  });

  test("REG-FE-FIN-014 cash & shifts: unbalanced counts, undrawn drawers, closeouts and splits", async () => {
    page("?tab=cash");
    expect(await screen.findByText("2 cash count(s) did not balance")).toBeInTheDocument();
    expect(tab("Cash & shifts")).toHaveTextContent("2");
    expect(screen.getByText("Abel has not counted today's drawer")).toBeInTheDocument();
    expect(screen.getByText("-100 ETB")).toHaveClass("text-destructive");
    expect(screen.getByText("+50 ETB")).toBeInTheDocument();
    expect(screen.getByText("short")).toBeInTheDocument();
    expect(screen.getByText("not recorded")).toBeInTheDocument();
    expect(screen.getByText("Nothing collected.")).toBeInTheDocument(); // by branch
  });

  test("REG-FE-FIN-015 cash with every drawer counted and balanced", async () => {
    fin.financeCash.mockResolvedValue({ ...CASH, shifts: [], open_drawers: [], by_method: [] });
    page("?tab=cash");
    expect(await screen.findByText("No drawer has been counted in this period.")).toBeInTheDocument();
    expect(screen.queryByText(/did not balance/)).not.toBeInTheDocument();
  });

  test("REG-FE-FIN-016 services: count, revenue, average and how it compares with the list price", async () => {
    fin.financeServices.mockResolvedValue([
      { label: "Root canal", source: "dental", count: 4, revenue: "16000", avg: "4000", catalogued: true, list_price: "5000" },
      { label: "Crown", source: "dental", count: 2, revenue: "12000", avg: "6600", catalogued: true, list_price: "6000" },
      { label: "Scaling", source: "dental", count: 5, revenue: "5000", avg: "1000", catalogued: true, list_price: "1000" },
      { label: "Whitening", source: "dental", count: 1, revenue: "3000", avg: "3000", catalogued: false },
      { label: "Check-up", source: "card", count: 3, revenue: "0", avg: "0", catalogued: true, list_price: "0" },
    ]);
    page("?tab=services");
    expect(await screen.findByText("Root canal")).toBeInTheDocument();
    expect(screen.getByText("−20%")).toHaveClass("text-amber-700");
    expect(screen.getByText("+10%")).toHaveClass("text-emerald-700");
    expect(screen.getByText("At list")).toBeInTheDocument();
    expect(screen.getByText("Not on the list")).toBeInTheDocument();
    expect(screen.getByText("3,000 ETB", { selector: "b" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Add them to the catalog" })).toHaveAttribute("href", "/billing/services");
    expect(fin.financeServices).toHaveBeenCalledWith({ from: "2026-09-27", to: "2026-10-03", branch: undefined });
  });

  test("REG-FE-FIN-017 services with nothing billed", async () => {
    page("?tab=services");
    expect(await screen.findByText("Nothing was billed in this period.")).toBeInTheDocument();
  });

  test("REG-FE-FIN-018 treatment book: booked ahead by month, and courses at risk with a phone", async () => {
    fin.financeBook.mockResolvedValue({
      total: "18000", visits: 6,
      by_month: [{ key: "2026-10", label: "October", amount: "12000", count: 4 }, { key: "2026-11", label: "November", amount: "6000", count: 2 }],
      at_risk: [
        { id: "pat_1", patient: "Almaz Haile", mrn: "CD-1", phone: "0911", plan: "Implant", at_risk: "9000", reason: "Missed visit 2", days_idle: 12 },
        { id: "pat_2", patient: "Tesfaye Alemu", mrn: "CD-2", plan: "Braces", at_risk: "4000", reason: "No visit booked", days_idle: 0 },
      ],
    });
    page("?tab=book");
    expect(await screen.findByText("18,000 ETB over 6 visit(s)")).toBeInTheDocument();
    expect(screen.getByText("October")).toBeInTheDocument();
    expect(screen.getByText("· 12 days late")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /0911/ })).toHaveAttribute("href", "tel:0911");
    expect(screen.getByText("no phone")).toBeInTheDocument();
    expect(fin.financeBook).toHaveBeenCalledWith({ branch: undefined });
  });

  test("REG-FE-FIN-019 an empty book: nothing scheduled, every course on schedule", async () => {
    page("?tab=book");
    expect(await screen.findByText("No visits are scheduled.")).toBeInTheDocument();
    expect(screen.getByText("Every course is on schedule")).toBeInTheDocument();
  });

  test("REG-FE-FIN-020 each tab shows Loading… until its data arrives", () => {
    for (const f of Object.values(fin)) f.mockReturnValue(new Promise(() => {}));
    for (const t of ["overview", "receivables", "cash", "services", "book"]) {
      const r = page(`?tab=${t}`);
      expect(screen.getByText("Loading…")).toBeInTheDocument();
      r.unmount();
    }
  });

  test("REG-FE-FIN-021 switching tabs keeps the period", async () => {
    const { user } = page("?period=30d");
    await screen.findByText("12,000 ETB");
    await user.click(tab("Services"));
    expect(currentLocation()).toBe("/finance?period=30d&tab=services");
    await waitFor(() => expect(fin.financeServices).toHaveBeenCalledWith({ from: "2026-09-04", to: "2026-10-03", branch: undefined }));
  });

  // NEW-FIN-1. Every tab renders `loading || !data → "Loading…"`, so a failed
  // request (403 for a role without the right, a 500, the network) shows
  // "Loading…" for ever — the money screen never admits it could not load.
  test.fails("REG-FE-FIN-022 KNOWN BUG NEW-FIN-1 a failed load says so instead of Loading… for ever", async () => {
    fin.financeOverview.mockRejectedValue(new Error("500"));
    page();
    await waitFor(() => expect(fin.financeOverview).toHaveBeenCalled());
    await waitFor(() => expect(screen.queryByText("Loading…")).not.toBeInTheDocument(), { timeout: 500 });
  });
});

describe("REG-FE-REVCHART revenue chart", () => {
  const svg = () => screen.getByRole("img");

  test("REG-FE-REVCHART-001 a week by day: bars, the peak labelled, the comparison line and its dates", () => {
    render7();
    expect(screen.getByText("by day")).toBeInTheDocument();
    expect(svg()).toHaveAccessibleName("Collected per day. Peak 5,000 ETB.");
    expect(screen.getByText(/previous 7 days · Sep 20 – Sep 26/)).toBeInTheDocument();
    expect(svg().querySelectorAll("path")).toHaveLength(6); // the empty day has no bar
    expect(svg().querySelector("polyline")).not.toBeNull();
    expect(svg().querySelectorAll("circle")).toHaveLength(7);
    expect(within(svg()).getByText("5,000 ETB")).toBeInTheDocument();
  });

  function render7(prev = days("2026-09-20", 7, () => 800)) {
    return renderUI(<RevenueChart series={days("2026-09-27", 7, (i) => (i === 3 ? 5000 : i === 5 ? 0 : 1000))} prev={prev} comparing="previous 7 days" />);
  }

  test("REG-FE-REVCHART-002 focusing a bar shows its value and the comparison's own day", () => {
    render7();
    const bars = within(svg()).getAllByRole("button");
    fireEvent.focus(bars[3]);
    expect(screen.getAllByText("Wed, Sep 30").length + screen.queryAllByText(/Wed, 30 Sep/).length).toBeGreaterThan(0);
    expect(screen.getByText(/800 ETB/, { selector: "span" })).toHaveTextContent("· Wed, Sep 23");
    // The peak label hides while a bar is read.
    expect(within(svg()).queryByText("5,000 ETB")).not.toBeInTheDocument();
    fireEvent.blur(bars[3]);
    expect(within(svg()).getByText("5,000 ETB")).toBeInTheDocument();
    // Late bars put the readout on the other side.
    fireEvent.focus(bars[6]);
    expect(document.querySelector(".pointer-events-none.absolute")).toHaveStyle({ transform: "translateX(-105%)" });
  });

  test("REG-FE-REVCHART-003 the pointer picks the band under it; outside the plot clears", () => {
    render7();
    vi.spyOn(svg(), "getBoundingClientRect").mockReturnValue({ left: 0, top: 0, width: 720, height: 234, right: 720, bottom: 234, x: 0, y: 0, toJSON: () => {} });
    const move = (x: number) => fireEvent(svg(), new MouseEvent("pointermove", { clientX: x, bubbles: true }));
    move(60);
    expect(document.querySelector(".pointer-events-none.absolute")).not.toBeNull();
    move(10);
    expect(document.querySelector(".pointer-events-none.absolute")).toBeNull();
    move(700);
    expect(document.querySelector(".pointer-events-none.absolute")).not.toBeNull();
    fireEvent(svg(), new MouseEvent("pointerout", { bubbles: true, relatedTarget: document.body }));
    expect(document.querySelector(".pointer-events-none.absolute")).toBeNull();
  });

  test("REG-FE-REVCHART-004 the table view lists every value, with dashes for empty days", async () => {
    const { user } = render7();
    await user.click(screen.getByRole("button", { name: /Table/ }));
    const table = screen.getByRole("table");
    expect(within(table).getByRole("columnheader", { name: "Day" })).toBeInTheDocument();
    expect(within(table).getByRole("columnheader", { name: "previous 7 days" })).toBeInTheDocument();
    expect(within(table).getAllByRole("row")).toHaveLength(8);
    expect(within(table).getByText("—")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /Chart/ }));
    expect(screen.getByRole("img")).toBeInTheDocument();
  });

  test("REG-FE-REVCHART-005 ninety days is drawn by week; a year by month; no comparison, no line", async () => {
    const r = renderUI(<RevenueChart series={days("2026-07-06", 90, (i) => i % 7 === 0 ? 700 : 0)} prev={days("2026-04-07", 90, () => 10)} comparing="previous 90 days" />);
    expect(screen.getByText("by week")).toBeInTheDocument();
    await r.user.click(screen.getByRole("button", { name: /Table/ }));
    expect(screen.getByRole("columnheader", { name: "Week" })).toBeInTheDocument();
    expect(screen.getAllByText(/^week of /).length).toBeGreaterThan(10);
    expect(screen.getAllByText(/ – /).length).toBeGreaterThan(0); // comparison spans
    r.unmount();
    const y = renderUI(<RevenueChart series={days("2026-01-01", 276, () => 100)} prev={[]} comparing="previous year" />);
    expect(screen.getByText("by month")).toBeInTheDocument();
    expect(screen.queryByText(/previous year/)).not.toBeInTheDocument();
    expect(screen.getByRole("img").querySelector("polyline")).toBeNull();
    await y.user.click(screen.getByRole("button", { name: /Table/ }));
    expect(screen.getByRole("columnheader", { name: "Month" })).toBeInTheDocument();
    expect(screen.getByText(/January 2026/)).toBeInTheDocument();
  });

  test("REG-FE-REVCHART-006 no days at all; and an all-zero window draws no bars", () => {
    const r = renderUI(<RevenueChart series={[]} prev={[]} comparing="x" />);
    expect(screen.getByText("No days in this period.")).toBeInTheDocument();
    r.unmount();
    renderUI(<RevenueChart series={days("2026-09-27", 3, () => 0)} prev={[]} comparing="x" />);
    expect(screen.getByRole("img").querySelectorAll("path")).toHaveLength(0);
    expect(screen.getByRole("img")).toHaveAccessibleName("Collected per day. Peak 0 ETB.");
  });

  test("REG-FE-REVCHART-007 the axis tops out at or above the biggest bar (28,333 is not cut at 20,000)", () => {
    renderUI(<RevenueChart series={days("2026-09-27", 3, (i) => (i === 1 ? 28333 : 100))} prev={[]} comparing="x" />);
    const ticks = Array.from(screen.getByRole("img").querySelectorAll("text")).map((t) => t.textContent);
    expect(ticks).toContain("30,000");
  });

  test("REG-FE-REVCHART-008 the chart follows its container's real width", () => {
    let cb: ResizeObserverCallback | undefined;
    const RO = class { constructor(f: ResizeObserverCallback) { cb = f; } observe() {} disconnect() {} unobserve() {} };
    vi.stubGlobal("ResizeObserver", RO);
    try {
      render7();
      // A phone-width card: the viewBox shrinks with it (never below 280).
      act(() => cb!([{ contentRect: { width: 200 } } as ResizeObserverEntry], {} as ResizeObserver));
      expect(svg().getAttribute("viewBox")).toBe("0 0 280 234");
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

import { act } from "@testing-library/react";
