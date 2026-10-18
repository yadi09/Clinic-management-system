// "My teeth": three separate views, the 2D chart and a 3D model that opens, shows the upper
// or lower jaw, the roots and the numbers.
import { act, fireEvent, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, test, vi } from "vitest";

const stage = vi.hoisted(() => ({ calls: [] as Array<Record<string, unknown>> }));
vi.mock("@/features/dental/anatomical/three/Dental3D", () => ({
  default: (p: Record<string, unknown>) => { stage.calls.push(p); return <div data-testid="stage3d" />; },
}));

import type { ChartItem } from "@/features/dental/api";
import { PortalTeeth } from "@/features/portal/PortalTeeth";
import type { PortalMe } from "@/features/portal/api";
import { T } from "@/features/portal/text";
import { renderUI } from "@/test/render";

const ME = (items: ChartItem[], show3d = true): PortalMe => ({
  clinic: { name: "Yoya Dental", slug: "yoya", has_logo: false }, first_name: "Meron", today: "2026-10-18", treatments: [],
  settings: { enabled: true, show_money: true, show_unbilled: true, show_teeth: true, show_3d: show3d, allow_pay: false, welcome_note: "" },
  chart: { items, positions: {} },
});
const ITEMS = [
  { id: "a", tooth: 16, kind: "filling", surface: "O", material: "composite", status: "existing" },
  { id: "b", tooth: 26, kind: "crown", material: "zirconia", status: "done", done_on: "2026-10-05" },
  { id: "c", tooth: 36, kind: "root_canal", status: "planned" },
] as ChartItem[];
const open = (m: PortalMe) => renderUI(<PortalTeeth me={m} t={T.en} />);
const last = () => stage.calls.at(-1)!;

beforeEach(() => { stage.calls.length = 0; });

