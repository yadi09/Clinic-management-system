// The Treatments panel: one course at a time. The list says how each course is going
// (delivery, money, what is wrong with it); opening one shows its terms, its money and
// its visits in course order. Rows hand off to the cockpit via onOpenVisit.
import { screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

const api = vi.hoisted(() => ({ collectSession: vi.fn() }));
vi.mock("@/features/dental/api", async (orig) => ({ ...(await orig<object>()), ...api }));
vi.mock("@/lib/api-client", async (orig) => {
  const { quietApiFetch } = await import("@/test/render");
  return { ...(await orig<object>()), apiFetch: vi.fn(quietApiFetch) };
});
const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }));
vi.mock("sonner", () => ({ toast, Toaster: () => null }));

import { AppError } from "@/lib/api-client";
import { TreatmentsPanel } from "@/features/dental/shelf/TreatmentsPanel";
import type { Plan, Session } from "@/features/dental/api";
import { freezeToday, renderUI } from "@/test/render";
import { P as baseP, S } from "@/features/dental/visit/__tests__/fixtures";

const T = "2026-08-12";
const money = (m: Partial<Plan["money"]> = {}) => ({ planned: "0", collected: "0", at_cashier: "0", due: "0", waived: "0", ...m });
const P = (id: string, title: string, sessions: Session[], status = "active", extra: Partial<Plan> = {}) =>
  baseP(id, title, sessions, status, { money: money(), ...extra });

function panel(plans: Plan[], opts: { canCollect?: boolean; noNew?: boolean } = {}) {
  const onOpenVisit = vi.fn(), onNewPlan = vi.fn();
  const r = renderUI(
    <TreatmentsPanel patientId="pat_1" plans={plans} todayISO={T} canCollect={opts.canCollect ?? true}
      onOpenVisit={onOpenVisit} onNewPlan={opts.noNew ? undefined : onNewPlan} />,
  );
  return { ...r, onOpenVisit, onNewPlan };
}
/** The course cards on the list, in order. */
const cards = () => screen.getAllByRole("button").filter((b) => b.className.includes("shadow-sm"));
const card = (title: string) => cards().find((c) => c.textContent?.startsWith(title)) as HTMLElement;
const section = (heading: string) => screen.getByText(heading).closest("section") as HTMLElement;

