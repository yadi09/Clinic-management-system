// The anatomical chart at work: marking each condition, every position slider, gaps,
// the Adult/Child switch, debounced saving of whole teeth, failure, undo/redo, the
// simple chart's marks, and read-only use.
import { useState } from "react";
import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, test, vi } from "vitest";

const api = vi.hoisted(() => ({ saveAnatomy: vi.fn() }));
vi.mock("@/features/dental/api", async (orig) => ({ ...(await orig<object>()), ...api }));
const tst = vi.hoisted(() => ({ error: vi.fn(), success: vi.fn() }));
vi.mock("@/components/ui/sonner", async (orig) => ({ ...(await orig<object>()), toast: Object.assign(vi.fn(), tst) }));

import { AnatomicalWorkspace } from "@/features/dental/anatomical/AnatomicalWorkspace";
import { EMPTY } from "@/features/dental/anatomical/geometry";
import type { ToothAnatomy } from "@/features/dental/api";
import { AppError } from "@/lib/api-client";
import { renderUI } from "@/test/render";

const T = (over: Partial<ToothAnatomy>): ToothAnatomy => ({ ...EMPTY, ...over });
const tooth = (n: number) => screen.getByRole("button", { name: new RegExp(`^Tooth ${n},`) });
const tool = (name: string) => within(screen.getByRole("toolbar", { name: "Chart tools" })).getByRole("button", { name: new RegExp(`^${name}$`) });
const surface = (name: string) => within(screen.getByRole("group", { name: "Tooth surfaces" })).getByRole("button", { name: new RegExp(`^${name}`) });
const slider = (label: string) => screen.getByLabelText(label) as HTMLInputElement;
const info = () => screen.getByTestId("tooth-info");
/** Every tooth record the server was sent, merged in order. */
const sent = () => Object.assign({}, ...api.saveAnatomy.mock.calls.map((c) => c[1])) as Record<string, ToothAnatomy | null>;

function open(server: Record<string, ToothAnatomy> = {}, editable = true, extra: Partial<Parameters<typeof AnatomicalWorkspace>[0]> = {}) {
  return renderUI(<AnatomicalWorkspace patientId="pat_1" server={server} editable={editable} {...extra} />);
}

beforeEach(() => {
  api.saveAnatomy.mockReset();
  // Like the real server: changes are merged into what it holds, and the reply is
  // the WHOLE merged chart (REG_DENTAL_ANAT_002/003).
  const held: Record<string, ToothAnatomy> = {};
  api.saveAnatomy.mockImplementation(async (_p: string, changes: Record<string, ToothAnatomy | null>) => {
    for (const [k, v] of Object.entries(changes)) { if (v) held[k] = v; else delete held[k]; }
    return { teeth: {}, anatomy: { ...held } };
  });
  tst.error.mockReset();
});

