// The arches as drawn: every tooth there and selectable, position changes in orange,
// gaps with their size, the simple chart's marks, and clip ids that never clash.
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, test, vi } from "vitest";

import { AnatomicalChart } from "@/features/dental/anatomical/AnatomicalChart";
import { EMPTY } from "@/features/dental/anatomical/geometry";
import type { ToothAnatomy } from "@/features/dental/api";

const T = (over: Partial<ToothAnatomy>): ToothAnatomy => ({ ...EMPTY, ...over });
const teethButtons = () => screen.getAllByRole("button", { name: /^Tooth \d+/ });
const numberOf = (n: number) => [...document.querySelectorAll("text")].find((t) => t.textContent === String(n))!;

describe("REG-FE-ANAT chart", () => {
  test("REG-FE-ANAT-020 adult: 32 teeth, each named; child: 20", () => {
    const { rerender } = render(<AnatomicalChart dentition="adult" anatomy={{}} selected={11} onSelect={() => {}} />);
    expect(teethButtons()).toHaveLength(32);
    expect(screen.getByRole("button", { name: "Tooth 11, Upper right central incisor" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: "Tooth 38, Lower left third molar" })).toHaveAttribute("aria-pressed", "false");
    rerender(<AnatomicalChart dentition="child" anatomy={{}} selected={54} onSelect={() => {}} />);
    expect(teethButtons()).toHaveLength(20);
    expect(screen.getByRole("group", { name: "Child tooth chart" })).toBeInTheDocument();
  });

  test("REG-FE-ANAT-021 a tap or Enter on a tooth selects it", async () => {
    const onSelect = vi.fn();
    render(<AnatomicalChart dentition="adult" anatomy={{}} selected={11} onSelect={onSelect} />);
    await userEvent.click(screen.getByRole("button", { name: /^Tooth 26,/ }));
    expect(onSelect).toHaveBeenLastCalledWith(26);
    screen.getByRole("button", { name: /^Tooth 47,/ }).focus();
    await userEvent.keyboard("{Enter}");
    expect(onSelect).toHaveBeenLastCalledWith(47);
  });

  test("REG-FE-ANAT-022 a tooth's findings are in its name, for a screen reader", () => {
    render(<AnatomicalChart dentition="adult" anatomy={{ 16: T({ surfaces: { O: "caries" }, rotation: 10 }) }} selected={11} onSelect={() => {}} />);
    expect(screen.getByRole("button", { name: "Tooth 16, Upper right first molar: caries (occlusal), rotated 10° clockwise" })).toBeInTheDocument();
  });

  test("REG-FE-ANAT-023 the selected number is blue, a moved tooth's number orange, others grey", () => {
    render(<AnatomicalChart dentition="adult" anatomy={{ 12: T({ rotation: 35 }), 26: T({ crown: true }) }} selected={11} onSelect={() => {}} />);
    expect(numberOf(11).style.fill).toBe("var(--text-accent)");
    expect(numberOf(12).style.fill).toBe("var(--text-warning)");
    expect(numberOf(26).style.fill).toBe("var(--text-secondary)"); // a crown is not a position change
  });

  test("REG-FE-ANAT-024 gaps on both sides of both arches show their real size above and below", () => {
    render(<AnatomicalChart dentition="adult" selected={11} onSelect={() => {}}
      anatomy={{ 11: T({ gap_mesial: 2 }), 25: T({ gap_mesial: 0.5 }), 35: T({ gap_mesial: 3 }), 45: T({ gap_mesial: 1.5 }) }} />);
    const pills = [...document.querySelectorAll("text")].map((t) => t.textContent).filter((t) => t?.endsWith("mm"));
    expect(pills.sort()).toEqual(["0.5mm", "1.5mm", "2mm", "3mm"]);
    // Upper pills sit above the arch, lower ones below it.
    const y = (txt: string) => Number([...document.querySelectorAll("text")].find((t) => t.textContent === txt)!.getAttribute("y"));
    expect(y("2mm")).toBeLessThan(20);
    expect(y("0.5mm")).toBeLessThan(20);
    expect(y("3mm")).toBeGreaterThan(250);
    expect(y("1.5mm")).toBeGreaterThan(250);
  });

  test("REG-FE-ANAT-025 surfaces, crown, root canal and missing are drawn in the reference's colours", () => {
    const { container } = render(<AnatomicalChart dentition="adult" selected={11} onSelect={() => {}}
      anatomy={{ 16: T({ surfaces: { O: "caries", M: "filling" } }), 26: T({ crown: true, root_canal: true }), 46: T({ missing: true }) }} />);
    const fills = [...container.querySelectorAll("rect")].map((r) => r.getAttribute("fill"));
    expect(fills.filter((f) => f === "#E24B4A")).toHaveLength(2); // caries, side and top view
    expect(fills.filter((f) => f === "#378ADD")).toHaveLength(2);
    const crowns = [...container.querySelectorAll("path")].filter((p) => p.style.fill === "rgb(239, 159, 39)" || p.style.fill === "#EF9F27");
    expect(crowns.length).toBe(2);
    expect([...container.querySelectorAll("path")].filter((p) => p.getAttribute("stroke") === "#7F77DD").length).toBe(2); // a molar has two roots
    expect([...container.querySelectorAll("path")].some((p) => p.style.strokeDasharray === "4 3")).toBe(true);
  });

  test("REG-FE-ANAT-026 two charts on one page never share a clipPath id", () => {
    const { container } = render(<>
      <AnatomicalChart dentition="adult" anatomy={{}} selected={11} onSelect={() => {}} />
      <AnatomicalChart dentition="adult" anatomy={{}} selected={11} onSelect={() => {}} />
    </>);
    const ids = [...container.querySelectorAll("clipPath")].map((c) => c.id);
    expect(ids.length).toBe(128);
    expect(new Set(ids).size).toBe(ids.length);
  });

  test("REG-FE-ANAT-027 the simple chart's mark shows as a coloured bar, but not 'healthy'", () => {
    const marks = (p: string) => (p === "UR6" ? { code: "decayed", label: "Decayed", color: "#c0392b" } : p === "UL1" ? { code: "healthy", label: "Healthy", color: "#0a7c59" } : null);
    const { container } = render(<AnatomicalChart dentition="adult" anatomy={{}} marks={marks} selected={11} onSelect={() => {}} />);
    const bars = container.querySelectorAll("rect[data-mark]");
    expect([...bars].map((b) => b.getAttribute("data-mark"))).toEqual(["16"]);
    expect(within(bars[0] as unknown as HTMLElement).getByText("Decayed")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Tooth 16, Upper right first molar, Decayed" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Tooth 21, Upper left central incisor, Healthy" })).toBeInTheDocument();
  });
});
