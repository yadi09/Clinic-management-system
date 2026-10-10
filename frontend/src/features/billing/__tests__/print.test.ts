// The paper the clinic hands out. A receipt is an accountability record: it must
// carry the receipt number, the patient, every line, the total, how it was paid (and
// the transfer reference), and who took the money. A Z-report must say plainly
// whether the drawer balanced. A statement must state the real balance — including
// dental treatment given but not yet billed. And whatever a patient's name says, it
// must never become markup on the printed page.
import { beforeEach, describe, expect, test, vi } from "vitest";

import { printReceipt, printStatement, printVisitReceipt, printZReport } from "@/features/billing/print";
vi.mock("@/features/printing/api", () => ({
  peekPrint: vi.fn(async () => ({ count: 0 })), logPrint: vi.fn(async () => ({ count: 1 })),
  getPrintSettings: vi.fn(), savePrintSettings: vi.fn(),
}));

import { transport } from "@/features/printing/engine";

// Every paper is drawn by the print engine (features/printing) and arrives at its
// transport; this file reads what the clinic's paper actually says.
const sent: string[] = [];
beforeEach(() => {
  sent.length = 0;
  vi.spyOn(transport, "send").mockImplementation((html: string) => { sent.push(html); });
});

/** The text of the last receipt the engine sent. */
const textOf = (html: string) => {
  const doc = new DOMParser().parseFromString(html, "text/html");
  doc.querySelectorAll("script,style").forEach((n) => n.remove());
  const walker = doc.createTreeWalker(doc.body, NodeFilter.SHOW_TEXT);
  const parts: string[] = [];
  for (let n = walker.nextNode(); n; n = walker.nextNode()) parts.push(n.textContent ?? "");
  return parts.join(" ").replace(/\s+/g, " ").trim();
};
const receiptText = () => textOf(sent[sent.length - 1] ?? "");
const waitSent = async (n = 1) => { await vi.waitFor(() => expect(sent.length).toBeGreaterThanOrEqual(n)); };

