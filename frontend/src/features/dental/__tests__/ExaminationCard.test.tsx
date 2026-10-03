// The clinical examination card on a dental patient's page. The exams API is mocked
// so each test controls what is on record and asserts the exact document a save
// sends; the clinic, branch and patient queries resolve through quietApiFetch.
// Toasts are spied on through a mocked sonner, and printing through a mocked
// printExamination (printExam.ts has its own test of the HTML it writes).
import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, test, vi } from "vitest";

// These render the whole dental page and type into it; under a full parallel run
// (with coverage) a test can take longer than the 5 s default.
vi.setConfig({ testTimeout: 60_000 });

const api = vi.hoisted(() => ({
  listExams: vi.fn(), createExam: vi.fn(), updateExam: vi.fn(), deleteExam: vi.fn(),
}));
vi.mock("@/features/dental/api", async (orig) => ({ ...(await orig<object>()), ...api }));

const net = vi.hoisted(() => ({ branches: [] as unknown[] }));
vi.mock("@/lib/api-client", async (orig) => {
  const { quietApiFetch } = await import("@/test/render");
  return {
    ...(await orig<object>()),
    apiFetch: vi.fn(async (path: string) => (path === "/org/branches" ? net.branches : quietApiFetch(path))),
    apiList: vi.fn(async () => ({ items: [], meta: {} })),
  };
});

const tst = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }));
vi.mock("sonner", async (orig) => ({ ...(await orig<object>()), toast: tst }));

const printer = vi.hoisted(() => ({ printExamination: vi.fn() }));
vi.mock("@/features/dental/printExam", () => printer);

const auth = vi.hoisted(() => ({ activeBranchId: null as string | null }));
vi.mock("@/app/auth-context", () => ({
  useAuth: () => ({ can: () => true, flagOn: () => true, user: { id: "u1", full_name: "Dr Test" }, activeBranchId: auth.activeBranchId }),
}));

import { ExaminationCard } from "@/features/dental/ExaminationCard";
import type { Exam } from "@/features/dental/api";
import { AppError } from "@/lib/api-client";
import { renderUI } from "@/test/render";

const PID = "pat_1";

function E(id: string, over: Partial<Exam> = {}): Exam {
  return {
    id, visit_date: "2026-08-12", extraoral: [], intraoral: [], investigations: [], treatment_given: [],
    procedures: [], anaesthesia: "None", created_at: "", updated_at: "", ...over,
  } as Exam;
}

const FULL = E("ex1", {
  chief_complaint: "Pain lower right", hpi: "Three days", past_dental_history: "Filling 2024",
  extraoral: ["Within normal limits"], extraoral_notes: "No swelling",
  intraoral: ["Caries present"], intraoral_notes: "Deep caries",
  investigations: ["Periapical X-ray"], investigation_results: "PA lesion on 46",
  diagnosis: "Irreversible pulpitis — 46", treatment_plan: "RCT then crown",
  treatment_given: ["Root Canal Treatment", "Suturing"], anaesthesia: "Nerve Block", complications: "Bleeding",
  procedures: [{ tooth: "46", procedure: "Access opening", notes: "MB2 found" }, { procedure: "Rinse" }],
  postop: "Soft diet", recorded_by: "Dr Hana",
});

function card(exams: Exam[] | Promise<never>, { editable = true, bare = false } = {}) {
  if (exams instanceof Promise) api.listExams.mockReturnValue(exams);
  else api.listExams.mockResolvedValue({ items: exams });
  return renderUI(<ExaminationCard patientId={PID} editable={editable} bare={bare} />);
}

const btn = (name: string | RegExp) => screen.getByRole("button", { name });
const complaint = () => screen.getByPlaceholderText(/Pain in lower right back tooth/);

/** Pick from a Radix select, identified by the text its trigger shows now. */
async function pick(user: ReturnType<typeof renderUI>["user"], showing: string, option: string) {
  const trigger = screen.getAllByRole("combobox").find((c) => c.textContent === showing)!;
  await user.click(trigger);
  await user.click(await screen.findByRole("option", { name: option }));
}

