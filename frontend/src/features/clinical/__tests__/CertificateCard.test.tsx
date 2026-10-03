// Medical certificates (the dental workspace's Certificates tab and the patient
// profile). What the clinic relies on: the list shows each certificate's number,
// kind, signer and rest period, void ones marked; Print re-prints the stored copy
// with the clinic and branch header; only someone who may issue sees Issue and
// Void; issuing sends the kind, rest days and start date (none for a fitness or
// attendance note), keeps the diagnosis off the paper unless ticked, and goes
// straight to print; voiding needs a reason; a refusal is shown and nothing prints.
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, onTestFinished, test, vi } from "vitest";

const printed = vi.hoisted(() => ({ docs: [] as unknown[] }));

vi.mock("@/lib/api-client", async (orig) => ({ ...(await orig<object>()), ...(await import("@/test/frontdesk")).apiModule }));
vi.mock("@/app/auth-context", async () => (await import("@/test/frontdesk")).authModule);
vi.mock("@/components/ui/sonner", async (orig) => ({ ...(await orig<object>()), toast: (await import("@/test/frontdesk")).toastSpy }));
vi.mock("@/features/clinical/printCertificate", () => ({
  printCertificate: async (doc: unknown) => { printed.docs.push(doc); },
}));

import { CertificateCard } from "@/features/clinical/CertificateCard";
import type { Certificate } from "@/features/clinical/api";
import { fail, fake, hang, resetToasts, setAuth, toasts, DESK_USER } from "@/test/frontdesk";
import { freezeToday, renderUI } from "@/test/render";

const cert = (id: string, over: Partial<Certificate> = {}): Certificate => ({
  id, ref: `MC-2026-00${id}`, kind: "sick_leave", patient_name: "Abebe Kebede", mrn: "CD-1", age: "34", gender: "male",
  show_diagnosis: false, rest_days: 3, rest_from: "2026-10-01", rest_to: "2026-10-03", issued_at: "2026-10-01T08:00:00Z",
  issued_by: "Dr Hana", status: "active", ...over,
});

function mount(props: Partial<{ canIssue: boolean; bare: boolean }> = {}) {
  return renderUI(<CertificateCard patientId="pat_1" canIssue={props.canIssue ?? true} bare={props.bare} />);
}
const rowOf = (ref: string) => screen.getByText(ref).closest("div.rounded-md") as HTMLElement;

beforeEach(() => {
  fake.reset();
  resetToasts();
  setAuth({ user: { ...DESK_USER, full_name: "Dr Hana" } });
  printed.docs = [];
  fake.on("GET", "/org/clinic", { name: "Cure Dental" });
  fake.on("GET", "/org/branches", [{ id: "br_main", name: "Bole", address: "Bole Rd", phone: "0911" }]);
  fake.on("GET", "/patients/pat_1/certificates", { items: [] });
});

