// The front desk's action strip on a dental patient: what is owed now (visits given,
// the down payment, extras), what can be paid in advance, the visits that were
// missed, and the two things it does about them — send a selection to the cashier,
// and rebook a missed visit.
import { screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

const api = vi.hoisted(() => ({ collectSessions: vi.fn(), rescheduleSession: vi.fn() }));
const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }));
vi.mock("@/features/dental/api", async (orig) => ({ ...(await orig<object>()), ...api }));
vi.mock("sonner", async (orig) => ({ ...(await orig<object>()), toast }));
vi.mock("@/lib/api-client", async (orig) => {
  const { quietApiFetch } = await import("@/test/render");
  return { ...(await orig<object>()), apiFetch: vi.fn(quietApiFetch) };
});

import { DeskActions } from "@/features/dental/desk/DeskActions";
import type { Plan } from "@/features/dental/api";
import { AppError } from "@/lib/api-client";
import { freezeToday, renderUI } from "@/test/render";
import { P, S } from "../../visit/__tests__/fixtures";

const T = "2026-08-12";

function desk(plans: Plan[], opts: { canCollect?: boolean; canReschedule?: boolean } = {}) {
  const onChanged = vi.fn();
  const r = renderUI(
    <DeskActions patientId="pat_1" plans={plans} todayISO={T}
      canCollect={opts.canCollect ?? true} canReschedule={opts.canReschedule ?? true} onChanged={onChanged} />,
  );
  return { ...r, onChanged };
}

/** One course: visit 1 given and unpaid, visit 2 today-ish future, plus a 5,000 down payment. */
const course = (extra: Partial<Plan> = {}) =>
  P("p1", "Root canal", [
    S("s1", "2026-08-10", 1, "done"),
    S("s2", "2026-09-12", 2),
    S("s3", "2026-10-12", 3),
  ], "active", { deposit: { id: "d1", amount_due: "5000", payment: "unpaid", scheduled_date: "2026-08-01" }, ...extra });

const takePayment = () => screen.getByRole("dialog", { name: "Take payment" });
const row = (dlg: HTMLElement, label: RegExp) =>
  within(dlg).getAllByRole("button").find((b) => label.test(b.textContent ?? ""))!;

