// Work done and never billed. The selector decides what counts as owed (a done visit,
// an extra, optionally the deposit — never a booked visit, never twice); the callout
// and the rows show it with the one button that bills it.
import { screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, test, vi } from "vitest";

const api = vi.hoisted(() => ({ collectSession: vi.fn() }));
const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }));
vi.mock("@/features/dental/api", async (orig) => ({ ...(await orig<object>()), ...api }));
vi.mock("sonner", async (orig) => ({ ...(await orig<object>()), toast }));

import {
  UnbilledCallout, UnbilledRows, coveredByCockpit, owedForPatient, owedOnPlan, owedTotal, type OwedItem,
} from "@/features/dental/shared/UnbilledWork";
import { AppError } from "@/lib/api-client";
import type { Plan, Session } from "@/features/dental/api";
import { renderUI } from "@/test/render";
import { P, S } from "../../visit/__tests__/fixtures";

const T = "2026-08-12";
const EX = (id: string, extra: Record<string, unknown> = {}) =>
  ({ id, amount_due: "2000", payment: "unpaid", status: "done", service_name: "X-ray", ...extra });
const withDeposit = (plan: Plan, payment: string, amount = "20000") =>
  ({ ...plan, deposit: { id: "dep_1", amount_due: amount, payment, scheduled_date: T } }) as Plan;

const item = (sessionId: string, extra: Partial<OwedItem> = {}): OwedItem => ({
  sessionId, planId: "p1", planStart: "2026-01-05", planTitle: "Root canal", openSessionId: `open_${sessionId}`,
  label: `visit 1 of 3`, amount: "700", refunded: false, ...extra,
});