describe("REG-FE-CERT the certificates list", () => {
  test("REG-FE-CERT-001 nothing issued: an explanation, the count badge absent", async () => {
    mount();
    expect(await screen.findByText(/None issued\. A certificate is the note/)).toBeInTheDocument();
    expect(screen.getByText("Medical certificates")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Issue certificate" })).toBeInTheDocument();
  });

  test("REG-FE-CERT-002 each certificate: number, kind, signer, rest days, dates; void ones say why and offer no Void", async () => {
    fake.on("GET", "/patients/pat_1/certificates", { items: [
      cert("41"),
      cert("42", { kind: "fitness", rest_days: undefined, rest_from: undefined, rest_to: undefined, issued_by: undefined }),
      cert("43", { kind: "attendance", status: "void", void_reason: "Wrong patient", rest_days: 1, rest_from: undefined }),
      cert("44", { kind: "other" as never, rest_days: undefined, rest_to: undefined }),
    ] });
    mount();
    const r41 = await waitFor(() => rowOf("MC-2026-0041"));
    expect(within(r41).getByText("Sick leave")).toBeInTheDocument();
    expect(within(r41).getByText(/· Dr Hana · 3 days rest/)).toBeInTheDocument();
    expect(within(r41).getByText("→", { exact: false })).toBeInTheDocument();
    expect(within(r41).getByRole("button", { name: /Void/ })).toBeInTheDocument();
    const r42 = rowOf("MC-2026-0042");
    expect(within(r42).getByText("Fit to return")).toBeInTheDocument();
    expect(within(r42).queryByText(/rest/)).not.toBeInTheDocument();
    const r43 = rowOf("MC-2026-0043");
    expect(within(r43).getByText("Attendance only")).toBeInTheDocument();
    expect(within(r43).getByText("Void")).toBeInTheDocument();
    expect(within(r43).getByText("Voided: Wrong patient")).toBeInTheDocument();
    expect(within(r43).getByText(/1 day rest/)).toBeInTheDocument();
    expect(within(r43).queryByRole("button", { name: /Void/ })).not.toBeInTheDocument();
    expect(within(rowOf("MC-2026-0044")).getByText("other")).toBeInTheDocument();
    expect(screen.getByText("4")).toBeInTheDocument();
  });

  test("REG-FE-CERT-003 without permission to issue: no Issue, no Void, but Print stays", async () => {
    fake.on("GET", "/patients/pat_1/certificates", { items: [cert("41")] });
    mount({ canIssue: false });
    const r = await waitFor(() => rowOf("MC-2026-0041"));
    expect(screen.queryByRole("button", { name: "Issue certificate" })).not.toBeInTheDocument();
    expect(within(r).queryByRole("button", { name: /Void/ })).not.toBeInTheDocument();
    expect(within(r).getByRole("button", { name: /Print/ })).toBeInTheDocument();
  });

  test("REG-FE-CERT-004 bare (inside the dental workspace): no card title, Issue still offered when allowed", async () => {
    const { unmount } = mount({ bare: true });
    expect(await screen.findByRole("button", { name: "Issue certificate" })).toBeInTheDocument();
    expect(screen.queryByText("Medical certificates")).not.toBeInTheDocument();
    unmount();
    mount({ bare: true, canIssue: false });
    await screen.findByText(/None issued/);
    expect(screen.queryByRole("button", { name: "Issue certificate" })).not.toBeInTheDocument();
  });

  test("REG-FE-CERT-005 while loading, no 'none issued' message", async () => {
    fake.on("GET", "/patients/pat_1/certificates", hang);
    mount();
    await screen.findByRole("button", { name: "Issue certificate" });
    expect(screen.queryByText(/None issued/)).not.toBeInTheDocument();
  });

  test("REG-FE-CERT-006 Print re-prints the stored certificate with the clinic and active branch header", async () => {
    fake.on("GET", "/patients/pat_1/certificates", { items: [cert("41", { status: "void", void_reason: "Dup", show_diagnosis: true, diagnosis: "Abscess", notes: "Light duty" })] });
    const { user } = mount();
    await waitFor(() => rowOf("MC-2026-0041"));
    await waitFor(() => expect(fake.sent("GET", "/org/branches")).toHaveLength(1));
    await new Promise((r) => setTimeout(r, 20));
    await user.click(within(rowOf("MC-2026-0041")).getByRole("button", { name: /Print/ }));
    expect(printed.docs).toHaveLength(1);
    expect(printed.docs[0]).toMatchObject({
      clinic: "Cure Dental", clinicContact: "Bole Rd · 0911", branch: "Bole", ref: "MC-2026-0041", kind: "sick_leave",
      patient: "Abebe Kebede", mrn: "CD-1", diagnosis: "Abscess", showDiagnosis: true, restDays: 3,
      restFrom: "2026-10-01", restTo: "2026-10-03", issuedOn: "2026-10-01", issuedBy: "Dr Hana",
      status: "void", voidReason: "Dup", notes: "Light duty",
    });
    expect((printed.docs[0] as { restFromEc?: string }).restFromEc).toBeTruthy();
    expect((printed.docs[0] as { issuedOnEc?: string }).issuedOnEc).toBeTruthy();
  });

  test("REG-FE-CERT-007 Print with no clinic name or branch details falls back to 'Clinic', no contact line", async () => {
    fake.on("GET", "/org/clinic", fail(500, "x"));
    fake.on("GET", "/org/branches", [{ id: "br_main", name: "Bole" }, { id: "br_2", name: "Other", address: "A" }]);
    fake.on("GET", "/patients/pat_1/certificates", { items: [cert("41", { rest_from: "bad-date", rest_to: undefined })] });
    const { user } = mount();
    await waitFor(() => rowOf("MC-2026-0041"));
    await waitFor(() => expect(fake.sent("GET", "/org/branches")).toHaveLength(1));
    await new Promise((r) => setTimeout(r, 20));
    await user.click(within(rowOf("MC-2026-0041")).getByRole("button", { name: /Print/ }));
    expect(printed.docs[0]).toMatchObject({ clinic: "Clinic", branch: "Bole", clinicContact: undefined, restToEc: undefined });
  });

  test("REG-FE-CERT-008 with no active branch the print carries no branch", async () => {
    setAuth({ activeBranchId: null });
    fake.on("GET", "/patients/pat_1/certificates", { items: [cert("41")] });
    const { user } = mount();
    await waitFor(() => rowOf("MC-2026-0041"));
    await user.click(within(rowOf("MC-2026-0041")).getByRole("button", { name: /Print/ }));
    expect(printed.docs[0]).toMatchObject({ branch: undefined, clinicContact: undefined });
  });
});

describe("REG-FE-CERT voiding", () => {
  test("REG-FE-CERT-009 Void asks why; the reason is required and sent; the list refreshes", async () => {
    fake.on("GET", "/patients/pat_1/certificates", { items: [cert("41")] });
    const { user } = mount();
    await waitFor(() => rowOf("MC-2026-0041"));
    await user.click(within(rowOf("MC-2026-0041")).getByRole("button", { name: /Void/ }));
    const dlg = await screen.findByRole("dialog");
    expect(within(dlg).getByText("Void MC-2026-0041?")).toBeInTheDocument();
    const confirm = within(dlg).getByRole("button", { name: "Void certificate" });
    expect(confirm).toBeDisabled();
    await user.type(within(dlg).getByLabelText(/Why is it being voided/), "  ");
    expect(confirm).toBeDisabled();
    await user.type(within(dlg).getByLabelText(/Why is it being voided/), "Issued to the wrong patient");
    await user.click(confirm);
    await waitFor(() => expect(toasts("success")).toEqual(["Certificate voided"]));
    expect(fake.sent("POST", "/certificates/41/void")[0].body).toEqual({ reason: "Issued to the wrong patient" });
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(fake.sent("GET", "/patients/pat_1/certificates").length).toBeGreaterThanOrEqual(2);
  });

  test("REG-FE-CERT-010 cancelling the void sends nothing", async () => {
    fake.on("GET", "/patients/pat_1/certificates", { items: [cert("41")] });
    const { user } = mount();
    await waitFor(() => rowOf("MC-2026-0041"));
    await user.click(within(rowOf("MC-2026-0041")).getByRole("button", { name: /Void/ }));
    await user.click(within(await screen.findByRole("dialog")).getByRole("button", { name: "Cancel" }));
    expect(fake.sent("POST", "/certificates/:id/void")).toHaveLength(0);
  });

  test("REG-FE-CERT-011 a refused void shows the server's reason; a network failure a plain one", async () => {
    fake.on("GET", "/patients/pat_1/certificates", { items: [cert("41")] });
    fake.on("POST", "/certificates/41/void", fail(409, "Already void"));
    // The confirm dialog awaits the mutation without a catch (NEW-CONFIRM-1), so a
    // refusal also surfaces as an unhandled rejection. Muted for this test alone.
    const saved = process.listeners("unhandledRejection");
    process.removeAllListeners("unhandledRejection");
    process.on("unhandledRejection", () => {});
    onTestFinished(() => {
      process.removeAllListeners("unhandledRejection");
      saved.forEach((l) => process.on("unhandledRejection", l));
    });
    const { user } = mount();
    await waitFor(() => rowOf("MC-2026-0041"));
    await user.click(within(rowOf("MC-2026-0041")).getByRole("button", { name: /Void/ }));
    const dlg = await screen.findByRole("dialog");
    await user.type(within(dlg).getByLabelText(/Why/), "dup");
    await user.click(within(dlg).getByRole("button", { name: "Void certificate" }));
    await waitFor(() => expect(toasts("error")).toEqual(["Already void"]));
    fake.on("POST", "/certificates/41/void", () => { throw new TypeError("offline"); });
    await user.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Void certificate" }));
    await waitFor(() => expect(toasts("error")).toEqual(["Already void", "Could not void it"]));
    // The dialog stays open with the reason kept, so the desk can retry.
    expect(within(screen.getByRole("dialog")).getByLabelText(/Why/)).toHaveValue("dup");
  });
});

describe("REG-FE-CERT issuing", () => {
  beforeEach(() => {
    fake.on("GET", "/patients/pat_1", { id: "pat_1", mrn: "CD-1", first_name: "Abebe", middle_name: "T", last_name: "Kebede", gender: "male" });
    fake.on("POST", "/patients/pat_1/certificates", cert("50"));
  });

  async function openIssue() {
    const r = mount();
    await r.user.click(await screen.findByRole("button", { name: "Issue certificate" }));
    const dlg = await screen.findByRole("dialog");
    await within(dlg).findAllByText("Abebe T Kebede");
    return { ...r, dlg };
  }

  test("REG-FE-CERT-012 the form names the patient and the signed-in signer; sick leave by default, 2 days from today", async () => {
    freezeToday("2026-10-03");
    const { dlg } = await openIssue();
    expect(within(dlg).getByText(/CD-1 · male · signed by/)).toBeInTheDocument();
    expect(within(dlg).getByText("Dr Hana")).toBeInTheDocument();
    expect(within(dlg).getByText("Medical Certificate")).toBeInTheDocument();
    expect(within(dlg).getByLabelText("Rest days")).toHaveValue(2);
    expect(within(dlg).getByText("2 days")).toBeInTheDocument();
    expect(within(dlg).getByText(/inclusive — back the next day/)).toBeInTheDocument();
    expect(within(dlg).getByText(/is not printed/)).toBeInTheDocument();
    vi.useRealTimers();
  });

  test("REG-FE-CERT-013 issue sick leave: kind, days, start date, diagnosis kept off by default; prints straight away", async () => {
    freezeToday("2026-10-03");
    const { user, dlg } = await openIssue();
    const days = within(dlg).getByLabelText("Rest days");
    await user.clear(days);
    await user.type(days, "1");
    expect(within(dlg).getByText("1 day")).toBeInTheDocument();
    await user.type(within(dlg).getByLabelText("Diagnosis / condition"), "Acute pain");
    expect(within(dlg).getByText(/is not printed/)).toBeInTheDocument();
    await user.type(within(dlg).getByLabelText("Extra notes (optional)"), "  Light duties  ");
    await user.click(within(dlg).getByRole("button", { name: /Issue & print/ }));
    await waitFor(() => expect(toasts("success")).toEqual(["Certificate MC-2026-0050 issued"]));
    expect(fake.lastBody("POST", "/patients/pat_1/certificates")).toEqual({
      kind: "sick_leave", diagnosis: "Acute pain", show_diagnosis: false, rest_days: 1, rest_from: "2026-10-03", notes: "Light duties",
    });
    expect(printed.docs).toHaveLength(1);
    expect(printed.docs[0]).toMatchObject({ ref: "MC-2026-0050" });
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    vi.useRealTimers();
  });

  test("REG-FE-CERT-014 ticking 'print the diagnosis' says so and sends show_diagnosis", async () => {
    const { user, dlg } = await openIssue();
    await user.type(within(dlg).getByLabelText("Diagnosis / condition"), "Abscess");
    await user.click(within(dlg).getByRole("checkbox"));
    expect(within(dlg).getByText(/“Abscess”/)).toBeInTheDocument();
    await user.click(within(dlg).getByRole("button", { name: /Issue & print/ }));
    await waitFor(() => expect(fake.sent("POST", "/patients/pat_1/certificates")).toHaveLength(1));
    expect(fake.lastBody("POST", "/patients/pat_1/certificates")).toMatchObject({ diagnosis: "Abscess", show_diagnosis: true });
  });

  test("REG-FE-CERT-015 fit to return: no rest period sent, no diagnosis when blank", async () => {
    const { user, dlg } = await openIssue();
    await user.click(within(dlg).getByRole("button", { name: /Fit to return/ }));
    expect(within(dlg).queryByLabelText("Rest days")).not.toBeInTheDocument();
    expect(within(dlg).getByText("Certificate of Fitness")).toBeInTheDocument();
    expect(within(dlg).getByText("fit to resume normal duties")).toBeInTheDocument();
    await user.click(within(dlg).getByRole("button", { name: /Issue & print/ }));
    await waitFor(() => expect(fake.sent("POST", "/patients/pat_1/certificates")).toHaveLength(1));
    expect(fake.lastBody("POST", "/patients/pat_1/certificates")).toEqual({
      kind: "fitness", diagnosis: undefined, show_diagnosis: false, rest_days: undefined, rest_from: undefined, notes: undefined,
    });
  });

  test("REG-FE-CERT-016 attendance only: no diagnosis field at all", async () => {
    const { user, dlg } = await openIssue();
    await user.click(within(dlg).getByRole("button", { name: /Attendance only/ }));
    expect(within(dlg).queryByLabelText("Diagnosis / condition")).not.toBeInTheDocument();
    expect(within(dlg).getByText("Certificate of Attendance")).toBeInTheDocument();
    expect(within(dlg).getByText("attended this clinic")).toBeInTheDocument();
    expect(within(dlg).queryByText(/is not printed/)).not.toBeInTheDocument();
  });

  test("REG-FE-CERT-017 validation: zero or blank rest days cannot be issued", async () => {
    const { user, dlg } = await openIssue();
    const days = within(dlg).getByLabelText("Rest days");
    await user.clear(days);
    expect(within(dlg).getByRole("button", { name: /Issue & print/ })).toBeDisabled();
    await user.type(days, "0");
    expect(within(dlg).getByRole("button", { name: /Issue & print/ })).toBeDisabled();
    expect(within(dlg).queryByText(/inclusive/)).not.toBeInTheDocument();
  });

  // NEW-CERTUI-1: clearing "Rest from" leaves Issue & print enabled and sends
  // rest_from: "" — a sick-leave certificate with no start date. It should be blocked.
  test.fails("REG-FE-CERT-018 validation: a sick-leave certificate without a start date cannot be issued (NEW-CERTUI-1)", async () => {
    const { user, dlg } = await openIssue();
    await user.click(within(dlg).getByRole("button", { name: "Gregorian" }));
    fireEvent.change(dlg.querySelector('input[type="date"]') as HTMLInputElement, { target: { value: "" } });
    await user.click(within(dlg).getByRole("button", { name: /Issue & print/ })).catch(() => {});
    await new Promise((r) => setTimeout(r, 50));
    expect(fake.sent("POST", "/patients/pat_1/certificates")).toHaveLength(0);
  });

  test("REG-FE-CERT-019 a refused issue shows the reason, keeps the form open, and prints nothing", async () => {
    fake.on("POST", "/patients/pat_1/certificates", fail(403, "Only clinicians may issue certificates"));
    const { user, dlg } = await openIssue();
    await user.click(within(dlg).getByRole("button", { name: /Issue & print/ }));
    await waitFor(() => expect(toasts("error")).toEqual(["Only clinicians may issue certificates"]));
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    expect(printed.docs).toHaveLength(0);
    fake.on("POST", "/patients/pat_1/certificates", () => { throw new TypeError("offline"); });
    await user.click(within(dlg).getByRole("button", { name: /Issue & print/ }));
    await waitFor(() => expect(toasts("error")).toContain("Could not issue the certificate"));
  });

  test("REG-FE-CERT-020 Cancel closes the form without issuing; an unknown signer reads 'you'", async () => {
    setAuth({ user: null });
    fake.on("GET", "/patients/pat_1", hang);
    const { user } = mount();
    await user.click(await screen.findByRole("button", { name: "Issue certificate" }));
    const dlg = await screen.findByRole("dialog");
    expect(within(dlg).getByText("…")).toBeInTheDocument();
    expect(within(dlg).getByText("you")).toBeInTheDocument();
    expect(within(dlg).getByText("the patient")).toBeInTheDocument();
    await user.click(within(dlg).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(fake.sent("POST", "/patients/pat_1/certificates")).toHaveLength(0);
  });
});
