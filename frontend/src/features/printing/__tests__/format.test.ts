// Numbers and dates on paper: the clinic's clock, the clinic's calendar, and the same
// text whichever computer prints it.
import { describe, expect, test } from "vitest";

import { amountInWords, fmtDate, money } from "@/features/printing/format";

describe("REG-FE-PRFMT amounts and dates on paper", () => {
  test("REG-FE-PRFMT-001 money has two decimals, and thousands separators when asked", () => {
    expect(money("1500", { thousands: true })).toBe("1,500.00");
    expect(money(1234567.5, { thousands: true })).toBe("1,234,567.50");
    expect(money("1500", { thousands: false })).toBe("1500.00");
    expect(money("abc", { thousands: true })).toBe("abc");
  });

  test("REG-FE-PRFMT-002 amount in words, birr and santim", () => {
    expect(amountInWords("1500", "ETB")).toBe("One thousand five hundred birr only");
    expect(amountInWords("21.50", "ETB")).toBe("Twenty-one birr and fifty santim only");
    expect(amountInWords("0", "ETB")).toBe("Zero birr only");
    expect(amountInWords("1000000", "ETB")).toBe("One million birr only");
    expect(amountInWords("119", "ETB")).toBe("One hundred nineteen birr only");
    expect(amountInWords("2.05", "USD")).toBe("Two dollars and five cents only");
    expect(amountInWords("5", "XYZ")).toBe("Five XYZ only");
    expect(amountInWords("5.25", "XYZ")).toBe("Five XYZ and twenty-five cents only");
    expect(amountInWords("-12", "ETB")).toBe("Twelve birr only");
    expect(amountInWords("nope", "ETB")).toBe("");
  });

  test("REG-FE-PRFMT-003 a date reads in the chosen calendar, on the Addis clock", () => {
    // 22:30 UTC on 2 Oct is 01:30 on 3 Oct in Addis.
    const iso = "2026-10-02T22:30:00Z";
    expect(fmtDate(iso, { dates: "gregorian", time24: false })).toBe("3 Oct 2026");
    expect(fmtDate(iso, { dates: "ethiopian", time24: false })).toBe("23 Meskerem 2019");
    expect(fmtDate(iso, { dates: "both", time24: false })).toBe("3 Oct 2026 · 23 Meskerem 2019");
  });

  test("REG-FE-PRFMT-004 time is 12- or 24-hour, midnight and noon read correctly, a plain date has no time", () => {
    expect(fmtDate("2026-10-03T09:41:00+03:00", { dates: "gregorian", time24: false }, true)).toBe("3 Oct 2026, 9:41 AM");
    expect(fmtDate("2026-10-03T09:41:00+03:00", { dates: "gregorian", time24: true }, true)).toBe("3 Oct 2026, 09:41");
    expect(fmtDate("2026-10-03T00:05:00+03:00", { dates: "gregorian", time24: false }, true)).toBe("3 Oct 2026, 12:05 AM");
    expect(fmtDate("2026-10-03T12:00:00+03:00", { dates: "gregorian", time24: false }, true)).toBe("3 Oct 2026, 12:00 PM");
    expect(fmtDate("2026-10-03T21:00:00+03:00", { dates: "gregorian", time24: false }, true)).toBe("3 Oct 2026, 9:00 PM");
    expect(fmtDate("2026-10-03", { dates: "gregorian", time24: false }, true)).toBe("3 Oct 2026");
  });

  test("REG-FE-PRFMT-005 nothing, or a non-date, never throws", () => {
    expect(fmtDate(undefined, { dates: "gregorian", time24: false })).toBe("");
    expect(fmtDate("not a date", { dates: "gregorian", time24: false })).toBe("not a date");
  });
});
