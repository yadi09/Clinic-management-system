// The cashier: one checkout card per patient with charges waiting, the paid list to
// reprint or refund, and the day close. The server is faked (src/test/frontdesk), so
// each test sets what is owed and asserts what the desk sees and exactly what each
// button sends — the real billing/api.ts builds the request.
import { screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

vi.mock("@/lib/api-client", async (orig) => ({ ...(await orig<object>()), ...(await import("@/test/frontdesk")).apiModule }));
vi.mock("@/app/auth-context", async () => (await import("@/test/frontdesk")).authModule);
vi.mock("@/components/ui/sonner", async (orig) => ({ ...(await orig<object>()), toast: (await import("@/test/frontdesk")).toastSpy }));

import { CashierPage } from "@/features/billing/pages/CashierPage";
import type { DaySummary, ExpectedDay, PaidVisit, PendingCharge } from "@/features/billing/api";
import type { PaymentRail } from "@/features/admin/api";
import { capturePrints, DESK_PERMS, fail, fake, hang, resetToasts, setAuth, toasts } from "@/test/frontdesk";
import { freezeToday, renderUI } from "@/test/render";

const T = "2026-08-12";

function C(id: string, patient: string, amount: string, over: Partial<PendingCharge> = {}): PendingCharge {
  return {
    id, patient_id: `pat_${patient}`, source: "consultation", description: `Service ${id}`, amount, currency: "ETB",
    created_at: `${T}T08:00:00Z`, patient_name: `Patient ${patient}`, mrn: `MRN-${patient}`, ...over,
  };
}
const RAILS: PaymentRail[] = [
  { id: "rl_cash", key: "cash", label: "Cash", kind: "cash", needs_reference: false, active: true, sort_order: 1 },
  { id: "rl_tb", key: "telebirr", label: "Telebirr", kind: "wallet", bank_key: "telebirr", account_number: "0911", needs_reference: true, active: true, sort_order: 2 },
  { id: "rl_mob", key: "mobile", label: "Mobile money", kind: "wallet", needs_reference: false, active: true, sort_order: 3 },
];
function V(no: number, over: Partial<PaidVisit> = {}): PaidVisit {
  return {
    receipt_no: no, patient_name: `Paid ${no}`, mrn: `MRN-P${no}`, total: "300.00", currency: "ETB", method: "cash",
    method_label: "Cash", settled_at: `${T}T07:30:00Z`, refunded: false, settled_by: "Abebe Cashier",
    lines: [{ description: "Consultation", amount: "200.00" }, { description: "X-ray", amount: "100.00" }], ...over,
  };
}

function page() {
  return renderUI(<CashierPage />, { route: "/cashier" });
}
const tab = (name: RegExp) => screen.getByRole("tab", { name });
const cardOf = (name: string) => screen.getByText(name).closest(".overflow-hidden") as HTMLElement;

async function pick(trigger: HTMLElement, option: string, user: ReturnType<typeof page>["user"]) {
  await user.click(trigger);
  await user.click(await screen.findByRole("option", { name: new RegExp(`^${option}`) }));
}

describe("REG-FE-CASHIER the cashier page", () => {
  beforeEach(() => {
    freezeToday(T, 10);
    fake.reset();
    resetToasts();
    setAuth();
    fake.on("GET", "/billing/charges/pending", [C("ch1", "a", "200.00"), C("ch2", "a", "100.00", { source: "dental" }), C("ch3", "b", "50.00")]);
    fake.on("GET", "/org/payment-rails", RAILS);
    fake.on("GET", "/billing/waiver-reasons", ["Staff", "Other"]);
    fake.on("GET", "/billing/payments", [V(12), V(13, { refunded: true, reference: "FT123", method_label: undefined, method: "telebirr" })]);
    fake.on("GET", "/billing/day-closes", []);
  });
  afterEach(() => vi.useRealTimers());

  test("REG-FE-CASHIER-001 pending: one checkout per patient with every line, its source, and the patient's total", async () => {
    page();
    const a = await screen.findByText("Patient a").then(() => cardOf("Patient a"));
    expect(within(a).getByText("MRN-a")).toBeInTheDocument();
    // The total heads the card and is repeated on the button.
    expect(within(a).getAllByText("ETB 300.00")).toHaveLength(2);
    expect(within(a).getByText("Service ch1")).toBeInTheDocument();
    expect(within(a).getAllByText("dental").length).toBeGreaterThan(0);
    expect(cardOf("Patient b")).toHaveTextContent("ETB 50.00");
    // The badge counts patients, not lines.
    expect(tab(/Pending/)).toHaveTextContent("2");
    expect(screen.getByText(/All pending checkouts waiting to be collected/)).toBeInTheDocument();
  });

  test("REG-FE-CASHIER-002 nothing owed: says so plainly", async () => {
    fake.on("GET", "/billing/charges/pending", []);
    page();
    expect(await screen.findByText("No pending payments")).toBeInTheDocument();
    expect(tab(/Pending/)).toHaveTextContent(/^Pending$/);
  });

  test("REG-FE-CASHIER-003 a failed load is an error with Retry, not 'No pending payments'", async () => {
    fake.on("GET", "/billing/charges/pending", fail(500, "down"));
    const { user } = page();
    expect(await screen.findByRole("alert")).toHaveTextContent("Could not load the pending payments");
    expect(screen.queryByText("No pending payments")).not.toBeInTheDocument();
    fake.on("GET", "/billing/charges/pending", [C("ch1", "a", "200.00")]);
    await user.click(screen.getByRole("button", { name: /Retry/ }));
    expect(await screen.findByText("Patient a")).toBeInTheDocument();
  });

  test("REG-FE-CASHIER-004 take payment: the first rail is preselected and exactly the lines on screen are settled", async () => {
    fake.on("POST", "/billing/checkout", { receipt_no: 42, total: "300.00", count: 2 });
    const { user } = page();
    await screen.findByText("Patient a");
    const a = cardOf("Patient a");
    await waitFor(() => expect(within(a).getByRole("combobox", { name: "Payment method" })).toHaveTextContent("Cash"));
    await user.click(within(a).getByRole("button", { name: /Take payment · ETB 300.00/ }));
    await waitFor(() => expect(fake.sent("POST", "/billing/checkout")).toHaveLength(1));
    expect(fake.lastBody("POST", "/billing/checkout")).toEqual({
      patient_id: "pat_a", rail_id: "rl_cash", method: "cash", reference: "", force: false, charge_ids: ["ch1", "ch2"],
    });
    expect(toasts("success")[0]).toMatch(/Paid ETB 300.00 · receipt RCP-000042/);
    // The desk lands on the paid list to print the receipt.
    await waitFor(() => expect(tab(/^Paid/)).toHaveAttribute("aria-selected", "true"));
    expect(await screen.findByText("Paid 12")).toBeInTheDocument();
  });

  test("REG-FE-CASHIER-005 a wallet rail needs its reference before the button arms, and the reference is sent", async () => {
    fake.on("POST", "/billing/checkout", { receipt_no: 7, total: "50.00", count: 1 });
    const { user } = page();
    await screen.findByText("Patient b");
    const b = cardOf("Patient b");
    const trigger = within(b).getByRole("combobox", { name: "Payment method" });
    await waitFor(() => expect(trigger).toHaveTextContent("Cash"));
    await pick(trigger, "Telebirr", user);
    const pay = within(b).getByRole("button", { name: /Take payment/ });
    expect(pay).toBeDisabled();
    expect(within(b).getByPlaceholderText(/CH7K2M9QRS/)).toBeInTheDocument();
    await user.type(within(b).getByLabelText(/Transaction reference/), "CH7K2M9QRS");
    expect(pay).toBeEnabled();
    await user.click(pay);
    await waitFor(() => expect(fake.lastBody("POST", "/billing/checkout")).toMatchObject({
      patient_id: "pat_b", rail_id: "rl_tb", method: "telebirr", reference: "CH7K2M9QRS", charge_ids: ["ch3"],
    }));
  });

  test("REG-FE-CASHIER-006 a generic wallet warns it names no account; managers get the settings link", async () => {
    const { user, unmount } = page();
    await screen.findByText("Patient b");
    let b = cardOf("Patient b");
    await waitFor(() => expect(within(b).getByRole("combobox")).toHaveTextContent("Cash"));
    await pick(within(b).getByRole("combobox"), "Mobile money", user);
    expect(within(b).getByText(/This is a generic method/)).toBeInTheDocument();
    expect(within(b).getByText(/Ask an administrator/)).toBeInTheDocument();
    // Optional reference: the button stays live without one.
    expect(within(b).getByText(/optional, but it is the only proof/)).toBeInTheDocument();
    expect(within(b).getByRole("button", { name: /Take payment/ })).toBeEnabled();
    unmount();

    setAuth({ perms: [...DESK_PERMS, "clinic.manage"] });
    const r = page();
    await screen.findByText("Patient b");
    b = cardOf("Patient b");
    await waitFor(() => expect(within(b).getByRole("combobox")).toHaveTextContent("Cash"));
    await pick(within(b).getByRole("combobox"), "Mobile money", r.user);
    expect(within(b).getByRole("link", { name: /Name your accounts/ })).toHaveAttribute("href", "/settings?section=payments");
  });

  test("REG-FE-CASHIER-007 check with the bank: sends rail, reference, the expected total and patient; shows what the bank said", async () => {
    setAuth({ flags: ["dental", "payment_verification"] });
    fake.on("GET", "/billing/verify-payment/status", { available: true });
    fake.on("POST", "/billing/verify-payment", { state: "verified", reason: "Matches", amount: "50.00", sender: "Abebe", account: "0911" });
    const { user } = page();
    await screen.findByText("Patient b");
    const b = cardOf("Patient b");
    await waitFor(() => expect(within(b).getByRole("combobox")).toHaveTextContent("Cash"));
    await pick(within(b).getByRole("combobox"), "Telebirr", user);
    expect(within(b).queryByRole("button", { name: /Check with the bank/ })).not.toBeInTheDocument();
    await user.type(within(b).getByLabelText(/Transaction reference/), " CH1 ");
    await user.click(await within(b).findByRole("button", { name: /Check with the bank/ }));
    expect(await within(b).findByText("Confirmed by the bank")).toBeInTheDocument();
    expect(fake.lastBody("POST", "/billing/verify-payment")).toEqual({ rail_id: "rl_tb", reference: "CH1", expected: "50.00", patient_id: "pat_b" });
    expect(within(b).getByText("50.00 ETB")).toBeInTheDocument();
    expect(within(b).getByText(/from Abebe/)).toBeInTheDocument();
    expect(within(b).getByText(/to 0911/)).toBeInTheDocument();
    expect(within(b).getByRole("button", { name: /Check again/ })).toBeInTheDocument();
  });

  test("REG-FE-CASHIER-008 the bank contradicts the payment: no Take payment; only payment.waive may force it, and force is sent", async () => {
    setAuth({ flags: ["dental", "payment_verification"], perms: DESK_PERMS.filter((p) => p !== "payment.waive") });
    fake.on("GET", "/billing/verify-payment/status", { available: true });
    fake.on("POST", "/billing/verify-payment", { state: "rejected", reason: "Paid to another account" });
    fake.on("POST", "/billing/checkout", { receipt_no: 9, total: "50.00", count: 1 });
    const first = page();
    await screen.findByText("Patient b");
    let b = cardOf("Patient b");
    await waitFor(() => expect(within(b).getByRole("combobox")).toHaveTextContent("Cash"));
    await pick(within(b).getByRole("combobox"), "Telebirr", first.user);
    await first.user.type(within(b).getByLabelText(/Transaction reference/), "X1");
    await first.user.click(within(b).getByRole("button", { name: /Check with the bank/ }));
    expect(await within(b).findByText("The bank does not confirm this")).toBeInTheDocument();
    expect(within(b).getByRole("button", { name: /The bank did not confirm this payment/ })).toBeDisabled();
    expect(within(b).queryByRole("button", { name: /Take payment/ })).not.toBeInTheDocument();
    expect(within(b).getByText("A manager can override this.")).toBeInTheDocument();
    first.unmount();

    setAuth({ flags: ["dental", "payment_verification"] });
    const { user } = page();
    await screen.findByText("Patient b");
    b = cardOf("Patient b");
    await waitFor(() => expect(within(b).getByRole("combobox")).toHaveTextContent("Cash"));
    await pick(within(b).getByRole("combobox"), "Telebirr", user);
    await user.type(within(b).getByLabelText(/Transaction reference/), "X1");
    await user.click(within(b).getByRole("button", { name: /Check with the bank/ }));
    await user.click(await within(b).findByRole("button", { name: /Take it anyway — recorded against my name/ }));
    await waitFor(() => expect(fake.lastBody("POST", "/billing/checkout")).toMatchObject({ force: true, reference: "X1" }));
  });

  test("REG-FE-CASHIER-009 a check that could not run is 'Not checked' and does not block payment", async () => {
    setAuth({ flags: ["dental", "payment_verification"] });
    fake.on("GET", "/billing/verify-payment/status", { available: true });
    fake.on("POST", "/billing/verify-payment", fail(502, "gateway"));
    const { user } = page();
    await screen.findByText("Patient b");
    const b = cardOf("Patient b");
    await waitFor(() => expect(within(b).getByRole("combobox")).toHaveTextContent("Cash"));
    await pick(within(b).getByRole("combobox"), "Telebirr", user);
    await user.type(within(b).getByLabelText(/Transaction reference/), "Z9");
    await user.click(within(b).getByRole("button", { name: /Check with the bank/ }));
    expect(await within(b).findByText("Not checked")).toBeInTheDocument();
    expect(within(b).getByText("The check could not be run.")).toBeInTheDocument();
    expect(within(b).getByRole("button", { name: /Take payment/ })).toBeEnabled();
  });

  test("REG-FE-CASHIER-010 bank checks are not offered off-plan, and the status endpoint is never asked", async () => {
    const { user } = page();
    await screen.findByText("Patient b");
    const b = cardOf("Patient b");
    await waitFor(() => expect(within(b).getByRole("combobox")).toHaveTextContent("Cash"));
    await pick(within(b).getByRole("combobox"), "Telebirr", user);
    await user.type(within(b).getByLabelText(/Transaction reference/), "Z9");
    expect(within(b).queryByRole("button", { name: /Check with the bank/ })).not.toBeInTheDocument();
    expect(fake.sent("GET", "/billing/verify-payment/status")).toHaveLength(0);
  });

  test("REG-FE-CASHIER-011 a refused payment shows the server's reason; anything else a generic one", async () => {
    fake.on("POST", "/billing/checkout", fail(409, "Reference already used"));
    const { user } = page();
    await screen.findByText("Patient b");
    const b = cardOf("Patient b");
    await waitFor(() => expect(within(b).getByRole("combobox")).toHaveTextContent("Cash"));
    await user.click(within(b).getByRole("button", { name: /Take payment/ }));
    await waitFor(() => expect(toasts("error")).toEqual(["Reference already used"]));
    fake.on("POST", "/billing/checkout", () => { throw new Error("x"); });
    await user.click(within(b).getByRole("button", { name: /Take payment/ }));
    await waitFor(() => expect(toasts("error")[1]).toBe("Could not take payment"));
    expect(tab(/Pending/)).toHaveAttribute("aria-selected", "true");
  });

  test("REG-FE-CASHIER-012 a rail-less clinic still takes cash under the legacy method", async () => {
    fake.on("GET", "/org/payment-rails", []);
    fake.on("POST", "/billing/checkout", { receipt_no: 1, total: "50.00", count: 1 });
    const { user } = page();
    await screen.findByText("Patient b");
    const b = cardOf("Patient b");
    expect(within(b).getByRole("combobox")).toBeDisabled();
    await user.click(within(b).getByRole("button", { name: /Take payment/ }));
    await waitFor(() => expect(fake.lastBody("POST", "/billing/checkout")).toMatchObject({ method: "cash", charge_ids: ["ch3"] }));
    expect((fake.lastBody("POST", "/billing/checkout") as { rail_id?: string }).rail_id).toBeUndefined();
  });

  test("REG-FE-CASHIER-013 void a line: a reason is required; Other carries the note", async () => {
    fake.on("POST", "/billing/charges/:id/void", undefined);
    const { user } = page();
    await screen.findByText("Patient a");
    await user.click(within(cardOf("Patient a")).getAllByRole("button", { name: "Line actions" })[1]);
    await user.click(await screen.findByRole("menuitem", { name: "Void…" }));
    const dlg = await screen.findByRole("dialog", { name: "Void charge" });
    expect(dlg).toHaveTextContent("Service ch2 · ETB 100.00 · Patient a");
    const go = within(dlg).getByRole("button", { name: "Void charge" });
    expect(go).toBeDisabled();
    await pick(within(dlg).getByRole("combobox"), "Other", user);
    await user.type(within(dlg).getByPlaceholderText("Explain"), "  tooth not done  ");
    await user.click(go);
    await waitFor(() => expect(fake.sent("POST", "/billing/charges/ch2/void")).toHaveLength(1));
    expect(fake.lastBody("POST", "/billing/charges/ch2/void")).toEqual({ reason: "Other: tooth not done" });
    expect(toasts("success")).toContain("Charge voided");
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
  });

  test("REG-FE-CASHIER-014 void: a listed reason is sent as is; a refusal is shown; Cancel closes", async () => {
    fake.on("POST", "/billing/charges/:id/void", fail(409, "Already paid"));
    const { user } = page();
    await screen.findByText("Patient b");
    await user.click(within(cardOf("Patient b")).getByRole("button", { name: "Line actions" }));
    await user.click(await screen.findByRole("menuitem", { name: "Void…" }));
    const dlg = await screen.findByRole("dialog");
    await pick(within(dlg).getByRole("combobox"), "Duplicate charge", user);
    await user.click(within(dlg).getByRole("button", { name: "Void charge" }));
    await waitFor(() => expect(toasts("error")).toEqual(["Already paid"]));
    expect(fake.lastBody("POST", "/billing/charges/ch3/void")).toEqual({ reason: "Duplicate charge" });
    fake.on("POST", "/billing/charges/:id/void", () => { throw new Error("net"); });
    await user.click(within(dlg).getByRole("button", { name: "Void charge" }));
    await waitFor(() => expect(toasts("error")[1]).toBe("Could not void"));
    await user.click(within(dlg).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
  });

  test("REG-FE-CASHIER-015 waive a line with the clinic's reasons; Other + note; refusal shown", async () => {
    fake.on("POST", "/billing/charges/:id/waive", undefined);
    const { user } = page();
    await screen.findByText("Patient b");
    await user.click(within(cardOf("Patient b")).getByRole("button", { name: "Line actions" }));
    await user.click(await screen.findByRole("menuitem", { name: "Waive…" }));
    const dlg = await screen.findByRole("dialog", { name: "Waive charge" });
    expect(dlg).toHaveTextContent("Service ch3 · ETB 50.00 · Patient b");
    expect(within(dlg).getByRole("button", { name: /Waive/ })).toBeDisabled();
    await pick(within(dlg).getByRole("combobox"), "Other", user);
    await user.type(within(dlg).getByPlaceholderText("Explain the exemption"), "Orphan");
    await user.click(within(dlg).getByRole("button", { name: /Waive/ }));
    await waitFor(() => expect(fake.lastBody("POST", "/billing/charges/ch3/waive")).toEqual({ reason: "Other: Orphan" }));
    expect(toasts("success")).toContain("Charge waived");

    fake.on("POST", "/billing/charges/:id/waive", fail(403, "Not allowed"));
    await user.click(within(cardOf("Patient b")).getByRole("button", { name: "Line actions" }));
    await user.click(await screen.findByRole("menuitem", { name: "Waive…" }));
    const d2 = await screen.findByRole("dialog");
    await pick(within(d2).getByRole("combobox"), "Staff", user);
    await user.click(within(d2).getByRole("button", { name: /Waive/ }));
    await waitFor(() => expect(toasts("error")).toEqual(["Not allowed"]));
    fake.on("POST", "/billing/charges/:id/waive", () => { throw new Error("x"); });
    await user.click(within(d2).getByRole("button", { name: /Waive/ }));
    await waitFor(() => expect(toasts("error")[1]).toBe("Could not waive"));
    await user.click(within(d2).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
  });

  test("REG-FE-CASHIER-016 paid list: receipt number, lines, method, reference, refunded receipts struck and not refundable", async () => {
    const { user } = page();
    await user.click(tab(/^Paid/));
    expect(await screen.findByText("Paid 12")).toBeInTheDocument();
    expect(screen.getByText("RCP-000012")).toBeInTheDocument();
    expect(screen.getByText(/Consultation · X-ray · Cash/)).toBeInTheDocument();
    expect(screen.getByText("FT123")).toBeInTheDocument();
    expect(screen.getByText(/Consultation · X-ray · telebirr/)).toBeInTheDocument();
    expect(screen.getByText("refunded")).toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: /Refund/ })).toHaveLength(1);
    expect(screen.getByText(/A record of settled payments/)).toBeInTheDocument();
    // The window asked for is today's local day.
    const q = fake.sent("GET", "/billing/payments")[0].query;
    expect(new Date(q.get("since")!).getDate()).toBe(12);
    expect(new Date(q.get("until")!).getTime() - new Date(q.get("since")!).getTime()).toBe(86_400_000);
  });

  test("REG-FE-CASHIER-017 reprint prints the cashier recorded on the payment, not whoever is at the till", async () => {
    const docs = capturePrints();
    const { user } = page();
    await user.click(tab(/^Paid/));
    await screen.findByText("Paid 12");
    await user.click(screen.getAllByRole("button", { name: /Print/ })[0]);
    expect(docs).toHaveLength(1);
    expect(docs[0]).toContain("RCP-000012");
    expect(docs[0]).toContain("Abebe Cashier");
    expect(docs[0]).not.toContain("Selam Desk");
    expect(docs[0]).toContain("Test Clinic");
    expect(docs[0]).toContain("X-ray");
    // A transfer prints its reference, so a disputed payment can be found.
    await user.click(screen.getAllByRole("button", { name: /Print/ })[1]);
    expect(docs).toHaveLength(2);
    expect(docs[1]).toContain("RCP-000013");
    expect(docs[1]).toContain("Reference");
    expect(docs[1]).toContain("FT123");
  });

  test("REG-FE-CASHIER-018 a payment with no recorded cashier or time reprints under the current user", async () => {
    fake.on("GET", "/billing/payments", [V(5, { settled_by: undefined, settled_at: undefined, method_label: undefined, method: undefined })]);
    const docs = capturePrints();
    const { user } = page();
    await user.click(tab(/^Paid/));
    await screen.findByText("Paid 5");
    expect(screen.getByText(/Consultation · X-ray · —/)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /Print/ }));
    expect(docs[0]).toContain("Selam Desk");
  });

  test("REG-FE-CASHIER-019 no payments in range; refund needs billing.manage", async () => {
    fake.on("GET", "/billing/payments", []);
    const { user, unmount } = page();
    await user.click(tab(/^Paid/));
    expect(await screen.findByText("No payments in this range.")).toBeInTheDocument();
    unmount();
    setAuth({ perms: DESK_PERMS.filter((p) => p !== "billing.manage") });
    fake.on("GET", "/billing/payments", [V(12)]);
    const r = page();
    await r.user.click(tab(/^Paid/));
    await screen.findByText("Paid 12");
    expect(screen.queryByRole("button", { name: /Refund/ })).not.toBeInTheDocument();
  });

  test("REG-FE-CASHIER-020 the range filter re-asks for the chosen window", async () => {
    const { user } = page();
    await user.click(tab(/^Paid/));
    await screen.findByText("Paid 12");
    await user.click(screen.getByRole("button", { name: "Yesterday" }));
    await waitFor(() => expect(fake.sent("GET", "/billing/payments")).toHaveLength(2));
    const q = fake.sent("GET", "/billing/payments")[1].query;
    expect(new Date(q.get("since")!).getDate()).toBe(11);
  });

  test("REG-FE-CASHIER-021 refund: whole receipt, reason required, sent with the receipt number", async () => {
    fake.on("POST", "/billing/refund-visit", undefined);
    const { user } = page();
    await user.click(tab(/^Paid/));
    await screen.findByText("Paid 12");
    await user.click(screen.getByRole("button", { name: /Refund/ }));
    const dlg = await screen.findByRole("dialog", { name: "Refund payment" });
    expect(dlg).toHaveTextContent("RCP-000012 · Paid 12 · ETB 300.00");
    const go = within(dlg).getByRole("button", { name: "Refund" });
    expect(go).toBeDisabled();
    await pick(within(dlg).getByRole("combobox"), "Overcharged", user);
    await user.click(go);
    await waitFor(() => expect(fake.lastBody("POST", "/billing/refund-visit")).toEqual({ receipt_no: 12, reason: "Overcharged" }));
    expect(toasts("success")).toContain("Payment refunded");
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
  });

  test("REG-FE-CASHIER-022 refund refused: the reason is shown and the dialog stays; Cancel clears it", async () => {
    fake.on("POST", "/billing/refund-visit", fail(409, "Already refunded"));
    const { user } = page();
    await user.click(tab(/^Paid/));
    await screen.findByText("Paid 12");
    await user.click(screen.getByRole("button", { name: /Refund/ }));
    const dlg = await screen.findByRole("dialog");
    await pick(within(dlg).getByRole("combobox"), "Billing error", user);
    await user.click(within(dlg).getByRole("button", { name: "Refund" }));
    await waitFor(() => expect(toasts("error")).toEqual(["Already refunded"]));
    fake.on("POST", "/billing/refund-visit", () => { throw new Error("x"); });
    await user.click(within(dlg).getByRole("button", { name: "Refund" }));
    await waitFor(() => expect(toasts("error")[1]).toBe("Could not refund"));
    await user.click(within(dlg).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    // Reopened, the reason starts empty again.
    await user.click(screen.getByRole("button", { name: /Refund/ }));
    expect(within(await screen.findByRole("dialog")).getByRole("button", { name: "Refund" })).toBeDisabled();
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
  });

  test("REG-FE-CASHIER-023 the paid list shows Loading while it is fetched", async () => {
    fake.on("GET", "/billing/payments", hang);
    const { user } = page();
    await user.click(tab(/^Paid/));
    expect(await screen.findByText("Loading…")).toBeInTheDocument();
  });
});

