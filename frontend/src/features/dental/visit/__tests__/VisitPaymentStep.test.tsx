// The fee, asked before the treatment notes. feeStage decides which of four steps
// the visit is on; each step offers only what makes sense there, and every action
// reaches the API with the right visit.
import { screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

const api = vi.hoisted(() => ({
  collectSession: vi.fn(), uncollectSession: vi.fn(), setPayLater: vi.fn(), repriceSession: vi.fn(),
}));
vi.mock("@/features/dental/api", async (orig) => ({ ...(await orig<object>()), ...api }));

import { FeeStrip, VisitPaymentStep, feeResolved, feeStage, respreadPool } from "@/features/dental/visit/VisitPaymentStep";
import type { Plan, Session } from "@/features/dental/api";
import { freezeToday, renderUI } from "@/test/render";
import { P, S } from "./fixtures";

const T = "2026-08-12";

function step(session: Session, opts: { canCollect?: boolean; plan?: Plan } = {}) {
  const plan = opts.plan ?? P("p1", "Root canal", [S("s1", "2026-08-01", 1, "done", { payment: "paid" }), session, S("s3", "2026-09-12", 3)]);
  const onChanged = vi.fn();
  const r = renderUI(
    <VisitPaymentStep patientId="pat_1" plan={plan} session={session} canCollect={opts.canCollect ?? true}
      editable onChanged={onChanged} />,
  );
  return { ...r, onChanged };
}
/** The confirming button of a ConfirmDialog, not its X. */
const confirmIn = (dlg: HTMLElement, name: string) =>
  within(dlg).getAllByRole("button", { name }).find((b) => b.textContent === name)!;

describe("REG-FE-FEE the visit's fee", () => {
  beforeEach(() => {
    freezeToday(T);
    Object.values(api).forEach((f) => { f.mockReset(); f.mockResolvedValue({}); });
  });
  afterEach(() => vi.useRealTimers());

  test("REG-FE-FEE-001 feeStage: unpaid, at cashier, paid (or written off), promised", () => {
    expect(feeStage(S("a", T, 1))).toBe("unpaid");
    expect(feeStage(S("a", T, 1, "planned", { payment: "billed" }))).toBe("atCashier");
    expect(feeStage(S("a", T, 1, "planned", { payment: "paid" }))).toBe("paid");
    expect(feeStage(S("a", T, 1, "planned", { payment: "waived" }))).toBe("paid");
    expect(feeStage(S("a", T, 1, "planned", { pay_later: true }))).toBe("promised");
    // Money that moved beats a promise.
    expect(feeStage(S("a", T, 1, "planned", { pay_later: true, payment: "billed" }))).toBe("atCashier");
    expect(feeStage(S("a", T, 1, "planned", { pay_later: true, payment: "paid" }))).toBe("paid");
  });

  test("REG-FE-FEE-002 feeResolved opens the notes only for paid or promised", () => {
    expect(feeResolved(S("a", T, 1))).toBe(false);
    expect(feeResolved(S("a", T, 1, "planned", { payment: "billed" }))).toBe(false);
    expect(feeResolved(S("a", T, 1, "planned", { payment: "paid" }))).toBe(true);
    expect(feeResolved(S("a", T, 1, "planned", { pay_later: true }))).toBe(true);
  });

  test("REG-FE-FEE-003 respreadPool: only later visits that are still planned and unbilled absorb a change", () => {
    const plan = P("p", "RCT", [
      S("a", "2026-08-01", 1, "done"), S("b", T, 2), S("c", "2026-09-01", 3, "planned", { payment: "paid" }),
      S("d", "2026-10-01", 4, "planned", { payment: "billed" }), S("e", "2026-11-01", 5), S("f", "2026-12-01", 6, "done"),
    ]);
    expect(respreadPool(plan, plan.sessions[1]).map((s) => s.id)).toEqual(["e"]);
  });

  test("REG-FE-FEE-004 unpaid: the fee, nothing billed yet, Send to cashier bills this visit", async () => {
    const s = S("s2", T, 2);
    const { user, onChanged } = step(s);
    expect(screen.getByLabelText("Fee: unpaid")).toBeInTheDocument();
    expect(screen.getByText("Nothing has been billed for it yet.")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /Send to cashier/ }));
    await waitFor(() => expect(api.collectSession).toHaveBeenCalledWith("pat_1", "s2"));
    await waitFor(() => expect(onChanged).toHaveBeenCalled());
  });

  test("REG-FE-FEE-005 unpaid without the collect permission: no Send to cashier, pay later still offered", () => {
    step(S("s2", T, 2), { canCollect: false });
    expect(screen.queryByRole("button", { name: /Send to cashier/ })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Treat now, pay later/ })).toBeInTheDocument();
  });

  test("REG-FE-FEE-006 Treat now, pay later is asked, not taken on one click, and records the promise", async () => {
    const { user } = step(S("s2", T, 2));
    await user.click(screen.getByRole("button", { name: /Treat now, pay later/ }));
    const dlg = await screen.findByRole("dialog");
    expect(within(dlg).getByText(/stays owed/)).toBeInTheDocument();
    expect(api.setPayLater).not.toHaveBeenCalled();
    await user.type(within(dlg).getByPlaceholderText(/Next visit/), "After salary");
    await user.click(confirmIn(dlg, "Treat now, pay later"));
    await waitFor(() => expect(api.setPayLater).toHaveBeenCalledWith("pat_1", "s2", { on: true, note: "After salary" }));
  });

  test("REG-FE-FEE-007 at the cashier: says so, and pulling it back needs a reason", async () => {
    const { user } = step(S("s2", T, 2, "planned", { payment: "billed" }));
    expect(screen.getByLabelText("Fee: atCashier")).toBeInTheDocument();
    expect(screen.getByText("is with the cashier")).toBeInTheDocument();
    expect(screen.getByText(/This updates on its own/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Send to cashier/ })).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /Pull back from cashier/ }));
    const dlg = await screen.findByRole("dialog");
    const ok = confirmIn(dlg, "Pull it back");
    expect(ok).toBeDisabled();
    await user.type(within(dlg).getByPlaceholderText("Sent the wrong visit"), "Wrong visit");
    await user.click(ok);
    await waitFor(() => expect(api.uncollectSession).toHaveBeenCalledWith("pat_1", "s2", "Wrong visit"));
  });

  test("REG-FE-FEE-008 promised: owed after this visit, with Undo and Send to cashier", async () => {
    const { user } = step(S("s2", T, 2, "planned", { pay_later: true, pay_later_note: "Next visit" }));
    expect(screen.getByLabelText("Fee: promised")).toBeInTheDocument();
    expect(screen.getByText(/Owed after this visit/)).toHaveTextContent("2,000 ETB");
    expect(screen.getByLabelText(/Promised by/)).toHaveValue("Next visit");
    await user.click(screen.getByRole("button", { name: /Undo/ }));
    await waitFor(() => expect(api.setPayLater).toHaveBeenCalledWith("pat_1", "s2", { on: false, note: "" }));
  });

  test("REG-FE-FEE-009 the course recap: total, paid, with the cashier, left, percent collected", () => {
    const plan = P("p1", "Root canal", [S("s1", "2026-08-01", 1, "done", { payment: "paid" }), S("s2", T, 2), S("s3", "2026-09-12", 3)],
      "active", { money: { planned: "6000", collected: "1500", at_cashier: "500" } as Plan["money"] });
    step(plan.sessions[1], { plan });
    // The recap grid comes before the visit track, which repeats words like "Paid".
    const cell = (k: string) => screen.getAllByText(k, { selector: "div" })[0].nextElementSibling;
    expect(cell("Total")).toHaveTextContent("6,000 ETB");
    expect(cell("Paid")).toHaveTextContent("1,500 ETB");
    expect(cell("With cashier")).toHaveTextContent("500 ETB");
    expect(cell("Left")).toHaveTextContent("4,000 ETB");
    expect(screen.getByText("25% collected")).toBeInTheDocument();
    expect(screen.getByText(/1 of 3 visits done, 1 in the chair/)).toBeInTheDocument();
    expect(screen.getByText("In the chair")).toBeInTheDocument();
  });

  test("REG-FE-FEE-010 changing the fee re-spreads over the rest of the course by default", async () => {
    const { user } = step(S("s2", T, 2));
    await user.click(screen.getByRole("button", { name: /Change/ }));
    const input = screen.getByLabelText("This visit's fee");
    await user.clear(input);
    await user.type(input, "3000");
    expect(screen.getByText(/1,000 ETB more\./)).toBeInTheDocument();
    expect(screen.getByText(/visit 3 of 3 2,000 ETB → 1,000 ETB/)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Save fee" }));
    await waitFor(() => expect(api.repriceSession).toHaveBeenCalledWith("pat_1", "s2", { amount: "3000", mode: "respread", reason: undefined }));
  });

  test("REG-FE-FEE-011 the last visit has nothing to re-spread: the course total moves, and says so", async () => {
    const plan = P("p1", "Root canal", [S("s1", "2026-08-01", 1, "done", { payment: "paid" }), S("s2", T, 2)],
      "active", { money: { planned: "4000", collected: "2000", at_cashier: "0" } as Plan["money"] });
    const { user } = step(plan.sessions[1], { plan });
    await user.click(screen.getByRole("button", { name: /Change/ }));
    const input = screen.getByLabelText("This visit's fee");
    await user.clear(input);
    await user.type(input, "2500");
    expect(screen.getByText(/This is the last visit/)).toHaveTextContent("The course becomes 4,500 ETB (was 4,000 ETB).");
    await user.click(screen.getByRole("button", { name: "Save fee" }));
    await waitFor(() => expect(api.repriceSession).toHaveBeenCalledWith("pat_1", "s2", { amount: "2500", mode: "total", reason: undefined }));
  });

  test("REG-FE-FEE-012 lowering a fee for treatment already given needs a reason", async () => {
    const { user } = step(S("s2", "2026-08-10", 2, "done"));
    await user.click(screen.getByRole("button", { name: /Change/ }));
    const input = screen.getByLabelText("This visit's fee");
    await user.clear(input);
    await user.type(input, "1500");
    expect(screen.getByRole("button", { name: "Save fee" })).toBeDisabled();
    await user.type(screen.getByLabelText(/Why is this visit costing less/), "Agreed discount");
    expect(screen.getByRole("button", { name: "Save fee" })).toBeEnabled();
  });

  test("REG-FE-FEE-013 the fee strip: Paid, Free of charge for a write-off, Payment options for a promise", async () => {
    const onReopen = vi.fn();
    const { unmount } = renderUI(<FeeStrip session={S("s2", T, 2, "planned", { payment: "paid" })} planTitle="RCT" />);
    expect(screen.getByText("Paid")).toBeInTheDocument();
    expect(screen.getByText(/RCT · visit 2/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Payment options" })).not.toBeInTheDocument();
    unmount();
    const w = renderUI(<FeeStrip session={S("s2", T, 2, "planned", { payment: "waived" })} planTitle="RCT" />);
    expect(screen.getByText("Free of charge")).toBeInTheDocument();
    w.unmount();
    const { user } = renderUI(<FeeStrip session={S("s2", T, 2, "planned", { pay_later: true })} planTitle="RCT" onReopen={onReopen} />);
    expect(screen.getByText("Pay later")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Payment options" }));
    expect(onReopen).toHaveBeenCalled();
  });
});
