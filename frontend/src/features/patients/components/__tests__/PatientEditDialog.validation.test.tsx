// Editing a patient's details from the profile or the dental workspace: what the
// desk relies on beyond the happy path. The first name is the only required field;
// every value is trimmed; the phone is the server's to judge, and its refusal is
// shown with the dialog left open so nothing typed is lost; a birthdate entered in
// either calendar is sent as a Gregorian date; Cancel and Escape send nothing.
import { fireEvent, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, test, vi } from "vitest";

vi.mock("@/lib/api-client", async (orig) => ({ ...(await orig<object>()), ...(await import("@/test/frontdesk")).apiModule }));
vi.mock("@/components/ui/sonner", async (orig) => ({ ...(await orig<object>()), toast: (await import("@/test/frontdesk")).toastSpy }));

import { PatientEditDialog } from "@/features/patients/components/PatientEditDialog";
import type { Patient } from "@/features/patients/api";
import { fail, fake, resetToasts, toasts } from "@/test/frontdesk";
import { renderUI } from "@/test/render";

const base: Patient = {
  id: "pat_1", mrn: "MRN-0001", first_name: "Abebe", middle_name: "Kebede", last_name: "Bekele",
  gender: "male", dob: "1990-05-01", phone: "0911000000", email: "abebe@example.test",
  national_id: "NID-1", blood_group: "O+", created_at: "2026-01-01T00:00:00Z",
} as Patient;

function open(p: Partial<Patient> = {}) {
  const onSaved = vi.fn();
  const onClose = vi.fn();
  const r = renderUI(<PatientEditDialog patient={{ ...base, ...p } as Patient} onClose={onClose} onSaved={onSaved} />);
  return { ...r, onSaved, onClose };
}
const field = (label: string) => screen.getByText(label).parentElement!.querySelector("input") as HTMLInputElement;
const save = () => screen.getByRole("button", { name: "Save changes" });
const sentBody = () => fake.lastBody("PUT", "/patients/pat_1") as Record<string, unknown> | undefined;

beforeEach(() => {
  fake.reset();
  resetToasts();
  fake.on("PUT", "/patients/pat_1", (r: { body: unknown }) => ({ ...base, ...(r.body as object) }));
});

const anyUpdate = () => fake.sent("PUT", "/patients/pat_1");
const lastUpdate = () => sentBody() as Record<string, unknown>;

