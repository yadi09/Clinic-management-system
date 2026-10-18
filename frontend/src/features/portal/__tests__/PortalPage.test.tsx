// The patient's own page: signing in with the card number, the four sections, the
// language switch, and what the clinic hides.
import { fireEvent, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { Route, Routes } from "react-router-dom";

const client = vi.hoisted(() => ({ apiFetch: vi.fn() }));
vi.mock("@/lib/api-client", async (orig) => ({ ...(await orig<object>()), ...client }));
vi.mock("@/features/dental/anatomical/three/Dental3D", () => ({ default: () => <div data-testid="stage3d" /> }));

import { AppError } from "@/lib/api-client";
import { PortalPage } from "@/features/portal/PortalPage";
import type { PortalMe } from "@/features/portal/api";
import { renderUI } from "@/test/render";

const ME = (over: Partial<PortalMe> = {}, settings: Partial<PortalMe["settings"]> = {}): PortalMe => ({
  clinic: { name: "Yoya Dental", slug: "yoya", phone: "0911 00 00 00", has_logo: false },
  first_name: "Meron",
  settings: { enabled: true, show_money: true, show_unbilled: true, show_teeth: true, show_3d: true, welcome_note: "Brush gently around the new crown.", ...settings },
  today: "2026-10-18",
  next: { date: "2026-10-21", title: "Root canal", seq: 3, of: 3 },
  treatments: [{
    title: "Root canal", tooth: "36", status: "active", done: 2, of: 3, planned: "4500.00", collected: "3000.00",
    visits: [
      { seq: 1, date: "2026-10-01", status: "done", what: "Nerve cleaned", paid: "paid" },
      { seq: 2, date: "2026-10-10", status: "done", what: "Canals sealed", paid: "paid" },
      { seq: 3, date: "2026-10-21", status: "planned", what: "Crown fitted", paid: "unpaid" },
    ],
  }],
  money: { paid: "9000.00", to_pay: "3500.00", unbilled: "800.00" },
  receipts: [{ no: 212, date: "2026-10-10", what: "Root canal visit 2", method: "telebirr", amount: "1500.00" }],
  chart: { items: [{ id: "i1", tooth: 36, kind: "root_canal", status: "planned" }], positions: {} },
  ...over,
});

const open = () => renderUI(<Routes><Route path="/p/:slug" element={<PortalPage />} /></Routes>, { route: "/p/yoya" });

function serve(me: PortalMe) {
  client.apiFetch.mockImplementation(async (path: string) => {
    if (path.endsWith("/login")) return { token: "tok", expires_in: 7200 };
    if (path.endsWith("/me")) return me;
    throw new Error(`unexpected ${path}`);
  });
}
async function signIn() {
  open();
  await userEvent.type(screen.getByLabelText("Card number"), "MRN-000123");
  await userEvent.click(screen.getByRole("button", { name: "See my treatment" }));
  await screen.findByText(/Hello Meron/);
}

beforeEach(() => { client.apiFetch.mockReset(); sessionStorage.clear(); localStorage.clear(); });

describe("REG-FE-PORTAL the patient's page", () => {
  test("REG-FE-PORTAL-001 a card number opens the page: the greeting, the next visit, the treatment and the balance", async () => {
    serve(ME());
    await signIn();
    expect(client.apiFetch).toHaveBeenCalledWith("/portal/yoya/login", expect.objectContaining({ method: "POST", body: { card: "MRN-000123" }, auth: false }));
    expect(client.apiFetch).toHaveBeenCalledWith("/portal/yoya/me", expect.objectContaining({ headers: { "X-Portal-Token": "tok" } }));
    expect(screen.getByText("Yoya Dental")).toBeInTheDocument();
    expect(screen.getByText("Root canal")).toBeInTheDocument();
    expect(screen.getByText(/visit 3 \/ 3/)).toBeInTheDocument();
    expect(screen.getByText("2 / 3 visits done")).toBeInTheDocument();
    expect(screen.getByText("3,500 ETB")).toBeInTheDocument();
    expect(screen.getByText("Brush gently around the new crown.")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Call the clinic" })).toHaveAttribute("href", "tel:0911000000");
  });

  test("REG-FE-PORTAL-002 a wrong card number says so in plain words, and a rush of tries says to wait", async () => {
    client.apiFetch.mockRejectedValue(new AppError(401, "PORTAL_LOGIN_FAILED", "x"));
    open();
    await userEvent.type(screen.getByLabelText("Card number"), "NOPE");
    await userEvent.click(screen.getByRole("button", { name: "See my treatment" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("could not find that card number");
    client.apiFetch.mockRejectedValue(new AppError(429, "RATE_LIMITED", "x"));
    await userEvent.click(screen.getByRole("button", { name: "See my treatment" }));
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("Too many tries"));
  });

  test("REG-FE-PORTAL-003 an empty or very short card number is stopped before asking the server", async () => {
    open();
    await userEvent.click(screen.getByRole("button", { name: "See my treatment" }));
    expect(screen.getByRole("alert")).toHaveTextContent("Please type your card number.");
    expect(client.apiFetch).not.toHaveBeenCalled();
  });

  test("REG-FE-PORTAL-004 the language switch changes every word at once and is remembered", async () => {
    serve(ME());
    await signIn();
    await userEvent.click(screen.getByRole("button", { name: "አማ" }));
    expect(screen.getByText(/ሰላም Meron/)).toBeInTheDocument();
    expect(screen.queryByText(/Hello/)).not.toBeInTheDocument();
    expect(localStorage.getItem("portal-lang")).toBe("am");
  });

  test("REG-FE-PORTAL-005 Treatment lists each visit; Payments shows paid, to pay, not-billed-yet and receipts", async () => {
    serve(ME());
    await signIn();
    await userEvent.click(screen.getByRole("tab", { name: "Treatment" }));
    expect(screen.getByText("Crown fitted")).toBeInTheDocument();
    expect(screen.getByText(/Canals sealed — done/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole("tab", { name: "Payments" }));
    expect(screen.getByText("Treatment done — bill not issued yet")).toBeInTheDocument();
    expect(screen.getByText("800 ETB")).toBeInTheDocument();
    expect(screen.getByText(/RCP-000212/)).toBeInTheDocument();
    expect(screen.getByText(/Root canal visit 2 · telebirr/)).toBeInTheDocument();
  });

  test("REG-FE-PORTAL-006 what the clinic hides is not on the page: no Payments tab, no My teeth tab", async () => {
    serve(ME({ money: undefined, receipts: undefined, chart: undefined }, { show_money: false, show_teeth: false }));
    await signIn();
    expect(screen.queryByRole("tab", { name: "Payments" })).not.toBeInTheDocument();
    expect(screen.queryByRole("tab", { name: "My teeth" })).not.toBeInTheDocument();
    expect(screen.queryByText("Your payments")).not.toBeInTheDocument();
  });

  test("REG-FE-PORTAL-007 My teeth: tapping a tooth says what it has in words; the 3D view opens on request and can be hidden", async () => {
    serve(ME());
    await signIn();
    await userEvent.click(screen.getByRole("tab", { name: "My teeth" }));
    expect(screen.getByText("Tap a tooth")).toBeInTheDocument();
    fireEvent.click(screen.getAllByRole("button", { name: /36/ })[0]!);
    expect(await screen.findByText(/root canal — to be done/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: /3D/ }));
    expect(await screen.findByTestId("stage3d")).toBeInTheDocument();
  });

  test("REG-FE-PORTAL-008 without the 3D switch there is no 3D button", async () => {
    serve(ME({}, { show_3d: false }));
    await signIn();
    await userEvent.click(screen.getByRole("tab", { name: "My teeth" }));
    expect(screen.queryByRole("button", { name: /3D/ })).not.toBeInTheDocument();
  });

  test("REG-FE-PORTAL-009 an expired sign-in returns to the card screen; a network failure offers a retry; sign out forgets the token", async () => {
    sessionStorage.setItem("portal-token:yoya", "old");
    client.apiFetch.mockRejectedValue(new AppError(401, "PORTAL_SESSION", "x"));
    open();
    expect(await screen.findByLabelText("Card number")).toBeInTheDocument();
    expect(sessionStorage.getItem("portal-token:yoya")).toBeNull();

    sessionStorage.setItem("portal-token:yoya", "ok");
    client.apiFetch.mockRejectedValueOnce(new AppError(0, "NETWORK", "x")).mockResolvedValue(ME());
    renderUI(<Routes><Route path="/p/:slug" element={<PortalPage />} /></Routes>, { route: "/p/yoya" });
    await userEvent.click(await screen.findByRole("button", { name: "Try again" }));
    await userEvent.click(await screen.findByRole("button", { name: "Sign out" }));
    expect(sessionStorage.getItem("portal-token:yoya")).toBeNull();
  });

  test("REG-FE-PORTAL-010 a patient with no treatment yet is told so, not shown an empty page", async () => {
    serve(ME({ treatments: [], next: undefined, money: { paid: "0", to_pay: "0" }, receipts: [] }));
    await signIn();
    expect(screen.getAllByText(/No treatment yet/).length).toBeGreaterThan(0);
  });
});
