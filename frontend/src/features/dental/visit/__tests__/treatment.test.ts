import { describe, expect, test } from "vitest";

import { joinNumbers, liveVisits, payWord, planMoney, visitWord } from "@/features/dental/visit/treatment";
import type { Plan } from "@/features/dental/api";
import { P, S } from "./fixtures";

const T = "2026-08-12";

describe("REG-FE-VISIT treatment helpers (visit card words)", () => {
  test("REG-FE-VISIT-001 liveVisits: done first, then by date, cancelled dropped", () => {
    const plan = P("p", "RCT", [
      S("late", "2026-09-01", 2),
      S("doneLate", "2026-08-20", 4, "done"),
      S("gone", "2026-08-01", 5, "cancelled"),
      S("early", "2026-08-05", 3),
      S("doneEarly", "2026-07-01", 1, "done"),
    ]);
    expect(liveVisits(plan).map((s) => s.id)).toEqual(["doneEarly", "doneLate", "early", "late"]);
  });

  test("REG-FE-VISIT-002 liveVisits: same date falls back to seq", () => {
    const plan = P("p", "RCT", [S("b", "2026-08-05", 2), S("a", "2026-08-05", 1)]);
    expect(liveVisits(plan).map((s) => s.id)).toEqual(["a", "b"]);
  });

  test("REG-FE-VISIT-003 visitWord: Done / Missed / Today / Next / Later", () => {
    const plan = P("p", "RCT", [
      S("d", "2026-08-01", 1, "done"),
      S("m", "2026-08-05", 2),
      S("t", T, 3),
      S("n", "2026-08-20", 4),
      S("l", "2026-09-01", 5),
    ]);
    const word = (id: string) => visitWord(plan, plan.sessions.find((s) => s.id === id)!, T);
    expect(["d", "m", "t", "n", "l"].map(word)).toEqual(["Done", "Missed", "Today", "Next", "Later"]);
  });

  test("REG-FE-VISIT-004 visitWord: Next is the earliest upcoming by date, not by seq", () => {
    const plan = P("p", "RCT", [S("s3", "2026-10-08", 3), S("s4", "2026-10-05", 4)]);
    expect(visitWord(plan, plan.sessions[1], T)).toBe("Next");
    expect(visitWord(plan, plan.sessions[0], T)).toBe("Later");
  });

  test("REG-FE-VISIT-005 payWord labels", () => {
    expect(payWord({ payment: "paid", status: "done" })).toEqual({ label: "Paid", tone: "good" });
    expect(payWord({ payment: "paid", status: "planned" })).toEqual({ label: "Paid ahead", tone: "good" });
    expect(payWord({ payment: "billed", status: "planned" })).toEqual({ label: "At cashier", tone: "wait" });
    expect(payWord({ payment: "waived", status: "done" })).toEqual({ label: "Free of charge", tone: "plain" });
    expect(payWord({ payment: "refunded", status: "done" })).toEqual({ label: "Refunded", tone: "plain" });
    expect(payWord({ payment: "unpaid", status: "done" })).toEqual({ label: "Owed", tone: "owed" });
    expect(payWord({ payment: "unpaid", status: "planned", pay_later: true })).toEqual({ label: "Pay later", tone: "wait" });
    expect(payWord({ payment: "unpaid", status: "planned" })).toEqual({ label: "Not paid", tone: "plain" });
  });

  test("REG-FE-VISIT-006 planMoney: left = total - paid - atCashier, never negative", () => {
    const withMoney = (planned: string, collected: string, at_cashier: string) =>
      P("p", "RCT", [], "active", { money: { planned, collected, at_cashier } } as unknown as Partial<Plan>);
    expect(planMoney(withMoney("12000", "4000", "2000"))).toEqual({ paid: 4000, total: 12000, atCashier: 2000, left: 6000 });
    expect(planMoney(withMoney("1000", "1500", "0")).left).toBe(0);
    expect(planMoney(withMoney("", "abc", "0"))).toEqual({ paid: 0, total: 0, atCashier: 0, left: 0 });
  });

  test("REG-FE-VISIT-007 joinNumbers", () => {
    expect(joinNumbers([])).toBe("");
    expect(joinNumbers([2])).toBe("2");
    expect(joinNumbers([2, 3])).toBe("2 and 3");
    expect(joinNumbers([2, 3, 4])).toBe("2, 3 and 4");
  });
});
