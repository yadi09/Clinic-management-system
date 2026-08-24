// Render one thing or the other, not both.
//
// Tailwind's `lg:hidden` hides an element, but a Dialog portals its overlay to the
// body — so a sheet marked "phones only" still dimmed the whole desktop page behind a
// panel that was already visible beside the list. Some choices have to be made in JS,
// not CSS: this is for the ones where the wrong branch must not exist at all.
import { useEffect, useState } from "react";

export function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(() =>
    typeof window !== "undefined" && window.matchMedia ? window.matchMedia(query).matches : false);

  useEffect(() => {
    if (typeof window === "undefined" || !window.matchMedia) return;
    const mql = window.matchMedia(query);
    const onChange = () => setMatches(mql.matches);
    onChange();
    mql.addEventListener("change", onChange);
    return () => mql.removeEventListener("change", onChange);
  }, [query]);

  return matches;
}

/** Tailwind's `lg` breakpoint — where Reception gains room for a side panel. */
export const useIsLargeScreen = () => useMediaQuery("(min-width: 1024px)");
