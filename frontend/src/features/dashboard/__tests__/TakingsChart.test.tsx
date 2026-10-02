// The money chart on the home page: the range switch (remembered), the empty and
// failed states, the breakdown beside it, and what a bar does — a mouse click opens
// that day in Finance, a tap on a touch screen shows the day first with a link.
import { cloneElement, isValidElement, type ReactElement, type ReactNode } from "react";
import { fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

const api = vi.hoisted(() => ({ dashboardTakings: vi.fn() }));
vi.mock("@/features/dashboard/api", async (orig) => ({ ...(await orig<object>()), ...api }));
// NumberFlow animates in a shadow root jsdom cannot drive; the sr-only twin is what we read.
vi.mock("@number-flow/react", () => ({ default: () => null }));
// jsdom has no layout, so ResponsiveContainer would measure 0×0 and draw nothing.
// Give the chart a fixed size instead.
vi.mock("recharts", async (orig) => {
  const real = await orig<typeof import("recharts")>();
  return {
    ...real,
    // jsdom never advances recharts' animation frames, so an animated bar stays unpainted.
    Bar: (props: React.ComponentProps<typeof real.Bar>) => <real.Bar {...props} isAnimationActive={false} />,
    ResponsiveContainer: ({ children }: { children: ReactNode }) => (
      <div style={{ width: 700, height: 230 }}>
        {isValidElement(children) ? cloneElement(children as ReactElement<{ width: number; height: number }>, { width: 700, height: 230 }) : children}
      </div>
    ),
  };
});

import TakingsChart from "@/features/dashboard/components/TakingsChart";
import type { DashTakings } from "@/features/dashboard/api";
import type { DashLinks } from "@/features/dashboard/links";
import { currentLocation, renderUI } from "@/test/render";

const TODAY = "2026-10-02";
const iso = (back: number) => {
  const d = new Date(`${TODAY}T00:00:00`);
  d.setDate(d.getDate() - back);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};
const series = (days: number, amt: (i: number) => number) =>
  Array.from({ length: days }, (_, i) => ({ date: iso(days - 1 - i), amount: String(amt(i)), count: amt(i) > 0 ? 2 : 0 }));

const takings = (days: number, over: Partial<DashTakings> = {}): DashTakings => ({
  days, total: "21000", prev: "14000", series: series(days, () => 3000),
  by_source: [
    { key: "dental", label: "Dental treatment", amount: "15000", count: 5 },
    { key: "pharmacy", label: "Pharmacy", amount: "6000", count: 3 },
    { key: "lab", label: "Lab", amount: "0", count: 0 },
  ],
  by_method: [
    { key: "cash", label: "Cash", amount: "15750", count: 6 },
    { key: "telebirr", label: "telebirr", amount: "5250", count: 2 },
  ],
  ...over,
});

function links(finance = true): DashLinks {
  return {
    finance: (period?: string, tab?: string) => {
      if (!finance) return undefined;
      const q = new URLSearchParams();
      if (tab) q.set("tab", tab);
      if (period) q.set("period", period);
      return `/finance?${q}`;
    },
  } as unknown as DashLinks;
}

const setPointer = (coarse: boolean) => {
  window.matchMedia = ((q: string) => ({
    matches: coarse && q.includes("coarse"), media: q, onchange: null, addListener() {}, removeListener() {},
    addEventListener() {}, removeEventListener() {}, dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia;
};
const bars = () => Array.from(document.querySelectorAll<SVGElement>("path.recharts-rectangle"));

// jsdom has no PointerEvent, so fireEvent.pointerUp would drop pointerType and clientX.
if (typeof window.PointerEvent === "undefined") {
  class PE extends MouseEvent {
    pointerType: string;
    constructor(type: string, init: PointerEventInit = {}) { super(type, init); this.pointerType = init.pointerType ?? ""; }
  }
  (window as unknown as { PointerEvent: typeof PE }).PointerEvent = PE;
}

describe("REG-FE-TAKINGS the money chart", () => {
  const origMM = window.matchMedia;
  beforeEach(() => {
    localStorage.clear();
    api.dashboardTakings.mockReset();
    setPointer(false);
  });
  afterEach(() => { window.matchMedia = origMM; });

  test("REG-FE-TAKINGS-001 opens on 30 days, shows the total and the change on the 30 days before", async () => {
    api.dashboardTakings.mockImplementation(async (d: number) => takings(d));
    renderUI(<TakingsChart links={links()} today={TODAY} />);
    expect(api.dashboardTakings).toHaveBeenCalledWith(30);
    expect(screen.getByRole("tab", { name: "30 days" })).toHaveAttribute("aria-selected", "true");
    expect(await screen.findByText("21,000")).toBeInTheDocument();
    expect(screen.getByText(/on the 30 days before/)).toBeInTheDocument();
    expect(screen.getByText("Where it came from · 30 days")).toBeInTheDocument();
  });

  test("REG-FE-TAKINGS-002 switching range asks for that range and is remembered next time", async () => {
    api.dashboardTakings.mockImplementation(async (d: number) => takings(d));
    const { user, unmount } = renderUI(<TakingsChart links={links()} today={TODAY} />);
    await screen.findByText("21,000");
    await user.click(screen.getByRole("tab", { name: "7 days" }));
    await waitFor(() => expect(api.dashboardTakings).toHaveBeenCalledWith(7));
    expect(screen.getByRole("tab", { name: "7 days" })).toHaveAttribute("aria-selected", "true");
    expect(await screen.findByText(/on the 7 days before/)).toBeInTheDocument();
    expect(localStorage.getItem("dashboard:range")).toBe("7");
    unmount();
    api.dashboardTakings.mockClear();
    renderUI(<TakingsChart links={links()} today={TODAY} />);
    expect(api.dashboardTakings).toHaveBeenCalledWith(7);
  });

  test("REG-FE-TAKINGS-003 a nonsense saved range falls back to 30 days", () => {
    localStorage.setItem("dashboard:range", "45");
    api.dashboardTakings.mockImplementation(async (d: number) => takings(d));
    renderUI(<TakingsChart links={links()} today={TODAY} />);
    expect(api.dashboardTakings).toHaveBeenCalledWith(30);
  });

  test("REG-FE-TAKINGS-004 nothing collected: says so in the chart and in the breakdown", async () => {
    api.dashboardTakings.mockResolvedValue(takings(30, {
      total: "0", prev: "0", series: series(30, () => 0),
      by_source: [{ key: "dental", label: "Dental", amount: "0", count: 0 }], by_method: [],
    }));
    renderUI(<TakingsChart links={links()} today={TODAY} />);
    expect(await screen.findByText("Nothing collected in the last 30 days.")).toBeInTheDocument();
    expect(screen.getByText("Nothing collected in this period.")).toBeInTheDocument();
    expect(bars()).toHaveLength(0);
  });

  test("REG-FE-TAKINGS-005 a failed load is shown as a failure with Retry, which asks again", async () => {
    api.dashboardTakings.mockRejectedValueOnce(new Error("boom")).mockResolvedValue(takings(30));
    const { user } = renderUI(<TakingsChart links={links()} today={TODAY} />);
    const retry = await screen.findByRole("button", { name: /retry|try again/i });
    expect(screen.queryByText(/Nothing collected/)).not.toBeInTheDocument();
    await user.click(retry);
    expect(await screen.findByText("21,000")).toBeInTheDocument();
    expect(api.dashboardTakings).toHaveBeenCalledTimes(2);
  });

  test("REG-FE-TAKINGS-006 the breakdown lists only sources that took money, linked to Finance services", async () => {
    api.dashboardTakings.mockResolvedValue(takings(30));
    renderUI(<TakingsChart links={links()} today={TODAY} />);
    const dental = await screen.findByRole("link", { name: /Dental treatment\s*15,000/ });
    expect(dental).toHaveAttribute("href", "/finance?tab=services&period=30d");
    expect(screen.getByRole("link", { name: /Pharmacy\s*6,000/ })).toBeInTheDocument();
    expect(screen.queryByText("Lab")).not.toBeInTheDocument();
    expect(screen.getByText("21k")).toBeInTheDocument();
    // How it was paid, as shares of the methods total.
    expect(screen.getByText("Cash").parentElement).toHaveTextContent("Cash 75%");
    expect(screen.getByText("telebirr").parentElement).toHaveTextContent("telebirr 25%");
    expect(screen.getByRole("link", { name: "Cash & shifts" })).toHaveAttribute("href", "/finance?tab=cash&period=30d");
  });

  test("REG-FE-TAKINGS-007 someone who cannot open Finance sees the breakdown without links", async () => {
    api.dashboardTakings.mockResolvedValue(takings(30, { total: "6000", by_source: [{ key: "x", label: "Lab", amount: "6000", count: 1 }] }));
    renderUI(<TakingsChart links={links(false)} today={TODAY} />);
    expect(await screen.findByText("Lab")).toBeInTheDocument();
    expect(screen.queryByRole("link")).not.toBeInTheDocument();
    expect(screen.getByText("Lab").parentElement).toHaveTextContent("Lab6,000");
  });

  test("REG-FE-TAKINGS-008 a mouse click on a day's bar opens that day in Finance", async () => {
    api.dashboardTakings.mockImplementation(async (d: number) => takings(d));
    renderUI(<TakingsChart links={links()} today={TODAY} />);
    await screen.findByText("21,000");
    await waitFor(() => expect(bars().length).toBeGreaterThan(0));
    // The last bar is today (series runs oldest → newest).
    fireEvent.click(bars()[bars().length - 1]);
    await waitFor(() => expect(currentLocation()).toBe(`/finance?period=${TODAY}`));
  });

  test("REG-FE-TAKINGS-009 on a touch screen a tap shows the day and a link instead of leaving the page", async () => {
    setPointer(true);
    api.dashboardTakings.mockImplementation(async (d: number) => takings(d));
    renderUI(<TakingsChart links={links()} today={TODAY} />, { route: "/" });
    await screen.findByText("21,000");
    await waitFor(() => expect(bars().length).toBeGreaterThan(0));
    fireEvent.click(bars()[bars().length - 1]);
    expect(await screen.findByText("Today so far")).toBeInTheDocument();
    expect(screen.getByText(/3,000 ETB · 2 payments/)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /See this day/ })).toHaveAttribute("href", `/finance?period=${TODAY}`);
    expect(currentLocation()).toBe("/");
  });

  test("REG-FE-TAKINGS-010 without Finance a click only shows the day, with no link to follow", async () => {
    api.dashboardTakings.mockImplementation(async (d: number) => takings(d));
    renderUI(<TakingsChart links={links(false)} today={TODAY} />);
    await screen.findByText("21,000");
    await waitFor(() => expect(bars().length).toBeGreaterThan(0));
    fireEvent.click(bars()[0]);
    expect(await screen.findByText(/3,000 ETB/)).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: /See this/ })).not.toBeInTheDocument();
    expect(currentLocation()).toBe("/");
  });

  test("REG-FE-TAKINGS-011 90 days is drawn as weeks, and a week opens the whole period", async () => {
    api.dashboardTakings.mockImplementation(async (d: number) => takings(d));
    const { user } = renderUI(<TakingsChart links={links()} today={TODAY} />);
    await screen.findByText("21,000");
    await user.click(screen.getByRole("tab", { name: "90 days" }));
    await screen.findByText(/on the 90 days before/);
    await waitFor(() => expect(bars().length).toBe(13));
    setPointer(true);
    fireEvent.click(bars()[12]);
    expect(await screen.findByText(/^Week of/)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /See these days/ })).toHaveAttribute("href", "/finance?period=90d");
  });

  test("REG-FE-TAKINGS-012 a touch lift over the plot picks the bar under the finger", async () => {
    api.dashboardTakings.mockImplementation(async (d: number) => takings(d));
    renderUI(<TakingsChart links={links()} today={TODAY} />);
    await screen.findByText("21,000");
    await waitFor(() => expect(bars().length).toBeGreaterThan(0));
    const plot = document.querySelector<HTMLElement>(".h-\\[230px\\]")!;
    plot.getBoundingClientRect = () => ({ left: 0, top: 0, width: 344, height: 230, right: 344, bottom: 230, x: 0, y: 0, toJSON() {} });
    // Plot width 344-40-4 = 300 over 30 bars: 10px each. x=40+295 is the last (today).
    fireEvent.pointerUp(plot, { pointerType: "touch", clientX: 335 });
    expect(await screen.findByText("Today so far")).toBeInTheDocument();
    // A mouse lift is left to the bar's own click.
    fireEvent.pointerUp(plot, { pointerType: "mouse", clientX: 45 });
    expect(screen.getByText("Today so far")).toBeInTheDocument();
    // Off the plot (in the axis gutter) picks nothing new.
    fireEvent.pointerUp(plot, { pointerType: "touch", clientX: 5 });
    expect(screen.getByText("Today so far")).toBeInTheDocument();
  });

  test("REG-FE-TAKINGS-013 switching range clears a picked day", async () => {
    setPointer(true);
    api.dashboardTakings.mockImplementation(async (d: number) => takings(d));
    const { user } = renderUI(<TakingsChart links={links()} today={TODAY} />);
    await screen.findByText("21,000");
    await waitFor(() => expect(bars().length).toBeGreaterThan(0));
    fireEvent.click(bars()[bars().length - 1]);
    expect(await screen.findByText("Today so far")).toBeInTheDocument();
    await user.click(screen.getByRole("tab", { name: "7 days" }));
    expect(screen.queryByText("Today so far")).not.toBeInTheDocument();
  });
});
