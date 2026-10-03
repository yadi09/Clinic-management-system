// Importing old records, two ways. What the screen must get right:
//
// One patient (default tab): first and last name plus a birthdate OR an age are
// required (an age becomes 1 January of the birth year); the patient is created with
// force=true (the duplicate prompt is skipped on import, a reused card ID is still
// refused by the server) keeping the existing card number; pasted history is saved
// as ONE back-dated visit on the record date — and only when something was pasted;
// errors stay on the page; success opens the new patient.
//
// Bulk CSV: the file (chosen or pasted) is parsed (quoted commas, doubled quotes,
// CRLF, blank lines); headings are matched to fields automatically and can be
// corrected; unmapped columns are reported as ignored; rows without a name, phone
// or age are skipped; the first date is previewed in the chosen calendar; "Check
// file" is a dry run; rows go in batches of 300 and a failed batch marks its rows
// failed without stopping the rest; the report counts outcomes, and both the failed
// rows and the full report download as CSV with the original row numbers.
//
// Time: tests freeze "now" themselves. The record date default is read when the
// page module loads, so those tests re-import the module after freezing.
//
// KNOWN-BUG CONVENTION: `test.fails("REG-... KNOWN BUG <id> ...")` asserts the
// CORRECT behaviour, so it fails today and Vitest counts it as an expected failure.
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

const api = vi.hoisted(() => ({ createPatient: vi.fn(), importHistory: vi.fn(), importPatients: vi.fn() }));
vi.mock("@/features/patients/api", async (orig) => ({ ...(await orig<object>()), ...api }));
const tst = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }));
vi.mock("sonner", async (orig) => ({ ...(await orig<object>()), toast: tst }));

import { PatientImportPage } from "@/features/patients/pages/PatientImportPage";
import type { ImportReport, ImportRowInput, ImportRowResult } from "@/features/patients/api";
import { AppError } from "@/lib/api-client";
import { currentLocation, renderUI } from "@/test/render";

type User = ReturnType<typeof renderUI>["user"];

const at = (iso: string) => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(iso));
};
const fieldBox = (label: RegExp) => screen.getByText(label, { selector: "label" }).parentElement!;
const textIn = (label: RegExp) => within(fieldBox(label)).getByRole("textbox");
const inputIn = (label: RegExp) => fieldBox(label).querySelector("input, textarea") as HTMLInputElement;
const btn = (name: string | RegExp) => screen.getByRole("button", { name });

function show(Page = PatientImportPage) {
  return renderUI(<Page />, { route: "/patients/import" });
}

// ---------------------------------------------------------------- single

async function fillPatient(user: User, { first = "Abebe", last = "Kebede", mrn = "", age = "", dob = "", phone = "" } = {}) {
  if (mrn) await user.type(textIn(/^Existing card ID/), mrn);
  if (first) await user.type(textIn(/^First name/), first);
  if (last) await user.type(textIn(/^Last name/), last);
  if (dob) fireEvent.change(inputIn(/^Date of birth/), { target: { value: dob } });
  if (age) fireEvent.change(inputIn(/^Age \(if DOB unknown\)/), { target: { value: age } });
  if (phone) await user.type(textIn(/^Phone/), phone);
}

