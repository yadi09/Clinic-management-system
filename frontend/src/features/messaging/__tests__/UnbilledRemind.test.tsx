// Reminding patients about unbilled treatment by SMS (opened from the dental
// Unbilled page). What the clinic relies on: the wording starts in the clinic's
// language; the preview shows exactly who will be reached and who cannot be (no
// phone, opted out) and why; the Send button counts only reachable patients, is
// off when nobody is reachable or SMS sending is switched off; a send reports how
// many were queued and what it cost; a failure says why; a double click spends
// once; a patient chased this week is flagged.
import { configure, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, test, vi } from "vitest";

vi.mock("@/lib/api-client", async (orig) => ({ ...(await orig<object>()), ...(await import("@/test/frontdesk")).apiModule }));
vi.mock("@/components/ui/sonner", async (orig) => ({ ...(await orig<object>()), toast: (await import("@/test/frontdesk")).toastSpy }));

import { UnbilledRemindDialog } from "@/features/messaging/UnbilledRemind";
import type { UnbilledRemindRow } from "@/features/messaging/api";
import { fail, fake, hang, resetToasts, toasts, type Req } from "@/test/frontdesk";
import { renderUI } from "@/test/render";

const settings = (over: object = {}) => ({
  enabled: true, lang: "en", quiet_from: "", quiet_to: "", sender_name: "", sender_status: "none",
  has_own_key: false, body_prefix: "", ...over,
});
const row = (id: string, over: Partial<UnbilledRemindRow> = {}): UnbilledRemindRow => ({
  patient_id: id, patient_name: `Patient ${id}`, mrn: `MRN-${id}`, body: `Dear ${id}, you owe.`, segments: 1, cost: "0.50", ...over,
});
const daysBack = (n: number) => new Date(Date.now() - n * 86_400_000 - 3_600_000).toISOString();

function serve(rows: UnbilledRemindRow[], cost = "1.00") {
  fake.on("POST", "/messaging/unbilled-reminders", (r: Req) =>
    (r.body as { preview?: boolean }).preview
      ? { rows, segments: rows.length, cost, queued: 0, skipped: 0 }
      : { rows, segments: rows.length, cost, queued: rows.filter((x) => !x.skip_reason).length, skipped: 0 });
}
const sends = () => fake.sent("POST", "/messaging/unbilled-reminders").filter((r) => !(r.body as { preview?: boolean }).preview);

function open(ids = ["tss_1", "tss_2"]) {
  const onClose = vi.fn();
  const onSent = vi.fn();
  const r = renderUI(<UnbilledRemindDialog sessionIds={ids} onClose={onClose} onSent={onSent} />);
  return { ...r, onClose, onSent };
}

// The preview waits out a 400 ms debounce after the settings load; on a loaded
// machine under coverage that outlasts the 1 s default wait.
configure({ asyncUtilTimeout: 4000 });

beforeEach(() => {
  fake.reset();
  resetToasts();
  fake.on("GET", "/messaging/settings", settings());
});

