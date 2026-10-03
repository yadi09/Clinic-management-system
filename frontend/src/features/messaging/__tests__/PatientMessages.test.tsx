// The patient's message panel ("did she get hers?"), shown on the dental patient page.
//
// What it must get right: it asks for THIS patient's messages only; every status
// reads in desk words, and a message that did not go out names the reason, since
// each reason means a different next step; one summary counts the people who were
// not reached; "Send now" / "Try again" / "Send again" appear only when the server
// allows them AND the reader may send, reach the right endpoint, and refresh the
// log; a retried message stops offering a button somebody has already pressed.
import { screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

const api = vi.hoisted(() => ({ messageLog: vi.fn(), resendMessage: vi.fn(), sendMessageNow: vi.fn() }));
const perms = vi.hoisted(() => ({ set: new Set<string>(["message.send"]) }));
const toast = vi.hoisted(() => Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn() }));

vi.mock("@/features/messaging/api", async (orig) => ({ ...(await orig<object>()), ...api }));
vi.mock("@/components/ui/sonner", async (orig) => ({ ...(await orig<object>()), toast }));
vi.mock("@/app/auth-context", () => ({
  useAuth: () => ({ can: (p: string) => perms.set.has(p), flagOn: () => true }),
}));

import { PatientMessages } from "../PatientMessages";
import type { MessageRow } from "@/features/messaging/api";
import { AppError } from "@/lib/api-client";
import { renderUI } from "@/test/render";

const row = (id: string, extra: Partial<MessageRow> = {}): MessageRow => ({
  id, kind: "welcome", lang: "en", msisdn: "+251911223344", body: `Body ${id}`, segments: 1, cost: "0.50",
  status: "delivered", scheduled_for: "2026-10-03T06:00:00Z", created_at: "2026-10-03T05:00:00Z",
  delivered_at: "2026-10-03T06:01:00Z", can_resend: false, can_send_now: false, retried: false, ...extra,
});
const card = (body: string) => screen.getByText(body).closest("div.rounded-md") as HTMLElement;

