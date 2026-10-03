// Age on a chart and the photo a dental clinic uploads. Age is computed against a
// frozen "today" so the suite passes at any hour in any time zone.
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { ageLabel, ageYears, cn } from "@/lib/utils";
import { compressImage } from "@/lib/image";
import { freezeToday } from "@/test/render";

describe("REG-FE-LIB age and class helpers", () => {
  beforeEach(() => freezeToday("2026-10-03", 10));
  afterEach(() => vi.useRealTimers());

  test("REG-FE-LIB-010 whole years, counting the birthday only once it has passed", () => {
    expect(ageYears("1990-10-03")).toBe(36);
    expect(ageYears("1990-10-04")).toBe(35);
    expect(ageYears("1990-11-01")).toBe(35);
    expect(ageYears("2026-10-03")).toBe(0);
  });

  test("REG-FE-LIB-011 blank, unparseable, future and absurd dates are not an age", () => {
    expect(ageYears(undefined)).toBeNull();
    expect(ageYears("")).toBeNull();
    expect(ageYears("03/10/1990")).toBeNull();
    expect(ageYears("2027-01-01")).toBeNull();
    expect(ageYears("1700-01-01")).toBeNull();
    expect(ageLabel(null)).toBe("—");
  });

  test("REG-FE-LIB-012 the label: years, then months, then days for an infant", () => {
    expect(ageLabel("1990-01-01")).toBe("36 yrs");
    expect(ageLabel("2025-10-01")).toBe("1 yr");
    expect(ageLabel("2026-07-01")).toMatch(/^3 mos$/);
    expect(ageLabel("2026-08-31")).toBe("1 mo");
    expect(ageLabel("2026-10-02")).toBe("1 day");
    expect(ageLabel("2026-09-25")).toBe("8 days");
  });

  test("REG-FE-LIB-013 cn merges Tailwind classes with the later one winning", () => {
    expect(cn("px-2", "px-4", false && "hidden", "text-sm")).toBe("px-4 text-sm");
  });
});

describe("REG-FE-IMG client-side image compression", () => {
  const big = (type = "image/png", size = 5000) => new File([new Uint8Array(size)], "xray.png", { type });
  let drawn: unknown[];
  let blobOut: Blob | null;
  let ctx: { drawImage: (...a: unknown[]) => void } | null;

  beforeEach(() => {
    drawn = [];
    blobOut = new Blob([new Uint8Array(100)], { type: "image/jpeg" });
    ctx = { drawImage: (...a) => { drawn.push(a); } };
    vi.stubGlobal("createImageBitmap", vi.fn(async () => ({ width: 4000, height: 2000, close: vi.fn() })));
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation(() => ctx as never);
    vi.spyOn(HTMLCanvasElement.prototype, "toBlob").mockImplementation(function (cb: BlobCallback) { cb(blobOut); });
  });
  afterEach(() => vi.unstubAllGlobals());

  test("REG-FE-IMG-001 a big photo is scaled to the long edge and re-encoded as a smaller JPEG", async () => {
    const out = await compressImage(big());
    expect(out).not.toBe(big());
    expect(out.name).toBe("xray.jpg");
    expect(out.type).toBe("image/jpeg");
    expect(out.size).toBe(100);
    expect(drawn[0]).toEqual([expect.anything(), 0, 0, 2000, 1000]);
  });

  test("REG-FE-IMG-002 not an image, undecodable, no canvas, no blob, or no gain: the original is kept", async () => {
    const pdf = new File(["x"], "a.pdf", { type: "application/pdf" });
    expect(await compressImage(pdf)).toBe(pdf);

    const f1 = big();
    (globalThis.createImageBitmap as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error("bad"));
    expect(await compressImage(f1)).toBe(f1);

    const f2 = big();
    ctx = null;
    expect(await compressImage(f2)).toBe(f2);
    ctx = { drawImage: () => {} };

    const f3 = big();
    blobOut = null;
    expect(await compressImage(f3)).toBe(f3);

    const f4 = big("image/jpeg", 50);
    blobOut = new Blob([new Uint8Array(100)]);
    expect(await compressImage(f4, { maxEdge: 8000, quality: 0.5 })).toBe(f4);
  });
});