describe("REG-FE-UREM reminding patients about unbilled treatment", () => {
  test("REG-FE-UREM-001 the wording starts in the clinic's language and the preview is asked for those rows", async () => {
    serve([row("p1")]);
    open();
    const box = await screen.findByLabelText("Message");
    await waitFor(() => expect((box as HTMLTextAreaElement).value).toMatch(/^Dear \{\{name\}\}, for your \{\{treatment\}\}/));
    await screen.findByText("Dear p1, you owe.");
    const prev = fake.sent("POST", "/messaging/unbilled-reminders")[0].body as { session_ids: string[]; preview: boolean; body: string };
    expect(prev.session_ids).toEqual(["tss_1", "tss_2"]);
    expect(prev.preview).toBe(true);
    expect(prev.body).toContain("{{amount}}");
  });

  test("REG-FE-UREM-002 an Amharic clinic starts from the Amharic wording", async () => {
    fake.on("GET", "/messaging/settings", settings({ lang: "am" }));
    serve([]);
    open();
    const box = (await screen.findByLabelText("Message")) as HTMLTextAreaElement;
    await waitFor(() => expect(box.value).toMatch(/^ውድ \{\{name\}\}/));
  });

  test("REG-FE-UREM-003 reachable vs unreachable: skipped patients say why and are not counted or charged", async () => {
    serve([
      row("p1", { segments: 2, cost: "1.00" }),
      row("p2", { skip_reason: "no_phone" }),
      row("p3", { skip_reason: "no_consent" }),
      row("p4", { skip_reason: "bad_phone" }),
      row("p5", { skip_reason: "unsupported_network" }),
      row("p6", { skip_reason: "weird", patient_name: "" }),
    ], "1.00");
    open();
    expect(await screen.findByText("1 of 6 reachable")).toBeInTheDocument();
    expect(screen.getByText("no phone number on file")).toBeInTheDocument();
    expect(screen.getByText("asked not to be messaged")).toBeInTheDocument();
    expect(screen.getByText("number is not a valid mobile")).toBeInTheDocument();
    expect(screen.getByText("not an Ethio Telecom number")).toBeInTheDocument();
    expect(screen.getByText("cannot be reached")).toBeInTheDocument();
    expect(screen.getByText("Patient")).toBeInTheDocument(); // nameless row
    expect(screen.getByText("2 msgs · 1.00 ETB")).toBeInTheDocument();
    // A skipped patient's message body is not shown.
    expect(screen.queryByText("Dear p2, you owe.")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Send 1 reminder · 1.00 ETB/ })).toBeEnabled();
  });

  test("REG-FE-UREM-004 nobody reachable: Send is disabled", async () => {
    serve([row("p1", { skip_reason: "no_phone" })]);
    open();
    await screen.findByText("0 of 1 reachable");
    expect(screen.getByRole("button", { name: /Send 0 reminders/ })).toBeDisabled();
  });

  test("REG-FE-UREM-005 SMS sending switched off: a warning, preview still works, Send disabled", async () => {
    fake.on("GET", "/messaging/settings", settings({ enabled: false }));
    serve([row("p1")]);
    open();
    expect(await screen.findByText(/Sending is switched off under Patient messages/)).toBeInTheDocument();
    await screen.findByText("Dear p1, you owe.");
    expect(screen.getByRole("button", { name: /Send 1 reminder/ })).toBeDisabled();
  });

  test("REG-FE-UREM-006 sending: the server is told the rows and the wording, the desk sees count and cost", async () => {
    serve([row("p1"), row("p2")], "1.00");
    const { user, onSent } = open();
    const btn = await screen.findByRole("button", { name: /Send 2 reminders · 1.00 ETB/ });
    await user.click(btn);
    await waitFor(() => expect(onSent).toHaveBeenCalledTimes(1));
    const body = sends()[0].body as { session_ids: string[]; body: string; preview?: boolean };
    expect(body.session_ids).toEqual(["tss_1", "tss_2"]);
    expect(body.preview).toBeUndefined();
    expect(body.body).toMatch(/^Dear \{\{name\}\}/);
    expect(toasts("success")).toEqual(["2 reminders queued · 1.00 ETB"]);
  });

  test("REG-FE-UREM-007 one queued reads in the singular", async () => {
    serve([row("p1")], "0.50");
    const { user } = open();
    await user.click(await screen.findByRole("button", { name: /Send 1 reminder · 0.50 ETB/ }));
    await waitFor(() => expect(toasts("success")).toEqual(["1 reminder queued · 0.50 ETB"]));
  });

  test("REG-FE-UREM-008 a send the server refuses shows its reason and leaves the dialog open", async () => {
    fake.on("POST", "/messaging/unbilled-reminders", (r: Req) =>
      (r.body as { preview?: boolean }).preview
        ? { rows: [row("p1")], segments: 1, cost: "0.50", queued: 0, skipped: 0 }
        : fail(402, "Not enough SMS credit")());
    const { user, onSent } = open();
    await user.click(await screen.findByRole("button", { name: /Send 1 reminder/ }));
    await waitFor(() => expect(toasts("error")).toEqual(["Not enough SMS credit"]));
    expect(onSent).not.toHaveBeenCalled();
    expect(screen.getByText("Remind about unpaid treatment")).toBeInTheDocument();
  });

  test("REG-FE-UREM-009 a non-server failure gets a plain message", async () => {
    fake.on("POST", "/messaging/unbilled-reminders", (r: Req) => {
      if ((r.body as { preview?: boolean }).preview) return { rows: [row("p1")], segments: 1, cost: "0.50", queued: 0, skipped: 0 };
      throw new TypeError("network down");
    });
    const { user } = open();
    await user.click(await screen.findByRole("button", { name: /Send 1 reminder/ }));
    await waitFor(() => expect(toasts("error")).toEqual(["Could not send the reminders"]));
  });

  test("REG-FE-UREM-010 a double click spends once", async () => {
    let release!: () => void;
    fake.on("POST", "/messaging/unbilled-reminders", (r: Req) =>
      (r.body as { preview?: boolean }).preview
        ? { rows: [row("p1")], segments: 1, cost: "0.50", queued: 0, skipped: 0 }
        : new Promise((res) => { release = () => res({ rows: [], segments: 1, cost: "0.50", queued: 1, skipped: 0 }); }));
    const { user, onSent } = open();
    const btn = await screen.findByRole("button", { name: /Send 1 reminder/ });
    await user.dblClick(btn);
    await user.click(btn);
    expect(sends()).toHaveLength(1);
    release();
    await waitFor(() => expect(onSent).toHaveBeenCalledTimes(1));
  });

  test("REG-FE-UREM-011 a patient reminded this week is flagged by name; several are counted", async () => {
    serve([row("p1", { last_reminded_at: daysBack(2) }), row("p2", { last_reminded_at: daysBack(30) })]);
    const first = open();
    expect(await screen.findByText("Patient p1 was already reminded this week — they will be messaged again.")).toBeInTheDocument();
    expect(screen.getByText("reminded 2d ago")).toBeInTheDocument();
    expect(screen.getByText("reminded 30d ago")).toBeInTheDocument();
    first.unmount();

    serve([row("p1", { last_reminded_at: daysBack(1) }), row("p2", { last_reminded_at: daysBack(3), patient_name: "" }),
      row("p3", { last_reminded_at: daysBack(1), skip_reason: "no_phone" })]);
    open();
    expect(await screen.findByText("2 of these patients were already reminded this week — they will be messaged again.")).toBeInTheDocument();
  });

  test("REG-FE-UREM-012 a nameless patient reminded this week reads 'One patient'", async () => {
    serve([row("p1", { last_reminded_at: daysBack(0), patient_name: "" })]);
    open();
    expect(await screen.findByText("One patient was already reminded this week — they will be messaged again.")).toBeInTheDocument();
  });

  test("REG-FE-UREM-013 the blanks chips append to the wording and the preview follows the edit", async () => {
    serve([row("p1")]);
    const { user } = open();
    const box = (await screen.findByLabelText("Message")) as HTMLTextAreaElement;
    await waitFor(() => expect(box.value).not.toBe(""));
    await user.clear(box);
    await user.type(box, "Hi ");
    await user.click(screen.getByRole("button", { name: "{{card}}" }));
    expect(box.value).toBe("Hi {{card}}");
    await waitFor(() => expect(fake.sent("POST", "/messaging/unbilled-reminders")
      .some((r) => (r.body as { body: string }).body === "Hi {{card}}")).toBe(true), { timeout: 3000 });
  });

  test("REG-FE-UREM-014 an empty wording asks for no preview and offers nothing to send", async () => {
    serve([row("p1")]);
    const { user } = open();
    const box = (await screen.findByLabelText("Message")) as HTMLTextAreaElement;
    await waitFor(() => expect(box.value).not.toBe(""));
    await user.clear(box);
    await waitFor(() => expect(screen.getByText("Nothing to preview.")).toBeInTheDocument(), { timeout: 3000 });
    expect(screen.getByRole("button", { name: /Send 0 reminders/ })).toBeDisabled();
  });

  test("REG-FE-UREM-015 while the preview loads it says so; Cancel and closing call onClose", async () => {
    fake.on("POST", "/messaging/unbilled-reminders", hang);
    const { user, onClose } = open();
    expect(await screen.findByText("Working it out…")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onClose).toHaveBeenCalledTimes(1);
    await user.keyboard("{Escape}");
    expect(onClose).toHaveBeenCalledTimes(2);
  });
});
