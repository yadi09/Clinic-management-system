// Settings → Printing: the clinic sets its identity once and chooses how each paper
// looks. What matters: what is read back, what is saved (and what is not sent — the
// logo when it was not touched), who may change it, and that the preview is the
// real template drawing the clinic's own draft.
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, test, vi } from "vitest";

const auth = vi.hoisted(() => ({ manage: true }));
vi.mock("@/app/auth-context", () => ({
  useAuth: () => ({ can: (p: string) => (p === "clinic.manage" ? auth.manage : true), flagOn: () => true, user: { id: "u", full_name: "Owner" }, activeBranchId: "b1" }),
}));
const api = vi.hoisted(() => ({ getPrintSettings: vi.fn(), savePrintSettings: vi.fn(), peekPrint: vi.fn(), logPrint: vi.fn() }));
vi.mock("@/features/printing/api", () => api);
const admin = vi.hoisted(() => ({ getClinic: vi.fn(), listBranches: vi.fn() }));
vi.mock("@/features/admin/api", async (orig) => ({ ...(await orig<object>()), ...admin }));
const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }));
vi.mock("sonner", async (orig) => ({ ...(await orig<object>()), toast }));

import { PrintingSettings } from "@/features/printing/PrintingSettings";
import { AppError } from "@/lib/api-client";
import { renderUI } from "@/test/render";

const PNG = "data:image/png;base64,iVBORw0KGgo=";
const preview = () => screen.getByTitle("Paper preview").getAttribute("srcdoc") ?? "";
const tab = (name: string | RegExp) => screen.getByRole("tab", { name });

async function open(stored: { settings?: unknown; logo?: string } = {}) {
  api.getPrintSettings.mockResolvedValue({ settings: stored.settings ?? {}, logo: stored.logo ?? "" });
  const r = renderUI(<PrintingSettings />);
  await screen.findByRole("tablist", { name: "Printing settings" });
  return r;
}

