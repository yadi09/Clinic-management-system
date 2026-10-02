// The money words and the two money rules every dental surface leans on: what one
// session's fee is called (sessionMoneyState), whether a charge can be raised for it
// (isBillable, which must match the server's collect guard), and how a total is
// split into visits (splitRounded, which must match the server's splitAmount).
import { describe, expect, test } from "vitest";
import { MONEY, birr, isBillable, num, sessionMoneyState, settledLabel, splitRounded } from "@/features/dental/money";

describe("REG-FE-MONEY the money vocabulary and rules", () => {
  test("REG-FE-MONEY-001 a cancelled visit is never owed, even if it had been put on pay-later", () => {
    expect(sessionMoneyState({ status: "cancelled", payment: "unpaid", pay_later: true })).toBe("cancelled");
    expect(sessionMoneyState({ status: "cancelled", payment: "paid" })).toBe("cancelled");
    expect(MONEY.cancelled.countsAsOwed).toBe(false);
  });

  test("REG-FE-MONEY-002 each server payment state maps to one display state", () => {
    expect(sessionMoneyState({ status: "done", payment: "paid" })).toBe("paid");
    expect(sessionMoneyState({ status: "done", payment: "billed" })).toBe("atCashier");
    expect(sessionMoneyState({ status: "done", payment: "waived" })).toBe("waived");
    expect(sessionMoneyState({ status: "done", payment: "refunded" })).toBe("refunded");
  });

  test("REG-FE-MONEY-003 unpaid is a debt only once the work was done; pay-later on a future visit is not owed", () => {
    expect(sessionMoneyState({ status: "done", payment: "unpaid" })).toBe("owedNow");
    expect(sessionMoneyState({ status: "planned", payment: "unpaid" })).toBe("notYetDue");
    expect(sessionMoneyState({ status: "planned", payment: "unpaid", pay_later: true })).toBe("notYetDue");
  });

  test("REG-FE-MONEY-004 an unknown payment state degrades to a readable state instead of throwing", () => {
    expect(() => sessionMoneyState({ status: "done", payment: "something-new" })).not.toThrow();
    expect(sessionMoneyState({ status: "done", payment: "something-new" })).toBe("owedNow");
    expect(MONEY[sessionMoneyState({ status: "planned", payment: "?" })].label).toBe("Not yet due");
  });

  test("REG-FE-MONEY-005 only owed-now and refunded count toward what the patient owes today", () => {
    const owed = (Object.keys(MONEY) as (keyof typeof MONEY)[]).filter((k) => MONEY[k].countsAsOwed).sort();
    expect(owed).toEqual(["owedNow", "refunded"]);
    // At the cashier is queued, not owed: counting it twice asks for money twice.
    expect(MONEY.atCashier.countsAsOwed).toBe(false);
    expect(MONEY.refunded.label).toMatch(/owed again/);
  });

  test("REG-FE-MONEY-006 a write-off is settled but labelled Free of charge, never Paid", () => {
    expect(settledLabel("waived")).toEqual({ label: "Free of charge", forgiven: true });
    expect(settledLabel("paid")).toEqual({ label: "Paid", forgiven: false });
    expect(settledLabel()).toEqual({ label: "Paid", forgiven: false });
  });

  test("REG-FE-MONEY-007 billable: unpaid or refunded with a positive fee, nothing else", () => {
    expect(isBillable({ payment: "unpaid", amount_due: "2000" })).toBe(true);
    expect(isBillable({ payment: "refunded", amount_due: "500" })).toBe(true);
    expect(isBillable({ payment: "unpaid", amount_due: "0" })).toBe(false);
    expect(isBillable({ payment: "unpaid" })).toBe(false);
    for (const p of ["paid", "billed", "waived"]) expect(isBillable({ payment: p, amount_due: "2000" })).toBe(false);
  });

  test("REG-FE-MONEY-008 an exact division is every visit the same", () => {
    expect(splitRounded(15000, 20)).toEqual(Array(20).fill(750));
    expect(splitRounded(12000, 3)).toEqual([4000, 4000, 4000]);
  });

  test("REG-FE-MONEY-009 an uneven total rounds to hundreds/tens/units and the rest lands on the last visit", () => {
    expect(splitRounded(10000, 3)).toEqual([3300, 3300, 3400]);
    expect(splitRounded(100, 3)).toEqual([30, 30, 40]);
    expect(splitRounded(10, 3)).toEqual([3, 3, 4]);
    for (const [t, n] of [[10000, 3], [7777, 4], [95, 7]]) {
      expect(splitRounded(t, n).reduce((a, b) => a + b, 0)).toBe(t);
    }
  });

  test("REG-FE-MONEY-010 no visits gives no split; no total gives zero visits", () => {
    expect(splitRounded(1000, 0)).toEqual([]);
    expect(splitRounded(0, 3)).toEqual([0, 0, 0]);
    expect(splitRounded(Number.NaN, 2)).toEqual([0, 0]);
  });

  test("REG-FE-MONEY-011 birr and num read API strings the same way everywhere", () => {
    expect(num("2500.50")).toBe(2500.5);
    expect(num(undefined)).toBe(0);
    expect(num("")).toBe(0);
    expect(num(7)).toBe(7);
    expect(birr(12000)).toBe(`${(12000).toLocaleString()} ETB`);
    expect(birr("2500.5")).toBe(`${(2500.5).toLocaleString(undefined, { maximumFractionDigits: 2 })} ETB`);
    expect(birr(undefined)).toBe("0 ETB");
  });
});