describe("REG-FE-CASHIER day close", () => {
  const D = (business_date: string, over: Partial<DaySummary> = {}): DaySummary => ({ business_date, expected_total: "1200", count: 3, closed: false, ...over });
  const EXP: ExpectedDay = {
    business_date: T, closed: false, expected_total: "800.00", non_cash_total: "400.00",
    by_method: [{ label: "cash", total: "800.00", count: 2, cash: true }, { label: "telebirr", total: "400.00", count: 1, cash: false }],
  };
  beforeEach(() => {
    freezeToday(T, 10);
    fake.reset();
    resetToasts();
    setAuth();
    fake.on("GET", "/billing/charges/pending", []);
    fake.on("GET", "/billing/waiver-reasons", []);
    fake.on("GET", "/billing/day-close", EXP);
  });
  afterEach(() => vi.useRealTimers());
  const longDay = (iso: string) => new Date(`${iso}T00:00:00`).toLocaleDateString(undefined, { weekday: "short", day: "numeric", month: "short", year: "numeric" });
  const rowOf = (iso: string) => screen.getByText(longDay(iso)).closest(".overflow-hidden") as HTMLElement;

  test("REG-FE-CASHIER-030 today is always offered; earlier unclosed days are flagged and counted on the tab", async () => {
    fake.on("GET", "/billing/day-closes", [D("2026-08-10"), D("2026-08-09", { closed: true, counted_total: "1200", variance: "0" })]);
    const { user } = page();
    await waitFor(() => expect(tab(/Day close/)).toBeInTheDocument());
    await user.click(tab(/Day close/));
    expect(await screen.findByText(longDay(T))).toBeInTheDocument();
    const today = rowOf(T);
    expect(within(today).getByText("today")).toBeInTheDocument();
    expect(within(today).getByText("open")).toBeInTheDocument();
    expect(within(today).getByText(/0 payments/)).toBeInTheDocument();
    expect(within(rowOf("2026-08-10")).getByText("needs closing")).toBeInTheDocument();
    expect(within(rowOf("2026-08-10")).getByText(/3 payments/)).toBeInTheDocument();
    expect(within(rowOf("2026-08-09")).getByText("closed")).toBeInTheDocument();
    expect(within(rowOf("2026-08-09")).queryByRole("button", { name: /Close day/ })).not.toBeInTheDocument();
    expect(screen.getByText(/earlier day was never closed/)).toHaveTextContent("1 earlier day was never closed. You can still close it now");
    await waitFor(() => expect(tab(/Day close/)).toHaveTextContent("1"));
    // Newest first.
    const order = screen.getAllByText(/^(Mon|Tue|Wed|Thu|Fri|Sat|Sun)/).map((e) => e.textContent);
    expect(order[0]).toBe(longDay(T));
    expect(screen.getByText(/Close off each day's drawer/)).toBeInTheDocument();
  });

  test("REG-FE-CASHIER-031 two missed days use the plural", async () => {
    fake.on("GET", "/billing/day-closes", [D("2026-08-10"), D("2026-08-11", { count: 1 })]);
    const { user } = page();
    await user.click(tab(/Day close/));
    expect(await screen.findByText(/earlier days were never closed/)).toHaveTextContent("You can still close them now");
    expect(within(rowOf("2026-08-11")).getByText(/1 payment$/)).toBeInTheDocument();
  });

  test("REG-FE-CASHIER-032 opening a day lists takings per method, non-cash marked, and the cash expected in the drawer", async () => {
    fake.on("GET", "/billing/day-closes", [D(T)]);
    const { user } = page();
    await user.click(tab(/Day close/));
    await screen.findByText(longDay(T));
    const row = rowOf(T);
    await user.click(within(row).getByRole("button", { expanded: false }));
    expect(await within(row).findByText(/telebirr \(1\)/)).toBeInTheDocument();
    expect(within(row).getByText(/not in drawer/)).toBeInTheDocument();
    expect(within(row).getByText("Expected cash in drawer").nextSibling).toHaveTextContent("ETB 800.00");
    expect(within(row).getByText(/Close the drawer at the end of the day/)).toBeInTheDocument();
    expect(fake.sent("GET", "/billing/day-close")[0].query.get("date")).toBe(T);
    await user.click(within(row).getByRole("button", { expanded: true }));
    expect(within(row).queryByText("Expected cash in drawer")).not.toBeInTheDocument();
  });

  test("REG-FE-CASHIER-033 an empty day says no payments; a missed day says it was never closed", async () => {
    fake.on("GET", "/billing/day-closes", [D("2026-08-10")]);
    fake.on("GET", "/billing/day-close", { business_date: "2026-08-10", closed: false, expected_total: "0", by_method: [] });
    const { user } = page();
    await user.click(tab(/Day close/));
    await screen.findByText(longDay("2026-08-10"));
    const row = rowOf("2026-08-10");
    await user.click(within(row).getByRole("button", { expanded: false }));
    expect(await within(row).findByText("No payments on this day.")).toBeInTheDocument();
    expect(within(row).getByText("This day was never closed off.")).toBeInTheDocument();
  });

  test("REG-FE-CASHIER-034 a closed short day shows the variance, the counted cash, and prints its Z-report from the close", async () => {
    fake.on("GET", "/billing/day-closes", [D("2026-08-11", { closed: true, counted_total: "750", variance: "-50", note: "Gave change", closed_at: "2026-08-11T15:00:00Z" })]);
    fake.on("GET", "/billing/day-close", { ...EXP, business_date: "2026-08-11", closed: true, reconciliation: { business_date: "2026-08-11", expected_total: "800.00", counted_total: "750", variance: "-50", closed_at: "" } });
    const docs = capturePrints();
    const { user } = page();
    await user.click(tab(/Day close/));
    await screen.findByText(longDay("2026-08-11"));
    const row = rowOf("2026-08-11");
    expect(within(row).getByText("short ETB 50.00")).toBeInTheDocument();
    expect(within(row).getByText(/closed /)).toBeInTheDocument();
    await user.click(within(row).getByRole("button", { expanded: false }));
    expect(await within(row).findByText("Gave change")).toBeInTheDocument();
    expect(within(row).getByText("ETB 750.00")).toBeInTheDocument();
    expect(within(row).getByText("ETB -50.00")).toHaveClass("text-rose-600");
    await user.click(within(row).getByRole("button", { name: /Print Z-report/ }));
    expect(docs[0]).toContain("END-OF-DAY Z-REPORT");
    expect(docs[0]).toContain("Variance (SHORT)");
    expect(docs[0]).toContain("ETB 800.00");
    expect(docs[0]).toContain("telebirr (1) — not in drawer");
    await user.click(within(row).getByRole("button", { name: /Re-close/ }));
    expect(await screen.findByRole("dialog", { name: /Close day/ })).toHaveTextContent("Already closed — saving again updates the closeout.");
  });

  test("REG-FE-CASHIER-035 an over day is flagged over; a balanced one has no badge", async () => {
    fake.on("GET", "/billing/day-closes", [
      D("2026-08-11", { closed: true, counted_total: "1210", variance: "10" }),
      D("2026-08-10", { closed: true, counted_total: "1200", variance: "0" }),
    ]);
    const { user } = page();
    await user.click(tab(/Day close/));
    await screen.findByText(longDay("2026-08-11"));
    expect(within(rowOf("2026-08-11")).getByText("over ETB 10.00")).toBeInTheDocument();
    expect(within(rowOf("2026-08-10")).queryByText(/over|short/)).not.toBeInTheDocument();
  });

  test("REG-FE-CASHIER-036 closing today: expected per method, non-cash note, live variance, counted sent, Z printed", async () => {
    fake.on("GET", "/billing/day-closes", []);
    fake.on("POST", "/billing/day-close", { business_date: T, expected_total: "800.00", counted_total: "790", variance: "-10.00", closed_at: "" });
    const docs = capturePrints();
    const { user } = page();
    await user.click(tab(/Day close/));
    await screen.findByText(longDay(T));
    await user.click(within(rowOf(T)).getByRole("button", { name: /Close day/ }));
    const dlg = await screen.findByRole("dialog", { name: `Close day — ${longDay(T)}` });
    expect(await within(dlg).findByText(/cash \(2\)/)).toBeInTheDocument();
    expect(within(dlg).getByText(/ETB 400.00 more was taken by Telebirr, bank or card/)).toBeInTheDocument();
    expect(within(dlg).queryByText(/Closing an earlier day/)).not.toBeInTheDocument();
    const go = within(dlg).getByRole("button", { name: /Close & print Z-report/ });
    expect(go).toBeDisabled();
    const input = within(dlg).getByPlaceholderText("0.00");
    await user.type(input, "800");
    expect(within(dlg).getByText("Variance: ETB 0.00")).toHaveClass("text-emerald-600");
    await user.clear(input);
    await user.type(input, "790");
    expect(within(dlg).getByText("Variance: ETB -10.00")).toHaveClass("text-rose-600");
    await user.click(go);
    await waitFor(() => expect(fake.lastBody("POST", "/billing/day-close")).toEqual({ business_date: T, counted: 790, note: "" }));
    expect(toasts("success")).toContain("Day closed — variance ETB -10.00");
    expect(docs[0]).toContain("Variance (SHORT)");
    expect(docs[0]).toContain("Selam Desk");
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    await waitFor(() => expect(fake.sent("GET", "/billing/day-closes").length).toBeGreaterThan(1));
  });

  test("REG-FE-CASHIER-037 closing an earlier day says the Z-report is filed against that date; a refusal is shown", async () => {
    fake.on("GET", "/billing/day-closes", [D("2026-08-10")]);
    fake.on("GET", "/billing/day-close", { business_date: "2026-08-10", closed: false, expected_total: "0", by_method: [] });
    fake.on("POST", "/billing/day-close", fail(409, "Day locked"));
    const { user } = page();
    await user.click(tab(/Day close/));
    await screen.findByText(longDay("2026-08-10"));
    await user.click(within(rowOf("2026-08-10")).getByRole("button", { name: /Close day/ }));
    const dlg = await screen.findByRole("dialog");
    expect(within(dlg).getByText(/Closing an earlier day/)).toHaveTextContent("filed against 2026-08-10, not today");
    expect(within(dlg).queryByText(/more was taken by Telebirr/)).not.toBeInTheDocument();
    await user.type(within(dlg).getByPlaceholderText("0.00"), "0");
    await user.click(within(dlg).getByRole("button", { name: /Close & print/ }));
    await waitFor(() => expect(toasts("error")).toEqual(["Day locked"]));
    fake.on("POST", "/billing/day-close", () => { throw new Error("x"); });
    await user.click(within(dlg).getByRole("button", { name: /Close & print/ }));
    await waitFor(() => expect(toasts("error")[1]).toBe("Could not close the day"));
    await user.click(within(dlg).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
  });

  test("REG-FE-CASHIER-038 Count & close inside an opened row opens the same dialog; Escape closes it", async () => {
    fake.on("GET", "/billing/day-closes", []);
    const { user } = page();
    await user.click(tab(/Day close/));
    await screen.findByText(longDay(T));
    await user.click(within(rowOf(T)).getByRole("button", { expanded: false }));
    await user.click(await within(rowOf(T)).findByRole("button", { name: /Count & close/ }));
    expect(await screen.findByRole("dialog")).toBeInTheDocument();
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
  });

  test("REG-FE-CASHIER-039 the day list shows Loading while it is fetched", async () => {
    fake.on("GET", "/billing/day-closes", hang);
    const { user } = page();
    await user.click(tab(/Day close/));
    expect(await screen.findByText("Loading…")).toBeInTheDocument();
  });

  test.fails("REG-FE-CASHIER-040 KNOWN BUG UX-1 a failed day-close load looks like a quiet open day, not an error", async () => {
    fake.on("GET", "/billing/day-closes", fail(500, "down"));
    const { user } = page();
    await user.click(tab(/Day close/));
    await screen.findByText(longDay(T));
    expect(screen.getByRole("alert")).toHaveTextContent(/Could not load/);
  });

  test.fails("REG-FE-CASHIER-041 KNOWN BUG UX-1 a failed paid-list load reads 'No payments in this range.'", async () => {
    fake.on("GET", "/billing/payments", fail(500, "down"));
    const { user } = page();
    await user.click(tab(/^Paid/));
    await waitFor(() => expect(fake.sent("GET", "/billing/payments")).toHaveLength(1));
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent(/Could not load/));
  });

  test.fails("REG-FE-CASHIER-042 KNOWN BUG FE-9 'today' on the day close is the UTC date, not the clinic's (Addis) day", async () => {
    // 22:30 UTC on the 12th is 01:30 on the 13th in Addis Ababa: the drawer being
    // closed is the 13th's.
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-08-12T22:30:00Z"));
    fake.on("GET", "/billing/day-closes", []);
    const { user } = page();
    await user.click(tab(/Day close/));
    const badge = await screen.findByText("today");
    expect(badge.closest(".overflow-hidden")).toHaveTextContent(longDay("2026-08-13"));
  });

  test("REG-FE-CASHIER-043 bills the receptionist ticked are marked, with who ticked them and who the patient goes to", async () => {
    fake.on("GET", "/billing/charges/pending", [
      C("ch1", "a", "1200.00", { desk_selected: true, desk_selected_by: "Hana Desk", goes_to: "Dr Yonas" }),
      C("ch2", "a", "100.00"),
      C("ch3", "b", "50.00"),
    ]);
    page();
    const a = await screen.findByText("Patient a").then(() => cardOf("Patient a"));
    expect(within(a).getByText(/Agreed at reception \(Hana Desk\)/)).toHaveTextContent("goes to Dr Yonas once these are paid");
    expect(within(a).getAllByText("Picked at reception")).toHaveLength(1);
    expect(cardOf("Patient b")).not.toHaveTextContent(/Agreed at reception/);
  });

  test("REG-FE-CASHIER-044 a ticked bill with no recorded dentist says it is to be paid before the visit", async () => {
    fake.on("GET", "/billing/charges/pending", [C("ch1", "a", "500.00", { desk_selected: true })]);
    page();
    const a = await screen.findByText("Patient a").then(() => cardOf("Patient a"));
    expect(within(a).getByText(/Agreed at reception — to be paid before the visit/)).toBeInTheDocument();
  });
});
