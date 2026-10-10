// The provider keeps the print engine informed about this clinic: its printing
// settings, its registered name and the branch the person is working in. A print
// button anywhere in the app then prints with the clinic's own letterhead.
import { act, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, test, vi } from "vitest";

vi.mock("@/app/auth-context", () => ({
  useAuth: () => ({ can: () => true, flagOn: () => true, user: { id: "u", full_name: "U" }, activeBranchId: "b2" }),
}));
const api = vi.hoisted(() => ({ getPrintSettings: vi.fn(), savePrintSettings: vi.fn(), peekPrint: vi.fn(), logPrint: vi.fn() }));
vi.mock("@/features/printing/api", () => api);
const admin = vi.hoisted(() => ({ getClinic: vi.fn(), listBranches: vi.fn() }));
vi.mock("@/features/admin/api", async (orig) => ({ ...(await orig<object>()), ...admin }));

import { PrintProvider } from "@/features/printing/PrintProvider";
import { getPrintContext } from "@/features/printing/context";
import { requestPrint } from "@/features/printing/request";
import { DEFAULT_SETTINGS } from "@/features/printing/settings";
import { setPrintContext } from "@/features/printing/context";
import { renderUI } from "@/test/render";

describe("REG-FE-PRPROV the print context", () => {
  beforeEach(() => {
    Object.values(api).forEach((f) => f.mockReset());
    api.peekPrint.mockResolvedValue({ count: 0 });
    api.logPrint.mockResolvedValue({ count: 1 });
    admin.getClinic.mockResolvedValue({ name: "Registered Name", timezone: "x", locale: "en" });
    admin.listBranches.mockResolvedValue([
      { id: "b1", name: "Bole", code: "B1", address: "Bole Rd", phone: "0911" },
      { id: "b2", name: "Piassa", code: "P1", address: "Piassa St", phone: "0922" },
    ]);
    setPrintContext({ settings: DEFAULT_SETTINGS, logo: "", clinicName: "", branch: null });
  });

  test("REG-FE-PRPROV-001 it publishes the stored settings, the logo, the clinic name and the active branch", async () => {
    api.getPrintSettings.mockResolvedValue({ settings: { identity: { nameEn: "Abeba", tin: "9" } }, logo: "data:image/png;base64,AAAA" });
    renderUI(<PrintProvider />);
    await waitFor(() => expect(getPrintContext().clinicName).toBe("Registered Name"));
    await waitFor(() => expect(getPrintContext().settings.identity.nameEn).toBe("Abeba"));
    const c = getPrintContext();
    expect(c.logo).toBe("data:image/png;base64,AAAA");
    expect(c.branch).toMatchObject({ id: "b2", name: "Piassa", address: "Piassa St", phone: "0922" });
  });

  test("REG-FE-PRPROV-002 a print button then shows the clinic's own preview", async () => {
    api.getPrintSettings.mockResolvedValue({ settings: { identity: { nameEn: "Abeba Dental" } }, logo: "" });
    renderUI(<PrintProvider />);
    await waitFor(() => expect(getPrintContext().settings.identity.nameEn).toBe("Abeba Dental"));
    await act(async () => {
      await requestPrint({
        doc: "receipt",
        data: { kind: "payment", number: "RCP-000001", when: "2026-10-03T09:00:00+03:00", patient: "P", lines: [], total: "0", currency: "ETB" },
      });
    });
    const dlg = await screen.findByRole("dialog", { name: "Print preview" });
    const src = within(dlg).getByTitle("Paper preview").getAttribute("srcdoc") ?? "";
    expect(src).toContain("Abeba Dental");
    expect(src).toContain("Piassa St");
  });

  test("REG-FE-PRPROV-003 settings that cannot be loaded do not stop printing: the defaults and the clinic's name are used", async () => {
    api.getPrintSettings.mockRejectedValue(new Error("down"));
    renderUI(<PrintProvider />);
    await waitFor(() => expect(getPrintContext().clinicName).toBe("Registered Name"));
    expect(getPrintContext().settings).toEqual(DEFAULT_SETTINGS);
    expect(getPrintContext().logo).toBe("");
  });
});
