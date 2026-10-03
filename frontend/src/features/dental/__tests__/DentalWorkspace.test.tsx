// The dental patient page around the visit card: loading and failure, the patient
// banner (allergies, owing, the links out), what a read-only viewer gets, and the
// record shelf — which panels each role sees, the ?panel= deep link, the money
// panel's numbers and the patient-level image gallery.
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

// These render the whole dental page and type into it; under a full parallel run
// (with coverage) a test can take longer than the 5 s default.
vi.setConfig({ testTimeout: 60_000 });

const api = vi.hoisted(() => ({
  dentalSummary: vi.fn(), createPlan: vi.fn(), saveChart: vi.fn(), listToothStatuses: vi.fn(),
  listDentalImages: vi.fn(), uploadDentalImage: vi.fn(), deleteDentalImage: vi.fn(),
}));
const patients = vi.hoisted(() => ({ getPatient: vi.fn() }));
const messaging = vi.hoisted(() => ({ messageLog: vi.fn() }));
const perms = vi.hoisted(() => ({ set: new Set<string>(["*"]) }));
const toast = vi.hoisted(() => Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn() }));

vi.mock("@/features/dental/api", async (orig) => ({ ...(await orig<object>()), ...api }));
vi.mock("@/features/patients/api", async (orig) => ({ ...(await orig<object>()), ...patients }));
vi.mock("@/features/messaging/api", async (orig) => ({ ...(await orig<object>()), ...messaging }));
vi.mock("@/components/ui/sonner", async (orig) => ({ ...(await orig<object>()), toast }));
vi.mock("@/lib/image", () => ({ compressImage: vi.fn(async (f: File) => f) }));
vi.mock("@/lib/api-client", async (orig) => {
  const { quietApiFetch } = await import("@/test/render");
  return { ...(await orig<object>()), apiFetch: vi.fn(quietApiFetch), apiList: vi.fn(async () => ({ items: [], meta: {} })) };
});
vi.mock("@/app/auth-context", () => ({
  useAuth: () => ({
    can: (p: string) => perms.set.has("*") || perms.set.has(p),
    flagOn: () => true, user: { id: "u1", full_name: "Dr Test" }, activeBranchId: null,
  }),
}));

import { DentalWorkspace } from "@/features/dental/DentalWorkspace";
import type { Summary, Plan } from "@/features/dental/api";
import { AppError } from "@/lib/api-client";
import { currentLocation, freezeToday, renderUI } from "@/test/render";
import { P, S } from "../visit/__tests__/fixtures";

const T = "2026-08-12";
const BAL = { owed: "0", paid: "0", balance: "0", due: "0", at_cashier: "0", waived: "0", overdue: false };
const summary = (plans: Plan[] = [], bal: Partial<typeof BAL> = {}, extra: Partial<Summary> = {}): Summary =>
  ({ chart: { teeth: {} }, plans, balance: { ...BAL, ...bal }, image_limit: -1, ...extra }) as unknown as Summary;
const patient = (extra: Record<string, unknown> = {}) => ({
  id: "pat_1", mrn: "MRN-42", first_name: "Abebe", middle_name: "Kebede", last_name: "Tesfaye", gender: "male",
  dob: "1990-01-01", phone: "0911223344", blood_group: "O+", allergies: [], conditions: [], attachments: [], guardians: [],
  created_at: "", ...extra,
});
const img = (id: string, filename = `${id}.jpg`) =>
  ({ id, url: `https://img/${id}`, filename, mime_type: "image/jpeg", size_bytes: 1, created_at: "" });

function page(opts: { route?: string } = {}) {
  return renderUI(<DentalWorkspace patientId="pat_1" />, { route: opts.route ?? "/patients/pat_1" });
}
const loaded = () => screen.findByRole("heading", { level: 2, name: "Abebe Kebede Tesfaye" });
const shelf = () => screen.getByRole("navigation", { name: "Patient record" });
const tab = (name: RegExp) => within(shelf()).getByRole("button", { name });

