// Cashier defects found while covering the cashier (the main suite is
// CashierPage.test.tsx). Each test asserts what the desk SHOULD see and is marked
// test.fails until the product is fixed — remove .fails with the fix.
//
// - A reprinted Z-report is an accountability record: it must name the cashier who
//   closed that day, not whoever happens to be at the terminal when it is reprinted
//   (the same rule the receipt reprint already follows).
// - A void/waive dialog must open blank for every charge. A reason picked for one
//   line and then cancelled must not sit pre-selected under the button for the next.
import { screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

vi.mock("@/lib/api-client", async (orig) => ({ ...(await orig<object>()), ...(await import("@/test/frontdesk")).apiModule }));
vi.mock("@/app/auth-context", async () => (await import("@/test/frontdesk")).authModule);
vi.mock("@/components/ui/sonner", async (orig) => ({ ...(await orig<object>()), toast: (await import("@/test/frontdesk")).toastSpy }));

import { CashierPage } from "@/features/billing/pages/CashierPage";
import type { PendingCharge } from "@/features/billing/api";
import { capturePrints, fake, resetToasts, setAuth } from "@/test/frontdesk";
import { renderUI } from "@/test/render";

// Noon in Addis: the same calendar day in Addis, UTC and New York.
const NOW = new Date("2026-10-03T12:00:00+03:00");
const C = (id: string, patient: string): PendingCharge => ({
  id, patient_id: `pat_${patient}`, source: "dental", description: `Service ${id}`, amount: "100.00", currency: "ETB",
  created_at: "2026-10-03T08:00:00+03:00", patient_name: `Patient ${patient}`, mrn: `MRN-${patient}`,
});
const cardOf = (name: string) => screen.getByText(name).closest(".overflow-hidden") as HTMLElement;
const longDay = (iso: string) => new Date(`${iso}T00:00:00`).toLocaleDateString(undefined, { weekday: "short", day: "numeric", month: "short", year: "numeric" });

describe("REG-FE-CASHIER known defects", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(NOW);
    fake.reset();
    resetToasts();
    setAuth();
    fake.on("GET", "/billing/charges/pending", [C("ch1", "a"), C("ch2", "b")]);
    fake.on("GET", "/billing/waiver-reasons", ["Staff benefit", "Other"]);
    fake.on("GET", "/org/payment-rails", []);
    fake.on("GET", "/org/clinic", { name: "Cure Dental" });
  });
  afterEach(() => vi.useRealTimers());

  // NEW-CASH-1: CashierPage.tsx:388-389 — DayCloseRow.printZ passes `cashier:
  // cashierName` (the signed-in user) although the close it reprints carries its own
  // `reconciliation.cashier` (billing/api.ts:103). Selam reprinting Meron's Z-report
  // prints Selam's name over Meron's count.
  test.fails("REG-FE-CASHIER-050 KNOWN BUG NEW-CASH-1 a reprinted Z-report names the cashier who closed the day", async () => {
    fake.on("GET", "/billing/day-closes", [{ business_date: "2026-10-01", expected_total: "800", count: 2, closed: true, counted_total: "800", variance: "0" }]);
    fake.on("GET", "/billing/day-close", {
      business_date: "2026-10-01", closed: true, expected_total: "800", by_method: [{ label: "cash", total: "800", count: 2, cash: true }],
      reconciliation: { cashier: "Meron Closer", business_date: "2026-10-01", expected_total: "800", counted_total: "800", variance: "0", closed_at: "2026-10-01T18:00:00+03:00" },
    });
    const docs = capturePrints();
    const { user } = renderUI(<CashierPage />, { route: "/cashier" });
    await user.click(screen.getByRole("tab", { name: /Day close/ }));
    const row = (await screen.findByText(longDay("2026-10-01"))).closest(".overflow-hidden") as HTMLElement;
    await user.click(within(row).getByRole("button", { expanded: false }));
    await within(row).findByText(/cash \(2\)/);
    await user.click(within(row).getByRole("button", { name: /Print Z-report/ }));
    await waitFor(() => expect(docs).toHaveLength(1));
    expect(docs[0]).toContain("Meron Closer");
  });

  // NEW-CASH-2: CashierPage.tsx:541-574 — VoidDialog stays mounted between charges and
  // its Cancel / close path (`onClose`) never clears `reason`, unlike RefundVisitDialog
  // which does. The next charge opens with the old reason chosen and the destructive
  // button armed.
  test.fails("REG-FE-CASHIER-051 KNOWN BUG NEW-CASH-2 a cancelled void reason is not pre-selected for the next charge", async () => {
    const { user } = renderUI(<CashierPage />, { route: "/cashier" });
    await screen.findByText("Patient b");
    await user.click(within(cardOf("Patient b")).getByRole("button", { name: "Line actions" }));
    await user.click(await screen.findByRole("menuitem", { name: "Void…" }));
    let dlg = await screen.findByRole("dialog", { name: "Void charge" });
    await user.click(within(dlg).getByRole("combobox"));
    await user.click(await screen.findByRole("option", { name: "Wrong patient" }));
    await user.click(within(dlg).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());

    await user.click(within(cardOf("Patient a")).getByRole("button", { name: "Line actions" }));
    await user.click(await screen.findByRole("menuitem", { name: "Void…" }));
    dlg = await screen.findByRole("dialog", { name: "Void charge" });
    expect(dlg).toHaveTextContent("Patient a");
    expect(within(dlg).getByRole("button", { name: "Void charge" })).toBeDisabled();
  });

  // NEW-CASH-2 (waive): the same at CashierPage.tsx:582-624 — WaiveDialog's Cancel keeps
  // the reason, so the next line opens ready to be written off.
  test.fails("REG-FE-CASHIER-052 KNOWN BUG NEW-CASH-2 a cancelled waive reason is not pre-selected for the next charge", async () => {
    const { user } = renderUI(<CashierPage />, { route: "/cashier" });
    await screen.findByText("Patient b");
    await user.click(within(cardOf("Patient b")).getByRole("button", { name: "Line actions" }));
    await user.click(await screen.findByRole("menuitem", { name: "Waive…" }));
    let dlg = await screen.findByRole("dialog", { name: "Waive charge" });
    await user.click(within(dlg).getByRole("combobox"));
    await user.click(await screen.findByRole("option", { name: "Staff benefit" }));
    await user.click(within(dlg).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());

    await user.click(within(cardOf("Patient a")).getByRole("button", { name: "Line actions" }));
    await user.click(await screen.findByRole("menuitem", { name: "Waive…" }));
    dlg = await screen.findByRole("dialog", { name: "Waive charge" });
    expect(dlg).toHaveTextContent("Patient a");
    expect(within(dlg).getByRole("button", { name: /Waive/ })).toBeDisabled();
  });
});