describe("REG-FE-PIMPORT single legacy patient", () => {
  beforeEach(() => {
    Object.values(api).forEach((f) => f.mockReset());
    tst.success.mockReset();
    at("2026-10-03T10:00:00+03:00");
  });
  afterEach(() => vi.useRealTimers());

  test("REG-FE-PIMPORT-001 Import stays disabled until first name, last name and a birthdate or age are given", async () => {
    const { user } = show();
    const go = btn(/Import patient/);
    expect(go).toBeDisabled();
    expect(screen.getByText(/No history entered/)).toBeInTheDocument();
    await fillPatient(user, { last: "" });
    fireEvent.change(inputIn(/^Age/), { target: { value: "30" } });
    expect(go).toBeDisabled(); // no last name
    await user.type(textIn(/^Last name/), "Kebede");
    expect(go).toBeEnabled();
    fireEvent.change(inputIn(/^Age/), { target: { value: "200" } }); // not a real age
    expect(go).toBeDisabled();
  });

  test("REG-FE-PIMPORT-002 an age becomes 1 January of the birth year, shown as a hint, and the card ID is kept", async () => {
    api.createPatient.mockResolvedValue({ patient: { id: "pat_1", mrn: "0087" } });
    const { user, qc } = show();
    const inval = vi.spyOn(qc, "invalidateQueries");
    await fillPatient(user, { mrn: "  0087 ", first: " Abebe ", last: "Kebede", age: "34", phone: "0911223344" });
    await user.type(textIn(/^Middle name/), "Tesfaye");
    expect(screen.getByText("Using 1992-01-01 from age")).toBeInTheDocument();
    await user.click(btn(/Import patient/));
    await waitFor(() => expect(api.createPatient).toHaveBeenCalledTimes(1));
    expect(api.createPatient).toHaveBeenCalledWith(
      { mrn: "0087", first_name: "Abebe", middle_name: "Tesfaye", last_name: "Kebede", gender: "unknown", dob: "1992-01-01", phone: "0911223344" },
      true,
    );
    // Nothing pasted → no history visit.
    expect(api.importHistory).not.toHaveBeenCalled();
    await waitFor(() => expect(currentLocation()).toBe("/patients/pat_1"));
    expect(tst.success).toHaveBeenCalledWith("Imported · card 0087");
    expect(inval).toHaveBeenCalledWith({ queryKey: ["patients"] });
  });

  test("REG-FE-PIMPORT-003 a blank card ID is left for the server to generate; a birthdate wins over (and locks) age", async () => {
    api.createPatient.mockResolvedValue({ patient: { id: "pat_2", mrn: "MRN-0100" } });
    const { user } = show();
    await fillPatient(user, { dob: "1980-02-03" });
    expect(inputIn(/^Age/)).toBeDisabled();
    expect(screen.getByText("Or enter age →")).toBeInTheDocument();
    await user.click(screen.getByRole("combobox"));
    await user.click(await screen.findByRole("option", { name: "Female" }));
    await user.click(btn(/Import patient/));
    await waitFor(() => expect(api.createPatient).toHaveBeenCalled());
    const [values] = api.createPatient.mock.calls[0];
    expect(values).toMatchObject({ mrn: undefined, dob: "1980-02-03", gender: "female" });
  });

  test("REG-FE-PIMPORT-004 pasted history is saved once, back-dated to the record date, with all four sections", async () => {
    api.createPatient.mockResolvedValue({ patient: { id: "pat_3", mrn: "C-3" } });
    api.importHistory.mockResolvedValue({ encounter_id: "enc_1" });
    const { user } = show();
    await fillPatient(user, { age: "50" });
    fireEvent.change(inputIn(/^Record date/), { target: { value: "2019-04-05" } });
    fireEvent.change(inputIn(/^History/), { target: { value: "Toothache for 3 days" } });
    fireEvent.change(inputIn(/^Examination findings/), { target: { value: "Caries 36" } });
    fireEvent.change(inputIn(/^Diagnosis/), { target: { value: "Pulpitis" } });
    fireEvent.change(inputIn(/^Treatment/), { target: { value: "RCT" } });
    expect(screen.getByText("History will be saved as a past visit.")).toBeInTheDocument();
    await user.click(btn(/Import patient/));
    await waitFor(() => expect(api.importHistory).toHaveBeenCalledTimes(1));
    expect(api.importHistory).toHaveBeenCalledWith("pat_3", {
      date: "2019-04-05", subjective: "Toothache for 3 days", objective: "Caries 36", assessment: "Pulpitis", plan: "RCT",
    });
    await waitFor(() => expect(currentLocation()).toBe("/patients/pat_3"));
  });

  test("REG-FE-PIMPORT-005 a server refusal (e.g. card ID in use) is shown and nothing else is saved", async () => {
    api.createPatient.mockRejectedValue(new AppError(409, "MRN_TAKEN", "Card ID 0087 is already in use"));
    const { user } = show();
    await fillPatient(user, { age: "20" });
    fireEvent.change(inputIn(/^Diagnosis/), { target: { value: "x" } });
    await user.click(btn(/Import patient/));
    expect(await screen.findByText("Card ID 0087 is already in use")).toBeInTheDocument();
    expect(api.importHistory).not.toHaveBeenCalled();
    expect(currentLocation()).toBe("/patients/import");
    expect(btn(/Import patient/)).toBeEnabled();
  });

  test("REG-FE-PIMPORT-006 an unexpected failure (no patient back, or history save fails) says it could not import", async () => {
    api.createPatient.mockResolvedValueOnce({ duplicates: [] });
    const { user } = show();
    await fillPatient(user, { age: "20" });
    await user.click(btn(/Import patient/));
    expect(await screen.findByText("Could not import this patient.")).toBeInTheDocument();
    api.createPatient.mockResolvedValueOnce({ patient: { id: "pat_4", mrn: "M4" } });
    api.importHistory.mockRejectedValueOnce(new TypeError("Failed to fetch"));
    fireEvent.change(inputIn(/^Treatment/), { target: { value: "Scaling" } });
    await user.click(btn(/Import patient/));
    await waitFor(() => expect(api.importHistory).toHaveBeenCalled());
    expect(await screen.findByText("Could not import this patient.")).toBeInTheDocument();
    expect(currentLocation()).toBe("/patients/import");
  });

  test("REG-FE-PIMPORT-007 the back button returns to the patient list", async () => {
    const { user } = show();
    await user.click(btn(/Patients/));
    expect(currentLocation()).toBe("/patients");
  });

  test("REG-FE-PIMPORT-008 the record date defaults to today and cannot be in the future", async () => {
    vi.resetModules();
    const { PatientImportPage: Fresh } = await import("@/features/patients/pages/PatientImportPage");
    show(Fresh);
    expect(inputIn(/^Record date/)).toHaveValue("2026-10-03");
    expect(inputIn(/^Record date/)).toHaveAttribute("max", "2026-10-03");
  });

  test.fails("REG-FE-PIMPORT-009 KNOWN BUG NEW-PATUI-2 just after midnight in Addis the record date is still today, not yesterday (UTC)", async () => {
    at("2026-10-03T00:20:00+03:00"); // 2 Oct 21:20 UTC
    vi.resetModules();
    const { PatientImportPage: Fresh } = await import("@/features/patients/pages/PatientImportPage");
    show(Fresh);
    expect(inputIn(/^Record date/)).toHaveValue("2026-10-03");
    expect(inputIn(/^Record date/)).toHaveAttribute("max", "2026-10-03");
  });
});

