// The triage desk (/triage — hidden from the dental menu, still reachable by URL).
// What a clinic relies on: the department defaults to one in the active branch;
// patients split into "Awaiting vitals" / "Ready for doctor" / "Sent to doctor";
// recording vitals sends only the clinic's enabled fields as numbers, refuses
// implausible values and blank required ones, flags low/high against the reference
// range, and prefills when editing; a patient can only be sent to a doctor once
// vitals exist, and the assignment names that doctor; maternity clinics see dating.
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, test, vi } from "vitest";

vi.mock("@/lib/api-client", async (orig) => ({ ...(await orig<object>()), ...(await import("@/test/frontdesk")).apiModule }));
vi.mock("@/app/auth-context", async () => (await import("@/test/frontdesk")).authModule);
vi.mock("@/components/ui/sonner", async (orig) => ({ ...(await orig<object>()), toast: (await import("@/test/frontdesk")).toastSpy }));
vi.mock("@/features/maternity/PregnancyCalculator", () => ({
  PregnancyDatingDialog: ({ patientId, onOpenChange, onSaved }: { patientId: string; onOpenChange: (o: boolean) => void; onSaved: () => void }) => (
    <div role="dialog" aria-label="dating">
      dating for {patientId}
      <button onClick={() => { onSaved(); onOpenChange(false); }}>save dating</button>
    </div>
  ),
}));
vi.mock("@/features/clinical/components/DictateButton", () => ({
  DictateButton: ({ onText }: { onText: (t: string) => void }) => <button type="button" onClick={() => onText("spoken words")}>Dictate</button>,
}));

import { TriagePage } from "@/features/scheduling/pages/TriagePage";
import type { QueueEntry } from "@/features/scheduling/api";
import type { VitalField } from "@/features/clinical/api";
import { fail, fake, hang, resetToasts, setAuth, toasts, type Req } from "@/test/frontdesk";
import { renderUI } from "@/test/render";

const minsAgo = (m: number) => new Date(Date.now() - m * 60_000).toISOString();
const entry = (id: string, over: Partial<QueueEntry> = {}): QueueEntry => ({
  id, patient_id: `p_${id}`, state: "waiting", stage: "triage", priority: 0, enqueued_at: minsAgo(7),
  patient_name: `Patient ${id}`, mrn: `MRN-${id}`, has_vitals: false, in_lab: false, ...over,
});
const vf = (key: string, over: Partial<VitalField> = {}): VitalField => ({
  key, label: key.toUpperCase(), unit: "", decimals: 0, enabled: true, required: false, order: 1, ...over,
});
const FIELDS: VitalField[] = [
  vf("temperature_c", { label: "Temp", unit: "°C", decimals: 1, order: 2, min: 30, max: 45, low: 36, high: 37.5, required: true }),
  vf("pulse_bpm", { label: "Pulse", unit: "bpm", order: 1, min: 20, max: 250 }),
  vf("spo2_pct", { label: "SpO2", enabled: false, order: 3 }),
];

function serveQueue(triage: QueueEntry[], withDoctor: QueueEntry[] = []) {
  fake.on("GET", "/queue", (r: Req) => (r.query.get("stage") === "with_doctor" ? withDoctor : triage));
}

beforeEach(() => {
  fake.reset();
  resetToasts();
  setAuth({ perms: ["triage.manage", "queue.manage"], flags: [] });
  fake.on("GET", "/org/branches", [{ id: "br_main", name: "Main" }]);
  fake.on("GET", "/org/departments", [
    { id: "dep_other", name: "Other branch OPD", branch_id: "br_2" },
    { id: "dep_opd", name: "OPD", branch_id: "br_main" },
    { id: "dep_peds", name: "Paediatrics", branch_id: "br_main" },
  ]);
  fake.on("GET", "/vital-fields", FIELDS);
  fake.on("GET", "/providers", [{ id: "usr_doc", full_name: "Dr Hana" }, { id: "usr_doc2", full_name: "Dr Yonas" }]);
  serveQueue([]);
});

const triageCalls = () => fake.sent("GET", "/queue").filter((r) => r.query.get("stage") === "triage");

