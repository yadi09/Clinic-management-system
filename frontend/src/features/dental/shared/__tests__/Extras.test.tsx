// "Also done at this visit": unplanned procedures priced from the clinic's list, and
// — the part that matters at the chair — whether each has been paid for.
// Covered: what each extra shows at each stage (not billed, at the cashier, paid, on
// a promise, free), sending it to the cashier, taking it back, treating now and paying
// later (with a reason), taking the money in place, the clinic's one-tap usual extras,
// the totals line, adding and removing, and the gentle stop when a visit is finished
// with something unpaid. The service picker and the payment step have their own tests;
// here they are stubs.
import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, onTestFinished, test, vi } from "vitest";

const auth = vi.hoisted(() => ({ perms: new Set<string>() }));
vi.mock("@/app/auth-context", () => ({
  useAuth: () => ({ can: (p: string) => auth.perms.has(p), flagOn: () => true, user: { id: "u1", full_name: "Dr" }, activeBranchId: null }),
}));
const api = vi.hoisted(() => ({
  addExtra: vi.fn(), collectSession: vi.fn(), collectSessions: vi.fn(), removeExtra: vi.fn(), setPayLater: vi.fn(),
  uncollectSession: vi.fn(), dentalSummary: vi.fn(), popularExtras: vi.fn(),
}));
const billing = vi.hoisted(() => ({ settleVisit: vi.fn() }));
const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }));
vi.mock("@/features/dental/api", async (orig) => ({ ...(await orig<object>()), ...api }));
vi.mock("@/features/billing/api", async (orig) => ({ ...(await orig<object>()), ...billing }));
vi.mock("sonner", async (orig) => ({ ...(await orig<object>()), toast }));
vi.mock("@/features/billing/PaymentRail", () => ({
  EMPTY_PAYMENT: { railId: "", method: "cash", reference: "" },
  usePaymentRails: () => ({ data: [{ id: "rl_cash", key: "cash", label: "Cash", kind: "cash" }] }),
  PaymentRailPicker: ({ value, onChange }: { value: { railId: string; method: string }; onChange: (v: unknown) => void }) => (
    <div>
      <span data-testid="rail">{value.railId}/{value.method}</span>
      <button type="button" onClick={() => onChange({ ...value, check: { state: "rejected" } })}>reject the transfer</button>
    </div>
  ),
  PaymentRefused: ({ canOverride, onForce }: { canOverride: boolean; onForce: () => void }) => (
    canOverride ? <button type="button" onClick={onForce}>Take it anyway</button> : <span>Refused</span>
  ),
  paymentBlocked: (c: { check?: { state: string } }) => c.check?.state === "rejected",
  paymentIncomplete: () => false,
}));
vi.mock("@/features/dental/shared/ServicePicker", () => ({
  ServicePicker: ({ value, onPick, onFreeText, placeholder }: {
    value: string; onPick: (s: { id: string; name: string; price: string } | null) => void; onFreeText: (n: string) => void; placeholder?: string;
  }) => (
    <div>
      <span data-testid="picker-value">{value || placeholder}</span>
      <button type="button" onClick={() => onPick({ id: "svc_xray", name: "X-ray", price: "2000" })}>pick X-ray</button>
      <button type="button" onClick={() => onPick(null)}>clear pick</button>
      <button type="button" onClick={() => onFreeText("Something new")}>type free text</button>
    </div>
  ),
}));

import { ExtrasSection, UnpaidExtrasStop, extraStage, extrasTotal, unsettledExtras } from "@/features/dental/shared/Extras";
import { AppError } from "@/lib/api-client";
import type { Extra, Session } from "@/features/dental/api";
import { renderUI } from "@/test/render";
import { S } from "../../visit/__tests__/fixtures";

const T = "2026-08-12";
const EX = (id: string, extra: Record<string, unknown> = {}) =>
  ({ id, amount_due: "2000", payment: "unpaid", status: "done", service_name: "X-ray", ...extra });
const visit = (extras: unknown[] = []) => S("s3", T, 3, "done", { extras } as Partial<Session>);

function extras(session: Session, { editable = true, canCollect = true } = {}) {
  return renderUI(<ExtrasSection patientId="pat_1" session={session} editable={editable} canCollect={canCollect} />);
}
const row = (name: string) => screen.getByText(name).closest("div.rounded-lg") as HTMLElement;
const confirmIn = (dlg: HTMLElement, name: string) =>
  within(dlg).getAllByRole("button", { name }).find((b) => b.textContent === name)!;
