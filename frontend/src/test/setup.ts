// Shared setup for every Vitest file: DOM matchers, and cleanup between tests.
import "@testing-library/jest-dom/vitest";
import { cleanup, configure } from "@testing-library/react";
import { afterEach, beforeEach, vi } from "vitest";

// findBy*/waitFor give up after 1 s by default. A page that renders in 50 ms on a
// quiet machine can take longer than that when the full suite runs under coverage,
// and a test then fails while the screen is fine (REG-FE-TRIAGE-012, 2026-10-03).
// Waiting longer costs a passing test nothing: it continues the moment the element
// appears. Assertions that something must NOT appear are unaffected.
configure({ asyncUtilTimeout: 5000 });

afterEach(() => cleanup());

// Radix primitives (Select, Dialog, ScrollArea) call these; jsdom lacks them.
class RO { observe() {} unobserve() {} disconnect() {} }
(globalThis as unknown as { ResizeObserver: typeof RO }).ResizeObserver ??= RO;
if (!Element.prototype.hasPointerCapture) {
  Element.prototype.hasPointerCapture = () => false;
  Element.prototype.releasePointerCapture = () => {};
  Element.prototype.scrollIntoView = () => {};
}
// Sonner's swipe-to-dismiss captures the pointer on a toast.
if (!Element.prototype.setPointerCapture) Element.prototype.setPointerCapture = () => {};
// The patient banner watches itself scroll out of view.
(globalThis as unknown as { IntersectionObserver?: unknown }).IntersectionObserver ??= class {
  observe() {} unobserve() {} disconnect() {} takeRecords() { return []; }
};
if (!window.matchMedia) {
  window.matchMedia = (q: string) =>
    ({ matches: false, media: q, onchange: null, addListener() {}, removeListener() {},
       addEventListener() {}, removeEventListener() {}, dispatchEvent: () => false }) as MediaQueryList;
}

// FAKE_NOW=<ISO instant> runs the whole suite at a chosen moment (only Date is
// faked; timers stay real). scripts/test/time-sweep.sh uses it to prove no test
// depends on the hour, the date or the time zone it happens to run in.
if (process.env.FAKE_NOW) {
  const now = new Date(process.env.FAKE_NOW);
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(now);
  });
}
