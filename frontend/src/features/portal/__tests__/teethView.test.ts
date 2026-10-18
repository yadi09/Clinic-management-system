// The three separate pictures of a mouth: what is there today, what is planned, what is done.
import { describe, expect, test } from "vitest";

import type { ChartItem } from "@/features/dental/api";
import { countFor, itemsFor, teethWith } from "@/features/portal/teethView";

const I = (tooth: number, kind: ChartItem["kind"], status: ChartItem["status"]): ChartItem => ({ id: `${tooth}${kind}${status}`, tooth, kind, status });
const ROWS = [I(16, "filling", "existing"), I(26, "crown", "done"), I(36, "root_canal", "planned"), I(46, "missing", "existing"), I(46, "implant", "planned")];

describe("REG-FE-PORTAL-VIEW the three views", () => {
  test("REG-FE-PORTAL-VIEW-001 today: everything in the mouth now, nothing planned", () => {
    expect(itemsFor(ROWS, "now").map((i) => i.id)).toEqual(["16fillingexisting", "26crowndone", "46missingexisting"]);
  });
  test("REG-FE-PORTAL-VIEW-002 planned: only planned work, with missing teeth kept as the backdrop (an implant needs a gap)", () => {
    expect(itemsFor(ROWS, "planned").map((i) => i.id)).toEqual(["36root_canalplanned", "46missingexisting", "46implantplanned"]);
  });
  test("REG-FE-PORTAL-VIEW-003 done: only finished work, missing teeth kept as the backdrop", () => {
    expect(itemsFor(ROWS, "done").map((i) => i.id)).toEqual(["26crowndone", "46missingexisting"]);
  });
  test("REG-FE-PORTAL-VIEW-004 the counts on the buttons count work, never the missing-tooth backdrop", () => {
    expect([countFor(ROWS, "now"), countFor(ROWS, "planned"), countFor(ROWS, "done")]).toEqual([2, 2, 1]);
  });
  test("REG-FE-PORTAL-VIEW-005 teethWith lists each tooth once, in mouth order", () => {
    expect(teethWith(ROWS)).toEqual([16, 26, 36, 46]);
    expect(teethWith([])).toEqual([]);
  });
});
