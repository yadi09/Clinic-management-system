// The anatomical chart (version 2) at work: the panel's tools on the selected tooth,
// refusals said in words, what is sent to the server (each changed tooth's full list
// of items; positions apart and debounced), the server refusing and the chart going
// back, undo/redo, bridges, Adult/Child, notes, the simple chart's marks, read-only
// use, full screen, and nothing lost when the chart closes mid-save.
import { useState } from "react";
import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, test, vi } from "vitest";

const api = vi.hoisted(() => ({ saveChartItems: vi.fn(), savePositions: vi.fn() }));
vi.mock("@/features/dental/api", async (orig) => ({ ...(await orig<object>()), ...api }));
const tst = vi.hoisted(() => ({ error: vi.fn(), success: vi.fn() }));
vi.mock("@/components/ui/sonner", async (orig) => ({ ...(await orig<object>()), toast: Object.assign(vi.fn(), tst) }));

// The 3D view stands in for itself here (WebGL is not available to unit tests): it
// shows what it was given and offers a tap; REG-E2E-029 drives the real one.
const three = vi.hoisted(() => ({ fail: false }));
vi.mock("@/features/dental/anatomical/three/Dental3D", () => ({
  default: (p: { sel: number; xray: boolean; nums: boolean; view: string; mode: string; onSelect: (n: number) => void; onCustomView: () => void }) => {
    if (three.fail) throw new Error("Failed to fetch dynamically imported module");
    return (
      <div data-testid="fake3d" data-sel={p.sel} data-xray={String(p.xray)} data-nums={String(p.nums)} data-view={p.view} data-mode={p.mode}>
        <button type="button" onClick={() => p.onSelect(36)}>tap 36 in 3D</button>
        <button type="button" onClick={p.onCustomView}>drag</button>
      </div>
    );
  },
}));

import { AnatomicalWorkspace } from "@/features/dental/anatomical/AnatomicalWorkspace";
import type { Chart, ChartItem, ItemInput, Position } from "@/features/dental/api";
import { AppError } from "@/lib/api-client";
import { renderUI } from "@/test/render";

const TODAY = "2026-10-14";
const tooth = (n: number) => screen.getAllByRole("button", { name: new RegExp(`^Tooth ${n},`) })[0];
const add = (name: string) => within(screen.getAllByRole("toolbar", { name: "Add" })[0]).getByRole("button", { name: new RegExp(`^${name}$`) });
const as = (name: string) => within(screen.getAllByRole("radiogroup", { name: "Record as" })[0]).getByRole("radio", { name });
const mat = (name: RegExp) => within(screen.getAllByRole("radiogroup", { name: "Material" })[0]).getByRole("radio", { name });
const surf = (name: string) => within(screen.getAllByRole("group", { name: "Surface" })[0]).getByRole("button", { name: new RegExp(`^${name}`) });
const info = () => screen.getAllByTestId("tooth-info")[0];
const said = () => document.querySelector(".tooth-anatomy p[aria-live]")!;
const slider = (label: string) => screen.getAllByLabelText(label)[0] as HTMLInputElement;

/** Like the real server: merges each tooth's list and answers with the whole chart. */
let held: ChartItem[] = [];
let heldPos: Record<string, Position> = {};
const chart = (): Chart => ({ teeth: {}, items: held, positions: heldPos });
/** Every tooth list the server was sent, merged in order. */
const sentTeeth = () => Object.assign({}, ...api.saveChartItems.mock.calls.map((c) => c[1])) as Record<string, ItemInput[]>;

function open(server: Chart = { teeth: {}, items: [], positions: {} }, editable = true, extra: Partial<Parameters<typeof AnatomicalWorkspace>[0]> = {}) {
  // The fake server holds what the patient already has, as the real one does.
  held = [...(server.items ?? [])];
  heldPos = { ...(server.positions ?? {}) };
  return renderUI(<AnatomicalWorkspace patientId="pat_1" server={server} editable={editable} today={TODAY} {...extra} />);
}

