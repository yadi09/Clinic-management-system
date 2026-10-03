// The shared pickers: what was done (the clinic's procedure list, multi-select, with
// "add one not on the list"), and to which teeth (a quadrant list with one-tap whole
// mouth / arch / condition picks, and the Palmer chart that shows the selection).
import { useState } from "react";
import { screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, test, vi } from "vitest";

const api = vi.hoisted(() => ({ listProcedures: vi.fn(), listToothStatuses: vi.fn() }));
vi.mock("@/features/dental/api", async (orig) => ({ ...(await orig<object>()), ...api }));
vi.mock("@/lib/api-client", async (orig) => {
  const { quietApiFetch } = await import("@/test/render");
  return { ...(await orig<object>()), apiFetch: vi.fn(quietApiFetch) };
});

import { FLAT_TEETH, ProcedureMultiSelect, ToothMultiSelect, ToothPalmerPicker, parseCsv } from "@/features/dental/shared/pickers";
import type { ToothStatusDef } from "@/features/dental/api";
import { renderUI } from "@/test/render";

// The tooth list is 32 rows plus quick picks; a few clicks re-render it all.
vi.setConfig({ testTimeout: 60_000 });

const STATUSES: ToothStatusDef[] = [
  { id: "1", code: "decayed", label: "Decayed", color: "#ef4444", sort_order: 1, is_active: true },
  { id: "2", code: "filled", label: "Filled", color: "#3b82f6", sort_order: 2, is_active: true },
  { id: "3", code: "crown", label: "Crown", color: "#a855f7", sort_order: 3, is_active: true },
  { id: "4", code: "bridge", label: "Bridge", color: "#999999", sort_order: 4, is_active: false },
];
const TEETH = { UR6: "decayed", LL3: "decayed", UR1: "filled" };
const UPPER = FLAT_TEETH.slice(0, 16);
const LOWER = FLAT_TEETH.slice(16);

/** Holds the value like a real form does, and shows it for assertions. */
function Stateful({ kind, initial = [], teeth = TEETH, placeholder }: {
  kind: "proc" | "tooth" | "palmer"; initial?: string[]; teeth?: Record<string, string>; placeholder?: string;
}) {
  const [v, setV] = useState<string[]>(initial);
  return (
    <>
      {kind === "proc" && <ProcedureMultiSelect value={v} onChange={setV} />}
      {kind === "tooth" && <ToothMultiSelect teeth={teeth} value={v} onChange={setV} placeholder={placeholder} />}
      {kind === "palmer" && <ToothPalmerPicker teeth={teeth} value={v} onChange={setV} />}
      <output data-testid="value">{v.join(",")}</output>
    </>
  );
}
const value = () => screen.getByTestId("value").textContent;
const trigger = () => screen.getAllByRole("combobox")[0];

describe("REG-FE-SHARED pickers helpers", () => {
  test("REG-FE-SHARED-117 FLAT_TEETH is the 32 Palmer codes in chart order; parseCsv splits stored lists", () => {
    expect(FLAT_TEETH).toHaveLength(32);
    expect(FLAT_TEETH.slice(0, 3)).toEqual(["UR8", "UR7", "UR6"]);
    expect(FLAT_TEETH.at(-1)).toBe("LL8");
    expect(parseCsv("UR6, UR7 ,, LL1")).toEqual(["UR6", "UR7", "LL1"]);
    expect(parseCsv("")).toEqual([]);
    expect(parseCsv(undefined)).toEqual([]);
  });
});

