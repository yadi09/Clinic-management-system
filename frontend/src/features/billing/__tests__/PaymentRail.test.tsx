// How the money arrived, asked the same way at every till. The picker must list the
// clinic's own rails, ask for a transaction reference only where one exists (wallet /
// bank), warn about a generic unnamed rail, and — when the plan includes it and the
// deployment has a Verify.ET key — let the desk check the reference with the bank
// BEFORE the money is taken. A bank that contradicts the payment must block the
// ordinary Collect button; only a manager gets a named, recorded override.
import { screen, waitFor } from "@testing-library/react";
import { useState } from "react";
import { beforeEach, describe, expect, test, vi } from "vitest";

const auth = vi.hoisted(() => ({ perms: new Set<string>(), flags: new Set<string>() }));
vi.mock("@/app/auth-context", () => ({
  useAuth: () => ({ can: (p: string) => auth.perms.has(p), flagOn: (f: string) => auth.flags.has(f), user: { id: "u1", full_name: "Hanna" } }),
}));
const api = vi.hoisted(() => ({ verifyPayment: vi.fn(), verificationAvailable: vi.fn() }));
vi.mock("@/features/billing/api", async (orig) => ({ ...(await orig<object>()), ...api }));
const admin = vi.hoisted(() => ({ listPaymentRails: vi.fn() }));
vi.mock("@/features/admin/api", async (orig) => ({ ...(await orig<object>()), ...admin }));

import {
  EMPTY_PAYMENT, PaymentRailPicker, PaymentRefused, paymentBlocked, paymentIncomplete, usePaymentRails,
  type PaymentChoice, type PaymentRail,
} from "@/features/billing/PaymentRail";
import { renderUI } from "@/test/render";

const rail = (id: string, over: Partial<PaymentRail> = {}): PaymentRail => ({
  id, key: id, label: id, kind: "cash", needs_reference: false, active: true, sort_order: 0, ...over,
});
const CASH = rail("cash", { label: "Cash" });
const TELEBIRR = rail("tb", { key: "telebirr", label: "Telebirr", kind: "wallet", bank_key: "telebirr", account_number: "0911223344", needs_reference: true });
const MOBILE = rail("mob", { key: "mobile", label: "Mobile money", kind: "wallet" });
const CBE = rail("cbe", { key: "cbe", label: "CBE", kind: "bank", bank_key: "cbe" });
const ODD = rail("odd", { key: "odd", label: "Odd bank", kind: "bank", bank_key: "zzz" });
const RAILS = [CASH, TELEBIRR, MOBILE, CBE, ODD];

let seen: PaymentChoice[] = [];
function Harness({ initial = EMPTY_PAYMENT, rails = RAILS, disabled }: { initial?: PaymentChoice; rails?: PaymentRail[]; disabled?: boolean }) {
  const [v, setV] = useState(initial);
  return (
    <PaymentRailPicker rails={rails} value={v} disabled={disabled} expected="500.00" patientId="pat_1"
      onChange={(n) => { seen.push(n); setV(n); }} />
  );
}
const pick = async (user: ReturnType<typeof renderUI>["user"], label: string) => {
  await user.click(screen.getByRole("combobox", { name: "Payment method" }));
  await user.click(await screen.findByRole("option", { name: new RegExp(`^${label}`) }));
};
const lastSeen = () => seen.at(-1)!;