describe("REG-FE-SHARED what has not been billed", () => {
  beforeEach(() => {
    api.collectSession.mockReset();
    api.collectSession.mockResolvedValue({});
    Object.values(toast).forEach((f) => f.mockReset());
  });

  test("REG-FE-SHARED-028 owedOnPlan: a done unbilled visit is owed; a booked, paid or at-cashier one is not", () => {
    const plan = P("p1", "Root canal", [
      S("s1", T, 1, "done"),
      S("s2", T, 2, "planned"),
      S("s3", T, 3, "done", { payment: "paid" }),
      S("s4", T, 4, "done", { payment: "billed" }),
      S("s5", T, 5, "done", { payment: "refunded" }),
      S("s6", T, 6, "cancelled"),
    ], "active", { start_date: "2026-01-05" } as Partial<Plan>);
    const out = owedOnPlan(plan);
    expect(out.map((o) => o.sessionId)).toEqual(["s1", "s5"]);
    expect(out[0]).toEqual({
      sessionId: "s1", planId: "p1", planStart: "2026-01-05", openSessionId: "s1", planTitle: "Root canal",
      label: "visit 1 of 6", amount: "2000", refunded: false,
    });
    expect(out[1].refunded).toBe(true);
  });

  test("REG-FE-SHARED-029 owedOnPlan: extras are owed even on a paid visit; cancelled, free or settled extras are not", () => {
    const plan = P("p1", "Root canal", [
      S("s1", T, 3, "done", {
        payment: "paid",
        extras: [EX("e1"), EX("e2", { status: "cancelled" }), EX("e3", { amount_due: "0" }), EX("e4", { payment: "paid" }),
          EX("e5", { service_name: "", payment: "refunded" })],
      } as Partial<Session>),
      // Extras on a planned visit are still owed: the work was agreed.
      S("s2", T, 4, "planned", { extras: [EX("e6")] } as Partial<Session>),
    ]);
    const out = owedOnPlan(plan);
    expect(out.map((o) => [o.sessionId, o.label, o.openSessionId, o.refunded])).toEqual([
      ["e1", "X-ray added at visit 3", "s1", false],
      ["e5", "extra treatment added at visit 3", "s1", true],
      ["e6", "X-ray added at visit 4", "s2", false],
    ]);
  });

  test("REG-FE-SHARED-030 owedOnPlan: the deposit counts only when asked for, and only while unpaid or refunded", () => {
    const base = P("p1", "Root canal", [S("s0", T, 1, "cancelled"), S("s1", T, 2)]);
    expect(owedOnPlan(withDeposit(base, "unpaid"))).toEqual([]);
    const [dep] = owedOnPlan(withDeposit(base, "unpaid"), { withDeposit: true });
    // It opens the first visit that is still going ahead.
    expect(dep).toMatchObject({ sessionId: "dep_1", label: "down payment", amount: "20000", openSessionId: "s1", refunded: false });
    expect(owedOnPlan(withDeposit(base, "refunded"), { withDeposit: true })[0].refunded).toBe(true);
    for (const pay of ["paid", "billed", "waived"]) expect(owedOnPlan(withDeposit(base, pay), { withDeposit: true })).toEqual([]);
    expect(owedOnPlan(withDeposit(base, "unpaid", "0"), { withDeposit: true })).toEqual([]);
    expect(owedOnPlan(withDeposit(base, "unpaid"), { withDeposit: true, exclude: new Set(["dep_1"]) })).toEqual([]);
    expect(owedOnPlan(base, { withDeposit: true })).toEqual([]);
  });

  test("REG-FE-SHARED-031 owedOnPlan: excluded ids are never listed twice, and a cancelled course owes nothing", () => {
    const plan = P("p1", "RCT", [S("s1", T, 1, "done", { extras: [EX("e1")] } as Partial<Session>), S("s2", T, 2, "done")]);
    expect(owedOnPlan(plan, { exclude: new Set(["s1", "e1"]) }).map((o) => o.sessionId)).toEqual(["s2"]);
    expect(owedOnPlan({ ...plan, status: "cancelled" } as Plan)).toEqual([]);
  });

  test("REG-FE-SHARED-032 owedForPatient covers every course; coveredByCockpit names the visit, its extras and the deposit; owedTotal adds up", () => {
    const a = P("pa", "A", [S("a1", T, 1, "done")]);
    const b = withDeposit(P("pb", "B", [S("b1", T, 1, "done")]), "unpaid", "500");
    expect(owedForPatient([a, b], { withDeposit: true }).map((o) => o.sessionId)).toEqual(["a1", "dep_1", "b1"]);
    const s = S("s1", T, 1, "done", { extras: [EX("e1"), EX("e2")] } as Partial<Session>);
    expect([...coveredByCockpit(s, b)]).toEqual(["s1", "e1", "e2", "dep_1"]);
    expect([...coveredByCockpit(S("s9", T, 1), a)]).toEqual(["s9"]);
    expect(owedTotal([item("x", { amount: "700" }), item("y", { amount: "1300.5" })])).toBe(2000.5);
    expect(owedTotal([])).toBe(0);
  });

  test("REG-FE-SHARED-033 the callout is absent when nothing is owed", () => {
    renderUI(<UnbilledCallout patientId="pat_1" items={[]} canCollect />);
    expect(screen.queryByText(/has not been billed/)).not.toBeInTheDocument();
  });

  test("REG-FE-SHARED-034 the callout totals what is owed and lists each item with its course and amount", () => {
    renderUI(<UnbilledCallout patientId="pat_1" canCollect items={[
      item("a", { amount: "700" }), item("b", { label: "X-ray added at visit 3", amount: "2000", refunded: true }),
    ]} />);
    expect(screen.getByText("2,700 ETB has not been billed")).toBeInTheDocument();
    expect(screen.getByText(/Sending it to\s+the desk is what turns it into money/)).toBeInTheDocument();
    expect(screen.getByText("X-ray added at visit 3")).toBeInTheDocument();
    expect(screen.getAllByText("Root canal ·")).toHaveLength(2);
    expect(screen.getByText("700 ETB")).toBeInTheDocument();
    expect(screen.getByText("Refunded — owed again")).toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: /Send to cashier/ })).toHaveLength(2);
  });

  test("REG-FE-SHARED-035 a debt on another course is marked as such, with its start date (or 'an earlier date')", () => {
    renderUI(<UnbilledCallout patientId="pat_1" canCollect={false} focusedPlanId="p1" items={[
      item("a"), item("b", { planId: "p2" }), item("c", { planId: "p3", planStart: "" }),
    ]} />);
    const marks = screen.getAllByText(/another treatment · from/);
    expect(marks).toHaveLength(2);
    expect(marks[0]).toHaveTextContent(`another treatment · from ${new Date("2026-01-05").toLocaleDateString(undefined, { day: "numeric", month: "short" })}`);
    expect(marks[1]).toHaveTextContent("another treatment · from an earlier date");
  });

  test("REG-FE-SHARED-036 a row opens the visit it is for; without onOpen (or a visit) it is plain text", async () => {
    const onOpen = vi.fn();
    const { user, unmount } = renderUI(<UnbilledCallout patientId="pat_1" canCollect={false} onOpen={onOpen}
      items={[item("a"), item("b", { openSessionId: undefined, label: "down payment" })]} />);
    const rows = screen.getAllByTitle("Open this visit");
    expect(rows).toHaveLength(1);
    await user.click(rows[0]);
    expect(onOpen).toHaveBeenCalledWith("open_a");
    unmount();
    renderUI(<UnbilledCallout patientId="pat_1" canCollect={false} items={[item("a")]} />);
    expect(screen.queryByTitle("Open this visit")).not.toBeInTheDocument();
  });

  test("REG-FE-SHARED-037 without billing permission there is no Send to cashier", () => {
    renderUI(<UnbilledCallout patientId="pat_1" canCollect={false} compact items={[item("a")]} />);
    expect(screen.getByText("700 ETB has not been billed")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Send to cashier/ })).not.toBeInTheDocument();
  });

  test("REG-FE-SHARED-038 Send to cashier bills that row only, shows pending on that row only, and refreshes", async () => {
    let resolve!: () => void;
    api.collectSession.mockReturnValue(new Promise<void>((r) => { resolve = r; }));
    const { user, qc } = renderUI(<UnbilledCallout patientId="pat_1" canCollect items={[item("a"), item("b")]} />);
    const inv = vi.spyOn(qc, "invalidateQueries");
    const [first, second] = screen.getAllByRole("button", { name: /Send to cashier/ });
    await user.click(second);
    await waitFor(() => expect(api.collectSession).toHaveBeenCalledWith("pat_1", "b"));
    await waitFor(() => expect(second).toBeDisabled());
    expect(first).toBeEnabled();
    resolve();
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith("Sent to the cashier"));
    expect(inv).toHaveBeenCalledWith({ queryKey: ["dental-unbilled"] });
  });

  test("REG-FE-SHARED-039 a refused send says why (or a fallback)", async () => {
    api.collectSession.mockRejectedValueOnce(new AppError(409, "C", "Already billed")).mockRejectedValueOnce(new Error("x"));
    const { user } = renderUI(<UnbilledCallout patientId="pat_1" canCollect items={[item("a")]} />);
    await user.click(screen.getByRole("button", { name: /Send to cashier/ }));
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith("Already billed"));
    await user.click(screen.getByRole("button", { name: /Send to cashier/ }));
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith("Could not send it to the cashier"));
  });

  test("REG-FE-SHARED-040 the money-panel rows: label, amount, Owed now or Refunded, and a working send", async () => {
    const { user } = renderUI(<UnbilledRows patientId="pat_1" canCollect items={[
      item("a", { label: "visit 2 of 5" }), item("b", { label: "X-ray added at visit 3", refunded: true, amount: "2000" }),
    ]} />);
    expect(screen.getByText("visit 2 of 5")).toBeInTheDocument();
    expect(screen.getByText("Owed now")).toBeInTheDocument();
    expect(screen.getByText("Refunded — owed again")).toBeInTheDocument();
    expect(screen.getByText("2,000 ETB")).toBeInTheDocument();
    await user.click(screen.getAllByRole("button", { name: /Send to cashier/ })[1]);
    await waitFor(() => expect(api.collectSession).toHaveBeenCalledWith("pat_1", "b"));
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith("Sent to the cashier"));
  });

  test("REG-FE-SHARED-041 the rows are absent when nothing is owed and have no button without permission", () => {
    const a = renderUI(<UnbilledRows patientId="pat_1" canCollect items={[]} />);
    expect(screen.queryByText("Owed now")).not.toBeInTheDocument();
    a.unmount();
    renderUI(<UnbilledRows patientId="pat_1" canCollect={false} items={[item("a")]} />);
    expect(screen.getByText("Owed now")).toBeInTheDocument();
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
  });
});
