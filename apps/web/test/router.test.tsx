import { RouterProvider } from "@tanstack/react-router";
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { router } from "../src/router";
import config from "../vite.config";

/*
 * Which component throws is chosen per test. Both failures are caught by the
 * router rather than by the boundary main.tsx puts around the provider, but
 * they are caught at different depths: the root match has no shell around it,
 * while a child match sits inside the shell's <main>.
 */
const failing = vi.hoisted(() => ({ shell: false, screen: false }));

vi.mock("../src/components/app-shell", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/components/app-shell")>();

  return {
    AppShell: () => {
      if (failing.shell) {
        throw new Error("the shell could not render");
      }

      return <actual.AppShell />;
    },
  };
});

vi.mock("../src/components/placeholder-screen", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/components/placeholder-screen")>();

  return {
    PlaceholderScreen: (props: { title: string; summary: string }) => {
      if (failing.screen) {
        throw new Error("the screen could not render");
      }

      return <actual.PlaceholderScreen {...props} />;
    },
  };
});

// React and the router both report a caught render error on the console; these
// tests assert what is painted, not the noise. The router also scrolls on
// mount, which jsdom does not implement.
function silenceFailureNoise() {
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.stubGlobal("scrollTo", () => {});
}

afterEach(() => {
  cleanup();
  failing.shell = false;
  failing.screen = false;
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

it("answers a throw from the root route with the app's own panel, not the library's", async () => {
  silenceFailureNoise();
  failing.shell = true;

  await act(async () => {
    render(<RouterProvider router={router} />);
  });

  const alert = screen.getByRole("alert");
  expect(alert.textContent).toContain("tasma stopped rendering");
  expect(screen.getByText("the shell could not render")).toBeTruthy();
  expect(document.activeElement).toBe(alert);
  // Nothing renders a landmark once the shell is gone, so the panel supplies
  // the one <main> the page has.
  expect(screen.getByRole("main").contains(alert)).toBe(true);
  // The library's own fallback, which paints instead when the router is left
  // to its default.
  expect(screen.queryByText("Something went wrong!")).toBeNull();
});

/*
 * A child's failure is caught in the child's own slot, so the shell stays and
 * the panel lands inside its <main>. A panel carrying a <main> of its own would
 * nest one landmark in another, which the content model forbids and which
 * leaves a screen-reader user two main regions to choose between.
 */
it("keeps a throw from a child screen inside the shell's one main landmark", async () => {
  silenceFailureNoise();
  failing.screen = true;

  await act(async () => {
    render(<RouterProvider router={router} />);
  });

  const alert = screen.getByRole("alert");
  expect(screen.getByText("the screen could not render")).toBeTruthy();
  expect(screen.getAllByRole("main")).toHaveLength(1);
  expect(screen.getByRole("main").contains(alert)).toBe(true);
  expect(screen.getByRole("navigation")).toBeTruthy();
});
