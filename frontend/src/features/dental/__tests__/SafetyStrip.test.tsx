// The allergy strip: absent when there is nothing to warn about, severe first, the
// reaction beside the substance, and a compact one-liner that fetches the patient
// for itself (the version dialogs carry, so the allergy is not hidden behind them).
import { screen } from "@testing-library/react";
import { beforeEach, describe, expect, test, vi } from "vitest";

const patients = vi.hoisted(() => ({ getPatient: vi.fn() }));
vi.mock("@/features/patients/api", async (orig) => ({ ...(await orig<object>()), ...patients }));

import { PatientAllergyLine, SafetyStrip, allergyText } from "@/features/dental/SafetyStrip";
import { renderUI } from "@/test/render";

const A = (id: string, substance: string, severity?: string, reaction?: string) => ({ id, substance, severity, reaction });

describe("REG-FE-WORKSPACE the allergy strip", () => {
  beforeEach(() => patients.getPatient.mockReset());

  test("REG-FE-WORKSPACE-001 no allergies: the strip renders nothing at all", () => {
    const { container } = renderUI(<SafetyStrip allergies={[]} />);
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(container.querySelector("[role=alert]")).toBeNull();
    renderUI(<SafetyStrip compact allergies={[]} />);
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  test("REG-FE-WORKSPACE-002 full strip: severe first, reaction shown, SEVERE tag only on severe", () => {
    renderUI(<SafetyStrip className="extra" allergies={[
      A("1", "Latex", "mild", "Rash"),
      A("2", "Ibuprofen", "moderate"),
      A("3", "Penicillin", "severe", "  Anaphylaxis "),
      A("4", "Dust"),
    ]} />);
    const strip = screen.getByRole("alert");
    expect(strip).toHaveClass("sticky", "extra");
    expect(strip).toHaveTextContent(/^Allergy/);
    const rows = Array.from(strip.querySelectorAll("div.font-semibold")).map((d) => d.textContent);
    expect(rows).toEqual(["Penicillin — Anaphylaxissevere", "Ibuprofen", "Latex — Rash", "Dust"]);
    expect(screen.getAllByText("severe")).toHaveLength(1);
  });

  test("REG-FE-WORKSPACE-003 compact strip: one line, severe first, dot separators, no SEVERE tag", () => {
    renderUI(<SafetyStrip compact allergies={[A("1", "Latex", "mild"), A("2", "Penicillin", "severe", "Hives")]} />);
    const strip = screen.getByRole("alert");
    expect(strip).not.toHaveClass("sticky");
    expect(strip).toHaveTextContent("AllergyPenicillin — Hives·Latex");
    expect(screen.queryByText("severe")).not.toBeInTheDocument();
  });

  test("REG-FE-WORKSPACE-004 allergyText: substance alone when the reaction is blank", () => {
    expect(allergyText(A("1", "Latex"))).toBe("Latex");
    expect(allergyText(A("1", "Latex", "mild", "   "))).toBe("Latex");
    expect(allergyText(A("1", "Latex", "mild", " Rash "))).toBe("Latex — Rash");
  });

  test("REG-FE-WORKSPACE-005 PatientAllergyLine fetches the patient and shows the compact line", async () => {
    patients.getPatient.mockResolvedValue({ id: "pat_1", allergies: [A("1", "Penicillin", "severe")] });
    renderUI(<PatientAllergyLine patientId="pat_1" />);
    expect(await screen.findByRole("alert")).toHaveTextContent("Penicillin");
    expect(patients.getPatient).toHaveBeenCalledWith("pat_1");
  });

  test("REG-FE-WORKSPACE-006 PatientAllergyLine shows nothing while loading, on error, or with no allergies", async () => {
    patients.getPatient.mockImplementation(() => new Promise(() => {}));
    const first = renderUI(<PatientAllergyLine patientId="pat_1" />);
    await vi.waitFor(() => expect(patients.getPatient).toHaveBeenCalled());
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    first.unmount();

    patients.getPatient.mockReset();
    patients.getPatient.mockImplementation(async () => { throw new Error("down"); });
    const second = renderUI(<PatientAllergyLine patientId="pat_2" />);
    await vi.waitFor(() => expect(second.qc.getQueryState(["patient", "pat_2"])?.status).toBe("error"));
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    second.unmount();

    patients.getPatient.mockResolvedValue({ id: "pat_3", allergies: [] });
    const third = renderUI(<PatientAllergyLine patientId="pat_3" />);
    await vi.waitFor(() => expect(third.qc.getQueryState(["patient", "pat_3"])?.status).toBe("success"));
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });
});
