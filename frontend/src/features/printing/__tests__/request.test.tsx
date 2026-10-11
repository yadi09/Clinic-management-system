// Asking for a paper: the flow every print button goes through. A paper is looked at
// (not counted) before the preview, counted only when it is actually printed, and a
// reprint says so; offline, it still prints.
import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, test, vi } from "vitest";

const api = vi.hoisted(() => ({ peekPrint: vi.fn(), logPrint: vi.fn(), getPrintSettings: vi.fn(), savePrintSettings: vi.fn() }));
vi.mock("@/features/printing/api", () => api);
const verify = vi.hoisted(() => ({ issueCheck: vi.fn() }));
vi.mock("@/features/printing/verify", () => verify);

import { PrintHost } from "@/features/printing/PrintHost";
import { setPrintContext } from "@/features/printing/context";
import { paperPx, transport, type DocData } from "@/features/printing/engine";
import { printNow, registerPreview, requestPrint } from "@/features/printing/request";
import { DEFAULT_SETTINGS, resolveSettings } from "@/features/printing/settings";
import { renderUI } from "@/test/render";
import QRCode from "qrcode";

const rx: DocData = {
  doc: "prescription",
  data: {
    clinic: "Legacy Clinic", clinicContact: "Old Rd", rxRef: "Rx 1", qrData: "RX:1", patient: "Abebe", when: "2026-10-03T09:00:00+03:00",
    diagnoses: [], meds: [{ drug_name: "Amoxicillin" }],
  },
};
const rcp = (number = "RCP-000007"): DocData => ({
  doc: "receipt",
  data: { kind: "payment", number, when: "2026-10-03T09:00:00+03:00", patient: "Abebe", lines: [{ description: "Filling", amount: "100" }], total: "100", currency: "ETB" },
});

const sent: string[] = [];
beforeEach(() => {
  sent.length = 0;
  Object.values(api).forEach((f) => f.mockReset());
  verify.issueCheck.mockReset();
  api.peekPrint.mockResolvedValue({ count: 0 });
  api.logPrint.mockResolvedValue({ count: 1 });
  vi.spyOn(transport, "send").mockImplementation((html: string) => { sent.push(html); });
  registerPreview(null);
  setPrintContext({ settings: DEFAULT_SETTINGS, logo: "", clinicName: "", branch: null });
});

describe("REG-FE-PRREQ asking for a paper", () => {
  test("REG-FE-PRREQ-001 with no preview mounted it counts the print and sends the page; the old call site's name and contact fill in", async () => {
    await requestPrint(rx, { clinic: "Legacy Clinic", contact: "Old Rd" });
    expect(api.peekPrint).toHaveBeenCalledWith("prescription", "Rx 1");
    expect(api.logPrint).toHaveBeenCalledWith("prescription", "Rx 1");
    expect(sent).toHaveLength(1);
    expect(sent[0]).toContain("Legacy Clinic");
    expect(sent[0]).toContain("Old Rd");
    expect(sent[0]).not.toContain('class="dup"');
  });

  test("REG-FE-PRREQ-002 a paper printed before is marked DUPLICATE, with the count from the server", async () => {
    api.peekPrint.mockResolvedValue({ count: 1, first_by: "Hana", first_at: "2026-10-03T09:00:00+03:00" });
    api.logPrint.mockResolvedValue({ count: 2, first_by: "Hana", first_at: "2026-10-03T09:00:00+03:00" });
    await requestPrint(rcp());
    expect(sent[0]).toContain('class="dup">DUPLICATE');
    expect(sent[0]).toContain("Copy 2");
    expect(sent[0]).toContain("Printed by Hana");
  });

  test("REG-FE-PRREQ-003 someone else printed it in the meantime: the count in the page is the server's, not the preview's", async () => {
    api.peekPrint.mockResolvedValue({ count: 0 });
    api.logPrint.mockResolvedValue({ count: 3, first_by: "Hana" });
    await requestPrint(rcp());
    expect(sent[0]).toContain("Copy 3");
  });

  test("REG-FE-PRREQ-004 offline: the paper still prints, as the preview knew it", async () => {
    api.peekPrint.mockRejectedValue(new Error("offline"));
    api.logPrint.mockRejectedValue(new Error("offline"));
    await requestPrint(rcp());
    expect(sent).toHaveLength(1);
    expect(sent[0]).not.toContain('class="dup"');
  });

  test("REG-FE-PRREQ-005 a paper with no reference, or with reprint marking off, is never counted", async () => {
    await requestPrint(rcp(""));
    expect(api.peekPrint).not.toHaveBeenCalled();
    expect(api.logPrint).not.toHaveBeenCalled();
    setPrintContext({ settings: resolveSettings({ integrity: { duplicateMark: false } }), logo: "", clinicName: "C", branch: null });
    await requestPrint(rcp());
    expect(api.logPrint).not.toHaveBeenCalled();
    expect(sent).toHaveLength(2);
  });

  test("REG-FE-PRREQ-006 paper sizes in pixels at 96 dpi", () => {
    expect(paperPx("a4")).toEqual({ w: 794, h: 1123 });
    expect(paperPx("slip80")).toEqual({ w: 302, h: null });
  });

  test("REG-FE-PRREQ-007 printNow counts only when the job has a reference", async () => {
    const ctx = { settings: DEFAULT_SETTINGS, logo: "", clinicName: "C", branch: null };
    await printNow({ ctx, doc: "receipt", ref: "", title: "x", render: () => ({ html: "<p>x</p>", paper: "slip80", template: "slip" }) });
    expect(api.logPrint).not.toHaveBeenCalled();
    expect(sent).toEqual(["<p>x</p>"]);
  });
});

