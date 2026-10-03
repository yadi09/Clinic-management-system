// useMediaQuery: some UI must not exist at all on the wrong screen size (a Dialog
// portals its overlay past any `lg:hidden`), so the choice is made in JS. What it
// promises: the current match on first render, a re-render when the media query
// flips, the listener removed on unmount or when the query changes, and `false`
// (not a crash) where there is no matchMedia.
import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { useIsLargeScreen, useMediaQuery } from "@/hooks/useMediaQuery";

type Listener = () => void;
interface FakeMql { query: string; matches: boolean; listeners: Set<Listener>; add: ReturnType<typeof vi.fn>; remove: ReturnType<typeof vi.fn> }

let lists: FakeMql[] = [];
let state: Record<string, boolean> = {};
const original = window.matchMedia;

function fakeMatchMedia(query: string) {
  const m: FakeMql = { query, matches: !!state[query], listeners: new Set(), add: vi.fn(), remove: vi.fn() };
  m.add.mockImplementation((_: string, l: Listener) => m.listeners.add(l));
  m.remove.mockImplementation((_: string, l: Listener) => m.listeners.delete(l));
  lists.push(m);
  return {
    get matches() { return m.matches; }, media: query, onchange: null,
    addEventListener: m.add, removeEventListener: m.remove, addListener() {}, removeListener() {}, dispatchEvent: () => false,
  } as unknown as MediaQueryList;
}
/** The screen changes: every list for the query flips and fires "change". */
function flip(query: string, matches: boolean) {
  state[query] = matches;
  for (const m of lists.filter((l) => l.query === query)) {
    m.matches = matches;
    m.listeners.forEach((l) => l());
  }
}

beforeEach(() => {
  lists = [];
  state = {};
  window.matchMedia = fakeMatchMedia;
});
afterEach(() => { window.matchMedia = original; });

describe("REG-FE-MQ useMediaQuery", () => {
  test("REG-FE-MQ-001 the current match on the first render: true and false", () => {
    state["(min-width: 1024px)"] = true;
    expect(renderHook(() => useMediaQuery("(min-width: 1024px)")).result.current).toBe(true);
    expect(renderHook(() => useMediaQuery("(max-width: 400px)")).result.current).toBe(false);
  });

  test("REG-FE-MQ-002 re-renders when the screen crosses the breakpoint, both ways", () => {
    const { result } = renderHook(() => useMediaQuery("(min-width: 1024px)"));
    expect(result.current).toBe(false);
    act(() => flip("(min-width: 1024px)", true));
    expect(result.current).toBe(true);
    act(() => flip("(min-width: 1024px)", false));
    expect(result.current).toBe(false);
  });

  test("REG-FE-MQ-003 unmount removes the very listener it added", () => {
    const { unmount } = renderHook(() => useMediaQuery("(min-width: 1024px)"));
    const subscribed = lists.find((l) => l.add.mock.calls.length > 0)!;
    const listener = subscribed.add.mock.calls[0][1];
    expect(subscribed.add).toHaveBeenCalledWith("change", listener);
    unmount();
    expect(subscribed.remove).toHaveBeenCalledWith("change", listener);
    expect(subscribed.listeners.size).toBe(0);
  });

  test("REG-FE-MQ-004 a new query drops the old subscription and reads the new one at once", () => {
    state["(min-width: 640px)"] = true;
    const { result, rerender } = renderHook(({ q }) => useMediaQuery(q), { initialProps: { q: "(min-width: 1024px)" } });
    expect(result.current).toBe(false);
    rerender({ q: "(min-width: 640px)" });
    expect(result.current).toBe(true);
    const old = lists.filter((l) => l.query === "(min-width: 1024px)");
    expect(old.every((l) => l.listeners.size === 0)).toBe(true);
    // The old query flipping no longer moves the hook.
    act(() => flip("(min-width: 1024px)", true));
    act(() => flip("(min-width: 640px)", false));
    expect(result.current).toBe(false);
  });

  test("REG-FE-MQ-005 no matchMedia (old browser, test env, SSR-like): false, and no crash on mount or unmount", () => {
    (window as unknown as { matchMedia?: unknown }).matchMedia = undefined;
    const { result, unmount } = renderHook(() => useMediaQuery("(min-width: 1024px)"));
    expect(result.current).toBe(false);
    expect(() => unmount()).not.toThrow();
  });

  test("REG-FE-MQ-006 useIsLargeScreen is Tailwind's lg breakpoint", () => {
    state["(min-width: 1024px)"] = true;
    const { result } = renderHook(() => useIsLargeScreen());
    expect(result.current).toBe(true);
    expect(lists.every((l) => l.query === "(min-width: 1024px)")).toBe(true);
  });
});
