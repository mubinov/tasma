import { useSyncExternalStore } from "react";

/** The `lg` breakpoint of the theme. */
const WIDE_QUERY = "(min-width: 64rem)";

function subscribe(onChange: () => void): () => void {
  const query = window.matchMedia(WIDE_QUERY);
  query.addEventListener("change", onChange);
  return () => {
    query.removeEventListener("change", onChange);
  };
}

function readWide(): boolean {
  return window.matchMedia(WIDE_QUERY).matches;
}

/** Whether the window is at least as wide as the `lg` breakpoint. */
export function useWide(): boolean {
  return useSyncExternalStore(subscribe, readWide);
}
