// The delivery itself: a hidden frame inside the page (no pop-up to be blocked) that
// prints and then removes itself, and the four calls the engine makes to the server.
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

vi.mock("@/lib/api-client", () => ({ apiFetch: vi.fn(async () => ({ count: 1 })) }));

import { apiFetch } from "@/lib/api-client";
import { getPrintSettings, logPrint, peekPrint, savePrintSettings } from "@/features/printing/api";
import { transport } from "@/features/printing/engine";

describe("REG-FE-PRTRN delivering a page to the printer", () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); document.body.innerHTML = ""; });

  test("REG-FE-PRTRN-001 the page is written into a hidden frame, printed, and the frame removed afterwards", () => {
    const print = vi.fn();
    const realCreate = document.createElement.bind(document);
    vi.spyOn(document, "createElement").mockImplementation((tag: string, o?: ElementCreationOptions) => {
      const el = realCreate(tag, o);
      if (tag === "iframe") {
        Object.defineProperty(el, "contentWindow", {
          value: { document: { open: vi.fn(), write: vi.fn(), close: vi.fn() }, focus: vi.fn(), print },
          configurable: true,
        });
      }
      return el;
    });
    transport.send("<p>hello</p>");
    const frame = document.querySelector("iframe")!;
    expect(frame).not.toBeNull();
    expect(frame.getAttribute("aria-hidden")).toBe("true");
    vi.advanceTimersByTime(60);
    expect(print).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(1600);
    expect(document.querySelector("iframe")).toBeNull();
    vi.restoreAllMocks();
  });

  test("REG-FE-PRTRN-002 a frame that has no window is dropped, not left behind", () => {
    const realCreate = document.createElement.bind(document);
    vi.spyOn(document, "createElement").mockImplementation((tag: string, o?: ElementCreationOptions) => {
      const el = realCreate(tag, o);
      if (tag === "iframe") Object.defineProperty(el, "contentWindow", { value: null, configurable: true });
      return el;
    });
    transport.send("<p>x</p>");
    expect(document.querySelector("iframe")).toBeNull();
    vi.restoreAllMocks();
  });

  test("REG-FE-PRTRN-003 the server calls: read settings, save them (logo kept when omitted), peek and count a print", async () => {
    await getPrintSettings();
    expect(apiFetch).toHaveBeenCalledWith("/org/print-settings");
    await savePrintSettings({ settings: { a: 1 } });
    expect(apiFetch).toHaveBeenCalledWith("/org/print-settings", { method: "PUT", body: { settings: { a: 1 } } });
    await peekPrint("receipt", "RCP 1/2");
    expect(apiFetch).toHaveBeenCalledWith("/org/print-log?kind=receipt&ref=RCP%201%2F2");
    await logPrint("receipt", "RCP-1");
    expect(apiFetch).toHaveBeenCalledWith("/org/print-log", { method: "POST", body: { kind: "receipt", ref: "RCP-1" } });
  });
});
