// The clinical-alert bar that stays on screen once the patient banner scrolls away.
//
// What it must get right: it appears only when the banner has scrolled up out of
// view (not when it is merely below the fold), it says nothing when there is
// nothing to warn about, a severe allergy reads as danger rather than caution,
// and "Hide" silences only the alerts the reader actually saw — a newly added
// allergy must bring the bar back.
import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useRef } from "react";
import { afterEach, describe, expect, test, vi } from "vitest";

import { StickyAlertBar, useScrolledPast, type ClinicalAlert } from "../StickyAlertBar";

const PEN: ClinicalAlert = { key: "alg1", level: "danger", text: "Allergy: Penicillin" };
const DM: ClinicalAlert = { key: "cnd1", level: "warn", text: "Type 2 diabetes" };
const WARF: ClinicalAlert = { key: "alg2", level: "danger", text: "Allergy: Warfarin" };

/** An IntersectionObserver the test can drive, recording what it watches. */
function controllableObserver() {
  const made: { cb: IntersectionObserverCallback; observed: Element[]; disconnected: boolean }[] = [];
  class IO {
    rec: (typeof made)[number];
    constructor(cb: IntersectionObserverCallback) { this.rec = { cb, observed: [], disconnected: false }; made.push(this.rec); }
    observe(el: Element) { this.rec.observed.push(el); }
    unobserve() {}
    disconnect() { this.rec.disconnected = true; }
    takeRecords() { return []; }
  }
  vi.stubGlobal("IntersectionObserver", IO);
  const fire = (isIntersecting: boolean, top: number) =>
    act(() => made[made.length - 1].cb(
      [{ isIntersecting, boundingClientRect: { top } } as unknown as IntersectionObserverEntry],
      {} as IntersectionObserver,
    ));
  return { made, fire };
}

function Probe({ attach = true }: { attach?: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  const past = useScrolledPast(ref);
  return (
    <div>
      {attach && <div ref={ref} data-testid="banner">banner</div>}
      <output data-testid="past">{String(past)}</output>
    </div>
  );
}

describe("REG-FE-ALERTBAR the sticky clinical alert bar", () => {
  afterEach(() => vi.unstubAllGlobals());

  test("REG-FE-ALERTBAR-001 nothing to warn about: renders nothing, even when scrolled past", () => {
    const { container } = render(<StickyAlertBar alerts={[]} show patientName="Abebe" />);
    expect(container).toBeEmptyDOMElement();
  });

  test("REG-FE-ALERTBAR-002 alerts exist but the banner is still visible: no bar", () => {
    render(<StickyAlertBar alerts={[PEN]} show={false} patientName="Abebe" />);
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });

  test("REG-FE-ALERTBAR-003 scrolled past: the patient's name and every alert, in order, danger in bold", () => {
    render(<StickyAlertBar alerts={[PEN, DM]} show patientName="Abebe Tesfaye" />);
    const bar = screen.getByRole("status");
    expect(bar).toHaveAttribute("aria-live", "polite");
    expect(bar).toHaveTextContent(/Abebe Tesfaye.*Allergy: Penicillin.*·.*Type 2 diabetes/);
    expect(screen.getByText("Allergy: Penicillin")).toHaveClass("font-semibold");
    expect(screen.getByText("Type 2 diabetes")).not.toHaveClass("font-semibold");
    // One danger alert is enough to turn the whole bar red.
    expect(bar.className).toMatch(/rose/);
  });

  test("REG-FE-ALERTBAR-004 only cautions: amber bar, and no name when none is given", () => {
    render(<StickyAlertBar alerts={[DM]} show />);
    const bar = screen.getByRole("status");
    expect(bar.className).toMatch(/amber/);
    expect(bar.className).not.toMatch(/rose/);
    expect(bar).toHaveTextContent(/^Type 2 diabetesHide$/);
  });

  test("REG-FE-ALERTBAR-005 Hide dismisses the bar; the same alerts re-rendered stay hidden", async () => {
    const user = userEvent.setup();
    const { rerender } = render(<StickyAlertBar alerts={[PEN]} show patientName="A" />);
    await user.click(screen.getByRole("button", { name: "Hide" }));
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
    rerender(<StickyAlertBar alerts={[{ ...PEN }]} show patientName="A" />);
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });

  test("REG-FE-ALERTBAR-006 a newly added alert re-arms a dismissed bar", async () => {
    const user = userEvent.setup();
    const { rerender } = render(<StickyAlertBar alerts={[PEN]} show />);
    await user.click(screen.getByRole("button", { name: "Hide" }));
    rerender(<StickyAlertBar alerts={[PEN, WARF]} show />);
    expect(screen.getByRole("status")).toHaveTextContent("Allergy: Warfarin");
  });

  test("REG-FE-ALERTBAR-007 useScrolledPast: true only once the banner has left through the top", () => {
    const io = controllableObserver();
    render(<Probe />);
    expect(io.made[0].observed[0]).toBe(screen.getByTestId("banner"));
    expect(screen.getByTestId("past")).toHaveTextContent("false");
    // Below the fold (not intersecting, but top is positive): not "past".
    io.fire(false, 900);
    expect(screen.getByTestId("past")).toHaveTextContent("false");
    io.fire(false, -40);
    expect(screen.getByTestId("past")).toHaveTextContent("true");
    io.fire(true, -10);
    expect(screen.getByTestId("past")).toHaveTextContent("false");
  });

  test("REG-FE-ALERTBAR-008 useScrolledPast stops watching on unmount", () => {
    const io = controllableObserver();
    const { unmount } = render(<Probe />);
    unmount();
    expect(io.made[0].disconnected).toBe(true);
  });

  test("REG-FE-ALERTBAR-009 useScrolledPast without a banner or without IntersectionObserver: stays false, no crash", () => {
    const io = controllableObserver();
    render(<Probe attach={false} />);
    expect(io.made).toHaveLength(0);
    expect(screen.getByTestId("past")).toHaveTextContent("false");

    vi.stubGlobal("IntersectionObserver", undefined);
    render(<Probe />);
    expect(screen.getAllByTestId("past")[1]).toHaveTextContent("false");
  });
});