describe("REG-FE-PRSCR the printing settings screen", () => {
  beforeEach(() => {
    Object.values(api).forEach((f) => f.mockReset());
    Object.values(admin).forEach((f) => f.mockReset());
    Object.values(toast).forEach((f) => f.mockReset());
    auth.manage = true;
    admin.getClinic.mockResolvedValue({ name: "Registered Name", timezone: "Africa/Addis_Ababa", locale: "en" });
    admin.listBranches.mockResolvedValue([{ id: "b1", name: "Bole", code: "B1" }]);
    api.savePrintSettings.mockResolvedValue({ settings: {}, logo: "" });
  });

  test("REG-FE-PRSCR-001 it shows the stored identity and a preview that is the clinic's own receipt", async () => {
    await open({ settings: { identity: { nameEn: "Abeba Dental", tin: "0012345678" } }, logo: PNG });
    expect(screen.getByLabelText(/Clinic name \(English\)/i)).toBe(screen.getByPlaceholderText("Registered Name"));
    expect(screen.getByPlaceholderText("Registered Name")).toHaveValue("Abeba Dental");
    expect(screen.getByAltText("Clinic logo")).toHaveAttribute("src", PNG);
    expect(preview()).toContain("Abeba Dental");
    expect(preview()).toContain("TIN 0012345678");
    expect(preview()).toContain(PNG);
    expect(screen.getByRole("button", { name: /Save printing settings/ })).toBeDisabled();
  });

  test("REG-FE-PRSCR-002 editing the name updates the preview at once and enables Save; Save sends the document, not the untouched logo", async () => {
    const { user } = await open({ logo: PNG });
    await user.type(screen.getByPlaceholderText("Registered Name"), "Abeba");
    expect(preview()).toContain(">Abeba<");
    expect(screen.getByText("Unsaved changes")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /Save printing settings/ }));
    await waitFor(() => expect(api.savePrintSettings).toHaveBeenCalledTimes(1));
    const body = api.savePrintSettings.mock.calls[0][0];
    expect(body.logo).toBeUndefined();
    expect(body.settings.identity.nameEn).toBe("Abeba");
    expect(body.settings.version).toBe(1);
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith("Printing settings saved"));
  });

  test("REG-FE-PRSCR-003 removing the logo sends an empty logo, which removes it", async () => {
    const { user } = await open({ logo: PNG });
    await user.click(screen.getByRole("button", { name: /Remove/ }));
    expect(screen.queryByAltText("Clinic logo")).not.toBeInTheDocument();
    expect(preview()).not.toContain(PNG);
    await user.click(screen.getByRole("button", { name: /Save printing settings/ }));
    await waitFor(() => expect(api.savePrintSettings).toHaveBeenCalled());
    expect(api.savePrintSettings.mock.calls[0][0].logo).toBe("");
  });

  test("REG-FE-PRSCR-004 a refused save says why and keeps the edits", async () => {
    api.savePrintSettings.mockRejectedValueOnce(new AppError(400, "V", "the logo is too large")).mockRejectedValueOnce(new Error("x"));
    const { user } = await open();
    await user.type(screen.getByPlaceholderText("Registered Name"), "A");
    await user.click(screen.getByRole("button", { name: /Save printing settings/ }));
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith("the logo is too large"));
    await user.click(screen.getByRole("button", { name: /Save printing settings/ }));
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith("Could not save the printing settings"));
    expect(screen.getByText("Unsaved changes")).toBeInTheDocument();
  });

  test("REG-FE-PRSCR-005 Discard goes back to what was stored", async () => {
    const { user } = await open({ settings: { identity: { nameEn: "Stored" } } });
    await user.type(screen.getByPlaceholderText("Registered Name"), "X");
    await user.click(screen.getByRole("button", { name: /Discard changes/ }));
    expect(screen.getByPlaceholderText("Registered Name")).toHaveValue("Stored");
    expect(screen.queryByText("Unsaved changes")).not.toBeInTheDocument();
  });

  test("REG-FE-PRSCR-006 the look: a letterhead keeps the top blank, the accent and the logo position reach the paper", async () => {
    const { user } = await open({ logo: PNG });
    await user.click(tab("Look"));
    await user.click(screen.getByRole("radio", { name: "Centre" }));
    expect(preview()).toContain("hd-col");
    fireEvent.change(screen.getByLabelText("Accent colour", { selector: "input[type=color]" }), { target: { value: "#aa0000" } });
    expect(preview()).toContain("--accent:#aa0000");
    await user.click(screen.getByRole("radio", { name: "My own letterhead" }));
    fireEvent.change(screen.getByLabelText("Letterhead space"), { target: { value: "62" } });
    expect(preview()).toContain('class="lh" style="height:62mm"');
    expect(screen.getByText(/Blank space at the top: 62 mm/)).toBeInTheDocument();
  });

  test("REG-FE-PRSCR-007 language and dates change the preview; a typed accent is only taken as a colour", async () => {
    const { user } = await open();
    await user.click(tab("Language & dates"));
    await user.click(within(screen.getByRole("radiogroup", { name: "Language" })).getByRole("radio", { name: "Both" }));
    expect(preview()).toContain("ታካሚ");
    const dates = screen.getByRole("radiogroup", { name: "Dates" });
    await user.click(within(dates).getByRole("radio", { name: "Ethiopian" }));
    expect(preview()).toMatch(/\d+ (Meskerem|Tikimt|Hidar|Tahsas|Tir|Yekatit|Megabit|Miyazia|Ginbot|Sene|Hamle|Nehase|Pagumē) \d{4}/);
    await user.clear(screen.getByDisplayValue("ETB"));
    await user.type(screen.getByLabelText(/Currency label/), "Birr");
    expect(preview()).toContain("Birr ");
  });

  test("REG-FE-PRSCR-008 a paper's layout, size, switches, texts and wording are generated from the catalogue", async () => {
    const { user } = await open();
    await user.click(tab("Receipts"));
    expect(screen.getByText(/Proof of payment for the patient/)).toBeInTheDocument();
    await user.click(screen.getByRole("radio", { name: /Receipt sheet/ }));
    expect(preview()).toContain("size:148mm 210mm");
    await user.click(screen.getByRole("radio", { name: "A4" }));
    expect(preview()).toContain("size:210mm 297mm");
    await user.click(screen.getByRole("checkbox", { name: /Amount in words/ }));
    expect(preview()).toContain("In words:");
    await user.click(screen.getByRole("checkbox", { name: /Who received it/ }));
    expect(preview()).not.toContain("Hana Desta");
    fireEvent.change(screen.getByDisplayValue(/Thank you\. Keep this receipt/), { target: { value: "Betam amesegnalehu" } });
    expect(preview()).toContain("Betam amesegnalehu");
    await user.click(screen.getByText("Wording"));
    await user.type(screen.getByPlaceholderText("Payment receipt"), "Official receipt");
    expect(preview()).toContain("Official receipt");
    await user.click(screen.getByRole("button", { name: /Back to standard for this paper/ }));
    expect(preview()).not.toContain("Betam amesegnalehu");
    expect(preview()).toContain("size:80mm auto");
  });

  test("REG-FE-PRSCR-009 prescriptions: the pre-printed pad leaves the top blank; the reprint toggle shows the mark", async () => {
    const { user } = await open();
    await user.click(tab("Prescriptions"));
    await user.click(screen.getByRole("radio", { name: /Pre-printed pad/ }));
    expect(preview()).toContain('class="lh"');
    expect(preview()).not.toContain('class="dup"');
    await user.click(screen.getByLabelText("As a reprint"));
    expect(preview()).toContain("DUPLICATE");
  });

  test("REG-FE-PRSCR-010 footer and reprint marking: the wording of the mark and who-printed-it line are editable", async () => {
    const { user } = await open();
    await user.click(tab("Footer & reprints"));
    fireEvent.change(screen.getByDisplayValue("DUPLICATE"), { target: { value: "COPY" } });
    await user.click(screen.getByLabelText("As a reprint"));
    expect(preview()).toContain("COPY");
    await user.click(screen.getByRole("checkbox", { name: /Say who printed it first/ }));
    expect(preview()).not.toContain('class="dupline"');
    await user.click(screen.getByRole("checkbox", { name: /Mark a reprint/ }));
    expect(preview()).not.toContain("COPY");
    expect(screen.getByDisplayValue("COPY")).toBeDisabled();
  });

  test("REG-FE-PRSCR-011 extra lines can be added up to three, edited and removed", async () => {
    const { user } = await open();
    for (let i = 0; i < 3; i++) await user.click(screen.getByRole("button", { name: /Add a line/ }));
    expect(screen.queryByRole("button", { name: /Add a line/ })).not.toBeInTheDocument();
    const [label, value] = [screen.getAllByPlaceholderText("Label")[0], screen.getAllByPlaceholderText("Text")[0]];
    await user.type(label, "Bank");
    await user.type(value, "CBE 1000123");
    expect(preview()).toContain("Bank: CBE 1000123");
    await user.click(screen.getAllByRole("button", { name: "Remove line" })[0]);
    expect(preview()).not.toContain("CBE 1000123");
  });

  test("REG-FE-PRSCR-012 more than one branch: each may override address, phones, email and tax number", async () => {
    admin.listBranches.mockResolvedValue([{ id: "b1", name: "Bole", code: "B1" }, { id: "b2", name: "Piassa", code: "P1" }]);
    const { user } = await open();
    await user.click(tab("Branches"));
    expect(screen.getByText("Bole")).toBeInTheDocument();
    expect(screen.getByText("Piassa")).toBeInTheDocument();
    await user.type(screen.getAllByLabelText("TIN")[1], "777");
    await user.click(screen.getByRole("button", { name: /Save printing settings/ }));
    await waitFor(() => expect(api.savePrintSettings).toHaveBeenCalled());
    expect(api.savePrintSettings.mock.calls[0][0].settings.branches.b2.tin).toBe("777");
  });

  test("REG-FE-PRSCR-013 one branch: there is no Branches tab to fill in", async () => {
    await open();
    expect(screen.queryByRole("tab", { name: "Branches" })).not.toBeInTheDocument();
  });

  test("REG-FE-PRSCR-014 without clinic.manage everything is visible and nothing can be changed", async () => {
    auth.manage = false;
    await open({ settings: { identity: { nameEn: "Abeba" } } });
    expect(screen.getByPlaceholderText("Registered Name")).toBeDisabled();
    expect(screen.queryByRole("button", { name: /Save printing settings/ })).not.toBeInTheDocument();
    expect(screen.getByText(/only a clinic manager can change/)).toBeInTheDocument();
    expect(screen.queryByText("Upload")).not.toBeInTheDocument();
  });

  test("REG-FE-PRSCR-015 a failed load says so", async () => {
    api.getPrintSettings.mockRejectedValue(new Error("down"));
    renderUI(<PrintingSettings />);
    expect(await screen.findByText("Could not load the printing settings.")).toBeInTheDocument();
  });

  test("REG-FE-PRSCR-016 a logo file is shrunk to a data URL and sent; a file that is not an image is refused kindly", async () => {
    // jsdom has no image decoding: stand in for the browser's image and canvas.
    const drawn: Array<[number, number]> = [];
    class FakeImage { width = 1200; height = 600; onload: (() => void) | null = null; onerror: (() => void) | null = null;
      set src(v: string) { queueMicrotask(() => (v.includes("BROKEN") ? this.onerror?.() : this.onload?.())); } }
    vi.stubGlobal("Image", FakeImage);
    const real = document.createElement.bind(document);
    vi.spyOn(document, "createElement").mockImplementation((tag: string, o?: ElementCreationOptions) => {
      if (tag !== "canvas") return real(tag, o);
      const c = { width: 0, height: 0, getContext: () => ({ drawImage: () => drawn.push([c.width, c.height]) }), toDataURL: () => PNG } as unknown as HTMLCanvasElement;
      return c;
    });
    try {
      const { user } = await open();
      const input = screen.getByLabelText("Logo file") as HTMLInputElement;
      await user.upload(input, new File([new Uint8Array([1, 2, 3])], "logo.png", { type: "image/png" }));
      await screen.findByAltText("Clinic logo");
      expect(drawn[0]).toEqual([480, 240]);
      await user.click(screen.getByRole("button", { name: /Save printing settings/ }));
      await waitFor(() => expect(api.savePrintSettings).toHaveBeenCalled());
      expect(api.savePrintSettings.mock.calls[0][0].logo).toBe(PNG);
    } finally {
      vi.unstubAllGlobals();
      vi.restoreAllMocks();
    }
  });

  test("REG-FE-PRSCR-017 every field on every tab is wired: each one changes the document that is saved", async () => {
    admin.listBranches.mockResolvedValue([{ id: "b1", name: "Bole", code: "B1" }, { id: "b2", name: "Piassa", code: "P1" }]);
    const { user } = await open({ logo: PNG });
    const typeIn = async (el: HTMLElement, v: string) => { fireEvent.change(el, { target: { value: v } }); };

    // identity
    for (const [label, value] of [
      ["Clinic name (Amharic)", "አበባ"], ["Tagline or motto", "Smile"], ["Email", "a@b.et"], ["Website", "abeba.et"],
      ["Tax identification number (TIN)", "001"], ["VAT number", "V1"], ["Licence or registration number", "L1"],
      ["Address (up to 3 lines)", "Bole\nEdna Mall"], ["Phone numbers (one per line, up to 3)", "0911\n0922"],
    ] as const) await typeIn(screen.getByLabelText(label), value);
    await user.click(screen.getByRole("button", { name: /Add a line/ }));

    // look
    await user.click(screen.getByRole("tab", { name: "Look" }));
    for (const [group, name] of [
      ["Header", "Compact"], ["Logo position", "Right"], ["Logo size", "Large"], ["Logo shape", "Circle"],
      ["Text size", "Large"], ["Typeface", "Serif"],
    ] as const) await user.click(within(screen.getByRole("radiogroup", { name: group })).getByRole("radio", { name }));
    await typeIn(screen.getAllByDisplayValue("#14532d")[1], "#112233");
    await user.click(screen.getByRole("checkbox", { name: /A line under the header/ }));

    // language & dates
    await user.click(screen.getByRole("tab", { name: "Language & dates" }));
    await user.click(within(screen.getByRole("radiogroup", { name: "Language" })).getByRole("radio", { name: "አማርኛ" }));
    await user.click(within(screen.getByRole("radiogroup", { name: "Time" })).getByRole("radio", { name: /24-hour/ }));
    await user.click(screen.getByRole("checkbox", { name: /Thousands separator/ }));

    // footer and reprints
    await user.click(screen.getByRole("tab", { name: "Footer & reprints" }));
    await typeIn(screen.getByLabelText("Footer line on every paper"), "Open daily");

    // branches
    await user.click(screen.getByRole("tab", { name: "Branches" }));
    await typeIn(screen.getAllByLabelText("Address lines")[1], "Piassa St");
    await typeIn(screen.getAllByLabelText("Phone numbers")[1], "0933");
    await typeIn(screen.getAllByLabelText("Email")[1], "p@x.et");

    // every paper: layout, paper, a switch and a text
    for (const doc of ["Receipts", "Prescriptions", "Lab requests"]) {
      await user.click(screen.getByRole("tab", { name: doc }));
      await user.click(screen.getAllByRole("checkbox")[0]);
    }

    await user.click(screen.getByRole("button", { name: /Save printing settings/ }));
    await waitFor(() => expect(api.savePrintSettings).toHaveBeenCalled());
    const d = api.savePrintSettings.mock.calls[0][0].settings;
    expect(d.identity).toMatchObject({ nameAm: "አበባ", tagline: "Smile", email: "a@b.et", website: "abeba.et", tin: "001", vatNo: "V1", licenseNo: "L1",
      addressLines: ["Bole", "Edna Mall"], phones: ["0911", "0922"], extras: [{ label: "", value: "" }] });
    expect(d.look).toMatchObject({ header: "compact", logoPosition: "right", logoSize: "large", logoShape: "circle", textSize: "large", font: "serif", accent: "#112233", rule: false });
    expect(d.locale).toMatchObject({ language: "am", time24: true, thousands: false });
    expect(d.footer.text).toBe("Open daily");
    expect(d.branches.b2).toMatchObject({ addressLines: ["Piassa St"], phones: ["0933"], email: "p@x.et" });
    expect(Object.keys(d.docs).sort()).toEqual(["labrequest", "prescription", "receipt"]);
  });

  test("REG-FE-PRSCR-018 a logo file that cannot be read or decoded is refused kindly", async () => {
    class BadImage { onload: (() => void) | null = null; onerror: (() => void) | null = null;
      set src(_v: string) { queueMicrotask(() => this.onerror?.()); } }
    vi.stubGlobal("Image", BadImage);
    try {
      const { user } = await open();
      await user.upload(screen.getByLabelText("Logo file"), new File([new Uint8Array([1])], "x.png", { type: "image/png" }));
      await waitFor(() => expect(toast.error).toHaveBeenCalledWith("That file could not be read as an image. Use a PNG, JPEG or WebP."));
      expect(screen.queryByAltText("Clinic logo")).not.toBeInTheDocument();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  test("REG-FE-PRSCR-019 a file the browser cannot even read is refused kindly", async () => {
    class BadReader { onload: (() => void) | null = null; onerror: (() => void) | null = null; result = null;
      readAsDataURL() { queueMicrotask(() => this.onerror?.()); } }
    vi.stubGlobal("FileReader", BadReader);
    try {
      const { user } = await open();
      await user.upload(screen.getByLabelText("Logo file"), new File([new Uint8Array([1])], "x.png", { type: "image/png" }));
      await waitFor(() => expect(toast.error).toHaveBeenCalled());
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
