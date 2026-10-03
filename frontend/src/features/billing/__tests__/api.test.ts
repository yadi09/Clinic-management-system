// The billing API wrappers. Each one is thin, but each one is also the only place a
// path, a method and a body shape are spelled out — a typo here is a cashier whose
// payment never reaches the server, or a day close filed against the wrong date.
// These pin exactly what reaches apiFetch.
import { beforeEach, describe, expect, test, vi } from "vitest";

const apiFetch = vi.hoisted(() => vi.fn());
vi.mock("@/lib/api-client", async (orig) => ({ ...(await orig<object>()), apiFetch }));

import * as b from "@/features/billing/api";

const last = () => apiFetch.mock.calls.at(-1)!;

describe("REG-FE-BILLAPI billing API wrappers", () => {
  beforeEach(() => {
    apiFetch.mockReset();
    apiFetch.mockResolvedValue(undefined);
  });

  test("REG-FE-BILLAPI-001 card fee: assess (with and without appointment), collect, history", async () => {
    await b.assessCard("pat_1");
    expect(last()).toEqual(["/billing/card/assess?patient=pat_1"]);
    await b.assessCard("pat_1", "apt_9");
    expect(last()).toEqual(["/billing/card/assess?patient=pat_1&appointment=apt_9"]);
    const body = { patient_id: "pat_1", branch_id: "br_1", waived: true, waive_reason: "Staff" };
    await b.collectCard(body);
    expect(last()).toEqual(["/billing/card/collect", { method: "POST", body }]);
    await b.cardHistory("pat_1");
    expect(last()).toEqual(["/billing/card/history?patient=pat_1"]);
  });

  test("REG-FE-BILLAPI-002 service catalog CRUD hits the right verbs and paths", async () => {
    await b.listServices();
    expect(last()).toEqual(["/billing/services"]);
    await b.listServices(true);
    expect(last()).toEqual(["/billing/services?active=1"]);
    const body = { code: "C", name: "Consult", price: 100 };
    await b.createService(body);
    expect(last()).toEqual(["/billing/services", { method: "POST", body }]);
    await b.updateService("svc_1", body);
    expect(last()).toEqual(["/billing/services/svc_1", { method: "PUT", body }]);
    await b.setServiceActive("svc_1", false);
    expect(last()).toEqual(["/billing/services/svc_1/active", { method: "PUT", body: { is_active: false } }]);
    await b.setServiceDefault("svc_1", true);
    expect(last()).toEqual(["/billing/services/svc_1/default", { method: "PUT", body: { is_default: true } }]);
    await b.deleteService("svc_1");
    expect(last()).toEqual(["/billing/services/svc_1", { method: "DELETE" }]);
  });

  test("REG-FE-BILLAPI-003 providers: a missing user_ids list reads as nobody, not a crash", async () => {
    apiFetch.mockResolvedValueOnce({ user_ids: ["u1", "u2"] });
    await expect(b.getServiceProviders("svc_1")).resolves.toEqual(["u1", "u2"]);
    expect(last()).toEqual(["/billing/services/svc_1/providers"]);
    apiFetch.mockResolvedValueOnce({});
    await expect(b.getServiceProviders("svc_1")).resolves.toEqual([]);
    await b.setServiceProviders("svc_1", ["u1"]);
    expect(last()).toEqual(["/billing/services/svc_1/providers", { method: "PUT", body: { user_ids: ["u1"] } }]);
    await b.providersForServices(["a", "b"]);
    expect(last()).toEqual(["/billing/providers?services=a,b"]);
  });

  test("REG-FE-BILLAPI-004 charges: raise, batch, pending, a patient's ledger", async () => {
    const one = { patient_id: "p", description: "X-ray", amount: 300 };
    await b.raiseCharge(one);
    expect(last()).toEqual(["/billing/charges", { method: "POST", body: one }]);
    const batch = { patient_id: "p", branch_id: "br", department_id: "d", items: [{ description: "Reg", amount: 50 }] };
    await b.raiseChargeBatch(batch);
    expect(last()).toEqual(["/billing/charges/batch", { method: "POST", body: batch }]);
    await b.pendingCharges();
    expect(last()).toEqual(["/billing/charges/pending"]);
    await b.patientCharges("pat_1");
    expect(last()).toEqual(["/billing/charges?patient=pat_1"]);
  });

  test("REG-FE-BILLAPI-005 settle: one charge, or a visit whose body carries the patient and the exact lines", async () => {
    await b.settleCharge("ch_1", { method: "cash" });
    expect(last()).toEqual(["/billing/charges/ch_1/settle", { method: "POST", body: { method: "cash" } }]);
    await b.settleVisit("pat_1", { rail_id: "r1", method: "telebirr", reference: "CH7", force: true, charge_ids: ["c1", "c2"] });
    expect(last()).toEqual(["/billing/checkout", {
      method: "POST",
      body: { patient_id: "pat_1", rail_id: "r1", method: "telebirr", reference: "CH7", force: true, charge_ids: ["c1", "c2"] },
    }]);
  });

  test("REG-FE-BILLAPI-006 payments and cash summary: the window only goes on the URL when given", async () => {
    await b.paymentsToday();
    expect(last()).toEqual(["/billing/payments"]);
    await b.paymentsToday("2026-10-02T21:00:00.000Z", "2026-10-03T21:00:00.000Z");
    expect(last()).toEqual(["/billing/payments?since=2026-10-02T21%3A00%3A00.000Z&until=2026-10-03T21%3A00%3A00.000Z"]);
    await b.paymentsToday(undefined, "x");
    expect(last()).toEqual(["/billing/payments?until=x"]);
    await b.cashSummary();
    expect(last()).toEqual(["/billing/cash"]);
    await b.cashSummary("a", "b");
    expect(last()).toEqual(["/billing/cash?since=a&until=b"]);
  });

  test("REG-FE-BILLAPI-007 refund, waive, void, refund one charge, defer: each sends its reason", async () => {
    await b.refundVisit(42, "Overcharged");
    expect(last()).toEqual(["/billing/refund-visit", { method: "POST", body: { receipt_no: 42, reason: "Overcharged" } }]);
    await b.waiveCharge("c1", "Staff");
    expect(last()).toEqual(["/billing/charges/c1/waive", { method: "POST", body: { reason: "Staff" } }]);
    await b.voidCharge("c1", "Duplicate charge");
    expect(last()).toEqual(["/billing/charges/c1/void", { method: "POST", body: { reason: "Duplicate charge" } }]);
    await b.refundCharge("c1", "Billing error");
    expect(last()).toEqual(["/billing/charges/c1/refund", { method: "POST", body: { reason: "Billing error" } }]);
    await b.deferVisit("pat_1", { reason: "Payday", charge_ids: ["c1"] });
    expect(last()).toEqual(["/billing/patients/pat_1/defer", { method: "POST", body: { reason: "Payday", charge_ids: ["c1"] } }]);
    await b.waiverReasons();
    expect(last()).toEqual(["/billing/waiver-reasons"]);
  });

  test("REG-FE-BILLAPI-008 day close: list, one day, close, reconciliations", async () => {
    await b.dayCloses();
    expect(last()).toEqual(["/billing/day-closes"]);
    await b.dayCloses("2026-09-01", "2026-10-03");
    expect(last()).toEqual(["/billing/day-closes?from=2026-09-01&to=2026-10-03"]);
    await b.dayCloses(undefined, "2026-10-03");
    expect(last()).toEqual(["/billing/day-closes?to=2026-10-03"]);
    await b.dayClose();
    expect(last()).toEqual(["/billing/day-close"]);
    await b.dayClose("2026-10-03");
    expect(last()).toEqual(["/billing/day-close?date=2026-10-03"]);
    await b.closeDay({ business_date: "2026-10-03", counted: 1200, note: "" });
    expect(last()).toEqual(["/billing/day-close", { method: "POST", body: { business_date: "2026-10-03", counted: 1200, note: "" } }]);
    await b.reconciliations();
    expect(last()).toEqual(["/billing/reconciliations"]);
    await b.reconciliations(true);
    expect(last()).toEqual(["/billing/reconciliations?all=1"]);
  });

  test("REG-FE-BILLAPI-009 finance wrappers build the from/to/branch query, or none", async () => {
    await b.financeOverview({});
    expect(last()).toEqual(["/finance/overview"]);
    await b.financeOverview({ from: "2026-10-01", to: "2026-10-03", branch: "br_1" });
    expect(last()).toEqual(["/finance/overview?from=2026-10-01&to=2026-10-03&branch=br_1"]);
    await b.financeReceivables({ branch: "br_1" });
    expect(last()).toEqual(["/finance/receivables?branch=br_1"]);
    await b.financeCash({ from: "2026-10-01" });
    expect(last()).toEqual(["/finance/cash?from=2026-10-01"]);
    await b.financeServices({ to: "2026-10-03" });
    expect(last()).toEqual(["/finance/services?to=2026-10-03"]);
    await b.financeBook({});
    expect(last()).toEqual(["/finance/book"]);
  });

  test("REG-FE-BILLAPI-010 Verify.ET: verify posts the claim, status is a plain GET", async () => {
    const body = { rail_id: "r1", reference: "FT25", expected: "500.00", patient_id: "pat_1" };
    await b.verifyPayment(body);
    expect(last()).toEqual(["/billing/verify-payment", { method: "POST", body }]);
    await b.verificationAvailable();
    expect(last()).toEqual(["/billing/verify-payment/status"]);
  });
});
