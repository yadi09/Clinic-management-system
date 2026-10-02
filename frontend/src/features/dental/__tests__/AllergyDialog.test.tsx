// Recording and removing an allergy from the dental workspace. Asserts what reaches
// the API (the allergy, and the library entry taught alongside it), the confirm step
// before a removal, and the toasts on success and failure.
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, test, vi } from "vitest";

const patients = vi.hoisted(() => ({ addAllergy: vi.fn(), removeAllergy: vi.fn() }));
const clinical = vi.hoisted(() => ({ listAllergens: vi.fn(), createAllergen: vi.fn() }));
const toast = vi.hoisted(() => Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn() }));
vi.mock("@/features/patients/api", async (orig) => ({ ...(await orig<object>()), ...patients }));
vi.mock("@/features/clinical/api", async (orig) => ({ ...(await orig<object>()), ...clinical }));
vi.mock("@/components/ui/sonner", async (orig) => ({ ...(await orig<object>()), toast }));

import { AllergyDialog } from "@/features/dental/AllergyDialog";
import type { Allergy } from "@/features/patients/api";
import { AppError } from "@/lib/api-client";
import { renderUI } from "@/test/render";

const LIB = [
  { id: "g1", name: "Penicillin", is_active: true, default_reaction: "Hives", default_severity: "severe" },
  { id: "g2", name: "Latex", is_active: true },
];
const AL = (id: string, substance: string, severity: string, reaction?: string) =>
  ({ id, substance, severity, reaction, created_at: "" }) as Allergy;

function open(allergies: Allergy[] = []) {
  const onClose = vi.fn(), onSaved = vi.fn();
  const r = renderUI(<AllergyDialog patientId="pat_1" allergies={allergies} onClose={onClose} onSaved={onSaved} />);
  return { ...r, onClose, onSaved };
}
const substance = () => screen.getByLabelText("Substance");
const addBtn = () => screen.getByRole("button", { name: /Add allergy/ });

