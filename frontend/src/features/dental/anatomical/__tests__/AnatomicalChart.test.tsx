// The arches as drawn (version 2): materials in their real colours, planned work in
// red, the implant screw, a missing tooth ghosted, the porcelain-metal edge, the
// composite outline, the bridge bar, the tooth-number colours, gaps with their size,
// the simple chart's marks, and clip ids that never clash.
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, test, vi } from "vitest";

import { AnatomicalChart } from "@/features/dental/anatomical/AnatomicalChart";
import { fromItems, type ChartState } from "@/features/dental/anatomical/model";
import type { ChartItem, Position } from "@/features/dental/api";

const TODAY = "2026-10-14";
const P0: Position = { rotation: 0, tipping: 0, buccal_lingual: 0, vertical: 0, gap_mesial: 0 };
let n = 0;
const I = (o: Omit<ChartItem, "id">): ChartItem => ({ id: `i${n++}`, ...o });
const draw = (state: ChartState, positions: Record<string, Position> = {}, extra: Partial<Parameters<typeof AnatomicalChart>[0]> = {}) =>
  render(<AnatomicalChart dentition="adult" state={state} positions={positions} today={TODAY} selected={11} onSelect={() => {}} {...extra} />);
const num = (t: number) => [...document.querySelectorAll("text")].find((x) => x.textContent === String(t))!;
const fills = (c: HTMLElement) => [...c.querySelectorAll("rect, path")].map((r) => (r as SVGElement).getAttribute("fill") ?? (r as SVGElement).style.fill);

