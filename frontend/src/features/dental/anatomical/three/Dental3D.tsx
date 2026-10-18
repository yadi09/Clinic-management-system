// The 3D model as a React view. This module, and Three.js with it, is loaded only
// when the 3D tab is opened (see AnatomicalWorkspace). It owns one Three.js scene for
// as long as it is mounted, rebuilds the teeth when the chart changes, and frees the
// renderer, geometries, materials and animation loop when it goes.
import { useEffect, useRef, useState } from "react";

import type { Position } from "@/features/dental/api";
import type { Dentition } from "@/features/dental/anatomical/geometry";
import type { ChartState } from "@/features/dental/anatomical/model";
import { createScene, type Scene3D, type View3D } from "@/features/dental/anatomical/three/scene";

export type { View3D };

/** Whether this browser can draw 3D at all. */
function webglAvailable() {
  try {
    const c = document.createElement("canvas");
    return !!(window.WebGLRenderingContext && (c.getContext("webgl2") || c.getContext("webgl")));
  } catch { return false; }
}

export default function Dental3D({ state, positions, sel, today, mode, xray, nums, view, recenterToken = 0, onSelect, onCustomView, height }: {
  state: ChartState; positions: Record<string, Position>; sel: number; today: string; mode: Dentition;
  xray: boolean; nums: boolean; view: View3D;
  /** Changes each time "Re-centre" is pressed. */
  recenterToken?: number;
  onSelect: (n: number) => void; onCustomView: () => void;
  /** CSS height of the stage. */
  height: string;
}) {
  const stage = useRef<HTMLDivElement>(null);
  const labels = useRef<HTMLDivElement>(null);
  const scene = useRef<Scene3D | null>(null);
  const cb = useRef({ onSelect, onCustomView });
  cb.current = { onSelect, onCustomView };
  const [failed, setFailed] = useState<string | null>(null);

  useEffect(() => {
    if (!stage.current || !labels.current) return;
    if (!webglAvailable()) { setFailed("This device cannot show 3D. The 2D chart has everything."); return; }
    try {
      scene.current = createScene(stage.current, labels.current, (n) => cb.current.onSelect(n), () => cb.current.onCustomView());
    } catch {
      setFailed("The 3D view could not start on this device. The 2D chart has everything.");
      return;
    }
    return () => { scene.current?.dispose(); scene.current = null; };
  }, []);

  // A finger dragging the model must turn it, never scroll the page behind it. `touch-action: none`
  // says so, but not every phone browser honours it for a drag that starts on a canvas, so the
  // touch itself is also claimed (this listener cannot be passive, or it could not do that).
  useEffect(() => {
    const el = stage.current;
    if (!el) return;
    const hold = (e: TouchEvent) => { if (e.cancelable) e.preventDefault(); };
    el.addEventListener("touchmove", hold, { passive: false });
    return () => el.removeEventListener("touchmove", hold);
  }, [failed]);

  useEffect(() => { scene.current?.build({ state, positions, sel, today, mode, xray, nums }); }, [state, positions, sel, today, mode, xray, nums]);
  useEffect(() => { scene.current?.setView(view); }, [view]);
  useEffect(() => { if (recenterToken) scene.current?.recenter(); }, [recenterToken]);

  if (failed) return <p role="alert" className="rounded-xl p-6 text-sm" style={{ background: "var(--surface-1)", color: "var(--text-danger)" }}>{failed}</p>;
  return (
    <div ref={stage} data-testid="stage3d" className="ta-stage3d relative overflow-hidden rounded-xl" style={{ height, background: "var(--surface-1)", touchAction: "none", overscrollBehavior: "contain", cursor: "grab" }}>
      <div ref={labels} className="pointer-events-none absolute inset-0 overflow-hidden" />
    </div>
  );
}