const muteUnhandled = () => {
  const saved = process.listeners("unhandledRejection");
  process.removeAllListeners("unhandledRejection");
  process.on("unhandledRejection", () => {});
  onTestFinished(() => {
    process.removeAllListeners("unhandledRejection");
    saved.forEach((l) => process.on("unhandledRejection", l));
  });
};

describe("REG-FE-SHARED extras done at a visit", () => {
  beforeEach(() => {
    Object.values(api).forEach((f) => { f.mockReset(); f.mockResolvedValue({}); });
    api.popularExtras.mockResolvedValue([]);
    billing.settleVisit.mockReset();
    billing.settleVisit.mockResolvedValue({ receipt_no: 9, total: "2000", count: 1 });
    Object.values(toast).forEach((f) => f.mockReset());
    auth.perms = new Set(["dental.manage", "payment.charge"]);
  });

  test("REG-FE-SHARED-042 extrasTotal adds the visit's extras (none is zero)", () => {
    expect(extrasTotal(visit([EX("a"), EX("b", { amount_due: "500.5" })]))).toBe(2500.5);
    expect(extrasTotal(S("s", T, 1))).toBe(0);
  });

  test("REG-FE-SHARED-043 a reviewed visit with no extras shows nothing at all", () => {
    extras(visit(), { editable: false });
    expect(screen.queryByText("Also done at this visit")).not.toBeInTheDocument();
  });

  test("REG-FE-SHARED-044 an editable visit with no extras says so and offers Other…", () => {
    extras(visit());
    expect(screen.getByText("Also done at this visit")).toBeInTheDocument();
    expect(screen.getByText(/Nothing extra — this visit is what the treatment planned\./)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Other…/ })).toBeInTheDocument();
  });

  test("REG-FE-SHARED-045 each extra shows its stage in words; a free one reads 'Included in the course'", () => {
    extras(visit([
      EX("a", { service_name: "Unbilled" }), EX("b", { payment: "billed", service_name: "Filling" }),
      EX("c", { payment: "paid", service_name: "Scaling" }), EX("d", { payment: "waived", service_name: "Polish" }),
      EX("e", { payment: "refunded", service_name: "Crown" }),
      EX("f", { amount_due: "0", service_name: "" }),
      EX("g", { pay_later: true, pay_later_note: "Staff", service_name: "Whitening" }),
    ]), { editable: false });
    expect(screen.getByText("7")).toBeInTheDocument();
    expect(within(row("Filling")).getByRole("status")).toHaveTextContent("Waiting for the patient to pay at the cashier");
    expect(within(row("Scaling")).getByText("✓ Paid — go ahead")).toBeInTheDocument();
    expect(within(row("Polish")).getByText("✓ Paid — go ahead")).toBeInTheDocument();
    expect(within(row("Crown")).getByText("Refunded — owed again")).toBeInTheDocument();
    expect(within(row("Whitening")).getByText(/Treated now — owed after this visit: Staff/)).toBeInTheDocument();
    expect(within(row("Unbilled")).getByText("Not billed")).toBeInTheDocument();
    // Once billed, the first stop reads as done: "Billed", not "Not billed".
    expect(within(row("Filling")).getByText("Billed")).toBeInTheDocument();
    expect(within(row("Whitening")).getByText("Pay later")).toBeInTheDocument();
    expect(screen.getByText("Procedure")).toBeInTheDocument();
    expect(screen.getByText("Included in the course")).toBeInTheDocument();
    // Read-only: no add, no remove, no pay-later.
    expect(screen.queryByRole("button", { name: /Other…/ })).not.toBeInTheDocument();
    expect(screen.queryByTitle("Remove this extra")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /pay later/i })).not.toBeInTheDocument();
  });

  test("REG-FE-SHARED-046 the stage of an extra, and which are still unsettled", () => {
    const e = (over: Partial<Extra>) => ({ id: "x", amount_due: "100", payment: "unpaid", status: "done", ...over }) as Extra;
    expect(extraStage(e({ amount_due: "0" }))).toBe("free");
    expect(extraStage(e({ payment: "paid" }))).toBe("paid");
    expect(extraStage(e({ payment: "waived" }))).toBe("paid");
    expect(extraStage(e({ payment: "billed" }))).toBe("atCashier");
    expect(extraStage(e({ pay_later: true }))).toBe("promised");
    expect(extraStage(e({}))).toBe("unpaid");
    const v = visit([EX("a"), EX("b", { payment: "billed" }), EX("c", { payment: "paid" }), EX("d", { pay_later: true }), EX("e", { amount_due: "0" })]);
    expect(unsettledExtras(v).map((x) => x.id)).toEqual(["a", "b"]);
  });

  test("REG-FE-SHARED-047 Send to cashier for money not yet billed, only with billing permission", () => {
    const list = [EX("a"), EX("b", { payment: "refunded" }), EX("c", { payment: "billed" }), EX("d", { payment: "paid" }), EX("e", { amount_due: "0" }),
      EX("f", { pay_later: true })];
    const { unmount } = extras(visit(list));
    // Unbilled, refunded and on-a-promise each offer it; at the cashier and paid do not.
    expect(screen.getAllByRole("button", { name: /Send to cashier/ })).toHaveLength(3);
    unmount();
    extras(visit(list), { canCollect: false });
    expect(screen.queryByRole("button", { name: /Send to cashier/ })).not.toBeInTheDocument();
  });

  test("REG-FE-SHARED-048 Send to cashier bills that extra, says so, and refreshes", async () => {
    const { user, qc } = extras(visit([EX("a"), EX("b", { service_name: "Filling" })]));
    const inv = vi.spyOn(qc, "invalidateQueries");
    await user.click(within(row("Filling")).getByRole("button", { name: /Send to cashier/ }));
    await waitFor(() => expect(api.collectSession).toHaveBeenCalledWith("pat_1", "b"));
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith("Sent to the cashier"));
    expect(inv).toHaveBeenCalledWith({ queryKey: ["dental-summary", "pat_1"] });
  });

  test("REG-FE-SHARED-049 a refused send says why (or a fallback)", async () => {
    api.collectSession.mockRejectedValueOnce(new AppError(409, "C", "Already billed")).mockRejectedValueOnce(new Error("x"));
    const { user } = extras(visit([EX("a")]));
    await user.click(screen.getByRole("button", { name: /Send to cashier/ }));
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith("Already billed"));
    await user.click(screen.getByRole("button", { name: /Send to cashier/ }));
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith("Could not send it to the cashier"));
  });

  test("REG-FE-SHARED-050 only an unbilled extra on no promise can be removed", () => {
    extras(visit([EX("a"), EX("b", { payment: "billed" }), EX("c", { payment: "paid" }), EX("d", { payment: "refunded" }), EX("e", { pay_later: true })]));
    expect(screen.getAllByTitle("Remove this extra")).toHaveLength(2);
  });

  test("REG-FE-SHARED-051 removing asks first, naming what stops being owed, then removes it", async () => {
    const { user } = extras(visit([EX("a")]));
    await user.click(screen.getByTitle("Remove this extra"));
    const dlg = await screen.findByRole("dialog");
    expect(within(dlg).getByText("Remove X-ray?")).toBeInTheDocument();
    expect(within(dlg).getByText(/It will no longer be owed/)).toHaveTextContent("It will no longer be owed — 2,000 ETB. Use this only if it was added by mistake.");
    await user.click(confirmIn(dlg, "Remove"));
    await waitFor(() => expect(api.removeExtra).toHaveBeenCalledWith("pat_1", "a"));
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith("Extra removed"));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
  });

  test("REG-FE-SHARED-052 removing a free, unnamed extra: no amount in the question; Cancel keeps it", async () => {
    const { user } = extras(visit([EX("a", { amount_due: "0", service_name: "" })]));
    await user.click(screen.getByTitle("Remove this extra"));
    const dlg = await screen.findByRole("dialog");
    expect(within(dlg).getByText("Remove this extra?")).toBeInTheDocument();
    expect(within(dlg).getByText(/It will no longer be owed/)).toHaveTextContent("It will no longer be owed. Use this only");
    await user.click(within(dlg).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(api.removeExtra).not.toHaveBeenCalled();
  });

  test("REG-FE-SHARED-053 a refused removal says why (or a fallback)", async () => {
    muteUnhandled();
    api.removeExtra.mockRejectedValueOnce(new AppError(409, "C", "It is at the cashier")).mockRejectedValueOnce(new Error("x"));
    const { user } = extras(visit([EX("a")]));
    for (const msg of ["It is at the cashier", "Could not remove it"]) {
      if (!screen.queryByRole("dialog")) await user.click(screen.getByTitle("Remove this extra"));
      await user.click(confirmIn(await screen.findByRole("dialog"), "Remove"));
      await waitFor(() => expect(toast.error).toHaveBeenCalledWith(msg));
    }
    expect(toast.success).not.toHaveBeenCalled();
  });

  test("REG-FE-SHARED-054 adding: nothing can be added until a procedure is picked, and the list price is filled in", async () => {
    const { user } = extras(visit());
    await user.click(screen.getByRole("button", { name: /Other…/ }));
    // The header's button hides while the form is open, and so does the empty line.
    expect(screen.queryByRole("button", { name: /Other…/ })).not.toBeInTheDocument();
    expect(screen.queryByText(/Nothing extra/)).not.toBeInTheDocument();
    expect(screen.getByTestId("picker-value")).toHaveTextContent("Choose a procedure");
    const addBtn = screen.getByRole("button", { name: "Add to this visit" });
    expect(addBtn).toBeDisabled();
    await user.click(screen.getByRole("button", { name: "pick X-ray" }));
    expect(screen.getByTestId("picker-value")).toHaveTextContent("X-ray");
    expect(screen.getByLabelText("Charge (ETB)")).toHaveValue(2000);
    expect(addBtn).toBeEnabled();
  });

  test("REG-FE-SHARED-055 a changed price is pointed out and sent; zero means included in the course", async () => {
    const { user } = extras(visit());
    await user.click(screen.getByRole("button", { name: /Other…/ }));
    await user.click(screen.getByRole("button", { name: "pick X-ray" }));
    const price = screen.getByLabelText("Charge (ETB)");
    fireEvent.change(price, { target: { value: "0" } });
    expect(screen.getByText(/Zero means/)).toHaveTextContent("Zero means included in the course — recorded, not billed.");
    fireEvent.change(price, { target: { value: "2500" } });
    expect(screen.getByText("The list says 2,000 ETB.")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Add to this visit" }));
    await waitFor(() => expect(api.addExtra).toHaveBeenCalledWith("pat_1", "s3", { service_id: "svc_xray", amount: "2500" }));
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith("X-ray added to this visit"));
    await waitFor(() => expect(screen.queryByRole("button", { name: "Add to this visit" })).not.toBeInTheDocument());
    await user.click(screen.getByRole("button", { name: /Other…/ }));
    expect(screen.getByTestId("picker-value")).toHaveTextContent("Choose a procedure");
    expect(screen.getByLabelText("Charge (ETB)")).toHaveValue(null);
  });

  test("REG-FE-SHARED-056 a blank price is not sent, so the server prices from its own list", async () => {
    const { user } = extras(visit());
    await user.click(screen.getByRole("button", { name: /Other…/ }));
    await user.click(screen.getByRole("button", { name: "pick X-ray" }));
    fireEvent.change(screen.getByLabelText("Charge (ETB)"), { target: { value: "" } });
    await user.click(screen.getByRole("button", { name: "Add to this visit" }));
    await waitFor(() => expect(api.addExtra).toHaveBeenCalledWith("pat_1", "s3", { service_id: "svc_xray", amount: undefined }));
  });

  test("REG-FE-SHARED-057 a typed name that is not on the list is refused with a hint", async () => {
    const { user } = extras(visit());
    await user.click(screen.getByRole("button", { name: /Other…/ }));
    await user.click(screen.getByRole("button", { name: "type free text" }));
    expect(toast.error).toHaveBeenCalledWith("Pick it from the clinic's list, or add it to the list first");
    expect(screen.getByRole("button", { name: "Add to this visit" })).toBeDisabled();
  });

  test("REG-FE-SHARED-058 clearing the pick disables Add again and empties the price; Cancel closes without adding", async () => {
    const { user } = extras(visit());
    await user.click(screen.getByRole("button", { name: /Other…/ }));
    await user.click(screen.getByRole("button", { name: "pick X-ray" }));
    await user.click(screen.getByRole("button", { name: "clear pick" }));
    expect(screen.getByRole("button", { name: "Add to this visit" })).toBeDisabled();
    expect(screen.getByLabelText("Charge (ETB)")).toHaveValue(null);
    await user.click(screen.getByRole("button", { name: "pick X-ray" }));
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("button", { name: "Add to this visit" })).not.toBeInTheDocument();
    expect(api.addExtra).not.toHaveBeenCalled();
  });

  test("REG-FE-SHARED-059 a refused add says why (or a fallback) and keeps the form", async () => {
    api.addExtra.mockRejectedValueOnce(new AppError(400, "V", "Service is inactive")).mockRejectedValueOnce(new Error("x"));
    const { user } = extras(visit());
    await user.click(screen.getByRole("button", { name: /Other…/ }));
    await user.click(screen.getByRole("button", { name: "pick X-ray" }));
    await user.click(screen.getByRole("button", { name: "Add to this visit" }));
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith("Service is inactive"));
    await user.click(screen.getByRole("button", { name: "Add to this visit" }));
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith("Could not add it"));
    expect(screen.getByTestId("picker-value")).toHaveTextContent("X-ray");
  });

  // --- the sequence -------------------------------------------------------------

  test("REG-FE-SHARED-060 the clinic's usual extras are one tap each, at the list price", async () => {
    api.popularExtras.mockResolvedValue([
      { service_id: "svc_xray", name: "X-ray", price: "2000.00", uses: 9 },
      { service_id: "svc_scale", name: "Scaling", price: "800.00", uses: 4 },
    ]);
    const { user } = extras(visit());
    const chips = await screen.findByRole("group", { name: "Usual extras" });
    expect(within(chips).getByRole("button", { name: /\+ Scaling\s*800/ })).toBeInTheDocument();
    await user.click(within(chips).getByRole("button", { name: /\+ X-ray/ }));
    await waitFor(() => expect(api.addExtra).toHaveBeenCalledWith("pat_1", "s3", { service_id: "svc_xray", amount: undefined }));
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith("X-ray added to this visit"));
  });

  test("REG-FE-SHARED-061 no chips on a reviewed visit or when the clinic has none yet", async () => {
    api.popularExtras.mockResolvedValue([{ service_id: "svc_xray", name: "X-ray", price: "2000.00", uses: 9 }]);
    const { unmount } = extras(visit(), { editable: false });
    expect(screen.queryByRole("group", { name: "Usual extras" })).not.toBeInTheDocument();
    unmount();
    api.popularExtras.mockResolvedValue([]);
    extras(visit());
    await waitFor(() => expect(api.popularExtras).toHaveBeenCalled());
    expect(screen.queryByRole("group", { name: "Usual extras" })).not.toBeInTheDocument();
  });

  test("REG-FE-SHARED-062 the totals line adds up each stage, and Send all bills every unbilled extra at once", async () => {
    const { user } = extras(visit([
      EX("a", { service_name: "X-ray" }), EX("b", { service_name: "Cleaning", amount_due: "500" }),
      EX("c", { service_name: "Filling", payment: "billed", amount_due: "800" }),
      EX("d", { service_name: "Scaling", payment: "paid", amount_due: "1500" }),
      EX("e", { service_name: "Whitening", pay_later: true, amount_due: "300" }),
    ]));
    const line = screen.getByText(/Extras:/).parentElement!;
    expect(line).toHaveTextContent("Extras: 5,100 ETB · 1,500 ETB paid · 800 ETB at cashier · 300 ETB pay later · 2,500 ETB not billed");
    await user.click(screen.getByRole("button", { name: /Send all to cashier/ }));
    await waitFor(() => expect(api.collectSessions).toHaveBeenCalledWith("pat_1", ["a", "b"]));
    api.collectSessions.mockResolvedValue({ billed: 2, total: "2500" });
  });

  test("REG-FE-SHARED-063 Send all names how many went, and says why when it fails; one unbilled extra has no Send all", async () => {
    api.collectSessions.mockResolvedValueOnce({ billed: 2, total: "2500" }).mockRejectedValueOnce(new Error("x"));
    const { user } = extras(visit([EX("a"), EX("b")]));
    await user.click(screen.getByRole("button", { name: /Send all to cashier/ }));
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith("2 sent to the cashier"));
    await user.click(screen.getByRole("button", { name: /Send all to cashier/ }));
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith("Could not send them to the cashier"));
  });

  test("REG-FE-SHARED-064 one unbilled extra has its own button and no Send all", () => {
    extras(visit([EX("a"), EX("b", { payment: "paid" })]));
    expect(screen.queryByRole("button", { name: /Send all to cashier/ })).not.toBeInTheDocument();
  });

  test("REG-FE-SHARED-065 Treat now, pay later needs a reason, keeps it, and says the money stays owed", async () => {
    const { user } = extras(visit([EX("a", { service_name: "Scaling", amount_due: "800" })]));
    await user.click(screen.getByRole("button", { name: /Treat now, pay later/ }));
    const dlg = await screen.findByRole("dialog");
    expect(dlg).toHaveTextContent("stays owed");
    expect(dlg).toHaveTextContent("800 ETB");
    const go = within(dlg).getByRole("button", { name: "Treat now, bill later" });
    expect(go).toBeDisabled();
    await user.type(within(dlg).getByRole("textbox"), "Emergency: pain");
    await user.click(go);
    await waitFor(() => expect(api.setPayLater).toHaveBeenCalledWith("pat_1", "a", { on: true, note: "Emergency: pain" }));
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith("Treated now — still owed"));
  });

  test("REG-FE-SHARED-066 a promise can be undone, and a failed promise says so", async () => {
    muteUnhandled();
    const { user } = extras(visit([EX("a", { service_name: "Whitening", pay_later: true, pay_later_note: "Salary" })]));
    await user.click(screen.getByRole("button", { name: /Undo/ }));
    await waitFor(() => expect(api.setPayLater).toHaveBeenCalledWith("pat_1", "a", { on: false, note: "" }));
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith("Promise removed"));
    api.setPayLater.mockRejectedValueOnce(new AppError(409, "C", "Not allowed")).mockRejectedValueOnce(new Error("x"));
    await user.click(screen.getByRole("button", { name: /Undo/ }));
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith("Not allowed"));
    await user.click(screen.getByRole("button", { name: /Undo/ }));
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith("Could not remove it"));
  });

  test("REG-FE-SHARED-067 at the cashier: says it is waiting, and can be taken back with a reason", async () => {
    const { user } = extras(visit([EX("a", { service_name: "Filling", payment: "billed" })]));
    expect(screen.getByRole("status")).toHaveTextContent("Waiting for the patient to pay at the cashier — this updates by itself");
    await user.click(screen.getByRole("button", { name: /Take back/ }));
    const dlg = await screen.findByRole("dialog");
    const go = within(dlg).getByRole("button", { name: "Take it back" });
    expect(go).toBeDisabled();
    await user.type(within(dlg).getByRole("textbox"), "Sent by mistake");
    await user.click(go);
    await waitFor(() => expect(api.uncollectSession).toHaveBeenCalledWith("pat_1", "a", "Sent by mistake"));
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith("Taken back from the cashier"));
  });

  test("REG-FE-SHARED-068 while something is at the cashier the chair re-reads every few seconds, and stops when nothing is", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    try {
      const { qc, unmount } = extras(visit([EX("a", { payment: "billed" })]));
      const inv = vi.spyOn(qc, "invalidateQueries");
      act(() => { vi.advanceTimersByTime(6100); });
      expect(inv).toHaveBeenCalledWith({ queryKey: ["dental-summary", "pat_1"] });
      unmount();
      const { qc: qc2 } = extras(visit([EX("a")]));
      const inv2 = vi.spyOn(qc2, "invalidateQueries");
      act(() => { vi.advanceTimersByTime(20_000); });
      expect(inv2).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  test("REG-FE-SHARED-069 Take back, and Pay later, are offered to those who may and not to read-only viewers", () => {
    extras(visit([EX("a", { payment: "billed" })]), { editable: false, canCollect: false });
    expect(screen.queryByRole("button", { name: /Take back/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Pay later/ })).not.toBeInTheDocument();
    expect(screen.getByRole("status")).toBeInTheDocument();
  });

  test("REG-FE-SHARED-070 Collect here is only for a person who may take money", () => {
    extras(visit([EX("a")]));
    expect(screen.queryByRole("button", { name: /Collect here/ })).not.toBeInTheDocument();
  });

  test("REG-FE-SHARED-071 Collect here bills an unbilled extra and then takes the money against that bill", async () => {
    auth.perms = new Set(["dental.manage", "payment.charge", "payment.collect"]);
    api.dentalSummary.mockResolvedValue({
      plans: [{ sessions: [{ extras: [{ id: "a", charge_id: "chg_77" }] }] }],
    });
    const { user } = extras(visit([EX("a", { service_name: "X-ray" })]));
    await user.click(screen.getByRole("button", { name: /Collect here/ }));
    const dlg = await screen.findByRole("dialog");
    expect(dlg).toHaveTextContent("Take payment for X-ray");
    expect(within(dlg).getByTestId("rail")).toHaveTextContent("rl_cash/cash");
    await user.click(within(dlg).getByRole("button", { name: /^Take 2,000 ETB/ }));
    await waitFor(() => expect(api.collectSession).toHaveBeenCalledWith("pat_1", "a"));
    await waitFor(() => expect(billing.settleVisit).toHaveBeenCalledWith("pat_1", expect.objectContaining({
      rail_id: "rl_cash", method: "cash", charge_ids: ["chg_77"], force: false,
    })));
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith("X-ray paid · receipt RCP-000009"));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
  });

  test("REG-FE-SHARED-072 Collect here on an extra already at the cashier uses its bill without billing again", async () => {
    auth.perms = new Set(["dental.manage", "payment.charge", "payment.collect"]);
    const { user } = extras(visit([EX("a", { payment: "billed", charge_id: "chg_5" })]));
    await user.click(screen.getByRole("button", { name: /Collect here/ }));
    await user.click(within(await screen.findByRole("dialog")).getByRole("button", { name: /^Take/ }));
    await waitFor(() => expect(billing.settleVisit).toHaveBeenCalledWith("pat_1", expect.objectContaining({ charge_ids: ["chg_5"] })));
    expect(api.collectSession).not.toHaveBeenCalled();
  });

  test("REG-FE-SHARED-073 a payment the bank contradicts cannot be taken; a manager's override is sent as force", async () => {
    auth.perms = new Set(["dental.manage", "payment.collect", "payment.waive"]);
    const { user } = extras(visit([EX("a", { payment: "billed", charge_id: "chg_5" })]));
    await user.click(screen.getByRole("button", { name: /Collect here/ }));
    const dlg = await screen.findByRole("dialog");
    await user.click(within(dlg).getByRole("button", { name: "reject the transfer" }));
    expect(within(dlg).queryByRole("button", { name: /^Take 2,000/ })).not.toBeInTheDocument();
    await user.click(within(dlg).getByRole("button", { name: "Take it anyway" }));
    await waitFor(() => expect(billing.settleVisit).toHaveBeenCalledWith("pat_1", expect.objectContaining({ force: true })));
  });

  test("REG-FE-SHARED-074 without the override permission a contradicted payment is only refused", async () => {
    auth.perms = new Set(["dental.manage", "payment.collect"]);
    const { user } = extras(visit([EX("a", { payment: "billed", charge_id: "chg_5" })]));
    await user.click(screen.getByRole("button", { name: /Collect here/ }));
    const dlg = await screen.findByRole("dialog");
    await user.click(within(dlg).getByRole("button", { name: "reject the transfer" }));
    expect(within(dlg).getByText("Refused")).toBeInTheDocument();
    expect(billing.settleVisit).not.toHaveBeenCalled();
  });

  test("REG-FE-SHARED-075 Collect here: a refused payment says why and keeps the dialog; Cancel closes", async () => {
    auth.perms = new Set(["dental.manage", "payment.collect"]);
    billing.settleVisit.mockRejectedValueOnce(new AppError(409, "X", "Reference already used")).mockRejectedValueOnce(new Error("x"));
    const { user } = extras(visit([EX("a", { payment: "billed", charge_id: "chg_5" })]));
    await user.click(screen.getByRole("button", { name: /Collect here/ }));
    const dlg = await screen.findByRole("dialog");
    await user.click(within(dlg).getByRole("button", { name: /^Take/ }));
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith("Reference already used"));
    await user.click(within(dlg).getByRole("button", { name: /^Take/ }));
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith("Could not take the payment"));
    await user.click(within(dlg).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
  });

  test("REG-FE-SHARED-076 Collect here when the extra could not be billed says to send it to the cashier instead", async () => {
    auth.perms = new Set(["dental.manage", "payment.collect"]);
    api.dentalSummary.mockResolvedValue({ plans: [{ sessions: [{ extras: [{ id: "other" }] }] }] });
    const { user } = extras(visit([EX("a")]));
    await user.click(screen.getByRole("button", { name: /Collect here/ }));
    await user.click(within(await screen.findByRole("dialog")).getByRole("button", { name: /^Take/ }));
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith("That extra could not be billed. Send it to the cashier instead."));
    expect(billing.settleVisit).not.toHaveBeenCalled();
  });

  // --- finishing the visit with something unpaid -----------------------------------

  const stop = (list: Extra[], { canCollect = true } = {}) => {
    const onProceed = vi.fn();
    const onClose = vi.fn();
    const r = renderUI(<UnpaidExtrasStop open patientId="pat_1" extras={list} canCollect={canCollect} onClose={onClose} onProceed={onProceed} />);
    return { ...r, onProceed, onClose };
  };
  const unpaidList = [EX("a", { service_name: "X-ray" }), EX("b", { service_name: "Filling", payment: "billed", amount_due: "800" })] as unknown as Extra[];

  test("REG-FE-SHARED-077 finishing with unpaid extras lists them and offers three honest ways out", () => {
    stop(unpaidList);
    const dlg = screen.getByRole("dialog");
    expect(dlg).toHaveTextContent("2 extras have not been paid");
    expect(dlg).toHaveTextContent("not billed");
    expect(dlg).toHaveTextContent("at the cashier");
    expect(within(dlg).getByRole("button", { name: /Send to cashier and finish/ })).toBeInTheDocument();
    expect(within(dlg).getByRole("button", { name: /Treat now, pay later/ })).toBeInTheDocument();
    expect(within(dlg).getByRole("button", { name: /Finish anyway/ })).toBeInTheDocument();
  });

  test("REG-FE-SHARED-078 Send to cashier and finish bills only the unbilled ones, then finishes", async () => {
    const { user, onProceed } = stop(unpaidList);
    await user.click(screen.getByRole("button", { name: /Send to cashier and finish/ }));
    await waitFor(() => expect(api.collectSessions).toHaveBeenCalledWith("pat_1", ["a"]));
    await waitFor(() => expect(onProceed).toHaveBeenCalledTimes(1));
  });

  test("REG-FE-SHARED-079 a failed send does not finish the visit", async () => {
    api.collectSessions.mockRejectedValueOnce(new AppError(409, "C", "Already billed"));
    const { user, onProceed } = stop(unpaidList);
    await user.click(screen.getByRole("button", { name: /Send to cashier and finish/ }));
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith("Already billed"));
    expect(onProceed).not.toHaveBeenCalled();
  });

  test("REG-FE-SHARED-080 pay later asks why, records it for each unpaid extra, then finishes; Back returns", async () => {
    const { user, onProceed } = stop(unpaidList);
    await user.click(screen.getByRole("button", { name: /Treat now, pay later/ }));
    const go = screen.getByRole("button", { name: "Treat now, bill later" });
    expect(go).toBeDisabled();
    await user.click(screen.getByRole("button", { name: "Back" }));
    expect(screen.getByRole("button", { name: /Finish anyway/ })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /Treat now, pay later/ }));
    await user.type(screen.getByLabelText(/Why\?/), "Staff dependent");
    await user.click(screen.getByRole("button", { name: "Treat now, bill later" }));
    await waitFor(() => expect(api.setPayLater).toHaveBeenCalledTimes(2));
    expect(api.setPayLater).toHaveBeenCalledWith("pat_1", "a", { on: true, note: "Staff dependent" });
    expect(api.setPayLater).toHaveBeenCalledWith("pat_1", "b", { on: true, note: "Staff dependent" });
    await waitFor(() => expect(onProceed).toHaveBeenCalledTimes(1));
  });

  test("REG-FE-SHARED-081 a failed promise does not finish the visit", async () => {
    api.setPayLater.mockRejectedValue(new Error("x"));
    const { user, onProceed } = stop(unpaidList);
    await user.click(screen.getByRole("button", { name: /Treat now, pay later/ }));
    await user.type(screen.getByLabelText(/Why\?/), "Staff");
    await user.click(screen.getByRole("button", { name: "Treat now, bill later" }));
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith("Could not record that"));
    expect(onProceed).not.toHaveBeenCalled();
  });

  test("REG-FE-SHARED-082 Finish anyway changes nothing and finishes; without billing rights there is no send", async () => {
    const { user, onProceed, unmount } = stop(unpaidList);
    await user.click(screen.getByRole("button", { name: /Finish anyway/ }));
    expect(onProceed).toHaveBeenCalledTimes(1);
    expect(api.collectSessions).not.toHaveBeenCalled();
    expect(api.setPayLater).not.toHaveBeenCalled();
    unmount();
    stop(unpaidList, { canCollect: false });
    expect(screen.queryByRole("button", { name: /Send to cashier and finish/ })).not.toBeInTheDocument();
  });

  test("REG-FE-SHARED-083 a single unpaid extra is named in the singular, and only already-billed ones offer no send", () => {
    stop([EX("b", { service_name: "Filling", payment: "billed" }) as unknown as Extra]);
    expect(screen.getByRole("dialog")).toHaveTextContent("1 extra has not been paid");
    expect(screen.queryByRole("button", { name: /Send to cashier and finish/ })).not.toBeInTheDocument();
  });

  test("REG-FE-SHARED-084 closing the stop reports it", async () => {
    const { user, onClose } = stop(unpaidList);
    await user.keyboard("{Escape}");
    expect(onClose).toHaveBeenCalled();
  });
});
