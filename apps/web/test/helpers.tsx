import { createMemoryHistory, RouterProvider } from "@tanstack/react-router";
import { act, render } from "@testing-library/react";
import { vi } from "vitest";
import { createAppRouter } from "../src/routes";

/**
 * Replaces matchMedia with one whose answer can be changed mid-test. jsdom's
 * own evaluates no media query, so it never reports dark.
 */
const DARK_QUERY = "(prefers-color-scheme: dark)";

export function stubSystemTheme(initial: "light" | "dark") {
  let current = initial;
  // Keyed by query, so a test touching prefers-reduced-motion or
  // prefers-contrast gets that feature's answer rather than the theme's, and a
  // theme change notifies only the listeners that asked about the theme.
  const listeners = new Map<string, Set<() => void>>();

  vi.stubGlobal("matchMedia", (media: string) => ({
    media,
    get matches() {
      return media === DARK_QUERY && current === "dark";
    },
    addEventListener(_type: string, listener: () => void) {
      const forQuery = listeners.get(media) ?? new Set<() => void>();
      forQuery.add(listener);
      listeners.set(media, forQuery);
    },
    removeEventListener: (_type: string, listener: () => void) => void listeners.get(media)?.delete(listener),
  }));

  return {
    set(next: "light" | "dark") {
      current = next;
      for (const listener of listeners.get(DARK_QUERY) ?? []) {
        listener();
      }
    },
  };
}

/**
 * Mounts the real route tree at a path. The shell is the root route's component
 * and the sidebar renders Link, so neither renders outside a router; a memory
 * history keeps a test off the document's own address.
 *
 * The router comes from the application's own factory, so a test cannot run a
 * differently configured router than the application does — the error and
 * not-found components included.
 */
export async function renderWithRouter(initialPath = "/") {
  // The router scrolls on mount, which jsdom does not implement.
  vi.stubGlobal("scrollTo", () => {});

  const router = createAppRouter(createMemoryHistory({ initialEntries: [initialPath] }));

  await act(async () => {
    render(<RouterProvider router={router} />);
  });

  return router;
}
