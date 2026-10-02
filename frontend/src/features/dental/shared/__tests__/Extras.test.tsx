// "Also done at this visit": unplanned procedures priced from the clinic's list.
// Covered: what each extra shows (price, "included", payment badge), adding one
// (price from the list, sent only when changed), billing it, and removing an
// unbilled one only after confirming. The service picker itself has its own tests;
// here it is a stub that picks a known entry.
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, onTestFinished, test, vi } from "vitest";

const api = vi.hoisted(() => ({ addExtra: vi.fn(), collectSession: vi.fn(), removeExtra: vi.fn() }));
const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }));
vi.mock("@/features/dental/api", async (orig) => ({ ...(await orig<object>()), ...api }));
vi.mock("sonner", async (orig) => ({ ...(await orig<object>()), toast }));
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

import { ExtrasSection, extrasTotal } from "@/features/dental/shared/Extras";
import { AppError } from "@/lib/api-client";
import type { Session } from "@/features/dental/api";
import { renderUI } from "@/test/render";
import { S } from "../../visit/__tests__/fixtures";

const T = "2026-08-12";
const EX = (id: string, extra: Record<string, unknown> = {}) =>
  ({ id, amount_due: "2000", payment: "unpaid", status: "done", service_name: "X-ray", ...extra });
const visit = (extras: unknown[] = []) => S("s3", T, 3, "done", { extras } as Partial<Session>);