describe("REG-FE-PEDIT editing a patient's details", () => {
  test("REG-FE-PEDIT-001 an unchanged save sends the same record back, says so, and closes", async () => {
    const { user, onSaved, onClose } = open();
    await user.click(save());
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
    expect(onSaved).toHaveBeenCalledTimes(1);
    expect(toasts("success")).toEqual(["Patient details updated"]);
    expect(anyUpdate()).toHaveLength(1);
    expect(lastUpdate()).toEqual({
      first_name: "Abebe", middle_name: "Kebede", last_name: "Bekele", gender: "male", dob: "1990-05-01",
      phone: "0911000000", email: "abebe@example.test", national_id: "NID-1", blood_group: "O+",
    });
  });

  test("REG-FE-PEDIT-002 a record with blanks: fields default to empty, sex to Unknown, blood group 'Not recorded'", async () => {
    const { user } = open({
      middle_name: undefined, last_name: undefined, gender: "" as never, dob: undefined, phone: undefined,
      email: undefined, national_id: undefined, blood_group: undefined,
    } as Partial<Patient>);
    expect(screen.getByText("Not recorded")).toBeInTheDocument();
    expect(screen.getByText("Unknown")).toBeInTheDocument();
    expect(screen.getByText("Enter the Ethiopian birthdate (ዓ.ም).")).toBeInTheDocument();
    await user.click(save());
    await waitFor(() => expect(anyUpdate()).toHaveLength(1));
    expect(lastUpdate()).toEqual({
      first_name: "Abebe", middle_name: "", last_name: "", gender: "unknown", dob: "", phone: "", email: "",
      national_id: "", blood_group: "",
    });
  });

  test("REG-FE-PEDIT-003 the first name is required: blank or spaces disable Save", async () => {
    const { user } = open();
    const first = field("First name *");
    await user.clear(first);
    expect(save()).toBeDisabled();
    await user.type(first, "   ");
    expect(save()).toBeDisabled();
    await user.type(first, "Almaz");
    expect(save()).toBeEnabled();
  });

  test("REG-FE-PEDIT-004 every typed value is trimmed before it is sent", async () => {
    const { user } = open();
    for (const [label, v] of [["First name *", "  Almaz "], ["Middle name", " T "], ["Last name", " Girma "],
      ["Phone", " 0922 111 111 "], ["Email", " a@b.et "], ["National ID", " N-2 "]] as const) {
      const el = field(label);
      await user.clear(el);
      await user.type(el, v);
    }
    await user.click(save());
    await waitFor(() => expect(anyUpdate()).toHaveLength(1));
    expect(lastUpdate()).toMatchObject({
      first_name: "Almaz", middle_name: "T", last_name: "Girma", phone: "0922 111 111", email: "a@b.et", national_id: "N-2",
    });
  });

  test("REG-FE-PEDIT-005 sex and blood group are chosen from the lists; 'Not recorded' clears the blood group", async () => {
    const { user } = open();
    const [sex, blood] = screen.getAllByRole("combobox").slice(0, 2);
    await user.click(sex);
    await user.click(await screen.findByRole("option", { name: "Female" }));
    await user.click(blood);
    await user.click(await screen.findByRole("option", { name: "Not recorded" }));
    await user.click(save());
    await waitFor(() => expect(anyUpdate()).toHaveLength(1));
    expect(lastUpdate()).toMatchObject({ gender: "female", blood_group: "" });
  });

  test("REG-FE-PEDIT-006 a blood group can be set", async () => {
    const { user } = open({ blood_group: "" });
    await user.click(screen.getAllByRole("combobox")[1]);
    await user.click(await screen.findByRole("option", { name: "AB-" }));
    await user.click(save());
    await waitFor(() => expect(anyUpdate()).toHaveLength(1));
    expect(lastUpdate()).toMatchObject({ blood_group: "AB-" });
  });

  test("REG-FE-PEDIT-007 a birthdate typed in the Gregorian calendar is sent as entered, and the age shows", async () => {
    const { user } = open();
    await user.click(screen.getByRole("button", { name: "Gregorian" }));
    const date = document.querySelector('input[type="date"]') as HTMLInputElement;
    fireEvent.change(date, { target: { value: "2000-02-29" } });
    expect(screen.getByText(/Ethiopian: .* EC/)).toBeInTheDocument();
    await user.click(save());
    await waitFor(() => expect(anyUpdate()).toHaveLength(1));
    expect(lastUpdate()).toMatchObject({ dob: "2000-02-29" });
  });

  test("REG-FE-PEDIT-008 an incomplete Ethiopian birthdate clears it rather than sending half a date", async () => {
    const { user } = open();
    const day = screen.getByPlaceholderText("Day");
    await user.clear(day);
    await user.click(save());
    await waitFor(() => expect(anyUpdate()).toHaveLength(1));
    expect(lastUpdate()).toMatchObject({ dob: "" });
  });

  // NEW-PATUI-4: the edit dialog accepts a birthdate in the future (no age can be
  // worked out from it) and saves it. It should refuse it, as it refuses a blank name.
  test.fails("REG-FE-PEDIT-009 a birthdate in the future cannot be saved (NEW-PATUI-4)", async () => {
    const { user } = open();
    await user.click(screen.getByRole("button", { name: "Gregorian" }));
    const next = new Date();
    next.setFullYear(next.getFullYear() + 1);
    const iso = `${next.getFullYear()}-01-15`;
    fireEvent.change(document.querySelector('input[type="date"]') as HTMLInputElement, { target: { value: iso } });
    await user.click(save()).catch(() => {});
    await new Promise((r) => setTimeout(r, 50));
    expect(anyUpdate()).toHaveLength(0);
  });

  // NEW-PATUI-5: registration refuses a malformed email ("Invalid email"); the edit
  // dialog sends it to the server unchecked, so the two ways in disagree.
  test.fails("REG-FE-PEDIT-010 a malformed email is refused before saving, as at registration (NEW-PATUI-5)", async () => {
    const { user } = open();
    const email = field("Email");
    await user.clear(email);
    await user.type(email, "not-an-email");
    await user.click(save()).catch(() => {});
    await new Promise((r) => setTimeout(r, 50));
    expect(anyUpdate()).toHaveLength(0);
  });

  test("REG-FE-PEDIT-011 a phone the server refuses: its reason is shown and the dialog stays open with the edit", async () => {
    fake.on("PUT", "/patients/pat_1", fail(422, "Phone must be an Ethiopian mobile number", "VALIDATION"));
    const { user, onSaved, onClose } = open();
    const phone = field("Phone");
    await user.clear(phone);
    await user.type(phone, "12345");
    await user.click(save());
    await waitFor(() => expect(toasts("error")).toEqual(["Phone must be an Ethiopian mobile number"]));
    expect(onSaved).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByText("Edit patient details")).toBeInTheDocument();
    expect(field("Phone")).toHaveValue("12345");
  });

  test("REG-FE-PEDIT-012 a network failure gets a plain message and the dialog stays open", async () => {
    const boom = () => { throw new TypeError("offline"); };
    fake.on("PUT", "/patients/pat_1", boom);
    const { user, onClose } = open();
    await user.click(save());
    await waitFor(() => expect(toasts("error")).toEqual(["Could not save the changes"]));
    expect(onClose).not.toHaveBeenCalled();
  });

  test("REG-FE-PEDIT-013 Cancel and Escape close without saving", async () => {
    const { user, onClose, onSaved } = open();
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onClose).toHaveBeenCalledTimes(1);
    await user.keyboard("{Escape}");
    expect(onClose).toHaveBeenCalledTimes(2);
    expect(onSaved).not.toHaveBeenCalled();
    expect(anyUpdate()).toHaveLength(0);
  });
});