describe("REG-FE-PORTAL-TEETH the three views", () => {
  test("REG-FE-PORTAL-TEETH-001 it opens on today's mouth; the buttons carry the counts; there is no 'everything' view that mixes them", () => {
    open(ME([...ITEMS]));
    expect(screen.getByRole("button", { name: "My mouth today" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: "Planned (1)" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Done so far (1)" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /everything|all/i })).not.toBeInTheDocument();
    // Today: the filling and the crown are in the mouth, the planned root canal is not.
    const list = screen.getByText("In this view").closest("div")!;
    expect(list).toHaveTextContent("Tooth 16");
    expect(list).toHaveTextContent("Tooth 26");
    expect(list).not.toHaveTextContent("Tooth 36");
  });

  test("REG-FE-PORTAL-TEETH-002 Planned shows only planned work; Done shows only finished work with its date", async () => {
    open(ME([...ITEMS]));
    await userEvent.click(screen.getByRole("button", { name: "Planned (1)" }));
    let list = screen.getByText("In this view").closest("div")!;
    expect(list).toHaveTextContent("Tooth 36");
    expect(list).not.toHaveTextContent("Tooth 16");
    expect(screen.getByText("Treatment your dentist has planned for you.")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Done so far (1)" }));
    list = screen.getByText("In this view").closest("div")!;
    expect(list).toHaveTextContent("Tooth 26");
    expect(list).not.toHaveTextContent("Tooth 36");
    await userEvent.click(within26(list));
    expect(screen.getByText(/Done · 5 Oct/)).toBeInTheDocument();
  });

  test("REG-FE-PORTAL-TEETH-003 a view with nothing in it says so in words", async () => {
    open(ME([{ id: "a", tooth: 16, kind: "filling", surface: "O", material: "composite", status: "existing" }]));
    await userEvent.click(screen.getByRole("button", { name: "Planned (0)" }));
    expect(screen.getByRole("status")).toHaveTextContent("Nothing is planned right now.");
    await userEvent.click(screen.getByRole("button", { name: "Done so far (0)" }));
    expect(screen.getByRole("status")).toHaveTextContent("No work has been finished yet.");
  });

  test("REG-FE-PORTAL-TEETH-004 tapping a tooth that has nothing in the current view says so; changing view clears the selection", async () => {
    open(ME([...ITEMS]));
    fireEvent.click(screen.getAllByRole("button", { name: /Tooth 36/ })[0]!);
    expect(await screen.findByText("Nothing here in this view.")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Planned (1)" }));
    expect(screen.getByText("Tap a tooth")).toBeInTheDocument();
  });
});

describe("REG-FE-PORTAL-TEETH the 3D model", () => {
  const to3d = async (m = ME([...ITEMS])) => { open(m); await userEvent.click(screen.getByRole("button", { name: /3D/ })); await screen.findByTestId("stage3d"); };

  test("REG-FE-PORTAL-TEETH-010 3D opens closed and front-on, with the controls to open the mouth, see only the upper or lower teeth, a side view, roots and numbers", async () => {
    await to3d();
    expect(last()).toMatchObject({ view: "front", xray: false, nums: true, mode: "adult" });
    for (const n of ["Closed", "Open mouth", "Upper teeth", "Lower teeth", "Side", "Show roots", "Numbers"]) expect(screen.getByRole("button", { name: n })).toBeInTheDocument();
  });

  test("REG-FE-PORTAL-TEETH-011 each view button turns the model; roots and numbers toggle", async () => {
    await to3d();
    for (const [name, view] of [["Open mouth", "open"], ["Upper teeth", "upper"], ["Lower teeth", "lower"], ["Side", "side"], ["Closed", "front"]] as const) {
      await userEvent.click(screen.getByRole("button", { name }));
      expect(last().view).toBe(view);
      expect(screen.getByRole("button", { name })).toHaveAttribute("aria-pressed", "true");
    }
    await userEvent.click(screen.getByRole("button", { name: "Show roots" }));
    expect(last().xray).toBe(true);
    await userEvent.click(screen.getByRole("button", { name: "Numbers" }));
    expect(last().nums).toBe(false);
  });

  test("REG-FE-PORTAL-TEETH-012 turning the model by hand leaves the preset; Re-centre brings it back", async () => {
    await to3d();
    await userEvent.click(screen.getByRole("button", { name: "Upper teeth" }));
    expect(screen.getByRole("button", { name: "Re-centre" })).toBeDisabled();
    act(() => (last().onCustomView as () => void)());
    expect(last().view).toBe("custom");
    await userEvent.click(screen.getByRole("button", { name: "Re-centre" }));
    expect(last().view).toBe("upper");
  });

  test("REG-FE-PORTAL-TEETH-013 the 3D model shows the same view as the chart: planned work only in Planned", async () => {
    await to3d();
    expect((last().state as { teeth: Record<number, unknown> }).teeth[36]).toBeUndefined();
    await userEvent.click(screen.getByRole("button", { name: "Planned (1)" }));
    expect((last().state as { teeth: Record<number, { rct?: unknown }> }).teeth[36]?.rct).toBeTruthy();
  });

  test("REG-FE-PORTAL-TEETH-014 selecting a tooth in 3D selects it in the panel", async () => {
    await to3d();
    act(() => (last().onSelect as (n: number) => void)(16));
    expect(await screen.findByText(/Tooth 16 · /)).toBeInTheDocument();
  });

  test("REG-FE-PORTAL-TEETH-015 a clinic that hides 3D shows only the chart", () => {
    open(ME([...ITEMS], false));
    expect(screen.queryByRole("button", { name: /3D/ })).not.toBeInTheDocument();
  });

  test("REG-FE-PORTAL-TEETH-016 a child's chart opens in the child dentition", async () => {
    await to3d(ME([{ id: "k", tooth: 55, kind: "filling", surface: "O", material: "composite", status: "existing" }]));
    expect(last().mode).toBe("child");
  });
});

function within26(list: HTMLElement) { return Array.from(list.querySelectorAll("button")).find((b) => /Tooth 26/.test(b.textContent ?? ""))!; }
