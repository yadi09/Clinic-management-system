// Patient messages as a dental clinic configures them: the state banner that says
// why nothing is going out, the monthly meter, the three automations, writing to a
// chosen set of patients, the sending settings, a test, and the log.
import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, test, vi } from "vitest";

// Whole-page flows with many clicks; the shared 5s budget is too tight when the full
// suite runs in parallel (and under scripts/test/time-sweep.sh).
vi.setConfig({ testTimeout: 20_000 });

vi.mock("@/app/auth-context", async () => (await import("@/test/admin")).authModule);
vi.mock("@/components/ui/sonner", async (orig) => ({ ...(await orig<object>()), toast: (await import("@/test/admin")).toastSpy }));
const api = vi.hoisted(() => ({
  getMessagingSettings: vi.fn(), saveMessagingSettings: vi.fn(), messagingUsage: vi.fn(), previewMessage: vi.fn(),
  messageLog: vi.fn(), sendTestMessage: vi.fn(), listTemplates: vi.fn(), saveTemplate: vi.fn(), listRules: vi.fn(),
  saveRule: vi.fn(), messageVariables: vi.fn(), messageAudience: vi.fn(), sendCampaign: vi.fn(),
}));
vi.mock("@/features/messaging/api", async (orig) => ({ ...(await orig<object>()), ...api }));

import { MessagesPage } from "@/features/messaging/pages/MessagesPage";
import type { MessageRow, MessagingSettings } from "@/features/messaging/api";
import { AppError } from "@/lib/api-client";
import { resetToasts, setAuth, toastSpy } from "@/test/admin";
import { renderUI } from "@/test/render";

const SETTINGS: MessagingSettings = {
  enabled: true, lang: "en", quiet_from: "21:00", quiet_to: "07:00", sender_name: "Cure Dental", sender_id: "CureDental",
  sender_status: "approved", has_own_key: true, body_prefix: "", gateway_live: true, gateway_name: "SMSEthiopia", cost_per_segment: 0.5,
};
const USAGE = { used_segments: 120, limit: 1000, sent: 100, failed: 2, skipped: 1, cost: "60.00" };
const settings = (over: Partial<MessagingSettings>) => api.getMessagingSettings.mockResolvedValue({ ...SETTINGS, ...over });
const page = () => renderUI(<MessagesPage />);
const goTab = async (user: ReturnType<typeof page>["user"], name: string) => user.click(screen.getByRole("tab", { name }));

beforeEach(() => {
  setAuth({ flags: ["dental", "messaging"] });
  resetToasts();
  for (const f of Object.values(api)) f.mockResolvedValue(undefined);
  api.getMessagingSettings.mockResolvedValue(SETTINGS);
  api.messagingUsage.mockResolvedValue(USAGE);
  api.listRules.mockResolvedValue([
    { kind: "welcome", enabled: true, offset_hours: 0, repeat_days: 0, max_repeats: 0, sent: 12 },
    { kind: "appointment_reminder", enabled: false, offset_hours: -24, send_at: "18:00", repeat_days: 0, max_repeats: 0, sent: 0 },
    { kind: "bill_reminder", enabled: true, offset_hours: 72, repeat_days: 7, max_repeats: 2, sent: 3 },
  ]);
  api.listTemplates.mockResolvedValue([
    { kind: "welcome", lang: "en", body: "Welcome {{name}}, card {{mrn}}", preview: "Welcome Almaz, card CD-1", segments: 1, unicode: false, cost: "0.50" },
    { kind: "appointment_reminder", lang: "en", body: "Reminder", preview: "Reminder", segments: 2, unicode: true, cost: "1.00" },
    { kind: "welcome", lang: "am", body: "እንኳን", preview: "እንኳን", segments: 1, unicode: true, cost: "0.50" },
  ]);
  api.messageVariables.mockResolvedValue([{ name: "name", describes: "First name" }, { name: "mrn", describes: "Card number" }]);
  api.previewMessage.mockImplementation(async (body: string) => ({ body: `Cure: ${body}`, segments: body.length > 20 ? 2 : 1, unicode: false, chars: body.length, per_segment: 160, cost: "0.50" }));
  api.messageLog.mockResolvedValue([]);
  api.messageAudience.mockResolvedValue([]);
});