describe("REG-FE-RAIL payment rail picker", () => {
  beforeEach(() => {
    seen = [];
    auth.perms = new Set();
    auth.flags = new Set();
    Object.values(api).forEach((f) => f.mockReset());
    admin.listPaymentRails.mockReset();
    api.verificationAvailable.mockResolvedValue({ available: true });
  });

  test("REG-FE-RAIL-001 helpers: blocked only on a bank rejection; incomplete only when a needed reference is blank", () => {
    expect(paymentBlocked(EMPTY_PAYMENT)).toBe(false);
    expect(paymentBlocked({ ...EMPTY_PAYMENT, check: { state: "review", reason: "" } })).toBe(false);
    expect(paymentBlocked({ ...EMPTY_PAYMENT, check: { state: "rejected", reason: "" } })).toBe(true);
    expect(paymentIncomplete(undefined, EMPTY_PAYMENT)).toBe(false);
    expect(paymentIncomplete(RAILS, { railId: "tb", method: "telebirr", reference: "  " })).toBe(true);
    expect(paymentIncomplete(RAILS, { railId: "tb", method: "telebirr", reference: "CH7" })).toBe(false);
    expect(paymentIncomplete(RAILS, { railId: "mob", method: "mobile", reference: "" })).toBe(false);
    expect(EMPTY_PAYMENT).toEqual({ railId: "", method: "cash", reference: "" });
  });

  test("REG-FE-RAIL-002 lists the clinic's rails with account numbers; cash asks for no reference", async () => {
    const { user } = renderUI(<Harness />);
    await user.click(screen.getByRole("combobox", { name: "Payment method" }));
    expect(await screen.findByRole("option", { name: /Telebirr\s*0911223344/ })).toBeInTheDocument();
    await user.click(screen.getByRole("option", { name: "Cash" }));
    expect(lastSeen()).toEqual({ railId: "cash", method: "cash", reference: "" });
    expect(screen.queryByLabelText(/Transaction reference/)).not.toBeInTheDocument();
  });

  test("REG-FE-RAIL-003 no rails configured: the picker is disabled", () => {
    renderUI(<Harness rails={[]} />);
    expect(screen.getByRole("combobox", { name: "Payment method" })).toBeDisabled();
  });

  test("REG-FE-RAIL-004 a wallet that needs a reference: provider-specific hint, typed reference reaches onChange", async () => {
    const { user } = renderUI(<Harness />);
    await pick(user, "Telebirr");
    const ref = screen.getByLabelText(/Transaction reference/);
    expect(ref).toHaveAttribute("placeholder", expect.stringMatching(/Telebirr SMS/));
    expect(screen.queryByText(/optional/)).not.toBeInTheDocument();
    await user.type(ref, "CH7");
    expect(lastSeen()).toMatchObject({ railId: "tb", method: "telebirr", reference: "CH7" });
    expect(screen.getByText(/cannot be used to pay twice/)).toBeInTheDocument();
  });

  test("REG-FE-RAIL-005 a generic unnamed wallet: the reference is optional and the desk is told to name the account", async () => {
    auth.perms = new Set(["clinic.manage"]);
    const { user, unmount } = renderUI(<Harness />);
    await pick(user, "Mobile money");
    expect(screen.getByText(/optional, but it is the only proof/)).toBeInTheDocument();
    expect(screen.getByLabelText(/Transaction reference/)).toHaveAttribute("placeholder", "The transaction number on the patient's SMS");
    expect(screen.getByText(/generic method/)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /Name your accounts/ })).toHaveAttribute("href", "/settings?section=payments");
    unmount();
    auth.perms = new Set();
    renderUI(<Harness initial={{ railId: "mob", method: "mobile", reference: "" }} />);
    expect(screen.queryByRole("link", { name: /Name your accounts/ })).not.toBeInTheDocument();
    expect(screen.getByText(/Ask an administrator/)).toBeInTheDocument();
  });

  test("REG-FE-RAIL-006 a bank rail with an unknown provider falls back to the generic hint", () => {
    renderUI(<Harness initial={{ railId: "odd", method: "odd", reference: "" }} />);
    expect(screen.getByLabelText(/Transaction reference/)).toHaveAttribute("placeholder", "The transaction number on the patient's SMS");
  });

  test("REG-FE-RAIL-007 switching rail clears the reference typed for the previous one", async () => {
    const { user } = renderUI(<Harness initial={{ railId: "tb", method: "telebirr", reference: "CH7" }} />);
    await pick(user, "CBE");
    expect(lastSeen()).toEqual({ railId: "cbe", method: "cbe", reference: "" });
    expect(screen.getByLabelText(/Transaction reference/)).toHaveValue("");
  });

  test("REG-FE-RAIL-008 no bank check off the plan: the status endpoint is not even asked", async () => {
    renderUI(<Harness initial={{ railId: "cbe", method: "cbe", reference: "FT25" }} />);
    await new Promise((r) => setTimeout(r, 20));
    expect(api.verificationAvailable).not.toHaveBeenCalled();
    expect(screen.queryByRole("button", { name: /Check with the bank/ })).not.toBeInTheDocument();
  });

  test("REG-FE-RAIL-009 on the plan but the deployment has no key: no check button", async () => {
    auth.flags = new Set(["payment_verification"]);
    api.verificationAvailable.mockResolvedValue({ available: false });
    renderUI(<Harness initial={{ railId: "cbe", method: "cbe", reference: "FT25" }} />);
    await waitFor(() => expect(api.verificationAvailable).toHaveBeenCalled());
    expect(screen.queryByRole("button", { name: /Check with the bank/ })).not.toBeInTheDocument();
  });

  test("REG-FE-RAIL-010 the check needs a reference and a named provider", async () => {
    auth.flags = new Set(["payment_verification"]);
    const { unmount } = renderUI(<Harness initial={{ railId: "cbe", method: "cbe", reference: "  " }} />);
    await waitFor(() => expect(api.verificationAvailable).toHaveBeenCalled());
    expect(screen.queryByRole("button", { name: /Check with the bank/ })).not.toBeInTheDocument();
    unmount();
    renderUI(<Harness initial={{ railId: "mob", method: "mobile", reference: "X1" }} />);
    await new Promise((r) => setTimeout(r, 20));
    expect(screen.queryByRole("button", { name: /Check with the bank/ })).not.toBeInTheDocument();
  });

  test("REG-FE-RAIL-011 verified: the check sends rail, trimmed reference, expected amount and patient; shows what the bank said", async () => {
    auth.flags = new Set(["payment_verification"]);
    api.verifyPayment.mockResolvedValue({ state: "verified", reason: "Matches", amount: "500.00", sender: "Abebe", account: "1000***" });
    const { user } = renderUI(<Harness initial={{ railId: "cbe", method: "cbe", reference: " FT25 " }} />);
    await user.click(await screen.findByRole("button", { name: /Check with the bank/ }));
    await waitFor(() => expect(api.verifyPayment).toHaveBeenCalledWith({ rail_id: "cbe", reference: "FT25", expected: "500.00", patient_id: "pat_1" }));
    expect(await screen.findByText("Confirmed by the bank")).toBeInTheDocument();
    expect(screen.getByText("Matches")).toBeInTheDocument();
    expect(screen.getByText("500.00 ETB")).toBeInTheDocument();
    expect(screen.getByText(/from Abebe/)).toBeInTheDocument();
    expect(screen.getByText(/to 1000\*\*\*/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Check again/ })).toBeInTheDocument();
    expect(lastSeen().check?.state).toBe("verified");
  });

  test.each([
    ["rejected", "The bank does not confirm this"],
    ["review", "Needs a second look"],
    ["pending", "The bank has not answered yet"],
    ["unchecked", "Not checked"],
  ] as const)("REG-FE-RAIL-012 the bank's answer %s reads as '%s'", (state, words) => {
    renderUI(<Harness initial={{ railId: "cbe", method: "cbe", reference: "FT", check: { state, reason: `why ${state}` } }} />);
    expect(screen.getByText(words)).toBeInTheDocument();
    expect(screen.getByText(`why ${state}`)).toBeInTheDocument();
  });

  test("REG-FE-RAIL-013 a check that cannot run is not a failed payment: it reads 'Not checked' and the desk can go on", async () => {
    auth.flags = new Set(["payment_verification"]);
    api.verifyPayment.mockRejectedValue(new Error("network"));
    const { user } = renderUI(<Harness initial={{ railId: "cbe", method: "cbe", reference: "FT25" }} />);
    await user.click(await screen.findByRole("button", { name: /Check with the bank/ }));
    expect(await screen.findByText("Not checked")).toBeInTheDocument();
    expect(screen.getByText("The check could not be run.")).toBeInTheDocument();
    expect(paymentBlocked(lastSeen())).toBe(false);
  });

  test("REG-FE-RAIL-014 PaymentRefused: no way through for the desk; a manager gets a named override", async () => {
    const onForce = vi.fn();
    const { user, unmount } = renderUI(<PaymentRefused canOverride onForce={onForce} />);
    expect(screen.getByRole("button", { name: /bank did not confirm/ })).toBeDisabled();
    await user.click(screen.getByRole("button", { name: /Take it anyway — recorded against my name/ }));
    expect(onForce).toHaveBeenCalledTimes(1);
    unmount();
    const r2 = renderUI(<PaymentRefused onForce={onForce} />);
    expect(screen.queryByRole("button", { name: /Take it anyway/ })).not.toBeInTheDocument();
    expect(screen.getByText("A manager can override this.")).toBeInTheDocument();
    r2.unmount();
    renderUI(<PaymentRefused canOverride />);
    expect(screen.queryByRole("button", { name: /Take it anyway/ })).not.toBeInTheDocument();
    expect(screen.getByText(/Ask for another reference/)).toBeInTheDocument();
  });

  test("REG-FE-RAIL-015 usePaymentRails reads the clinic's active rails", async () => {
    admin.listPaymentRails.mockResolvedValue([CASH]);
    function Probe() {
      const q = usePaymentRails();
      return <p>{q.data?.map((r) => r.label).join(",") ?? "…"}</p>;
    }
    renderUI(<Probe />);
    expect(await screen.findByText("Cash")).toBeInTheDocument();
    expect(admin.listPaymentRails).toHaveBeenCalledWith();
  });
});
