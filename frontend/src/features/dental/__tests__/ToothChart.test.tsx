// The tooth chart. Two layers: the chart itself (what a dentist can do to it — mark
// with a chosen condition, drag across teeth, select a group, clear, undo — reported
// as changes), and the patient page's save around it (changes are saved as just the
// teeth that differ, undo is saved like any edit, a failed save puts the chart back).
import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { Toaster } from "sonner";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

const api = vi.hoisted(() => ({ listToothStatuses: vi.fn(), saveChart: vi.fn(), dentalSummary: vi.fn() }));
vi.mock("@/features/dental/api", async (orig) => ({ ...(await orig<object>()), ...api }));
vi.mock("@/lib/api-client", async (orig) => {
  const { quietApiFetch } = await import("@/test/render");
  return { ...(await orig<object>()), apiFetch: vi.fn(quietApiFetch), apiList: vi.fn(async () => ({ items: [], meta: {} })) };
});
vi.mock("@/app/auth-context", () => ({
  useAuth: () => ({ can: () => true, flagOn: () => true, user: { id: "u1", full_name: "Dr Test" }, activeBranchId: null }),
}));

import { ToothChart, type ToothChartProps } from "@/features/dental/ToothChart";
import { DentalWorkspace } from "@/features/dental/DentalWorkspace";
import type { Summary, ToothStatusDef } from "@/features/dental/api";
import { quietApiFetch, renderUI } from "@/test/render";
import { apiFetch } from "@/lib/api-client";

const STATUSES: ToothStatusDef[] = [
  { id: "1", code: "healthy", label: "Healthy", color: "#10b981", sort_order: 1, is_active: true },
  { id: "2", code: "decayed", label: "decayed", color: "#ef4444", sort_order: 2, is_active: true },
  { id: "3", code: "filled", label: "Filled", color: "#3b82f6", sort_order: 3, is_active: true },
  { id: "4", code: "extracted", label: "Extracted", color: "#6b7280", sort_order: 4, is_active: true },
];

const tooth = (code: string) => screen.getByRole("button", { name: new RegExp(`^${code}( —|$)`) });
const chip = (name: string) => within(screen.getByRole("group", { name: "Conditions" })).getByRole("button", { name });
const quick = (name: RegExp | string) => within(screen.getByRole("group", { name: "Quick selects" })).getByRole("button", { name });

/** A pointer event as the browser sends it. jsdom has no PointerEvent, and a plain
 *  Event drops `button` and the coordinates, so build it from a MouseEvent. */
function pointer(el: Element | Window, type: "pointerdown" | "pointermove" | "pointerup", init: MouseEventInit = {}) {
  act(() => { el.dispatchEvent(new MouseEvent(type, { bubbles: true, button: 0, ...init })); });
}

type Props = Partial<ToothChartProps>;
function chart(props: Props = {}) {
  const onApply = vi.fn();
  const onUndo = vi.fn();
  const onRedo = vi.fn();
  const r = renderUI(
    <ToothChart teeth={{}} editable onApply={onApply} onUndo={onUndo} onRedo={onRedo}
      canUndo={false} canRedo={false} saving={false} {...props} />,
  );
  return { ...r, onApply, onUndo, onRedo };
}
async function ready(props: Props = {}) {
  api.listToothStatuses.mockResolvedValue(STATUSES);
  const r = chart(props);
  await waitFor(() => expect(tooth("UR1")).toBeEnabled());
  return r;
}

