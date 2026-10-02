// useDashLinks must never hand out a link the person cannot open. useAuth is mocked
// so each test states exactly which permissions and flags the user has.
import { renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, test, vi } from "vitest";

const auth = vi.hoisted(() => ({ perms: new Set<string>(), flags: new Set<string>() }));
vi.mock("@/app/auth-context", () => ({
  useAuth: () => ({ can: (p: string) => auth.perms.has(p), flagOn: (f: string) => auth.flags.has(f) }),
}));

import { useDashLinks } from "@/features/dashboard/links";

const as = (perms: string[], flags: string[]) => {
  auth.perms = new Set(perms);
  auth.flags = new Set(flags);
  return renderHook(() => useDashLinks()).result.current;
};

describe("REG-FE-DASHLINK dashboard link gating", () => {
  beforeEach(() => { auth.perms.clear(); auth.flags.clear(); });

  test("REG-FE-DASHLINK-001 finance needs billing.manage AND finance_advanced", () => {
    expect(as([], ["finance_advanced"]).finance("today")).toBeUndefined();
    expect(as(["billing.manage"], []).finance("today")).toBeUndefined();
    expect(as(["billing.manage"], ["finance_advanced"]).finance("today", "revenue")).toBe("/finance?tab=revenue&period=today");
  });

  test("REG-FE-DASHLINK-002 receivables also need debt_ageing", () => {
    expect(as(["billing.manage"], ["finance_advanced"]).receivables()).toBeUndefined();
    expect(as([], ["finance_advanced", "debt_ageing"]).receivables()).toBeUndefined();
    expect(as(["billing.manage"], ["finance_advanced", "debt_ageing"]).receivables("31-60"))
      .toBe("/finance?tab=receivables&bucket=31-60");
  });

  test("REG-FE-DASHLINK-003 receivables alert degrades to /finance without debt_ageing, nothing without finance", () => {
    expect(as(["billing.manage"], ["finance_advanced"]).alert("/finance?tab=receivables")).toBe("/finance");
    expect(as([], []).alert("/finance?tab=receivables")).toBeUndefined();
  });

  test("REG-FE-DASHLINK-004 patient link only with patient access", () => {
    expect(as([], ["dental"]).patient("p1")).toBeUndefined();
    expect(as(["patient.read"], []).patient("p1")).toBe("/patients/p1");
    expect(as(["patient.read"], []).patient("")).toBeUndefined();
    expect(as(["patient.read"], ["dental"]).patient("p1", { money: true })).toBe("/patients/p1?panel=money");
    expect(as(["patient.read"], []).patient("p1", { money: true })).toBe("/patients/p1");
  });

  test("REG-FE-DASHLINK-005 cashier and appointments follow their own permission", () => {
    expect(as([], []).cashier()).toBeUndefined();
    expect(as(["payment.collect"], []).cashier()).toBe("/cashier");
    expect(as([], []).appointments({ view: "followups" })).toBeUndefined();
    expect(as(["appointment.manage"], []).appointments({ view: "followups" })).toBe("/appointments?view=followups");
  });
});
