import { afterAll, beforeAll, describe, expect, test } from "vitest";

import { change, clock, minutes } from "@/features/dashboard/format";

describe("REG-FE-DASHFMT dashboard formatting", () => {
  test("REG-FE-DASHFMT-001 change(): signed whole percent, null with nothing to compare", () => {
    expect(change(150, 100)).toBe(50);
    expect(change(50, 100)).toBe(-50);
    expect(change(100, 100)).toBe(0);
    expect(change(1, 3)).toBe(-67);
    expect(change(100, 0)).toBeNull();
    expect(change(100, -5)).toBeNull();
  });

  test("REG-FE-DASHFMT-002 minutes(): '24 min', '1 h', '4 h 43 min'", () => {
    expect(minutes(0)).toBe("0 min");
    expect(minutes(24)).toBe("24 min");
    expect(minutes(60)).toBe("1 h");
    expect(minutes(283)).toBe("4 h 43 min");
  });

  describe("clock() in a laptop set to another zone", () => {
    const saved = process.env.TZ;
    beforeAll(() => { process.env.TZ = "America/New_York"; });
    afterAll(() => { process.env.TZ = saved; });

    test("REG-FE-DASHFMT-003 clock() is always Addis Ababa time, whatever the machine's zone", () => {
      // Guard: the zone change took effect, so the test proves something.
      expect(new Date("2026-10-02T05:42:00Z").getHours()).toBe(1);
      // 05:42 UTC is 08:42 in Addis (UTC+3, no DST).
      expect(clock("2026-10-02T05:42:00Z")).toMatch(/^8:42/);
      expect(clock("2026-10-02T21:05:00Z")).toMatch(/^12:05/); // 00:05 next day in Addis
    });
  });
});