describe("REG-FE-CHART the tooth chart", () => {
  beforeEach(() => {
    Object.values(api).forEach((f) => f.mockReset());
    sessionStorage.clear();
  });

  test("REG-FE-CHART-001 read-only while the conditions load: says so, teeth cannot be tapped", async () => {
    api.listToothStatuses.mockReturnValue(new Promise(() => {}));
    chart();
    expect(screen.getByRole("status")).toHaveTextContent("Loading the tooth conditions…");
    expect(tooth("UR1")).toBeDisabled();
  });

  test("REG-FE-CHART-002 the conditions failed to load: read-only, with Retry that asks again", async () => {
    api.listToothStatuses.mockRejectedValueOnce(new Error("down")).mockResolvedValue(STATUSES);
    const { user } = chart();
    expect(await screen.findByText(/did not load — the chart is read-only/)).toBeInTheDocument();
    expect(tooth("LL8")).toBeDisabled();
    await user.click(screen.getByRole("button", { name: "Retry" }));
    await waitFor(() => expect(tooth("LL8")).toBeEnabled());
    expect(screen.queryByText(/did not load/)).not.toBeInTheDocument();
  });

  test("REG-FE-CHART-003 loaded: 32 teeth, each saying its condition; the bar is the clinic's own list, capitalised", async () => {
    await ready({ teeth: { UR6: "decayed", LL3: "retired_mark" } });
    expect(screen.getAllByRole("button", { name: /^[UL][RL]\d/ })).toHaveLength(32);
    expect(tooth("UR6")).toHaveAccessibleName("UR6 — Decayed");
    // A mark the clinic no longer lists is still shown, never read as healthy.
    expect(tooth("LL3")).toHaveAccessibleName("LL3 — Retired mark");
    for (const name of ["Healthy", "Decayed", "Filled", "Extracted", "Clear"]) expect(chip(name)).toBeInTheDocument();
    // Right and left are labelled, and a mark carries its letter.
    expect(screen.getByText("Patient's right")).toBeInTheDocument();
    expect(within(tooth("UR6")).getByText("D")).toBeInTheDocument();
  });

  test("REG-FE-CHART-004 a viewer without edit rights gets no bar and no tappable chart, only a key", async () => {
    api.listToothStatuses.mockResolvedValue(STATUSES);
    chart({ editable: false });
    expect(await screen.findByText("Filled")).toBeInTheDocument();
    expect(tooth("UR1")).toBeDisabled();
    expect(screen.queryByRole("tablist", { name: "Chart mode" })).not.toBeInTheDocument();
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });

  test("REG-FE-CHART-010 pick a condition, then tap teeth: each tooth takes it, one change per tap; one already holding it is not an edit", async () => {
    const { user, onApply } = await ready({ teeth: { UR2: "decayed" } });
    expect(screen.getByText(/Pick a condition, then tap teeth/)).toBeInTheDocument();
    await user.click(chip("Decayed"));
    expect(chip("Decayed")).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByText(/Marking: Decayed/)).toBeInTheDocument();
    await user.click(tooth("UR1"));
    expect(onApply).toHaveBeenCalledWith({ UR1: "decayed" }, "Marked 1 tooth Decayed");
    onApply.mockClear();
    await user.click(tooth("UR2")); // already decayed
    expect(onApply).not.toHaveBeenCalled();
    // The same chip again, Escape, or another chip, all put the condition down / swap it.
    await user.click(chip("Decayed"));
    expect(chip("Decayed")).toHaveAttribute("aria-pressed", "false");
    await user.click(chip("Filled"));
    await user.click(tooth("UL4"));
    expect(onApply).toHaveBeenCalledWith({ UL4: "filled" }, "Marked 1 tooth Filled");
  });

  test("REG-FE-CHART-011 dragging across teeth marks each once, committed as ONE change", async () => {
    const { user, onApply } = await ready({ teeth: { UR6: "filled" } });
    await user.click(chip("Healthy"));
    await user.pointer([
      { keys: "[MouseLeft>]", target: tooth("UR8") },
      { target: tooth("UR7") },
      { target: tooth("UR7") },
      { target: tooth("UR6") },
      { keys: "[/MouseLeft]" },
    ]);
    expect(onApply).toHaveBeenCalledTimes(1);
    expect(onApply).toHaveBeenCalledWith({ UR8: "healthy", UR7: "healthy", UR6: "healthy" }, "Marked 3 teeth Healthy");
  });

  test("REG-FE-CHART-012 a drag shows the marks as it goes, and a finger's position (not its start) says which tooth", async () => {
    const { user, onApply } = await ready();
    await user.click(chip("Filled"));
    const real = document.elementFromPoint;
    document.elementFromPoint = vi.fn((x: number) => (x === 1 ? tooth("LL1") : x === 2 ? tooth("LL2") : null)) as typeof document.elementFromPoint;
    try {
      pointer(tooth("LL1"), "pointerdown", { clientX: 1 });
      pointer(tooth("LL1"), "pointermove", { clientX: 2 });
      expect(tooth("LL2")).toHaveAccessibleName("LL2 — Filled"); // previewed, not yet committed
      expect(onApply).not.toHaveBeenCalled();
      pointer(window, "pointerup");
    } finally {
      document.elementFromPoint = real;
    }
    expect(onApply).toHaveBeenCalledWith({ LL1: "filled", LL2: "filled" }, "Marked 2 teeth Filled");
    // Moving with nothing pressed paints nothing.
    pointer(tooth("LL3"), "pointermove", { clientX: 3 });
    expect(onApply).toHaveBeenCalledTimes(1);
  });

  test("REG-FE-CHART-013 tapping with nothing chosen opens a small menu at the tooth: two taps, no cycling", async () => {
    const { user, onApply } = await ready({ teeth: { UR6: "decayed" } });
    await user.click(tooth("UL2"));
    const menu = await screen.findByText(/UL2 · not marked/);
    expect(menu).toBeInTheDocument();
    // Clear is offered only for a marked tooth.
    expect(screen.getByRole("menuitem", { name: /Clear/ })).toBeDisabled();
    await user.click(screen.getByRole("menuitem", { name: "Filled" }));
    expect(onApply).toHaveBeenCalledWith({ UL2: "filled" }, "UL2 → Filled");
    await waitFor(() => expect(screen.queryByText(/UL2 · not marked/)).not.toBeInTheDocument());

    await user.click(tooth("UR6"));
    expect(await screen.findByText(/UR6 · Decayed/)).toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: /Decayed/ })).toHaveTextContent("current");
    await user.click(screen.getByRole("menuitem", { name: /Clear/ }));
    expect(onApply).toHaveBeenLastCalledWith({ UR6: "" }, "UR6 cleared");
  });

  test("REG-FE-CHART-014 the Clear brush erases what you tap; keys 1-9 pick conditions, 0 clears, Escape puts it down", async () => {
    const { user, onApply } = await ready({ teeth: { UR3: "filled", UR4: "decayed" } });
    await user.click(chip("Clear"));
    expect(screen.getByText(/Clearing: tap or drag/)).toBeInTheDocument();
    await user.click(tooth("UR3"));
    expect(onApply).toHaveBeenCalledWith({ UR3: "" }, "Cleared 1 tooth");
    await user.click(tooth("UR1")); // unmarked: nothing to clear
    expect(onApply).toHaveBeenCalledTimes(1);

    await user.keyboard("{Escape}");
    expect(chip("Clear")).toHaveAttribute("aria-pressed", "false");
    await user.keyboard("3");
    expect(chip("Filled")).toHaveAttribute("aria-pressed", "true");
    await user.keyboard("0");
    expect(chip("Clear")).toHaveAttribute("aria-pressed", "true");
    await user.keyboard("9"); // no ninth condition: ignored
    expect(chip("Clear")).toHaveAttribute("aria-pressed", "true");
  });

  test("REG-FE-CHART-015 Select: tap and drag to select, shortcuts replace the selection, applying changes only those teeth", async () => {
    const { user, onApply } = await ready({ teeth: { UR1: "decayed", UL1: "decayed", LR8: "filled" } });
    await user.click(screen.getByRole("tab", { name: "Select" }));
    expect(screen.getByText("Select teeth, then pick a condition")).toBeInTheDocument();
    // Nothing selected: a condition does nothing.
    await user.click(chip("Healthy"));
    expect(onApply).not.toHaveBeenCalled();

    await user.click(tooth("UR8"));
    expect(tooth("UR8")).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByText("1 tooth selected")).toBeInTheDocument();
    // A drag starting on a selected tooth deselects what it crosses.
    await user.pointer([{ keys: "[MouseLeft>]", target: tooth("UR8") }, { target: tooth("UR7") }, { keys: "[/MouseLeft]" }]);
    expect(screen.getByText("Select teeth, then pick a condition")).toBeInTheDocument();
    // A drag starting on an unselected one selects.
    await user.pointer([{ keys: "[MouseLeft>]", target: tooth("UR6") }, { target: tooth("UR5") }, { keys: "[/MouseLeft]" }]);
    expect(screen.getByText("2 teeth selected")).toBeInTheDocument();

    await user.click(quick("Upper"));
    expect(screen.getByText("16 teeth selected")).toBeInTheDocument();
    await user.click(quick("Upper")); // again: back to nothing
    expect(screen.getByText("Select teeth, then pick a condition")).toBeInTheDocument();

    await user.click(quick("Not marked"));
    expect(screen.getByText("29 teeth selected")).toBeInTheDocument();
    await user.click(chip("Healthy"));
    const [changes, label] = onApply.mock.calls[0];
    expect(Object.keys(changes)).toHaveLength(29);
    expect(changes.UR1).toBeUndefined(); // marked teeth were not in "Not marked"
    expect(label).toBe("Marked 29 teeth Healthy");
    // Applying clears the selection: a second tap on a condition cannot repeat it.
    expect(screen.getByText("Select teeth, then pick a condition")).toBeInTheDocument();
  });

  test("REG-FE-CHART-016 Select: 'All decayed', Invert, Clear selection, and Clear applied to a selection", async () => {
    const { user, onApply } = await ready({ teeth: { UR1: "decayed", UL1: "decayed", LR8: "filled" } });
    await user.click(screen.getByRole("tab", { name: "Select" }));
    await user.click(quick("All decayed · 2"));
    expect(screen.getByText("2 teeth selected")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Invert" }));
    expect(screen.getByText("30 teeth selected")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Clear selection" }));
    expect(screen.getByText("Select teeth, then pick a condition")).toBeInTheDocument();

    await user.click(quick("All"));
    await user.click(chip("Clear"));
    const [changes, label] = onApply.mock.calls[0];
    expect(changes).toEqual({ UR1: "", UL1: "", LR8: "" });
    expect(label).toBe("Cleared 3 teeth");
  });

  test("REG-FE-CHART-017 leaving Select puts the selection down; a condition is never carried over", async () => {
    const { user, onApply } = await ready();
    await user.click(chip("Decayed"));
    await user.click(screen.getByRole("tab", { name: "Select" }));
    expect(chip("Decayed")).toHaveAttribute("aria-pressed", "false");
    await user.click(quick("Lower"));
    await user.click(screen.getByRole("tab", { name: "Mark" }));
    await user.click(tooth("LR1")); // nothing chosen: a menu, not a mark
    expect(await screen.findByText(/LR1 · not marked/)).toBeInTheDocument();
    expect(onApply).not.toHaveBeenCalled();
  });

  test("REG-FE-CHART-018 Clear all: disabled on an empty chart; asks first with the count; Cancel changes nothing", async () => {
    const empty = await ready();
    expect(screen.getByRole("button", { name: "Clear all" })).toBeDisabled();
    empty.unmount();

    const { user, onApply } = await ready({ teeth: { UR1: "decayed", UL2: "filled", LL3: "healthy" } });
    await user.click(screen.getByRole("button", { name: "Clear all" }));
    const dlg = await screen.findByRole("dialog");
    expect(dlg).toHaveTextContent("This removes 3 marks");
    await user.click(within(dlg).getByRole("button", { name: "Cancel" }));
    expect(onApply).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "Clear all" }));
    await user.click(await screen.findByRole("button", { name: "Clear 3 marks" }));
    expect(onApply).toHaveBeenCalledWith({ UR1: "", UL2: "", LL3: "" }, "Cleared 3 marks");
  });

  test("REG-FE-CHART-019 Undo and Redo: buttons, and Ctrl+Z / Ctrl+Shift+Z / Ctrl+Y inside the chart; disabled when there is nothing", async () => {
    const off = await ready();
    expect(screen.getByRole("button", { name: "Undo" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Redo" })).toBeDisabled();
    off.unmount();

    const { user, onUndo, onRedo } = await ready({ canUndo: true, canRedo: true });
    await user.click(screen.getByRole("button", { name: "Undo" }));
    await user.click(screen.getByRole("button", { name: "Redo" }));
    expect(onUndo).toHaveBeenCalledTimes(1);
    expect(onRedo).toHaveBeenCalledTimes(1);
    tooth("UR1").focus();
    await user.keyboard("{Control>}z{/Control}");
    expect(onUndo).toHaveBeenCalledTimes(2);
    await user.keyboard("{Control>}{Shift>}z{/Shift}{/Control}");
    await user.keyboard("{Control>}y{/Control}");
    expect(onRedo).toHaveBeenCalledTimes(3);
  });

  test("REG-FE-CHART-020 the bar says nothing until something is changed, then Saving… while a save is waiting and Saved after", async () => {
    const saved = await ready();
    expect(screen.queryByText("✓ Saved")).not.toBeInTheDocument();
    await saved.user.click(chip("Healthy"));
    await saved.user.click(tooth("UR1"));
    expect(screen.getByText("✓ Saved")).toBeInTheDocument();
    saved.unmount();

    const saving = await ready({ saving: true });
    await saving.user.click(chip("Healthy"));
    await saving.user.click(tooth("UR1"));
    expect(screen.getByText("Saving…")).toBeInTheDocument();
  });

  test("REG-FE-CHART-025 a failed save is said in the bar, in words, not only in a pop-up", async () => {
    await ready({ failed: true });
    expect(screen.getByText("Not saved — changes undone")).toBeInTheDocument();
  });

  test("REG-FE-CHART-034 a save that got no answer does not claim its changes were undone: it may have landed", async () => {
    await ready({ failed: "unconfirmed" });
    expect(screen.getByText("Not confirmed — reload to check what was saved")).toBeInTheDocument();
    expect(screen.queryByText("Not saved — changes undone")).not.toBeInTheDocument();
  });

  test("REG-FE-CHART-035 a timed-out save puts the chart back, says it is not confirmed, and the pop-up says it may not have been saved", async () => {
    const { AppError } = await vi.importActual<typeof import("@/lib/api-client")>("@/lib/api-client");
    const { user } = await openChart({ LR6: "decayed" });
    api.saveChart.mockRejectedValue(new AppError(0, "TIMEOUT", "The server did not answer in time. Your change may not have been saved — check before doing it again."));
    await user.click(chip("Filled"));
    await user.click(tooth("LR6"));
    await waitFor(() => expect(api.saveChart).toHaveBeenCalled(), { timeout: 3000 });
    await waitFor(() => expect(tooth("LR6")).toHaveAccessibleName("LR6 — Decayed"));
    expect(await screen.findByText(/may not have been saved/)).toBeInTheDocument();
    expect(screen.getByText("Not confirmed — reload to check what was saved")).toBeInTheDocument();
    expect(screen.queryByText("Not saved — changes undone")).not.toBeInTheDocument();
    // The next change clears it.
    api.saveChart.mockResolvedValue({ teeth: { LR6: "filled" } });
    await user.click(tooth("LR5"));
    expect(screen.queryByText(/Not confirmed/)).not.toBeInTheDocument();
  });

  test("REG-FE-CHART-021 keyboard: arrows walk the teeth and stop at the edge, A selects every tooth, Enter marks with the chosen condition", async () => {
    const { user, onApply } = await ready();
    await user.click(chip("Filled"));
    tooth("UR8").focus();
    await user.keyboard("{ArrowRight}");
    expect(tooth("UR7")).toHaveFocus();
    await user.keyboard("{ArrowDown}");
    expect(tooth("LR7")).toHaveFocus();
    await user.keyboard("{ArrowUp}{ArrowLeft}{ArrowLeft}");
    expect(tooth("UR8")).toHaveFocus(); // stopped at the edge
    await user.keyboard("{Enter}");
    expect(onApply).toHaveBeenCalledWith({ UR8: "filled" }, "Marked 1 tooth Filled");

    await user.keyboard("a");
    expect(screen.getByRole("tab", { name: "Select" })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByText("32 teeth selected")).toBeInTheDocument();
    await user.keyboard("{Escape}");
    expect(screen.getByText("Select teeth, then pick a condition")).toBeInTheDocument();
  });

  test("REG-FE-CHART-022 the summary line counts what is marked and what is not", async () => {
    await ready();
    expect(screen.getByText("Nothing marked yet.")).toBeInTheDocument();
  });

  test("REG-FE-CHART-023 the summary line counts per condition and shows a drag's marks as it goes", async () => {
    const { user } = await ready({ teeth: { UR1: "decayed", UR2: "decayed", UL1: "healthy" } });
    expect(screen.getByText(/3 marked: 1 Healthy · 2 Decayed · 29 not marked/)).toBeInTheDocument();
    await user.click(chip("Filled"));
    pointer(tooth("LR1"), "pointerdown");
    expect(screen.getByText(/4 marked: 1 Healthy · 2 Decayed · 1 Filled · 28 not marked/)).toBeInTheDocument();
    pointer(window, "pointerup");
  });

  test("REG-FE-CHART-024 only the primary button starts a stroke (a right-click is not a mark)", async () => {
    const { user, onApply } = await ready();
    await user.click(chip("Healthy"));
    pointer(tooth("UR1"), "pointerdown", { button: 2 });
    pointer(window, "pointerup");
    expect(onApply).not.toHaveBeenCalled();
    pointer(tooth("UR1"), "pointerdown");
    pointer(window, "pointerup");
    expect(onApply).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// The save, on the patient page.

const summary = (teeth: Record<string, string>): Summary => ({
  chart: { teeth } as Summary["chart"],
  plans: [],
  balance: { owed: "0", paid: "0", balance: "0", due: "0", at_cashier: "0", waived: "0", overdue: false } as unknown as Summary["balance"],
  image_limit: -1,
});

async function openChart(teeth: Record<string, string>) {
  api.listToothStatuses.mockResolvedValue(STATUSES);
  api.dentalSummary.mockResolvedValue(summary(teeth));
  const r = renderUI(<><DentalWorkspace patientId="pat_1" /><Toaster /></>, { route: "/patients/pat_1" });
  await r.user.click(await screen.findByRole("button", { name: /Tooth chart/ }));
  await waitFor(() => expect(tooth("UR1")).toBeEnabled());
  return r;
}

describe("REG-FE-CHART saving the chart from the patient page", () => {
  beforeEach(() => {
    Object.values(api).forEach((f) => f.mockReset());
    sessionStorage.clear();
    api.saveChart.mockImplementation(async (_p: string, changes: Record<string, string>) => ({ teeth: changes }));
  });

  test("REG-FE-CHART-005 a chosen condition on a tooth saves only that tooth", async () => {
    const { user } = await openChart({ UR6: "decayed" });
    api.dentalSummary.mockResolvedValue(summary({ UR6: "filled" }));
    api.saveChart.mockResolvedValue({ teeth: { UR6: "filled" } });
    await user.click(chip("Filled"));
    await user.click(tooth("UR6"));
    expect(tooth("UR6")).toHaveAccessibleName("UR6 — Filled");
    await waitFor(() => expect(api.saveChart).toHaveBeenCalledTimes(1), { timeout: 3000 });
    expect(api.saveChart.mock.calls[0].slice(0, 2)).toEqual(["pat_1", { UR6: "filled" }]);
  });

  test("REG-FE-CHART-006 a single change has no pop-up; Undo in the bar saves the tooth back, and Redo does it again", async () => {
    const { user } = await openChart({});
    api.saveChart.mockResolvedValueOnce({ teeth: { UL2: "healthy" } });
    api.dentalSummary.mockResolvedValue(summary({ UL2: "healthy" }));
    await user.click(tooth("UL2"));
    await user.click(await screen.findByRole("menuitem", { name: "Healthy" }));
    expect(tooth("UL2")).toHaveAccessibleName("UL2 — Healthy");
    expect(document.querySelector("[data-sonner-toast]")).toBeNull();
    await waitFor(() => expect(api.saveChart).toHaveBeenCalledTimes(1), { timeout: 3000 });
    expect(api.saveChart.mock.calls[0][1]).toEqual({ UL2: "healthy" });

    api.saveChart.mockResolvedValueOnce({ teeth: {} });
    api.dentalSummary.mockResolvedValue(summary({}));
    await user.click(screen.getByRole("button", { name: "Undo" }));
    expect(tooth("UL2")).toHaveAccessibleName("UL2");
    await waitFor(() => expect(api.saveChart).toHaveBeenCalledTimes(2), { timeout: 3000 });
    expect(api.saveChart.mock.calls[1][1]).toEqual({ UL2: "" });

    api.saveChart.mockResolvedValueOnce({ teeth: { UL2: "healthy" } });
    api.dentalSummary.mockResolvedValue(summary({ UL2: "healthy" }));
    await user.click(screen.getByRole("button", { name: "Redo" }));
    expect(tooth("UL2")).toHaveAccessibleName("UL2 — Healthy");
    await waitFor(() => expect(api.saveChart).toHaveBeenCalledTimes(3), { timeout: 3000 });
    expect(api.saveChart.mock.calls[2][1]).toEqual({ UL2: "healthy" });
  });

  test("REG-FE-CHART-007 quick taps on two teeth go out as one save with both changes", async () => {
    const { user } = await openChart({});
    await user.click(chip("Healthy"));
    api.saveChart.mockResolvedValue({ teeth: { UR1: "healthy", UR2: "healthy" } });
    // The batch window is 700 ms of wall time. With real timers, two simulated taps on
    // a loaded machine (the full run under coverage) can land further apart than that,
    // and the test failed while the batching was fine. Own the clock instead.
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      pointer(tooth("UR1"), "pointerdown");
      pointer(window, "pointerup");
      act(() => { vi.advanceTimersByTime(600); });
      pointer(tooth("UR2"), "pointerdown");
      pointer(window, "pointerup");
      expect(api.saveChart).not.toHaveBeenCalled();
      act(() => { vi.advanceTimersByTime(700); });
    } finally {
      vi.useRealTimers();
    }
    await waitFor(() => expect(api.saveChart).toHaveBeenCalledTimes(1), { timeout: 3000 });
    expect(api.saveChart.mock.calls[0][1]).toEqual({ UR1: "healthy", UR2: "healthy" });
  });

  test("REG-FE-CHART-008 a failed save puts the chart back to what the server holds", async () => {
    const { user } = await openChart({ LR6: "decayed" });
    api.saveChart.mockRejectedValue(new Error("offline"));
    await user.click(chip("Filled"));
    await user.click(tooth("LR6"));
    expect(tooth("LR6")).toHaveAccessibleName("LR6 — Filled");
    await waitFor(() => expect(api.saveChart).toHaveBeenCalled(), { timeout: 3000 });
    await waitFor(() => expect(tooth("LR6")).toHaveAccessibleName("LR6 — Decayed"));
    expect(await screen.findByText(/your last changes were undone/)).toBeInTheDocument();
    expect(screen.getByText("Not saved — changes undone")).toBeInTheDocument();
    // The next change clears it.
    api.saveChart.mockResolvedValue({ teeth: { LR6: "filled" } });
    await user.click(tooth("LR5"));
    expect(screen.queryByText("Not saved — changes undone")).not.toBeInTheDocument();
  });

  test("REG-FE-CHART-009 the chart is shown as the server sent it", async () => {
    await openChart({ UR8: "decayed", LL1: "filled" });
    expect(tooth("UR8")).toHaveAccessibleName("UR8 — Decayed");
    expect(tooth("LL1")).toHaveAccessibleName("LL1 — Filled");
    await act(async () => {});
  });

  test("REG-FE-CHART-030 a whole-arch change is ONE save, ONE pop-up and ONE Undo (from the pop-up too)", async () => {
    const { user } = await openChart({});
    await user.click(screen.getByRole("tab", { name: "Select" }));
    await user.click(quick("Upper"));
    await user.click(chip("Healthy"));
    expect(tooth("UR1")).toHaveAccessibleName("UR1 — Healthy");
    const toast = await screen.findByText("Marked 16 teeth Healthy");
    await waitFor(() => expect(api.saveChart).toHaveBeenCalledTimes(1), { timeout: 3000 });
    expect(Object.keys(api.saveChart.mock.calls[0][1])).toHaveLength(16);

    api.saveChart.mockResolvedValueOnce({ teeth: {} });
    await user.click(within(toast.closest("li") as HTMLElement).getByRole("button", { name: "Undo" }));
    expect(tooth("UR1")).toHaveAccessibleName("UR1");
    await waitFor(() => expect(api.saveChart).toHaveBeenCalledTimes(2), { timeout: 3000 });
    expect(Object.values(api.saveChart.mock.calls[1][1]).every((v) => v === "")).toBe(true);
  });

  test("REG-FE-CHART-031 clearing the whole chart saves a clear for every mark, and Undo puts them all back", async () => {
    const { user } = await openChart({ UR1: "decayed", UL5: "filled", LR2: "healthy" });
    await user.click(screen.getByRole("button", { name: "Clear all" }));
    await user.click(await screen.findByRole("button", { name: "Clear 3 marks" }));
    expect(tooth("UL5")).toHaveAccessibleName("UL5");
    await waitFor(() => expect(api.saveChart).toHaveBeenCalledTimes(1), { timeout: 3000 });
    expect(api.saveChart.mock.calls[0][1]).toEqual({ UR1: "", UL5: "", LR2: "" });

    api.saveChart.mockResolvedValueOnce({ teeth: { UR1: "decayed", UL5: "filled", LR2: "healthy" } });
    await user.click(within(screen.getByRole("group", { name: "Conditions" }).parentElement!.parentElement!).getByRole("button", { name: "Undo" }));
    expect(tooth("UL5")).toHaveAccessibleName("UL5 — Filled");
    await waitFor(() => expect(api.saveChart).toHaveBeenCalledTimes(2), { timeout: 3000 });
    expect(api.saveChart.mock.calls[1][1]).toEqual({ UR1: "decayed", UL5: "filled", LR2: "healthy" });
  });

  test("REG-FE-CHART-032 a new change after an Undo ends the Redo (it would replay over newer work)", async () => {
    const { user } = await openChart({});
    await user.click(chip("Healthy"));
    await user.click(tooth("UR1"));
    await user.click(screen.getByRole("button", { name: "Undo" }));
    expect(screen.getByRole("button", { name: "Redo" })).toBeEnabled();
    await user.click(tooth("UR2"));
    expect(screen.getByRole("button", { name: "Redo" })).toBeDisabled();
  });

  test("REG-FE-CHART-033 Undo and Redo with nothing to undo or redo do nothing", async () => {
    await openChart({});
    expect(screen.getByRole("button", { name: "Undo" })).toBeDisabled();
    fireEvent.keyDown(tooth("UR1"), { key: "z", ctrlKey: true });
    fireEvent.keyDown(tooth("UR1"), { key: "z", ctrlKey: true, shiftKey: true });
    expect(api.saveChart).not.toHaveBeenCalled();
  });
});

describe("REG-FE-CHART the clinic's choice of chart", () => {
  const withSettings = (impl: (path: string) => Promise<unknown>) =>
    vi.mocked(apiFetch).mockImplementation(async (path: string) => impl(path));
  const anatomySummary = (teeth: Record<string, string>, anatomy: Summary["chart"]["anatomy"]) =>
    ({ ...summary(teeth), chart: { teeth, anatomy } }) as Summary;

  beforeEach(() => {
    Object.values(api).forEach((f) => f.mockReset());
    api.listToothStatuses.mockResolvedValue(STATUSES);
    api.saveChart.mockImplementation(async (_p: string, changes: Record<string, string>) => ({ teeth: changes }));
  });
  afterEach(() => vi.mocked(apiFetch).mockImplementation(quietApiFetch as never));

  test("REG-FE-CHART-036 a clinic on the anatomical chart gets it, with the simple chart's marks shown on the teeth", async () => {
    withSettings(async (p) => (p === "/dental/settings" ? { chart_style: "anatomical" } : quietApiFetch(p)));
    api.dentalSummary.mockResolvedValue(anatomySummary({ UR6: "decayed" }, { 11: { surfaces: {}, crown: false, root_canal: false, missing: false, rotation: 20, tipping: 0, buccal_lingual: 0, vertical: 0, gap_mesial: 0 } }));
    const { user } = renderUI(<><DentalWorkspace patientId="pat_1" /><Toaster /></>, { route: "/patients/pat_1" });
    await user.click(await screen.findByRole("button", { name: /Tooth chart/ }));
    expect(await screen.findByRole("radio", { name: "Adult (32)" })).toBeInTheDocument();
    expect(screen.queryByRole("group", { name: "Conditions" })).not.toBeInTheDocument();
    // The clinic's own name for the condition (this fixture's list calls it "decayed").
    expect(await screen.findByRole("button", { name: "Tooth 16, Upper right first molar, decayed" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^Tooth 11, Upper right central incisor: rotated 20° clockwise/ })).toBeInTheDocument();
    // Removing the old mark goes through the simple chart's own save.
    await user.click(screen.getByRole("button", { name: /^Tooth 16,/ }));
    await user.click(screen.getByRole("button", { name: "Remove mark" }));
    await waitFor(() => expect(api.saveChart).toHaveBeenCalled(), { timeout: 3000 });
    expect(api.saveChart.mock.calls[0][1]).toEqual({ UR6: "" });
  });

  test("REG-FE-CHART-037 a clinic on the simple chart keeps its squares, and still sees what was recorded on the anatomical chart", async () => {
    api.dentalSummary.mockResolvedValue(anatomySummary({ UR6: "decayed" }, {
      11: { surfaces: {}, crown: false, root_canal: false, missing: false, rotation: 20, tipping: 0, buccal_lingual: 0, vertical: 0, gap_mesial: 2 },
      54: { surfaces: { O: "caries" }, crown: false, root_canal: false, missing: false, rotation: 0, tipping: 0, buccal_lingual: 0, vertical: 0, gap_mesial: 0 },
    }));
    const { user } = renderUI(<><DentalWorkspace patientId="pat_1" /><Toaster /></>, { route: "/patients/pat_1" });
    await user.click(await screen.findByRole("button", { name: /Tooth chart/ }));
    await waitFor(() => expect(tooth("UR1")).toBeEnabled());
    const note = screen.getByRole("region", { name: "Recorded on the anatomical chart" });
    expect(note).toHaveTextContent("11 (UR1) Upper right central incisor: rotated 20° clockwise, 2mm gap on mesial side");
    expect(note).toHaveTextContent("54 Upper right primary first molar: caries (occlusal)");
  });

  test("REG-FE-CHART-038 a setting that cannot be read falls back to the simple chart the clinic had", async () => {
    withSettings(async (p) => { if (p === "/dental/settings") throw new Error("down"); return quietApiFetch(p); });
    api.dentalSummary.mockResolvedValue(summary({}));
    const { user } = renderUI(<><DentalWorkspace patientId="pat_1" /><Toaster /></>, { route: "/patients/pat_1" });
    await user.click(await screen.findByRole("button", { name: /Tooth chart/ }));
    await waitFor(() => expect(tooth("UR1")).toBeInTheDocument(), { timeout: 4000 });
    expect(screen.queryByRole("radio", { name: "Adult (32)" })).not.toBeInTheDocument();
  });
});