describe("REG-FE-PRINT printed slips", () => {
  test("REG-FE-PRINT-001 visit receipt: number, patient, every line, total, method, reference, cashier", async () => {
    printVisitReceipt({
      clinic: "Cure Dental", receiptNo: 42, patient: "Abebe Kebede", mrn: "MRN-7",
      lines: [{ description: "Scaling", amount: "800.00" }, { description: "X-ray", amount: "200.00" }],
      total: "1000.00", currency: "ETB", method: "Telebirr", reference: "CH7K2M9QRS", cashier: "Hanna",
      when: "2026-10-03T09:00:00+03:00",
    });
    await waitSent();
    const t = receiptText();
    expect(sent[0]).toContain("<title>RCP-000042</title>");
    expect(t).toContain("Cure Dental");
    expect(t).toContain("Payment receipt");
    expect(t).toContain("RCP-000042");
    expect(t).toContain("Abebe Kebede (MRN-7)");
    expect(t).toContain("Scaling");
    expect(t).toContain("800.00");
    expect(t).toContain("X-ray");
    expect(t).toContain("1,000.00");
    expect(t).toContain("Telebirr");
    expect(t).toContain("CH7K2M9QRS");
    expect(t).toContain("Hanna");
    // The Addis clock, the same on every computer.
    expect(t).toContain("3 Oct 2026, 9:00 AM");
  });

  test("REG-FE-PRINT-002 visit receipt without number, method, reference or cashier prints dashes, not 'undefined'", async () => {
    printVisitReceipt({ clinic: "C", patient: "P", lines: [], total: "0", currency: "ETB", when: "2026-10-03T09:00:00+03:00" });
    await waitSent();
    const t = receiptText();
    expect(t).not.toContain("undefined");
    expect(t).toContain("Paid by —");
    expect(t).toContain("Received by —");
    expect(t).not.toContain("Reference");
  });

  test("REG-FE-PRINT-003 names are escaped: a patient called <b>x</b> does not become markup", async () => {
    printVisitReceipt({
      clinic: "A&B <Clinic>", patient: "<img src=x onerror=alert(1)>", lines: [{ description: "<script>x</script>", amount: "1" }],
      total: "1", currency: "ETB", when: "2026-10-03T09:00:00+03:00",
    });
    await waitSent();
    expect(sent[0]).toContain("A&amp;B &lt;Clinic&gt;");
    expect(sent[0]).not.toContain("<img src=x");
    expect(sent[0]).toContain("&lt;script&gt;x&lt;/script&gt;");
  });

  test("REG-FE-PRINT-004 a pop-up blocker cannot swallow a paper: nothing opens a window", async () => {
    const open = vi.spyOn(window, "open").mockReturnValue(null);
    printStatement({ clinic: "C", patient: "P", currency: "ETB", lines: [], charged: "0", paid: "0", refunded: "0", outstanding: "0" });
    printZReport({ clinic: "C", cashier: "H", businessDate: "2026-10-03", byMethod: [], expected: "0", counted: "0", variance: "0" });
    await waitSent(2);
    expect(open).not.toHaveBeenCalled();
  });

  test("REG-FE-PRINT-005 single receipt: payment vs refund slip, with the reference when given", async () => {
    printReceipt({
      clinic: "Cure", receiptNo: 7, patient: "Sara", mrn: "M1", description: "Filling", amount: "1500",
      currency: "ETB", method: "CBE", reference: "FT25123ABCD", cashier: "Hanna", when: "2026-10-03T09:00:00+03:00",
    });
    await waitSent(1);
    let t = receiptText();
    expect(t).toContain("Payment receipt");
    expect(t).toContain("RCP-000007");
    expect(t).toContain("Sara (M1)");
    expect(t).toContain("Filling");
    expect(t).toContain("ETB 1,500.00");
    expect(t).toContain("FT25123ABCD");
    expect(t).toContain("Hanna");

    printReceipt({ clinic: "Cure", patient: "Sara", description: "Refund", amount: "-1500", currency: "ETB", when: "2026-10-03T09:00:00+03:00", refund: true });
    await waitSent(2);
    t = receiptText();
    expect(t).toContain("Refund slip");
    expect(sent[1]).toContain("<title>—</title>");
    expect(t).toContain("Paid by —");
    expect(t).toContain("Received by —");
    expect(t).not.toContain("Reference");
  });

  test("REG-FE-PRINT-009 a refunded visit receipt reprints as REFUNDED, never as an ordinary payment", async () => {
    printVisitReceipt({
      clinic: "Cure", receiptNo: 9, patient: "Sara", lines: [{ description: "Filling", amount: "1500" }],
      total: "1500", currency: "ETB", when: "2026-10-03T09:00:00+03:00", refunded: true,
    });
    await waitSent();
    expect(receiptText()).toContain("Payment receipt — REFUNDED");
  });

  test("REG-FE-PRINT-006 Z-report: methods (non-cash flagged), expected, counted, and BALANCED / OVER / SHORT", async () => {
    printZReport({
      clinic: "Cure", cashier: "Hanna", businessDate: "2026-10-03",
      byMethod: [{ label: "cash", total: "1000", count: 3, cash: true }, { label: "Telebirr", total: "500", count: 1 }],
      expected: "1000", counted: "1000", variance: "0", note: "All good",
    });
    await waitSent();
    let t = receiptText();
    expect(sent[0]).toContain("<title>Z-2026-10-03</title>");
    expect(t).toContain("End-of-day Z-report");
    expect(t).toContain("Cashier Hanna");
    expect(t).toContain("Business date 3 Oct 2026");
    expect(t).toContain("cash (3) ETB 1,000.00");
    expect(t).toContain("Telebirr (1) — not in drawer ETB 500.00");
    expect(t).toContain("Expected cash ETB 1,000.00");
    expect(t).toContain("Counted cash ETB 1,000.00");
    expect(t).toContain("Variance (BALANCED) ETB 0.00");
    expect(t).toContain("Note All good");
    // Both signature lines, so the cashier and the manager can sign what they file.
    expect(t).toContain("Cashier signature");
    expect(t).toContain("Manager signature");

    printZReport({ clinic: "C", cashier: "H", businessDate: "2026-10-04", byMethod: [], expected: "100", counted: "150", variance: "50", currency: "USD" });
    await waitSent(2);
    t = receiptText();
    expect(t).toContain("Variance (OVER) USD 50.00");
    expect(t).toContain("No collections USD 0.00");
    expect(t).not.toContain("Note");

    printZReport({ clinic: "C", cashier: "H", businessDate: "2026-10-05", byMethod: [], expected: "100", counted: "80", variance: "-20" });
    await waitSent(3);
    expect(receiptText()).toContain("Variance (SHORT) ETB -20.00");
  });

  test("REG-FE-PRINT-007 statement (general clinic): lines, totals, refund row only when refunded, the page note", async () => {
    printStatement({
      clinic: "Cure", clinicContact: "Bole · 0911", patient: "Sara <S>", mrn: "M1", phone: "0911000000", currency: "ETB",
      lines: [{ date: "2026-10-01", description: "Consult", status: "Paid", amount: "300" }],
      charged: "300", paid: "300", refunded: "0", outstanding: "0", issuedBy: "Hanna", note: "Showing the 50 most recent entries",
    });
    await waitSent();
    // The tab title is plain text: angle brackets are dropped, never turned into markup.
    expect(sent[0]).toContain("<title>Statement of account — Sara S</title>");
    expect(sent[0]).not.toContain("<S>");
    const t = receiptText();
    expect(t).toContain("Statement of account");
    expect(t).toContain("Bole · 0911");
    expect(t).toContain("by Hanna");
    expect(t).toContain("2026-10-01 Consult Paid ETB 300.00");
    expect(t).toContain("Total charged ETB 300.00");
    expect(t).toContain("Balance outstanding ETB 0.00");
    expect(t).not.toContain("Refunded");
    expect(t).not.toContain("not yet billed");
    expect(t).toContain("Showing the 50 most recent entries");
    // The phone is the patient's: it stays off the paper unless the clinic switches it on.
    expect(t).not.toContain("0911000000");
  });

  test("REG-FE-PRINT-008 statement (dental): balance owed now = billed-unpaid + treatment given unbilled; upcoming listed apart", async () => {
    printStatement({
      clinic: "Cure", patient: "Sara", currency: "ETB", lines: [],
      charged: "5000", paid: "3000", refunded: "500", outstanding: "2000", unbilled: "1500", upcoming: "4000",
    });
    await waitSent();
    const t = receiptText();
    expect(t).toContain("No billing activity.");
    expect(t).toContain("Card no. —");
    expect(t).toContain("Refunded − ETB 500.00");
    expect(t).toContain("Billed, not yet paid ETB 2,000.00");
    expect(t).toContain("Treatment given, not yet billed ETB 1,500.00");
    expect(t).toContain("Balance owed now ETB 3,500.00");
    expect(t).toContain("Still to come on treatment plans (not yet owed) ETB 4,000.00");

    printStatement({ clinic: "Cure", patient: "Sara", currency: "ETB", lines: [], charged: "0", paid: "0", refunded: "0", outstanding: "0", unbilled: "0", upcoming: "0" });
    await waitSent(2);
    expect(receiptText()).not.toContain("Still to come");
  });

  test("REG-FE-PRINT-010 statement: the clinic's accounts say where to pay, and only when it has any", async () => {
    printStatement({
      clinic: "Cure", patient: "Sara", currency: "ETB", lines: [],
      charged: "100", paid: "0", refunded: "0", outstanding: "100",
      payTo: [{ label: "CBE (Cure Dental)", account: "1000 123" }, { label: "Telebirr", account: "0911 000" }],
    });
    await waitSent();
    let t = receiptText();
    expect(t).toContain("How to pay");
    expect(t).toContain("CBE (Cure Dental) · 1000 123");
    expect(t).toContain("Telebirr · 0911 000");

    printStatement({ clinic: "Cure", patient: "Sara", currency: "ETB", lines: [], charged: "0", paid: "0", refunded: "0", outstanding: "0" });
    await waitSent(2);
    t = receiptText();
    expect(t).not.toContain("How to pay");
  });
});