describe("REG-FE-EXAM the examination card", () => {
  beforeEach(() => {
    Object.values(api).forEach((f) => f.mockReset());
    Object.values(tst).forEach((f) => f.mockReset());
    printer.printExamination.mockReset();
    auth.activeBranchId = null;
    net.branches = [];
  });

  test("REG-FE-EXAM-016 loading: a skeleton, not the empty state", () => {
    card(new Promise<never>(() => {}));
    expect(screen.queryByText("Clinical examinations")).not.toBeInTheDocument();
    expect(screen.queryByText("No examination on record")).not.toBeInTheDocument();
  });

  test("REG-FE-EXAM-017 empty: explains what an examination is for and offers New examination to an editor", async () => {
    card([]);
    expect(await screen.findByText("No examination on record")).toBeInTheDocument();
    expect(screen.getByText(/An examination records why/)).toBeInTheDocument();
    expect(btn(/New examination/)).toBeInTheDocument();
    expect(api.listExams).toHaveBeenCalledWith(PID);
  });

  test("REG-FE-EXAM-018 read-only: no New examination, and an opened record offers Print but not Edit or Remove", async () => {
    const { user } = card([FULL], { editable: false });
    await user.click(await screen.findByRole("button", { name: /Irreversible pulpitis/ }));
    expect(screen.queryByRole("button", { name: /New examination/ })).not.toBeInTheDocument();
    expect(btn(/Print/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Edit/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Remove/ })).not.toBeInTheDocument();
  });

  test("REG-FE-EXAM-019 collapsed row: count badge, headline, both calendars, treatment chips, examiner", async () => {
    card([FULL, E("ex2", { chief_complaint: "Checkup", visit_date: "2026-07-01" })], { bare: true });
    const row = await screen.findByRole("button", { name: /Irreversible pulpitis/ });
    expect(row).toHaveAttribute("aria-expanded", "false");
    expect(within(row).getByText(/^2026-08-12 · /)).toBeInTheDocument();
    expect(within(row).getByText("Root Canal Treatment")).toBeInTheDocument();
    expect(within(row).getByText("Suturing")).toBeInTheDocument();
    expect(within(row).getByText("Examined by Dr Hana")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Checkup/ })).toBeInTheDocument();
    expect(screen.getByText("2")).toBeInTheDocument(); // the count badge
  });

  test("REG-FE-EXAM-020 opened: diagnosis first, then the four groups with every field", async () => {
    const { user } = card([FULL]);
    const row = await screen.findByRole("button", { name: /Irreversible pulpitis/ });
    await user.click(row);
    expect(row).toHaveAttribute("aria-expanded", "true");
    expect(within(row).getByText("· examined by Dr Hana")).toBeInTheDocument();
    expect(screen.getByText("Diagnosis")).toBeInTheDocument();
    for (const g of ["Why they came", "What we found", "What we did", "What happens next"]) {
      expect(screen.getByRole("heading", { name: g })).toBeInTheDocument();
    }
    for (const t of ["Pain lower right", "Three days", "Filling 2024", "No swelling", "Deep caries", "PA lesion on 46",
      "RCT then crown", "Soft diet", "Nerve Block", "Bleeding", "Access opening", "MB2 found", "Rinse",
      "Within normal limits", "Caries present", "Periapical X-ray"]) {
      expect(screen.getByText(t)).toBeInTheDocument();
    }
    // A per-tooth row without a tooth shows a dash in the tooth column.
    expect(screen.getByText("46")).toBeInTheDocument();
    expect(screen.getByText("—")).toBeInTheDocument();
    // Abnormal findings stand out; reassuring ones stay quiet.
    expect(screen.getByText("Caries present").className).toMatch(/amber/);
    expect(screen.getByText("Within normal limits").className).not.toMatch(/amber/);
    await user.click(row);
    expect(row).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByText("Soft diet")).not.toBeInTheDocument();
  });

  test("REG-FE-EXAM-021 opened, sparse: empty groups are left out, and None anaesthesia is not shown", async () => {
    const { user } = card([E("ex1", { chief_complaint: "Checkup", anaesthesia: "None" })]);
    await user.click(await screen.findByRole("button", { name: /Checkup/ }));
    expect(screen.getByRole("heading", { name: "Why they came" })).toBeInTheDocument();
    for (const g of ["What we found", "What we did", "What happens next"]) {
      expect(screen.queryByRole("heading", { name: g })).not.toBeInTheDocument();
    }
    expect(screen.queryByText("Diagnosis")).not.toBeInTheDocument();
    expect(screen.queryByText("Anaesthesia")).not.toBeInTheDocument();
  });

  test("REG-FE-EXAM-022 a record with nothing written is headed Examination, and treatment alone heads it", async () => {
    card([E("ex1"), E("ex2", { treatment_given: ["Extraction"] })]);
    expect(await screen.findByRole("button", { name: /^Examination/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Extraction/ })).toBeInTheDocument();
  });

  test("REG-FE-EXAM-023 Print hands the exam, clinic, patient, MRN, age, gender and branch contact to the printer", async () => {
    auth.activeBranchId = "br_1";
    net.branches = [{ id: "br_1", name: "Main", address: "Bole Rd", phone: "0911" }, { id: "br_2", name: "Other" }];
    const { user } = card([FULL]);
    await user.click(await screen.findByRole("button", { name: /Irreversible pulpitis/ }));
    // Let the clinic / branches / patient queries settle before printing.
    await waitFor(() => expect(api.listExams).toHaveBeenCalled());
    await act(async () => { await new Promise((r) => setTimeout(r, 20)); });
    await user.click(btn(/Print/));
    const age = Math.floor((Date.now() - new Date("1990-01-01").getTime()) / 31557600000);
    expect(printer.printExamination).toHaveBeenCalledWith({
      clinic: "Test Clinic", clinicContact: "Bole Rd · 0911", patient: "Test Patient", mrn: "MRN-1",
      age, gender: "female", exam: FULL,
    });
  });

  test("REG-FE-EXAM-024 Print at a branch with no address or phone sends no contact line", async () => {
    auth.activeBranchId = "br_2";
    net.branches = [{ id: "br_2", name: "Other", address: "", phone: "" }];
    const { user } = card([FULL]);
    await user.click(await screen.findByRole("button", { name: /Irreversible pulpitis/ }));
    await act(async () => { await new Promise((r) => setTimeout(r, 20)); });
    await user.click(btn(/Print/));
    expect(printer.printExamination.mock.calls[0][0].clinicContact).toBeUndefined();
  });

  test("REG-FE-EXAM-025 Remove asks first; Keep backs out without deleting", async () => {
    const { user } = card([FULL]);
    await user.click(await screen.findByRole("button", { name: /Irreversible pulpitis/ }));
    await user.click(btn(/Remove/));
    expect(screen.getByText("Remove this examination?")).toBeInTheDocument();
    await user.click(btn("Keep"));
    expect(screen.queryByText("Remove this examination?")).not.toBeInTheDocument();
    expect(api.deleteExam).not.toHaveBeenCalled();
  });

  test("REG-FE-EXAM-026 Remove confirmed: deletes that exam, says so, and reloads the list", async () => {
    api.deleteExam.mockResolvedValue(undefined);
    const { user } = card([FULL]);
    await user.click(await screen.findByRole("button", { name: /Irreversible pulpitis/ }));
    await user.click(btn(/Remove/));
    await user.click(btn("Remove"));
    await waitFor(() => expect(api.deleteExam).toHaveBeenCalledWith(PID, "ex1"));
    await waitFor(() => expect(tst.success).toHaveBeenCalledWith("Examination removed"));
    await waitFor(() => expect(api.listExams).toHaveBeenCalledTimes(2));
  });

  test("REG-FE-EXAM-027 Remove failing: the server's message, or a plain one, and the confirm button is off while pending", async () => {
    let reject!: (e: unknown) => void;
    api.deleteExam.mockReturnValueOnce(new Promise((_r, j) => { reject = j; }));
    const { user } = card([FULL]);
    await user.click(await screen.findByRole("button", { name: /Irreversible pulpitis/ }));
    await user.click(btn(/Remove/));
    await user.click(btn("Remove"));
    await waitFor(() => expect(btn("Remove")).toBeDisabled());
    await act(async () => reject(new AppError(403, "forbidden", "Not allowed to remove")));
    await waitFor(() => expect(tst.error).toHaveBeenCalledWith("Not allowed to remove"));
    api.deleteExam.mockRejectedValueOnce(new Error("boom"));
    await user.click(btn("Remove"));
    await waitFor(() => expect(tst.error).toHaveBeenCalledWith("Could not remove"));
  });

  test("REG-FE-EXAM-028 New examination opens a blank form dated today and hides the empty state", async () => {
    const { user } = card([]);
    await user.click(await screen.findByRole("button", { name: /New examination/ }));
    expect(screen.queryByText("No examination on record")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /New examination/ })).not.toBeInTheDocument();
    expect(complaint()).toHaveValue("");
    expect(btn("Record examination")).toBeEnabled();
    for (const s of ["Presenting complaint", "Extraoral examination", "Intraoral examination", "Investigations",
      "Assessment", "Treatment given this visit", "Post-operative instructions"]) {
      expect(screen.getByRole("heading", { name: s })).toBeInTheDocument();
    }
    // Either Cancel (top or bottom) closes it.
    await user.click(screen.getAllByRole("button", { name: /Cancel/ })[0]);
    expect(screen.getByText("No examination on record")).toBeInTheDocument();
    await user.click(btn(/New examination/));
    await user.click(screen.getAllByRole("button", { name: /Cancel/ })[1]);
    expect(screen.queryByRole("button", { name: "Record examination" })).not.toBeInTheDocument();
  });

  test("REG-FE-EXAM-029 saving a blank form is refused with a message and sends nothing", async () => {
    const { user } = card([]);
    await user.click(await screen.findByRole("button", { name: /New examination/ }));
    await user.click(btn("Record examination"));
    expect(tst.error).toHaveBeenCalledWith("Nothing to record yet — add at least a complaint or a finding.");
    expect(api.createExam).not.toHaveBeenCalled();
  });

  test("REG-FE-EXAM-030 a filled form sends every field, drops the empty tooth row, and closes on success", async () => {
    api.createExam.mockResolvedValue(E("new"));
    const { user } = card([]);
    await user.click(await screen.findByRole("button", { name: /New examination/ }));

    // The visit date, entered in the Gregorian calendar.
    await user.click(btn("Gregorian"));
    fireEvent.change(document.querySelector('input[type="date"]')!, { target: { value: "2026-08-01" } });

    fireEvent.change(complaint(), { target: { value: "Pain lower right" } });
    fireEvent.change(screen.getByPlaceholderText(/Onset, duration/), { target: { value: "Three days" } });
    const [pastDental] = screen.getAllByRole("textbox").filter((t) => t.getAttribute("rows") === "2" && !t.getAttribute("placeholder"));
    fireEvent.change(pastDental, { target: { value: "Filling 2024" } });
    const [extraNotes, intraNotes] = screen.getAllByPlaceholderText("Findings");
    fireEvent.change(extraNotes, { target: { value: "No swelling" } });
    fireEvent.change(intraNotes, { target: { value: "Deep caries" } });
    fireEvent.change(screen.getByPlaceholderText("Results"), { target: { value: "PA lesion" } });
    fireEvent.change(screen.getByPlaceholderText(/Irreversible pulpitis — 46/), { target: { value: "Pulpitis 46" } });
    const plan = screen.getAllByRole("textbox").find((t) => t.getAttribute("rows") === "3" && !t.getAttribute("placeholder"))!;
    fireEvent.change(plan, { target: { value: "RCT" } });
    fireEvent.change(screen.getByPlaceholderText("None"), { target: { value: "Bleeding" } });
    fireEvent.change(screen.getByPlaceholderText(/avoid chewing/), { target: { value: "Soft diet" } });

    // Chips: the exclusive extraoral option clears a finding; toggling twice removes.
    await user.click(btn("Facial asymmetry"));
    await user.click(btn("Within normal limits"));
    expect(btn("Facial asymmetry")).toHaveAttribute("aria-pressed", "false");
    expect(btn("Within normal limits")).toHaveAttribute("aria-pressed", "true");
    await user.click(btn("Caries present"));
    await user.click(btn("Halitosis"));
    await user.click(btn("Halitosis"));
    await user.click(btn("Bitewing X-ray"));
    await user.click(btn("Root Canal Treatment"));

    await pick(user, "None", "Nerve Block");

    // The tooth table: a filled row grows a new blank one; a row can be removed.
    await pick(user, "Tooth", "UR6");
    fireEvent.change(screen.getAllByPlaceholderText("Procedure / material used")[0], { target: { value: "Access opening" } });
    fireEvent.change(screen.getAllByPlaceholderText("Notes")[0], { target: { value: "MB2" } });
    expect(screen.getAllByPlaceholderText("Procedure / material used")).toHaveLength(2);
    fireEvent.change(screen.getAllByPlaceholderText("Procedure / material used")[1], { target: { value: "Temp filling" } });
    expect(screen.getAllByRole("button", { name: "Remove row" })).toHaveLength(2);
    await user.click(screen.getAllByRole("button", { name: "Remove row" })[1]);
    expect(screen.getAllByPlaceholderText("Procedure / material used")).toHaveLength(2);

    await user.click(btn("Record examination"));
    await waitFor(() => expect(api.createExam).toHaveBeenCalledTimes(1));
    expect(api.createExam).toHaveBeenCalledWith(PID, {
      visit_date: "2026-08-01", chief_complaint: "Pain lower right", hpi: "Three days", past_dental_history: "Filling 2024",
      extraoral: ["Within normal limits"], extraoral_notes: "No swelling", intraoral: ["Caries present"], intraoral_notes: "Deep caries",
      investigations: ["Bitewing X-ray"], investigation_results: "PA lesion", diagnosis: "Pulpitis 46", treatment_plan: "RCT",
      treatment_given: ["Root Canal Treatment"], anaesthesia: "Nerve Block", complications: "Bleeding",
      procedures: [{ tooth: "UR6", procedure: "Access opening", notes: "MB2" }], postop: "Soft diet",
    });
    await waitFor(() => expect(tst.success).toHaveBeenCalledWith("Examination recorded"));
    await waitFor(() => expect(screen.queryByRole("button", { name: "Record examination" })).not.toBeInTheDocument());
    expect(api.listExams).toHaveBeenCalledTimes(2);
  }, 20000);

  test("REG-FE-EXAM-031 while saving the button reads Saving… and is disabled; a failure keeps the form and says why", async () => {
    let reject!: (e: unknown) => void;
    api.createExam.mockReturnValueOnce(new Promise((_r, j) => { reject = j; }));
    const { user } = card([]);
    await user.click(await screen.findByRole("button", { name: /New examination/ }));
    fireEvent.change(complaint(), { target: { value: "Pain" } });
    await user.click(btn("Record examination"));
    expect(await screen.findByRole("button", { name: "Saving…" })).toBeDisabled();
    await act(async () => reject(new AppError(422, "invalid", "visit_date is required")));
    await waitFor(() => expect(tst.error).toHaveBeenCalledWith("visit_date is required"));
    expect(complaint()).toHaveValue("Pain");
    api.createExam.mockRejectedValueOnce(new Error("network"));
    await user.click(btn("Record examination"));
    await waitFor(() => expect(tst.error).toHaveBeenCalledWith("Could not save"));
    expect(api.createExam).toHaveBeenCalledTimes(2);
  });

  test("REG-FE-EXAM-032 Edit opens the record prefilled; Save changes PUTs the whole document without its metadata", async () => {
    api.updateExam.mockResolvedValue(FULL);
    const { user } = card([FULL]);
    await user.click(await screen.findByRole("button", { name: /Irreversible pulpitis/ }));
    await user.click(btn(/Edit/));
    expect(complaint()).toHaveValue("Pain lower right");
    expect(btn("Root Canal Treatment")).toHaveAttribute("aria-pressed", "true");
    expect(screen.getAllByPlaceholderText("Procedure / material used")[0]).toHaveValue("Access opening");
    fireEvent.change(screen.getByPlaceholderText(/Irreversible pulpitis — 46/), { target: { value: "Necrotic pulp — 46" } });
    await user.click(btn("Save changes"));
    await waitFor(() => expect(api.updateExam).toHaveBeenCalledTimes(1));
    const [pid, id, body] = api.updateExam.mock.calls[0];
    expect([pid, id]).toEqual([PID, "ex1"]);
    expect(body).not.toHaveProperty("id");
    expect(body).not.toHaveProperty("recorded_by");
    expect(body).not.toHaveProperty("created_at");
    expect(body).not.toHaveProperty("updated_at");
    expect(body).toMatchObject({ diagnosis: "Necrotic pulp — 46", chief_complaint: "Pain lower right", anaesthesia: "Nerve Block",
      procedures: [{ tooth: "46", procedure: "Access opening", notes: "MB2 found" }, { procedure: "Rinse" }] });
    await waitFor(() => expect(tst.success).toHaveBeenCalledWith("Examination updated"));
    await waitFor(() => expect(screen.queryByRole("button", { name: "Save changes" })).not.toBeInTheDocument());
  });

  test("REG-FE-EXAM-033 an old record with no anaesthesia edits as None; Cancel puts the row back", async () => {
    const { user } = card([E("ex1", { chief_complaint: "Old", anaesthesia: "" })]);
    await user.click(await screen.findByRole("button", { name: /Old/ }));
    await user.click(btn(/Edit/));
    expect(screen.getAllByRole("combobox").some((c) => c.textContent === "None")).toBe(true);
    await user.click(screen.getAllByRole("button", { name: /Cancel/ })[0]);
    expect(screen.getByRole("button", { name: /Old/ })).toBeInTheDocument();
    expect(api.updateExam).not.toHaveBeenCalled();
  });

  test.fails("REG-FE-EXAM-034 KNOWN BUG FE-2 Cancel on a half-written examination asks first or keeps the draft", async () => {
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
    const { user } = card([]);
    await user.click(await screen.findByRole("button", { name: /New examination/ }));
    fireEvent.change(complaint(), { target: { value: "Swelling for a week" } });
    await user.click(screen.getAllByRole("button", { name: /Cancel/ })[0]);
    // Correct: either the dentist was asked (and said no, so the form stays), or
    // reopening the form brings back what they typed.
    const asked = confirm.mock.calls.length > 0 || screen.queryByRole("alertdialog") != null;
    if (!asked) await user.click(btn(/New examination/));
    expect(complaint()).toHaveValue("Swelling for a week");
  });

  test.fails("REG-FE-EXAM-035 KNOWN BUG FE-2 opening another record's Edit does not silently throw away a new examination", async () => {
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
    const { user } = card([FULL]);
    await user.click(await screen.findByRole("button", { name: /New examination/ }));
    fireEvent.change(complaint(), { target: { value: "Swelling for a week" } });
    await user.click(screen.getByRole("button", { name: /Irreversible pulpitis/ }));
    await user.click(btn(/Edit/));
    const asked = confirm.mock.calls.length > 0 || screen.queryByRole("alertdialog") != null;
    expect(asked || screen.getAllByPlaceholderText(/Pain in lower right back tooth/).some((i) => (i as HTMLInputElement).value === "Swelling for a week")).toBe(true);
  });

  test.fails("REG-FE-EXAM-036 KNOWN BUG NEW-EXAM-1 a failed load says so, instead of claiming there is no examination", async () => {
    card(Promise.reject(new Error("network")) as Promise<never>);
    await waitFor(() => expect(api.listExams).toHaveBeenCalled());
    await act(async () => { await new Promise((r) => setTimeout(r, 20)); });
    expect(screen.queryByText("No examination on record")).not.toBeInTheDocument();
    expect(screen.getByRole("alert")).toBeInTheDocument();
  });
});
