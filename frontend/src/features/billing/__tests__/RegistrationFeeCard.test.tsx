// Settings → Registration fee (FEAT-REG-1): a clinic chooses how often a patient pays
// registration (every visit, one time only, or again after a period) and that is what
// gets saved; a clinic with no arrival fee is told where to add one; staff without
// billing rights can read the rule but not change it.
import { screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, test, vi } from "vitest";

const api = vi.hoisted(() => ({ getRegistrationPolicy: vi.fn(), saveRegistrationPolicy: vi.fn(), listServices: vi.fn() }));
vi.mock("@/features/billing/api", async (orig) => ({ ...(await orig<object>()), ...api }));
const tst = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }));
vi.mock("sonner", async (orig) => ({ ...(await orig<object>()), toast: tst }));

import { RegistrationFeeCard } from "@/features/billing/RegistrationFeeCard";
import type { RegistrationPolicy, ServiceItem } from "@/features/billing/api";
import { AppError } from "@/lib/api-client";
import { renderUI } from "@/test/render";

const SVC = (id: string, name: string, price: string, isDefault = true): ServiceItem => ({
  id, code: id, name, category: "general", price, currency: "ETB", is_active: true, is_default: isDefault, assignable_by: "reception",
});
const services = [SVC("svc_reg", "Registration", "100"), SVC("svc_con", "Consultation", "300"), SVC("svc_xray", "X-ray", "250", false)];
const POLICY: RegistrationPolicy = { service_id: "svc_reg", rule: "every_visit", every_count: null, every_unit: "", paper_patients_registered: true };

const card = (manage = true) => renderUI(<RegistrationFeeCard manage={manage} />);
const save = () => screen.getByRole("button", { name: "Save registration rule" });
const radio = (name: RegExp) => screen.getByRole("radio", { name });

