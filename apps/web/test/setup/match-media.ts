import { act } from "@testing-library/react";
import { beforeEach, vi } from "vitest";

const WIDE_QUERY = "(min-width: 64rem)";

/**
 * Replaces matchMedia with one that answers the width query of the dashboard
 * alone, and returns a setter that changes the width and tells the listeners.
 * jsdom has no matchMedia.
 */
export function stubWindowWidth(initial: "wide" | "narrow") {
  let wide = initial === "wide";
  const listeners = new Set<() => void>();

  vi.stubGlobal("matchMedia", (media: string) => ({
    media,
    get matches() {
      return media === WIDE_QUERY && wide;
    },
    addEventListener(_type: string, listener: () => void) {
      if (media === WIDE_QUERY) {
        listeners.add(listener);
      }
    },
    removeEventListener(_type: string, listener: () => void) {
      listeners.delete(listener);
    },
  }));

  return {
    set(next: "wide" | "narrow") {
      act(() => {
        wide = next === "wide";
        for (const listener of listeners) {
          listener();
        }
      });
    },
  };
}

// Many test files unstub all globals after each test, so the default is set again before each.
beforeEach(() => {
  stubWindowWidth("wide");
});