describe("REG-FE-MSG state banner and meter", () => {
  test.each([
    [{ gateway_live: false }, "Messaging is not connected"],
    [{ has_own_key: false }, "Sending on the shared platform account"],
    [{ sender_status: "pending" as const }, "Waiting for Ethio Telecom to approve the sender name"],
    [{ sender_status: "rejected" as const }, "Ethio Telecom rejected the sender name"],
    [{ enabled: false }, "Sending is switched off"],
  ])("REG-FE-MSG-001 the banner names why nothing goes out (%o)", async (over, title) => {
    settings(over);
    page();
    expect(await screen.findByText(title)).toBeInTheDocument();
  });

  test("REG-FE-MSG-002 pending sender: names the sender id, or the name when there is no id", async () => {
    settings({ sender_status: "pending", sender_id: "" });
    page();
    expect(await screen.findByText("Cure Dental", { selector: "b" })).toBeInTheDocument();
  });

  test("REG-FE-MSG-003 the allowance: used up, nearly used, fine", async () => {
    api.messagingUsage.mockResolvedValue({ ...USAGE, used_segments: 1000 });
    const a = page();
    expect(await screen.findByText("This month's allowance is used up")).toBeInTheDocument();
    a.unmount();
    api.messagingUsage.mockResolvedValue({ ...USAGE, used_segments: 850 });
    const b = page();
    expect(await screen.findByText("You are near this month's limit")).toBeInTheDocument();
    expect(screen.getByText("150 messages left of 1,000.")).toBeInTheDocument();
    b.unmount();
    api.messagingUsage.mockResolvedValue(USAGE);
    page();
    expect(await screen.findByText("Sending is on")).toBeInTheDocument();
    expect(screen.getByText("CureDental", { selector: "b" })).toBeInTheDocument();
    expect(screen.getByText(/Quiet between 21:00 and 07:00/)).toBeInTheDocument();
  });

  test("REG-FE-MSG-004 not approved but live: patients see a shared number, so the name leads", async () => {
    settings({ sender_status: "none" });
    page();
    expect(await screen.findByText("Cure Dental:")).toBeInTheDocument();
  });

  test("REG-FE-MSG-005 the meter: segments against the cap, cost, failures; no cap says so", async () => {
    const a = page();
    expect(await screen.findByText("/ 1,000")).toBeInTheDocument();
    expect(screen.getByText("60.00 ETB")).toBeInTheDocument();
    expect(screen.getByText("· 2 failed")).toBeInTheDocument();
    a.unmount();
    api.messagingUsage.mockResolvedValue({ ...USAGE, limit: undefined, failed: 0 });
    page();
    expect(await screen.findByText("No monthly limit on your plan.")).toBeInTheDocument();
    expect(screen.queryByText(/failed/)).not.toBeInTheDocument();
  });

  test("REG-FE-MSG-006 the meter turns amber past 80% and red at the cap", async () => {
    api.messagingUsage.mockResolvedValue({ ...USAGE, used_segments: 900 });
    const a = page();
    await screen.findByText("/ 1,000");
    expect(document.querySelector(".bg-amber-500")).not.toBeNull();
    a.unmount();
    api.messagingUsage.mockResolvedValue({ ...USAGE, used_segments: 1200 });
    page();
    await screen.findByText("/ 1,000");
    expect(document.querySelector(".h-full.bg-destructive")).not.toBeNull();
  });
});

