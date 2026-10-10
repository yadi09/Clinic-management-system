// The laboratory report a validated sample prints: the page hands the print engine the
// result as the laboratory states it — analytes with their reference ranges and flags,
// who drew the sample, when it was reported and who signed it off — and the paper is
// the clinic's own, not a bare browser window.
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

import { LabOrderItemPage } from "@/features/lab/pages/LabOrderItemPage";
import { capturePrints, fake, printedText, setAuth } from "@/test/frontdesk";
import { renderUI } from "@/test/render";

const item = (over: Record<string, unknown> = {}) => ({
  id: "it1", sample_no: 1042, status: "validated", specimen: "Whole blood", test_name: "Complete blood count",
  patient_name: "Abebe Kebede", mrn: "P000033", priority: "routine", ordered_by: "Dr Yonas", critical: false,
  collected_by: "Selam", collected_at: "2026-10-03T08:00:00+03:00", resulted_at: "2026-10-03T10:00:00+03:00",
  validated_at: "2026-10-03T10:30:00+03:00", validated_by: "Dr Meron",
  analytes: [
    { analyte_id: "a1", name: "Haemoglobin", unit: "g/dL", ref_low: "13", ref_high: "17", value: "13.4", flag: "normal" },
    { analyte_id: "a2", name: "WBC", unit: "x10^9/L", ref_low: "4", ref_high: "11", value: "18", flag: "high" },
  ],
  ...over,
});
const open = () => renderUI(
  <Routes><Route path="/lab/items/:itemId" element={<LabOrderItemPage />} /></Routes>,
  { route: "/lab/items/it1" },
);

describe("REG-FE-LABPRINT the laboratory report", () => {
  beforeEach(() => {
    fake.reset();
    setAuth({ perms: ["lab.validate"], flags: ["laboratory"] });
    fake.on("GET", "/org/clinic", { name: "Cure Dental" });
  });

  test("REG-FE-LABPRINT-001 Print report sends the clinic's laboratory report, with the trail from the server", async () => {
    fake.on("GET", "/lab/items/it1", item());
    const docs = capturePrints();
    const { user } = open();
    await user.click(await screen.findByRole("button", { name: /Print report/ }));
    await waitFor(() => expect(docs).toHaveLength(1));
    const t = printedText(docs[0]);
    for (const part of ["Laboratory report", "Complete blood count", "Sample S-1042", "Whole blood", "Abebe Kebede", "Card no. P000033",
      "Haemoglobin 13.4 g/dL 13–17 g/dL", "WBC 18 x10^9/L 4–11 x10^9/L HIGH", "Collected", "Selam", "Validated by Dr Meron"]) {
      expect(t).toContain(part);
    }
    expect(docs[0]).toContain("<title>Laboratory report S-1042</title>");
  });

  test("REG-FE-LABPRINT-002 a critical value that nobody was told about says so on the paper", async () => {
    fake.on("GET", "/lab/items/it1", item({ critical: true }));
    const docs = capturePrints();
    const { user } = open();
    await user.click(await screen.findByRole("button", { name: /Print report/ }));
    await waitFor(() => expect(docs).toHaveLength(1));
    expect(printedText(docs[0])).toContain("NOT YET COMMUNICATED");
  });

  test("REG-FE-LABPRINT-003 a sample still being worked on has no report to print", async () => {
    fake.on("GET", "/lab/items/it1", item({ status: "in_process" }));
    open();
    await screen.findByText("Results");
    expect(screen.queryByRole("button", { name: /Print report/ })).not.toBeInTheDocument();
  });
});
