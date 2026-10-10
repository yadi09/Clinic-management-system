// The dispensing slip: Print used to print the whole web page, menus and all. It now
// hands the print engine what the pharmacist is giving — the medicines and how to take
// them, the batch and quantity they chose, the patient's allergies — and says plainly
// when a line was blocked. Once the order has gone to the cashier the page no longer
// holds the chosen batch, so the slip does not guess one.
import { screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { Route, Routes } from "react-router-dom";

vi.mock("@/lib/api-client", async (orig) => ({ ...(await orig<object>()), ...(await import("@/test/frontdesk")).apiModule }));
vi.mock("@/app/auth-context", async () => (await import("@/test/frontdesk")).authModule);
vi.mock("@/components/ui/sonner", async (orig) => ({ ...(await orig<object>()), toast: (await import("@/test/frontdesk")).toastSpy }));
vi.mock("@/features/printing/api", () => ({
  peekPrint: vi.fn(async () => ({ count: 0 })), logPrint: vi.fn(async () => ({ count: 1 })),
  getPrintSettings: vi.fn(), savePrintSettings: vi.fn(),
}));

import { DispensePage } from "@/features/pharmacy/pages/DispensePage";
import { capturePrints, fake, printedText, setAuth } from "@/test/frontdesk";
import { renderUI } from "@/test/render";

const batch = { id: "b1", drug_id: "d1", batch_no: "AMX-22", expiry_date: "2027-08-31", qty_on_hand: 100, quarantined: false, status: "ok" };
const rx = (over: Record<string, unknown> = {}) => ({
  id: "rx1", rx_no: 1042, patient_name: "Abebe Kebede", mrn: "P000033", prescriber: "Dr Yonas", dispensed: false,
  allergies: ["Penicillin"], prepared: false, charge_settled: false,
  items: [
    { id: "i1", drug_name: "Amoxicillin 500 mg", sig: "1 cap, 3 times a day", matched_drug_id: "d1", batches: [batch] },
    { id: "i2", drug_name: "Penicillin V", sig: "1 tab", matched_drug_id: "d2", allergy_conflict: "patient allergic to penicillin", batches: [] },
  ],
  ...over,
});
const open = () => renderUI(
  <Routes><Route path="/pharmacy/dispense/:rxId" element={<DispensePage />} /></Routes>,
  { route: "/pharmacy/dispense/rx1" },
);

describe("REG-FE-DISPPRINT the dispensing slip", () => {
  beforeEach(() => {
    fake.reset();
    setAuth({ perms: ["pharmacy.dispense"], flags: ["pharmacy"] });
    fake.on("GET", "/org/clinic", { name: "Cure Dental" });
  });

  test("REG-FE-DISPPRINT-001 while choosing, the slip carries the batch and quantity, the allergy block and the allergies", async () => {
    fake.on("GET", "/pharmacy/dispense/rx1", rx());
    const docs = capturePrints();
    const { user } = open();
    await user.click(await screen.findByRole("button", { name: /Print/ }));
    await waitFor(() => expect(docs).toHaveLength(1));
    const t = printedText(docs[0]);
    for (const part of ["Dispensing slip", "not yet handed over", "R-1042", "Abebe Kebede (P000033)", "Dr Yonas",
      "Amoxicillin 500 mg 1 cap, 3 times a day", "AMX-22", "2027-08", "patient allergic to penicillin", "Allergies: Penicillin"]) {
      expect(t).toContain(part);
    }
    // The blocked line is not given a quantity: nothing was dispensed for it.
    expect(t).not.toMatch(/Penicillin V 1 tab 1\b/);
  });

  test("REG-FE-DISPPRINT-002 once sent to the cashier the slip lists the medicines but never a guessed batch", async () => {
    fake.on("GET", "/pharmacy/dispense/rx1", rx({ prepared: true, prepared_total: "120.00" }));
    const docs = capturePrints();
    const { user } = open();
    await user.click(await screen.findByRole("button", { name: /Print/ }));
    await waitFor(() => expect(docs).toHaveLength(1));
    const t = printedText(docs[0]);
    expect(t).toContain("Amoxicillin 500 mg");
    expect(t).not.toContain("AMX-22");
    expect(t).not.toContain("Batch");
  });

  test("REG-FE-DISPPRINT-003 an order already handed over prints without the 'not yet handed over' mark", async () => {
    fake.on("GET", "/pharmacy/dispense/rx1", rx({ dispensed: true, prepared: true, charge_settled: true }));
    const docs = capturePrints();
    const { user } = open();
    await user.click(await screen.findByRole("button", { name: /Print/ }));
    await waitFor(() => expect(docs).toHaveLength(1));
    expect(printedText(docs[0])).not.toContain("not yet handed over");
  });
});