describe("REG-FE-SHARED ProcedureMultiSelect", () => {
  beforeEach(() => {
    api.listProcedures.mockReset();
    api.listProcedures.mockResolvedValue([
      { id: "a", name: "Filling", is_active: true, sort_order: 1 },
      { id: "b", name: "Extraction", is_active: true, sort_order: 2 },
    ]);
  });

  test("REG-FE-SHARED-118 the trigger reads 'Select procedures', then the count and names", async () => {
    const a = renderUI(<Stateful kind="proc" />);
    expect(trigger()).toHaveTextContent("Select procedures");
    a.unmount();
    renderUI(<Stateful kind="proc" initial={["Filling", "Scaling"]} />);
    expect(trigger()).toHaveTextContent("2 selected · Filling, Scaling");
  });

  test("REG-FE-SHARED-119 lists the clinic's procedures plus a retired one already on the record, ticked", async () => {
    const { user } = renderUI(<Stateful kind="proc" initial={["Old bleach"]} />);
    await user.click(trigger());
    expect(await screen.findByRole("option", { name: "Filling" })).toBeInTheDocument();
    expect(screen.getByRole("option", { name: "Extraction" })).toBeInTheDocument();
    const retired = screen.getByRole("option", { name: "Old bleach" });
    expect(retired.querySelector("svg")!.getAttribute("class")).toContain("opacity-100");
    expect(screen.getByRole("option", { name: "Filling" }).querySelector("svg")!.getAttribute("class")).toContain("opacity-0");
    expect(api.listProcedures).toHaveBeenCalled();
  });

  test("REG-FE-SHARED-120 choosing toggles: tick adds, tick again removes, several at once", async () => {
    const { user } = renderUI(<Stateful kind="proc" />);
    await user.click(trigger());
    await user.click(await screen.findByRole("option", { name: "Filling" }));
    await user.click(screen.getByRole("option", { name: "Extraction" }));
    expect(value()).toBe("Filling,Extraction");
    await user.click(screen.getByRole("option", { name: "Filling" }));
    expect(value()).toBe("Extraction");
  });

  test("REG-FE-SHARED-121 a name not on the list can be added; the search then clears", async () => {
    const { user } = renderUI(<Stateful kind="proc" />);
    await user.click(trigger());
    await screen.findByRole("option", { name: "Filling" });
    const box = screen.getByPlaceholderText("Search procedures…");
    await user.type(box, "Veneer");
    await user.click(screen.getByRole("option", { name: /Add "Veneer"/ }));
    expect(value()).toBe("Veneer");
    expect(box).toHaveValue("");
  });

  test("REG-FE-SHARED-122 no Add offer for a name already on the list, in any case", async () => {
    const { user } = renderUI(<Stateful kind="proc" />);
    await user.click(trigger());
    await screen.findByRole("option", { name: "Filling" });
    await user.type(screen.getByPlaceholderText("Search procedures…"), "filling");
    expect(screen.queryByRole("option", { name: /Add "/ })).not.toBeInTheDocument();
    expect(screen.getByRole("option", { name: "Filling" })).toBeInTheDocument();
  });

  test("REG-FE-SHARED-123 an empty clinic list says so; closing the picker forgets the search", async () => {
    api.listProcedures.mockResolvedValue([]);
    const { user } = renderUI(<Stateful kind="proc" />);
    await user.click(trigger());
    expect(await screen.findByText("No procedure found.")).toBeInTheDocument();
    await user.type(screen.getByPlaceholderText("Search procedures…"), "Veneer");
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByPlaceholderText("Search procedures…")).not.toBeInTheDocument());
    await user.click(trigger());
    expect(await screen.findByPlaceholderText("Search procedures…")).toHaveValue("");
  });
});

describe("REG-FE-SHARED ToothMultiSelect", () => {
  beforeEach(() => {
    api.listToothStatuses.mockReset();
    api.listToothStatuses.mockResolvedValue(STATUSES);
  });
  const tooth = (code: string) => screen.getByRole("button", { name: new RegExp(`^${code}\\b`) });
  async function openTeeth(user: ReturnType<typeof renderUI>["user"]) {
    await user.click(trigger());
    await screen.findByRole("button", { name: "Upper" });
  }

  test("REG-FE-SHARED-124 the trigger: placeholder (default or given), then the codes in chart order", () => {
    const a = renderUI(<Stateful kind="tooth" />);
    expect(trigger()).toHaveTextContent("No specific tooth");
    a.unmount();
    const b = renderUI(<Stateful kind="tooth" placeholder="Whole mouth" />);
    expect(trigger()).toHaveTextContent("Whole mouth");
    b.unmount();
    renderUI(<Stateful kind="tooth" initial={["UR6", "UR8"]} />);
    expect(trigger()).toHaveTextContent("2 selected · UR8, UR6");
  });

  test("REG-FE-SHARED-125 summaries: whole mouth, an arch, more than six teeth", () => {
    const a = renderUI(<Stateful kind="tooth" initial={[...FLAT_TEETH]} />);
    expect(trigger()).toHaveTextContent("All 32 teeth");
    a.unmount();
    const b = renderUI(<Stateful kind="tooth" initial={UPPER} />);
    expect(trigger()).toHaveTextContent("Upper arch · 16 teeth");
    b.unmount();
    const c = renderUI(<Stateful kind="tooth" initial={LOWER} />);
    expect(trigger()).toHaveTextContent("Lower arch · 16 teeth");
    c.unmount();
    renderUI(<Stateful kind="tooth" initial={FLAT_TEETH.slice(0, 7)} />);
    expect(trigger()).toHaveTextContent("7 teeth · UR8, UR7, UR6, UR5, UR4…");
  });

  test("REG-FE-SHARED-126 every tooth of one condition reads back as that condition", async () => {
    renderUI(<Stateful kind="tooth" initial={["LL3", "UR6"]} />);
    await waitFor(() => expect(trigger()).toHaveTextContent("All decayed · 2"));
  });

  test("REG-FE-SHARED-127 quick picks: whole mouth, upper, lower; the active one is marked; Clear empties", async () => {
    const { user } = renderUI(<Stateful kind="tooth" />);
    await openTeeth(user);
    expect(screen.queryByRole("button", { name: "Clear" })).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "All 32" }));
    expect(value()!.split(",")).toHaveLength(32);
    expect(screen.getByRole("button", { name: "All 32" }).className).toContain("bg-brand");
    await user.click(screen.getByRole("button", { name: "Upper" }));
    expect(value()).toBe(UPPER.join(","));
    expect(screen.getByRole("button", { name: "Upper" }).className).toContain("bg-brand");
    expect(screen.getByRole("button", { name: "All 32" }).className).not.toContain("bg-brand");
    await user.click(screen.getByRole("button", { name: "Lower" }));
    expect(value()).toBe(LOWER.join(","));
    await user.click(screen.getByRole("button", { name: "Clear" }));
    expect(value()).toBe("");
  });

  test("REG-FE-SHARED-128 condition picks appear only for conditions this mouth has, with counts, and toggle", async () => {
    const { user } = renderUI(<Stateful kind="tooth" />);
    await openTeeth(user);
    const decayed = await screen.findByRole("button", { name: "All decayed · 2" });
    expect(screen.getByRole("button", { name: "All filled · 1" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /All crown/ })).not.toBeInTheDocument();
    await user.click(decayed);
    expect(value()).toBe("UR6,LL3");
    await user.click(screen.getByRole("button", { name: "All decayed · 2" }));
    expect(value()).toBe("");
  });

  test("REG-FE-SHARED-129 no condition row when nothing is charted", async () => {
    const { user } = renderUI(<Stateful kind="tooth" teeth={{}} />);
    await openTeeth(user);
    await waitFor(() => expect(api.listToothStatuses).toHaveBeenCalled());
    expect(screen.queryByRole("button", { name: /^All (decayed|filled)/ })).not.toBeInTheDocument();
  });

  test("REG-FE-SHARED-130 a quadrant's 'all 8' adds its teeth to the selection, 'none' takes only them away", async () => {
    const { user } = renderUI(<Stateful kind="tooth" initial={["LL1"]} />);
    await openTeeth(user);
    expect(screen.getByText("Upper right")).toBeInTheDocument();
    await user.click(screen.getAllByRole("button", { name: "all 8" })[0]);
    expect(value()).toBe(["LL1", ...FLAT_TEETH.slice(0, 8)].join(","));
    await user.click(screen.getByRole("button", { name: "none" }));
    expect(value()).toBe("LL1");
  });

  test("REG-FE-SHARED-131 a tooth row toggles and names its charted condition", async () => {
    const { user } = renderUI(<Stateful kind="tooth" />);
    await openTeeth(user);
    await waitFor(() => expect(tooth("UR6")).toHaveTextContent("· Decayed"));
    expect(tooth("UR7")).not.toHaveTextContent("·");
    await user.click(tooth("UR6"));
    await user.click(tooth("LR2"));
    expect(value()).toBe("UR6,LR2");
    expect(tooth("UR6").querySelector("svg")).not.toBeNull();
    await user.click(tooth("UR6"));
    expect(value()).toBe("LR2");
    expect(tooth("UR6").querySelector("svg")).toBeNull();
  });
});

