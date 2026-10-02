import { describe, expect, test } from "vitest";

import {
  ethiopianDaysInMonth,
  ethiopianToGregorianISO,
  formatEthiopian,
  isEthiopianLeap,
  toEthiopian,
} from "@/lib/ethiopian";

describe("REG-FE-ETH Ethiopian calendar conversion", () => {
  test("REG-FE-ETH-001 2026-10-02 is Meskerem 22, 2019", () => {
    expect(toEthiopian("2026-10-02")).toEqual({ year: 2019, month: 1, day: 22 });
    expect(formatEthiopian("2026-10-02")).toBe("Meskerem 22, 2019");
  });

  test("REG-FE-ETH-002 2024-01-07 (Genna) is Tahsas 28, 2016", () => {
    expect(toEthiopian("2024-01-07")).toEqual({ year: 2016, month: 4, day: 28 });
    expect(formatEthiopian("2024-01-07", { dayFirst: true })).toBe("28 Tahsas 2016");
  });

  test("REG-FE-ETH-003 Pagumē 6 exists in leap year 2015 EC and is 2023-09-11", () => {
    expect(isEthiopianLeap(2015)).toBe(true);
    expect(ethiopianDaysInMonth(2015, 13)).toBe(6);
    expect(ethiopianDaysInMonth(2016, 13)).toBe(5);
    expect(ethiopianToGregorianISO(2015, 13, 6)).toBe("2023-09-11");
    expect(toEthiopian("2023-09-11")).toEqual({ year: 2015, month: 13, day: 6 });
    expect(toEthiopian("2023-09-12")).toEqual({ year: 2016, month: 1, day: 1 });
  });

  test("REG-FE-ETH-004 Meskerem 1, 2018 is 2025-09-11 (documented anchor)", () => {
    expect(ethiopianToGregorianISO(2018, 1, 1)).toBe("2025-09-11");
  });

  test("REG-FE-ETH-005 round trip GC -> EC -> GC over six years, day by day", () => {
    const start = new Date(2021, 0, 1);
    for (let i = 0; i < 6 * 366; i++) {
      const d = new Date(start.getFullYear(), start.getMonth(), start.getDate() + i);
      const iso = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
      const e = toEthiopian(iso);
      expect(ethiopianToGregorianISO(e.year, e.month, e.day), iso).toBe(iso);
    }
  });
});