// ---------------------------------------------------------------- bulk

const HEADER = "NUMBER,Date of Visit,Name,Phone Number,Sex,Age,Notes";
const CSV = [
  HEADER,
  "1,13/06/2017,Abebe Kebede,0911223344,M,34,paid 200",
  '2,42922,"Bekele, Almaz",+251912345678,Female,27,"said ""hi"""',
  "3,,,,,,only notes",
  "",
  "4,01/01/2016,Selam,,,,",
].join("\r\n");

const report = (over: Partial<ImportReport> = {}, rows: ImportRowResult[] = []): ImportReport => ({
  total: rows.length, imported: 0, updated: 0, duplicates: 0, failed: 0, missing_phone: 0, missing_gender: 0,
  estimated_dob: 0, dry_run: false, rows, ...over,
});
const rr = (row_number: number, outcome: ImportRowResult["outcome"], extra: Partial<ImportRowResult> = {}): ImportRowResult => ({
  row_number, name: `P${row_number}`, phone: "", gender: "", age: "", visit_date: "", outcome, ...extra,
});

function paste(text: string) {
  fireEvent.change(screen.getByPlaceholderText(/^NUMBER,Date of Visit/), { target: { value: text } });
}

async function openBulk(user: User) {
  await user.click(btn("Bulk import (CSV)"));
  await screen.findByText("Bulk import from a spreadsheet");
}

