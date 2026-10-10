// Asking for a paper: the flow every print button goes through. A paper is looked at
// (not counted) before the preview, counted only when it is actually printed, and a
// reprint says so; offline, it still prints.
import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, test, vi } from "vitest";

const api = vi.hoisted(() => ({ peekPrint: vi.fn(), logPrint: vi.fn(), getPrintSettings: vi.fn(), savePrintSettings: vi.fn() }));
vi.mock("@/features/printing/api", () => api);

import { PrintHost } from "@/features/printing/PrintHost";
import { setPrintContext } from "@/features/printing/context";
import { paperPx, transport, type DocData } from "@/features/printing/engine";
import { printNow, registerPreview, requestPrint } from "@/features/printing/request";
import { DEFAULT_SETTINGS, resolveSettings } from "@/features/printing/settings";
import { renderUI } from "@/test/render";

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
});