describe("REG-FE-PMSG the patient's messages", () => {
  beforeEach(() => {
    perms.set = new Set(["message.send"]);
    [...Object.values(api), toast, toast.success, toast.error].forEach((f) => f.mockReset());
    api.resendMessage.mockResolvedValue(undefined);
    api.sendMessageNow.mockResolvedValue(undefined);
  });
  afterEach(() => vi.useRealTimers());

  test("REG-FE-PMSG-001 while loading: says so; asks only for this patient's messages", () => {
    api.messageLog.mockReturnValue(new Promise(() => {}));
    renderUI(<PatientMessages patientId="pat_1" />);
    expect(screen.getByText("Loading…")).toBeInTheDocument();
    expect(api.messageLog).toHaveBeenCalledWith({ patient: "pat_1" });
  });

  test("REG-FE-PMSG-002 nothing sent: says so and where automatic messages are set up", async () => {
    api.messageLog.mockResolvedValue([]);
    renderUI(<PatientMessages patientId="pat_1" />);
    expect(await screen.findByText("Nothing has been sent to this patient.")).toBeInTheDocument();
    expect(screen.getByText(/set up under Patient messages/)).toBeInTheDocument();
  });

  test("REG-FE-PMSG-003 every status in desk words, every kind named, number, segments and cost", async () => {
    api.messageLog.mockResolvedValue([
      row("m1"),
      row("m2", { status: "sent", kind: "appointment_reminder", delivered_at: undefined, sent_at: "2026-10-03T06:00:00Z", segments: 2, cost: "1.00" }),
      row("m3", { status: "scheduled", kind: "bill_reminder", delivered_at: undefined }),
      row("m4", { status: "sending", kind: "custom", delivered_at: undefined }),
      row("m5", { status: "cancelled", kind: "birthday", delivered_at: undefined, msisdn: "" }),
      row("m6", { status: "weird" as MessageRow["status"], delivered_at: undefined }),
    ]);
    renderUI(<PatientMessages patientId="pat_1" />);
    await screen.findByText("Body m1");
    expect(within(card("Body m1")).getByText("Delivered")).toBeInTheDocument();
    expect(within(card("Body m1")).getByText("Welcome")).toBeInTheDocument();
    expect(within(card("Body m1")).getByText("+251911223344 · 1 message · 0.50 ETB")).toBeInTheDocument();
    expect(within(card("Body m2")).getByText("Sent")).toBeInTheDocument();
    expect(within(card("Body m2")).getByText("Appointment reminder")).toBeInTheDocument();
    expect(within(card("Body m2")).getByText(/2 messages · 1\.00 ETB/)).toBeInTheDocument();
    expect(within(card("Body m2")).getByText(/network accepted it; waiting for the handset/)).toBeInTheDocument();
    expect(within(card("Body m3")).getByText("Waiting")).toBeInTheDocument();
    expect(within(card("Body m3")).getByText("Unpaid bill")).toBeInTheDocument();
    expect(within(card("Body m3")).getByText(/^Waiting until .* outside the clinic's quiet hours\.$/)).toBeInTheDocument();
    expect(within(card("Body m4")).getByText("Sending")).toBeInTheDocument();
    expect(within(card("Body m4")).getByText("Written by staff")).toBeInTheDocument();
    expect(within(card("Body m5")).getByText("Cancelled")).toBeInTheDocument();
    expect(within(card("Body m5")).getByText("birthday")).toBeInTheDocument();
    expect(within(card("Body m5")).getByText(/^no number · /)).toBeInTheDocument();
    expect(within(card("Body m6")).getByText("weird")).toBeInTheDocument();
    // All of these went out or are on their way: no "never reached" summary.
    expect(screen.queryByText(/never reached this patient/)).not.toBeInTheDocument();
  });

  test("REG-FE-PMSG-004 not sent / failed: the reason in plain words, and how many were never reached", async () => {
    api.messageLog.mockResolvedValue([
      row("a", { status: "skipped", skip_reason: "unsupported_network", delivered_at: undefined }),
      row("b", { status: "skipped", skip_reason: "no_consent", delivered_at: undefined }),
      row("c", { status: "skipped", skip_reason: "brand_new_reason", delivered_at: undefined }),
      row("d", { status: "skipped", delivered_at: undefined }),
      row("e", { status: "failed", last_error: "gateway timeout", delivered_at: undefined }),
      row("f", { status: "failed", delivered_at: undefined }),
    ]);
    renderUI(<PatientMessages patientId="pat_1" />);
    expect(await screen.findByText(/^6 messages never reached this patient\./)).toBeInTheDocument();
    expect(within(card("Body a")).getByText("Not sent")).toBeInTheDocument();
    expect(within(card("Body a")).getByText("Not sent — the number is not an Ethio Telecom number, which is all this gateway reaches.")).toBeInTheDocument();
    expect(within(card("Body b")).getByText("Not sent — this patient asked not to be messaged.")).toBeInTheDocument();
    expect(within(card("Body c")).getByText("Not sent — brand_new_reason.")).toBeInTheDocument();
    expect(within(card("Body d")).queryByText(/Not sent —/)).not.toBeInTheDocument();
    expect(within(card("Body e")).getByText("Failed — gateway timeout")).toBeInTheDocument();
    expect(within(card("Body f")).queryByText(/Failed —/)).not.toBeInTheDocument();
  });

  test("REG-FE-PMSG-005 one unreached message is counted in the singular", async () => {
    api.messageLog.mockResolvedValue([row("a", { status: "failed", delivered_at: undefined }), row("b")]);
    renderUI(<PatientMessages patientId="pat_1" />);
    expect(await screen.findByText(/^1 message never reached this patient\./)).toBeInTheDocument();
  });

  test("REG-FE-PMSG-006 Try again on a failed message: POSTs a resend, toasts, refreshes the log", async () => {
    api.messageLog.mockResolvedValue([row("m1", { status: "failed", can_resend: true, delivered_at: undefined, cost: "0.75" })]);
    const { user } = renderUI(<PatientMessages patientId="pat_1" />);
    await screen.findByText("Body m1");
    expect(screen.getByText(/Costs 0\.75 ETB and re-reads the number/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Send now/ })).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /Try again/ }));
    await waitFor(() => expect(api.resendMessage).toHaveBeenCalledWith("m1"));
    expect(toast.success).toHaveBeenCalledWith("Queued to send again");
    await waitFor(() => expect(api.messageLog).toHaveBeenCalledTimes(2));
  });

  test("REG-FE-PMSG-007 a delivered or sent message offers Send again, not Try again", async () => {
    api.messageLog.mockResolvedValue([
      row("m1", { can_resend: true }),
      row("m2", { status: "sent", can_resend: true, delivered_at: undefined }),
    ]);
    renderUI(<PatientMessages patientId="pat_1" />);
    await screen.findByText("Body m1");
    expect(within(card("Body m1")).getByRole("button", { name: /Send again/ })).toBeInTheDocument();
    expect(within(card("Body m2")).getByRole("button", { name: /Send again/ })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Try again/ })).not.toBeInTheDocument();
  });

  test("REG-FE-PMSG-008 Send now releases a message waiting out quiet hours", async () => {
    perms.set = new Set(["message.manage"]);
    api.messageLog.mockResolvedValue([row("m1", { status: "scheduled", can_send_now: true, delivered_at: undefined })]);
    const { user } = renderUI(<PatientMessages patientId="pat_1" />);
    await user.click(await screen.findByRole("button", { name: /Send now/ }));
    await waitFor(() => expect(api.sendMessageNow).toHaveBeenCalledWith("m1"));
    expect(toast.success).toHaveBeenCalledWith("Sending now");
    expect(api.resendMessage).not.toHaveBeenCalled();
  });

  test("REG-FE-PMSG-009 the server's refusal is shown in its own words; anything else gets a plain fallback", async () => {
    api.messageLog.mockResolvedValue([
      row("m1", { status: "failed", can_resend: true, delivered_at: undefined }),
      row("m2", { status: "scheduled", can_send_now: true, delivered_at: undefined }),
    ]);
    api.resendMessage.mockRejectedValueOnce(new AppError(409, "quota", "Monthly allowance used up"))
      .mockRejectedValueOnce(new Error("network"));
    api.sendMessageNow.mockRejectedValueOnce(new AppError(409, "x", "Already sent"))
      .mockRejectedValueOnce(new Error("network"));
    const { user } = renderUI(<PatientMessages patientId="pat_1" />);
    await screen.findByText("Body m1");
    await user.click(screen.getByRole("button", { name: /Try again/ }));
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith("Monthly allowance used up"));
    await user.click(screen.getByRole("button", { name: /Try again/ }));
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith("Could not send it again"));
    await user.click(screen.getByRole("button", { name: /Send now/ }));
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith("Already sent"));
    await user.click(screen.getByRole("button", { name: /Send now/ }));
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith("Could not send it now"));
    expect(toast.success).not.toHaveBeenCalled();
  });

  test("REG-FE-PMSG-010 a message already retried keeps its record but offers no second button", async () => {
    api.messageLog.mockResolvedValue([row("m1", { status: "failed", can_resend: true, retried: true, delivered_at: undefined })]);
    renderUI(<PatientMessages patientId="pat_1" />);
    expect(await screen.findByText("Tried again — see the newer attempt above.")).toBeInTheDocument();
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
    expect(screen.queryByText(/^Costs/)).not.toBeInTheDocument();
  });

  test("REG-FE-PMSG-011 a reader who may not send sees the outcome but no buttons", async () => {
    perms.set = new Set();
    api.messageLog.mockResolvedValue([row("m1", { status: "failed", can_resend: true, can_send_now: true, delivered_at: undefined })]);
    renderUI(<PatientMessages patientId="pat_1" />);
    await screen.findByText("Body m1");
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
  });

  test("REG-FE-PMSG-012 the server not allowing it: no buttons even for a sender", async () => {
    api.messageLog.mockResolvedValue([row("m1", { status: "failed", delivered_at: undefined })]);
    renderUI(<PatientMessages patientId="pat_1" />);
    await screen.findByText("Body m1");
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
  });

  test.fails("REG-FE-PMSG-013 KNOWN BUG NEW-PROF-4 a log that fails to load must not tell the desk nothing was sent", async () => {
    // PatientMessages.tsx:475-479 checks isLoading, then rows.length: a failed
    // request leaves data undefined and the panel says "Nothing has been sent to
    // this patient." — the exact false answer this panel was built to stop giving
    // (its own header: the clinic concluded SMS was broken from a missing window).
    api.messageLog.mockRejectedValue(new Error("502"));
    renderUI(<PatientMessages patientId="pat_1" />);
    await new Promise((r) => setTimeout(r, 50));
    expect(screen.queryByText("Nothing has been sent to this patient.")).not.toBeInTheDocument();
  });
});