describe("REG-FE-TRIAGE the triage desk", () => {
  test("REG-FE-TRIAGE-001 defaults to the active branch's first department; empty lists say so", async () => {
    const { user } = renderUI(<TriagePage />);
    expect(await screen.findByText("No patients waiting for vitals.")).toBeInTheDocument();
    expect(triageCalls()[0].query.get("department")).toBe("dep_opd");
    await user.click(screen.getByRole("combobox"));
    expect(screen.queryByRole("option", { name: "Other branch OPD" })).not.toBeInTheDocument();
    await user.click(screen.getByRole("option", { name: "Paediatrics" }));
    await waitFor(() => expect(triageCalls().at(-1)!.query.get("department")).toBe("dep_peds"));
    await user.click(screen.getByRole("button", { name: /Ready for doctor/ }));
    expect(screen.getByText("No patients ready for a doctor yet — record vitals first.")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /Sent to doctor/ }));
    expect(screen.getByText("No patients sent to a doctor in this range.")).toBeInTheDocument();
  });

  test("REG-FE-TRIAGE-002 no department in this branch: asks to select one, loads no queue", async () => {
    fake.on("GET", "/org/departments", [{ id: "dep_other", name: "Elsewhere", branch_id: "br_2" }]);
    const { user } = renderUI(<TriagePage />);
    expect(await screen.findByText("Select a department.")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /Sent to doctor/ }));
    expect(screen.getByText("Select a department.")).toBeInTheDocument();
    expect(fake.sent("GET", "/queue")).toHaveLength(0);
  });

  test("REG-FE-TRIAGE-003 patients split by whether vitals are recorded; only ready ones can be assigned", async () => {
    serveQueue([entry("a"), entry("b", { has_vitals: true })]);
    const { user } = renderUI(<TriagePage />);
    expect(await screen.findByText("Patient a")).toBeInTheDocument();
    expect(screen.getByText("Vitals pending")).toBeInTheDocument();
    expect(screen.getByText("7m")).toBeInTheDocument();
    expect(screen.queryByText("Patient b")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Assign/ })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Awaiting vitals\s*1/ })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /Ready for doctor\s*1/ }));
    expect(screen.getByText("Patient b")).toBeInTheDocument();
    expect(screen.getByText("Vitals recorded")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Edit vitals/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Assign/ })).toBeDisabled();
  });

  test("REG-FE-TRIAGE-004 sending a patient to a doctor names that doctor and refreshes the lists", async () => {
    serveQueue([entry("b", { has_vitals: true })]);
    const { user } = renderUI(<TriagePage />);
    await user.click(await screen.findByRole("button", { name: /Ready for doctor/ }));
    await user.click(screen.getAllByRole("combobox")[1]);
    await user.click(await screen.findByRole("option", { name: "Dr Yonas" }));
    const before = triageCalls().length;
    await user.click(screen.getByRole("button", { name: /Assign/ }));
    await waitFor(() => expect(toasts("success")).toEqual(["Assigned to doctor"]));
    expect(fake.lastBody("POST", "/queue/b/assign")).toEqual({ provider_id: "usr_doc2" });
    await waitFor(() => expect(triageCalls().length).toBeGreaterThan(before));
  });

  test("REG-FE-TRIAGE-005 a refused assignment shows the reason", async () => {
    serveQueue([entry("b", { has_vitals: true })]);
    fake.on("POST", "/queue/b/assign", fail(409, "Vitals are required first"));
    const { user } = renderUI(<TriagePage />);
    await user.click(await screen.findByRole("button", { name: /Ready for doctor/ }));
    await user.click(screen.getAllByRole("combobox")[1]);
    await user.click(await screen.findByRole("option", { name: "Dr Hana" }));
    await user.click(screen.getByRole("button", { name: /Assign/ }));
    await waitFor(() => expect(toasts("error")).toEqual(["Vitals are required first"]));
  });

  test("REG-FE-TRIAGE-006 no doctors set up: the picker says so", async () => {
    fake.on("GET", "/providers", []);
    serveQueue([entry("b", { has_vitals: true })]);
    const { user } = renderUI(<TriagePage />);
    await user.click(await screen.findByRole("button", { name: /Ready for doctor/ }));
    expect(await screen.findByText("No doctors available")).toBeInTheDocument();
  });

  test("REG-FE-TRIAGE-007 Sent to doctor keeps the trail: doctor and state for each patient", async () => {
    serveQueue([], [
      entry("x", { state: "waiting", provider_name: "Dr Hana" }),
      entry("y", { state: "in_consult" }),
      entry("z", { state: "done" }),
      entry("n", { state: "no_show" }),
      entry("c", { state: "called" }),
      entry("q", { state: "odd_state" }),
    ]);
    const { user } = renderUI(<TriagePage />);
    await user.click(await screen.findByRole("button", { name: /Sent to doctor\s*6/ }));
    expect(screen.getByText("Dr Hana")).toBeInTheDocument();
    for (const t of ["Waiting for doctor", "In consultation", "Seen", "No-show", "Called", "odd_state"]) {
      expect(screen.getByText(t)).toBeInTheDocument();
    }
    expect(fake.sent("GET", "/queue").some((r) => r.query.get("stage") === "with_doctor")).toBe(true);
  });
});