describe("REG-FE-WORKSPACE the allergy dialog", () => {
  beforeEach(() => {
    [...Object.values(patients), ...Object.values(clinical), toast, toast.success, toast.error].forEach((f) => f.mockReset());
    clinical.listAllergens.mockResolvedValue(LIB);
    clinical.createAllergen.mockResolvedValue({});
    patients.addAllergy.mockResolvedValue({ id: "a9" });
    patients.removeAllergy.mockResolvedValue(undefined);
  });

  test("REG-FE-WORKSPACE-007 lists recorded allergies with reaction and severity; Add is disabled until a substance is typed", async () => {
    open([AL("a1", "Penicillin", "severe", "Anaphylaxis"), AL("a2", "Latex", "moderate"), AL("a3", "Dust", "mild")]);
    const dlg = screen.getByRole("dialog");
    expect(within(dlg).getByRole("heading", { name: "Allergies" })).toBeInTheDocument();
    const items = within(dlg).getAllByRole("listitem");
    expect(items.map((li) => li.textContent)).toEqual(["Penicillin — Anaphylaxissevere", "Latexmoderate", "Dustmild"]);
    expect(within(items[0]).getByText("severe")).toHaveClass("bg-destructive");
    expect(within(items[1]).getByText("moderate")).toHaveClass("bg-amber-500");
    expect(within(items[2]).getByText("mild")).toHaveClass("bg-muted");
    expect(addBtn()).toBeDisabled();
    fireEvent.change(substance(), { target: { value: "   " } });
    expect(addBtn()).toBeDisabled();
  });

  test("REG-FE-WORKSPACE-008 no allergies yet: no list, just the form", () => {
    open([]);
    expect(screen.queryByRole("list")).not.toBeInTheDocument();
    expect(substance()).toHaveValue("");
  });

  test("REG-FE-WORKSPACE-009 a new substance teaches the library, then records the allergy with reaction and severity", async () => {
    const { user, onSaved } = open();
    await waitFor(() => expect(clinical.listAllergens).toHaveBeenCalled());
    fireEvent.change(substance(), { target: { value: "  Chlorhexidine " } });
    fireEvent.change(screen.getByLabelText("Reaction"), { target: { value: " Swelling " } });
    await user.click(screen.getByRole("combobox"));
    await user.click(await screen.findByRole("option", { name: "Moderate" }));
    await user.click(addBtn());
    await waitFor(() => expect(patients.addAllergy).toHaveBeenCalledTimes(1));
    expect(clinical.createAllergen).toHaveBeenCalledWith("Chlorhexidine", { default_reaction: "Swelling", default_severity: "moderate" });
    expect(patients.addAllergy).toHaveBeenCalledWith("pat_1", { substance: "Chlorhexidine", reaction: "Swelling", severity: "moderate" });
    expect(toast.success).toHaveBeenCalledWith("Allergy recorded");
    expect(onSaved).toHaveBeenCalledTimes(1);
    // The form resets for the next one.
    await waitFor(() => expect(substance()).toHaveValue(""));
    expect(screen.getByLabelText("Reaction")).toHaveValue("");
    expect(screen.getByRole("combobox")).toHaveTextContent("Mild");
  });

  test("REG-FE-WORKSPACE-010 a library substance prefills reaction and severity, says so, and is not re-created", async () => {
    const { user } = open();
    await waitFor(() => expect(clinical.listAllergens).toHaveBeenCalled());
    await user.type(substance(), "peni");
    await user.click(await screen.findByRole("button", { name: /Penicillin/ }));
    expect(substance()).toHaveValue("Penicillin");
    expect(screen.getByLabelText("Reaction")).toHaveValue("Hives");
    expect(screen.getByRole("combobox")).toHaveTextContent("Severe");
    expect(screen.getByText(/Filled in from the clinic's allergen library/)).toBeInTheDocument();
    // Editing the prefilled reaction drops the note: the value is now the clinician's.
    fireEvent.change(screen.getByLabelText("Reaction"), { target: { value: "Rash" } });
    expect(screen.queryByText(/Filled in from the clinic's allergen library/)).not.toBeInTheDocument();
    await user.click(addBtn());
    await waitFor(() => expect(patients.addAllergy).toHaveBeenCalled());
    expect(clinical.createAllergen).not.toHaveBeenCalled();
    expect(patients.addAllergy).toHaveBeenCalledWith("pat_1", { substance: "Penicillin", reaction: "Rash", severity: "severe" });
  });

  test("REG-FE-WORKSPACE-011 a library entry with no defaults prefills nothing and shows no note", async () => {
    const { user } = open();
    await waitFor(() => expect(clinical.listAllergens).toHaveBeenCalled());
    await user.type(substance(), "lat");
    await user.click(await screen.findByRole("button", { name: "Latex" }));
    expect(screen.queryByText(/Filled in from/)).not.toBeInTheDocument();
    await user.click(addBtn());
    await waitFor(() => expect(patients.addAllergy).toHaveBeenCalledWith("pat_1", { substance: "Latex", reaction: undefined, severity: "mild" }));
  });

  test("REG-FE-WORKSPACE-012 a substance already on the record is flagged (any case) and cannot be added twice", async () => {
    open([AL("a1", "Penicillin", "severe")]);
    fireEvent.change(substance(), { target: { value: "penicillin" } });
    expect(screen.getByText("Already on this patient's record.")).toBeInTheDocument();
    expect(addBtn()).toBeDisabled();
  });

  test("REG-FE-WORKSPACE-013 the library already having the name (create fails) still records the allergy", async () => {
    clinical.createAllergen.mockRejectedValue(new Error("exists"));
    const { user } = open();
    fireEvent.change(substance(), { target: { value: "Amoxicillin" } });
    await user.click(addBtn());
    await waitFor(() => expect(patients.addAllergy).toHaveBeenCalled());
    expect(toast.success).toHaveBeenCalledWith("Allergy recorded");
  });

  test("REG-FE-WORKSPACE-014 a failed add says why (server message, or a fallback) and keeps what was typed", async () => {
    patients.addAllergy.mockRejectedValueOnce(new AppError(409, "dup", "Already recorded on the server"));
    const { user, onSaved } = open();
    fireEvent.change(substance(), { target: { value: "Amoxicillin" } });
    await user.click(addBtn());
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith("Already recorded on the server"));
    expect(substance()).toHaveValue("Amoxicillin");
    expect(onSaved).not.toHaveBeenCalled();
    patients.addAllergy.mockRejectedValueOnce(new Error("offline"));
    await user.click(addBtn());
    await waitFor(() => expect(toast.error).toHaveBeenLastCalledWith("Could not record the allergy"));
  });

  test("REG-FE-WORKSPACE-015 remove asks first; cancelling removes nothing", async () => {
    const { user } = open([AL("a1", "Penicillin", "severe")]);
    await user.click(screen.getByRole("button", { name: "Remove Penicillin" }));
    const confirm = await screen.findByRole("dialog", { name: /Remove the Penicillin allergy\?/ });
    expect(within(confirm).getByText(/will no longer be warned about it/)).toBeInTheDocument();
    await user.click(within(confirm).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: /Remove the Penicillin/ })).not.toBeInTheDocument());
    expect(patients.removeAllergy).not.toHaveBeenCalled();
  });

  test("REG-FE-WORKSPACE-016 confirming removes that allergy and refreshes the record", async () => {
    const { user, onSaved } = open([AL("a1", "Penicillin", "severe"), AL("a2", "Latex", "mild")]);
    await user.click(screen.getByRole("button", { name: "Remove Latex" }));
    const confirm = await screen.findByRole("dialog", { name: /Remove the Latex allergy\?/ });
    await user.click(within(confirm).getByRole("button", { name: "Remove allergy" }));
    await waitFor(() => expect(patients.removeAllergy).toHaveBeenCalledWith("pat_1", "a2"));
    expect(toast.success).toHaveBeenCalledWith("Allergy removed");
    expect(onSaved).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(screen.queryByRole("dialog", { name: /Remove the Latex/ })).not.toBeInTheDocument());
  });

  test("REG-FE-WORKSPACE-017 a failed remove shows the error toast", async () => {
    patients.removeAllergy.mockRejectedValue(new Error("offline"));
    const onUnhandled = vi.fn();
    process.on("unhandledRejection", onUnhandled);
    try {
      const { user, onSaved } = open([AL("a1", "Penicillin", "severe")]);
      await user.click(screen.getByRole("button", { name: "Remove Penicillin" }));
      const confirm = await screen.findByRole("dialog", { name: /Remove the Penicillin allergy\?/ });
      await user.click(within(confirm).getByRole("button", { name: "Remove allergy" }));
      await waitFor(() => expect(toast.error).toHaveBeenCalledWith("Could not remove"));
      expect(onSaved).not.toHaveBeenCalled();
    } finally {
      await new Promise((r) => setTimeout(r, 0));
      process.off("unhandledRejection", onUnhandled);
    }
  });

  test("REG-FE-WORKSPACE-018 Done closes the dialog", async () => {
    const { user, onClose } = open();
    await user.click(screen.getByRole("button", { name: "Done" }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