function extras(session: Session, { editable = true, canCollect = true } = {}) {
  return renderUI(<ExtrasSection patientId="pat_1" session={session} editable={editable} canCollect={canCollect} />);
}
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
    Object.values(toast).forEach((f) => f.mockReset());
  });

  test("REG-FE-SHARED-042 extrasTotal adds the visit's extras (none is zero)", () => {
    expect(extrasTotal(visit([EX("a"), EX("b", { amount_due: "500.5" })]))).toBe(2500.5);
    expect(extrasTotal(S("s", T, 1))).toBe(0);
  });

  test("REG-FE-SHARED-043 a reviewed visit with no extras shows nothing at all", () => {
    extras(visit(), { editable: false });
    expect(screen.queryByText("Also done at this visit")).not.toBeInTheDocument();
  });

  test("REG-FE-SHARED-044 an editable visit with no extras says so and offers Add", () => {
    extras(visit());
    expect(screen.getByText("Also done at this visit")).toBeInTheDocument();
    expect(screen.getByText(/Nothing extra — this visit is what the treatment planned\./)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Add/ })).toBeInTheDocument();
  });

  test("REG-FE-SHARED-045 each extra shows its price and payment state; a free one reads 'Included in the course'", () => {
    extras(visit([
      EX("a"), EX("b", { payment: "billed", service_name: "Filling" }), EX("c", { payment: "paid", service_name: "Scaling" }),
      EX("d", { payment: "waived", service_name: "Polish" }), EX("e", { payment: "refunded", service_name: "Crown" }),
      EX("f", { amount_due: "0", service_name: "" }),
    ]), { editable: false });
    expect(screen.getByText("6")).toBeInTheDocument();
    for (const t of ["Owed now", "At cashier", "Paid", "Written off", "Refunded — owed again"]) expect(screen.getByText(t)).toBeInTheDocument();
    expect(screen.getAllByText("2,000 ETB")).toHaveLength(5);
    expect(screen.getByText("Procedure")).toBeInTheDocument();
    expect(screen.getByText("Included in the course")).toBeInTheDocument();
    // Read-only: no add and no remove.
    expect(screen.queryByRole("button", { name: /Add/ })).not.toBeInTheDocument();
    expect(screen.queryByTitle("Remove this extra")).not.toBeInTheDocument();
  });

  test("REG-FE-SHARED-046 Send to cashier only for money still owed, and only with billing permission", () => {
    const list = [EX("a"), EX("b", { payment: "refunded" }), EX("c", { payment: "billed" }), EX("d", { payment: "paid" }), EX("e", { amount_due: "0" })];
    const { unmount } = extras(visit(list));
    expect(screen.getAllByRole("button", { name: /Send to cashier/ })).toHaveLength(2);
    unmount();
    extras(visit(list), { canCollect: false });
    expect(screen.queryByRole("button", { name: /Send to cashier/ })).not.toBeInTheDocument();
  });

  test("REG-FE-SHARED-047 Send to cashier bills that extra, says so, and refreshes", async () => {
    const { user, qc } = extras(visit([EX("a"), EX("b", { service_name: "Filling" })]));
    const inv = vi.spyOn(qc, "invalidateQueries");
    await user.click(screen.getAllByRole("button", { name: /Send to cashier/ })[1]);
    await waitFor(() => expect(api.collectSession).toHaveBeenCalledWith("pat_1", "b"));
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith("Sent to the cashier"));
    expect(inv).toHaveBeenCalledWith({ queryKey: ["dental-summary", "pat_1"] });
  });

  test("REG-FE-SHARED-048 a refused send says why (or a fallback)", async () => {
    api.collectSession.mockRejectedValueOnce(new AppError(409, "C", "Already billed")).mockRejectedValueOnce(new Error("x"));
    const { user } = extras(visit([EX("a")]));
    await user.click(screen.getByRole("button", { name: /Send to cashier/ }));
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith("Already billed"));
    await user.click(screen.getByRole("button", { name: /Send to cashier/ }));
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith("Could not send it to the cashier"));
  });

  test("REG-FE-SHARED-049 only an unbilled extra can be removed", () => {
    extras(visit([EX("a"), EX("b", { payment: "billed" }), EX("c", { payment: "paid" }), EX("d", { payment: "refunded" })]));
    expect(screen.getAllByTitle("Remove this extra")).toHaveLength(1);
  });

  test("REG-FE-SHARED-050 removing asks first, naming what stops being owed, then removes it", async () => {
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

  test("REG-FE-SHARED-051 removing a free, unnamed extra: no amount in the question; Cancel keeps it", async () => {
    const { user } = extras(visit([EX("a", { amount_due: "0", service_name: "" })]));
    await user.click(screen.getByTitle("Remove this extra"));
    const dlg = await screen.findByRole("dialog");
    expect(within(dlg).getByText("Remove this extra?")).toBeInTheDocument();
    expect(within(dlg).getByText(/It will no longer be owed/)).toHaveTextContent("It will no longer be owed. Use this only");
    await user.click(within(dlg).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(api.removeExtra).not.toHaveBeenCalled();
  });

  test("REG-FE-SHARED-052 a refused removal says why (or a fallback)", async () => {
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

  test("REG-FE-SHARED-053 adding: nothing can be added until a procedure is picked, and the list price is filled in", async () => {
    const { user } = extras(visit());
    await user.click(screen.getByRole("button", { name: /Add/ }));
    // The header's Add hides while the form is open, and so does the empty line.
    expect(screen.queryByRole("button", { name: /^Add$/ })).not.toBeInTheDocument();
    expect(screen.queryByText(/Nothing extra/)).not.toBeInTheDocument();
    expect(screen.getByTestId("picker-value")).toHaveTextContent("Choose a procedure");
    const addBtn = screen.getByRole("button", { name: "Add to this visit" });
    expect(addBtn).toBeDisabled();
    expect(screen.getByText(/Priced from the clinic's list/)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "pick X-ray" }));
    expect(screen.getByTestId("picker-value")).toHaveTextContent("X-ray");
    expect(screen.getByLabelText("Charge (ETB)")).toHaveValue(2000);
    expect(addBtn).toBeEnabled();
    expect(screen.getByText(/Priced from the clinic's list/)).toBeInTheDocument();
  });

  test("REG-FE-SHARED-054 a changed price is pointed out and sent; zero means included in the course", async () => {
    const { user } = extras(visit());
    await user.click(screen.getByRole("button", { name: /Add/ }));
    await user.click(screen.getByRole("button", { name: "pick X-ray" }));
    const price = screen.getByLabelText("Charge (ETB)");
    fireEvent.change(price, { target: { value: "0" } });
    expect(screen.getByText(/Zero means/)).toHaveTextContent("Zero means included in the course — recorded, not billed.");
    fireEvent.change(price, { target: { value: "2500" } });
    expect(screen.getByText("The list says 2,000 ETB.")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Add to this visit" }));
    await waitFor(() => expect(api.addExtra).toHaveBeenCalledWith("pat_1", "s3", { service_id: "svc_xray", amount: "2500" }));
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith("X-ray added to this visit"));
    // The form closes and is clean next time.
    await waitFor(() => expect(screen.queryByRole("button", { name: "Add to this visit" })).not.toBeInTheDocument());
    await user.click(screen.getByRole("button", { name: /Add/ }));
    expect(screen.getByTestId("picker-value")).toHaveTextContent("Choose a procedure");
    expect(screen.getByLabelText("Charge (ETB)")).toHaveValue(null);
  });

  test("REG-FE-SHARED-055 a blank price is not sent, so the server prices from its own list", async () => {
    const { user } = extras(visit());
    await user.click(screen.getByRole("button", { name: /Add/ }));
    await user.click(screen.getByRole("button", { name: "pick X-ray" }));
    fireEvent.change(screen.getByLabelText("Charge (ETB)"), { target: { value: "" } });
    await user.click(screen.getByRole("button", { name: "Add to this visit" }));
    await waitFor(() => expect(api.addExtra).toHaveBeenCalledWith("pat_1", "s3", { service_id: "svc_xray", amount: undefined }));
  });

  test("REG-FE-SHARED-056 a typed name that is not on the list is refused with a hint", async () => {
    const { user } = extras(visit());
    await user.click(screen.getByRole("button", { name: /Add/ }));
    await user.click(screen.getByRole("button", { name: "type free text" }));
    expect(toast.error).toHaveBeenCalledWith("Pick it from the clinic's list, or add it to the list first");
    expect(screen.getByRole("button", { name: "Add to this visit" })).toBeDisabled();
  });

  test("REG-FE-SHARED-057 clearing the pick disables Add again and empties the price", async () => {
    const { user } = extras(visit());
    await user.click(screen.getByRole("button", { name: /Add/ }));
    await user.click(screen.getByRole("button", { name: "pick X-ray" }));
    await user.click(screen.getByRole("button", { name: "clear pick" }));
    expect(screen.getByRole("button", { name: "Add to this visit" })).toBeDisabled();
    expect(screen.getByLabelText("Charge (ETB)")).toHaveValue(null);
  });

  test("REG-FE-SHARED-058 Cancel closes the form without adding", async () => {
    const { user } = extras(visit());
    await user.click(screen.getByRole("button", { name: /Add/ }));
    await user.click(screen.getByRole("button", { name: "pick X-ray" }));
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("button", { name: "Add to this visit" })).not.toBeInTheDocument();
    expect(screen.getByText(/Nothing extra/)).toBeInTheDocument();
    expect(api.addExtra).not.toHaveBeenCalled();
  });

  test("REG-FE-SHARED-059 a refused add says why (or a fallback) and keeps the form", async () => {
    api.addExtra.mockRejectedValueOnce(new AppError(400, "V", "Service is inactive")).mockRejectedValueOnce(new Error("x"));
    const { user } = extras(visit());
    await user.click(screen.getByRole("button", { name: /Add/ }));
    await user.click(screen.getByRole("button", { name: "pick X-ray" }));
    await user.click(screen.getByRole("button", { name: "Add to this visit" }));
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith("Service is inactive"));
    await user.click(screen.getByRole("button", { name: "Add to this visit" }));
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith("Could not add it"));
    expect(screen.getByTestId("picker-value")).toHaveTextContent("X-ray");
  });

  test("REG-FE-SHARED-060 Add to this visit is disabled while the request is in flight", async () => {
    let resolve!: () => void;
    api.addExtra.mockReturnValue(new Promise<void>((r) => { resolve = r; }));
    const { user } = extras(visit());
    await user.click(screen.getByRole("button", { name: /Add/ }));
    await user.click(screen.getByRole("button", { name: "pick X-ray" }));
    const btn = screen.getByRole("button", { name: "Add to this visit" });
    await user.click(btn);
    await waitFor(() => expect(btn).toBeDisabled());
    fireEvent.click(btn);
    expect(api.addExtra).toHaveBeenCalledTimes(1);
    resolve();
    await waitFor(() => expect(toast.success).toHaveBeenCalled());
  });
});
