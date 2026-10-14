// The timeline: every visit across every course, on one date spine, read outwards
// from today. Read-only — a row hands off to the cockpit via onOpenVisit.
import { render, screen, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { TimelinePanel, timelineCount } from "@/features/dental/shelf/TimelinePanel";
import type { Plan } from "@/features/dental/api";
import { freezeToday } from "@/test/render";
import { P, S } from "@/features/dental/visit/__tests__/fixtures";

const T = "2026-08-12";

function panel(plans: Plan[], patientId = "pat_1") {
  const onOpenVisit = vi.fn();
  const user = userEvent.setup();
  // The app's data provider, with the clinic's numbering already known (simple:
  // Palmer), as it is on the patient page that hosts this panel.
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
  qc.setQueryData(["dental-settings"], { chart_style: "simple" });
  const r = render(<QueryClientProvider client={qc}><TimelinePanel patientId={patientId} plans={plans} todayISO={T} onOpenVisit={onOpenVisit} /></QueryClientProvider>);
  return { ...r, onOpenVisit, user };
}
/** Every visit row in document order, as text. */
const rows = () => screen.queryAllByRole("button").filter((b) => !b.getAttribute("role") && /visit \d|Cancelled/.test(b.textContent ?? ""));
const rowFor = (text: string) => rows().find((r) => r.textContent?.includes(text)) as HTMLElement;
const sections = () => Array.from(document.querySelectorAll("p.uppercase")).map((p) => p.textContent);

describe("REG-FE-TREATMENTS the timeline panel", () => {
  beforeEach(() => { freezeToday(T); sessionStorage.clear(); });
  afterEach(() => vi.useRealTimers());

  test("REG-FE-TREATMENTS-010 no plans: says the timeline is empty and how it fills", () => {
    panel([]);
    expect(screen.getByText("Nothing on the timeline yet")).toBeInTheDocument();
    expect(screen.getByText(/Create a treatment plan and its visits appear here/)).toBeInTheDocument();
    expect(screen.queryByRole("tablist")).not.toBeInTheDocument();
  });

  test("REG-FE-TREATMENTS-011 today leads, then next (nearest first), then earlier (most recent first)", () => {
    panel([P("p1", "Root canal", [
      S("a", "2026-08-01", 1, "done", { payment: "paid" }),
      S("b", "2026-08-05", 2, "done", { payment: "paid" }),
      S("c", T, 3),
      S("d", "2026-08-20", 4),
      S("e", "2026-08-15", 5),
    ])]);
    expect(sections()[0]).toMatch(/^Today · /);
    expect(sections()[1]).toBe("Next · 2 booked");
    expect(sections()[2]).toBe("Earlier · most recent first");
    expect(rows().map((r) => r.textContent!.match(/visit (\d)/)![1])).toEqual(["3", "5", "4", "2", "1"]);
  });

  test("REG-FE-TREATMENTS-012 a row: course, visit N of M, date + relative, procedure · tooth, note, attachments, fee and money state", () => {
    panel([P("p1", "Root canal", [
      S("a", "2026-08-10", 1, "done", { payment: "paid", procedure: "Pulpotomy", tooth: "UR5", notes: "Went well",
        prescriptions: [{}, {}] as never, images: [{}] as never, amount_due: "2500" }),
      S("b", "2026-08-11", 2, "done", { payment: "unpaid", prescriptions: [{}] as never }),
      S("c", "2026-08-13", 3, "planned", { images: [{}, {}] as never }),
    ])]);
    const a = rowFor("visit 1");
    expect(a).toHaveTextContent("Root canal");
    expect(a).toHaveTextContent("visit 1 of 3");
    expect(a).toHaveTextContent("2 days ago");
    expect(a).toHaveTextContent("Pulpotomy · UR5");
    expect(a).toHaveTextContent("Went well");
    expect(a).toHaveTextContent("2 prescriptions · 1 image");
    expect(a).toHaveTextContent("2,500 ETB");
    expect(a).toHaveTextContent("Paid");
    expect(a.querySelector(".bg-emerald-500")).toBeInTheDocument();
    const b = rowFor("visit 2");
    expect(b).toHaveTextContent("1 prescription");
    expect(b).not.toHaveTextContent("image");
    // Done and never settled: flagged, in red, with the amber dot.
    expect(within(b).getAllByText("Owed now")).toHaveLength(2);
    expect(b.querySelector(".bg-amber-500")).toBeInTheDocument();
    const c = rowFor("visit 3");
    expect(c).toHaveTextContent("tomorrow");
    expect(c).toHaveTextContent("2 images");
    expect(c).toHaveTextContent("Not yet due");
  });

  test("REG-FE-TREATMENTS-013 a visit at the cashier is marked, but not as owed", () => {
    panel([P("p1", "Crown", [S("a", "2026-08-10", 1, "done", { payment: "billed" })])]);
    const a = rowFor("visit 1");
    expect(within(a).getAllByText("At cashier")).toHaveLength(2);
    expect(a.querySelector(".text-destructive")).not.toBeInTheDocument();
  });

  test("REG-FE-TREATMENTS-014 a booked visit in the past is Missed; today's has no relative text", () => {
    panel([P("p1", "Crown", [S("a", "2026-08-05", 1), S("b", T, 2)])]);
    const a = rowFor("visit 1");
    expect(within(a).getByText("Missed")).toBeInTheDocument();
    expect(a.querySelector(".bg-rose-500")).toBeInTheDocument();
    const b = rowFor("visit 2");
    expect(b).not.toHaveTextContent(/today|ago/);
    expect(b.querySelector(".bg-brand")).toBeInTheDocument();
  });

  test("REG-FE-TREATMENTS-015 a cancelled visit stays on the record, struck out of the numbering", () => {
    panel([P("p1", "Crown", [S("a", "2026-08-01", 1, "done", { payment: "paid" }), S("x", "2026-08-03", 2, "cancelled"), S("b", "2026-08-14", 3)])]);
    const x = rows().find((r) => within(r).queryByText("Cancelled", { selector: "div" }) || r.className.includes("opacity-60"))!;
    expect(x).toHaveClass("opacity-60");
    expect(x).not.toHaveTextContent(/visit \d of/);
    // The live visits are numbered 1 and 2 of 2, skipping the cancelled one.
    expect(rowFor("visit 2 of 2")).toBeInTheDocument();
  });

  test("REG-FE-TREATMENTS-016 a row opens its visit in the cockpit", async () => {
    const { user, onOpenVisit } = panel([P("p1", "Crown", [S("a", "2026-08-10", 1, "done", { payment: "paid" })])]);
    await user.click(rowFor("visit 1"));
    expect(onOpenVisit).toHaveBeenCalledWith("a");
  });

  test("REG-FE-TREATMENTS-017 the window hides distance, says how many it hid, and 'show everything' widens it", async () => {
    const { user } = panel([P("p1", "Ortho", [
      S("old2", "2026-03-01", 1, "done", { payment: "paid" }),
      S("old1", "2026-05-01", 2, "done", { payment: "paid" }),
      S("near", "2026-08-20", 3),
      S("far", "2026-12-01", 4),
    ])]);
    expect(screen.getByRole("tab", { name: "Month" })).toHaveAttribute("aria-selected", "true");
    // The most recent past visit survives any window; the older one and the far one do not.
    expect(rowFor("visit 2")).toBeInTheDocument();
    expect(rowFor("visit 1")).toBeUndefined();
    expect(rowFor("visit 4")).toBeUndefined();
    const more = screen.getByRole("button", { name: "2 more visits outside this window — show everything" });
    await user.click(more);
    expect(screen.getByRole("tab", { name: "All" })).toHaveAttribute("aria-selected", "true");
    expect(rowFor("visit 1")).toBeInTheDocument();
    expect(rowFor("visit 4")).toBeInTheDocument();
    expect(screen.queryByText(/outside this window/)).not.toBeInTheDocument();
    expect(sessionStorage.getItem("dental-tl-window:pat_1")).toBe("all");
  });

  test("REG-FE-TREATMENTS-018 picking a window narrows/widens and is remembered per patient", async () => {
    const plans = [P("p1", "Ortho", [S("near", "2026-08-15", 1), S("mid", "2026-10-01", 2)])];
    const { user, unmount } = panel(plans);
    expect(rowFor("visit 2")).toBeUndefined();
    await user.click(screen.getByRole("tab", { name: "3 months" }));
    expect(rowFor("visit 2")).toBeInTheDocument();
    await user.click(screen.getByRole("tab", { name: "Week" }));
    expect(rowFor("visit 1")).toBeInTheDocument();
    expect(screen.getByText("1 more visit outside this window — show everything")).toBeInTheDocument();
    unmount();
    panel(plans);
    expect(screen.getByRole("tab", { name: "Week" })).toHaveAttribute("aria-selected", "true");
    sessionStorage.setItem("dental-tl-window:pat_2", "bogus");
    panel(plans, "pat_2");
    expect(screen.getAllByRole("tab", { name: "Month" }).at(-1)).toHaveAttribute("aria-selected", "true");
  });

  test("REG-FE-TREATMENTS-019 the window never hides a missed visit or an unsettled fee", () => {
    panel([P("p1", "Ortho", [
      S("missed", "2026-02-01", 1),
      S("owed", "2026-03-01", 2, "done", { payment: "unpaid" }),
      S("paid", "2026-04-01", 3, "done", { payment: "paid" }),
      S("recent", "2026-06-01", 4, "done", { payment: "paid" }),
    ])]);
    expect(rowFor("visit 1")).toBeInTheDocument();
    expect(rowFor("visit 2")).toBeInTheDocument();
    expect(rowFor("visit 4")).toBeInTheDocument();
    expect(rowFor("visit 3")).toBeUndefined();
    expect(screen.getByText("1 more visit outside this window — show everything")).toBeInTheDocument();
  });

  test("REG-FE-TREATMENTS-020 only upcoming visits: says no visits are recorded yet", () => {
    panel([P("p1", "Ortho", [S("a", "2026-08-20", 1)])]);
    expect(sections()).toEqual(["Next"]);
    expect(screen.getByText("No visits recorded yet.")).toBeInTheDocument();
  });

  test("REG-FE-TREATMENTS-021 visits from two courses are interleaved by date", () => {
    panel([
      P("p1", "Crown", [S("a", "2026-08-14", 1), S("b", "2026-08-30", 2)]),
      P("p2", "Cleaning", [S("c", "2026-08-20", 1)]),
    ]);
    expect(rows().map((r) => r.textContent!.split("visit")[0])).toEqual(["Crown", "Cleaning", "Crown"]);
  });

  test("REG-FE-TREATMENTS-022 timelineCount counts live visits across courses for the rail badge", () => {
    expect(timelineCount([
      P("p1", "A", [S("a", T, 1), S("b", T, 2, "cancelled")]),
      P("p2", "B", [S("c", T, 1, "done")]),
    ])).toBe(2);
    expect(timelineCount([])).toBe(0);
  });
});