/** Capture CSV downloads: file name and text of every Blob the page saves. */
function captureDownloads() {
  const files: { name: string; blob: Blob }[] = [];
  const blobs = new Map<string, Blob>();
  let n = 0;
  URL.createObjectURL = vi.fn((b: Blob) => { const u = `blob:test/${n++}`; blobs.set(u, b); return u; });
  URL.revokeObjectURL = vi.fn();
  vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (this: HTMLAnchorElement) {
    files.push({ name: this.download, blob: blobs.get(this.href)! });
  });
  // jsdom's Blob has no .text(); FileReader reads it the same way.
  const text = (i: number) => new Promise<string>((resolve) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result));
    r.readAsText(files[i].blob);
  });
  return { files, text };
}

const sentRows = (call = 0) => (api.importPatients.mock.calls[call][0] as { rows: ImportRowInput[] }).rows;

describe("REG-FE-PIMPORT bulk CSV import", () => {
  beforeEach(() => {
    Object.values(api).forEach((f) => f.mockReset());
    tst.success.mockReset();
    at("2026-10-03T10:00:00+03:00");
  });
  afterEach(() => vi.useRealTimers());

  test("REG-FE-PIMPORT-010 a pasted register is parsed, mapped by heading and previewed; blank and name-less rows are skipped", async () => {
    const { user } = show();
    await openBulk(user);
    paste(CSV);
    expect(await screen.findByText("Column mapping")).toBeInTheDocument();
    // Headings were matched automatically.
    const box = (l: RegExp) => within(fieldBox(l)).getByRole("combobox");
    expect(box(/^Name/)).toHaveTextContent("Name");
    expect(box(/^Phone number/)).toHaveTextContent("Phone Number");
    expect(box(/^Sex/)).toHaveTextContent("Sex");
    expect(box(/^Age/)).toHaveTextContent("Age");
    expect(box(/^Date of visit/)).toHaveTextContent("Date of Visit");
    expect(box(/^Card ID/)).toHaveTextContent("— not in my file —");
    expect(screen.getByText(/Ignored columns:/).parentElement).toHaveTextContent("NUMBER, Notes");
    // Row 3 has only notes → skipped; the blank line is not a row.
    expect(screen.getByText("3 rows found.")).toBeInTheDocument();
    const preview = screen.getByText("Row").closest("table")!;
    expect(within(preview).getByText("Bekele, Almaz")).toBeInTheDocument();
    expect(within(preview).getByText("Selam")).toBeInTheDocument();
    expect(btn(/Import 3/)).toBeEnabled();
    // The first date is previewed in the Ethiopian calendar by default: 13/06/2017 EC = 20 Feb 2025.
    expect(screen.getByText(/^"13\/06\/2017" → .*2025/)).toBeInTheDocument();
  });

  test("REG-FE-PIMPORT-011 Check file is a dry run: rows go up unparsed with row numbers, and nothing is said to be saved", async () => {
    api.importPatients.mockResolvedValue(report({ total: 3, imported: 3, dry_run: true, estimated_dob: 2, missing_phone: 1, missing_gender: 1 }, [rr(2, "imported"), rr(3, "imported"), rr(6, "imported")]));
    const { user, qc } = show();
    const inval = vi.spyOn(qc, "invalidateQueries");
    await openBulk(user);
    paste(CSV);
    await user.click(await screen.findByRole("button", { name: /Check file/ }));
    await waitFor(() => expect(api.importPatients).toHaveBeenCalledTimes(1));
    const body = api.importPatients.mock.calls[0][0];
    expect(body).toMatchObject({ dry_run: true, on_duplicate: "skip", calendar: "ethiopian" });
    expect(body.rows).toEqual([
      { row_number: 2, name: "Abebe Kebede", phone: "0911223344", gender: "M", age: "34", visit_date: "13/06/2017", mrn: "" },
      { row_number: 3, name: "Bekele, Almaz", phone: "+251912345678", gender: "Female", age: "27", visit_date: "42922", mrn: "" },
      { row_number: 5, name: "Selam", phone: "", gender: "", age: "", visit_date: "01/01/2016", mrn: "" },
    ]);
    expect(await screen.findByText("Check results — nothing was saved")).toBeInTheDocument();
    expect(screen.getByText("100% of 3 rows are ready to import.")).toBeInTheDocument();
    expect(screen.getByText(/3 ready to import/)).toBeInTheDocument();
    expect(screen.getByText(/flagged it as\s+approximate/)).toBeInTheDocument();
    expect(tst.success).toHaveBeenCalledWith("Check complete — nothing was saved");
    expect(inval).not.toHaveBeenCalled();
  });

  test("REG-FE-PIMPORT-012 a real import with Gregorian dates and 'update' sends those choices and refreshes the patient list", async () => {
    api.importPatients.mockResolvedValue(report({ total: 3, imported: 1, updated: 1, duplicates: 1 }, [
      rr(2, "imported", { mrn: "MRN-1" }), rr(3, "updated"), rr(5, "duplicate", { reason: "same phone", mrn: "MRN-0007" }),
    ]));
    const { user, qc } = show();
    const inval = vi.spyOn(qc, "invalidateQueries");
    await openBulk(user);
    paste(CSV);
    await user.click(within(fieldBox(/^Dates in my file are/)).getByRole("combobox"));
    await user.click(await screen.findByRole("option", { name: "Gregorian" }));
    // 13/06/2017 read as Gregorian: day 13, month 6.
    expect(screen.getByText(/^"13\/06\/2017" → .*2017/)).toBeInTheDocument();
    await user.click(within(fieldBox(/^If a patient is already on file/)).getByRole("combobox"));
    await user.click(await screen.findByRole("option", { name: "Update their details from this file" }));
    await user.click(btn(/Import 3/));
    await waitFor(() => expect(api.importPatients).toHaveBeenCalled());
    expect(api.importPatients.mock.calls[0][0]).toMatchObject({ dry_run: false, on_duplicate: "update", calendar: "gregorian" });
    expect(await screen.findByText("Import complete")).toBeInTheDocument();
    expect(screen.getByText("67% of 3 rows went in.")).toBeInTheDocument();
    expect(screen.getByText("1 updated")).toBeInTheDocument();
    expect(screen.getByText("1 already on file")).toBeInTheDocument();
    expect(screen.getByText("Rows already on file (1)")).toBeInTheDocument();
    expect(screen.getByText("Row 5 · P5 — same phone (card MRN-0007)")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Download failed rows/ })).not.toBeInTheDocument();
    expect(tst.success).toHaveBeenCalledWith("Imported 1 patient");
    expect(inval).toHaveBeenCalledWith({ queryKey: ["patients"] });
  });

  test("REG-FE-PIMPORT-013 more than 300 rows go in batches; a failed batch marks only its rows failed and the rest still import", async () => {
    const lines = [HEADER, ...Array.from({ length: 301 }, (_, i) => `${i + 1},,Patient ${i + 1},09${String(i).padStart(8, "0")},F,30,`)];
    api.importPatients
      .mockResolvedValueOnce(report({ total: 300, imported: 300 }, Array.from({ length: 300 }, (_, i) => rr(i + 2, "imported"))))
      .mockRejectedValueOnce(new AppError(500, "INTERNAL", "Server exploded"));
    const { user } = show();
    await openBulk(user);
    paste(lines.join("\n"));
    expect(await screen.findByText("301 rows found — showing the first 10.")).toBeInTheDocument();
    expect(screen.getByText("Dates are stored as Gregorian.")).toBeInTheDocument();
    await user.click(btn(/Import 301/));
    expect(await screen.findByText("Import complete")).toBeInTheDocument();
    expect(api.importPatients).toHaveBeenCalledTimes(2);
    expect(sentRows(0)).toHaveLength(300);
    expect(sentRows(1)).toEqual([{ row_number: 302, name: "Patient 301", phone: "0900000300", gender: "F", age: "30", visit_date: "", mrn: "" }]);
    expect(screen.getByText("100% of 301 rows went in.")).toBeInTheDocument(); // 300/301 rounds to 100
    expect(screen.getByText(/1 row failed/)).toBeInTheDocument();
    await user.click(btn(/View failed rows/));
    const failedTable = screen.getByText("Why it failed").closest("table")!;
    expect(within(failedTable).getByText("302")).toBeInTheDocument();
    expect(within(failedTable).getByText("Server exploded")).toBeInTheDocument();
    await user.click(btn(/Hide failed rows/));
    expect(screen.queryByText("Why it failed")).not.toBeInTheDocument();
    expect(tst.success).toHaveBeenCalledWith("Imported 300 patients");
  });

  test("REG-FE-PIMPORT-014 failed rows and the full report download as CSV with original row numbers and reasons", async () => {
    const dl = captureDownloads();
    api.importPatients.mockRejectedValue(new TypeError("Failed to fetch"));
    const { user } = show();
    await openBulk(user);
    paste(CSV);
    await user.click(await screen.findByRole("button", { name: /Import 3/ }));
    expect(await screen.findByText(/3 rows failed/)).toBeInTheDocument();
    expect(screen.getByText("0% of 3 rows went in.")).toBeInTheDocument();
    expect(tst.success).toHaveBeenCalledWith("Imported 0 patients");
    await user.click(btn(/Download failed rows/));
    await user.click(btn(/Download full report/));
    expect(dl.files.map((f) => f.name)).toEqual(["failed-rows.csv", "import-report.csv"]);
    const failed = (await dl.text(0)).split("\n");
    expect(failed[0]).toBe("OriginalRowNumber,Name,PhoneNumber,Gender,Age,DateOfVisit,FailureReason");
    // A name with a comma is quoted so the CSV still opens in the right columns.
    expect(failed[2]).toBe('3,"Bekele, Almaz",+251912345678,Female,27,42922,Could not reach the server');
    expect(failed).toHaveLength(4);
    const full = (await dl.text(1)).split("\n");
    expect(full[0]).toBe("OriginalRowNumber,Name,PhoneNumber,Gender,Age,DateOfVisit,Outcome,CardID,Detail");
    expect(full[1]).toBe("2,Abebe Kebede,0911223344,M,34,13/06/2017,failed,,Could not reach the server");
    expect(URL.revokeObjectURL).toHaveBeenCalledTimes(2);
  });

  test("REG-FE-PIMPORT-015 the full report carries card IDs and warnings for rows that went in", async () => {
    const dl = captureDownloads();
    api.importPatients.mockResolvedValue(report({ total: 1, imported: 1 }, [rr(2, "imported", { mrn: "MRN-9", warning: 'age "x" ignored', name: 'Abebe "Abe"' })]));
    const { user } = show();
    await openBulk(user);
    paste(CSV);
    await user.click(await screen.findByRole("button", { name: /Import 3/ }));
    await screen.findByText("Import complete");
    await user.click(btn(/Download full report/));
    expect((await dl.text(0)).split("\n")[1]).toBe('2,"Abebe ""Abe""",,,,,imported,MRN-9,"age ""x"" ignored"');
  });

  test("REG-FE-PIMPORT-016 the template downloads with the expected headings", async () => {
    const dl = captureDownloads();
    const { user } = show();
    await openBulk(user);
    await user.click(btn(/Download template/));
    expect(dl.files[0].name).toBe("clinicos-patient-import-template.csv");
    const lines = (await dl.text(0)).split("\n");
    expect(lines[0]).toBe("NUMBER,Date of Visit,Name,Phone Number,Sex,Age,Notes");
    expect(lines).toHaveLength(3);
  });

  test("REG-FE-PIMPORT-017 a chosen CSV file is read like a pasted one", async () => {
    const { user } = show();
    await openBulk(user);
    await user.click(btn(/Choose CSV file/)); // opens the (hidden) picker
    const picker = document.querySelector('input[type="file"]') as HTMLInputElement;
    // jsdom's File lacks .text(), which the page uses; give this one the browser's.
    const file = Object.assign(new File([CSV], "register.csv", { type: "text/csv" }), { text: async () => CSV });
    await user.upload(picker, file);
    expect(await screen.findByText("3 rows found.")).toBeInTheDocument();
    expect(screen.getByPlaceholderText(/^NUMBER,Date of Visit/)).toHaveValue(CSV.replace(/\r\n/g, "\n")); // a textarea normalises line ends
  });

  test("REG-FE-PIMPORT-018 a header alone asks for a patient row; nothing can be imported", async () => {
    const { user } = show();
    await openBulk(user);
    paste("Name,Phone");
    expect(await screen.findByText("Add a header row and at least one patient row.")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Check file/ })).not.toBeInTheDocument();
  });

  test("REG-FE-PIMPORT-019 with no name column the import is blocked until one is picked; the mapping can be corrected", async () => {
    const { user } = show();
    await openBulk(user);
    paste("Client,Mobile,Gender\nAbebe,0911,M\nAlmaz,0912,F");
    expect(await screen.findByText(/Pick the column that holds the patient's name/)).toBeInTheDocument();
    expect(btn(/Check file/)).toBeDisabled();
    expect(btn(/Import 2/)).toBeDisabled();
    await user.click(within(fieldBox(/^Name/)).getByRole("combobox"));
    await user.click(await screen.findByRole("option", { name: "Client" }));
    expect(screen.queryByText(/Pick the column that holds the patient's name/)).not.toBeInTheDocument();
    expect(btn(/Import 2/)).toBeEnabled();
    api.importPatients.mockResolvedValue(report({ total: 2, imported: 2 }));
    await user.click(btn(/Import 2/));
    await waitFor(() => expect(api.importPatients).toHaveBeenCalled());
    expect(sentRows()[0]).toMatchObject({ name: "Abebe", phone: "0911", gender: "M" });
  });

  test("REG-FE-PIMPORT-020 un-mapping a column stops it being sent", async () => {
    const { user } = show();
    await openBulk(user);
    paste(CSV);
    await user.click(within(fieldBox(/^Phone number/)).getByRole("combobox"));
    await user.click(await screen.findByRole("option", { name: "— not in my file —" }));
    expect(screen.getByText(/Ignored columns:/).parentElement).toHaveTextContent("NUMBER, Phone Number, Notes");
    api.importPatients.mockResolvedValue(report());
    await user.click(btn(/Check file/));
    await waitFor(() => expect(api.importPatients).toHaveBeenCalled());
    expect(sentRows().every((r) => r.phone === "")).toBe(true);
  });

  test("REG-FE-PIMPORT-021 the date preview reads year-first, month-first, Excel serials and says when a date is unreadable", async () => {
    const { user } = show();
    await openBulk(user);
    const csvWith = (d: string) => `Name,Date\nAbebe,${d}`;
    const pickGregorian = async () => {
      await user.click(within(fieldBox(/^Dates in my file are/)).getByRole("combobox"));
      await user.click(await screen.findByRole("option", { name: "Gregorian" }));
    };
    paste(csvWith("2017-06-13"));
    await pickGregorian();
    expect(screen.getByText(/^"2017-06-13" → .*2017/)).toBeInTheDocument();
    paste(csvWith("6/13/98")); // month-first, two-digit year → 1998
    await pickGregorian();
    expect(screen.getByText(/^"6\/13\/98" → .*1998/)).toBeInTheDocument();
    paste(csvWith("42922")); // Excel serial = 6 July 2017
    await pickGregorian();
    expect(screen.getByText(/^"42922" → .*2017/)).toBeInTheDocument();
    paste(csvWith("1234")); // a number but not a plausible serial
    expect(screen.getByText(`"1234" isn't a date we can read.`)).toBeInTheDocument();
    paste(csvWith("soon"));
    expect(screen.getByText(`"soon" isn't a date we can read.`)).toBeInTheDocument();
    paste(csvWith("31/31/2017")); // no month 31 → not a real date
    await pickGregorian();
    expect(screen.getByText(`"31/31/2017" isn't a date we can read.`)).toBeInTheDocument();
    paste(csvWith("40/14/2017")); // month 40 does not exist
    expect(screen.getByText(`"40/14/2017" isn't a date we can read.`)).toBeInTheDocument();
  });

  test("REG-FE-PIMPORT-022 a failed row with no name or phone reads 'empty' and '—'; headings that only contain an alias still map", async () => {
    api.importPatients.mockResolvedValue(report({ total: 1, failed: 1 }, [rr(2, "failed", { name: "", phone: "", reason: "name is required" })]));
    const { user } = show();
    await openBulk(user);
    paste("Patient Full Name ,Contact Number,Age (yrs)\n,,45");
    expect(await screen.findByText("1 row found.")).toBeInTheDocument();
    expect(screen.getByText("missing")).toBeInTheDocument(); // the preview flags the missing name
    await user.click(btn(/Check file/));
    expect(await screen.findByText("0% of 1 rows are ready to import.")).toBeInTheDocument();
    expect(sentRows()[0]).toMatchObject({ name: "", phone: "", age: "45" });
    await user.click(btn(/View failed rows/));
    const t = screen.getByText("Why it failed").closest("table")!;
    expect(within(t).getByText("empty")).toBeInTheDocument();
    expect(within(t).getByText("name is required")).toBeInTheDocument();
  });

  test.fails("REG-FE-PIMPORT-024 KNOWN BUG NEW-PATUI-3 row numbers are the sheet's own line numbers even after a blank line", async () => {
    // Line 6 of the sheet is Selam (line 5 is blank). The failed-rows CSV promises the
    // "OriginalRowNumber" so staff can find and fix the row; today blank lines are
    // dropped before numbering, so every row after one is reported a line too early.
    const { user } = show();
    await openBulk(user);
    paste(CSV);
    api.importPatients.mockResolvedValue(report());
    await user.click(await screen.findByRole("button", { name: /Check file/ }));
    await waitFor(() => expect(api.importPatients).toHaveBeenCalled());
    expect(sentRows().find((r) => r.name === "Selam")?.row_number).toBe(6);
  });

  test("REG-FE-PIMPORT-023 an empty report is 0%, and switching back to 'Add one patient' shows the single form", async () => {
    api.importPatients.mockResolvedValue(report());
    const { user } = show();
    await openBulk(user);
    paste("Name\nAbebe");
    await user.click(await screen.findByRole("button", { name: /Check file/ }));
    expect(await screen.findByText("0% of 0 rows are ready to import.")).toBeInTheDocument();
    // Editing the file clears the old report.
    paste("Name\nAlmaz");
    expect(screen.queryByText(/Check results/)).not.toBeInTheDocument();
    await user.click(btn("Add one patient"));
    expect(btn(/Import patient/)).toBeInTheDocument();
  });
});
