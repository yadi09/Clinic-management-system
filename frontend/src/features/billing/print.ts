// Print helpers for money papers. Every one goes through the shared print engine
// (features/printing): the clinic's own header, template and paper, a preview, and a
// DUPLICATE mark on a reprint of a paper that is counted.
import { requestPrint } from "@/features/printing/request";

export interface ReceiptArgs {
  clinic: string;
  receiptNo?: number;
  patient: string;
  mrn?: string;
  phone?: string;
  description: string;
  amount: string;
  currency: string;
  method?: string;
  /** The transaction reference, for a transfer or wallet payment. */
  reference?: string;
  cashier?: string;
  when: string;
  refund?: boolean;
  /** What is still owed after this payment, when the caller knows. */
  balance?: string;
}

const numberOf = (n?: number) => (n != null ? `RCP-${String(n).padStart(6, "0")}` : "");

/** One charge's receipt (or its refund slip). The paper is the clinic's own: see
 *  features/printing for the look, the paper, and the reprint mark. */
export function printReceipt(o: ReceiptArgs) {
  void requestPrint({
    doc: "receipt",
    data: {
      kind: o.refund ? "refund" : "payment", number: numberOf(o.receiptNo), when: o.when,
      patient: o.patient, mrn: o.mrn, phone: o.phone,
      lines: [{ description: o.description, amount: o.amount }], total: o.amount, currency: o.currency,
      method: o.method, reference: o.reference, cashier: o.cashier, balance: o.balance,
    },
  }, { clinic: o.clinic });
}

export function printVisitReceipt(o: {
  clinic: string;
  receiptNo?: number;
  patient: string;
  mrn?: string;
  phone?: string;
  lines: { description: string; amount: string }[];
  total: string;
  currency: string;
  method?: string;
  /** The transaction reference, for a transfer or wallet payment. */
  reference?: string;
  cashier?: string;
  when: string;
  /** The payment has since been refunded: the paper must say so, not read as paid. */
  refunded?: boolean;
  balance?: string;
}) {
  void requestPrint({
    doc: "receipt",
    data: {
      kind: "payment", number: numberOf(o.receiptNo), when: o.when,
      patient: o.patient, mrn: o.mrn, phone: o.phone, lines: o.lines, total: o.total, currency: o.currency,
      method: o.method, reference: o.reference, cashier: o.cashier, refunded: o.refunded, balance: o.balance,
    },
  }, { clinic: o.clinic });
}

/**
 * Patient statement of account — a sheet, not a till slip.
 *
 * A receipt proves one payment; a statement answers "what has this patient been
 * charged, what have they paid, and what is still owed?". Dental treatment runs
 * over months in instalments, so patients (and the employers/insurers who
 * reimburse them) routinely ask for exactly this on paper.
 *
 * Cancelled bills are deliberately excluded by the caller: no money ever moved, and
 * listing them makes an official document look like the patient owes more than they do.
 */
export function printStatement(o: {
  clinic: string;
  clinicContact?: string;
  patient: string;
  mrn?: string;
  phone?: string;
  currency: string;
  lines: { date: string; description: string; status: string; amount: string }[];
  charged: string;
  paid: string;
  refunded: string;
  outstanding: string;
  /** Dental only: treatment given (or a down payment agreed) not yet billed, and
   *  future visits on running courses. Absent for a general clinic. */
  unbilled?: string;
  upcoming?: string;
  issuedBy?: string;
  /** Printed under the lines when they are a page and the totals are the whole account. */
  note?: string;
  /** The clinic's own accounts, so the patient knows where to send the money. */
  payTo?: { label: string; account: string }[];
}) {
  const { clinic, clinicContact, ...data } = o;
  void requestPrint({ doc: "statement", data }, { clinic, contact: clinicContact });
}

export function printZReport(o: {
  clinic: string;
  cashier: string;
  businessDate: string;
  byMethod: { label: string; total: string; count: number; cash?: boolean }[];
  expected: string;
  counted: string;
  variance: string;
  note?: string;
  currency?: string;
}) {
  const { clinic, ...data } = o;
  void requestPrint({ doc: "zreport", data }, { clinic });
}