describe("REG-FE-TREATMENTS the treatments panel", () => {
  beforeEach(() => {
    freezeToday(T);
    sessionStorage.clear();
    api.collectSession.mockReset();
    toast.success.mockReset(); toast.error.mockReset();
  });
  afterEach(() => vi.useRealTimers());

  test("REG-FE-TREATMENTS-023 no courses: explains what a course is; New treatment only when offered", async () => {
    const { user, onNewPlan, unmount } = panel([]);
    expect(screen.getByText("No treatment courses yet")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /New treatment/ }));
    expect(onNewPlan).toHaveBeenCalledTimes(1);
    unmount();
    panel([], { noNew: true });
    expect(screen.queryByRole("button", { name: /New treatment/ })).not.toBeInTheDocument();
  });

  test("REG-FE-TREATMENTS-024 list has a New button (when offered) that starts a course", async () => {
    const plans = [P("p1", "Crown", [S("a", "2026-08-20", 1)])];
    const { user, onNewPlan, unmount } = panel(plans);
    await user.click(screen.getByRole("button", { name: "New" }));
    expect(onNewPlan).toHaveBeenCalledTimes(1);
    unmount();
    panel(plans, { noNew: true });
    expect(screen.queryByRole("button", { name: "New" })).not.toBeInTheDocument();
  });

  test("REG-FE-TREATMENTS-025 a card: title, tooth, status, service, delivery, money and the next visit", () => {
    panel([P("p1", "Root canal", [
      S("a", "2026-08-01", 1, "done", { payment: "paid" }),
      S("b", T, 2),
      S("c", "2026-08-26", 3),
    ], "active", { tooth: "36", service_name: "RCT molar",
      money: money({ planned: "6000", collected: "2000", due: "1500", at_cashier: "500" }) })]);
    const c = card("Root canal");
    expect(c).toHaveTextContent("#36");
    expect(c).toHaveTextContent("Active");
    expect(c).toHaveTextContent("RCT molar");
    expect(c).toHaveTextContent("1 of 3 done");
    expect(c).toHaveTextContent("2,000 ETB of 6,000 ETB");
    expect(c).toHaveTextContent("1,500 ETB owed now");
    expect(c).toHaveTextContent("500 ETB with the cashier");
    expect(c).toHaveTextContent("next today");
    // One delivery segment per live visit: done, today, still to come.
    const segs = c.querySelectorAll("span.h-1\\.5");
    expect(Array.from(segs).map((s) => s.className.match(/bg-\S+/)![0])).toEqual(["bg-emerald-500", "bg-brand", "bg-muted"]);
  });

  test("REG-FE-TREATMENTS-026 a quiet card shows no owed / cashier / next lines and no flags", () => {
    panel([P("p1", "Cleaning", [S("a", "2026-08-01", 1, "done", { payment: "paid" })], "completed")]);
    const c = card("Cleaning");
    expect(c).toHaveTextContent("Completed");
    expect(c).not.toHaveTextContent(/owed now|with the cashier|next /);
    expect(c.querySelector(".border-t")).not.toBeInTheDocument();
  });

  test("REG-FE-TREATMENTS-027 flags: never billed, one missed visit, booked out of order", () => {
    panel([P("p1", "Ortho", [
      S("a", "2026-08-01", 1, "done", { payment: "unpaid", amount_due: "2000" }),
      S("b", "2026-08-05", 2),
      S("c", "2026-09-20", 3),
      S("d", "2026-09-10", 4),
    ])]);
    const c = card("Ortho");
    expect(c).toHaveTextContent("2,000 ETB delivered and never billed");
    expect(c).toHaveTextContent("visit 2 was missed on 2026-08-05");
    expect(c).toHaveTextContent("visit 4 is booked before visit 3");
    expect(c).not.toHaveTextContent("nothing booked");
    const segs = c.querySelectorAll("span.h-1\\.5");
    expect(segs[1]).toHaveClass("bg-rose-400");
  });

  test("REG-FE-TREATMENTS-028 flags: several missed, stalled (nothing booked), past its deadline", () => {
    panel([P("p1", "Bridge", [S("a", "2026-07-01", 1), S("b", "2026-07-15", 2)], "active", { deadline: "2026-08-01" })]);
    const c = card("Bridge");
    expect(c).toHaveTextContent("2 visits missed");
    expect(c).toHaveTextContent("2 visits left and nothing booked");
    expect(c).toHaveTextContent("past its 2026-08-01 deadline with visits outstanding");
  });

  test("REG-FE-TREATMENTS-029 flags: visits booked beyond the deadline; deposit owed counts as never billed", () => {
    panel([P("p1", "Implant", [S("a", "2026-08-20", 1), S("b", "2026-10-01", 2)], "active", {
      deadline: "2026-09-01",
      deposit: { id: "dep1", amount_due: "5000", payment: "unpaid", scheduled_date: "2026-08-01" },
    })]);
    const c = card("Implant");
    expect(c).toHaveTextContent("visits booked beyond the 2026-09-01 deadline");
    expect(c).toHaveTextContent("5,000 ETB delivered and never billed");
    expect(c).not.toHaveTextContent("past its");
  });

  test("REG-FE-TREATMENTS-030 a cancelled course raises no flags and is dimmed", () => {
    panel([P("p1", "Old", [S("a", "2026-07-01", 1)], "cancelled")]);
    const c = card("Old");
    expect(c).toHaveTextContent("Cancelled");
    expect(c).toHaveClass("opacity-60");
    expect(c).not.toHaveTextContent("missed");
  });

  test("REG-FE-TREATMENTS-031 order: active before completed before cancelled; flagged first; then soonest next", () => {
    panel([
      P("c1", "Cancelled one", [S("x", "2026-08-20", 1)], "cancelled"),
      P("d1", "Done one", [S("y", "2026-07-01", 1, "done", { payment: "paid" })], "completed"),
      P("late", "Active later", [S("l", "2026-09-30", 1)]),
      P("soon", "Active sooner", [S("s", "2026-08-14", 1)]),
      P("none", "Active unbooked", [S("n1", "2026-07-01", 1, "done", { payment: "paid" })]),
      P("bad", "Active flagged", [S("b", "2026-08-01", 1), S("b2", "2026-09-01", 2)]),
    ]);
    expect(cards().map((c) => c.querySelector("span.font-semibold")!.textContent)).toEqual([
      "Active flagged", "Active sooner", "Active later", "Active unbooked", "Done one", "Cancelled one",
    ]);
  });

  test("REG-FE-TREATMENTS-032 opening a course shows its detail and is remembered; back returns to the list", async () => {
    const plans = [P("p1", "Crown", [S("a", "2026-08-20", 1)]), P("p2", "Cleaning", [S("b", "2026-08-25", 1)])];
    const { user, unmount } = panel(plans);
    await user.click(card("Cleaning"));
    expect(screen.getByRole("heading", { level: 3, name: "Cleaning" })).toBeInTheDocument();
    expect(sessionStorage.getItem("dental-course:pat_1")).toBe("p2");
    unmount();
    const again = panel(plans);
    expect(screen.getByRole("heading", { level: 3, name: "Cleaning" })).toBeInTheDocument();
    await again.user.click(screen.getByRole("button", { name: /All treatments/ }));
    expect(screen.queryByRole("heading", { level: 3 })).not.toBeInTheDocument();
    expect(cards()).toHaveLength(2);
    expect(sessionStorage.getItem("dental-course:pat_1")).toBeNull();
  });

  test("REG-FE-TREATMENTS-033 a remembered course that no longer exists falls back to the list", () => {
    sessionStorage.setItem("dental-course:pat_1", "gone");
    panel([P("p1", "Crown", [S("a", "2026-08-20", 1)])]);
    expect(cards()).toHaveLength(1);
  });

  test("REG-FE-TREATMENTS-034 the terms: total, discount off list, per-visit range × count, cadence, list, due by, note", async () => {
    const { user } = panel([P("p1", "Ortho", [
      S("a", "2026-08-20", 1, "planned", { amount_due: "700" }),
      S("b", "2026-09-03", 2, "planned", { amount_due: "1700" }),
    ], "active", { total_amount: "14000", list_price: "15000", service_name: "Braces", interval_unit: "week",
      interval_count: 2, session_count: 20, deadline: "2027-01-01", note: "Pays on Fridays", tooth: "11" })]);
    await user.click(card("Ortho"));
    const terms = section("What was agreed");
    expect(terms).toHaveTextContent("14,000 ETB1,000 ETB off the list price");
    expect(terms).toHaveTextContent("700 ETB – 1,700 ETB × 20");
    expect(terms).toHaveTextContent("every 2 weeks");
    expect(terms).toHaveTextContent("Braces · listed at 15,000 ETB");
    expect(terms).toHaveTextContent("Due by");
    expect(terms).toHaveTextContent("Pays on Fridays");
    expect(screen.getByText("#11")).toBeInTheDocument();
  });

  test.each([
    ["day", 1, "daily"], ["week", 1, "weekly"], ["month", 1, "monthly"], ["day", 10, "every 10 days"],
  ])("REG-FE-TREATMENTS-035 cadence %s × %i reads '%s'; equal instalments show one amount; no list/deadline/note rows", async (unit, n, text) => {
    const { user } = panel([P("p1", "Course", [S("a", "2026-08-20", 1), S("b", "2026-09-20", 2)], "active",
      { interval_unit: unit, interval_count: n })]);
    await user.click(card("Course"));
    const terms = section("What was agreed");
    expect(terms).toHaveTextContent(`Scheduled${text}`);
    expect(terms).toHaveTextContent("Per visit2,000 ETB × 2");
    expect(terms).not.toHaveTextContent(/off the list price|From the list|Due by|Note/);
  });

  test("REG-FE-TREATMENTS-036 a course with no visits states its total as the per-visit figure; default cadence is weekly", async () => {
    const { user } = panel([P("p1", "Empty", [], "active", { total_amount: "3000", interval_unit: "", interval_count: 0 })]);
    await user.click(card("Empty"));
    expect(section("What was agreed")).toHaveTextContent("Per visit3,000 ETB × 0");
    expect(section("What was agreed")).toHaveTextContent("Scheduledweekly");
  });

  test("REG-FE-TREATMENTS-037 money on the course: planned, collected, still to pay, owed now, cashier and waived lines", async () => {
    const { user } = panel([P("p1", "Crown", [S("a", "2026-08-20", 1)], "active", {
      money: money({ planned: "10000", collected: "3000", at_cashier: "1000", due: "2000", waived: "500" }),
    })]);
    await user.click(card("Crown"));
    const m = section("Money on this course");
    expect(m).toHaveTextContent("Planned10,000 ETB");
    expect(m).toHaveTextContent("Collected3,000 ETB");
    expect(m).toHaveTextContent("Still to pay6,000 ETB");
    expect(m).toHaveTextContent("Owed now2,000 ETB");
    expect(within(m).getByText("2,000 ETB")).toHaveClass("text-destructive");
    expect(m).toHaveTextContent("1,000 ETB with the cashier — deliberately not counted as owed");
    expect(m).toHaveTextContent("500 ETB written off");
  });

  test("REG-FE-TREATMENTS-038 still to pay never goes negative and no cashier/waived line when there is none", async () => {
    const { user } = panel([P("p1", "Crown", [S("a", "2026-08-20", 1)], "active", {
      money: money({ planned: "1000", collected: "1500" }),
    })]);
    await user.click(card("Crown"));
    const m = section("Money on this course");
    expect(m).toHaveTextContent("Still to pay0 ETB");
    expect(m).not.toHaveTextContent(/with the cashier|written off/);
    expect(within(m).getByText("Owed now").nextElementSibling).not.toHaveClass("text-destructive");
  });

  test("REG-FE-TREATMENTS-039 unbilled work in the course can be sent to the cashier (exact session)", async () => {
    api.collectSession.mockResolvedValue({});
    const { user } = panel([P("p1", "Crown", [
      S("a", "2026-08-01", 1, "done", { payment: "unpaid", amount_due: "2000",
        extras: [{ id: "ex1", amount_due: "800", payment: "unpaid", status: "done", service_name: "X-ray" }] }),
    ])]);
    await user.click(card("Crown"));
    const m = section("Money on this course");
    expect(m).toHaveTextContent("visit 1 of 1");
    expect(m).toHaveTextContent("X-ray added at visit 1");
    const sends = within(m).getAllByRole("button", { name: "Send to cashier" });
    expect(sends).toHaveLength(2);
    await user.click(sends[1]);
    await waitFor(() => expect(api.collectSession).toHaveBeenCalledWith("pat_1", "ex1"));
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith("Sent to the cashier"));
  });

  test("REG-FE-TREATMENTS-040 a refused send toasts the server's reason", async () => {
    api.collectSession.mockRejectedValue(new AppError(409, "conflict", "Already billed"));
    const { user } = panel([P("p1", "Crown", [S("a", "2026-08-01", 1, "done", { payment: "unpaid" })])]);
    await user.click(card("Crown"));
    await user.click(within(section("Money on this course")).getByRole("button", { name: "Send to cashier" }));
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith("Already billed"));
  });

  test("REG-FE-TREATMENTS-041 an unpaid down payment shows its callout; without permission, no send buttons", async () => {
    api.collectSession.mockResolvedValue({});
    const plan = P("p1", "Implant", [S("a", "2026-08-01", 1, "done", { payment: "unpaid" })], "active", {
      deposit: { id: "dep1", amount_due: "5000", payment: "unpaid", scheduled_date: "2026-08-01" },
    });
    const { user, unmount } = panel([plan]);
    await user.click(card("Implant"));
    const m = section("Money on this course");
    expect(m).toHaveTextContent("Down payment 5,000 ETB is due before this course starts");
    // The down payment's own button, then the visit's.
    await user.click(within(m).getAllByRole("button", { name: /Send to cashier/ })[0]);
    await waitFor(() => expect(api.collectSession).toHaveBeenCalledWith("pat_1", "dep1"));
    unmount();
    sessionStorage.clear();
    const ro = panel([plan], { canCollect: false });
    await ro.user.click(card("Implant"));
    expect(section("Money on this course")).toHaveTextContent("Down payment 5,000 ETB");
    expect(within(section("Money on this course")).queryByRole("button")).not.toBeInTheDocument();
  });

  test("REG-FE-TREATMENTS-042 visits in course order: dot, number, fee, state, procedure, tooth, attachments, out-of-order note", async () => {
    const { user, onOpenVisit } = panel([P("p1", "Ortho", [
      S("s2", "2026-08-05", 2, "planned"),
      S("s1", "2026-08-01", 1, "done", { payment: "paid", procedure: "Bracket fit", tooth: "11", notes: "ok",
        images: [{}, {}] as never, prescriptions: [{}] as never,
        extras: [{ id: "e", amount_due: "0", payment: "paid", status: "done" }] }),
      S("s3", T, 3, "planned", { service_name: "Adjustment" }),
      S("s4", "2026-09-30", 4),
      S("s5", "2026-09-01", 5),
      S("sx", "2026-08-02", 6, "cancelled"),
    ])]);
    await user.click(card("Ortho"));
    const v = section("Visits · in course order");
    const rows = within(v).getAllByRole("button");
    expect(rows.map((r) => r.querySelector("span.w-6")!.textContent)).toEqual(["1", "2", "3", "4", "5"]);
    expect(rows[0].firstElementChild).toHaveClass("bg-emerald-500");
    expect(rows[1].firstElementChild).toHaveClass("bg-rose-500");
    expect(rows[2].firstElementChild).toHaveClass("bg-brand");
    expect(rows[3].firstElementChild).toHaveClass("bg-border");
    expect(rows[0]).toHaveTextContent("Paid");
    expect(rows[0]).toHaveTextContent("Bracket fit · #11");
    expect(rows[0]).toHaveTextContent("21note+ 1 extra");
    expect(rows[2]).toHaveTextContent("Adjustment");
    expect(rows[4]).toHaveTextContent("booked before visit 4");
    expect(rows[3]).not.toHaveTextContent("booked before");
    await user.click(rows[2]);
    expect(onOpenVisit).toHaveBeenCalledWith("s3");
    // Attachments are counted for the whole course.
    expect(section("On this course")).toHaveTextContent("2 images · 1 prescription — open the visit to see them.");
  });

  test("REG-FE-TREATMENTS-043 the 'On this course' line: singular image only, plural prescriptions only, or absent", async () => {
    const one = panel([P("p1", "A", [S("a", "2026-08-20", 1, "planned", { images: [{}] as never })])]);
    await one.user.click(card("A"));
    expect(section("On this course")).toHaveTextContent(/^On this course1 image — open/);
    one.unmount(); sessionStorage.clear();
    const two = panel([P("p1", "B", [S("a", "2026-08-20", 1, "planned", { prescriptions: [{}, {}] as never })])]);
    await two.user.click(card("B"));
    expect(section("On this course")).toHaveTextContent(/^On this course2 prescriptions — open/);
    two.unmount(); sessionStorage.clear();
    const none = panel([P("p1", "C", [S("a", "2026-08-20", 1)])]);
    await none.user.click(card("C"));
    expect(screen.queryByText("On this course")).not.toBeInTheDocument();
  });

  test("REG-FE-TREATMENTS-044 the detail repeats the course's flags", async () => {
    const { user } = panel([P("p1", "Bridge", [S("a", "2026-07-01", 1)])]);
    await user.click(card("Bridge"));
    expect(screen.getByText(/visit 1 was missed on 2026-07-01/)).toBeInTheDocument();
    expect(screen.getByText(/1 visits left and nothing booked/)).toBeInTheDocument();
  });
});
