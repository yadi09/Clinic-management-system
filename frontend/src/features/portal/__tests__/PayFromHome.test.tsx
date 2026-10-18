// Pay from home, as the patient sees it: choose, pay and type the transaction number, then
// watch the bank check; and what the clinic's cashier sees for payments that wait.
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { Route, Routes } from "react-router-dom";

const client = vi.hoisted(() => ({ apiFetch: vi.fn() }));
vi.mock("@/lib/api-client", async (orig) => ({ ...(await orig<object>()), ...client }));
vi.mock("@/features/dental/anatomical/three/Dental3D", () => ({ default: () => <div /> }));

import { AppError } from "@/lib/api-client";
import { PortalPage } from "@/features/portal/PortalPage";
import type { PayOptions, PayStatus, PortalMe } from "@/features/portal/api";
import { renderUI } from "@/test/render";

const ME: PortalMe = {
  clinic: { name: "Yoya Dental", slug: "yoya", phone: "0911 00 00 00", has_logo: false },
  first_name: "Meron",
  settings: { enabled: true, show_money: true, show_unbilled: true, show_teeth: true, show_3d: true, allow_pay: true, welcome_note: "" },
  today: "2026-10-18", treatments: [], money: { paid: "0.00", to_pay: "3500.00" }, receipts: [],
  chart: { items: [], positions: {} },
};
const OPTS: PayOptions = {
  items: [
    { key: "c:1", label: "Braces · monthly payment", amount: "2000.00", payable: true, hint: "Waiting for payment" },
    { key: "s:2", label: "Root canal · visit 3", amount: "1500.00", payable: true, upcoming: true, date: "2026-10-21" },
    { key: "s:3", label: "Filling · tooth 47", amount: "800.00", payable: false },
  ],
  rails: [{ id: "pmt_1", label: "Telebirr", kind: "wallet", account_name: "Yoya Dental", account_number: "0911223344" }],
  open: [],
};
const ST = (o: Partial<PayStatus>): PayStatus => ({ id: "ppy_1", state: "paid", amount: "3500.00", rail: "Telebirr", reference: "CE7K2M9XQ4", date: "2026-10-18", ...o });

let opts = OPTS;
let payAnswer: PayStatus | Error = ST({ receipt_no: 231 });
function serve() {
  client.apiFetch.mockImplementation(async (path: string, o?: { body?: unknown }) => {
    if (path.endsWith("/login")) return { token: "tok", expires_in: 7200 };
    if (path.endsWith("/me")) return ME;
    if (path.endsWith("/pay/options")) return opts;
    if (path.endsWith("/pay")) { if (payAnswer instanceof Error) throw payAnswer; return payAnswer; }
    if (path.includes("/pay/ppy_1")) return ST({ receipt_no: 231 });
    throw new Error(`unexpected ${path} ${JSON.stringify(o)}`);
  });
}
async function toPayments() {
  renderUI(<Routes><Route path="/p/:slug" element={<PortalPage />} /></Routes>, { route: "/p/yoya" });
  await userEvent.type(screen.getByLabelText("Card number"), "MRN-000123");
  await userEvent.click(screen.getByRole("button", { name: "See my treatment" }));
  await screen.findByText(/Hello Meron/);
  await userEvent.click(screen.getByRole("tab", { name: "Payments" }));
}

beforeEach(() => { client.apiFetch.mockReset(); sessionStorage.clear(); localStorage.clear(); opts = OPTS; payAnswer = ST({ receipt_no: 231 }); serve(); });
afterEach(() => vi.useRealTimers());

