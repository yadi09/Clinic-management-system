// "Correct this visit": the repairs a visit needs after the fact — pull a bill back
// from the cashier, send the fee to the cashier, record or clear a pay-later promise,
// change the status (asking first when that invents or erases a debt), and move the
// date of a visit that has not happened.
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

const api = vi.hoisted(() => ({
  collectSession: vi.fn(), uncollectSession: vi.fn(), setPayLater: vi.fn(), updateSession: vi.fn(),
}));
const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }));
const auth = vi.hoisted(() => ({ perms: new Set<string>() }));
vi.mock("@/features/dental/api", async (orig) => ({ ...(await orig<object>()), ...api }));
vi.mock("sonner", async (orig) => ({ ...(await orig<object>()), toast }));
vi.mock("@/lib/api-client", async (orig) => {
  const { quietApiFetch } = await import("@/test/render");
  return { ...(await orig<object>()), apiFetch: vi.fn(quietApiFetch) };
});
vi.mock("@/app/auth-context", () => ({
  useAuth: () => ({ can: (p: string) => auth.perms.has(p), flagOn: () => true, user: { id: "u1", full_name: "Dr Test" }, activeBranchId: null }),
}));

import { VisitActions } from "@/features/dental/visit/VisitActions";
import type { Session } from "@/features/dental/api";
import { AppError } from "@/lib/api-client";
import { freezeToday, renderUI } from "@/test/render";
import { S } from "./fixtures";

const T = "2026-08-12";

function actions(session: Session, opts: { canCollect?: boolean; editable?: boolean } = {}) {
  const onChanged = vi.fn();
  const r = renderUI(
    <VisitActions patientId="pat_1" session={session} canCollect={opts.canCollect ?? true}
      editable={opts.editable ?? true} onChanged={onChanged} />,
  );
  return { ...r, onChanged };
}
async function openPanel(user: ReturnType<typeof actions>["user"]) {
  await user.click(screen.getByRole("button", { name: /Correct this visit/ }));
}
/** The confirming button of a ConfirmDialog, not its X. */
const confirmIn = (dlg: HTMLElement, name: string) =>
  within(dlg).getAllByRole("button", { name }).find((b) => b.textContent === name)!;
const statusSelect = () => screen.getAllByRole("combobox")[0];
async function pickStatus(user: ReturnType<typeof actions>["user"], label: string) {
  await user.click(statusSelect());
  await user.click(await screen.findByRole("option", { name: label }));
}

