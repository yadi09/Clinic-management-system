// The course's down payment: when it is worth showing, the loud chairside callout
// in each state, the quiet money-panel row, and the one button both offer.
import { screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, test, vi } from "vitest";

const api = vi.hoisted(() => ({ collectSession: vi.fn() }));
const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }));
vi.mock("@/features/dental/api", async (orig) => ({ ...(await orig<object>()), ...api }));
vi.mock("sonner", async (orig) => ({ ...(await orig<object>()), toast }));

import { DepositCallout, DepositRow, depositOf, depositOutstanding } from "@/features/dental/shared/Deposit";
import { AppError } from "@/lib/api-client";
import type { Plan } from "@/features/dental/api";
import { renderUI } from "@/test/render";
import { P, S } from "../../visit/__tests__/fixtures";

const withDeposit = (payment: string, amount = "20000") =>
  P("p1", "Root canal", [S("s1", "2026-08-12", 1)], "active", {
    deposit: { id: "dep_1", amount_due: amount, payment, scheduled_date: "2026-08-12" },
  } as unknown as Partial<Plan>);

describe("REG-FE-SHARED the down payment", () => {
  beforeEach(() => {
    api.collectSession.mockReset();
    api.collectSession.mockResolvedValue({});
    Object.values(toast).forEach((f) => f.mockReset());
  });

  test("REG-FE-SHARED-017 depositOf: none, zero or a fraction of a birr is no deposit; payment maps to a stage", () => {
    expect(depositOf(P("p", "x", []))).toBeNull();
    expect(depositOf(withDeposit("unpaid", "0"))).toBeNull();
    expect(depositOf(withDeposit("unpaid", "0.004"))).toBeNull();
    expect(depositOf(withDeposit("unpaid"))).toEqual({ id: "dep_1", amount: "20000", stage: "unpaid" });
    expect(depositOf(withDeposit("refunded"))!.stage).toBe("unpaid");
    expect(depositOf(withDeposit("billed"))!.stage).toBe("atCashier");
    expect(depositOf(withDeposit("paid"))!.stage).toBe("paid");
    expect(depositOf(withDeposit("waived"))!.stage).toBe("paid");
  });

  test("REG-FE-SHARED-018 depositOutstanding: owed or at the cashier, never once paid or waived", () => {
    expect(depositOutstanding(P("p", "x", []))).toBe(false);
    expect(depositOutstanding(withDeposit("unpaid"))).toBe(true);
    expect(depositOutstanding(withDeposit("billed"))).toBe(true);
    expect(depositOutstanding(withDeposit("paid"))).toBe(false);
    expect(depositOutstanding(withDeposit("waived"))).toBe(false);
  });

  test("REG-FE-SHARED-019 the callout is absent when there is no deposit or it is settled", () => {
    for (const plan of [P("p", "x", []), withDeposit("paid"), withDeposit("waived"), withDeposit("unpaid", "0")]) {
      const { unmount } = renderUI(<DepositCallout patientId="pat_1" plan={plan} canCollect />);
      expect(screen.queryByText(/Down payment/)).not.toBeInTheDocument();
      unmount();
    }
  });

  test("REG-FE-SHARED-020 owed: says it is due before the course starts and offers Send to cashier", () => {
    renderUI(<DepositCallout patientId="pat_1" plan={withDeposit("unpaid")} canCollect />);
    expect(screen.getByText("Down payment 20,000 ETB is due before this course starts")).toBeInTheDocument();
    expect(screen.getByText("Agreed up front for Root canal. The visits are priced separately.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Send to cashier/ })).toBeInTheDocument();
    expect(screen.queryByText("Awaiting payment")).not.toBeInTheDocument();
  });

  test("REG-FE-SHARED-021 owed, but this user cannot bill: the fact is shown, the button is not", () => {
    renderUI(<DepositCallout patientId="pat_1" plan={withDeposit("unpaid")} canCollect={false} />);
    expect(screen.getByText(/is due before this course starts/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Send to cashier/ })).not.toBeInTheDocument();
  });

  test("REG-FE-SHARED-022 at the cashier: send the patient to the desk, no second send", () => {
    const { container } = renderUI(<DepositCallout patientId="pat_1" plan={withDeposit("billed")} canCollect compact />);
    expect(screen.getByText("Down payment 20,000 ETB is with the cashier")).toBeInTheDocument();
    expect(screen.getByText(/Send the patient to the desk/)).toBeInTheDocument();
    expect(screen.getByText("Awaiting payment")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Send to cashier/ })).not.toBeInTheDocument();
    expect(container.firstElementChild).toHaveClass("py-2");
  });

  test("REG-FE-SHARED-023 Send to cashier bills the deposit, says so, and refreshes the patient's dental data", async () => {
    const { user, qc } = renderUI(<DepositCallout patientId="pat_1" plan={withDeposit("unpaid")} canCollect />);
    const inv = vi.spyOn(qc, "invalidateQueries");
    await user.click(screen.getByRole("button", { name: /Send to cashier/ }));
    await waitFor(() => expect(api.collectSession).toHaveBeenCalledWith("pat_1", "dep_1"));
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith("Down payment sent to the cashier"));
    expect(inv).toHaveBeenCalledWith({ queryKey: ["dental-summary", "pat_1"] });
  });

  test("REG-FE-SHARED-024 a refused send says why (or a fallback)", async () => {
    api.collectSession.mockRejectedValueOnce(new AppError(409, "C", "Already billed")).mockRejectedValueOnce(new Error("x"));
    const { user } = renderUI(<DepositCallout patientId="pat_1" plan={withDeposit("unpaid")} canCollect />);
    await user.click(screen.getByRole("button", { name: /Send to cashier/ }));
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith("Already billed"));
    await user.click(screen.getByRole("button", { name: /Send to cashier/ }));
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith("Could not send it to the cashier"));
    expect(toast.success).not.toHaveBeenCalled();
  });

  test("REG-FE-SHARED-025 the button is disabled while sending, so it bills once", async () => {
    let resolve!: () => void;
    api.collectSession.mockReturnValue(new Promise<void>((r) => { resolve = r; }));
    const { user } = renderUI(<DepositCallout patientId="pat_1" plan={withDeposit("unpaid")} canCollect />);
    const btn = screen.getByRole("button", { name: /Send to cashier/ });
    await user.click(btn);
    await waitFor(() => expect(btn).toBeDisabled());
    await user.click(btn);
    expect(api.collectSession).toHaveBeenCalledTimes(1);
    resolve();
    await waitFor(() => expect(toast.success).toHaveBeenCalled());
  });

  test("REG-FE-SHARED-026 the money-panel row labels every stage, including free of charge", () => {
    const cases: [string, string][] = [["unpaid", "Owed now"], ["billed", "At cashier"], ["paid", "Paid"], ["waived", "Free of charge"]];
    for (const [payment, label] of cases) {
      const { unmount } = renderUI(<DepositRow patientId="pat_1" plan={withDeposit(payment)} canCollect />);
      expect(screen.getByText("Down payment")).toBeInTheDocument();
      expect(screen.getByText("20,000 ETB")).toBeInTheDocument();
      expect(screen.getByText(label)).toBeInTheDocument();
      // Only money still owed can be sent.
      expect(!!screen.queryByRole("button", { name: /Send to cashier/ })).toBe(payment === "unpaid");
      unmount();
    }
  });

  test("REG-FE-SHARED-027 the row is absent with no deposit, has no button without permission, and its button sends", async () => {
    const a = renderUI(<DepositRow patientId="pat_1" plan={P("p", "x", [])} canCollect />);
    expect(screen.queryByText(/Down payment/)).not.toBeInTheDocument();
    a.unmount();
    const b = renderUI(<DepositRow patientId="pat_1" plan={withDeposit("unpaid")} canCollect={false} />);
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
    b.unmount();
    const { user } = renderUI(<DepositRow patientId="pat_1" plan={withDeposit("unpaid")} canCollect />);
    await user.click(screen.getByRole("button", { name: /Send to cashier/ }));
    await waitFor(() => expect(api.collectSession).toHaveBeenCalledWith("pat_1", "dep_1"));
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith("Down payment sent to the cashier"));
  });
});