describe("REG-FE-REGFEE settings: registration fee rule", () => {
  beforeEach(() => {
    for (const f of [...Object.values(api), tst.success, tst.error]) f.mockReset();
    api.getRegistrationPolicy.mockResolvedValue(POLICY);
    api.listServices.mockResolvedValue(services);
    api.saveRegistrationPolicy.mockImplementation(async (p: RegistrationPolicy) => p);
  });

  test("REG-FE-REGFEE-001 one time only is saved for the chosen registration fee, and the rule is said in words", async () => {
    const { user } = card();
    expect(await screen.findByText("Every patient pays Registration (100 birr) on every visit.")).toBeInTheDocument();
    await user.click(radio(/One time only/));
    expect(screen.getByText("A new patient pays Registration (100 birr) once. They never pay it again.")).toBeInTheDocument();
    await user.click(save());
    await waitFor(() => expect(api.saveRegistrationPolicy).toHaveBeenCalledWith({
      service_id: "svc_reg", rule: "once", every_count: null, every_unit: "", paper_patients_registered: true,
    }));
    expect(tst.success).toHaveBeenCalledWith("Registration fee rule saved");
  });

  test("REG-FE-REGFEE-002 again after a period: starts at 30 days, a shortcut sets 2 months, a number sets weeks", async () => {
    const { user } = card();
    await user.click(await screen.findByRole("radio", { name: /Again after a period/ }));
    expect(screen.getByLabelText("Pay again after")).toHaveValue(30);
    expect(screen.getByText(/They pay it again 30 days after they last paid it\./)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "2 months" }));
    expect(screen.getByText(/They pay it again 2 months after/)).toBeInTheDocument();
    await user.click(save());
    await waitFor(() => expect(api.saveRegistrationPolicy).toHaveBeenLastCalledWith(
      expect.objectContaining({ rule: "every", every_count: 2, every_unit: "month" })));
    await user.click(screen.getByRole("button", { name: "7 days" }));
    expect(screen.getByText(/They pay it again 7 days after/)).toBeInTheDocument();
  });

  test("REG-FE-REGFEE-003 a period with no number cannot be saved", async () => {
    const { user } = card();
    await user.click(await screen.findByRole("radio", { name: /Again after a period/ }));
    await user.clear(screen.getByLabelText("Pay again after"));
    expect(save()).toBeDisabled();
    expect(screen.getByText("Say how long registration lasts.")).toBeInTheDocument();
  });

  test("REG-FE-REGFEE-004 paper-register patients: the switch is offered for once / a period, and its choice is saved", async () => {
    const { user } = card();
    await screen.findByRole("radio", { name: /Every visit/ });
    expect(screen.queryByRole("checkbox")).not.toBeInTheDocument();
    await user.click(radio(/One time only/));
    const box = screen.getByRole("checkbox", { name: /paper register/ });
    expect(box).toBeChecked();
    await user.click(box);
    await user.click(save());
    await waitFor(() => expect(api.saveRegistrationPolicy).toHaveBeenCalledWith(expect.objectContaining({ paper_patients_registered: false })));
  });

  test("REG-FE-REGFEE-005 no fee chosen yet: one time only cannot be saved until a fee is named", async () => {
    api.getRegistrationPolicy.mockResolvedValue({ ...POLICY, service_id: null });
    const { user } = card();
    await user.click(await screen.findByRole("radio", { name: /One time only/ }));
    expect(save()).toBeDisabled();
    expect(screen.getByText("Choose which fee is the registration fee.")).toBeInTheDocument();
    expect(screen.getByRole("combobox", { name: "Registration fee" })).toBeInTheDocument();
  });

  test("REG-FE-REGFEE-006 no fee is charged on arrival yet: the clinic is told where to add one", async () => {
    api.listServices.mockResolvedValue([SVC("svc_xray", "X-ray", "250", false)]);
    card();
    expect(await screen.findByText(/No fee is charged when a patient arrives yet/)).toBeInTheDocument();
    expect(screen.queryByRole("combobox", { name: "Registration fee" })).not.toBeInTheDocument();
  });

  test("REG-FE-REGFEE-007 without billing rights the rule is readable but nothing can change", async () => {
    api.getRegistrationPolicy.mockResolvedValue({ ...POLICY, rule: "every", every_count: 1, every_unit: "month" });
    card(false);
    expect(await screen.findByText(/They pay it again 1 month after/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Save registration rule" })).not.toBeInTheDocument();
    expect(radio(/One time only/)).toBeDisabled();
    expect(screen.getByLabelText("Pay again after")).toBeDisabled();
  });

  test("REG-FE-REGFEE-008 a refused save shows the server's reason; a failed load says so", async () => {
    api.saveRegistrationPolicy.mockRejectedValue(new AppError(400, "VALIDATION_FAILED", "the registration fee must be one of the fees charged when a patient arrives"));
    const { user, unmount } = card();
    await user.click(await screen.findByRole("radio", { name: /One time only/ }));
    await user.click(save());
    await waitFor(() => expect(tst.error).toHaveBeenCalledWith("the registration fee must be one of the fees charged when a patient arrives"));
    unmount();
    api.getRegistrationPolicy.mockRejectedValue(new Error("down"));
    card();
    expect(await screen.findByText("Couldn't load the registration fee rule.")).toBeInTheDocument();
  });

  test("REG-FE-REGFEE-009 the registration fee and the unit are chosen from lists; the choices are what is saved", async () => {
    api.getRegistrationPolicy.mockResolvedValue({ ...POLICY, service_id: null });
    const { user } = card();
    await user.click(await screen.findByRole("combobox", { name: "Registration fee" }));
    // Only fees charged on arrival are offered; the X-ray is not one.
    expect(screen.queryByRole("option", { name: /X-ray/ })).not.toBeInTheDocument();
    await user.click(await screen.findByRole("option", { name: "Consultation · 300 birr" }));
    await user.click(radio(/Again after a period/));
    await user.clear(screen.getByLabelText("Pay again after"));
    await user.type(screen.getByLabelText("Pay again after"), "3");
    await user.click(screen.getByRole("combobox", { name: "Period unit" }));
    await user.click(await screen.findByRole("option", { name: "weeks" }));
    expect(screen.getByText("A new patient pays Consultation (300 birr). They pay it again 3 weeks after they last paid it.")).toBeInTheDocument();
    await user.click(save());
    await waitFor(() => expect(api.saveRegistrationPolicy).toHaveBeenCalledWith({
      service_id: "svc_con", rule: "every", every_count: 3, every_unit: "week", paper_patients_registered: true,
    }));
  });
});
