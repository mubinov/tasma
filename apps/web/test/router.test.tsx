import { RouterProvider } from "@tanstack/react-router";
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { router } from "../src/router";
import config from "../vite.config";

// The route component itself is what has to throw: the router catches it below
// the boundary main.tsx puts around the provider, so this is the only path a
// failure in any surface takes.
vi.mock("../src/app", () => ({
  App: () => {
    throw new Error("the shell could not render");
  },
}));

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

/*
 * base: "./" and hash history are one decision, and this is the only place
 * that binds them. Relative asset paths resolve against the document's own
 * directory, so they hold only while the document sits at the root; hash
 * history is what keeps it there once a nested route exists. Changing either
 * alone 404s every asset inside a packaged shell, where there are no devtools
 * to see it happen.
 */
it("couples relative asset paths to hash history", () => {
  expect(config.base).toBe("./");
  expect(router.history.createHref("/settings/general")).toContain("#/settings/general");
});

it("answers a throw from a route with the app's own panel, not the library's", async () => {
  // React and the router both report a caught render error on the console; the
  // test asserts what is painted, not the noise.
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  // The router scrolls on mount, which jsdom does not implement.
  vi.stubGlobal("scrollTo", () => {});

  await act(async () => {
    render(<RouterProvider router={router} />);
  });

  const alert = screen.getByRole("alert");
  expect(alert.textContent).toContain("tasma stopped rendering");
  expect(screen.getByText("the shell could not render")).toBeTruthy();
  expect(document.activeElement).toBe(alert);
  // The library's own fallback, which paints instead when the router is left
  // to its default.
  expect(screen.queryByText("Something went wrong!")).toBeNull();
});
