// Recording what was done at a visit. What matters: the save sends the right date
// (and only when it moves), the dentist is told loudly when the record is not dated
// today, a half-typed note survives a refetch or a mis-click, and an empty record
// cannot be saved.
import { screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

const api = vi.hoisted(() => ({ updateSession: vi.fn() }));
vi.mock("@/features/dental/api", async (orig) => ({ ...(await orig<object>()), ...api }));
vi.mock("@/lib/api-client", async (orig) => {
  const { quietApiFetch } = await import("@/test/render");
  return { ...(await orig<object>()), apiFetch: vi.fn(quietApiFetch) };
});
vi.mock("@/app/auth-context", () => ({
  useAuth: () => ({ can: () => true, flagOn: () => true, user: { id: "u1", full_name: "Dr Test" }, activeBranchId: null }),
}));

import { RecordVisitForm } from "@/features/dental/visit/RecordVisitForm";
import type { Session } from "@/features/dental/api";
import { freezeToday, renderUI } from "@/test/render";
import { S } from "./fixtures";

const T = "2026-08-12";

function form(session: Session, recordDate?: string, canCollect = true) {
  const onSaved = vi.fn(), onCancel = vi.fn(), onChanged = vi.fn();
  const r = renderUI(
    <RecordVisitForm patientId="pat_1" session={session} planTitle="Root canal" visitLabel="visit 2"
      recordDate={recordDate} teeth={{}} imageLimit={-1} canCollect={canCollect}
      onSaved={onSaved} onChanged={onChanged} onCancel={onCancel} />,
  );
  return { ...r, onSaved, onCancel };
}
const notes = () => screen.getByPlaceholderText(/Crown cemented/);
const saveBtn = () => screen.getByRole("button", { name: /Save & mark done/ });

describe("REG-FE-RECORD recording a visit", () => {
  beforeEach(() => {
    freezeToday(T);
    sessionStorage.clear();
    api.updateSession.mockReset();
    api.updateSession.mockResolvedValue({});
  });
  afterEach(() => vi.useRealTimers());

  test("REG-FE-RECORD-001 a planned visit recorded on another day sends status done and the new date in one request", async () => {
    const { user, onSaved } = form(S("s2", "2026-08-01", 2, "planned", { pay_later: true }), T);
    await user.type(notes(), "Canal shaped");
    await user.click(saveBtn());
    await waitFor(() => expect(api.updateSession).toHaveBeenCalledTimes(1));
    const [pid, sid, body] = api.updateSession.mock.calls[0];
    expect([pid, sid]).toEqual(["pat_1", "s2"]);
    expect(body).toEqual({ procedure: "", tooth: "", notes: "Canal shaped", status: "done", scheduled_date: T });
    await waitFor(() => expect(onSaved).toHaveBeenCalledTimes(1));
  });

  test("REG-FE-RECORD-002 recorded on its booked day: no scheduled_date is sent", async () => {
    const { user } = form(S("s2", T, 2, "planned", { pay_later: true }), T);
    await user.type(notes(), "x");
    await user.click(saveBtn());
    await waitFor(() => expect(api.updateSession).toHaveBeenCalledTimes(1));
    expect(api.updateSession.mock.calls[0][2]).not.toHaveProperty("scheduled_date");
  });

  test("REG-FE-RECORD-003 editing a visit already done never moves it", async () => {
    const { user } = form(S("s2", "2026-08-01", 2, "done", { notes: "Old note", payment: "paid" }), T);
    expect(notes()).toHaveValue("Old note");
    await user.type(notes(), " more");
    await user.click(saveBtn());
    await waitFor(() => expect(api.updateSession).toHaveBeenCalledTimes(1));
    expect(api.updateSession.mock.calls[0][2]).not.toHaveProperty("scheduled_date");
    expect(api.updateSession.mock.calls[0][2]).toMatchObject({ notes: "Old note more", status: "done" });
  });

  test("REG-FE-RECORD-004 backdated: says how many days ago, and that it is the booked date", () => {
    form(S("s2", "2026-08-01", 2, "done", { payment: "paid" }), T);
    expect(screen.getByText("You are recording a visit from 11 days ago — not today.")).toBeInTheDocument();
    expect(screen.getByText(/It is saved as/)).toHaveTextContent(/the date it was booked for\.$/);
  });

  test("REG-FE-RECORD-005 backdated to yesterday by choice: 'from yesterday', not the booked date", () => {
    form(S("s2", "2026-08-01", 2, "planned", { pay_later: true }), "2026-08-11");
    expect(screen.getByText("You are recording a visit from yesterday — not today.")).toBeInTheDocument();
    expect(screen.getByText(/It is saved as/)).not.toHaveTextContent("booked for");
  });

  test("REG-FE-RECORD-006 a visit booked ahead and no record date: warns it is for a later date", () => {
    form(S("s2", "2026-08-20", 2, "planned", { pay_later: true }));
    expect(screen.getByText("You are recording a visit booked for a later date — not today.")).toBeInTheDocument();
  });

  test("REG-FE-RECORD-007 recorded today: no warning", () => {
    form(S("s2", "2026-08-01", 2, "planned", { pay_later: true }), T);
    expect(screen.queryByText(/not today\./)).not.toBeInTheDocument();
  });

  test("REG-FE-RECORD-008 the typed note is kept as a draft and restored when the form reopens", async () => {
    const session = S("s2", T, 2, "planned", { pay_later: true });
    const { user, unmount } = form(session, T);
    await user.type(notes(), "Half way through");
    await waitFor(() => expect(sessionStorage.getItem("dental-draft:s2")).not.toBeNull(), { timeout: 3000 });
    expect(JSON.parse(sessionStorage.getItem("dental-draft:s2")!)).toMatchObject({ notes: "Half way through" });
    unmount();

    form(session, T);
    expect(await screen.findByText(/Draft restored/)).toBeInTheDocument();
    expect(notes()).toHaveValue("Half way through");
  });

  test("REG-FE-RECORD-009 nothing typed yet: no draft and no 'restored' banner", async () => {
    form(S("s2", T, 2, "planned", { pay_later: true }), T);
    await new Promise((r) => setTimeout(r, 900));
    expect(sessionStorage.getItem("dental-draft:s2")).toBeNull();
    expect(screen.queryByText(/Draft restored/)).not.toBeInTheDocument();
  });

  test("REG-FE-RECORD-010 a successful save clears the draft", async () => {
    sessionStorage.setItem("dental-draft:s2", JSON.stringify({ procedure: [], tooth: [], notes: "Earlier" }));
    const { user } = form(S("s2", T, 2, "planned", { pay_later: true }), T);
    expect(await screen.findByText(/Draft restored/)).toBeInTheDocument();
    await user.click(saveBtn());
    await waitFor(() => expect(sessionStorage.getItem("dental-draft:s2")).toBeNull());
  });

  test("REG-FE-RECORD-017 a draft save still pending when the visit is recorded does not bring the draft back (NEW-DRAFT-1)", async () => {
    sessionStorage.setItem("dental-draft:s2", JSON.stringify({ procedure: [], tooth: [], notes: "Earlier" }));
    const { user } = form(S("s2", T, 2, "planned", { pay_later: true }), T);
    expect(await screen.findByText(/Draft restored/)).toBeInTheDocument();
    // Save at once, while the 800 ms draft timer from the restore is still pending.
    await user.click(saveBtn());
    await waitFor(() => expect(sessionStorage.getItem("dental-draft:s2")).toBeNull());
    // Past the moment the pending timer would have fired: still no draft.
    await new Promise((r) => setTimeout(r, 1000));
    expect(sessionStorage.getItem("dental-draft:s2")).toBeNull();
  });

  test("REG-FE-RECORD-011 a failed save keeps the form open and does not report saved", async () => {
    api.updateSession.mockRejectedValue(new Error("boom"));
    const { user, onSaved } = form(S("s2", T, 2, "planned", { pay_later: true }), T);
    await user.type(notes(), "x");
    await user.click(saveBtn());
    await waitFor(() => expect(api.updateSession).toHaveBeenCalled());
    expect(onSaved).not.toHaveBeenCalled();
    expect(notes()).toHaveValue("x");
  });

  test("REG-FE-RECORD-012 Cancel with nothing typed closes at once", async () => {
    const { user, onCancel } = form(S("s2", T, 2, "planned", { pay_later: true }), T);
    await user.click(screen.getByRole("button", { name: /Cancel/ }));
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  test("REG-FE-RECORD-013 Cancel with typed text asks first, and the draft is already saved when it asks", async () => {
    const { user, onCancel } = form(S("s2", T, 2, "planned", { pay_later: true }), T);
    await user.type(notes(), "Do not lose me");
    await user.click(screen.getByRole("button", { name: /Cancel/ }));
    const dlg = await screen.findByRole("dialog");
    expect(within(dlg).getByText("Close without recording?")).toBeInTheDocument();
    expect(onCancel).not.toHaveBeenCalled();
    expect(JSON.parse(sessionStorage.getItem("dental-draft:s2")!)).toMatchObject({ notes: "Do not lose me" });
    // The confirming verb, not the dialog's own X (also labelled "Close").
    await user.click(within(dlg).getAllByRole("button", { name: "Close" }).find((b) => b.textContent === "Close")!);
    await waitFor(() => expect(onCancel).toHaveBeenCalledTimes(1));
  });

  test("REG-FE-RECORD-014 an empty record cannot be saved and says what is missing", () => {
    form(S("s2", T, 2, "planned", { pay_later: true }), T);
    expect(saveBtn()).toBeDisabled();
    expect(screen.getByText(/Add a tooth, a procedure or a note before finishing\./)).toBeInTheDocument();
  });

  test("REG-FE-RECORD-015 the line under Save says whether the fee was paid or promised", () => {
    const { unmount } = form(S("s2", T, 2, "planned", { payment: "paid" }), T);
    expect(screen.getByText(/Fee 2,000 ETB — paid\./)).toBeInTheDocument();
    unmount();
    form(S("s2", T, 2, "planned", { pay_later: true }), T);
    expect(screen.getByText(/Fee 2,000 ETB — owed; the patient pays later\./)).toBeInTheDocument();
  });

  test("REG-FE-RECORD-016 the header names the visit the way the card does", () => {
    form(S("s2", T, 2, "planned", { pay_later: true }), T);
    expect(screen.getByText(/Recording visit 2 · Root canal/)).toBeInTheDocument();
  });

  // --- an extra added at the chair that nobody has paid for -------------------------

  const withExtras = (extras: unknown[]) =>
    S("s2", T, 2, "planned", { pay_later: true, extras } as Partial<Session>);
  const xray = { id: "ex1", amount_due: "2000", payment: "unpaid", status: "done", service_name: "X-ray" };

  test("REG-FE-RECORD-040 finishing with an unpaid extra stops once and asks; Finish anyway then saves", async () => {
    const { user, onSaved } = form(withExtras([xray]), T);
    await user.type(notes(), "Canal shaped");
    await user.click(saveBtn());
    const dlg = await screen.findByRole("dialog");
    expect(dlg).toHaveTextContent("1 extra has not been paid");
    expect(api.updateSession).not.toHaveBeenCalled();
    await user.click(within(dlg).getByRole("button", { name: /Finish anyway/ }));
    await waitFor(() => expect(api.updateSession).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(onSaved).toHaveBeenCalledTimes(1));
  });

  test("REG-FE-RECORD-041 an extra already paid, on a promise, or free does not stop the save", async () => {
    const paid = { ...xray, id: "p", payment: "paid" };
    const promised = { ...xray, id: "q", pay_later: true };
    const free = { ...xray, id: "r", amount_due: "0" };
    const { user } = form(withExtras([paid, promised, free]), T);
    await user.type(notes(), "x");
    await user.click(saveBtn());
    await waitFor(() => expect(api.updateSession).toHaveBeenCalledTimes(1));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  test("REG-FE-RECORD-042 closing the stop saves nothing and leaves the form as it was", async () => {
    const { user } = form(withExtras([xray]), T);
    await user.type(notes(), "Canal shaped");
    await user.click(saveBtn());
    await screen.findByRole("dialog");
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(api.updateSession).not.toHaveBeenCalled();
    expect(notes()).toHaveValue("Canal shaped");
  });
});
