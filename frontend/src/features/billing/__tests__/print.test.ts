// The paper the clinic hands out. A receipt is an accountability record: it must
// carry the receipt number, the patient, every line, the total, how it was paid (and
// the transfer reference), and who took the money. A Z-report must say plainly
// whether the drawer balanced. A statement must state the real balance — including
// dental treatment given but not yet billed. And whatever a patient's name says, it
// must never become markup on the printed page.
import { afterEach, beforeEach, describe, expect, test, vi, type MockInstance } from "vitest";

import { printReceipt, printStatement, printVisitReceipt, printZReport } from "@/features/billing/print";

let written = "";
let opened: { write: ReturnType<typeof vi.fn>; close: ReturnType<typeof vi.fn> };
let openSpy: MockInstance<typeof window.open>;

beforeEach(() => {
  written = "";
  opened = { write: vi.fn((s: string) => { written += s; }), close: vi.fn() };
  openSpy = vi.spyOn(window, "open").mockReturnValue({ document: opened } as unknown as Window);
});
afterEach(() => openSpy.mockRestore());

/** The visible text of the printed body, tags stripped, whitespace collapsed. */
const text = () => {
  const doc = new DOMParser().parseFromString(written, "text/html");
  doc.querySelectorAll("script,style").forEach((n) => n.remove());
  const walker = doc.createTreeWalker(doc.body, NodeFilter.SHOW_TEXT);
  const parts: string[] = [];
  for (let n = walker.nextNode(); n; n = walker.nextNode()) parts.push(n.textContent ?? "");
  return parts.join(" ").replace(/\s+/g, " ").trim();
};

