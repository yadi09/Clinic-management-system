// Shared setup for every Vitest file: DOM matchers, and cleanup between tests.
import "@testing-library/jest-dom/vitest";
import { cleanup } from "@testing-library/react";
import { afterEach } from "vitest";

afterEach(() => cleanup());

// Radix primitives (Select, Dialog, ScrollArea) call these; jsdom lacks them.
class RO { observe() {} unobserve() {} disconnect() {} }
(globalThis as unknown as { ResizeObserver: typeof RO }).ResizeObserver ??= RO;
if (!Element.prototype.hasPointerCapture) {
  Element.prototype.hasPointerCapture = () => false;
  Element.prototype.releasePointerCapture = () => {};
  Element.prototype.scrollIntoView = () => {};
}
if (!window.matchMedia) {
  window.matchMedia = (q: string) =>
    ({ matches: false, media: q, onchange: null, addListener() {}, removeListener() {},
       addEventListener() {}, removeEventListener() {}, dispatchEvent: () => false }) as MediaQueryList;
}
