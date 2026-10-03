// The patients API module is a set of thin wrappers, but the paths, verbs and bodies
// they send are the contract with the server. What it must get right: the list query
// string (search, page, page size, the optional gender filter), the force flag on
// create, a PATIENT_DUPLICATE answer turned into duplicate matches instead of an
// error (and every other error passed through), and the patient id placed where the
// server expects it on every sub-resource.
import { beforeEach, describe, expect, test, vi } from "vitest";

const client = vi.hoisted(() => ({ apiFetch: vi.fn(), apiList: vi.fn() }));
vi.mock("@/lib/api-client", async (orig) => ({ ...(await orig<object>()), ...client }));

import { AppError } from "@/lib/api-client";
import {
  addAllergy, addCondition, createPatient, getPatient, importHistory, importPatients, patientLabs,
  patientOverview, removeAllergy, removeCondition, searchPatients, updatePatient,
} from "@/features/patients/api";

const values = { first_name: "Abebe", last_name: "Kebede", gender: "male", dob: "1990-05-01" };

describe("REG-FE-PATAPI patients API wrappers", () => {
  beforeEach(() => {
    client.apiFetch.mockReset();
    client.apiList.mockReset();
    client.apiFetch.mockResolvedValue({ ok: true });
    client.apiList.mockResolvedValue({ items: [], meta: { total: 0 } });
  });

  test("REG-FE-PATAPI-001 search sends q, page and page size, and no gender when unfiltered", async () => {
    await searchPatients("abe 09", 2, 20);
    const url = client.apiList.mock.calls[0][0] as string;
    const [path, qs] = url.split("?");
    expect(path).toBe("/patients");
    const p = new URLSearchParams(qs);
    expect(p.get("q")).toBe("abe 09");
    expect(p.get("page")).toBe("2");
    expect(p.get("page_size")).toBe("20");
    expect(p.has("gender")).toBe(false);
  });

  test("REG-FE-PATAPI-002 search adds the gender filter when one is chosen", async () => {
    const res = await searchPatients("", 1, 20, { gender: "female" });
    expect(new URLSearchParams((client.apiList.mock.calls[0][0] as string).split("?")[1]).get("gender")).toBe("female");
    expect(res).toEqual({ items: [], meta: { total: 0 } });
  });

  test("REG-FE-PATAPI-003 create posts the values with force=false by default and returns the patient", async () => {
    client.apiFetch.mockResolvedValue({ id: "pat_1", mrn: "MRN-1" });
    const res = await createPatient(values);
    expect(client.apiFetch).toHaveBeenCalledWith("/patients", { method: "POST", body: { ...values, force: false } });
    expect(res).toEqual({ patient: { id: "pat_1", mrn: "MRN-1" } });
  });

  test("REG-FE-PATAPI-004 create with force=true tells the server to skip the duplicate check", async () => {
    await createPatient(values, true);
    expect(client.apiFetch.mock.calls[0][1]).toMatchObject({ body: { force: true } });
  });

  test("REG-FE-PATAPI-005 a PATIENT_DUPLICATE answer comes back as matches, not an error", async () => {
    const dups = [{ id: "pat_9", mrn: "MRN-9", full_name: "Abebe Kebede", dob: "1990-05-01" }];
    client.apiFetch.mockRejectedValue(new AppError(409, "PATIENT_DUPLICATE", "dup", undefined, undefined, { duplicates: dups }));
    await expect(createPatient(values)).resolves.toEqual({ duplicates: dups });
  });

  test("REG-FE-PATAPI-006 a duplicate answer without a body still means 'duplicates' (an empty list)", async () => {
    client.apiFetch.mockRejectedValue(new AppError(409, "PATIENT_DUPLICATE", "dup"));
    await expect(createPatient(values)).resolves.toEqual({ duplicates: [] });
  });

  test("REG-FE-PATAPI-007 any other failure is passed through to the caller", async () => {
    const err = new AppError(422, "VALIDATION", "bad dob");
    client.apiFetch.mockRejectedValue(err);
    await expect(createPatient(values)).rejects.toBe(err);
    const net = new TypeError("offline");
    client.apiFetch.mockRejectedValue(net);
    await expect(createPatient(values)).rejects.toBe(net);
  });

  test("REG-FE-PATAPI-008 read and update address the patient by id", async () => {
    await getPatient("pat_1");
    await updatePatient("pat_1", values);
    await patientOverview("pat_1");
    await patientLabs("pat_1");
    expect(client.apiFetch.mock.calls).toEqual([
      ["/patients/pat_1"],
      ["/patients/pat_1", { method: "PUT", body: values }],
      ["/patients/pat_1/overview"],
      ["/lab/patients/pat_1/labs"],
    ]);
  });

  test("REG-FE-PATAPI-009 history import carries the patient id alongside the SOAP sections", async () => {
    await importHistory("pat_1", { date: "2020-01-02", subjective: "toothache", plan: "extract" });
    expect(client.apiFetch).toHaveBeenCalledWith("/history-import", {
      method: "POST", body: { patient_id: "pat_1", date: "2020-01-02", subjective: "toothache", plan: "extract" },
    });
  });

  test("REG-FE-PATAPI-010 bulk import posts the rows, dry-run flag, duplicate rule and calendar as given", async () => {
    const body = { rows: [{ row_number: 2, name: "Abebe" }], dry_run: true, on_duplicate: "update" as const, calendar: "ethiopian" as const };
    await importPatients(body);
    expect(client.apiFetch).toHaveBeenCalledWith("/patients/import", { method: "POST", body });
  });

  test("REG-FE-PATAPI-011 allergies and conditions are added and removed under the patient", async () => {
    await addAllergy("pat_1", { substance: "Penicillin", severity: "severe" });
    await removeAllergy("pat_1", "alg_1");
    await addCondition("pat_1", { description: "Diabetes", status: "active" });
    await removeCondition("pat_1", "cnd_1");
    expect(client.apiFetch.mock.calls).toEqual([
      ["/patients/pat_1/allergies", { method: "POST", body: { substance: "Penicillin", severity: "severe" } }],
      ["/patients/pat_1/allergies/alg_1", { method: "DELETE" }],
      ["/patients/pat_1/conditions", { method: "POST", body: { description: "Diabetes", status: "active" } }],
      ["/patients/pat_1/conditions/cnd_1", { method: "DELETE" }],
    ]);
  });
});
