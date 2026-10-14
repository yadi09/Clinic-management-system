// The 3D model's pieces that do not need a graphics card: the tooth sizes and shapes
// (teeth.ts, the reference's WID/TORQ/TIP/OB and geometry), and the React view that
// starts, rebuilds and frees the scene (Dental3D.tsx) — and says so plainly when a
// device cannot draw 3D. The scene itself is exercised in a real browser (REG-E2E-029).
import { render, screen } from "@testing-library/react";
import { afterEach, describe, expect, test, vi } from "vitest";

const scene = vi.hoisted(() => ({ build: vi.fn(), setView: vi.fn(), dispose: vi.fn(), create: vi.fn() }));
vi.mock("@/features/dental/anatomical/three/scene", () => ({
  createScene: (...a: unknown[]) => { scene.create(...a); return { build: scene.build, setView: scene.setView, dispose: scene.dispose }; },
}));

import { crownGeo, dims, implantGeos, rootSpecs, sm } from "@/features/dental/anatomical/three/teeth";
import Dental3D from "@/features/dental/anatomical/three/Dental3D";
import { fromItems } from "@/features/dental/anatomical/model";

afterEach(() => { vi.restoreAllMocks(); Object.values(scene).forEach((f) => f.mockReset()); });

describe("REG-FE-ANAT3 the 3D teeth", () => {
  test("REG-FE-ANAT3-001 real tooth sizes: widths, heights and roots by type; child teeth smaller", () => {
    expect(dims(11)).toMatchObject({ w: 8.5, t: "inc", u: true, c: false, torq: 16, tip: 5, ob: -2 });
    expect(dims(16)).toMatchObject({ w: 10.2, t: "mol", torq: -6, tip: 4, ob: 0 });
    expect(dims(36)).toMatchObject({ w: 11, t: "mol", u: false, torq: -12 });
    expect(dims(13).ob).toBe(-1.1);
    expect(dims(43).ob).toBe(0); // overbite is the upper front teeth's
    const c = dims(54), a = dims(14);
    expect(c).toMatchObject({ c: true, t: "mol", w: 7.3 });
    expect(c.h).toBeLessThan(dims(16).h);
    expect(c.torq).toBe(-6 * 0.5); // a primary first molar follows the permanent molar's angles, halved
    expect(a.t).toBe("pre");
    expect(dims(51).ob).toBe(-1); // halved for a child
  });

  test("REG-FE-ANAT3-002 a crown is built for every tooth type with its shading", () => {
    for (const n of [11, 13, 14, 16, 31, 33, 45, 47, 51, 53, 55, 75]) {
      const g = crownGeo(dims(n));
      expect(g.attributes.position.count, String(n)).toBeGreaterThan(1000);
      expect(g.attributes.color.count, String(n)).toBe(g.attributes.position.count);
      g.computeBoundingBox();
      const size = g.boundingBox!.max.x - g.boundingBox!.min.x;
      expect(size, String(n)).toBeCloseTo(dims(n).w, 0);
      g.dispose();
    }
  });

  test("REG-FE-ANAT3-003 roots: one for front teeth, two for the upper first premolar and lower molars, three for upper molars", () => {
    expect(rootSpecs(dims(11))).toHaveLength(1);
    expect(rootSpecs(dims(13))).toHaveLength(1);
    expect(rootSpecs(dims(14))).toHaveLength(2);
    expect(rootSpecs(dims(15))).toHaveLength(1);
    expect(rootSpecs(dims(16))).toHaveLength(3);
    expect(rootSpecs(dims(36))).toHaveLength(2);
    expect(rootSpecs(dims(55))).toHaveLength(3);
    expect(rootSpecs(dims(85))).toHaveLength(2);
    for (const r of rootSpecs(dims(16))) expect(r.cn.attributes.position.count).toBeGreaterThan(0);
  });

  test("REG-FE-ANAT3-004 an implant: the screw, seven threads and the abutment", () => {
    expect(implantGeos(dims(46))).toHaveLength(9);
  });

  test("REG-FE-ANAT3-005 the smoothstep the shapes are built with", () => {
    expect(sm(0, 1, -1)).toBe(0);
    expect(sm(0, 1, 2)).toBe(1);
    expect(sm(0, 1, 0.5)).toBe(0.5);
  });
});

const props = {
  state: fromItems([]), positions: {}, sel: 11, today: "2026-10-15", mode: "adult" as const, xray: false, nums: true, view: "front" as const,
  onSelect: vi.fn(), onCustomView: vi.fn(), height: "400px",
};
const withWebGL = () => {
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation((() => ({})) as never);
  Object.defineProperty(window, "WebGLRenderingContext", { value: function WebGLRenderingContext() {}, configurable: true });
};

describe("REG-FE-ANAT3 the 3D view", () => {
  test("REG-FE-ANAT3-010 a device that cannot draw 3D is told so, and the 2D chart is named as the way", () => {
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation((() => null) as never);
    render(<Dental3D {...props} />);
    expect(screen.getByRole("alert")).toHaveTextContent("This device cannot show 3D. The 2D chart has everything.");
    expect(scene.create).not.toHaveBeenCalled();
  });

  test("REG-FE-ANAT3-011 the scene starts once, is rebuilt when the chart changes, follows the camera preset, and is freed when the view closes", () => {
    withWebGL();
    const { rerender, unmount } = render(<Dental3D {...props} />);
    expect(scene.create).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId("stage3d")).toBeInTheDocument();
    expect(scene.build).toHaveBeenLastCalledWith(expect.objectContaining({ sel: 11, xray: false, nums: true, mode: "adult" }));
    expect(scene.setView).toHaveBeenLastCalledWith("front");
    rerender(<Dental3D {...props} sel={26} xray view="upper" />);
    expect(scene.build).toHaveBeenLastCalledWith(expect.objectContaining({ sel: 26, xray: true }));
    expect(scene.setView).toHaveBeenLastCalledWith("upper");
    expect(scene.create).toHaveBeenCalledTimes(1);
    // A tap in the scene reaches the newest handler.
    const onSelect = vi.fn();
    rerender(<Dental3D {...props} onSelect={onSelect} />);
    (scene.create.mock.calls[0][2] as (n: number) => void)(46);
    expect(onSelect).toHaveBeenCalledWith(46);
    (scene.create.mock.calls[0][3] as () => void)();
    expect(props.onCustomView).toHaveBeenCalled();
    unmount();
    expect(scene.dispose).toHaveBeenCalledTimes(1);
  });

  test("REG-FE-ANAT3-012 a scene that fails to start says so instead of breaking the page", () => {
    withWebGL();
    scene.create.mockImplementation(() => { throw new Error("context lost"); });
    render(<Dental3D {...props} />);
    expect(screen.getByRole("alert")).toHaveTextContent("The 3D view could not start on this device.");
  });
});