describe("REG-FE-TRIAGE recording vitals", () => {
  async function openVitals(e: QueueEntry = entry("a")) {
    serveQueue([e]);
    const r = renderUI(<TriagePage />);
    if (e.has_vitals) await r.user.click(await screen.findByRole("button", { name: /Ready for doctor/ }));
    await r.user.click(await screen.findByRole("button", { name: e.has_vitals ? /Edit vitals/ : /Record vitals/ }));
    const dlg = await screen.findByRole("dialog");
    await within(dlg).findByText("Temp");
    return { ...r, dlg };
  }
  const input = (dlg: HTMLElement, label: string) =>
    within(dlg).getByText(label).closest("div.space-y-1\\.5")!.querySelector("input") as HTMLInputElement;

  test("REG-FE-TRIAGE-008 only enabled fields, in the clinic's order; a required blank blocks Save", async () => {
    const { dlg } = await openVitals();
    expect(within(dlg).getByText("Vitals · Patient a")).toBeInTheDocument();
    const labels = [...dlg.querySelectorAll("label > span:first-child")].map((s) => s.textContent?.split(" ")[0]);
    expect(labels.slice(0, 2)).toEqual(["Pulse", "Temp"]);
    expect(within(dlg).queryByText("SpO2")).not.toBeInTheDocument();
    expect(within(dlg).getByRole("button", { name: "Save vitals" })).toBeDisabled();
  });

  test("REG-FE-TRIAGE-009 implausible values are refused; reference flags show Low/Normal/High", async () => {
    const { user, dlg } = await openVitals();
    const temp = input(dlg, "Temp");
    await user.type(temp, "50");
    expect(within(dlg).getByText("Above max 45")).toBeInTheDocument();
    expect(within(dlg).getByRole("button", { name: "Save vitals" })).toBeDisabled();
    await user.clear(temp);
    await user.type(temp, "20");
    expect(within(dlg).getByText("Below min 30")).toBeInTheDocument();
    await user.clear(temp);
    await user.type(temp, "35");
    expect(within(dlg).getByText("Low")).toBeInTheDocument();
    await user.clear(temp);
    await user.type(temp, "39");
    expect(within(dlg).getByText("High")).toBeInTheDocument();
    await user.clear(temp);
    await user.type(temp, "36.8");
    expect(within(dlg).getByText("Normal")).toBeInTheDocument();
    expect(within(dlg).getByRole("button", { name: "Save vitals" })).toBeEnabled();
  });

  test("REG-FE-TRIAGE-010 saving sends numbers for the filled fields, the branch, department and notes; moves to Ready", async () => {
    const { user, dlg } = await openVitals();
    await user.type(input(dlg, "Temp"), "37.2");
    await user.type(input(dlg, "Pulse"), "88");
    await user.type(within(dlg).getByPlaceholderText("Triage notes"), "Febrile");
    await user.click(within(dlg).getByRole("button", { name: "Dictate" }));
    expect(within(dlg).getByPlaceholderText("Triage notes")).toHaveValue("Febrile spoken words");
    serveQueue([entry("a", { has_vitals: true })]);
    await user.click(within(dlg).getByRole("button", { name: "Save vitals" }));
    await waitFor(() => expect(toasts("success")).toEqual(["Vitals recorded"]));
    const req = fake.sent("POST", "/visits/a/vitals")[0];
    expect(req.query.get("patient")).toBe("p_a");
    expect(req.body).toEqual({ branch_id: "br_main", department_id: "dep_opd", notes: "Febrile spoken words", temperature_c: 37.2, pulse_bpm: 88 });
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(await screen.findByText("Vitals recorded")).toBeInTheDocument();
  });

  test("REG-FE-TRIAGE-011 dictation into empty notes starts the note", async () => {
    const { user, dlg } = await openVitals();
    await user.click(within(dlg).getByRole("button", { name: "Dictate" }));
    expect(within(dlg).getByPlaceholderText("Triage notes")).toHaveValue("spoken words");
  });

  test("REG-FE-TRIAGE-012 a refused save shows the reason and keeps the dialog", async () => {
    fake.on("POST", "/visits/:id/vitals", fail(422, "Temperature out of range"));
    const { user, dlg } = await openVitals();
    await user.type(input(dlg, "Temp"), "37");
    await user.click(within(dlg).getByRole("button", { name: "Save vitals" }));
    await waitFor(() => expect(toasts("error")).toEqual(["Temperature out of range"]));
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    await user.click(within(dlg).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
  });

  test("REG-FE-TRIAGE-013 editing prefills the last reading and its notes", async () => {
    fake.on("GET", "/visits/b", { vitals: [{ temperature_c: 38.1, pulse_bpm: null, notes: "Earlier note" }] });
    const { dlg } = await openVitals(entry("b", { has_vitals: true }));
    await waitFor(() => expect(input(dlg, "Temp")).toHaveValue(38.1));
    expect(input(dlg, "Pulse")).toHaveValue(null);
    expect(within(dlg).getByPlaceholderText("Triage notes")).toHaveValue("Earlier note");
  });

  test("REG-FE-TRIAGE-014 editing with no stored reading starts blank; loading says so", async () => {
    fake.on("GET", "/visits/b", hang);
    const { dlg } = await openVitals(entry("b", { has_vitals: true }));
    expect(within(dlg).getByText("Loading the current reading…")).toBeInTheDocument();
  });

  test("REG-FE-TRIAGE-015 editing a visit with no vitals array leaves the form blank", async () => {
    fake.on("GET", "/visits/b", { vitals: [] });
    const { dlg } = await openVitals(entry("b", { has_vitals: true }));
    await new Promise((r) => setTimeout(r, 30));
    expect(input(dlg, "Temp")).toHaveValue(null);
    expect(within(dlg).getByPlaceholderText("Triage notes")).toHaveValue("");
  });

  test("REG-FE-TRIAGE-016 a non-number in a field is refused", async () => {
    const { dlg } = await openVitals();
    const t = input(dlg, "Temp");
    // A browser's number input can hold text a pasted value left behind; jsdom
    // sanitises it away, so the input's value is pinned for this check.
    Object.defineProperty(t, "value", { configurable: true, get: () => "abc", set: () => {} });
    fireEvent.change(t, { target: { value: "abc" } });
    expect(within(dlg).getByText("Enter a number")).toBeInTheDocument();
  });

  test("REG-FE-TRIAGE-017 a clinic with no vitals form configured cannot save", async () => {
    fake.on("GET", "/vital-fields", []);
    serveQueue([entry("a")]);
    const { user } = renderUI(<TriagePage />);
    await user.click(await screen.findByRole("button", { name: /Record vitals/ }));
    const dlg = await screen.findByRole("dialog");
    await new Promise((r) => setTimeout(r, 30));
    expect(within(dlg).getByRole("button", { name: "Save vitals" })).toBeDisabled();
  });
});

describe("REG-FE-TRIAGE maternity clinics", () => {
  test("REG-FE-TRIAGE-018 a recorded pregnancy shows GA and EDD on the row; Dating opens the calculator", async () => {
    setAuth({ perms: ["triage.manage"], flags: ["maternity"] });
    serveQueue([entry("a"), entry("b")]);
    fake.on("GET", "/dating/summary", { items: [{ patientId: "p_a", edd: "2027-03-15", gestationalAge: { label: "12w 3d" } }] });
    const { user } = renderUI(<TriagePage />);
    expect(await screen.findByText(/12w 3d · EDD/)).toBeInTheDocument();
    expect(fake.sent("GET", "/dating/summary")[0].query.get("patients")).toBe("p_a,p_b");
    expect(screen.getByRole("button", { name: /Update dating/ })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /^Dating$/ }));
    expect(screen.getByRole("dialog", { name: "dating" })).toHaveTextContent("dating for p_b");
    const before = fake.sent("GET", "/dating/summary").length;
    await user.click(screen.getByRole("button", { name: "save dating" }));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "dating" })).not.toBeInTheDocument());
    await waitFor(() => expect(fake.sent("GET", "/dating/summary").length).toBeGreaterThan(before));
  });

  test("REG-FE-TRIAGE-019 a clinic without maternity shows no dating at all", async () => {
    serveQueue([entry("a")]);
    renderUI(<TriagePage />);
    await screen.findByText("Patient a");
    expect(screen.queryByRole("button", { name: /Dating/ })).not.toBeInTheDocument();
    expect(fake.sent("GET", "/dating/summary")).toHaveLength(0);
  });
});
