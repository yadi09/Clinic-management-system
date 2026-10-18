// The clinic's switches for the patient portal.
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, test, vi } from "vitest";

const api = vi.hoisted(() => ({ getPortalSettings: vi.fn(), savePortalSettings: vi.fn() }));
vi.mock("@/features/portal/api", async (orig) => ({ ...(await orig<object>()), ...api }));
const tst = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }));
vi.mock("@/components/ui/sonner", async (orig) => ({ ...(await orig<object>()), toast: tst }));

import { PortalSettingsCard } from "@/features/portal/PortalSettingsCard";
import { renderUI } from "@/test/render";

const S = { enabled: false, show_money: true, show_unbilled: true, show_teeth: true, show_3d: true, welcome_note: "", slug: "yoya" };

beforeEach(() => { Object.values(api).forEach((f) => f.mockReset()); tst.success.mockReset(); tst.error.mockReset(); api.getPortalSettings.mockResolvedValue(S); });

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
