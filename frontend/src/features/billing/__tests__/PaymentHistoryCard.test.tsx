// A patient's money story, written for the person at the desk. The card must take
// its four totals from the server (the whole account, not the newest page), tell the
// ledger in clinic words (Paid / Awaiting payment / Free of charge / Refunded /
// Cancelled), fold cancelled bills away, group the timeline by day, show a failed
// load as an error rather than "nothing billed", and print a receipt or statement
// that names the cashier who actually took the money.
import { screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

vi.mock("@/app/auth-context", () => ({
  useAuth: () => ({ can: () => true, flagOn: (f: string) => f === "dental", user: { id: "u1", full_name: "Hanna Desta" } }),
}));
const api = vi.hoisted(() => ({ patientCharges: vi.fn() }));
vi.mock("@/features/billing/api", async (orig) => ({ ...(await orig<object>()), ...api }));
const admin = vi.hoisted(() => ({ getClinic: vi.fn(), listBranches: vi.fn() }));
vi.mock("@/features/admin/api", async (orig) => ({ ...(await orig<object>()), ...admin }));
const patients = vi.hoisted(() => ({ getPatient: vi.fn() }));
vi.mock("@/features/patients/api", async (orig) => ({ ...(await orig<object>()), ...patients }));
const print = vi.hoisted(() => ({ printReceipt: vi.fn(), printStatement: vi.fn() }));
vi.mock("@/features/billing/print", async (orig) => ({ ...(await orig<object>()), ...print }));

import { PaymentHistoryCard } from "@/features/billing/PaymentHistoryCard";
import type { ChargeRow, PatientLedger } from "@/features/billing/api";
import { renderUI } from "@/test/render";

// Noon in Addis is the same calendar day in Addis, UTC and New York.
const NOW = new Date("2026-10-03T12:00:00+03:00");

const row = (id: string, over: Partial<ChargeRow> = {}): ChargeRow => ({
  id, source: "service", description: id, amount: "100", currency: "ETB", status: "paid", created_at: "2026-10-03T09:00:00+03:00", ...over,
});
const ledger = (rows: ChargeRow[], over: Partial<PatientLedger> = {}): PatientLedger => ({
  rows, charged: "0", paid: "0", refunded: "0", awaiting: "0", waived: "0", total_count: rows.length, truncated: false, ...over,
});
const tile = (label: string) => screen.getByText(label, { selector: "p" }).nextElementSibling!;

describe("REG-FE-PAYHIST a patient's payment history", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(NOW);
    api.patientCharges.mockReset();
    Object.values(print).forEach((f) => f.mockReset());
    admin.getClinic.mockResolvedValue({ name: "Cure Dental" });
    admin.listBranches.mockResolvedValue([{ id: "br_1", name: "Bole", address: "Bole Rd", phone: "0911" }]);
    patients.getPatient.mockResolvedValue({ id: "pat_1", mrn: "MRN-7", first_name: "Sara", middle_name: "T", last_name: "Bekele", phone: "0922" });
  });
  afterEach(() => vi.useRealTimers());

  test("REG-FE-PAYHIST-001 a failed load is an error with a retry, not 'nothing billed'", async () => {
    api.patientCharges.mockRejectedValueOnce(new Error("down")).mockResolvedValueOnce(ledger([]));
    const { user } = renderUI(<PaymentHistoryCard patientId="pat_1" />);
    expect(screen.getByText("Loading…")).toBeInTheDocument();
    expect(await screen.findByRole("alert")).toHaveTextContent("Could not load this patient's payment history");
    expect(screen.queryByText(/Nothing has been billed/)).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /Retry/ }));
    expect(await screen.findByText("Nothing has been billed to this patient yet.")).toBeInTheDocument();
    expect(api.patientCharges).toHaveBeenCalledWith("pat_1");
    expect(screen.queryByRole("button", { name: /Print statement/ })).not.toBeInTheDocument();
  });

  test("REG-FE-PAYHIST-002 the four totals come from the server's whole-account figures, not the page", async () => {
    api.patientCharges.mockResolvedValue(ledger([row("Consult", { amount: "100" })], { charged: "9000", paid: "6000", refunded: "500", awaiting: "2500" }));
    renderUI(<PaymentHistoryCard patientId="pat_1" />);
    await screen.findByText("Consult");
    expect(tile("Charged")).toHaveTextContent("9,000.00 ETB");
    expect(tile("Paid")).toHaveTextContent("6,000.00 ETB");
    expect(screen.getByText("After refunds")).toBeInTheDocument();
    expect(tile("Refunded")).toHaveTextContent("500.00 ETB");
    expect(tile("Awaiting payment")).toHaveTextContent("2,500.00 ETB");
  });

  test("REG-FE-PAYHIST-003 the timeline speaks clinic language, grouped by day, newest first", async () => {
    api.patientCharges.mockResolvedValue(ledger([
      row("Old filling", { settled_at: "2026-09-20T10:00:00+03:00", receipt_no: 12, payment_method: "Telebirr" }),
      row("Scaling", { status: "pending", created_at: "2026-10-03T08:00:00+03:00" }),
      row("Staff checkup", { status: "waived", waive_reason: "Staff benefit", created_at: "2026-10-02T09:00:00+03:00" }),
      row("Card", { status: "waived", created_at: "2026-10-02T08:00:00+03:00" }),
      row("Refund X-ray", { source: "refund", amount: "-200", settled_at: "2026-10-03T10:00:00+03:00" }),
      row("Weird", { status: "on_hold", created_at: "2026-10-02T07:00:00+03:00" }),
      row("Nodate", { created_at: "", status: "pending" }),
    ]));
    renderUI(<PaymentHistoryCard patientId="pat_1" />);
    await screen.findByText("Scaling");
    const headings = screen.getAllByText(/^(Today|Yesterday|Undated|\w{3}, .*)$/, { selector: "span" }).map((s) => s.textContent);
    const older = new Date("2026-09-20T00:00:00").toLocaleDateString(undefined, { weekday: "short", day: "numeric", month: "short", year: "numeric" });
    expect(headings).toEqual(["Today", "Yesterday", older, "Undated"]);
    expect(screen.getAllByText("Sent to the cashier — not yet paid")).toHaveLength(2);
    expect(screen.getByText("Staff benefit")).toBeInTheDocument();
    expect(screen.getByText("Waived")).toBeInTheDocument();
    expect(screen.getAllByText("Free of charge")).toHaveLength(2);
    // The tile label and the refund row's badge.
    expect(screen.getAllByText("Refunded")).toHaveLength(2);
    expect(screen.getByText("Money returned to the patient")).toBeInTheDocument();
    expect(screen.getByText("on_hold")).toBeInTheDocument();
    expect(screen.getByText(/· Telebirr · receipt RCP-000012/)).toBeInTheDocument();
    expect(screen.getByText("-200.00 ETB")).toBeInTheDocument();
  });

  test("REG-FE-PAYHIST-004 cancelled bills are folded away, and can be shown and hidden again", async () => {
    api.patientCharges.mockResolvedValue(ledger([row("Kept"), row("Wrong patient", { status: "void" }), row("Dup", { status: "void" })]));
    const { user } = renderUI(<PaymentHistoryCard patientId="pat_1" />);
    await screen.findByText("Kept");
    expect(screen.queryByText("Wrong patient")).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /Show 2 cancelled bills/ }));
    expect(screen.getByText("Wrong patient")).toBeInTheDocument();
    expect(screen.getAllByText("Cancelled")).toHaveLength(2);
    await user.click(screen.getByRole("button", { name: /Hide 2 cancelled bills/ }));
    expect(screen.queryByText("Wrong patient")).not.toBeInTheDocument();
  });

  test("REG-FE-PAYHIST-005 one cancelled bill is singular", async () => {
    api.patientCharges.mockResolvedValue(ledger([row("Kept"), row("Gone", { status: "void" })]));
    renderUI(<PaymentHistoryCard patientId="pat_1" bare />);
    expect(await screen.findByRole("button", { name: /Show 1 cancelled bill ·/ })).toBeInTheDocument();
  });

  test("REG-FE-PAYHIST-006 reprinting a receipt names the cashier on record, not whoever is at the desk", async () => {
    api.patientCharges.mockResolvedValue(ledger([
      row("Crown", { amount: "4000", receipt_no: 9, payment_method: "Cash", settled_by: "Meron", settled_at: "2026-10-03T10:00:00+03:00" }),
      row("Pending", { status: "pending" }),
    ]));
    const { user } = renderUI(<PaymentHistoryCard patientId="pat_1" />);
    await waitFor(() => expect(screen.getAllByRole("button", { name: /Receipt/ })).toHaveLength(1));
    await waitFor(() => expect(patients.getPatient).toHaveBeenCalled());
    await waitFor(async () => {
      await user.click(screen.getByRole("button", { name: /Receipt/ }));
      expect(print.printReceipt).toHaveBeenLastCalledWith(expect.objectContaining({ patient: "Sara T Bekele", clinic: "Cure Dental" }));
    });
    expect(print.printReceipt).toHaveBeenLastCalledWith({
      clinic: "Cure Dental", receiptNo: 9, patient: "Sara T Bekele", mrn: "MRN-7",
      description: "Crown", amount: "4000", currency: "ETB", method: "Cash", cashier: "Meron",
      when: "2026-10-03T10:00:00+03:00", refund: false,
    });
  });

  test("REG-FE-PAYHIST-007 the statement: real money only, oldest first, server totals, dental balance, truncation note", async () => {
    api.patientCharges.mockResolvedValue(ledger([
      row("B second", { created_at: "2026-10-02T09:00:00+03:00", amount: "200" }),
      row("A first", { created_at: "2026-10-01T09:00:00+03:00", status: "pending", amount: "300" }),
      row("Void", { status: "void", created_at: "2026-10-01T10:00:00+03:00" }),
    ], { charged: "500", paid: "200", refunded: "0", awaiting: "300", truncated: true, total_count: 80 }));
    const { user } = renderUI(<PaymentHistoryCard patientId="pat_1" treatment={{ unbilled: "1500", upcoming: "4000" }} />);
    await screen.findByText("A first");
    await waitFor(async () => {
      await user.click(screen.getByRole("button", { name: /Print statement/ }));
      expect(print.printStatement).toHaveBeenLastCalledWith(expect.objectContaining({ clinicContact: "Bole Rd · 0911", mrn: "MRN-7" }));
    });
    expect(print.printStatement).toHaveBeenLastCalledWith({
      clinic: "Cure Dental", clinicContact: "Bole Rd · 0911", patient: "Sara T Bekele", mrn: "MRN-7", phone: "0922", currency: "ETB",
      lines: [
        { date: "2026-10-01", description: "A first", status: "Awaiting payment", amount: "300" },
        { date: "2026-10-02", description: "B second", status: "Paid", amount: "200" },
      ],
      charged: "500", paid: "200", refunded: "0", outstanding: "300", unbilled: "1500", upcoming: "4000",
      issuedBy: "Hanna Desta",
      note: "Showing the 3 most recent entries of 80. The totals above cover the full account.",
    });
  });

  test("REG-FE-PAYHIST-008 statement before the patient, clinic or branch load: safe fallbacks", async () => {
    patients.getPatient.mockReturnValue(new Promise(() => {}));
    admin.getClinic.mockRejectedValue(new Error("x"));
    admin.listBranches.mockResolvedValue([{ id: "b", name: "B", address: "", phone: "" }]);
    api.patientCharges.mockResolvedValue(ledger([row("Only", { currency: "" })]));
    const { user } = renderUI(<PaymentHistoryCard patientId="pat_1" />);
    await screen.findByText("Only");
    await waitFor(() => expect(admin.listBranches).toHaveBeenCalled());
    await new Promise((r) => setTimeout(r, 20));
    await user.click(screen.getByRole("button", { name: /Print statement/ }));
    expect(print.printStatement).toHaveBeenLastCalledWith(expect.objectContaining({
      clinic: "Clinic", patient: "Patient", mrn: undefined, currency: "ETB", clinicContact: undefined, note: undefined,
      unbilled: undefined, upcoming: undefined,
    }));
  });

  // NEW-PAYHIST-1: the timeline's day is the first ten characters of the ISO string
  // (PaymentHistoryCard.tsx:28 `whenOf(c).slice(0, 10)`). The server sends UTC
  // timestamps, so a payment taken at 00:30 in Addis ("2026-10-02T21:30:00Z") is filed
  // under yesterday — and printed on the statement with yesterday's date.
  test.fails("REG-FE-PAYHIST-009 KNOWN BUG NEW-PAYHIST-1 a payment at 00:30 Addis is filed under Today, not Yesterday", async () => {
    api.patientCharges.mockResolvedValue(ledger([row("Night visit", { settled_at: "2026-10-02T21:30:00Z" })]));
    renderUI(<PaymentHistoryCard patientId="pat_1" />);
    await screen.findByText("Night visit");
    expect(screen.getByText("Today", { selector: "span" })).toBeInTheDocument();
  });
});