describe("REG-FE-ANAT2 drawing", () => {
  test("REG-FE-ANAT2-040 adult 32 teeth and child 20, each named, selectable by tap and keyboard", async () => {
    const onSelect = vi.fn();
    const { rerender } = draw(fromItems([]), {}, { onSelect });
    expect(screen.getAllByRole("button", { name: /^Tooth \d+,/ })).toHaveLength(32);
    await userEvent.click(screen.getByRole("button", { name: /^Tooth 26,/ }));
    expect(onSelect).toHaveBeenLastCalledWith(26);
    screen.getByRole("button", { name: /^Tooth 47,/ }).focus();
    await userEvent.keyboard("{Enter}");
    expect(onSelect).toHaveBeenLastCalledWith(47);
    rerender(<AnatomicalChart dentition="child" state={fromItems([])} positions={{}} today={TODAY} selected={54} onSelect={() => {}} />);
    expect(screen.getAllByRole("button", { name: /^Tooth \d+,/ })).toHaveLength(20);
  });

  test("REG-FE-ANAT2-041 materials in their colours; caries brown; planned work red; composite outlined in blue", () => {
    const { container } = draw(fromItems([
      I({ tooth: 16, kind: "caries", surface: "O", status: "existing" }),
      I({ tooth: 36, kind: "filling", surface: "O", material: "amalgam", status: "existing" }),
      I({ tooth: 37, kind: "filling", surface: "O", material: "composite", status: "done", done_on: TODAY }),
      I({ tooth: 15, kind: "filling", surface: "M", material: "composite", status: "planned" }),
      I({ tooth: 26, kind: "crown", material: "gold", status: "existing" }),
      I({ tooth: 21, kind: "crown", material: "zirconia", status: "planned" }),
    ]));
    const f = fills(container);
    expect(f.filter((x) => x === "#5a3a22").length).toBe(2); // caries, side and top
    expect(f.filter((x) => x === "#9aa0a8").length).toBe(2); // amalgam
    expect(f.filter((x) => x === "#e2b85c" || x === "rgb(226, 184, 92)").length).toBeGreaterThanOrEqual(2); // gold crown
    expect(f.filter((x) => x === "#E24B4A").length).toBeGreaterThanOrEqual(4); // planned filling + planned crown
    expect(container.querySelectorAll("rect[stroke='#378ADD']").length).toBe(2); // composite outline
  });

  test("REG-FE-ANAT2-042 an implant draws its screw; a missing tooth is ghosted; a porcelain-metal crown has its dark edge; a root canal shows in the root", () => {
    const { container } = draw(fromItems([
      I({ tooth: 46, kind: "missing", status: "existing" }), I({ tooth: 46, kind: "implant", material: "zirconia", status: "existing" }),
      I({ tooth: 45, kind: "missing", status: "existing" }),
      I({ tooth: 26, kind: "crown", material: "pfm", status: "existing" }), I({ tooth: 26, kind: "root_canal", status: "existing" }),
      I({ tooth: 38, kind: "extraction", status: "planned" }),
    ]));
    expect(container.querySelectorAll("line[stroke='#6f757c']").length).toBe(7); // the screw's seven threads
    expect([...container.querySelectorAll("path")].some((p) => p.style.strokeDasharray === "4 3")).toBe(true);
    expect(container.querySelectorAll("rect[fill='#5f5c58']").length).toBe(1);
    expect(container.querySelectorAll("path[stroke='#e0703c']").length).toBe(2); // a molar's two canals
    expect([...container.querySelectorAll("path")].filter((p) => p.getAttribute("fill") === "#E24B4A").length).toBeGreaterThanOrEqual(3); // planned extraction: roots + crown
  });

  test("REG-FE-ANAT2-043 a planned implant and a planned root canal are red", () => {
    const { container } = draw(fromItems([
      I({ tooth: 46, kind: "missing", status: "existing" }), I({ tooth: 46, kind: "implant", material: "zirconia", status: "planned" }),
      I({ tooth: 11, kind: "root_canal", status: "planned" }),
    ]));
    expect(container.querySelectorAll("line[stroke='#E24B4A']").length).toBe(7);
    expect(container.querySelectorAll("path[stroke='#E24B4A']").length).toBe(1);
  });

  test("REG-FE-ANAT2-044 the bridge bar: grey when in the mouth, gold for a gold bridge, red when planned", () => {
    const base = [I({ tooth: 14, kind: "missing", status: "existing" }), I({ tooth: 15, kind: "missing", status: "existing" }), I({ tooth: 35, kind: "missing", status: "existing" })];
    const { container } = draw(fromItems([...base,
      I({ tooth: 13, kind: "bridge", bridge_end: 16, material: "zirconia", status: "existing" }),
      I({ tooth: 34, kind: "bridge", bridge_end: 36, material: "gold", status: "planned" }),
    ]));
    expect(container.querySelector("[data-bridge='16-13']")!.getAttribute("stroke")).toBe("#8d8a84");
    expect(container.querySelector("[data-bridge='34-36']")!.getAttribute("stroke")).toBe("#E24B4A");
    const { container: g } = draw(fromItems([...base, I({ tooth: 13, kind: "bridge", bridge_end: 16, material: "gold", status: "existing" })]));
    expect(g.querySelector("[data-bridge='16-13']")!.getAttribute("stroke")).toBe("#e2b85c");
  });

  test("REG-FE-ANAT2-045 tooth numbers: blue selected, red planned, green done today, orange moved, grey otherwise", () => {
    draw(fromItems([
      I({ tooth: 21, kind: "root_canal", status: "planned" }),
      I({ tooth: 22, kind: "root_canal", status: "done", done_on: TODAY }),
      I({ tooth: 23, kind: "root_canal", status: "done", done_on: "2026-10-01" }),
    ]), { 24: { ...P0, rotation: 10 } });
    expect(num(11).style.fill).toBe("var(--text-accent)");
    expect(num(21).style.fill).toBe("var(--text-danger)");
    expect(num(22).style.fill).toBe("var(--text-success)");
    expect(num(23).style.fill).toBe("var(--text-secondary)"); // done on an earlier day
    expect(num(24).style.fill).toBe("var(--text-warning)");
    expect(num(25).style.fill).toBe("var(--text-secondary)");
  });

  test("REG-FE-ANAT2-046 gaps show their real size above and below; a missing tooth keeps no gap, an implant does", () => {
    draw(fromItems([
      I({ tooth: 31, kind: "missing", status: "existing" }),
      I({ tooth: 46, kind: "missing", status: "existing" }), I({ tooth: 46, kind: "implant", material: "zirconia", status: "existing" }),
    ]), { 11: { ...P0, gap_mesial: 2 }, 31: { ...P0, gap_mesial: 3 }, 46: { ...P0, gap_mesial: 1.5 } });
    const pills = [...document.querySelectorAll("text")].map((t) => t.textContent).filter((t) => t?.endsWith("mm"));
    expect(pills.sort()).toEqual(["1.5mm", "2mm"]);
  });

  test("REG-FE-ANAT2-047 the simple chart's mark is a coloured bar (not for 'healthy') and part of the tooth's name", () => {
    const marks = (p: string) => (p === "UR6" ? { code: "decayed", label: "Decayed", color: "#c0392b" } : p === "UL1" ? { code: "healthy", label: "Healthy", color: "#0a7c59" } : null);
    const { container } = draw(fromItems([]), {}, { marks });
    expect([...container.querySelectorAll("rect[data-mark]")].map((b) => b.getAttribute("data-mark"))).toEqual(["16"]);
    expect(screen.getByRole("button", { name: "Tooth 16, Upper right first molar, Decayed" })).toBeInTheDocument();
  });

  test("REG-FE-ANAT2-048 two charts on one page never share a clipPath id", () => {
    const { container } = render(<>
      <AnatomicalChart dentition="adult" state={fromItems([])} positions={{}} today={TODAY} selected={11} onSelect={() => {}} />
      <AnatomicalChart dentition="adult" state={fromItems([])} positions={{}} today={TODAY} selected={11} onSelect={() => {}} />
    </>);
    const ids = [...container.querySelectorAll("clipPath")].map((c) => c.id);
    expect(ids.length).toBe(128);
    expect(new Set(ids).size).toBe(ids.length);
  });

  test("REG-FE-ANAT2-049 the chart fits a height it is given, or fills its box", () => {
    const { rerender } = draw(fromItems([]), {}, { maxHeight: "50vh" });
    const svg = () => screen.getByRole("group", { name: "Adult tooth chart" }) as unknown as SVGElement;
    expect(svg().style.maxHeight).toBe("50vh");
    rerender(<AnatomicalChart dentition="adult" state={fromItems([])} positions={{}} today={TODAY} selected={11} onSelect={() => {}} fill />);
    expect(svg().style.height).toBe("100%");
  });

  test("REG-FE-ANAT2-050 braces: a bracket on each tooth that is there (silver metal, tooth-coloured ceramic, red planned) and the wire", () => {
    const { container } = draw(fromItems([
      I({ tooth: 12, kind: "missing", status: "existing" }),
      I({ tooth: 15, kind: "braces", bridge_end: 25, material: "metal", status: "existing" }),
      I({ tooth: 45, kind: "braces", bridge_end: 35, material: "ceramic", status: "planned" }),
    ]));
    const upper = [...container.querySelectorAll("rect[data-bracket]")].map((r) => Number(r.getAttribute("data-bracket"))).filter((n) => n < 30);
    expect(new Set(upper)).toEqual(new Set([15, 14, 13, 11, 21, 22, 23, 24, 25])); // not 12: missing
    expect(container.querySelector("rect[data-bracket='14']")!.getAttribute("fill")).toBe("#b8bec6");
    expect(container.querySelector("rect[data-bracket='41']")!.getAttribute("fill")).toBe("#E24B4A");
    expect(container.querySelector("[data-braces='15-25']")!.getAttribute("stroke")).toBe("#7d848c");
    expect(container.querySelector("[data-braces='45-35']")!.getAttribute("stroke")).toBe("#E24B4A");
    expect(screen.getByRole("button", { name: /^Tooth 11, .*metal braces 15–25 \(already in mouth\)/ })).toBeInTheDocument();
  });
});