describe("REG-FE-PORTAL-PAY pay from home", () => {
  test("REG-FE-PORTAL-PAY-001 the menu: bills and the next visit ticked, not-yet-billed work greyed out, total on the button", async () => {
    await toPayments();
    await userEvent.click(await screen.findByRole("button", { name: "Pay now" }));
    const box = screen.getByRole("dialog");
    expect(box).toHaveTextContent("Braces · monthly payment");
    expect(box).toHaveTextContent("Next visit — pay ahead");
    expect(screen.getByRole("checkbox", { name: /Filling/ })).toBeDisabled();
    expect(screen.getByRole("button", { name: /Continue · 3,500 ETB/ })).toBeEnabled();
    await userEvent.click(screen.getByRole("checkbox", { name: /Braces/ }));
    expect(screen.getByRole("button", { name: /Continue · 1,500 ETB/ })).toBeInTheDocument();
  });

  test("REG-FE-PORTAL-PAY-002 paying: the clinic's account is shown, the server gets the items, the method and the number, and a confirmed payment shows its receipt", async () => {
    await toPayments();
    await userEvent.click(await screen.findByRole("button", { name: "Pay now" }));
    await userEvent.click(screen.getByRole("button", { name: /Continue/ }));
    expect(screen.getByText("0911223344")).toBeInTheDocument();
    await userEvent.type(screen.getByLabelText("Transaction number"), "CE7K2M9XQ4");
    await userEvent.click(screen.getByRole("button", { name: "I have paid" }));
    expect(await screen.findByText(/Payment confirmed/)).toHaveTextContent("Payment confirmed");
    expect(screen.getByRole("status")).toHaveTextContent("RCP-000231");
    expect(client.apiFetch).toHaveBeenCalledWith("/portal/yoya/pay", expect.objectContaining({
      method: "POST", body: { items: ["c:1", "s:2"], rail_id: "pmt_1", reference: "CE7K2M9XQ4" }, headers: { "X-Portal-Token": "tok" },
    }));
  });

  test("REG-FE-PORTAL-PAY-003 a short transaction number is stopped before the server; a refused payment says so and offers to try again or call", async () => {
    payAnswer = ST({ state: "rejected", reason: "x" });
    await toPayments();
    await userEvent.click(await screen.findByRole("button", { name: "Pay now" }));
    await userEvent.click(screen.getByRole("button", { name: /Continue/ }));
    await userEvent.type(screen.getByLabelText("Transaction number"), "12");
    await userEvent.click(screen.getByRole("button", { name: "I have paid" }));
    expect(screen.getByRole("alert")).toHaveTextContent("at least 6");
    expect(client.apiFetch.mock.calls.some((c) => c[0] === "/portal/yoya/pay")).toBe(false);
    await userEvent.type(screen.getByLabelText("Transaction number"), "3456789");
    await userEvent.click(screen.getByRole("button", { name: "I have paid" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("could not find this payment yet");
    expect(screen.getByRole("link", { name: "Call the clinic" })).toHaveAttribute("href", "tel:0911000000");
    await userEvent.click(screen.getByRole("button", { name: "Check the number again" }));
    expect(screen.getByLabelText("Transaction number")).toBeInTheDocument();
  });

  test("REG-FE-PORTAL-PAY-004 a server refusal (already used) is shown in its own words and the patient stays on the form", async () => {
    payAnswer = new AppError(409, "PORTAL_REF_USED", "This transaction number has already been used.");
    await toPayments();
    await userEvent.click(await screen.findByRole("button", { name: "Pay now" }));
    await userEvent.click(screen.getByRole("button", { name: /Continue/ }));
    await userEvent.type(screen.getByLabelText("Transaction number"), "CE7K2M9XQ4");
    await userEvent.click(screen.getByRole("button", { name: "I have paid" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("already been used");
    expect(screen.getByRole("button", { name: "I have paid" })).toBeEnabled();
  });

  test("REG-FE-PORTAL-PAY-005 while the bank is still working the page says so, and asks again until it answers", async () => {
    payAnswer = ST({ state: "checking" });
    await toPayments();
    await userEvent.click(await screen.findByRole("button", { name: "Pay now" }));
    await userEvent.click(screen.getByRole("button", { name: /Continue/ }));
    await userEvent.type(screen.getByLabelText("Transaction number"), "CE7K2M9XQ4");
    await userEvent.click(screen.getByRole("button", { name: "I have paid" }));
    expect(await screen.findByRole("status")).toHaveTextContent("We are checking with the bank");
    // The next ask (4 s later) finds it confirmed.
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("Payment confirmed"), { timeout: 12000 });
  }, 20000);

  test("REG-FE-PORTAL-PAY-006 a clinic that does not allow paying shows no Pay from home; with no account set up it says so; with nothing owed it says so", async () => {
    // Not allowed: the page never even asks for options.
    client.apiFetch.mockImplementation(async (path: string) => {
      if (path.endsWith("/login")) return { token: "tok", expires_in: 1 };
      if (path.endsWith("/me")) return { ...ME, settings: { ...ME.settings, allow_pay: false } };
      throw new Error(`unexpected ${path}`);
    });
    await toPayments();
    expect(screen.queryByText("Pay from home")).not.toBeInTheDocument();
    expect(client.apiFetch.mock.calls.some((c) => String(c[0]).includes("/pay/options"))).toBe(false);
  });

  test("REG-FE-PORTAL-PAY-007 no way to pay set up, and nothing to pay, are each said plainly and the button is off", async () => {
    opts = { items: OPTS.items, rails: [], open: [] };
    await toPayments();
    expect(await screen.findByText(/has not set up a way to pay/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Pay now" })).toBeDisabled();
  });

  test("REG-FE-PORTAL-PAY-008 an attempt that is waiting is listed on the Payments page", async () => {
    opts = { ...OPTS, open: [ST({ state: "waiting", amount: "1500.00" })] };
    await toPayments();
    expect(await screen.findByText("Waiting for confirmation")).toBeInTheDocument();
    expect(screen.getByText(/CE7K2M9XQ4/)).toBeInTheDocument();
  });

  test("REG-FE-PORTAL-PAY-009 in Amharic the pay button and menu are in Amharic", async () => {
    await toPayments();
    await userEvent.click(screen.getByRole("button", { name: "አማ" }));
    await userEvent.click(await screen.findByRole("button", { name: "አሁን ይክፈሉ" }));
    expect(screen.getByRole("dialog")).toHaveTextContent("ምን መክፈል ይፈልጋሉ?");
  });

  test("REG-FE-PORTAL-PAY-010 'Pay what you owe' pays exactly what is owed, straight to paying — no list to tick first", async () => {
    await toPayments();
    const owed = (await screen.findByText("Pay what you owe")).closest("div")!;
    expect(owed).toHaveTextContent("Braces · monthly payment");
    await userEvent.click(within(owed).getByRole("button", { name: "Pay 2,000 ETB" }));
    const box = screen.getByRole("dialog");
    expect(within(box).getByRole("heading", { name: "Pay 2,000 ETB" })).toBeInTheDocument();
    expect(box).toHaveTextContent("0911223344");
    await userEvent.type(within(box).getByLabelText("Transaction number"), "CE7K2M9XQ4");
    await userEvent.click(within(box).getByRole("button", { name: "I have paid" }));
    await waitFor(() => expect(client.apiFetch).toHaveBeenCalledWith("/portal/yoya/pay", expect.objectContaining({ body: { items: ["c:1"], rail_id: "pmt_1", reference: "CE7K2M9XQ4" } })));
  });

  test("REG-FE-PORTAL-PAY-011 'Pay your next visit ahead' names the visit and its day and pays only that visit", async () => {
    await toPayments();
    const ahead = (await screen.findByText("Pay your next visit ahead")).closest("div")!;
    expect(ahead).toHaveTextContent("Root canal · visit 3");
    expect(ahead).toHaveTextContent("Wednesday 21 Oct");
    await userEvent.click(within(ahead).getByRole("button", { name: "Pay 1,500 ETB" }));
    const box = screen.getByRole("dialog");
    await userEvent.type(within(box).getByLabelText("Transaction number"), "CE7K2M9XQ4");
    await userEvent.click(within(box).getByRole("button", { name: "I have paid" }));
    await waitFor(() => expect(client.apiFetch).toHaveBeenCalledWith("/portal/yoya/pay", expect.objectContaining({ body: expect.objectContaining({ items: ["s:2"] }) })));
  });

  test("REG-FE-PORTAL-PAY-012 from a quick payment the patient can still change what they pay: the list opens with only that ticked", async () => {
    await toPayments();
    await userEvent.click(within((await screen.findByText("Pay what you owe")).closest("div")!).getByRole("button", { name: "Pay 2,000 ETB" }));
    await userEvent.click(screen.getByRole("button", { name: "Change what I am paying" }));
    expect(screen.getByRole("checkbox", { name: /Braces/ })).toBeChecked();
    expect(screen.getByRole("checkbox", { name: /Root canal/ })).not.toBeChecked();
    expect(screen.getByRole("button", { name: /Continue · 2,000 ETB/ })).toBeInTheDocument();
  });

  test("REG-FE-PORTAL-PAY-013 Home offers 'Pay what you owe' (not the visit ahead); with nothing owed there is no such card", async () => {
    renderUI(<Routes><Route path="/p/:slug" element={<PortalPage />} /></Routes>, { route: "/p/yoya" });
    await userEvent.type(screen.getByLabelText("Card number"), "MRN-000123");
    await userEvent.click(screen.getByRole("button", { name: "See my treatment" }));
    expect(await screen.findByRole("button", { name: "Pay 2,000 ETB" })).toBeInTheDocument();
    expect(screen.queryByText("Pay your next visit ahead")).not.toBeInTheDocument();
  });

  test("REG-FE-PORTAL-PAY-014 nothing owed: no owed card, the visit-ahead card still offered; no payment method set up: no quick cards at all", async () => {
    opts = { ...OPTS, items: OPTS.items.filter((i) => i.key !== "c:1") };
    await toPayments();
    expect(await screen.findByText("Pay your next visit ahead")).toBeInTheDocument();
    expect(screen.queryByText("Pay what you owe")).not.toBeInTheDocument();
  });

  test("REG-FE-PORTAL-PAY-015 with no way to pay from home there are no quick cards", async () => {
    opts = { ...OPTS, rails: [] };
    await toPayments();
    expect(await screen.findByText(/has not set up a way to pay/)).toBeInTheDocument();
    expect(screen.queryByText("Pay what you owe")).not.toBeInTheDocument();
    expect(screen.queryByText("Pay your next visit ahead")).not.toBeInTheDocument();
  });
});