describe("REG-FE-VISITACT correcting a visit", () => {
  beforeEach(() => {
    freezeToday(T);
    Object.values(api).forEach((f) => { f.mockReset(); f.mockResolvedValue(undefined); });
    toast.success.mockReset(); toast.error.mockReset();
    auth.perms = new Set();
  });
  afterEach(() => vi.useRealTimers());

  test("REG-FE-VISITACT-001 renders nothing for someone who can neither edit nor collect", () => {
    actions(S("s1", T, 1), { editable: false, canCollect: false });
    expect(screen.queryByRole("button", { name: /Correct this visit/ })).not.toBeInTheDocument();
  });

  test("REG-FE-VISITACT-002 collapsed behind a disclosure that toggles open and shut", async () => {
    const { user } = actions(S("s1", T, 1));
    expect(screen.queryByText("Status")).not.toBeInTheDocument();
    await openPanel(user);
    expect(screen.getByText("Status")).toBeInTheDocument();
    expect(screen.getByText("Marking a visit cancelled leaves its record intact.")).toBeInTheDocument();
    expect(screen.getByText(/To change the fee, press/)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /Hide corrections/ }));
    expect(screen.queryByText("Status")).not.toBeInTheDocument();
  });

  test("REG-FE-VISITACT-003 Send to the cashier bills this visit's fee", async () => {
    const { user, onChanged } = actions(S("s1", T, 1, "done"));
    await openPanel(user);
    await user.click(screen.getByRole("button", { name: "Send 2,000 ETB to the cashier" }));
    await waitFor(() => expect(api.collectSession).toHaveBeenCalledWith("pat_1", "s1"));
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith("Sent to the cashier"));
    expect(onChanged).toHaveBeenCalledTimes(1);
  });

  test("REG-FE-VISITACT-004 no Send button without collect rights, for a free visit, or once paid or billed", async () => {
    const cases: [Session, boolean][] = [
      [S("a", T, 1), false],
      [S("b", T, 1, "done", { amount_due: "0" }), true],
      [S("c", T, 1, "done", { payment: "paid" }), true],
      [S("d", T, 1, "done", { payment: "billed" }), true],
    ];
    for (const [s, canCollect] of cases) {
      const { user, unmount } = actions(s, { canCollect });
      await openPanel(user);
      expect(screen.queryByRole("button", { name: /to the cashier$/ })).not.toBeInTheDocument();
      unmount();
    }
  });

  test("REG-FE-VISITACT-005 a refunded visit can be billed again", async () => {
    const { user } = actions(S("s1", T, 1, "done", { payment: "refunded", amount_due: "1500" }));
    await openPanel(user);
    expect(screen.getByRole("button", { name: "Send 1,500 ETB to the cashier" })).toBeInTheDocument();
  });

  test("REG-FE-VISITACT-006 a refused bill is toasted with the server's words; a network failure plainly", async () => {
    api.collectSession.mockRejectedValueOnce(new AppError(409, "conflict", "Already billed"));
    api.collectSession.mockRejectedValueOnce(new TypeError("Failed to fetch"));
    const { user, onChanged } = actions(S("s1", T, 1, "done"));
    await openPanel(user);
    const send = screen.getByRole("button", { name: /Send 2,000 ETB/ });
    await user.click(send);
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith("Already billed"));
    await user.click(send);
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith("Could not do that"));
    expect(onChanged).not.toHaveBeenCalled();
  });

  test("REG-FE-VISITACT-007 Send is disabled while the bill is being raised (no double charge)", async () => {
    api.collectSession.mockReturnValue(new Promise(() => {}));
    const { user } = actions(S("s1", T, 1, "done"));
    await openPanel(user);
    const send = screen.getByRole("button", { name: /Send 2,000 ETB/ });
    await user.click(send);
    await waitFor(() => expect(send).toBeDisabled());
    await user.click(send);
    expect(api.collectSession).toHaveBeenCalledTimes(1);
  });

  test("REG-FE-VISITACT-008 pull back from the cashier asks why, refuses a blank reason, and sends it", async () => {
    const { user, onChanged } = actions(S("s1", T, 1, "done", { payment: "billed" }));
    await openPanel(user);
    await user.click(screen.getByRole("button", { name: /Undo — pull back from the cashier/ }));
    const dlg = screen.getByRole("dialog", { name: "Pull this bill back from the cashier?" });
    expect(within(dlg).getByText(/The visit goes back to unbilled/)).toBeInTheDocument();
    const ok = confirmIn(dlg, "Pull it back");
    expect(ok).toBeDisabled();
    await user.type(within(dlg).getByLabelText(/Why\?/), "   ");
    expect(ok).toBeDisabled();
    await user.clear(within(dlg).getByLabelText(/Why\?/));
    await user.type(within(dlg).getByLabelText(/Why\?/), " Sent the wrong visit ");
    await user.click(ok);
    await waitFor(() => expect(api.uncollectSession).toHaveBeenCalledWith("pat_1", "s1", "Sent the wrong visit"));
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith("Pulled back from the cashier"));
    expect(onChanged).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
  });

  test("REG-FE-VISITACT-009 the pull-back confirm stays busy while the request runs (no double cancel)", async () => {
    api.uncollectSession.mockReturnValue(new Promise(() => {}));
    const { user } = actions(S("s1", T, 1, "done", { payment: "billed" }));
    await openPanel(user);
    await user.click(screen.getByRole("button", { name: /Undo — pull back/ }));
    const dlg = screen.getByRole("dialog");
    await user.type(within(dlg).getByLabelText(/Why\?/), "Wrong visit");
    const ok = confirmIn(dlg, "Pull it back");
    await user.click(ok);
    await waitFor(() => expect(ok).toBeDisabled());
    await user.click(ok);
    expect(api.uncollectSession).toHaveBeenCalledTimes(1);
    expect(within(dlg).getByRole("button", { name: "Cancel" })).toBeDisabled();
  });

  test("REG-FE-VISITACT-010 the desk (collect only) cannot pull a bill back; a write-off holder can", async () => {
    const s = S("s1", T, 1, "done", { payment: "billed" });
    const first = actions(s, { editable: false, canCollect: true });
    await openPanel(first.user);
    expect(screen.queryByRole("button", { name: /Undo — pull back/ })).not.toBeInTheDocument();
    first.unmount();
    auth.perms = new Set(["payment.waive"]);
    const second = actions(s, { editable: false, canCollect: true });
    await openPanel(second.user);
    expect(screen.getByRole("button", { name: /Undo — pull back/ })).toBeInTheDocument();
  });

  test("REG-FE-VISITACT-011 read-only (collect only): money buttons, but no status, date or promise editors", async () => {
    const { user } = actions(S("s1", T, 1, "planned"), { editable: false });
    await openPanel(user);
    expect(screen.getByRole("button", { name: /Send 2,000 ETB/ })).toBeInTheDocument();
    expect(screen.queryByText("Status")).not.toBeInTheDocument();
    expect(screen.queryByText("Visit date")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Patient will pay later")).not.toBeInTheDocument();
  });

  test("REG-FE-VISITACT-012 record a pay-later promise: the note is trimmed and sent", async () => {
    api.setPayLater.mockResolvedValue({});
    const { user, onChanged } = actions(S("s1", T, 1, "done"));
    await openPanel(user);
    fireEvent.change(screen.getByLabelText("Patient will pay later"), { target: { value: "  End of the month " } });
    await user.click(screen.getByRole("button", { name: "Record the promise" }));
    await waitFor(() => expect(api.setPayLater).toHaveBeenCalledWith("pat_1", "s1", { on: true, note: "End of the month" }));
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith("Recorded as pay later"));
    expect(onChanged).toHaveBeenCalled();
  });

  test("REG-FE-VISITACT-013 the promise form is offered only for an unpaid visit with no promise yet", async () => {
    const { user, unmount } = actions(S("s1", T, 1, "done", { payment: "billed" }));
    await openPanel(user);
    expect(screen.queryByLabelText("Patient will pay later")).not.toBeInTheDocument();
    unmount();
    const again = actions(S("s1", T, 1, "done", { pay_later: true }));
    await openPanel(again.user);
    expect(screen.queryByLabelText("Patient will pay later")).not.toBeInTheDocument();
  });

  test("REG-FE-VISITACT-014 an existing promise is shown and can be cleared", async () => {
    const { user, onChanged } = actions(S("s1", T, 1, "done", { pay_later: true, pay_later_note: "Next visit" }));
    await openPanel(user);
    expect(screen.getByText("Promised: “Next visit”")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Clear the pay-later promise" }));
    await waitFor(() => expect(api.setPayLater).toHaveBeenCalledWith("pat_1", "s1", { on: false }));
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith("Promise cleared"));
    expect(onChanged).toHaveBeenCalled();
  });

  test("REG-FE-VISITACT-015 a promise without a note shows no quote", async () => {
    const { user } = actions(S("s1", T, 1, "done", { pay_later: true }));
    await openPanel(user);
    expect(screen.queryByText(/Promised:/)).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Clear the pay-later promise" })).toBeInTheDocument();
  });

  test("REG-FE-VISITACT-016 cancelling a planned visit is sent straight away, no reason asked", async () => {
    const { user, onChanged } = actions(S("s1", "2026-09-01", 1));
    await openPanel(user);
    await pickStatus(user, "Cancelled");
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    await waitFor(() => expect(api.updateSession).toHaveBeenCalledWith("pat_1", "s1", { status: "cancelled" }));
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith("Visit updated"));
    expect(onChanged).toHaveBeenCalled();
  });

  test("REG-FE-VISITACT-017 marking a visit booked for today done needs no confirmation", async () => {
    const { user } = actions(S("s1", T, 1));
    await openPanel(user);
    await pickStatus(user, "Done");
    await waitFor(() => expect(api.updateSession).toHaveBeenCalledWith("pat_1", "s1", { status: "done" }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  test("REG-FE-VISITACT-018 marking a FUTURE visit done asks first, naming the date and the fee that becomes owed", async () => {
    const { user, onChanged } = actions(S("s1", "2026-09-01", 1));
    await openPanel(user);
    await pickStatus(user, "Done");
    const dlg = screen.getByRole("dialog", { name: "Mark a future visit as done?" });
    expect(dlg).toHaveTextContent("This visit is booked for 2026-09-01, not today.");
    expect(dlg).toHaveTextContent("makes its 2,000 ETB fee owed straight away");
    expect(api.updateSession).not.toHaveBeenCalled();
    await user.click(confirmIn(dlg, "Mark it done"));
    await waitFor(() => expect(api.updateSession).toHaveBeenCalledWith("pat_1", "s1", { status: "done" }));
    expect(onChanged).toHaveBeenCalled();
  });

  test("REG-FE-VISITACT-019 backing out of the future-done question changes nothing", async () => {
    const { user } = actions(S("s1", "2026-09-01", 1));
    await openPanel(user);
    await pickStatus(user, "Done");
    await user.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(api.updateSession).not.toHaveBeenCalled();
    expect(statusSelect()).toHaveTextContent("Planned");
  });

  test("REG-FE-VISITACT-020 undoing a done visit warns the fee will no longer be owed and requires a reason", async () => {
    const { user } = actions(S("s1", "2026-08-01", 1, "done"));
    await openPanel(user);
    await pickStatus(user, "Planned");
    const dlg = screen.getByRole("dialog", { name: "Undo this visit?" });
    expect(dlg).toHaveTextContent("Its 2,000 ETB fee will no longer be owed.");
    expect(dlg).toHaveTextContent("the reason is kept");
    const ok = confirmIn(dlg, "Undo the visit");
    expect(ok).toBeDisabled();
    await user.type(within(dlg).getByLabelText(/Why\?/), "Recorded the wrong visit");
    await user.click(ok);
    await waitFor(() => expect(api.updateSession).toHaveBeenCalledWith("pat_1", "s1", { status: "planned", reason: "Recorded the wrong visit" }));
  });

  test("REG-FE-VISITACT-021 cancelling a done, paid visit asks with its own wording and no fee sentence", async () => {
    const { user } = actions(S("s1", "2026-08-01", 1, "done", { payment: "paid" }));
    await openPanel(user);
    await pickStatus(user, "Cancelled");
    const dlg = screen.getByRole("dialog", { name: "Cancel a visit that was given?" });
    expect(dlg).not.toHaveTextContent("will no longer be owed");
    await user.type(within(dlg).getByLabelText(/Why\?/), "Duplicate");
    await user.click(confirmIn(dlg, "Cancel the visit"));
    await waitFor(() => expect(api.updateSession).toHaveBeenCalledWith("pat_1", "s1", { status: "cancelled", reason: "Duplicate" }));
  });

  test("REG-FE-VISITACT-022 a refused status change is toasted with the server's words, or plainly", async () => {
    api.updateSession.mockRejectedValueOnce(new AppError(403, "forbidden", "Only the recording dentist can undo this"));
    const { user, unmount } = actions(S("s1", "2026-09-01", 1));
    await openPanel(user);
    await pickStatus(user, "Cancelled");
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith("Only the recording dentist can undo this"));
    unmount();
    api.updateSession.mockRejectedValueOnce(new TypeError("Failed to fetch"));
    const again = actions(S("s1", "2026-09-01", 1));
    await openPanel(again.user);
    await pickStatus(again.user, "Cancelled");
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith("Could not update the visit"));
    expect(toast.success).not.toHaveBeenCalled();
  });

  test("REG-FE-VISITACT-023 a planned visit's date can be moved; Save stays disabled until it changes", async () => {
    const { user, container, onChanged } = actions(S("s1", "2026-09-01", 1));
    await openPanel(user);
    expect(screen.getByText("Visit date")).toBeInTheDocument();
    const save = screen.getByRole("button", { name: "Save date" });
    expect(save).toBeDisabled();
    await user.click(screen.getByRole("button", { name: "Gregorian" }));
    fireEvent.change(container.querySelector('input[type="date"]')!, { target: { value: "2026-09-15" } });
    expect(save).toBeEnabled();
    await user.click(save);
    await waitFor(() => expect(api.updateSession).toHaveBeenCalledWith("pat_1", "s1", { scheduled_date: "2026-09-15" }));
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith("Date updated"));
    expect(onChanged).toHaveBeenCalled();
  });

  test("REG-FE-VISITACT-024 a cleared date cannot be saved; a done visit offers no date editor", async () => {
    const { user, container, unmount } = actions(S("s1", "2026-09-01", 1));
    await openPanel(user);
    await user.click(screen.getByRole("button", { name: "Gregorian" }));
    fireEvent.change(container.querySelector('input[type="date"]')!, { target: { value: "" } });
    expect(screen.getByRole("button", { name: "Save date" })).toBeDisabled();
    unmount();
    const done = actions(S("s1", "2026-08-01", 1, "done"));
    await openPanel(done.user);
    expect(screen.queryByText("Visit date")).not.toBeInTheDocument();
  });

  test("REG-FE-VISITACT-025 a visit at the cashier is not locked here: its status can still change and the bill can be pulled back", async () => {
    // UX-3 (notes locked while the bill is at the cashier) lives in the record form;
    // the corrections panel must not add a second lock on a billed visit.
    const { user } = actions(S("s1", T, 1, "done", { payment: "billed" }));
    await openPanel(user);
    expect(statusSelect()).toBeEnabled();
    expect(screen.getByRole("button", { name: /Undo — pull back/ })).toBeEnabled();
  });
});