describe("REG-FE-DESK the desk's action strip", () => {
  beforeEach(() => {
    freezeToday(T);
    Object.values(api).forEach((f) => { f.mockReset(); f.mockResolvedValue({}); });
    toast.success.mockReset(); toast.error.mockReset();
  });
  afterEach(() => vi.useRealTimers());

  test("REG-FE-DESK-001 renders nothing for someone who can neither collect nor reschedule", () => {
    const { container } = desk([course()], { canCollect: false, canReschedule: false });
    expect(container.querySelector(".rounded-lg, [class*=card]")).toBeNull();
    expect(screen.queryByText(/owed now/)).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Take payment/ })).not.toBeInTheDocument();
  });

  test("REG-FE-DESK-002 renders nothing when there is nothing billable and nothing missed", () => {
    desk([P("p1", "Cleaning", [S("s1", "2026-08-01", 1, "done", { payment: "paid" }), S("s2", "2026-09-01", 2, "planned", { amount_due: "0" })])]);
    expect(screen.queryByRole("button", { name: /Take payment/ })).not.toBeInTheDocument();
    expect(screen.queryByText(/missed visit/)).not.toBeInTheDocument();
  });

  test("REG-FE-DESK-003 owed now: a given visit plus the unpaid down payment, totalled and named", () => {
    desk([course()]);
    expect(screen.getByText("7,000 ETB owed now")).toBeInTheDocument();
    expect(screen.getByText(/· down payment, visit 1/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Take payment/ })).toBeInTheDocument();
  });

  test("REG-FE-DESK-004 nothing owed yet: future visits can be paid in advance (plural and singular)", () => {
    const { unmount } = desk([P("p1", "Braces", [S("s1", "2026-09-01", 1), S("s2", "2026-10-01", 2)])]);
    expect(screen.getByText("Nothing owed yet · 2 future visits can be paid in advance")).toBeInTheDocument();
    unmount();
    desk([P("p1", "Braces", [S("s1", "2026-09-01", 1)])]);
    expect(screen.getByText("Nothing owed yet · 1 future visit can be paid in advance")).toBeInTheDocument();
  });

  test("REG-FE-DESK-005 a down payment already paid or at the cashier is not owed, nor billable", () => {
    desk([
      P("p1", "Implant", [S("s1", "2026-09-01", 1)], "active", { deposit: { id: "d1", amount_due: "5000", payment: "billed", scheduled_date: T } }),
      P("p2", "Crown", [S("s2", "2026-09-02", 1)], "active", { deposit: { id: "d2", amount_due: "3000", payment: "paid", scheduled_date: T } }),
    ]);
    expect(screen.queryByText(/owed now/)).not.toBeInTheDocument();
    expect(screen.getByText(/2 future visits can be paid in advance/)).toBeInTheDocument();
  });

  test("REG-FE-DESK-006 an extra given at a visit is owed and named; cancelled extras, sessions and plans are left out", () => {
    desk([
      P("p1", "Root canal", [
        S("s1", "2026-08-10", 1, "done", { payment: "paid", extras: [
          { id: "x1", amount_due: "800", payment: "unpaid", status: "done", service_name: "X-ray" },
          { id: "x2", amount_due: "999", payment: "unpaid", status: "cancelled", service_name: "Gone" },
        ] }),
        S("s2", "2026-08-11", 2, "cancelled"),
      ]),
      P("p2", "Dropped", [S("s9", "2026-08-01", 1, "done")], "cancelled"),
    ]);
    expect(screen.getByText("800 ETB owed now")).toBeInTheDocument();
    expect(screen.getByText(/· extra$/)).toBeInTheDocument();
    // The cancelled visit in the past is not "missed".
    expect(screen.queryByText(/missed visit/)).not.toBeInTheDocument();
  });

  test("REG-FE-DESK-007 a refunded visit is owed again and badged Refunded in the dialog", async () => {
    const { user } = desk([P("p1", "Filling", [S("s1", "2026-08-01", 1, "done", { payment: "refunded", amount_due: "1500" })])]);
    expect(screen.getByText("1,500 ETB owed now")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /Take payment/ }));
    const dlg = takePayment();
    expect(within(dlg).getByText("Refunded")).toBeInTheDocument();
    expect(within(dlg).queryByText("Owed now")).not.toBeInTheDocument();
    expect(within(dlg).getByText("1 selected")).toBeInTheDocument();
  });

  test("REG-FE-DESK-008 the dialog ticks only what is owed by default, with the total; a deposit shows no date", async () => {
    const { user } = desk([course()]);
    await user.click(screen.getByRole("button", { name: /Take payment/ }));
    const dlg = takePayment();
    expect(within(dlg).getByText("2 selected")).toBeInTheDocument();
    expect(within(dlg).getByText("7,000 ETB", { selector: "span.text-base" })).toBeInTheDocument();
    expect(within(dlg).getAllByText("Owed now")).toHaveLength(2);
    // Four rows: down payment + three visits.
    expect(within(dlg).getByText("Root canal · down payment")).toBeInTheDocument();
    expect(within(dlg).getByText("Root canal · visit 3")).toBeInTheDocument();
    const dep = row(dlg, /down payment/);
    expect(dep.querySelectorAll(".text-xs.text-muted-foreground")).toHaveLength(0);
    const v1 = row(dlg, /visit 1/);
    expect(v1.querySelectorAll(".text-xs.text-muted-foreground").length).toBeGreaterThan(0);
  });

  test("REG-FE-DESK-009 ticking a future visit adds it; unticking everything disables Send", async () => {
    const { user } = desk([course()]);
    await user.click(screen.getByRole("button", { name: /Take payment/ }));
    const dlg = takePayment();
    await user.click(row(dlg, /visit 2/));
    expect(within(dlg).getByText("3 selected")).toBeInTheDocument();
    expect(within(dlg).getByText("9,000 ETB", { selector: "span.text-base" })).toBeInTheDocument();
    await user.click(row(dlg, /visit 2/));
    await user.click(row(dlg, /visit 1/));
    await user.click(row(dlg, /down payment/));
    expect(within(dlg).getByText("0 selected")).toBeInTheDocument();
    expect(within(dlg).getByRole("button", { name: /Send to cashier/ })).toBeDisabled();
  });

  test("REG-FE-DESK-010 Send to cashier posts exactly the ticked ids, toasts the result, refreshes and closes", async () => {
    api.collectSessions.mockResolvedValue({ billed: 3, total: "9000" });
    const { user, onChanged } = desk([course()]);
    await user.click(screen.getByRole("button", { name: /Take payment/ }));
    const dlg = takePayment();
    await user.click(row(dlg, /visit 2/));
    await user.click(within(dlg).getByRole("button", { name: /Send to cashier/ }));
    await waitFor(() => expect(api.collectSessions).toHaveBeenCalledWith("pat_1", ["d1", "s1", "s2"]));
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith("3 visits sent to the cashier · 9,000 ETB"));
    expect(onChanged).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Take payment" })).not.toBeInTheDocument());
  });

  test("REG-FE-DESK-011 a single billed visit reads in the singular", async () => {
    api.collectSessions.mockResolvedValue({ billed: 1, total: "2000" });
    const { user } = desk([P("p1", "Filling", [S("s1", "2026-08-01", 1, "done")])]);
    await user.click(screen.getByRole("button", { name: /Take payment/ }));
    await user.click(within(takePayment()).getByRole("button", { name: /Send to cashier/ }));
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith("1 visit sent to the cashier · 2,000 ETB"));
  });

  test("REG-FE-DESK-012 the server's refusal is toasted verbatim and the dialog stays open", async () => {
    api.collectSessions.mockRejectedValue(new AppError(409, "conflict", "Already at the cashier"));
    const { user, onChanged } = desk([course()]);
    await user.click(screen.getByRole("button", { name: /Take payment/ }));
    await user.click(within(takePayment()).getByRole("button", { name: /Send to cashier/ }));
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith("Already at the cashier"));
    expect(onChanged).not.toHaveBeenCalled();
    expect(takePayment()).toBeInTheDocument();
  });

  test("REG-FE-DESK-013 a network failure gets a plain message", async () => {
    api.collectSessions.mockRejectedValue(new TypeError("Failed to fetch"));
    const { user } = desk([course()]);
    await user.click(screen.getByRole("button", { name: /Take payment/ }));
    await user.click(within(takePayment()).getByRole("button", { name: /Send to cashier/ }));
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith("Could not send to the cashier"));
  });

  test("REG-FE-DESK-014 Send is disabled while the request is in flight (no double billing)", async () => {
    api.collectSessions.mockReturnValue(new Promise(() => {}));
    const { user } = desk([course()]);
    await user.click(screen.getByRole("button", { name: /Take payment/ }));
    const send = within(takePayment()).getByRole("button", { name: /Send to cashier/ });
    await user.click(send);
    await waitFor(() => expect(send).toBeDisabled());
    await user.click(send);
    expect(api.collectSessions).toHaveBeenCalledTimes(1);
  });

  test("REG-FE-DESK-015 Cancel closes the dialog without billing", async () => {
    const { user } = desk([course()]);
    await user.click(screen.getByRole("button", { name: /Take payment/ }));
    await user.click(within(takePayment()).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(api.collectSessions).not.toHaveBeenCalled();
  });

  test("REG-FE-DESK-016 missed visits: every one listed with its amount, plural count, Rebook on each", () => {
    desk([P("p1", "Braces", [
      S("s1", "2026-06-01", 1), S("s2", "2026-07-01", 2), S("s3", "2026-07-15", 3), S("s4", "2026-08-01", 4, "planned", { amount_due: "750" }),
      S("s5", "2026-09-01", 5),
    ])]);
    expect(screen.getByText(/4 missed visits — nothing was recorded on the day/)).toBeInTheDocument();
    for (const n of [1, 2, 3, 4]) expect(screen.getByText(`Braces · visit ${n}`)).toBeInTheDocument();
    expect(screen.queryByText("Braces · visit 5")).not.toBeInTheDocument();
    expect(screen.getByText("750 ETB")).toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: /Rebook/ })).toHaveLength(4);
  });

  test("REG-FE-DESK-017 one missed visit reads singular; a visit booked today is not missed", () => {
    desk([P("p1", "Filling", [S("s1", "2026-08-01", 1), S("s2", T, 2)])]);
    expect(screen.getByText(/1 missed visit — nothing/)).toBeInTheDocument();
    expect(screen.queryByText("Filling · visit 2")).not.toBeInTheDocument();
  });

  test("REG-FE-DESK-018 without reschedule rights the missed list shows but no Rebook", () => {
    desk([P("p1", "Filling", [S("s1", "2026-08-01", 1)])], { canReschedule: false });
    expect(screen.getByText(/1 missed visit/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Rebook/ })).not.toBeInTheDocument();
  });

  test("REG-FE-DESK-019 without collect rights: no payment card, missed visits still rebookable", () => {
    desk([course({ sessions: [S("s1", "2026-08-01", 1, "done"), S("s2", "2026-08-05", 2)] })], { canCollect: false });
    expect(screen.queryByRole("button", { name: /Take payment/ })).not.toBeInTheDocument();
    expect(screen.queryByText(/owed now/)).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Rebook/ })).toBeInTheDocument();
  });

  test("REG-FE-DESK-020 Rebook opens the reschedule dialog for that visit, marked missed, and moves it", async () => {
    api.rescheduleSession.mockResolvedValue(undefined);
    const { user, onChanged } = desk([P("p1", "Braces", [S("s1", "2026-08-01", 1), S("s2", "2026-09-01", 2)])]);
    await user.click(screen.getByRole("button", { name: /Rebook/ }));
    const dlg = screen.getByRole("dialog", { name: "Reschedule visit 1" });
    expect(within(dlg).getByText(/Session 1 of 2/)).toBeInTheDocument();
    expect(within(dlg).getByText(/missed 11 days ago/)).toBeInTheDocument();
    await user.click(within(dlg).getByRole("button", { name: "In 3 days" }));
    await user.click(within(dlg).getByRole("button", { name: /Move session/ }));
    await waitFor(() => expect(api.rescheduleSession).toHaveBeenCalledWith("pat_1", "s1", "2026-08-15"));
    await waitFor(() => expect(onChanged).toHaveBeenCalled());
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
  });

  test("REG-FE-DESK-021 the rebook dialog warns of another visit already on the chosen day, and says when it was done", async () => {
    const { user } = desk([
      P("p1", "Braces", [S("s1", "2026-08-01", 1), S("s2", "2026-08-19", 2)]),
      P("p2", "Cleaning", [S("c1", "2026-08-19", 1, "done", { payment: "paid" })]),
    ]);
    await user.click(screen.getByRole("button", { name: /Rebook/ }));
    const dlg = screen.getByRole("dialog", { name: "Reschedule visit 1" });
    await user.click(within(dlg).getByRole("button", { name: "Next week" }));
    expect(within(dlg).getByText("There are already 2 sessions that day")).toBeInTheDocument();
    expect(within(dlg).getByText("Braces · visit 2")).toBeInTheDocument();
    expect(within(dlg).getByText("Cleaning · visit 1 (done)")).toBeInTheDocument();
    await user.click(within(dlg).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(api.rescheduleSession).not.toHaveBeenCalled();
  });
});
