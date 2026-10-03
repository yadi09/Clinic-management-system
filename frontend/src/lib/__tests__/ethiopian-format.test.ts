// The month and span labels the appointments calendar prints in both calendars.
import { describe, expect, test } from "vitest";

import { formatEthiopian, formatEthiopianMonth, formatEthiopianRange, toEthiopian } from "@/lib/ethiopian";

describe("REG-FE-ETH month and range labels", () => {
  test("REG-FE-ETH-010 month label, from a string or a Date (its local day)", () => {
    expect(formatEthiopianMonth("2026-10-03")).toBe("Meskerem 2019");
    expect(formatEthiopianMonth(new Date(2026, 6, 11))).toBe("Hamle 2018");
    expect(toEthiopian(new Date(2026, 9, 3, 23, 59))).toEqual({ year: 2019, month: 1, day: 23 });
  });

  test("REG-FE-ETH-011 a span inside one EC month, across months, and across the new year", () => {
    // [from, to) — the end is exclusive.
    expect(formatEthiopianRange(new Date(2026, 8, 12), new Date(2026, 9, 1))).toBe("Meskerem 2019");
    expect(formatEthiopianRange(new Date(2026, 9, 1), new Date(2026, 10, 1))).toBe("Meskerem–Tikimt 2019");
    expect(formatEthiopianRange(new Date(2026, 7, 1), new Date(2026, 9, 1))).toBe("Hamle 2018 – Meskerem 2019");
  });

  test("REG-FE-ETH-012 a full timestamp string still converts by its calendar day", () => {
    expect(formatEthiopian("2026-10-03T08:30:00")).toBe("Meskerem 23, 2019");
    expect(formatEthiopian("October 3, 2026")).toBe("Meskerem 23, 2019");
  });
});