beforeEach(() => {
  held = []; heldPos = {};
  api.saveChartItems.mockReset(); api.savePositions.mockReset(); tst.error.mockReset();
  api.saveChartItems.mockImplementation(async (_p: string, teeth: Record<string, ItemInput[]>) => {
    for (const [k, list] of Object.entries(teeth)) {
      held = held.filter((i) => i.tooth !== Number(k));
      list.forEach((x, j) => held.push({ id: `dci_${k}_${j}`, tooth: Number(k), ...x, ...(x.status === "done" ? { done_on: TODAY } : {}) } as ChartItem));
    }
    return chart();
  });
  api.savePositions.mockImplementation(async (_p: string, changes: Record<string, Position | null>) => {
    for (const [k, v] of Object.entries(changes)) { if (v) heldPos[k] = v; else delete heldPos[k]; }
    return chart();
  });
});

describe("REG-FE-ANAT2 workspace", () => {
  test("REG-FE-ANAT2-020 a filling planned on a surface is sent as the tooth's whole list, and listed in the plan", async () => {
    const { user } = open();
    await user.click(tooth(16));
    expect(screen.getAllByText("Tooth 16: Upper right first molar")[0]).toBeInTheDocument();
    await user.click(as("To be done"));
    expect(screen.getAllByText(/To be done: treatment the dentist recommends/)[0]).toBeInTheDocument();
    await user.click(add("Filling"));
    expect(screen.getAllByText(/Filling: decay removed and the hole filled/)[0]).toBeInTheDocument();
    await user.click(mat(/^Amalgam/));
    await user.click(surf("Top"));
    expect(said()).toHaveTextContent("Amalgam filling (to be done) on the top of 16.");
    expect(info()).toHaveTextContent("Amalgam filling, top (to be done)");
    await waitFor(() => expect(sentTeeth()[16]).toEqual([{ kind: "filling", surface: "O", material: "amalgam", status: "planned" }]), { timeout: 8000 });
    expect(within(screen.getAllByRole("region", { name: "Treatment plan" })[0]).getByText("16 · amalgam filling, top")).toBeInTheDocument();
    // Mark it done: the same item, now done today.
    await user.click(screen.getAllByRole("button", { name: "Mark this tooth's planned work as done" })[0]);
    expect(said()).toHaveTextContent("Planned work on 16 marked as done.");
    await waitFor(() => expect(sentTeeth()[16]).toEqual([{ kind: "filling", surface: "O", material: "amalgam", status: "done" }]), { timeout: 8000 });
    expect(within(screen.getAllByRole("region", { name: "Done today" })[0]).getByText("16 · amalgam filling, top")).toBeInTheDocument();
  });

  test("REG-FE-ANAT2-021 a refused action is said in words and nothing is sent", async () => {
    const { user } = open();
    await user.click(tooth(45));
    await user.click(add("Implant"));
    expect(said()).toHaveTextContent("An implant replaces a missing tooth. Mark this tooth as Missing first (or extract it).");
    expect(said()).toHaveStyle({ color: "var(--text-danger)" });
    await act(async () => { await new Promise((r) => setTimeout(r, 600)); });
    expect(api.saveChartItems).not.toHaveBeenCalled();
  });

  test("REG-FE-ANAT2-022 a bridge: start, tap the other end, sent on its first tooth; the bar is drawn", async () => {
    const missing = (n: number): ChartItem => ({ id: `m${n}`, tooth: n, kind: "missing", status: "existing" });
    const { user } = open({ teeth: {}, items: [missing(14), missing(15)], positions: {} });
    await user.click(tooth(13));
    await user.click(add("Bridge"));
    expect(said()).toHaveTextContent("Bridge starts at 13. Now tap the natural tooth on the other side of the gap.");
    await user.click(mat(/^Gold/));
    await user.click(tooth(16));
    expect(said()).toHaveTextContent("Bridge 16–13 added.");
    expect(document.querySelector("[data-bridge='16-13']")).not.toBeNull();
    await waitFor(() => expect(sentTeeth()[13]).toEqual([{ kind: "bridge", bridge_end: 16, material: "gold", status: "existing" }]), { timeout: 8000 });
    // A refused second end is said; the bridge start is dropped.
    await user.click(tooth(23));
    await user.click(add("Bridge"));
    await user.click(tooth(23));
    expect(said()).toHaveTextContent("Pick a different tooth for the other end of the bridge.");
  });

  test("REG-FE-ANAT2-023 every slider is saved once per drag, apart from the items; Reset clears the tooth's position", async () => {
    const { user } = open();
    await user.click(tooth(12));
    for (const v of [5, 15, 35]) fireEvent.change(slider("Rotation"), { target: { value: String(v) } });
    fireEvent.change(slider("Tipping"), { target: { value: "-10" } });
    fireEvent.change(slider("Buccal/lingual"), { target: { value: "1.5" } });
    fireEvent.change(slider("Vertical"), { target: { value: "-2.5" } });
    fireEvent.change(slider("Gap (mesial)"), { target: { value: "2" } });
    expect(screen.getAllByTestId("out-rot")[0]).toHaveTextContent("35° cw");
    await waitFor(() => expect(api.savePositions).toHaveBeenCalledTimes(1), { timeout: 8000 });
    expect(api.savePositions).toHaveBeenCalledWith("pat_1", { 12: { rotation: 35, tipping: -10, buccal_lingual: 1.5, vertical: -2.5, gap_mesial: 2 } });
    expect(api.saveChartItems).not.toHaveBeenCalled();
    expect(info()).toHaveTextContent("Rotated 35° clockwise · Tipped 10° distally · 1.5mm buccal · 2.5mm intruded · 2mm gap on mesial side");
    await user.click(screen.getAllByRole("button", { name: "Reset position" })[0]);
    await waitFor(() => expect(api.savePositions).toHaveBeenLastCalledWith("pat_1", { 12: null }), { timeout: 8000 });
  });

  test("REG-FE-ANAT2-024 the server refusing puts the chart back and says the server's reason where the chart speaks", async () => {
    api.saveChartItems.mockRejectedValueOnce(new AppError(400, "VALIDATION", "Tooth 26 is covered by a crown, so its surfaces cannot be marked."));
    const { user } = open();
    await user.click(tooth(26));
    await user.click(add("Root canal"));
    expect(info()).toHaveTextContent("Root canal (already in mouth)");
    await waitFor(() => expect(said()).toHaveTextContent("Tooth 26 is covered by a crown, so its surfaces cannot be marked."), { timeout: 8000 });
    expect(info()).toHaveTextContent("Healthy");
    expect(screen.getAllByText("Not saved — changes undone")[0]).toBeInTheDocument();
    expect(tst.error).not.toHaveBeenCalled();
  });

  test("REG-FE-ANAT2-025 no answer: not confirmed, with the may-not-have-been-saved message", async () => {
    api.saveChartItems.mockRejectedValueOnce(new AppError(0, "TIMEOUT", "The server did not answer in time. Your change may not have been saved — check before doing it again."));
    const { user } = open();
    await user.click(tooth(26));
    await user.click(add("Root canal"));
    await waitFor(() => expect(screen.getAllByText("Not confirmed — reload to check what was saved")[0]).toBeInTheDocument(), { timeout: 8000 });
    expect(tst.error).toHaveBeenCalledWith(expect.stringContaining("may not have been saved"));
  });

  test("REG-FE-ANAT2-026 undo and redo walk the changes back and forth and are saved like edits", async () => {
    const { user } = open();
    await user.click(tooth(14));
    await user.click(add("Crown"));
    await user.click(add("Root canal"));
    expect(info()).toHaveTextContent("Zirconia crown (already in mouth) · Root canal (already in mouth)");
    await user.click(screen.getAllByRole("button", { name: "Undo" })[0]);
    expect(info()).toHaveTextContent("Zirconia crown (already in mouth)");
    expect(info()).not.toHaveTextContent("Root canal");
    await user.click(screen.getAllByRole("button", { name: "Undo" })[0]);
    expect(info()).toHaveTextContent("Healthy");
    await user.click(screen.getAllByRole("button", { name: "Redo" })[0]);
    await waitFor(() => expect(sentTeeth()[14]).toEqual([{ kind: "crown", material: "zirconia", status: "existing" }]), { timeout: 8000 });
    await waitFor(() => expect(screen.getAllByText("✓ Saved")[0]).toBeInTheDocument(), { timeout: 8000 });
  });

  test("REG-FE-ANAT2-027 Adult and Child are separate; on the child chart the tools a child cannot have are refused", async () => {
    const { user } = open();
    await user.click(screen.getAllByRole("radio", { name: "Child (20)" })[0]);
    expect(screen.getAllByRole("button", { name: /^Tooth \d+,/ })).toHaveLength(20);
    expect(screen.getAllByText("Tooth 54: Upper right primary first molar")[0]).toBeInTheDocument();
    await user.click(add("Bridge"));
    expect(said()).toHaveTextContent("Bridges are not used for baby teeth.");
    await user.click(screen.getAllByRole("radio", { name: "Adult (32)" })[0]);
    expect(screen.getAllByRole("button", { name: /^Tooth \d+,/ })).toHaveLength(32);
  });

  test("REG-FE-ANAT2-028 a migrated note is shown with a warning and 'It is right' clears it on the server", async () => {
    const { user } = open({ teeth: {}, items: [{ id: "x", tooth: 26, kind: "crown", material: "zirconia", status: "existing", note: "Migrated from the first anatomical chart: material not recorded." }], positions: {} });
    await user.click(tooth(26));
    expect(screen.getAllByRole("note")[0]).toHaveTextContent("⚠ Migrated from the first anatomical chart: material not recorded.");
    await user.click(screen.getAllByRole("button", { name: "It is right" })[0]);
    await waitFor(() => expect(sentTeeth()[26]).toEqual([{ kind: "crown", material: "zirconia", status: "existing", note: "" }]), { timeout: 8000 });
    expect(screen.queryByRole("note")).not.toBeInTheDocument();
  });

  test("REG-FE-ANAT2-029 the simple chart's mark is shown on the tooth and can be removed", async () => {
    const onClearMark = vi.fn();
    const marks = (p: string) => (p === "UR1" ? { code: "decayed", label: "Decayed", color: "#c0392b" } : null);
    const { user } = open(undefined, true, { marks, onClearMark });
    expect(screen.getAllByText(/Marked on the simple chart/)[0]).toHaveTextContent("Marked on the simple chart: Decayed");
    await user.click(screen.getAllByRole("button", { name: "Remove mark" })[0]);
    expect(onClearMark).toHaveBeenCalledWith("UR1");
  });

  test("REG-FE-ANAT2-030 read-only: what is recorded is shown, nothing can be changed", async () => {
    const { user } = open({ teeth: {}, items: [{ id: "a", tooth: 11, kind: "filling", surface: "O", material: "composite", status: "existing" }], positions: { 11: { rotation: 0, tipping: 0, buccal_lingual: 0, vertical: 0, gap_mesial: 2 } } }, false);
    expect(screen.queryByRole("toolbar", { name: "Add" })).not.toBeInTheDocument();
    expect(screen.queryByRole("radiogroup", { name: "Record as" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Undo" })).not.toBeInTheDocument();
    expect(slider("Gap (mesial)")).toBeDisabled();
    expect(info()).toHaveTextContent("Composite filling, top (already in mouth) · 2mm gap on mesial side");
    await user.click(tooth(21));
    expect(screen.getAllByText("Tooth 21: Upper left central incisor")[0]).toBeInTheDocument();
  });

  test("REG-FE-ANAT2-031 full screen is the same chart; on a phone a tooth tap opens it", async () => {
    const { user } = open();
    await user.click(screen.getByRole("button", { name: "Full screen" }));
    const dlg = await screen.findByRole("dialog", { name: "Tooth chart" });
    await user.click(within(dlg).getByRole("button", { name: /^Tooth 26,/ }));
    await user.click(within(dlg).getByRole("button", { name: /^Crown$/ }));
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(info()).toHaveTextContent("Zirconia crown (already in mouth)");
    const mm = vi.spyOn(window, "matchMedia").mockImplementation((q: string) => ({
      matches: q.includes("max-width: 767px"), media: q, onchange: null, addListener: vi.fn(), removeListener: vi.fn(),
      addEventListener: vi.fn(), removeEventListener: vi.fn(), dispatchEvent: vi.fn(),
    }) as unknown as MediaQueryList);
    await user.click(tooth(36));
    expect(await screen.findByRole("dialog", { name: "Tooth chart" })).toBeInTheDocument();
    mm.mockRestore();
  });

  test("REG-FE-ANAT2-032 a change still waiting when the chart closes is sent anyway", async () => {
    const { user, unmount } = open();
    await user.click(tooth(17));
    await user.click(add("Missing"));
    unmount();
    expect(api.saveChartItems).toHaveBeenCalledWith("pat_1", { 17: [{ kind: "missing", status: "existing" }] }, { keepalive: true });
  });

  test("REG-FE-ANAT2-033 another clinician's work arrives when nothing of ours is waiting", async () => {
    function Harness() {
      const [server, setServer] = useState<Chart>({ teeth: {}, items: [], positions: {} });
      return (<>
        <button type="button" onClick={() => setServer({ teeth: {}, items: [{ id: "z", tooth: 11, kind: "missing", status: "existing" }], positions: {} })}>server sends</button>
        <AnatomicalWorkspace patientId="pat_1" server={server} editable today={TODAY} />
      </>);
    }
    const { user } = renderUI(<Harness />);
    expect(info()).toHaveTextContent("Healthy");
    await user.click(screen.getByRole("button", { name: "server sends" }));
    expect(info()).toHaveTextContent("Missing (already in mouth)");
  });

  test("REG-FE-ANAT2-034 work done on an earlier day reads as done on that day, not as done today", () => {
    open({ teeth: {}, items: [{ id: "a", tooth: 11, kind: "root_canal", status: "done", done_on: "2026-10-01" }], positions: {} });
    expect(info()).toHaveTextContent(/Root canal \(done (\d+ Oct|Oct \d+)\)/);
    expect(within(screen.getAllByRole("region", { name: "Done today" })[0]).getByText("Nothing yet")).toBeInTheDocument();
  });

  test("REG-FE-ANAT2-035 the 3D model: opened on demand, the presets, Show roots and Numbers, a tap selects, back to 2D keeps everything", async () => {
    const { user } = open();
    expect(screen.queryByTestId("fake3d")).not.toBeInTheDocument();
    await user.click(screen.getAllByRole("radio", { name: "3D model" })[0]);
    const v = await screen.findByTestId("fake3d");
    expect(v).toHaveAttribute("data-view", "front");
    expect(screen.getAllByText(/Drag to rotate · Right-drag or Shift-drag \(two fingers on a tablet\) to move/)[0]).toBeInTheDocument();
    const bar = within(screen.getAllByRole("toolbar", { name: "3D view" })[0]);
    for (const [name, view] of [["Open mouth", "open"], ["Upper jaw", "upper"], ["Lower jaw", "lower"], ["Side", "side"], ["Front", "front"]] as const) {
      await user.click(bar.getByRole("button", { name }));
      expect(screen.getByTestId("fake3d")).toHaveAttribute("data-view", view);
    }
    await user.click(bar.getByRole("button", { name: "Show roots" }));
    expect(screen.getByTestId("fake3d")).toHaveAttribute("data-xray", "true");
    await user.click(bar.getByRole("button", { name: "Numbers" }));
    expect(screen.getByTestId("fake3d")).toHaveAttribute("data-nums", "false");
    const recentre = bar.getByRole("button", { name: "Re-centre" });
    expect(recentre).toBeDisabled(); // nothing to undo while on a preset
    await user.click(screen.getByRole("button", { name: "drag" }));
    expect(screen.getByTestId("fake3d")).toHaveAttribute("data-view", "custom");
    expect(recentre).toBeEnabled();
    await user.click(recentre);
    expect(screen.getByTestId("fake3d")).toHaveAttribute("data-view", "front"); // back to the last preset
    await user.click(screen.getByRole("button", { name: "drag" }));
    await user.click(screen.getByRole("button", { name: "tap 36 in 3D" }));
    expect(screen.getAllByText("Tooth 36: Lower left first molar")[0]).toBeInTheDocument();
    await user.click(add("Missing"));
    await user.click(screen.getAllByRole("radio", { name: "2D chart" })[0]);
    expect(screen.queryByTestId("fake3d")).not.toBeInTheDocument();
    expect(info()).toHaveTextContent("Missing (already in mouth)");
  });

  test("REG-FE-ANAT2-036 in 3D a root canal turns the roots view on so it can be seen; an implant says how to see its screw", async () => {
    const missing36: ChartItem = { id: "m", tooth: 36, kind: "missing", status: "existing" };
    const { user } = open({ teeth: {}, items: [missing36], positions: {} });
    await user.click(screen.getAllByRole("radio", { name: "3D model" })[0]);
    await screen.findByTestId("fake3d");
    await user.click(add("Root canal"));
    expect(said()).toHaveTextContent("Roots view turned on so you can see the root canal.");
    expect(screen.getByTestId("fake3d")).toHaveAttribute("data-xray", "true");
    await user.click(within(screen.getAllByRole("toolbar", { name: "3D view" })[0]).getByRole("button", { name: "Show roots" }));
    await user.click(screen.getByRole("button", { name: "tap 36 in 3D" }));
    await user.click(add("Implant"));
    expect(said()).toHaveTextContent("Implant added. Turn on Show roots to see the screw in the bone.");
  });

  test("REG-FE-ANAT2-037 if the 3D model cannot be loaded, the page says so and the 2D chart is still there", async () => {
    three.fail = true;
    vi.spyOn(console, "error").mockImplementation(() => {});
    const { user } = open();
    await user.click(screen.getAllByRole("radio", { name: "3D model" })[0]);
    expect(await screen.findByRole("alert")).toHaveTextContent("The 3D model could not be loaded. Check the internet connection, or use the 2D chart");
    await user.click(screen.getAllByRole("radio", { name: "2D chart" })[0]);
    expect(screen.getAllByRole("group", { name: "Adult tooth chart" })[0]).toBeInTheDocument();
    three.fail = false;
  });

  test("REG-FE-ANAT2-038 braces from the panel: first tooth, Braces, material, last tooth; Whole arch; tapping Braces again removes them", async () => {
    const { user } = open();
    await user.click(tooth(15));
    await user.click(as("To be done"));
    await user.click(add("Braces"));
    expect(screen.getAllByText(/Braces: brackets glued to the teeth and joined by a wire/)[0]).toBeInTheDocument();
    expect(said()).toHaveTextContent("Braces start at 15. Now tap the last tooth of the braces, or tap Whole arch.");
    await user.click(mat(/^Ceramic/));
    await user.click(tooth(25));
    expect(said()).toHaveTextContent("Ceramic braces 15–25 added.");
    expect(document.querySelector("[data-braces='15-25']")).not.toBeNull();
    expect(document.querySelectorAll("rect[data-bracket]").length).toBeGreaterThanOrEqual(10);
    await waitFor(() => expect(sentTeeth()[15]).toEqual([{ kind: "braces", bridge_end: 25, material: "ceramic", status: "planned" }]), { timeout: 8000 });
    expect(within(screen.getAllByRole("region", { name: "Treatment plan" })[0]).getByText("15 · ceramic braces 15–25")).toBeInTheDocument();
    // Tapping Braces on a braced tooth takes them off.
    await user.click(tooth(21));
    await user.click(add("Braces"));
    expect(said()).toHaveTextContent("Ceramic braces 15–25 removed.");
    await waitFor(() => expect(sentTeeth()[15]).toEqual([]), { timeout: 8000 });
    // Whole arch, on the lower jaw.
    await user.click(tooth(36));
    await user.click(add("Braces"));
    await user.click(screen.getAllByRole("button", { name: "Whole arch" })[0]);
    expect(said()).toHaveTextContent("Ceramic braces 47–37 added.");
    await waitFor(() => expect(sentTeeth()[47]).toEqual([{ kind: "braces", bridge_end: 37, material: "ceramic", status: "planned" }]), { timeout: 8000 });
  });

  test("REG-FE-ANAT2-039 a refused braces end is said, and the next tap is an ordinary selection", async () => {
    const { user } = open();
    await user.click(tooth(16));
    await user.click(add("Braces"));
    await user.click(tooth(46));
    expect(said()).toHaveTextContent("Braces stay on one jaw. Pick the last tooth in the same jaw.");
    await user.click(tooth(26));
    expect(screen.getAllByText("Tooth 26: Upper left first molar")[0]).toBeInTheDocument();
    expect(api.saveChartItems).not.toHaveBeenCalled();
  });
});

