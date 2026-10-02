// The "Unbilled treatment" report: treatment delivered and never paid for. Each test
// renders the real page over a mocked report and reads it the way the desk would —
// the headline tiles, the lanes, the row actions — and asserts the exact call made.
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, onTestFinished, test, vi } from "vitest";

const api = vi.hoisted(() => ({
  unbilledTreatment: vi.fn(), collectSession: vi.fn(), writeOffSession: vi.fn(),
}));
vi.mock("@/features/dental/api", async (orig) => ({ ...(await orig<object>()), ...api }));
vi.mock("@/lib/api-client", async (orig) => {
  const { quietApiFetch } = await import("@/test/render");
  return { ...(await orig<object>()), apiFetch: vi.fn(quietApiFetch) };
});

const perms = vi.hoisted(() => ({ set: new Set<string>() }));
vi.mock("@/app/auth-context", () => ({
  useAuth: () => ({ can: (p: string) => perms.set.has(p), flagOn: () => true, user: { id: "u1" }, activeBranchId: null }),
}));

const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }));
vi.mock("sonner", () => ({ toast, Toaster: () => null }));

// The SMS dialog has its own tests; here only what the page hands it matters.
vi.mock("@/features/messaging/UnbilledRemind", () => ({
  UnbilledRemindDialog: ({ sessionIds, onClose, onSent }: { sessionIds: string[]; onClose: () => void; onSent: () => void }) => (
    <div data-testid="remind">
      <span data-testid="remind-ids">{sessionIds.join(",")}</span>
      <button onClick={onClose}>stub-close</button>
      <button onClick={onSent}>stub-sent</button>
    </div>
  ),
}));

import { AppError } from "@/lib/api-client";
import { UnbilledPage } from "@/features/dental/pages/UnbilledPage";
import type { UnbilledReport, UnbilledRow } from "@/features/dental/api";
import { renderUI, currentLocation } from "@/test/render";

const R = (id: string, extra: Partial<UnbilledRow> = {}): UnbilledRow => ({
  session_id: id, patient_id: `pat_${id}`, mrn: `MRN-${id}`, patient_name: `Patient ${id}`,
  plan_title: "Root canal", seq: 2, session_count: 4, kind: "visit", treatment_date: "2026-08-01",
  days_unbilled: 3, amount: "1000", lane: "never_billed", pay_later: false, ...extra,
});
const report = (rows: UnbilledRow[], extra: Partial<UnbilledReport> = {}): UnbilledReport => ({
  rows, total: String(rows.reduce((a, r) => a + Number(r.amount), 0)), count: rows.length,
  has_more: false, promised_total: "0", promised_count: 0, ...extra,
});
const rowOf = (name: string) => screen.getByRole("button", { name }).closest("div.rounded-lg") as HTMLElement;
/** The bulk-bar box comes first; its label text changes with the selection. */
const selectAllBox = () => screen.getAllByRole("checkbox")[0];
const tile = (label: string) => screen.getByText(label).parentElement as HTMLElement;

function page(...p: string[]) {
  perms.set = new Set(p);
  return renderUI(<UnbilledPage />);
}