describe("REG-FE-SHARED ToothPalmerPicker", () => {
  beforeEach(() => {
    api.listToothStatuses.mockReset();
    api.listToothStatuses.mockResolvedValue(STATUSES);
  });
  const chip = (code: string) => screen.getByTitle(new RegExp(`^Palmer ${code} ·`));

  test("REG-FE-SHARED-132 all 32 teeth, Palmer numbering, nothing pressed, an invitation to tap", () => {
    renderUI(<Stateful kind="palmer" />);
    const teeth = screen.getAllByRole("button", { pressed: false });
    expect(teeth).toHaveLength(32);
    expect(chip("UR8")).toHaveTextContent("8");
    expect(screen.getByText("Tap a tooth to add it to this visit")).toBeInTheDocument();
  });

  test("REG-FE-SHARED-133 the title names the charted condition, or 'Not charted'", async () => {
    renderUI(<Stateful kind="palmer" />);
    await waitFor(() => expect(chip("UR6")).toHaveAttribute("title", "Palmer UR6 · Decayed"));
    expect(chip("UR7")).toHaveAttribute("title", "Palmer UR7 · Not charted");
  });

  test("REG-FE-SHARED-134 tapping selects (pressed, ticked, listed in chart order); tapping again removes", async () => {
    const { user } = renderUI(<Stateful kind="palmer" />);
    await user.click(chip("LL1"));
    await user.click(chip("UR6"));
    expect(value()).toBe("LL1,UR6");
    expect(chip("UR6")).toHaveAttribute("aria-pressed", "true");
    expect(chip("UR6").title).toMatch(/· selected$/);
    expect(chip("UR6").querySelector("svg")).not.toBeNull();
    expect(screen.getByText("2 treated today — UR6, LL1")).toBeInTheDocument();
    await user.click(chip("UR6"));
    expect(value()).toBe("LL1");
    expect(chip("UR6")).toHaveAttribute("aria-pressed", "false");
  });

  test("REG-FE-SHARED-135 a selected tooth keeps its condition colour (selection is an outline)", async () => {
    renderUI(<Stateful kind="palmer" initial={["UR6"]} />);
    await waitFor(() => expect(chip("UR6").style.borderColor).toBe("rgb(239, 68, 68)"));
    expect(chip("UR6").className).toContain("outline-brand");
  });

  test("REG-FE-SHARED-136 the legend lists the clinic's active conditions and 'Treated today'", async () => {
    const { container } = renderUI(<Stateful kind="palmer" />);
    const legend = () => container.querySelector(".mt-2\\.5") as HTMLElement;
    await waitFor(() => expect(within(legend()).getByText("Decayed")).toBeInTheDocument());
    expect(within(legend()).getByText("Filled")).toBeInTheDocument();
    expect(within(legend()).getByText("Crown")).toBeInTheDocument();
    expect(within(legend()).queryByText("Bridge")).not.toBeInTheDocument();
    expect(within(legend()).getByText("Treated today")).toBeInTheDocument();
  });
});
