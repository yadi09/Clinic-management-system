// A finger dragging the 3D model must turn it and never scroll the page behind it. The CSS
// `touch-action: none` asks for that, but not every phone browser honours it for a drag that
// starts on a canvas, so the model also claims the touch itself.
import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, test, vi } from "vitest";

vi.mock("@/features/dental/anatomical/three/scene", () => ({
  createScene: () => ({ build: vi.fn(), setView: vi.fn(), recenter: vi.fn(), dispose: vi.fn() }),
}));

import Dental3D from "@/features/dental/anatomical/three/Dental3D";
import { EMPTY_STATE } from "@/features/dental/anatomical/model";

beforeEach(() => {
  // jsdom has no WebGL: say there is some, so the stage is drawn.
  (window as unknown as { WebGLRenderingContext: unknown }).WebGLRenderingContext = function () { /* stub */ };
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({} as unknown as RenderingContext);
});

describe("REG-FE-3D-TOUCH the model owns the finger", () => {
  const show = () => render(<Dental3D state={EMPTY_STATE} positions={{}} sel={0} today="2026-10-18" mode="adult" xray={false} nums view="front" onSelect={() => undefined} onCustomView={() => undefined} height="300px" />);

  test("REG-FE-3D-TOUCH-001 a touch-move on the model is claimed (not left to scroll the page), and the stage opts out of browser panning", () => {
    show();
    const stage = screen.getByTestId("stage3d");
    expect(stage.style.touchAction).toBe("none");
    expect(stage.style.overscrollBehavior).toBe("contain");
    const move = new Event("touchmove", { bubbles: true, cancelable: true });
    stage.dispatchEvent(move);
    expect(move.defaultPrevented).toBe(true);
  });

  test("REG-FE-3D-TOUCH-002 when the model is gone the claim goes with it", () => {
    const { unmount } = show();
    const stage = screen.getByTestId("stage3d");
    unmount();
    const move = new Event("touchmove", { bubbles: true, cancelable: true });
    stage.dispatchEvent(move);
    expect(move.defaultPrevented).toBe(false);
  });
});