describe("REG-FE-ANAT workspace", () => {
  test("REG-FE-ANAT-040 caries and filling go on the surface clicked; a second click takes it off; the tooth is saved whole", async () => {
    const { user } = open();
    await user.click(tooth(16));
    await user.click(tool("Caries"));
    await user.click(surface("Occlusal"));
    await user.click(tool("Filling"));
    await user.click(surface("Mesial"));
    expect(info()).toHaveTextContent("Upper right first molar. caries (occlusal), filling (mesial)");
    // However the clicks fall against the save delay, what reaches the server is the
    // whole tooth, and only that tooth.
    await waitFor(() => expect(sent()).toEqual({ 16: { ...EMPTY, surfaces: { O: "caries", M: "filling" } } }), { timeout: 8000 });
    for (const [, changes] of api.saveAnatomy.mock.calls) expect(Object.keys(changes)).toEqual(["16"]);
    await user.click(surface("Mesial"));
    await waitFor(() => expect(sent()).toEqual({ 16: { ...EMPTY, surfaces: { O: "caries" } } }), { timeout: 8000 });
  });

  test("REG-FE-ANAT-041 mesial and distal swap sides with the quadrant on the surface diagram", async () => {
    const { user } = open();
    const x = (name: string) => Number(surface(name).getAttribute("points")!.split(" ")[0].split(",")[0]);
    await user.click(tooth(11));
    expect(x("Mesial")).toBe(120); // right of the diagram, towards the midline
    await user.click(tooth(21));
    expect(x("Mesial")).toBe(0);
  });

  test("REG-FE-ANAT-042 crown, root canal and missing toggle on the whole tooth; clear empties it", async () => {
    const { user } = open();
    await user.click(tooth(26));
    await user.click(tool("Crown"));
    await user.click(tool("Root canal"));
    expect(info()).toHaveTextContent("Upper left first molar. crown, root canal");
    await user.click(tooth(46));
    await user.click(tool("Missing"));
    expect(info()).toHaveTextContent("missing");
    await waitFor(() => expect(sent()).toMatchObject({ 26: { crown: true, root_canal: true }, 46: { missing: true } }), { timeout: 8000 });
    await user.click(tooth(26));
    await user.click(tool("Clear"));
    expect(info()).toHaveTextContent("Upper left first molar. Healthy");
    await waitFor(() => expect(sent()[26]).toBeNull(), { timeout: 8000 });
  });

  test("REG-FE-ANAT-043 marking a surface on a missing tooth brings it back", async () => {
    const { user } = open({ 36: T({ missing: true }) });
    await user.click(tooth(36));
    await user.click(tool("Caries"));
    await user.click(surface("Buccal"));
    expect(info()).toHaveTextContent("Lower left first molar. caries (buccal)");
    expect(info()).not.toHaveTextContent("missing");
  });

  test("REG-FE-ANAT-044 every position slider is saved once per drag, with its last value, and Reset puts the tooth back", async () => {
    const { user } = open();
    await user.click(tooth(12));
    for (const v of [5, 10, 15, 20, 35]) fireEvent.change(slider("Rotation"), { target: { value: String(v) } });
    fireEvent.change(slider("Tipping"), { target: { value: "-10" } });
    fireEvent.change(slider("Buccal/lingual"), { target: { value: "1.5" } });
    fireEvent.change(slider("Vertical"), { target: { value: "-2.5" } });
    fireEvent.change(slider("Gap (mesial)"), { target: { value: "2" } });
    expect(screen.getByTestId("out-rot")).toHaveTextContent("35° cw");
    expect(screen.getByTestId("out-tilt")).toHaveTextContent("10° dist");
    expect(screen.getByTestId("out-bl")).toHaveTextContent("1.5mm buc");
    expect(screen.getByTestId("out-vert")).toHaveTextContent("2.5mm down");
    expect(screen.getByTestId("out-gap")).toHaveTextContent("2mm");
    await waitFor(() => expect(api.saveAnatomy).toHaveBeenCalledTimes(1), { timeout: 8000 });
    expect(api.saveAnatomy).toHaveBeenCalledWith("pat_1", { 12: { ...EMPTY, rotation: 35, tipping: -10, buccal_lingual: 1.5, vertical: -2.5, gap_mesial: 2 } });
    // The gap shows on the chart with its size; the number turns orange.
    expect([...document.querySelectorAll("text")].some((t) => t.textContent === "2mm")).toBe(true);
    await user.click(screen.getByRole("button", { name: "Reset position" }));
    await waitFor(() => expect(api.saveAnatomy).toHaveBeenCalledTimes(2), { timeout: 8000 });
    expect(api.saveAnatomy.mock.calls[1][1]).toEqual({ 12: null });
  });

  test("REG-FE-ANAT-045 gaps on both sides of both arches", async () => {
    const { user } = open();
    for (const [n, g] of [[11, "2"], [25, "1"], [35, "3"], [45, "1.5"]] as const) {
      await user.click(tooth(n));
      fireEvent.change(slider("Gap (mesial)"), { target: { value: g } });
    }
    await waitFor(() => expect(sent()).toMatchObject({ 11: { gap_mesial: 2 }, 25: { gap_mesial: 1 }, 35: { gap_mesial: 3 }, 45: { gap_mesial: 1.5 } }), { timeout: 8000 });
    const pills = [...document.querySelectorAll("text")].map((t) => t.textContent).filter((t) => t?.endsWith("mm") && /^\d/.test(t));
    for (const p of ["2mm", "1mm", "3mm", "1.5mm"]) expect(pills).toContain(p);
  });

  test("REG-FE-ANAT-046 Adult and Child are separate charts, each remembering its selected tooth", async () => {
    const { user } = open({ 54: T({ surfaces: { O: "caries" } }) });
    await user.click(tooth(36));
    await user.click(screen.getByRole("radio", { name: "Child (20)" }));
    expect(screen.getAllByRole("button", { name: /^Tooth \d+/ })).toHaveLength(20);
    expect(screen.getByText("Tooth 54")).toBeInTheDocument();
    expect(info()).toHaveTextContent("Upper right primary first molar. caries (occlusal)");
    await user.click(tooth(75));
    await user.click(tool("Crown"));
    await waitFor(() => expect(sent()).toMatchObject({ 75: { crown: true } }), { timeout: 8000 });
    await user.click(screen.getByRole("radio", { name: "Adult (32)" }));
    expect(screen.getByText("Tooth 36")).toBeInTheDocument();
  });

  test("REG-FE-ANAT-047 a refused save puts the tooth back and says so; a save with no answer says it is not confirmed", async () => {
    api.saveAnatomy.mockRejectedValueOnce(new AppError(500, "INTERNAL", "Something went wrong"));
    const { user } = open({ 21: T({ rotation: 10 }) });
    await user.click(tooth(21));
    await user.click(tool("Crown"));
    await waitFor(() => expect(screen.getByText("Not saved — changes undone")).toBeInTheDocument(), { timeout: 8000 });
    expect(info()).toHaveTextContent("Upper left central incisor. rotated 10° clockwise");
    expect(tst.error).toHaveBeenCalledWith("Something went wrong");

    api.saveAnatomy.mockRejectedValueOnce(new AppError(0, "TIMEOUT", "The server did not answer in time. Your change may not have been saved — check before doing it again."));
    await user.click(tool("Missing"));
    await waitFor(() => expect(screen.getByText("Not confirmed — reload to check what was saved")).toBeInTheDocument(), { timeout: 8000 });
  });

  test("REG-FE-ANAT-048 undo and redo walk back and forward through changes, and are saved like edits", async () => {
    const { user } = open();
    await user.click(tooth(14));
    await user.click(tool("Crown"));
    await user.click(tool("Root canal"));
    expect(info()).toHaveTextContent("crown, root canal");
    await user.click(screen.getByRole("button", { name: "Undo" }));
    expect(info()).toHaveTextContent("Upper right first premolar. crown");
    expect(info()).not.toHaveTextContent("root canal");
    await user.click(screen.getByRole("button", { name: "Undo" }));
    expect(info()).toHaveTextContent("Upper right first premolar. Healthy");
    expect(screen.getByRole("button", { name: "Undo" })).toBeDisabled();
    await user.click(screen.getByRole("button", { name: "Redo" }));
    expect(info()).toHaveTextContent("crown");
    await waitFor(() => expect(sent()[14]).toEqual({ ...EMPTY, crown: true }), { timeout: 8000 });
    await waitFor(() => expect(screen.getByText("✓ Saved")).toBeInTheDocument(), { timeout: 8000 });
  });

  test("REG-FE-ANAT-049 a whole slider drag is one undo step", async () => {
    const { user } = open();
    await user.click(tooth(33));
    for (const v of [5, 10, 15]) fireEvent.change(slider("Rotation"), { target: { value: String(v) } });
    await user.click(screen.getByRole("button", { name: "Undo" }));
    expect(screen.getByTestId("out-rot")).toHaveTextContent("0°");
  });

  test("REG-FE-ANAT-050 the server's copy arrives (another clinician's work) when nothing of ours is waiting", async () => {
    function Harness() {
      const [server, setServer] = useState<Record<string, ToothAnatomy>>({});
      return (<>
        <button type="button" onClick={() => setServer({ 11: T({ missing: true }) })}>server sends</button>
        <AnatomicalWorkspace patientId="pat_1" server={server} editable />
      </>);
    }
    const { user } = renderUI(<Harness />);
    expect(info()).toHaveTextContent("Upper right central incisor. Healthy");
    await user.click(screen.getByRole("button", { name: "server sends" }));
    expect(info()).toHaveTextContent("Upper right central incisor. missing");
  });

  test("REG-FE-ANAT-051 the simple chart's mark is shown on the tooth and can be removed", async () => {
    const onClearMark = vi.fn();
    const marks = (p: string) => (p === "UR1" ? { code: "decayed", label: "Decayed", color: "#c0392b" } : null);
    const { user } = open({}, true, { marks, onClearMark });
    expect(screen.getByText(/Marked on the simple chart/)).toHaveTextContent("Marked on the simple chart: Decayed");
    await user.click(screen.getByRole("button", { name: "Remove mark" }));
    expect(onClearMark).toHaveBeenCalledWith("UR1");
  });

  test("REG-FE-ANAT-052 read-only: the findings and positions are shown, nothing can be changed", async () => {
    const { user } = open({ 11: T({ surfaces: { O: "filling" }, gap_mesial: 2 }) }, false, {
      marks: () => ({ code: "decayed", label: "Decayed", color: "#c0392b" }), onClearMark: vi.fn(),
    });
    expect(screen.queryByRole("toolbar")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Undo" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Reset position" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Remove mark" })).not.toBeInTheDocument();
    expect(slider("Gap (mesial)")).toBeDisabled();
    expect(info()).toHaveTextContent("filling (occlusal), 2mm gap on mesial side");
    await user.click(tooth(21));
    expect(screen.getByText("Tooth 21")).toBeInTheDocument();
    await act(async () => { await new Promise((r) => setTimeout(r, 700)); });
    expect(api.saveAnatomy).not.toHaveBeenCalled();
  });

  test("REG-FE-ANAT-053 a change still waiting when the chart closes is sent anyway", async () => {
    const { user, unmount } = open();
    await user.click(tooth(17));
    await user.click(tool("Missing"));
    unmount();
    expect(api.saveAnatomy).toHaveBeenCalledWith("pat_1", { 17: { ...EMPTY, missing: true } }, { keepalive: true });
  });
});
