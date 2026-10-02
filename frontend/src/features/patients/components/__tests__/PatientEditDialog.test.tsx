// Component-test pattern: render the real component inside the providers it needs
// (here a fresh QueryClient), mock the API module at its import path, drive it the
// way a user would (user-event, roles/text), and assert on what reached the API.
//
// KNOWN-BUG CONVENTION: a test that pins a bug we have NOT fixed yet is written as
// `test.fails("REG-... KNOWN BUG <id> ...")`. It asserts the CORRECT behaviour, so
// today it fails and Vitest reports it as passing (expected failure), keeping the
// suite green. The day the bug is fixed the assertion passes, `test.fails` turns red,
// and whoever fixed it changes `test.fails` to `test` — the bug is then guarded for
// good. Never "fix" a red known-bug test by weakening its assertion.
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, test, vi } from "vitest";

const api = vi.hoisted(() => ({ updatePatient: vi.fn() }));
vi.mock("@/features/patients/api", () => ({ updatePatient: api.updatePatient }));

import { PatientEditDialog } from "@/features/patients/components/PatientEditDialog";
import type { Patient } from "@/features/patients/api";

// The server's patient record carries address and emergency_contact too, though
// the frontend Patient type does not declare them yet.
const patient = {
  id: "pat_1", mrn: "MRN-0001", first_name: "Abebe", middle_name: "Kebede", last_name: "Bekele",
  gender: "male", dob: "1990-05-01", phone: "0911000000", email: "abebe@example.test",
  national_id: "NID-1", passport_no: "EP1234567", blood_group: "O+", created_at: "2026-01-01T00:00:00Z",
  address: "Bole, Addis Ababa", emergency_contact: "Almaz 0911222333",
} as Patient & { address: string; emergency_contact: string };

async function editPhoneAndSave() {
  const onSaved = vi.fn();
  const onClose = vi.fn();
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      <PatientEditDialog patient={patient} onClose={onClose} onSaved={onSaved} />
    </QueryClientProvider>,
  );
  const user = userEvent.setup();
  const phone = screen.getByPlaceholderText("09…");
  await user.clear(phone);
  await user.type(phone, "0922111111");
  await user.click(screen.getByRole("button", { name: "Save changes" }));
  await waitFor(() => expect(api.updatePatient).toHaveBeenCalledTimes(1));
  await waitFor(() => expect(onSaved).toHaveBeenCalled());
  return api.updatePatient.mock.calls[0] as [string, Record<string, unknown>];
}

describe("REG-FE-PATIENT patient edit dialog", () => {
  beforeEach(() => {
    api.updatePatient.mockReset();
    api.updatePatient.mockImplementation(async (_id: string, v: object) => ({ ...patient, ...v }));
  });

  test("REG-FE-PATIENT-002 saving sends the edited phone and keeps the shown fields", async () => {
    const [id, body] = await editPhoneAndSave();
    expect(id).toBe("pat_1");
    expect(body).toMatchObject({
      first_name: "Abebe", middle_name: "Kebede", last_name: "Bekele", gender: "male", dob: "1990-05-01",
      phone: "0922111111", email: "abebe@example.test", national_id: "NID-1", blood_group: "O+",
    });
  });

  test.fails("REG-FE-PATIENT-001 KNOWN BUG PAT-6 editing the phone must not erase passport, address, emergency contact", async () => {
    const [, body] = await editPhoneAndSave();
    expect(body).toMatchObject({
      passport_no: "EP1234567",
      address: "Bole, Addis Ababa",
      emergency_contact: "Almaz 0911222333",
    });
  });
});