describe("REG-FE-UNBILLED the unbilled treatment report", () => {
  beforeEach(() => {
    Object.values(api).forEach((f) => f.mockReset());
    toast.success.mockReset(); toast.error.mockReset();
  });

  test("REG-FE-UNBILLED-001 loading shows a skeleton, then the report; the first page is requested", async () => {
    let resolve!: (r: UnbilledReport) => void;
    api.unbilledTreatment.mockReturnValue(new Promise((r) => { resolve = r; }));
    const { container } = page();
    expect(container.querySelector(".animate-pulse")).toBeInTheDocument();
    expect(screen.queryByText("What is owed")).not.toBeInTheDocument();
    resolve(report([R("a")]));
    expect(await screen.findByText("What is owed")).toBeInTheDocument();
    expect(api.unbilledTreatment).toHaveBeenCalledWith({ limit: 100, offset: 0 });
  });

  test("REG-FE-UNBILLED-002 a failed load says so instead of an all-clear", async () => {
    api.unbilledTreatment.mockRejectedValue(new Error("boom"));
    page();
    expect(await screen.findByText("Could not load the report.")).toBeInTheDocument();
    expect(screen.queryByText(/Nothing outstanding/)).not.toBeInTheDocument();
  });

  test("REG-FE-UNBILLED-003 empty report: the all-clear, zero headline, no bulk bar", async () => {
    api.unbilledTreatment.mockResolvedValue(report([]));
    page("message.send", "payment.charge");
    expect(await screen.findByText("Nothing outstanding — every treatment given has been billed.")).toBeInTheDocument();
    expect(tile("Owed, not yet billed")).toHaveTextContent("0 ETB");
    expect(tile("Owed, not yet billed")).toHaveTextContent("across 0 items");
    expect(tile("Oldest")).toHaveTextContent("0days");
    expect(screen.queryByText("Select all")).not.toBeInTheDocument();
  });

  test("REG-FE-UNBILLED-004 headline: server total and count, oldest age, promised kept apart", async () => {
    api.unbilledTreatment.mockResolvedValue(report(
      [R("a", { days_unbilled: 40 }), R("b", { days_unbilled: 8 })],
      { total: "11500", count: 7, promised_total: "4000", promised_count: 1 },
    ));
    page();
    await screen.findByText("What is owed");
    expect(tile("Owed, not yet billed")).toHaveTextContent("11,500 ETB");
    expect(tile("Owed, not yet billed")).toHaveTextContent("across 7 items");
    expect(tile("Oldest")).toHaveTextContent("40days");
    expect(tile("Promised, not yet given")).toHaveTextContent("4,000 ETB");
    expect(tile("Promised, not yet given")).toHaveTextContent("1 booked with a pay-later note — not billable yet");
    // Ageing is coloured: 30+ red, 7+ amber, younger muted.
    expect(screen.getByText("40 days")).toHaveClass("bg-destructive");
    expect(screen.getByText("8 days")).toHaveClass("bg-amber-500");
  });

  test("REG-FE-UNBILLED-005 a row says what is owed: visit, deposit, extra, procedure, tooth, people, note, phone", async () => {
    api.unbilledTreatment.mockResolvedValue(report([
      R("v", { procedure: "Pulpotomy", tooth: "UR5", clinician: "Dr Abebe", branch: "Bole", phone: "0911000000",
        pay_later_note: "Will pay Friday", days_unbilled: 2 }),
      R("d", { kind: "deposit" }),
      R("x", { kind: "extra", service_name: "X-ray", seq: 3 }),
      R("y", { kind: "extra", seq: 1 }),
    ]));
    page();
    await screen.findByText("What is owed");
    const v = rowOf("Patient v");
    expect(v).toHaveTextContent("MRN-v");
    expect(v).toHaveTextContent("Never billed");
    expect(v).toHaveTextContent("Root canal · session 2 of 4 · Pulpotomy · UR5");
    expect(v).toHaveTextContent("· Dr Abebe · Bole");
    expect(v).toHaveTextContent("“Will pay Friday”");
    expect(within(v).getByRole("link", { name: /0911000000/ })).toHaveAttribute("href", "tel:0911000000");
    expect(within(v).getByText("2 days")).toHaveClass("bg-muted");
    expect(v).toHaveTextContent("1,000 ETB");
    // A down payment is not "session N of M", and is dated from when it was agreed.
    const d = rowOf("Patient d");
    expect(d).toHaveTextContent("Root canal · down payment");
    expect(d).not.toHaveTextContent(/session/);
    expect(d).toHaveTextContent(/agreed /);
    expect(rowOf("Patient x")).toHaveTextContent("X-ray added at visit 3");
    expect(rowOf("Patient y")).toHaveTextContent("extra treatment added at visit 1");
    expect(within(rowOf("Patient d")).queryByRole("link")).not.toBeInTheDocument();
  });

  test("REG-FE-UNBILLED-006 the patient name opens that visit on the patient's page", async () => {
    api.unbilledTreatment.mockResolvedValue(report([R("a")]));
    const { user } = page();
    await user.click(await screen.findByRole("button", { name: "Patient a" }));
    expect(currentLocation()).toBe("/patients/pat_a?visit=a");
  });

  test("REG-FE-UNBILLED-007 lane filter: counts on each tab, rows narrowed, headline describes only that lane", async () => {
    api.unbilledTreatment.mockResolvedValue(report([
      R("a", { amount: "1000" }), R("b", { lane: "bill_withdrawn", amount: "2500" }),
      R("c", { lane: "refunded", amount: "500", days_unbilled: 12 }), R("e", { lane: "refunded", amount: "700" }),
    ], { total: "11500", count: 9 }));
    const { user } = page();
    await screen.findByText("What is owed");
    expect(screen.getByRole("tab", { name: "All 4" })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByRole("tab", { name: "Never billed 1" })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "Bill withdrawn 1" })).toBeInTheDocument();
    await user.click(screen.getByRole("tab", { name: "Refunded 2" }));
    expect(screen.queryByRole("button", { name: "Patient a" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Patient c" })).toBeInTheDocument();
    expect(tile("Owed, not yet billed")).toHaveTextContent("1,200 ETB");
    expect(tile("Owed, not yet billed")).toHaveTextContent("across 2 items · refunded on this page");
    expect(tile("Oldest")).toHaveTextContent("12days");
    await user.click(screen.getByRole("tab", { name: "Bill withdrawn 1" }));
    expect(tile("Owed, not yet billed")).toHaveTextContent("across 1 item · bill withdrawn on this page");
  });

  test("REG-FE-UNBILLED-008 an empty lane says 'Nothing in this category.'", async () => {
    api.unbilledTreatment.mockResolvedValue(report([R("a")]));
    const { user } = page();
    await user.click(await screen.findByRole("tab", { name: "Refunded 0" }));
    expect(screen.getByText("Nothing in this category.")).toBeInTheDocument();
  });

  test("REG-FE-UNBILLED-009 no money permission: no Send to cashier / Write off / Remind / checkboxes", async () => {
    api.unbilledTreatment.mockResolvedValue(report([R("a")]));
    page();
    await screen.findByText("What is owed");
    expect(screen.queryByRole("button", { name: /Send to cashier/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Write off" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Remind/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("checkbox")).not.toBeInTheDocument();
  });

  test("REG-FE-UNBILLED-010 dental.manage alone can send to the cashier but not write off (that is payment.waive)", async () => {
    api.unbilledTreatment.mockResolvedValue(report([R("a")]));
    page("dental.manage");
    expect(await screen.findByRole("button", { name: /Send to cashier/ })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Write off" })).not.toBeInTheDocument();
  });

  test("REG-FE-UNBILLED-011 Send to cashier collects that exact session, toasts, and refetches the report", async () => {
    api.unbilledTreatment.mockResolvedValue(report([R("a"), R("b")]));
    api.collectSession.mockResolvedValue({});
    const { user } = page("payment.charge");
    await screen.findByText("What is owed");
    await user.click(within(rowOf("Patient b")).getByRole("button", { name: /Send to cashier/ }));
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith("Sent to the cashier"));
    expect(api.collectSession).toHaveBeenCalledTimes(1);
    expect(api.collectSession).toHaveBeenCalledWith("pat_b", "b");
    await waitFor(() => expect(api.unbilledTreatment).toHaveBeenCalledTimes(2));
  });

  test("REG-FE-UNBILLED-012 a refunded row offers Bill again (same call)", async () => {
    api.unbilledTreatment.mockResolvedValue(report([R("r", { lane: "refunded" })]));
    api.collectSession.mockResolvedValue({});
    const { user } = page("payment.charge");
    await user.click(await screen.findByRole("button", { name: /Bill again/ }));
    expect(api.collectSession).toHaveBeenCalledWith("pat_r", "r");
    expect(screen.queryByRole("button", { name: /Send to cashier/ })).not.toBeInTheDocument();
  });

  test("REG-FE-UNBILLED-013 while sending, only that row's button is busy, so it cannot be pressed twice", async () => {
    api.unbilledTreatment.mockResolvedValue(report([R("a"), R("b")]));
    api.collectSession.mockReturnValue(new Promise(() => {}));
    const { user } = page("payment.charge");
    await screen.findByText("What is owed");
    const btn = within(rowOf("Patient a")).getByRole("button", { name: /Send to cashier/ });
    await user.click(btn);
    await waitFor(() => expect(btn).toBeDisabled());
    fireEvent.click(btn);
    expect(api.collectSession).toHaveBeenCalledTimes(1);
    expect(within(rowOf("Patient b")).getByRole("button", { name: /Send to cashier/ })).toBeEnabled();
  });

  test("REG-FE-UNBILLED-014 a refused send toasts the server's message, or a generic one", async () => {
    api.unbilledTreatment.mockResolvedValue(report([R("a"), R("b")]));
    api.collectSession.mockRejectedValueOnce(new AppError(409, "conflict", "Already billed"))
      .mockRejectedValueOnce(new Error("network"));
    const { user } = page("payment.charge");
    await screen.findByText("What is owed");
    await user.click(within(rowOf("Patient a")).getByRole("button", { name: /Send to cashier/ }));
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith("Already billed"));
    await user.click(within(rowOf("Patient b")).getByRole("button", { name: /Send to cashier/ }));
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith("Could not send it to the cashier"));
    expect(toast.success).not.toHaveBeenCalled();
  });

  test("REG-FE-UNBILLED-015 Write off asks for a required reason, then posts it", async () => {
    api.unbilledTreatment.mockResolvedValue(report([R("a", { amount: "2500" })]));
    api.writeOffSession.mockResolvedValue(undefined);
    const { user } = page("payment.charge", "payment.waive");
    await user.click(await screen.findByRole("button", { name: "Write off" }));
    const dlg = await screen.findByRole("dialog");
    expect(dlg).toHaveTextContent("Write off 2,500 ETB?");
    expect(dlg).toHaveTextContent("Patient a will not be charged for this treatment.");
    const ok = within(dlg).getByRole("button", { name: "Write it off" });
    expect(ok).toBeDisabled();
    await user.type(within(dlg).getByLabelText(/Why is it not being charged for/), "   ");
    expect(ok).toBeDisabled();
    await user.type(within(dlg).getByLabelText(/Why is it not being charged for/), "Goodwill ");
    await user.click(ok);
    await waitFor(() => expect(api.writeOffSession).toHaveBeenCalledWith("pat_a", "a", "Goodwill"));
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith("Written off"));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
  });

  test("REG-FE-UNBILLED-016 cancelling the write-off sends nothing", async () => {
    api.unbilledTreatment.mockResolvedValue(report([R("a")]));
    const { user } = page("payment.charge", "payment.waive");
    await user.click(await screen.findByRole("button", { name: "Write off" }));
    await user.click(within(await screen.findByRole("dialog")).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(api.writeOffSession).not.toHaveBeenCalled();
  });

  test("REG-FE-UNBILLED-017 a refused write-off toasts the reason (server or generic)", async () => {
    api.unbilledTreatment.mockResolvedValue(report([R("a")]));
    api.writeOffSession.mockRejectedValueOnce(new AppError(403, "forbidden", "Not allowed"))
      .mockRejectedValueOnce(new Error("x"));
    // The confirm dialog awaits the mutation without a catch, so a refusal also
    // surfaces as an unhandled rejection (console noise only — the dialog stays open
    // with the reason kept, so the desk can retry). Muted for this test alone.
    const saved = process.listeners("unhandledRejection");
    process.removeAllListeners("unhandledRejection");
    process.on("unhandledRejection", () => {});
    onTestFinished(() => {
      process.removeAllListeners("unhandledRejection");
      saved.forEach((l) => process.on("unhandledRejection", l));
    });
    const { user } = page("payment.charge", "payment.waive");
    for (const msg of ["Not allowed", "Could not write it off"]) {
      await user.click(await screen.findByRole("button", { name: "Write off" }));
      const dlg = await screen.findByRole("dialog");
      fireEvent.change(within(dlg).getByLabelText(/Why is it not being charged for/), { target: { value: "Goodwill" } });
      await user.click(within(dlg).getByRole("button", { name: "Write it off" }));
      await waitFor(() => expect(toast.error).toHaveBeenCalledWith(msg));
      await user.keyboard("{Escape}");
      await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    }
    expect(toast.success).not.toHaveBeenCalled();
  });

  test("REG-FE-UNBILLED-018 Remind on one row opens the SMS dialog for that session only", async () => {
    api.unbilledTreatment.mockResolvedValue(report([R("a"), R("b")]));
    const { user } = page("message.send");
    await screen.findByText("What is owed");
    await user.click(within(rowOf("Patient b")).getByRole("button", { name: /Remind/ }));
    expect(screen.getByTestId("remind-ids")).toHaveTextContent(/^b$/);
    await user.click(screen.getByRole("button", { name: "stub-close" }));
    expect(screen.queryByTestId("remind")).not.toBeInTheDocument();
  });

  test("REG-FE-UNBILLED-019 bulk select: per patient count, one message each, cleared after sending", async () => {
    // Two visits of one patient + one of another = 3 rows, 2 patients.
    api.unbilledTreatment.mockResolvedValue(report([
      R("a1", { patient_id: "pat_A", patient_name: "Alem" }), R("a2", { patient_id: "pat_A", patient_name: "Alem B" }),
      R("c", { patient_id: "pat_C", patient_name: "Chala" }),
    ]));
    const { user } = page("message.manage");
    await screen.findByText("What is owed");
    const bulk = screen.getByRole("button", { name: /^Message/ });
    expect(bulk).toBeDisabled();
    expect(bulk).toHaveTextContent(/Message patients$/);
    await user.click(screen.getByLabelText("Select Alem"));
    expect(screen.getByText("1 selected")).toBeInTheDocument();
    expect(bulk).toHaveTextContent("Message 1 patient");
    await user.click(screen.getByLabelText("Select Alem B"));
    expect(screen.getByText("2 selected")).toBeInTheDocument();
    expect(screen.getByText("1 patient — one message each")).toBeInTheDocument();
    await user.click(screen.getByLabelText("Select Alem B")); // untick
    expect(screen.getByText("1 selected")).toBeInTheDocument();
    await user.click(selectAllBox());
    expect(screen.getByText("3 selected")).toBeInTheDocument();
    expect(screen.getByText("2 patients — one message each")).toBeInTheDocument();
    expect(bulk).toHaveTextContent("Message 2 patients");
    await user.click(bulk);
    expect(screen.getByTestId("remind-ids")).toHaveTextContent("a1,a2,c");
    await user.click(screen.getByRole("button", { name: "stub-sent" }));
    expect(screen.queryByTestId("remind")).not.toBeInTheDocument();
    expect(screen.getByText("Select all")).toBeInTheDocument();
    // Select all, then untick everything via the same box.
    await user.click(selectAllBox());
    expect(selectAllBox()).toBeChecked();
    await user.click(selectAllBox());
    expect(screen.getByText("Select all")).toBeInTheDocument();
  });

  test("REG-FE-UNBILLED-020 switching lanes drops ticks the desk can no longer see", async () => {
    api.unbilledTreatment.mockResolvedValue(report([R("a"), R("b", { lane: "refunded" })]));
    const { user } = page("message.send");
    await screen.findByText("What is owed");
    await user.click(screen.getByLabelText("Select Patient a"));
    expect(screen.getByText("1 selected")).toBeInTheDocument();
    await user.click(screen.getByRole("tab", { name: "Refunded 1" }));
    expect(screen.getByText("Select all")).toBeInTheDocument();
    expect(screen.getByLabelText("Select Patient b")).not.toBeChecked();
  });

  test("REG-FE-UNBILLED-021 paging: Older requests the next offset, Newer goes back; no pager on a single page", async () => {
    const first = report([R("a")], { has_more: true, count: 150 });
    const second = report([R("z")], { has_more: false, count: 150 });
    api.unbilledTreatment.mockImplementation(async ({ offset }: { offset: number }) => (offset ? second : first));
    const { user } = page();
    await screen.findByText("What is owed");
    expect(screen.getByText(/showing 1–1 of 150/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Newer" })).toBeDisabled();
    await user.click(screen.getByRole("button", { name: "Older" }));
    await screen.findByRole("button", { name: "Patient z" });
    expect(api.unbilledTreatment).toHaveBeenLastCalledWith({ limit: 100, offset: 100 });
    expect(screen.getByText(/showing 101–101 of 150/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Older" })).toBeDisabled();
    await user.click(screen.getByRole("button", { name: "Newer" }));
    await screen.findByRole("button", { name: "Patient a" });
  });

  test("REG-FE-UNBILLED-022 no pager when everything fits on one page", async () => {
    api.unbilledTreatment.mockResolvedValue(report([R("a")]));
    page();
    await screen.findByText("What is owed");
    expect(screen.queryByRole("button", { name: "Older" })).not.toBeInTheDocument();
  });

  test("REG-FE-UNBILLED-023 a later page that comes back empty returns to the first page", async () => {
    const first = report([R("a")], { has_more: true, count: 101 });
    api.unbilledTreatment.mockImplementation(async ({ offset }: { offset: number }) => (offset ? report([], { count: 101 }) : first));
    const { user } = page();
    await screen.findByText("What is owed");
    await user.click(screen.getByRole("button", { name: "Older" }));
    await waitFor(() => expect(api.unbilledTreatment).toHaveBeenCalledWith({ limit: 100, offset: 100 }));
    // Bounced back to page 1 rather than showing an empty page under a non-zero total.
    await waitFor(() => expect(screen.getByRole("button", { name: "Newer" })).toBeDisabled());
    expect(screen.getByRole("button", { name: "Patient a" })).toBeInTheDocument();
  });
});