describe("REG-FE-MSG automations", () => {
  test("REG-FE-MSG-010 three automations, on/off, sent this month, and timing in a sentence", async () => {
    page();
    expect(await screen.findByText("Welcome and card number")).toBeInTheDocument();
    expect(await screen.findByText("12 sent this month")).toBeInTheDocument();
    expect(screen.getByText("Sent straight away, when the patient is registered.")).toBeInTheDocument();
    expect(screen.getByText("Sent 1 day before the appointment, at 18:00.")).toBeInTheDocument();
    expect(screen.getByText("Sent 3 days after the bill appears, then every 7 days up to 2 more times.")).toBeInTheDocument();
    expect(screen.getAllByText("On")).toHaveLength(2);
    expect(screen.getByText(/You are editing the/)).toHaveTextContent("English");
  });

  test("REG-FE-MSG-011 turning one on saves the rule with its signed offset", async () => {
    const { user } = page();
    await screen.findByText("12 sent this month");
    await user.click(screen.getByRole("button", { name: "Turn on" }));
    await waitFor(() => expect(api.saveRule).toHaveBeenCalledWith({
      kind: "appointment_reminder", enabled: true, offset_hours: -24, send_at: "18:00", repeat_days: 0, max_repeats: 0,
    }));
    await user.click(screen.getAllByRole("button", { name: "Turn off" })[0]);
    await waitFor(() => expect(api.saveRule).toHaveBeenCalledWith({
      kind: "welcome", enabled: false, offset_hours: 0, send_at: "", repeat_days: 0, max_repeats: 0,
    }));
  });

  test("REG-FE-MSG-012 edit the bill reminder: hours, time, repeat; insert a variable; save wording and timing", async () => {
    api.listTemplates.mockResolvedValue([]);
    const { user } = page();
    await screen.findByText("12 sent this month");
    const card = () => screen.getByText("Unpaid bill reminder").closest(".rounded-lg, [class*=card]") as HTMLElement ?? document.body;
    await user.click(screen.getAllByRole("button", { name: /Edit/ })[2]);
    const hours = screen.getByLabelText("Hours after the bill");
    expect(hours).toHaveValue(72);
    fireEvent.change(hours, { target: { value: "48" } });
    fireEvent.change(screen.getByLabelText("Send at"), { target: { value: "09:30" } });
    const rep = screen.getByLabelText("Repeat every (days)");
    fireEvent.change(rep, { target: { value: "3" } });
    await user.click(screen.getByRole("combobox"));
    await user.click(await screen.findByRole("option", { name: "Once only" }));
    const body = screen.getByLabelText("What it says (English)");
    await user.type(body, "Dear ");
    await user.click(screen.getByRole("button", { name: "{{name}}" }));
    expect(body).toHaveValue("Dear {{name}}");
    expect(screen.getByText("Unsaved changes to the wording.")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Save wording" }));
    await waitFor(() => expect(api.saveTemplate).toHaveBeenCalledWith({ kind: "bill_reminder", lang: "en", body: "Dear {{name}}" }));
    expect(toastSpy.success).toHaveBeenCalledWith("Wording saved");
    await user.click(screen.getByRole("button", { name: "Save timing" }));
    await waitFor(() => expect(api.saveRule).toHaveBeenCalledWith({
      kind: "bill_reminder", enabled: true, offset_hours: 48, send_at: "09:30", repeat_days: 3, max_repeats: 0,
    }));
    void card;
    await user.click(screen.getByRole("button", { name: /Hide/ }));
    expect(screen.queryByLabelText("Hours after the bill")).not.toBeInTheDocument();
  });

  // NEW-MSG-1. The hours / repeat boxes coerce an empty value to 1 on every
  // keystroke (`Number(v) || 1`), so backspacing "72" away and typing "48" saves 148
  // hours — the box can never be emptied to retype a number.
  test.fails("REG-FE-MSG-017 KNOWN BUG NEW-MSG-1 clearing the hours box and typing a new number keeps that number", async () => {
    const { user } = page();
    await screen.findByText("12 sent this month");
    await user.click(screen.getAllByRole("button", { name: /Edit/ })[2]);
    const hours = screen.getByLabelText("Hours after the bill");
    await user.clear(hours);
    await user.type(hours, "48");
    expect(hours).toHaveValue(48);
  });

  test("REG-FE-MSG-013 the welcome editor has no timing, and shows what a patient sees and costs", async () => {
    const { user } = page();
    await screen.findByText("Welcome and card number");
    await user.click(screen.getAllByRole("button", { name: /Edit/ })[0]);
    expect(screen.queryByLabelText("Send at")).not.toBeInTheDocument();
    expect(screen.getByText("Welcome Almaz, card CD-1")).toBeInTheDocument();
    expect(screen.getByText(/1 message \(160 characters each\) · 0.50 ETB each time/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Save timing" })).not.toBeInTheDocument();
    await user.click(screen.getAllByRole("button", { name: /Edit/ })[0]); // now the reminder
    expect(screen.getByLabelText("Hours before")).toHaveValue(24);
    expect(screen.getByText(/2 messages \(Amharic, 70 characters each\)/)).toBeInTheDocument();
  });

  test("REG-FE-MSG-014 refusals are said, in the server's words or a fallback", async () => {
    api.saveRule.mockRejectedValueOnce(new AppError(402, "PLAN", "Reminders need the Practice plan")).mockRejectedValueOnce("x");
    api.saveTemplate.mockRejectedValueOnce(new AppError(422, "V", "Unknown variable {{foo}}")).mockRejectedValueOnce("x");
    const { user } = page();
    await screen.findByText("12 sent this month");
    await user.click(screen.getByRole("button", { name: "Turn on" }));
    await waitFor(() => expect(toastSpy.error).toHaveBeenCalledWith("Reminders need the Practice plan"));
    await user.click(screen.getByRole("button", { name: "Turn on" }));
    await waitFor(() => expect(toastSpy.error).toHaveBeenCalledWith("Could not save"));
    await user.click(screen.getAllByRole("button", { name: /Edit/ })[0]);
    await user.type(screen.getByLabelText("What it says (English)"), "!");
    await user.click(screen.getByRole("button", { name: "Save wording" }));
    await waitFor(() => expect(toastSpy.error).toHaveBeenCalledWith("Unknown variable {{foo}}"));
    await user.click(screen.getByRole("button", { name: "Save wording" }));
    await waitFor(() => expect(toastSpy.error).toHaveBeenCalledWith("Could not save the wording"));
  });

  test("REG-FE-MSG-015 an Amharic clinic edits the Amharic wording; staff without manage only read", async () => {
    settings({ lang: "am" });
    setAuth({ flags: ["dental", "messaging"], perms: ["message.send"] });
    const { user } = page();
    await screen.findByText("Welcome and card number");
    await waitFor(() => expect(screen.getByText(/You are editing the/)).toHaveTextContent("Amharic"));
    expect(screen.queryByRole("button", { name: /Turn/ })).not.toBeInTheDocument();
    await user.click(screen.getAllByRole("button", { name: /Edit/ })[0]);
    expect(screen.getByLabelText("What it says (Amharic)")).toHaveValue("እንኳን");
    expect(screen.getByLabelText("What it says (Amharic)")).toBeDisabled();
    expect(screen.queryByRole("button", { name: "Save wording" })).not.toBeInTheDocument();
  });

  test("REG-FE-MSG-016 timing sentences for odd hours and a single repeat", async () => {
    api.listRules.mockResolvedValue([
      { kind: "appointment_reminder", enabled: true, offset_hours: -3, repeat_days: 0, max_repeats: 0, sent: 0 },
      { kind: "bill_reminder", enabled: true, offset_hours: 24, repeat_days: 5, max_repeats: 1, sent: 0 },
    ]);
    page();
    expect(await screen.findByText("Sent 3 hours before the appointment.")).toBeInTheDocument();
    expect(screen.getByText("Sent 1 day after the bill appears, then every 5 days up to 1 more time.")).toBeInTheDocument();
  });
});

describe("REG-FE-MSG write to patients", () => {
  const AUD = [
    { id: "p1", name: "Almaz Haile", mrn: "CD-1", phone: "0911000001", reachable: true, opted_out: false, owes: "1500.4" },
    { id: "p2", name: "Tesfaye Alemu", mrn: "CD-2", phone: "0911000002", reachable: true, opted_out: false },
    { id: "p3", name: "", mrn: "", reachable: false, phone_issue: "unsupported", opted_out: false },
    { id: "p4", name: "Selam", mrn: "CD-4", phone: "0911000004", reachable: true, opted_out: true },
    { id: "p5", name: "Kebede", mrn: "CD-5", reachable: false, opted_out: false },
  ];

  test("REG-FE-MSG-020 who gets it: reachable ones ticked; unreachable and opted-out shown, not ticked", async () => {
    api.messageAudience.mockResolvedValue(AUD);
    const { user } = page();
    await goTab(user, "Write to patients");
    expect(await screen.findByText("Almaz Haile")).toBeInTheDocument();
    expect(api.messageAudience).toHaveBeenCalledWith({ q: undefined, seen_days: 180, not_seen_days: undefined, owing: undefined });
    expect(screen.getByText("will be messaged").parentElement).toHaveTextContent("2 will be messaged");
    expect(screen.getByText("· 2 cannot be reached")).toBeInTheDocument();
    expect(screen.getByText("· 1 asked not to be messaged")).toBeInTheDocument();
    expect(screen.getByText("owes 1500 ETB")).toBeInTheDocument();
    expect(screen.getByText("Unnamed")).toBeInTheDocument();
    expect(screen.getByText("not an Ethio Telecom number")).toBeInTheDocument();
    expect(screen.getByText("cannot be reached")).toBeInTheDocument();
    expect(screen.getByText("Asked not to be messaged")).toBeInTheDocument();
    const boxes = screen.getAllByRole("checkbox").slice(1); // first is "only owing"
    expect(boxes.map((b) => (b as HTMLInputElement).checked)).toEqual([true, true, false, false, false]);
    await user.click(boxes[0]);
    expect(screen.getByText("will be messaged").parentElement).toHaveTextContent("1 will be messaged");
    await user.click(screen.getByRole("button", { name: "Clear" }));
    expect(screen.getByText("will be messaged").parentElement).toHaveTextContent("0 will be messaged");
    await user.click(screen.getByRole("button", { name: "Select all" }));
    expect(screen.getByText("will be messaged").parentElement).toHaveTextContent("2 will be messaged");
  });

  test("REG-FE-MSG-021 filters: search, owing only, last visit; recall options only with the recalls plan", async () => {
    const { user } = page();
    await goTab(user, "Write to patients");
    expect(await screen.findByText("No patients match that filter.")).toBeInTheDocument();
    await user.type(screen.getByLabelText("Name or card number"), "alm");
    await user.click(screen.getAllByRole("checkbox")[0]);
    await waitFor(() => expect(api.messageAudience).toHaveBeenLastCalledWith({ q: "alm", seen_days: 180, not_seen_days: undefined, owing: true }));
    await user.click(screen.getAllByRole("combobox")[0]);
    expect(screen.queryByRole("option", { name: "Not been in for a year" })).not.toBeInTheDocument();
    await user.click(screen.getByRole("option", { name: "Any time" }));
    await waitFor(() => expect(api.messageAudience).toHaveBeenLastCalledWith({ q: "alm", seen_days: undefined, not_seen_days: undefined, owing: true }));
  });

  test("REG-FE-MSG-022 a recall list (Practice plan): 'not been in for a year'", async () => {
    setAuth({ flags: ["dental", "messaging", "recalls"] });
    const { user } = page();
    await goTab(user, "Write to patients");
    await user.click(screen.getAllByRole("combobox")[0]);
    await user.click(await screen.findByRole("option", { name: "Not been in for a year" }));
    await waitFor(() => expect(api.messageAudience).toHaveBeenLastCalledWith({ q: undefined, seen_days: undefined, not_seen_days: 365, owing: undefined }));
    expect(screen.getByText(/Recall list — whoever has been away longest/)).toBeInTheDocument();
  });

  test("REG-FE-MSG-023 the message is priced live, confirmed with its cost, and sent to exactly the ticked patients", async () => {
    api.messageAudience.mockResolvedValue(AUD);
    api.sendCampaign.mockResolvedValue({ id: "c1", queued: 2, skipped: 0, segments: 4, cost: "2.00" });
    const { user } = page();
    await goTab(user, "Write to patients");
    await screen.findByText("Almaz Haile");
    const send = screen.getByRole("button", { name: /Review and send/ });
    expect(send).toBeDisabled();
    await user.type(screen.getByLabelText("What this is (for your records)"), "Holiday");
    await user.type(screen.getByLabelText("Message"), "Closed Monday, ");
    await user.click(screen.getByRole("button", { name: "{{name}}" }));
    expect(await screen.findByText(/≈/)).toHaveTextContent("2 recipients ≈ 2.00 ETB");
    expect(screen.getByText("Cure: Closed Monday, {{name}}")).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("Send"), { target: { value: "2026-10-05T09:00" } });
    await user.click(send);
    const dlg = screen.getByRole("dialog", { name: "Send to 2 patients?" });
    expect(dlg).toHaveTextContent("About 2.00 ETB, 2 messages each.");
    await user.click(within(dlg).getByRole("button", { name: "Send" }));
    await waitFor(() => expect(api.sendCampaign).toHaveBeenCalledWith({
      title: "Holiday", body: "Closed Monday, {{name}}", patient_ids: ["p1", "p2"], scheduled_for: new Date("2026-10-05T09:00").toISOString(),
    }));
    expect(toastSpy.success).toHaveBeenCalledWith("2 messages queued · 2.00 ETB");
    expect(screen.getByLabelText("Message")).toHaveValue("");
  });

  test("REG-FE-MSG-024 one recipient, untitled, sent now", async () => {
    api.messageAudience.mockResolvedValue([AUD[0]]);
    api.sendCampaign.mockResolvedValue({ id: "c1", queued: 1, skipped: 0, segments: 1, cost: "0.50" });
    const { user } = page();
    await goTab(user, "Write to patients");
    await screen.findByText("Almaz Haile");
    await user.type(screen.getByLabelText("Message"), "Hi");
    await screen.findByText(/1 recipient ≈/);
    await user.click(screen.getByRole("button", { name: /Review and send/ }));
    await user.click(within(screen.getByRole("dialog", { name: "Send to 1 patient?" })).getByRole("button", { name: "Send" }));
    await waitFor(() => expect(api.sendCampaign).toHaveBeenCalledWith({ title: "Message to patients", body: "Hi", patient_ids: ["p1"], scheduled_for: undefined }));
    expect(toastSpy.success).toHaveBeenCalledWith("1 message queued · 0.50 ETB");
  });

  test("REG-FE-MSG-025 sending off: nothing can be sent from here", async () => {
    settings({ enabled: false });
    api.messageAudience.mockResolvedValue([AUD[0]]);
    const { user } = page();
    await goTab(user, "Write to patients");
    await screen.findByText("Almaz Haile");
    await user.type(screen.getByLabelText("Message"), "Hi");
    expect(screen.getByRole("button", { name: /Review and send/ })).toBeDisabled();
    expect(screen.getByText("Turn sending on under Sending first.")).toBeInTheDocument();
  });
});

describe("REG-FE-MSG sending settings and test", () => {
  test("REG-FE-MSG-030 settings load into the form; a new key is sent only when typed", async () => {
    const { user } = page();
    await goTab(user, "Sending");
    expect(await screen.findByLabelText("Sender name patients see")).toHaveValue("CureDental");
    expect(screen.getByPlaceholderText(/stored — type to replace/)).toBeInTheDocument();
    expect(screen.getByText(/Not used — the phone already shows/)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Save settings" }));
    await waitFor(() => expect(api.saveMessagingSettings).toHaveBeenCalledWith({
      enabled: true, lang: "en", quiet_from: "21:00", quiet_to: "07:00", sender_name: "Cure Dental", sender_id: "CureDental",
      sender_status: "approved", api_key: undefined,
    }));
    expect(toastSpy.success).toHaveBeenCalledWith("Sending settings saved");
    await user.type(screen.getByLabelText("API key"), "  k-123  ");
    await user.click(screen.getByRole("checkbox"));
    await user.clear(screen.getByLabelText("Name inside the message"));
    await user.type(screen.getByLabelText("Name inside the message"), "Cure");
    fireEvent.change(screen.getByLabelText("Quiet from"), { target: { value: "22:00" } });
    fireEvent.change(screen.getByLabelText("Quiet until"), { target: { value: "06:30" } });
    await user.clear(screen.getByLabelText("Sender name patients see"));
    await user.click(screen.getAllByRole("combobox")[0]);
    await user.click(await screen.findByRole("option", { name: "Waiting for approval" }));
    await user.click(screen.getAllByRole("combobox")[1]);
    await user.click(await screen.findByRole("option", { name: /Amharic/ }));
    expect(screen.getByText(/Amharic fits/)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Save settings" }));
    await waitFor(() => expect(api.saveMessagingSettings).toHaveBeenLastCalledWith({
      enabled: false, lang: "am", quiet_from: "22:00", quiet_to: "06:30", sender_name: "Cure", sender_id: "",
      sender_status: "pending", api_key: "k-123",
    }));
  });

  test("REG-FE-MSG-031 not approved: the name leads every message, and the preview says how", async () => {
    settings({ sender_status: "none", has_own_key: false, sender_id: undefined });
    const { user } = page();
    await goTab(user, "Sending");
    expect(await screen.findByText(/Patients see “/)).toHaveTextContent("Patients see “Cure Dental: …”.");
    expect(screen.getByText("From the SMS console: Console → API Keys.")).toBeInTheDocument();
    expect(screen.getByText(/the clinic's name has to lead the text/)).toBeInTheDocument();
  });

  test("REG-FE-MSG-032 a refused save is said", async () => {
    api.saveMessagingSettings.mockRejectedValueOnce(new AppError(422, "KEY", "That API key was rejected")).mockRejectedValueOnce("x");
    const { user } = page();
    await goTab(user, "Sending");
    await screen.findByLabelText("API key");
    await user.click(screen.getByRole("button", { name: "Save settings" }));
    await waitFor(() => expect(toastSpy.error).toHaveBeenCalledWith("That API key was rejected"));
    await user.click(screen.getByRole("button", { name: "Save settings" }));
    await waitFor(() => expect(toastSpy.error).toHaveBeenCalledWith("Could not save"));
  });

  test("REG-FE-MSG-033 a test goes to the typed number, priced first; failures are said", async () => {
    const { user } = page();
    await goTab(user, "Sending");
    const btn = await screen.findByRole("button", { name: /Send test/ });
    expect(btn).toBeDisabled();
    expect(await screen.findByText("Cure: This is a test message.")).toBeInTheDocument();
    expect(screen.getByText((_, el) => el?.tagName === "P" && /^23 characters/.test(el.textContent ?? ""))).toHaveTextContent("23 characters · 2 messages (160 characters each) · 0.50 ETB");
    await user.type(screen.getByLabelText("Phone number"), "0911223344");
    await user.click(btn);
    await waitFor(() => expect(api.sendTestMessage).toHaveBeenCalledWith("0911223344", "This is a test message."));
    expect(toastSpy.success).toHaveBeenCalledWith("Queued — it should arrive within a minute");
    api.sendTestMessage.mockRejectedValueOnce(new AppError(400, "PHONE", "Not an Ethio Telecom number")).mockRejectedValueOnce("x");
    await user.click(btn);
    await waitFor(() => expect(toastSpy.error).toHaveBeenCalledWith("Not an Ethio Telecom number"));
    await user.click(btn);
    await waitFor(() => expect(toastSpy.error).toHaveBeenCalledWith("Could not queue it"));
    await user.clear(screen.getByLabelText("Message"));
    await user.type(screen.getByLabelText("Message"), "Hi");
    expect(await screen.findByText((_, el) => el?.tagName === "P" && /^2 characters · 1 message \(160 characters each\)/.test(el.textContent ?? ""))).toBeInTheDocument();
  });

  test("REG-FE-MSG-034 with sending off a test cannot go; staff without manage cannot edit", async () => {
    settings({ enabled: false, cost_per_segment: 0 });
    setAuth({ flags: ["dental", "messaging"], perms: ["message.send"] });
    api.previewMessage.mockResolvedValue({ body: "x", segments: 1, unicode: true, chars: 5, per_segment: 70, cost: "0" });
    const { user } = page();
    await goTab(user, "Sending");
    expect(await screen.findByText("Turn sending on first — a test is a real message.")).toBeInTheDocument();
    expect(screen.getByLabelText("API key")).toBeDisabled();
    expect(screen.queryByRole("button", { name: "Save settings" })).not.toBeInTheDocument();
    expect(await screen.findByText(/70 characters each, Amharic\)/)).toBeInTheDocument();
  });
});

describe("REG-FE-MSG log", () => {
  const row = (over: Partial<MessageRow>): MessageRow => ({
    id: "m", kind: "appointment_reminder", lang: "en", msisdn: "251911000001", body: "Reminder for tomorrow", segments: 1, cost: "0.50",
    status: "delivered", scheduled_for: "2026-10-02T06:00:00Z", can_resend: false, can_send_now: false, retried: false,
    created_at: "2026-10-02T05:00:00Z", ...over,
  });

  test("REG-FE-MSG-040 every status says what it means; skipped and failed say why", async () => {
    api.messageLog.mockResolvedValue([
      row({ id: "1", status: "delivered", patient_name: "Almaz", mrn: "CD-1", delivered_at: "2026-10-02T06:01:00Z" }),
      row({ id: "2", status: "sent", kind: "welcome", sent_at: "2026-10-02T06:00:00Z", segments: 2 }),
      row({ id: "3", status: "scheduled", kind: "bill_reminder" }),
      row({ id: "4", status: "failed", kind: "custom", last_error: "gateway timeout" }),
      row({ id: "5", status: "skipped", skip_reason: "no_consent", msisdn: "" }),
      row({ id: "6", status: "skipped", skip_reason: "brand_new_reason" }),
      row({ id: "7", status: "cancelled" as MessageRow["status"], kind: "odd_kind" }),
      row({ id: "8", status: "weird" as MessageRow["status"] }),
    ]);
    const { user } = page();
    await goTab(user, "Message log");
    expect(await screen.findByText("Delivered")).toBeInTheDocument();
    expect(screen.getByText("The network accepted it. Waiting for the handset to confirm.")).toBeInTheDocument();
    expect(screen.getByText(/Waiting to send at/)).toBeInTheDocument();
    expect(screen.getByText("Failed — gateway timeout")).toBeInTheDocument();
    expect(screen.getByText("Not sent — this patient asked not to be messaged.")).toBeInTheDocument();
    expect(screen.getByText("Not sent — brand_new_reason.")).toBeInTheDocument();
    expect(screen.getByText("Cancelled")).toBeInTheDocument();
    expect(screen.getByText("odd_kind")).toBeInTheDocument();
    expect(screen.getByText("weird")).toBeInTheDocument();
    expect(screen.getByText("Almaz")).toBeInTheDocument();
    expect(screen.getByText("2 msgs, 0.50 ETB")).toBeInTheDocument();
  });

  test("REG-FE-MSG-041 empty log points to the test; the status filter asks the server", async () => {
    const { user } = page();
    await goTab(user, "Message log");
    expect(await screen.findByText(/Nothing sent yet/)).toBeInTheDocument();
    await user.click(screen.getByRole("combobox"));
    await user.click(await screen.findByRole("option", { name: "Failed" }));
    await waitFor(() => expect(api.messageLog).toHaveBeenLastCalledWith({ status: "failed" }));
    await user.click(screen.getByRole("combobox"));
    await user.click(await screen.findByRole("option", { name: "All messages" }));
    expect(screen.getByRole("combobox")).toHaveTextContent("All messages");
  });

  test("REG-FE-MSG-042 before settings load there is no banner and no meter", () => {
    api.getMessagingSettings.mockReturnValue(new Promise(() => {}));
    api.messagingUsage.mockReturnValue(new Promise(() => {}));
    page();
    expect(screen.queryByText(/Sending is/)).not.toBeInTheDocument();
    expect(screen.queryByText("this month")).not.toBeInTheDocument();
    act(() => {});
  });
});