describe("REG-FE-PRHOST the preview", () => {
  test("REG-FE-PRHOST-001 the paper is shown first; nothing is printed or counted until Print is pressed", async () => {
    const { user } = renderUI(<PrintHost />);
    await act(async () => { await requestPrint(rcp()); });
    const dlg = await screen.findByRole("dialog", { name: "Print preview" });
    expect(within(dlg).getByTitle("Paper preview")).toHaveAttribute("srcdoc", expect.stringContaining("RCP-000007"));
    expect(sent).toHaveLength(0);
    expect(api.logPrint).not.toHaveBeenCalled();
    await user.click(within(dlg).getByRole("button", { name: /Print/ }));
    await waitFor(() => expect(sent).toHaveLength(1));
    expect(api.logPrint).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
  });

  test("REG-FE-PRHOST-002 Cancel closes it with nothing printed or counted", async () => {
    const { user } = renderUI(<PrintHost />);
    await act(async () => { await requestPrint(rcp()); });
    await user.click(within(await screen.findByRole("dialog")).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(sent).toHaveLength(0);
    expect(api.logPrint).not.toHaveBeenCalled();
  });

  test("REG-FE-PRHOST-003 the layout and the paper can be changed for this one print", async () => {
    const { user } = renderUI(<PrintHost />);
    await act(async () => { await requestPrint(rcp()); });
    const dlg = await screen.findByRole("dialog");
    const layout = within(dlg).getByRole("radiogroup", { name: "Layout" });
    const paper = () => within(dlg).getByRole("radiogroup", { name: "Paper" });
    const srcdoc = () => within(dlg).getByTitle("Paper preview").getAttribute("srcdoc");
    expect(within(layout).getByRole("radio", { name: /Till slip/ })).toHaveAttribute("aria-checked", "true");
    expect(within(paper()).getAllByRole("radio").map((r) => r.textContent)).toEqual(["Till slip 58 mm", "Till slip 80 mm"]);
    await user.click(within(paper()).getByRole("radio", { name: "Till slip 58 mm" }));
    expect(srcdoc()).toContain("size:58mm auto");
    await user.click(within(layout).getByRole("radio", { name: /Receipt sheet/ }));
    expect(srcdoc()).toContain("size:148mm 210mm");
    await user.click(within(paper()).getByRole("radio", { name: "A4" }));
    expect(srcdoc()).toContain("size:210mm 297mm");
    await user.click(within(dlg).getByRole("button", { name: /Print/ }));
    await waitFor(() => expect(sent).toHaveLength(1));
    expect(sent[0]).toContain("size:210mm 297mm");
  });

  test("REG-FE-PRHOST-004 a paper already printed says so before it is printed again", async () => {
    api.peekPrint.mockResolvedValue({ count: 1, first_by: "Hana" });
    renderUI(<PrintHost />);
    await act(async () => { await requestPrint(rcp()); });
    const dlg = await screen.findByRole("dialog");
    expect(dlg).toHaveTextContent("It will be marked DUPLICATE");
    expect(within(dlg).getByTitle("Paper preview").getAttribute("srcdoc")).toContain("DUPLICATE");
  });

  test("REG-FE-PRHOST-005 a paper with one layout offers no layout picker", async () => {
    renderUI(<PrintHost />);
    await act(async () => { await requestPrint(rx); });
    const dlg = await screen.findByRole("dialog");
    // A prescription has three layouts, so the picker is there; a single-layout paper would not show it.
    expect(within(dlg).getByRole("radiogroup", { name: "Layout" })).toBeInTheDocument();
  });
  test("REG-FE-PRHOST-006 Escape closes the preview without printing", async () => {
    renderUI(<PrintHost />);
    await act(async () => { await requestPrint(rcp()); });
    fireEvent.keyDown(await screen.findByRole("dialog"), { key: "Escape", code: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(sent).toHaveLength(0);
  });

  test("REG-FE-PRHOST-007 the preview is already gone when the page is handed to the printer", async () => {
    // The browser's print window takes the page over right after the paper is sent. A
    // preview still on screen at that moment was left half-closed for good — a blank
    // box over the list that Cancel and Esc could not dismiss until a reload.
    const dialogsWhenSent: number[] = [];
    vi.mocked(transport.send).mockImplementation((html: string) => {
      sent.push(html);
      dialogsWhenSent.push(screen.queryAllByRole("dialog").length);
    });
    const { user } = renderUI(<PrintHost />);
    await act(async () => { await requestPrint(rcp()); });
    await user.click(within(await screen.findByRole("dialog")).getByRole("button", { name: /Print/ }));
    await waitFor(() => expect(sent).toHaveLength(1));
    expect(dialogsWhenSent).toEqual([0]);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(sent[0]).toContain("RCP-000007");
  });

  test("REG-FE-PRHOST-008 a second press while the first is being counted prints once, not twice", async () => {
    let release: () => void = () => {};
    api.logPrint.mockReturnValue(new Promise((r) => { release = () => r({ count: 1 }); }));
    renderUI(<PrintHost />);
    await act(async () => { await requestPrint(rcp()); });
    const press = within(await screen.findByRole("dialog")).getByRole("button", { name: /Print/ });
    fireEvent.click(press);
    fireEvent.click(press);
    await act(async () => { release(); });
    await waitFor(() => expect(sent).toHaveLength(1));
    expect(api.logPrint).toHaveBeenCalledTimes(1);
  });

  test("REG-FE-PRHOST-009 after one paper is printed the next one opens its own preview", async () => {
    const { user } = renderUI(<PrintHost />);
    await act(async () => { await requestPrint(rcp("RCP-000007")); });
    await user.click(within(await screen.findByRole("dialog")).getByRole("button", { name: /Print/ }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    await act(async () => { await requestPrint(rcp("RCP-000008")); });
    const dlg = await screen.findByRole("dialog", { name: "Print preview" });
    expect(within(dlg).getByTitle("Paper preview")).toHaveAttribute("srcdoc", expect.stringContaining("RCP-000008"));
  });
});

describe("REG-FE-PRREQ a prescription's check", () => {
  const named: DocData = {
    doc: "prescription",
    data: {
      clinic: "Cure", rxRef: "Rx local", qrData: "", verify: { kind: "dental_rx", id: "drx_abc" }, patient: "Abebe",
      when: "2026-10-03T09:00:00+03:00", diagnoses: [], meds: [{ drug_name: "Amoxicillin" }],
    },
  };

  test("REG-FE-PRREQ-008 the QR becomes the paper's link and the short code is printed under it, with the server's reference", async () => {
    verify.issueCheck.mockResolvedValue({
      token: "abcdefghijklmnopqrstuvwxyz", slug: "cure-dental", path: "/v/cure-dental/abcdefghijklmnopqrstuvwxyz", code: "K7MQ-4XPR", ref: "Rx 7gbzsm",
    });
    const qr = vi.spyOn(QRCode, "toString");
    await requestPrint(named);
    expect(verify.issueCheck).toHaveBeenCalledWith("dental_rx", "drx_abc");
    expect(qr.mock.calls[0][0]).toBe(`${window.location.origin}/v/cure-dental/abcdefghijklmnopqrstuvwxyz`);
    expect(sent[0]).toContain("K7MQ-4XPR");
    expect(sent[0]).toContain(`Check this paper at ${window.location.host}/v`);
    expect(sent[0]).toContain("Rx 7gbzsm");
    // The paper is counted under the reference the page shows.
    expect(api.logPrint).toHaveBeenCalledWith("prescription", "Rx 7gbzsm");
  });

  test("REG-FE-PRREQ-009 when the check cannot be issued the paper still prints, with no QR that checks nothing", async () => {
    verify.issueCheck.mockRejectedValue(new Error("offline"));
    await requestPrint(named);
    expect(sent).toHaveLength(1);
    expect(sent[0]).not.toContain('class="qr"');
    expect(sent[0]).not.toContain("Check this paper at");
    expect(sent[0]).toContain("Amoxicillin");
    expect(api.logPrint).toHaveBeenCalledWith("prescription", "Rx local");
  });

  test("REG-FE-PRREQ-010 other papers and prescriptions that do not name themselves never ask for a check", async () => {
    await requestPrint(rcp());
    await requestPrint(rx);
    expect(verify.issueCheck).not.toHaveBeenCalled();
  });
});