describe("REG-FE-PRINT printed slips", () => {
  test("REG-FE-PRINT-001 visit receipt: number, patient, every line, total, method, reference, cashier, then print", () => {
    printVisitReceipt({
      clinic: "Cure Dental", receiptNo: 42, patient: "Abebe Kebede", mrn: "MRN-7",
      lines: [{ description: "Scaling", amount: "800.00" }, { description: "X-ray", amount: "200.00" }],
      total: "1000.00", currency: "ETB", method: "Telebirr", reference: "CH7K2M9QRS", cashier: "Hanna",
      when: "2026-10-03T09:00:00+03:00",
    });
    expect(openSpy).toHaveBeenCalledWith("", "_blank", "width=420,height=640");
    const t = text();
    expect(written).toContain("<title>RCP-000042</title>");
    expect(t).toContain("Cure Dental");
    expect(t).toContain("PAYMENT RECEIPT");
    expect(t).toContain("Abebe Kebede (MRN-7)");
    expect(t).toContain("Scaling ETB 800.00");
    expect(t).toContain("X-ray ETB 200.00");
    expect(t).toContain("TOTAL ETB 1000.00");
    expect(t).toContain("Method Telebirr");
    expect(t).toContain("Reference CH7K2M9QRS");
    expect(t).toContain("Cashier Hanna");
    expect(written).toContain("window.print()");
    expect(opened.close).toHaveBeenCalled();
  });

  test("REG-FE-PRINT-002 visit receipt without number, method, reference or cashier prints dashes, not 'undefined'", () => {
    printVisitReceipt({ clinic: "C", patient: "P", lines: [], total: "0", currency: "ETB", when: "2026-10-03T09:00:00+03:00" });
    const t = text();
    expect(written).toContain("<title>—</title>");
    expect(t).toContain("Method —");
    expect(t).toContain("Cashier —");
    expect(t).not.toContain("Reference");
    expect(t).not.toContain("undefined");
    expect(t).not.toContain("(");
  });

  test("REG-FE-PRINT-003 names are escaped: a patient called <b>x</b> does not become markup", () => {
    printVisitReceipt({
      clinic: "A&B <Clinic>", patient: "<img src=x onerror=alert(1)>", lines: [{ description: "<script>x</script>", amount: "1" }],
      total: "1", currency: "ETB", when: "2026-10-03T09:00:00+03:00",
    });
    expect(written).toContain("A&amp;B &lt;Clinic&gt;");
    expect(written).not.toContain("<img src=x");
    expect(written).toContain("&lt;script&gt;x&lt;/script&gt;");
  });

  test("REG-FE-PRINT-004 a blocked pop-up is not a crash: nothing is written", () => {
    openSpy.mockReturnValue(null);
    expect(() => printVisitReceipt({ clinic: "C", patient: "P", lines: [], total: "0", currency: "ETB", when: "2026-10-03" })).not.toThrow();
    expect(() => printStatement({ clinic: "C", patient: "P", currency: "ETB", lines: [], charged: "0", paid: "0", refunded: "0", outstanding: "0" })).not.toThrow();
    expect(opened.write).not.toHaveBeenCalled();
  });

  test("REG-FE-PRINT-005 single receipt: payment vs refund slip, with the reference when given", () => {
    printReceipt({
      clinic: "Cure", receiptNo: 7, patient: "Sara", mrn: "M1", description: "Filling", amount: "1500",
      currency: "ETB", method: "CBE", reference: "FT25123ABCD", cashier: "Hanna", when: "2026-10-03T09:00:00+03:00",
    });
    let t = text();
    expect(t).toContain("PAYMENT RECEIPT");
    expect(t).toContain("RCP-000007");
    expect(t).toContain("Sara (M1)");
    expect(t).toContain("Filling ETB 1500");
    expect(t).toContain("TOTAL ETB 1500");
    expect(t).toContain("Reference FT25123ABCD");
    expect(t).toContain("Cashier Hanna");

    written = "";
    printReceipt({ clinic: "Cure", patient: "Sara", description: "Refund", amount: "-1500", currency: "ETB", when: "2026-10-03", refund: true });
    t = text();
    expect(t).toContain("REFUND SLIP");
    expect(written).toContain("<title>—</title>");
    expect(t).toContain("Method —");
    expect(t).toContain("Cashier —");
    expect(t).not.toContain("Reference");
  });

  test("REG-FE-PRINT-006 Z-report: methods (non-cash flagged), expected, counted, and BALANCED / OVER / SHORT", () => {
    printZReport({
      clinic: "Cure", cashier: "Hanna", businessDate: "2026-10-03",
      byMethod: [{ label: "cash", total: "1000", count: 3, cash: true }, { label: "Telebirr", total: "500", count: 1 }],
      expected: "1000", counted: "1000", variance: "0", note: "All good",
    });
    let t = text();
    expect(written).toContain("<title>Z-2026-10-03</title>");
    expect(t).toContain("END-OF-DAY Z-REPORT");
    expect(t).toContain("Cashier Hanna");
    expect(t).toContain("Business date 2026-10-03");
    expect(t).toContain("cash (3) ETB 1000");
    expect(t).toContain("Telebirr (1) — not in drawer ETB 500");
    expect(t).toContain("Expected cash ETB 1000");
    expect(t).toContain("Counted cash ETB 1000");
    expect(t).toContain("Variance (BALANCED) ETB 0");
    expect(t).toContain("Note All good");

    written = "";
    printZReport({ clinic: "C", cashier: "H", businessDate: "d", byMethod: [], expected: "100", counted: "150", variance: "50", currency: "USD" });
    t = text();
    expect(t).toContain("Variance (OVER) USD 50");
    expect(t).toContain("No collections USD 0.00");
    expect(t).not.toContain("Note");

    written = "";
    printZReport({ clinic: "C", cashier: "H", businessDate: "d", byMethod: [], expected: "100", counted: "80", variance: "-20" });
    expect(text()).toContain("Variance (SHORT) ETB -20");
  });

  test("REG-FE-PRINT-007 statement (general clinic): lines, totals, refund row only when refunded, the page note", () => {
    printStatement({
      clinic: "Cure", clinicContact: "Bole · 0911", patient: "Sara <S>", mrn: "M1", phone: "0911000000", currency: "ETB",
      lines: [{ date: "2026-10-01", description: "Consult", status: "Paid", amount: "300" }],
      charged: "300", paid: "300", refunded: "0", outstanding: "0", issuedBy: "Hanna", note: "Showing the 50 most recent entries",
    });
    expect(openSpy).toHaveBeenCalledWith("", "_blank", "width=820,height=1000");
    expect(written).toContain("<title>Statement — Sara &lt;S&gt;</title>");
    const t = text();
    expect(t).toContain("Statement of account");
    expect(t).toContain("Bole · 0911");
    expect(t).toContain("by Hanna");
    expect(t).toContain("2026-10-01 Consult Paid ETB 300.00");
    expect(t).toContain("Total charged ETB 300.00");
    expect(t).toContain("Balance outstanding ETB 0.00");
    expect(t).not.toContain("Refunded");
    expect(t).not.toContain("not yet billed");
    expect(t).toContain("Showing the 50 most recent entries");
  });

  test("REG-FE-PRINT-008 statement (dental): balance owed now = billed-unpaid + treatment given unbilled; upcoming listed apart", () => {
    printStatement({
      clinic: "Cure", patient: "Sara", currency: "ETB", lines: [],
      charged: "5000", paid: "3000", refunded: "500", outstanding: "2000", unbilled: "1500", upcoming: "4000",
    });
    const t = text();
    expect(t).toContain("No billing activity.");
    expect(t).toContain("Card / MRN —");
    expect(t).toContain("Phone —");
    expect(t).toContain("Refunded − ETB 500.00");
    expect(t).toContain("Billed, not yet paid ETB 2,000.00");
    expect(t).toContain("Treatment given, not yet billed ETB 1,500.00");
    expect(t).toContain("Balance owed now ETB 3,500.00");
    expect(t).toContain("Still to come on treatment plans (not yet owed) ETB 4,000.00");

    written = "";
    printStatement({ clinic: "Cure", patient: "Sara", currency: "ETB", lines: [], charged: "0", paid: "0", refunded: "0", outstanding: "0", unbilled: "0", upcoming: "0" });
    expect(text()).not.toContain("Still to come");
  });
});
