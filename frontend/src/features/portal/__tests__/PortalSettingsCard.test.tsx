// The clinic's switches for the patient portal.
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, test, vi } from "vitest";

const api = vi.hoisted(() => ({ getPortalSettings: vi.fn(), savePortalSettings: vi.fn(), listHomePayments: vi.fn(), confirmHomePayment: vi.fn(), rejectHomePayment: vi.fn() }));
vi.mock("@/app/auth-context", async () => (await import("@/test/admin")).authModule);
vi.mock("@/features/portal/api", async (orig) => ({ ...(await orig<object>()), ...api }));
const tst = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }));
vi.mock("@/components/ui/sonner", async (orig) => ({ ...(await orig<object>()), toast: tst }));

import { HomePaymentsCard, PortalSettingsCard } from "@/features/portal/PortalSettingsCard";
import { setAuth } from "@/test/admin";
import { renderUI } from "@/test/render";

const S = { enabled: false, show_money: true, show_unbilled: true, show_teeth: true, show_3d: true, allow_pay: false, welcome_note: "", slug: "yoya" };

beforeEach(() => { setAuth(); Object.values(api).forEach((f) => f.mockReset()); tst.success.mockReset(); tst.error.mockReset(); api.getPortalSettings.mockResolvedValue(S); });

describe("REG-FE-PORTAL-SET the portal switches", () => {
  test("REG-FE-PORTAL-SET-001 off by default with no link; turning it on shows the link and Save sends the choices", async () => {
    api.savePortalSettings.mockImplementation(async (b) => b);
    renderUI(<PortalSettingsCard manage />);
    const on = await screen.findByLabelText(/Turn on the patient portal/);
    expect(screen.queryByText(/\/p\/yoya/)).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();
    await userEvent.click(on);
    expect(screen.getByText(new RegExp(`/p/yoya$`))).toBeInTheDocument();
    await userEvent.click(screen.getByLabelText(/Treatment not billed yet/));
    await userEvent.type(screen.getByLabelText(/message on their home page/), "Hello");
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(api.savePortalSettings).toHaveBeenCalled());
    expect(api.savePortalSettings.mock.calls[0]![0]).toMatchObject({ enabled: true, show_unbilled: false, show_money: true, welcome_note: "Hello" });
    await waitFor(() => expect(tst.success).toHaveBeenCalledWith("Patient portal saved"));
  });

  test("REG-FE-PORTAL-SET-002 someone who cannot manage the clinic can read the choices but not change or save them", async () => {
    renderUI(<PortalSettingsCard manage={false} />);
    expect(await screen.findByLabelText(/Turn on the patient portal/)).toBeDisabled();
    expect(screen.queryByRole("button", { name: "Save" })).not.toBeInTheDocument();
  });

  test("REG-FE-PORTAL-SET-003 a failed save says so; a failed load says so", async () => {
    api.savePortalSettings.mockRejectedValue(new Error("nope"));
    renderUI(<PortalSettingsCard manage />);
    await userEvent.click(await screen.findByLabelText(/Turn on the patient portal/));
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(tst.error).toHaveBeenCalledWith("nope"));
  });

  test("REG-FE-PORTAL-SET-004 a settings load failure is shown", async () => {
    api.getPortalSettings.mockRejectedValue(new Error("x"));
    renderUI(<PortalSettingsCard manage />);
    expect(await screen.findByRole("alert")).toHaveTextContent("Could not load");
  });
});

describe("REG-FE-PORTAL-SET the cashier's list of home payments", () => {
  const P = { id: "ppy_1", state: "waiting", amount: "1500.00", rail: "Telebirr", reference: "ce7k2m9xq4", date: "2026-10-18", patient: "Meron Alem", mrn: "MRN-1", patient_id: "pat_1", items: "Root canal · visit 3", verify_state: "review", verify_reason: "The bank shows 1,000.00 but this bill is 1,500.00." };

  test("REG-FE-PORTAL-SET-005 each waiting payment shows who, what, the bank's words; Confirm books it", async () => {
    api.listHomePayments.mockResolvedValue([P]);
    api.confirmHomePayment.mockResolvedValue({ ...P, state: "paid", receipt_no: 231 });
    renderUI(<HomePaymentsCard />);
    expect(await screen.findByText("Meron Alem")).toBeInTheDocument();
    expect(screen.getByText(/The bank shows 1,000.00/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Confirm payment" }));
    await waitFor(() => expect(api.confirmHomePayment).toHaveBeenCalledWith("ppy_1"));
    await waitFor(() => expect(tst.success).toHaveBeenCalledWith("Payment booked — receipt 231"));
  });

  test("REG-FE-PORTAL-SET-006 Turn down asks why, tells the server, and a failure is said", async () => {
    api.listHomePayments.mockResolvedValue([P]);
    api.rejectHomePayment.mockResolvedValue({ ok: true });
    renderUI(<HomePaymentsCard />);
    await userEvent.click(await screen.findByRole("button", { name: "Turn down" }));
    await userEvent.type(screen.getByLabelText("Why"), "SMS is from another phone");
    await userEvent.click(screen.getAllByRole("button", { name: "Turn down" })[0]!);
    await waitFor(() => expect(api.rejectHomePayment).toHaveBeenCalledWith("ppy_1", "SMS is from another phone"));
    api.rejectHomePayment.mockRejectedValue(new Error("closed"));
  });

  test("REG-FE-PORTAL-SET-007 nothing waiting says so", async () => {
    api.listHomePayments.mockResolvedValue([]);
    renderUI(<HomePaymentsCard />);
    expect(await screen.findByText("Nothing is waiting.")).toBeInTheDocument();
  });
});