describe("REG-FE-WORKSPACE the dental patient page", () => {
  beforeEach(() => {
    freezeToday(T);
    sessionStorage.clear();
    window.history.replaceState({}, "", "/");
    perms.set = new Set(["*"]);
    [...Object.values(api), ...Object.values(patients), ...Object.values(messaging), toast, toast.success, toast.error]
      .forEach((f) => f.mockReset());
    api.dentalSummary.mockResolvedValue(summary());
    api.listToothStatuses.mockResolvedValue([]);
    api.listDentalImages.mockResolvedValue([]);
    api.saveChart.mockResolvedValue({ teeth: {} });
    patients.getPatient.mockResolvedValue(patient());
    messaging.messageLog.mockResolvedValue([]);
  });
  afterEach(() => vi.useRealTimers());

  test("REG-FE-WORKSPACE-019 while loading: skeletons, no banner", () => {
    patients.getPatient.mockReturnValue(new Promise(() => {}));
    const { container } = page();
    expect(container.querySelectorAll(".animate-pulse, [class*=skeleton]").length).toBeGreaterThan(0);
    expect(screen.queryByRole("heading", { level: 2 })).not.toBeInTheDocument();
  });

  test("REG-FE-WORKSPACE-020 the patient fails to load: says so, and Back to patients goes to the list", async () => {
    patients.getPatient.mockRejectedValue(new Error("down"));
    const { user } = page();
    expect(await screen.findByText("Could not load this patient.")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /Back to patients/ }));
    expect(currentLocation()).toBe("/patients");
  });

  test("REG-FE-WORKSPACE-021 the dental summary fails to load: the same error, not a half-drawn page", async () => {
    api.dentalSummary.mockRejectedValue(new Error("down"));
    page();
    expect(await screen.findByText("Could not load this patient.")).toBeInTheDocument();
    expect(screen.queryByRole("navigation", { name: "Patient record" })).not.toBeInTheDocument();
  });

  test("REG-FE-WORKSPACE-022 banner: full name, MRN, age, gender, phone as tel: link, blood group", async () => {
    page();
    await loaded();
    const mrn = screen.getByText(/^MRN MRN-42/);
    expect(mrn).toHaveTextContent("MRN MRN-42 · 36y · male · 0911223344 · O+");
    const tels = screen.getAllByRole("link", { name: /0911223344/ });
    expect(tels.length).toBe(2);
    tels.forEach((a) => expect(a).toHaveAttribute("href", "tel:0911223344"));
    expect(screen.getByText("AT")).toBeInTheDocument(); // initials
  });

  test("REG-FE-WORKSPACE-023 banner without phone, dob, gender: those parts are simply absent", async () => {
    patients.getPatient.mockResolvedValue(patient({ phone: "", dob: "", gender: "unknown", blood_group: "", middle_name: "" }));
    renderUI(<DentalWorkspace patientId="pat_1" />);
    await screen.findByRole("heading", { level: 2, name: "Abebe Tesfaye" });
    expect(screen.getByText(/^MRN MRN-42/).textContent).toBe("MRN MRN-42");
    expect(screen.queryByRole("link", { name: /09/ })).not.toBeInTheDocument();
  });

  test("REG-FE-WORKSPACE-024 links out: Patients, Schedule and On the calendar", async () => {
    const r1 = page();
    await loaded();
    await r1.user.click(screen.getByRole("button", { name: /Schedule/ }));
    expect(currentLocation()).toBe("/patients/pat_1/schedule");
    r1.unmount();
    const r2 = page();
    await loaded();
    await r2.user.click(screen.getByRole("button", { name: /On the calendar/ }));
    expect(currentLocation()).toBe("/appointments?patient=pat_1");
    r2.unmount();
    const r3 = page();
    await loaded();
    await r3.user.click(screen.getByRole("button", { name: /^Patients$/ }));
    expect(currentLocation()).toBe("/patients");
  });

  test("REG-FE-WORKSPACE-025 allergies are red pills on the banner and an editor's button reads Allergies", async () => {
    patients.getPatient.mockResolvedValue(patient({ allergies: [
      { id: "a1", substance: "Penicillin", severity: "severe", created_at: "" },
      { id: "a2", substance: "Latex", severity: "mild", created_at: "" },
    ] }));
    page();
    await loaded();
    expect(screen.getByText("Allergy: Penicillin")).toHaveClass("bg-destructive");
    expect(screen.getByText("Allergy: Latex")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^Allergies$/ })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Record allergies/ })).not.toBeInTheDocument();
    expect(screen.queryByText("No known allergies")).not.toBeInTheDocument();
  });

  test("REG-FE-WORKSPACE-026 an editor with none recorded gets Record allergies, which opens the allergy dialog", async () => {
    const { user } = page();
    await loaded();
    await user.click(screen.getByRole("button", { name: /Record allergies/ }));
    const dlg = await screen.findByRole("dialog", { name: "Allergies" });
    await user.click(within(dlg).getByRole("button", { name: "Done" }));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Allergies" })).not.toBeInTheDocument());
  });

  test("REG-FE-WORKSPACE-027 a viewer without dental.manage reads 'No known allergies' (stated, not blank) and cannot edit them", async () => {
    perms.set = new Set(["patient.read"]);
    page();
    await loaded();
    expect(screen.getByText("No known allergies")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Record allergies|^Allergies$/ })).not.toBeInTheDocument();
  });

  test("REG-FE-WORKSPACE-028 a viewer with allergies on file sees the pills but no edit button and no 'no known' label", async () => {
    perms.set = new Set(["patient.read"]);
    patients.getPatient.mockResolvedValue(patient({ allergies: [{ id: "a1", substance: "Latex", severity: "mild", created_at: "" }] }));
    page();
    await loaded();
    expect(screen.getByText("Allergy: Latex")).toBeInTheDocument();
    expect(screen.queryByText("No known allergies")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^Allergies$/ })).not.toBeInTheDocument();
  });

  test("REG-FE-WORKSPACE-029 Edit details only with patient.update, and it opens the patient editor", async () => {
    perms.set = new Set(["patient.update"]);
    const { user } = page();
    await loaded();
    await user.click(screen.getByRole("button", { name: /Edit details/ }));
    expect(await screen.findByRole("dialog", { name: "Edit patient details" })).toBeInTheDocument();
  });

  test("REG-FE-WORKSPACE-030 no patient.update: no Edit details button", async () => {
    perms.set = new Set(["dental.manage"]);
    page();
    await loaded();
    expect(screen.queryByRole("button", { name: /Edit details/ })).not.toBeInTheDocument();
  });

  test("REG-FE-WORKSPACE-031 an editor's shelf: timeline, treatments, chart, exams, images, certificates, messages, money", async () => {
    page();
    await loaded();
    const labels = within(shelf()).getAllByRole("button").map((b) => b.textContent?.replace(/\d+$/, ""));
    expect(labels).toEqual(["Timeline", "Treatments", "Tooth chart", "Examinations", "Images", "Certificates", "Messages", "Money"]);
    expect(tab(/^Timeline/)).toHaveAttribute("aria-current", "page");
    // The editor has the cockpit's start button; there is no desk strip.
    expect(screen.getByRole("button", { name: /start a treatment/i })).toBeInTheDocument();
  });

  test("REG-FE-WORKSPACE-032 a read-only viewer: no chart, exams or images, no messages without the permission, no start button", async () => {
    perms.set = new Set(["patient.read"]);
    page();
    await loaded();
    const labels = within(shelf()).getAllByRole("button").map((b) => b.textContent?.replace(/\d+$/, ""));
    expect(labels).toEqual(["Timeline", "Treatments", "Certificates", "Money"]);
    expect(screen.queryByRole("button", { name: /start a treatment/i })).not.toBeInTheDocument();
    expect(messaging.messageLog).not.toHaveBeenCalled();
  });

  test("REG-FE-WORKSPACE-033 reception with message.send sees Messages, badged with the failed and skipped count", async () => {
    perms.set = new Set(["message.send"]);
    messaging.messageLog.mockResolvedValue([{ status: "failed" }, { status: "skipped" }, { status: "sent" }]);
    page();
    await loaded();
    await waitFor(() => expect(tab(/^Messages/)).toHaveTextContent("Messages2"));
    expect(messaging.messageLog).toHaveBeenCalledWith({ patient: "pat_1" });
  });

  test("REG-FE-WORKSPACE-034 ?panel=money opens the Money panel directly", async () => {
    window.history.replaceState({}, "", "/patients/pat_1?panel=money");
    page({ route: "/patients/pat_1?panel=money" });
    await loaded();
    await waitFor(() => expect(tab(/^Money/)).toHaveAttribute("aria-current", "page"));
    expect(screen.getByText("Owed now for treatment")).toBeVisible();
  });

  test("REG-FE-WORKSPACE-035 ?panel= naming a panel this viewer lacks falls back to the first one", async () => {
    perms.set = new Set(["patient.read"]);
    window.history.replaceState({}, "", "/patients/pat_1?panel=chart");
    page({ route: "/patients/pat_1?panel=chart" });
    await loaded();
    expect(tab(/^Timeline/)).toHaveAttribute("aria-current", "page");
  });

  test("REG-FE-WORKSPACE-036 the chosen panel is remembered for this patient", async () => {
    const r = page();
    await loaded();
    await r.user.click(tab(/^Certificates/));
    expect(tab(/^Certificates/)).toHaveAttribute("aria-current", "page");
    r.unmount();
    page();
    await loaded();
    await waitFor(() => expect(tab(/^Certificates/)).toHaveAttribute("aria-current", "page"));
  });

  test("REG-FE-WORKSPACE-037 money panel, nothing owed: green zero, no progress bar, no courses", async () => {
    const { user } = page();
    await loaded();
    await user.click(tab(/^Money/));
    expect(screen.getByText("Nothing is outstanding for treatment given.")).toBeInTheDocument();
    expect(screen.queryByText(/% paid/)).not.toBeInTheDocument();
    expect(screen.queryByText("Treatment courses")).not.toBeInTheDocument();
    expect(tab(/^Money/)).toHaveTextContent(/^Money$/);
  });

  test("REG-FE-WORKSPACE-038 money panel, owing: banner says Owes, headline in red, % paid, cashier and written-off lines, one card per live course", async () => {
    const plans = [
      P("p1", "Root canal", [S("s1", "2026-08-01", 1, "done")], "active",
        { money: { planned: "10000", collected: "4000", at_cashier: "1000", due: "2000" } } as never),
      P("p2", "Crown", [S("s2", "2026-09-01", 1)], "completed",
        { money: { planned: "0", collected: "0", at_cashier: "0", due: "0" } } as never),
      P("p3", "Cancelled one", [], "cancelled"),
    ];
    api.dentalSummary.mockResolvedValue(summary(plans, {
      owed: "10000", paid: "4000", balance: "6000", due: "2000", at_cashier: "1000", waived: "500", overdue: true,
    }));
    const { user } = page();
    await loaded();
    expect(screen.getByText("Owes 2,000 ETB")).toBeInTheDocument();
    expect(tab(/^Money/)).toHaveTextContent("Money!");
    await user.click(tab(/^Money/));
    const head = screen.getByText("Owed now for treatment").parentElement!;
    expect(within(head).getByText("2,000 ETB")).toHaveClass("text-destructive");
    expect(screen.getByText("Treatment already given and not paid for.")).toBeInTheDocument();
    expect(screen.getByText("40% paid")).toBeInTheDocument();
    expect(screen.getByText("1,000 ETB with the cashier — deliberately not counted above")).toBeInTheDocument();
    expect(screen.getByText("500 ETB written off")).toBeInTheDocument();
    expect(screen.getByText("2 courses · dental work only")).toBeInTheDocument();
    const rct = screen.getAllByText("Root canal").map((e) => e.closest(".rounded-lg.border")).find(Boolean) as HTMLElement;
    expect(within(rct).getByText("5,000 ETB still to pay")).toBeInTheDocument();
    expect(within(rct).getByText("2,000 ETB owed now")).toBeInTheDocument();
    expect(within(rct).getByText("1,000 ETB with the cashier")).toBeInTheDocument();
    expect(within(rct).getByText("40%")).toBeInTheDocument();
    expect(screen.queryByText("Cancelled one")).not.toBeInTheDocument();
  });

  test("REG-FE-WORKSPACE-039 one live course reads '1 course'", async () => {
    api.dentalSummary.mockResolvedValue(summary([P("p1", "Filling", [S("s1", "2026-09-01", 1)])]));
    const { user } = page();
    await loaded();
    await user.click(tab(/^Money/));
    expect(screen.getByText("1 course · dental work only")).toBeInTheDocument();
  });

  test("REG-FE-WORKSPACE-040 images panel: empty state, then grouped by treatment, with a filter", async () => {
    const plans = [P("p1", "Root canal", [S("s1", "2026-08-01", 1, "done", { images: [img("i2", "xray.jpg")] })])];
    api.dentalSummary.mockResolvedValue(summary(plans, {}, { image_limit: 5 }));
    api.listDentalImages.mockResolvedValue([img("i1", "consult.jpg")]);
    const { user } = page();
    await loaded();
    await user.click(tab(/^Images/));
    expect(await screen.findByText("(2/5)")).toBeInTheDocument();
    expect(screen.getByText("General (no treatment)")).toBeInTheDocument();
    expect(screen.getByAltText("consult.jpg")).toBeInTheDocument();
    expect(screen.getByAltText("xray.jpg")).toBeInTheDocument();
    // Filter to the treatment only.
    const panel = screen.getByText("Patient images").closest("div")!.parentElement!.parentElement!;
    await user.click(within(panel).getByRole("combobox"));
    await user.click(await screen.findByRole("option", { name: "Root canal" }));
    expect(screen.queryByAltText("consult.jpg")).not.toBeInTheDocument();
    expect(screen.getByAltText("xray.jpg")).toBeInTheDocument();
  });

  test("REG-FE-WORKSPACE-041 images panel: nothing on file says how to add one; an empty filter says so", async () => {
    const plans = [P("p1", "Root canal", [S("s1", "2026-08-01", 1)])];
    api.dentalSummary.mockResolvedValue(summary(plans));
    const { user } = page();
    await loaded();
    await user.click(tab(/^Images/));
    expect(await screen.findByText(/No images yet\. Add a general X-ray/)).toBeInTheDocument();
    expect(screen.getByText("(0)")).toBeInTheDocument();
    await user.click(screen.getByRole("combobox"));
    await user.click(await screen.findByRole("option", { name: "Root canal" }));
    expect(screen.getByText("No images.")).toBeInTheDocument();
  });

  test("REG-FE-WORKSPACE-042 uploading general images: each is compressed and sent session-less, with a count toast", async () => {
    api.uploadDentalImage.mockResolvedValue(img("n1"));
    const { user } = page();
    await loaded();
    await user.click(tab(/^Images/));
    const input = (await screen.findByText(/Add general image/)).querySelector("input[type=file]") as HTMLInputElement;
    const a = new File(["a"], "a.jpg", { type: "image/jpeg" }), b = new File(["b"], "b.jpg", { type: "image/jpeg" });
    fireEvent.change(input, { target: { files: [a, b] } });
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith("2 general images added"));
    expect(api.uploadDentalImage).toHaveBeenNthCalledWith(1, "pat_1", a);
    expect(api.uploadDentalImage).toHaveBeenNthCalledWith(2, "pat_1", b);
    // An empty pick does nothing.
    fireEvent.change(input, { target: { files: [] } });
    expect(api.uploadDentalImage).toHaveBeenCalledTimes(2);
  });

  test("REG-FE-WORKSPACE-043 a failed upload stops and says which file; one success reads singular", async () => {
    api.uploadDentalImage.mockResolvedValueOnce(img("n1")).mockRejectedValueOnce(new Error("x"));
    const { user } = page();
    await loaded();
    await user.click(tab(/^Images/));
    const input = (await screen.findByText(/Add general image/)).querySelector("input[type=file]") as HTMLInputElement;
    const files = ["a", "b", "c"].map((n) => new File([n], `${n}.jpg`, { type: "image/jpeg" }));
    fireEvent.change(input, { target: { files } });
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith("Could not upload b.jpg"));
    expect(api.uploadDentalImage).toHaveBeenCalledTimes(2);
    expect(toast.success).toHaveBeenCalledWith("1 general image added");
  });

  test("REG-FE-WORKSPACE-044 a server-refused upload shows the server's reason", async () => {
    api.uploadDentalImage.mockRejectedValue(new AppError(413, "quota", "Storage quota reached"));
    const { user } = page();
    await loaded();
    await user.click(tab(/^Images/));
    const input = (await screen.findByText(/Add general image/)).querySelector("input[type=file]") as HTMLInputElement;
    fireEvent.change(input, { target: { files: [new File(["a"], "a.jpg", { type: "image/jpeg" })] } });
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith("Storage quota reached"));
    expect(toast.success).not.toHaveBeenCalled();
  });

  test("REG-FE-WORKSPACE-045 at the plan's image cap the upload control is disabled and a pick is refused", async () => {
    api.dentalSummary.mockResolvedValue(summary([], {}, { image_limit: 1 }));
    api.listDentalImages.mockResolvedValue([img("i1")]);
    const { user } = page();
    await loaded();
    await user.click(tab(/^Images/));
    await screen.findByText("(1/1)");
    const input = screen.getByText(/Add general image/).querySelector("input[type=file]") as HTMLInputElement;
    expect(input).toBeDisabled();
    fireEvent.change(input, { target: { files: [new File(["a"], "a.jpg", { type: "image/jpeg" })] } });
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith("This plan allows up to 1 images per patient."));
    expect(api.uploadDentalImage).not.toHaveBeenCalled();
  });

  test("REG-FE-WORKSPACE-046 removing an image confirms first, then deletes it (and reports a failure)", async () => {
    api.listDentalImages.mockResolvedValue([img("i1", "consult.jpg")]);
    api.deleteDentalImage.mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error("x"));
    const { user } = page();
    await loaded();
    await user.click(tab(/^Images/));
    await user.click(await screen.findByRole("button", { name: "Remove image" }));
    await user.click(await screen.findByRole("button", { name: "Delete" }));
    await waitFor(() => expect(api.deleteDentalImage).toHaveBeenCalledWith("pat_1", "i1"));
    expect(toast.success).toHaveBeenCalledWith("Image removed");
    await user.click(screen.getByRole("button", { name: "Remove image" }));
    await user.click(await screen.findByRole("button", { name: "Delete" }));
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith("Could not remove the image"));
  });

  test("REG-FE-WORKSPACE-047 the tooth chart panel is badged with the marked-tooth count", async () => {
    api.dentalSummary.mockResolvedValue({ ...summary(), chart: { teeth: { UR1: "decayed", UL2: "filled" } } } as unknown as Summary);
    page();
    await loaded();
    await waitFor(() => expect(tab(/^Tooth chart/)).toHaveTextContent("Tooth chart2"));
  });

  test("REG-FE-WORKSPACE-048 the treatments tab is badged with active courses only; its New button opens the new-plan dialog", async () => {
    api.dentalSummary.mockResolvedValue(summary([
      P("p1", "Old", [S("s1", "2026-01-01", 1, "done")], "completed"),
      P("p2", "Bridge", [S("s2", "2026-09-01", 1)], "active"),
    ]));
    const { user } = page();
    await loaded();
    expect(tab(/^Treatments/)).toHaveTextContent(/^Treatments1$/);
    await user.click(tab(/^Treatments/));
    await user.click(screen.getByRole("button", { name: /^New$/ }));
    expect(await screen.findByRole("dialog", { name: "New treatment plan" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "New treatment plan" })).not.toBeInTheDocument());
  });
});
